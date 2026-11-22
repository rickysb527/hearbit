#!/usr/bin/env node
/* 更新のお知らせ（PWA 更新導線）の実Chrome検証。
 * app/ を一時ディレクトリへコピーして配信し、
 *   1) 起動時: 設定に現在の版が出る・バナーは出ない
 *   2) サーバ側を次の版に上げる（version.js / sw.js を +1）→「更新を確認」→ バナーに新しい版
 *   3) バナーをタップ → 再読み込みで新しい版のコードが動く（設定の版が上がり、バナーが消える）
 *   4) さらに再読み込みしても新しい版のまま（古い HTML/JS に戻らない）
 * を確認する。サーバはこのスクリプトが自分で立てる。GitHub Pages と同じく
 * Cache-Control: max-age=600 を付けて配信し、HTTP キャッシュが効く条件でも新しい版に
 * 切り替わることを確認する。
 * ※ 古い HTML/JS を HTTP キャッシュから掴む経路そのものは、この条件では再現しない
 *   （precache の cache:'reload' が HTTP キャッシュも新しい版で上書きするため）。
 *   sw.js の freshFetch（cache:'no-cache'）はその二重の防御。
 *
 * 使い方: node app/verify/verify_update.mjs
 */
import http from 'http';
import { spawn } from 'child_process';
import { rmSync, cpSync, readFileSync, writeFileSync, mkdtempSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8124;
const BASE = `http://localhost:${PORT}/index.html`;
const CHROME = process.env.CHS ||
  '/Users/rikikun/.cache/puppeteer/chrome-headless-shell/mac_arm-151.0.7922.47/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const DBG = 9334;

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

// 配信用コピー（音声は含まれない。app/ はコードのみ）
const ROOT = mkdtempSync(path.join(tmpdir(), 'hb-update-'));
cpSync(APP, ROOT, { recursive: true });
function bumpServedVersion() {
  const vf = path.join(ROOT, 'js/version.js'), sf = path.join(ROOT, 'sw.js');
  const cur = Number(readFileSync(vf, 'utf8').match(/APP_VERSION = (\d+)/)[1]);
  writeFileSync(vf, readFileSync(vf, 'utf8').replace(/APP_VERSION = \d+/, `APP_VERSION = ${cur + 1}`));
  writeFileSync(sf, readFileSync(sf, 'utf8').replace(/const VERSION = \d+;/, `const VERSION = ${cur + 1};`));
  // HTML も新しい版になったことを見分ける目印を入れる（古い HTML を掴んでいないかの確認用）
  const hf = path.join(ROOT, 'index.html');
  writeFileSync(hf, readFileSync(hf, 'utf8').replace('<head>', `<head><meta name="hb-build" content="${cur + 1}">`));
  return cur + 1;
}

// GitHub Pages 相当の静的サーバ（max-age=600）
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml' };
function startServer() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream',
      'Cache-Control': 'max-age=600' });
    res.end(readFileSync(f));
  });
  return new Promise((r) => srv.listen(PORT, () => r(srv)));
}

async function main() {
  const server = await startServer();
  try { rmSync('/tmp/hb-chrome-update', { recursive: true, force: true }); } catch (e) {}
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DBG}`, '--headless=new', '--no-sandbox',
    '--disable-gpu',
    '--user-data-dir=/tmp/hb-chrome-update', 'about:blank',
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

    const state = () => evalP(`({ ver: document.getElementById('app-version').textContent,
      banner: !document.getElementById('update-banner').classList.contains('hidden'),
      bannerVer: document.getElementById('update-banner-ver').textContent,
      ctrl: !!navigator.serviceWorker.controller,
      build: (document.querySelector('meta[name="hb-build"]') || {}).content || null })`);
    async function waitFor(pred, ms = 10000) {
      let s; for (let i = 0; i < ms / 200; i++) { s = await state().catch(() => null); if (s && pred(s)) return s; await sleep(200); }
      return s;
    }

    await sc('Page.navigate', { url: BASE });
    // 初回は SW 未制御 → controller が付くまで待つ（clients.claim）
    let s = await waitFor((x) => x.ctrl);
    const v0 = Number(s.ver.replace('v', ''));
    check('起動時: 設定に現在の版が出る', /^v\d+$/.test(s.ver), s.ver);
    check('起動時: SW が制御している', s.ctrl);
    check('起動時: 更新バナーは出ない', !s.banner);

    const v1 = bumpServedVersion();
    await evalP('document.getElementById("update-check-btn").click(); true');
    s = await waitFor((x) => x.banner);
    check('新しい版をデプロイ →「更新を確認」でバナーが出る', s.banner && s.bannerVer === `v${v1}`, JSON.stringify(s));
    check('バナー表示中も画面は古い版のまま（勝手に再読み込みしない）', s.ver === `v${v0}`, s.ver);

    await evalP('document.getElementById("update-banner").click(); true');
    await sleep(1000);
    s = await waitFor((x) => x.ver === `v${v1}`);
    check('バナーをタップ → 新しい版のコードで動く', s && s.ver === `v${v1}`, JSON.stringify(s));
    check('更新後はバナーが消える', s && !s.banner, JSON.stringify(s));
    check('更新後は HTML も新しい版（HTTP キャッシュの古い HTML を掴まない）', s && s.build === String(v1), JSON.stringify(s));

    // さらに 2 回「起動し直し」ても新しい版のまま（裏の再取得が古い JS/HTML でキャッシュを上書きしない）。
    // reload は HTTP キャッシュを再検証してしまうので、ホーム画面からの起動と同じ通常のナビゲーションで開く。
    for (let i = 0; i < 2; i++) { await sc('Page.navigate', { url: BASE }); await sleep(1500); }
    s = await waitFor((x) => x.ctrl);
    check('再読み込みを繰り返しても新しい版のまま', s && s.ver === `v${v1}` && s.build === String(v1) && !s.banner, JSON.stringify(s));

    await send('Target.closeTarget', { targetId });
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
    server.close();
    rmSync(ROOT, { recursive: true, force: true });
  }
  console.log(`\n=> ${fail === 0 ? '全チェック PASS' : `${fail}件 NG`}  (PASS ${pass} / NG ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
