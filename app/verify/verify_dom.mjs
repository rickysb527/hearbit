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

    await send('Target.closeTarget', { targetId });
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
  }

  console.log(`\n=> ${fail === 0 ? '全チェック PASS' : `${fail}件 NG`}  (PASS ${pass} / NG ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
