#!/usr/bin/env node
/* 実DOM統合検証（chrome-headless-shell + CDP）。
 * 実際の app.js / player.js / listen.js を Chrome で走らせ、UI操作で:
 *   - テキスト編集モーダルを開く → 保存 → 一覧セルの漢字が更新 & ? が外れる
 *   - 再オープン（IndexedDBから読み直し）で編集が保持される
 *   - 要確認フィルタで low_confidence だけ表示
 *   - 聞き流しプレーヤー(lp-text)に現在語の漢字・ピンインが出る
 * を確認する。音声Blobはダミー（無音WAV）を注入。
 *
 * puppeteer 無しで CDP(WebSocket)を直接叩く最小クライアント。Node22 の global WebSocket 使用。
 */
import http from 'http';
import { spawn } from 'child_process';
import { rmSync } from 'fs';

const PORT = 8123;
const BASE = `http://localhost:${PORT}/index.html`;
const CHROME = process.env.CHS ||
  '/Users/rikikun/.cache/puppeteer/chrome-headless-shell/mac_arm-151.0.7922.47/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const DBG = 9333;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra != null ? '  ' + extra : ''}`); }
}

async function main() {
  // 前回プロファイルの Service Worker キャッシュ（旧バージョンJS）を掴まないよう毎回破棄する。
  try { rmSync('/tmp/hb-chrome-verify', { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DBG}`, '--headless=new', '--no-sandbox',
    '--disable-gpu',
    // headless では range-chip タップがユーザージェスチャ扱いにならず autoplay が
    // 抑止される。実機ではタップが起点なので再生される。検証環境のみ抑止を解除する。
    '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=/tmp/hb-chrome-verify', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    // DevTools エンドポイントが立つまで待つ
    let ver = null;
    for (let i = 0; i < 50; i++) {
      try { ver = await getJSON(`http://localhost:${DBG}/json/version`); break; } catch (e) { await sleep(200); }
    }
    if (!ver) throw new Error('DevTools endpoint not up');

    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    const sessionEvents = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m); }
      else sessionEvents.push(m);
    };
    function send(method, params, sessionId) {
      const id = ++msgId;
      return new Promise((resolve) => { pending.set(id, { resolve }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
    }

    // ターゲット（ページ）を作って attach
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
    const sc = (method, params) => send(method, params, sessionId);
    await sc('Page.enable', {});
    await sc('Runtime.enable', {});

    async function evalP(expression) {
      const r = await sc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      if (r.result && r.result.result && r.result.result.subtype === 'error') throw new Error(JSON.stringify(r.result.result));
      return r.result.result.value;
    }

    // ページ遷移
    await sc('Page.navigate', { url: BASE });
    // app.js 初期化待ち
    for (let i = 0; i < 60; i++) {
      const ready = await evalP('!!(DB && Listen && Player && document.getElementById("books-list"))').catch(() => false);
      if (ready) break; await sleep(200);
    }

    // ---- 単語帳をIndexedDBへ投入（ダミー無音WAV + vocab） ----
    const seed = `(async () => {
      // 2ページ・各3セグメントの小さな book。003/1 を low_confidence:true にする。
      const pages = [
        { page: '001', duration: 30, num_segments: 3, layout: 'word_with_examples', word_count: 3, has_announce: false,
          segments: [
            { index:0, start:0, end:10, length:10, type:'word' },
            { index:1, start:10, end:20, length:10, type:'word' },
            { index:2, start:20, end:30, length:10, type:'word' } ] },
        { page: '002', duration: 30, num_segments: 3, layout: 'word_with_examples', word_count: 3, has_announce: false,
          segments: [
            { index:0, start:0, end:10, length:10, type:'word' },
            { index:1, start:10, end:20, length:10, type:'word' },
            { index:2, start:20, end:30, length:10, type:'word' } ] },
      ];
      const vocab = {
        '001/0': { hanzi:'阿姨', pinyin:'ā yí', gloss:'おばさん', low_confidence:false },
        '001/1': { hanzi:'爱好', pinyin:'ài hào', gloss:'趣味', low_confidence:true },
        '001/2': { hanzi:'安静', pinyin:'ān jìng', gloss:'静か', low_confidence:false },
        '002/0': { hanzi:'把', pinyin:'bǎ', gloss:'', low_confidence:true },
      };
      // 無音WAV(0.2s, 8kHz mono)をページ音声Blobに
      function silentWav(sec, sr){ const n=Math.floor(sec*sr); const bytes=44+n*2; const b=new ArrayBuffer(bytes); const v=new DataView(b);
        const w=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
        w(0,'RIFF');v.setUint32(4,36+n*2,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);
        v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
        w(36,'data');v.setUint32(40,n*2,true);
        // 純無音だと detectSilences が全区間を無音扱いにするので、軽いトーンを乗せる。
        const arr = new Int16Array(b, 44, n); for (let i=0;i<n;i++) arr[i] = Math.sin(i/5)*8000;
        return new Blob([b],{type:'audio/wav'}); }
      const wav = silentWav(30, 8000);
      const meta = { id:'book_verify', name:'検証帳', createdAt:Date.now(),
        splitVersion: Splitter.SPLIT_VERSION, book:{ book:'検証帳', pages }, vocab };
      await DB.saveBook(meta, { '001': wav, '002': wav });
      return true;
    })()`;
    await evalP(seed);

    // 一覧を再描画してから単語帳を開く（実UIのボタン経由）
    await evalP('document.querySelectorAll("#tab-bar .tabbar-btn")[0].click(); true');
    await sleep(300);
    // 単語帳セルをクリックして openBook
    const opened = await evalP(`(async () => {
      const item = document.querySelector('#books-list .book-item');
      if (!item) return 'no-book-item';
      item.click();
      // openBook は async（ensureSplitCurrent）。少し待つ。
      return 'clicked';
    })()`);
    check('単語帳セルをクリックできた', opened === 'clicked', opened);
    // pages ビュー描画待ち
    for (let i = 0; i < 40; i++) { const n = await evalP('document.querySelectorAll("#pages-grid-wrap .cell").length'); if (n >= 6) break; await sleep(150); }

    const cellCount = await evalP('document.querySelectorAll("#pages-grid-wrap .cell").length');
    check('一覧に6セル描画', cellCount === 6, `count=${cellCount}`);

    // 001/1 (爱好) は low_confidence → ? と low-conf クラス
    const lcCell = await evalP(`(() => {
      const cells = [...document.querySelectorAll('#pages-grid-wrap .cell')];
      const c = cells.find(x => (x.querySelector('.cell-hanzi')||{}).textContent === '爱好');
      return c ? { hasQ: !!c.querySelector('.cell-lc'), low: c.classList.contains('low-conf'), hasEdit: !!c.querySelector('.cell-edit') } : null;
    })()`);
    check('低信頼セルに ? が付く', lcCell && lcCell.hasQ, JSON.stringify(lcCell));
    check('低信頼セルに low-conf クラス', lcCell && lcCell.low);
    check('セルに編集ボタンがある', lcCell && lcCell.hasEdit);

    // 要確認フィルタ: 2件（001/1, 002/0）だけ表示
    const filterN = await evalP(`(() => {
      const bar = document.getElementById('vocab-filter-bar');
      if (bar.classList.contains('hidden')) return 'filter-hidden';
      document.getElementById('vocab-filter-btn').click();
      return document.querySelectorAll('#pages-grid-wrap .cell').length;
    })()`);
    check('要確認フィルタで low_confidence の2件だけ表示', filterN === 2, `n=${filterN}`);
    // フィルタ解除
    await evalP('document.getElementById("vocab-filter-btn").click(); true');
    await sleep(100);

    // ---- テキスト編集: 爱好(001/1) の編集ボタンを開いて保存 ----
    await evalP(`(() => {
      const cells = [...document.querySelectorAll('#pages-grid-wrap .cell')];
      const c = cells.find(x => (x.querySelector('.cell-hanzi')||{}).textContent === '爱好');
      c.querySelector('.cell-edit').click();
      return true;
    })()`);
    await sleep(150);
    const modalOpen = await evalP('!document.getElementById("text-edit-modal").classList.contains("hidden")');
    check('編集モーダルが開く', modalOpen);
    const presets = await evalP('({h:document.getElementById("te-hanzi").value, p:document.getElementById("te-pinyin").value, g:document.getElementById("te-gloss").value})');
    check('現在値がプリセットされる', presets.h === '爱好' && presets.p === 'ài hào' && presets.g === '趣味', JSON.stringify(presets));

    // 値を書き換えて保存
    await evalP(`(() => {
      document.getElementById('te-hanzi').value = '愛好';
      document.getElementById('te-pinyin').value = 'ài hǎo';
      document.getElementById('te-gloss').value = '趣味(修正)';
      document.getElementById('te-save').click();
      return true;
    })()`);
    await sleep(300);
    const afterSave = await evalP(`(() => {
      const cells = [...document.querySelectorAll('#pages-grid-wrap .cell')];
      const c = cells.find(x => (x.querySelector('.cell-hanzi')||{}).textContent === '愛好');
      return c ? { hanzi: c.querySelector('.cell-hanzi').textContent, pinyin: c.querySelector('.cell-pinyin').textContent, stillQ: !!c.querySelector('.cell-lc'), low: c.classList.contains('low-conf') } : null;
    })()`);
    check('保存後 一覧セルの漢字が更新', afterSave && afterSave.hanzi === '愛好', JSON.stringify(afterSave));
    check('保存後 ピンインが更新', afterSave && afterSave.pinyin === 'ài hǎo');
    check('保存後 ? が外れる', afterSave && !afterSave.stillQ);
    check('保存後 low-conf クラスが外れる', afterSave && !afterSave.low);

    // IndexedDB に保存されたか（再オープン相当）
    const persisted = await evalP(`(async () => { const b = await DB.getBook('book_verify'); return b.vocab['001/1']; })()`);
    check('IndexedDBに編集が永続化', persisted && persisted.hanzi === '愛好' && persisted.low_confidence === false, JSON.stringify(persisted));

    // 再オープン（別ビューへ→戻って開き直し）でも保持
    await evalP('document.querySelectorAll("#tab-bar .tabbar-btn")[0].click(); true');
    await sleep(200);
    await evalP('document.querySelector("#books-list .book-item").click(); true');
    for (let i = 0; i < 40; i++) { const n = await evalP('document.querySelectorAll("#pages-grid-wrap .cell").length'); if (n >= 6) break; await sleep(150); }
    const reopened = await evalP(`(() => { const c=[...document.querySelectorAll('#pages-grid-wrap .cell')].find(x=>(x.querySelector('.cell-hanzi')||{}).textContent==='愛好'); return !!c; })()`);
    check('再オープンで編集が保持（愛好）', reopened);

    // ---- 聞き流しプレーヤーのテキスト表示 ----
    // 聞き流しタブへ → 範囲チップをクリック → lp-text に漢字が出る
    await evalP(`(() => { document.querySelector('#book-tabs .tab[data-tab="listen"]').click(); return true; })()`);
    await sleep(150);
    const chipN = await evalP('document.querySelectorAll("#listen-ranges .listen-range-chip").length');
    check('聞き流し範囲チップが描画', chipN >= 1, `n=${chipN}`);
    await evalP('document.querySelector("#listen-ranges .listen-range-chip").click(); true');
    // トラック構築（無音decode）→再生。lp-text の漢字が出るまで待つ。
    let lpText = null;
    for (let i = 0; i < 60; i++) {
      lpText = await evalP(`(() => {
        const t = document.getElementById('lp-text');
        return { shown: !t.classList.contains('hidden'), hanzi: document.getElementById('lp-hanzi').textContent,
          pinyin: document.getElementById('lp-pinyin').textContent, wordHidden: document.getElementById('lp-word').classList.contains('hidden') };
      })()`);
      if (lpText.shown && lpText.hanzi) break;
      await sleep(200);
    }
    check('聞き流しプレーヤーに漢字テキストが表示', lpText && lpText.shown && !!lpText.hanzi, JSON.stringify(lpText));
    check('漢字表示中はフォールバック番号を隠す', lpText && lpText.wordHidden);
    // 先頭語 = 001/0 = 阿姨
    check('先頭語の漢字が 阿姨', lpText && lpText.hanzi === '阿姨', lpText && lpText.hanzi);

    // Media Session タイトルに漢字が入る（metadata 参照）
    const msTitle = await evalP(`(() => { try { return navigator.mediaSession.metadata ? navigator.mediaSession.metadata.title : null; } catch(e){ return 'no-ms'; } })()`);
    check('Media Session タイトルに漢字（あれば）', msTitle == null || msTitle === 'no-ms' || /阿姨/.test(msTitle) || /聞き流し/.test(msTitle), String(msTitle));

    // ================= スター（お気に入り） =================
    // 聞き流しプレーヤー(lp-star)で現在語（阿姨 = 001/0）にスターを付ける。
    await evalP('document.getElementById("lp-star").click(); true');
    await sleep(200);
    const lpStarOn = await evalP('document.getElementById("lp-star").classList.contains("on")');
    check('聞き流しプレーヤーのスターがON表示', lpStarOn);
    const star001 = await evalP(`(async () => { const b = await DB.getBook('book_verify'); return b.vocab['001/0'] && b.vocab['001/0'].starred === true; })()`);
    check('lp-star で 001/0 が starred:true 永続化', star001);

    // 聞き流しは <audio> 要素（WAV blob）で鳴らす（iOS のバックグラウンド/ロック中再生のため）
    const el0 = await evalP(`(() => { const a = Listen._audioEl(); return a ? { src: a.src, t: a.currentTime, paused: a.paused } : null; })()`);
    await sleep(1000);
    const el1 = await evalP(`(() => { const a = Listen._audioEl(); return a ? { src: a.src, t: a.currentTime, paused: a.paused, dur: a.duration } : null; })()`);
    check('聞き流しは <audio> 要素で blob の WAV を再生', el1 && /^blob:/.test(el1.src) && !el1.paused, JSON.stringify(el1));
    check('<audio> の再生位置が進む（実際に鳴っている）', el0 && el1 && el1.t > el0.t + 0.5, JSON.stringify({ el0, el1 }));

    // ================= 聞き流しミニ（▼で閉じても再生継続・下部常駐） =================
    const miniState = () => evalP(`(() => {
      const lm = document.getElementById('listen-mini');
      return { lpOpen: !document.getElementById('listen-player').classList.contains('hidden'),
        miniOpen: !lm.classList.contains('hidden'), active: Listen.isActive(), playing: Listen.isPlaying(),
        label: document.getElementById('lm-label').textContent,
        bodyCls: document.body.classList.contains('listen-mini-open') };
    })()`);
    await evalP('document.getElementById("lp-collapse").click(); true');
    await sleep(150);
    let ms = await miniState();
    check('▼でミニ化: 全画面が閉じミニが出る', !ms.lpOpen && ms.miniOpen && ms.bodyCls, JSON.stringify(ms));
    check('▼でミニ化: 再生は止まらない', ms.active && ms.playing, JSON.stringify(ms));
    check('ミニのラベル「聞き流し No.n (k/N) · 漢字」', /^聞き流し No\.\d+ \(\d+\/\d+\)/.test(ms.label) && /阿姨|愛好|安静/.test(ms.label), ms.label);
    await evalP('document.getElementById("lm-toggle").click(); true');
    await sleep(100);
    ms = await miniState();
    check('ミニの⏸で一時停止', ms.active && !ms.playing && await evalP('document.getElementById("listen-mini").classList.contains("paused")'), JSON.stringify(ms));
    await evalP('document.getElementById("lm-toggle").click(); true');
    await sleep(150);
    ms = await miniState();
    check('ミニの▶で再開', ms.playing, JSON.stringify(ms));
    await evalP('document.getElementById("lm-expand").click(); true');
    await sleep(100);
    ms = await miniState();
    check('ミニの▲で全画面に戻る', ms.lpOpen && !ms.miniOpen && ms.playing, JSON.stringify(ms));
    await evalP('document.getElementById("lp-collapse").click(); true');
    await sleep(100);

    // ミニのまま単語タブへ → 再生継続
    await evalP(`(() => { document.querySelector('#book-tabs .tab[data-tab="words"]').click(); return true; })()`);
    await sleep(150);
    ms = await miniState();
    check('単語タブへ移ってもミニ再生が続く', ms.miniOpen && ms.playing, JSON.stringify(ms));
    // 単語帳一覧（ルート）へ戻る → 再生継続 & ミニがタブバーを覆わない
    await evalP('document.getElementById("back-btn").click(); true');
    await sleep(200);
    const rootMini = await evalP(`(() => {
      const lm = document.getElementById('listen-mini').getBoundingClientRect();
      const tb = document.getElementById('tab-bar').getBoundingClientRect();
      return { playing: Listen.isPlaying(), miniOpen: !document.getElementById('listen-mini').classList.contains('hidden'),
        miniBottom: Math.round(lm.bottom), tabTop: Math.round(tb.top), tabH: Math.round(tb.height) };
    })()`);
    check('単語帳一覧へ戻ってもミニ再生が続く', rootMini.playing && rootMini.miniOpen, JSON.stringify(rootMini));
    check('ミニがタブバーを覆わない（タブバーの上に出る）', rootMini.tabH > 0 && rootMini.miniBottom <= rootMini.tabTop, JSON.stringify(rootMini));
    // 単語帳を開き直す → 停止（仕様: 単語側と同じ）
    await evalP(`(() => { const b = [...document.querySelectorAll('#books-list .book-item')][0]; b && b.click(); return !!b; })()`);
    for (let i = 0; i < 30; i++) { if (await evalP('document.getElementById("view-pages").classList.contains("active")')) break; await sleep(100); }
    ms = await miniState();
    check('単語帳を開き直すと聞き流しは停止しミニも消える', !ms.active && !ms.miniOpen && !ms.bodyCls, JSON.stringify(ms));
    await evalP(`(() => { document.querySelector('#book-tabs .tab[data-tab="words"]').click(); return true; })()`);
    await sleep(150);

    // 一覧セル: 阿姨(001/0) はスター済み → .starred と .cell-star.on
    const cellStarState = await evalP(`(() => {
      const c = [...document.querySelectorAll('#pages-grid-wrap .cell')].find(x => (x.querySelector('.cell-hanzi')||{}).textContent === '阿姨');
      return c ? { starred: c.classList.contains('starred'), btnOn: !!(c.querySelector('.cell-star') && c.querySelector('.cell-star.on')) } : null;
    })()`);
    check('一覧セル(阿姨)が starred 表示', cellStarState && cellStarState.starred, JSON.stringify(cellStarState));
    check('一覧セルのスターボタンが on', cellStarState && cellStarState.btnOn);

    // 別セル(愛好 = 001/1)にも一覧のスターボタンでスターを付ける（合計2件）
    await evalP(`(() => {
      const c = [...document.querySelectorAll('#pages-grid-wrap .cell')].find(x => (x.querySelector('.cell-hanzi')||{}).textContent === '愛好');
      c.querySelector('.cell-star').click(); return true;
    })()`);
    await sleep(200);
    const starCount = await evalP(`(async () => { const b = await DB.getBook('book_verify'); return Object.values(b.vocab).filter(v => v.starred).length; })()`);
    check('一覧スターボタンで2件目を永続化（計2件）', starCount === 2, `n=${starCount}`);

    // スターフィルタが出現し、件数バッジ=2
    const starFilterInfo = await evalP(`(() => {
      const btn = document.getElementById('vocab-star-filter-btn');
      return { shown: !btn.classList.contains('hidden'), count: document.getElementById('vocab-star-filter-count').textContent };
    })()`);
    check('スターフィルタが表示される', starFilterInfo && starFilterInfo.shown, JSON.stringify(starFilterInfo));
    check('スターフィルタの件数バッジ=（2）', starFilterInfo && /2/.test(starFilterInfo.count), starFilterInfo && starFilterInfo.count);

    // スターフィルタON → starred の2件だけ表示
    const filteredN = await evalP(`(() => { document.getElementById('vocab-star-filter-btn').click(); return document.querySelectorAll('#pages-grid-wrap .cell').length; })()`);
    check('スターフィルタで starred の2件だけ表示', filteredN === 2, `n=${filteredN}`);
    // フィルタ解除
    await evalP('document.getElementById("vocab-star-filter-btn").click(); true');
    await sleep(100);

    // 全画面プレーヤー(fp-star)でスターを外す/付ける（阿姨 001/0 を再生 → fp-star トグル）
    await evalP(`(() => {
      const c = [...document.querySelectorAll('#pages-grid-wrap .cell')].find(x => (x.querySelector('.cell-hanzi')||{}).textContent === '阿姨');
      c.click(); return true;
    })()`);
    await sleep(300);
    const fpStarBefore = await evalP('document.getElementById("fp-star").classList.contains("on")');
    check('全画面プレーヤーのスターが現在語(阿姨=済)を反映', fpStarBefore);
    await evalP('document.getElementById("fp-star").click(); true');
    await sleep(250);
    const fpStarAfter = await evalP('document.getElementById("fp-star").classList.contains("on")');
    const star001Off = await evalP(`(async () => { const b = await DB.getBook('book_verify'); return !(b.vocab['001/0'] && b.vocab['001/0'].starred); })()`);
    check('fp-star でスターOFFに（表示）', !fpStarAfter);
    check('fp-star でスターOFFを永続化', star001Off);
    // 再度ONに戻す（以降のスター聞き流しで2件にする）
    await evalP('document.getElementById("fp-star").click(); true');
    await sleep(250);
    await evalP('document.getElementById("fp-collapse").click(); true');

    // 聞き流しタブ → 「スター単語を聞き流す」が活性・件数2 → 起動して連結トラックが再生
    await evalP(`(() => { document.querySelector('#book-tabs .tab[data-tab="listen"]').click(); return true; })()`);
    await sleep(150);
    const starBtnState = await evalP(`(() => { const b = document.getElementById('listen-star-btn'); return { disabled: b.disabled, count: document.getElementById('listen-star-count').textContent }; })()`);
    check('スター聞き流しボタンが活性', starBtnState && !starBtnState.disabled, JSON.stringify(starBtnState));
    check('スター聞き流しボタンの件数=2語', starBtnState && /2/.test(starBtnState.count), starBtnState && starBtnState.count);
    await evalP('document.getElementById("listen-star-btn").click(); true');
    let starTrack = null;
    for (let i = 0; i < 60; i++) {
      starTrack = await evalP(`(() => {
        const lp = document.getElementById('listen-player');
        return { open: !lp.classList.contains('hidden'), total: document.getElementById('lp-total').textContent,
          sub: document.getElementById('lp-sub').textContent, hanzi: document.getElementById('lp-hanzi').textContent };
      })()`);
      if (starTrack.open && starTrack.hanzi) break;
      await sleep(200);
    }
    check('スター聞き流しプレーヤーが開く', starTrack && starTrack.open, JSON.stringify(starTrack));
    check('スター聞き流しの総語数=2（starred のみの連結）', starTrack && starTrack.total === '2', starTrack && starTrack.total);
    check('スター聞き流しのサブ表示が「スター単語」', starTrack && /スター単語/.test(starTrack.sub), starTrack && starTrack.sub);
    // 先頭語は starred の先頭 = 阿姨(001/0)
    check('スター聞き流しの先頭語が 阿姨', starTrack && starTrack.hanzi === '阿姨', starTrack && starTrack.hanzi);

    // 通し番号: 途中から始まる範囲（3語目〜）では No. が通し番号、k/N はトラック内の位置
    await evalP('Listen.playRange(2, 4, 50); true');
    let serialInfo = null;
    for (let i = 0; i < 40; i++) {
      serialInfo = await evalP(`({ serial: document.getElementById('lp-serial').textContent,
        cur: document.getElementById('lp-cur').textContent, total: document.getElementById('lp-total').textContent,
        playing: Listen.isPlaying() })`);
      if (serialInfo.playing) break;
      await sleep(200);
    }
    check('途中からの範囲: 通し番号は 3、範囲内の位置は 1/2', serialInfo.serial === '3' && serialInfo.cur === '1' && serialInfo.total === '2', JSON.stringify(serialInfo));

    // 再生中（ミニ）の単語帳を一覧から削除 → 停止・ミニ消去、★操作で DB に復活しない
    await evalP('document.getElementById("lp-collapse").click(); true');
    await sleep(100);
    await evalP('document.getElementById("back-btn").click(); true');
    await sleep(200);
    await evalP('window.confirm = () => true; document.querySelector("#books-list .book-item .book-del").click(); true');
    await sleep(400);
    const afterDel = await evalP(`(async () => ({
      active: Listen.isActive(), miniOpen: !document.getElementById('listen-mini').classList.contains('hidden'),
      exists: !!(await DB.getBook('book_verify')) }))()`);
    check('再生中の単語帳を削除すると聞き流し停止・ミニ消去', !afterDel.active && !afterDel.miniOpen, JSON.stringify(afterDel));
    await evalP('document.getElementById("lp-star").click(); true');
    await sleep(300);
    const resurrected = await evalP(`(async () => !!(await DB.getBook('book_verify')))()`);
    check('削除後の★操作で単語帳が復活しない', !afterDel.exists && !resurrected, `exists=${afterDel.exists} resurrected=${resurrected}`);

    await send('Target.closeTarget', { targetId });
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
  }

  console.log(`\n=> ${fail === 0 ? '全チェック PASS' : `${fail}件 NG`}  (PASS ${pass} / NG ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
