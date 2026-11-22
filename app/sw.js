/* Hearbit Service Worker
 * アプリのコード・アセット（App Shell）をキャッシュしてオフライン起動を可能にする。
 * 音声Blobは IndexedDB に保存されるため、ここではキャッシュしない（コード/アセットのみ）。
 *
 * 戦略:
 *   - 同一オリジンの App Shell: cache-first（オフラインで確実に起動）
 *   - それ以外: network-first フォールバック（開発中の外部取得など）
 */
// js/version.js の APP_VERSION と必ず同じ値にする（デプロイごとに両方 +1。verify_version.js で確認）。
const VERSION = 14;
const CACHE = 'hearbit-v' + VERSION;

// スコープ（app/）基準の相対パス。sw.js は app/ 直下に置く前提。
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/db.js',
  './js/splitter.js',
  './js/listen-build.js',
  './js/editor.js',
  './js/player.js',
  './js/listen.js',
  './js/srs.js',
  './js/typing.js',
  './js/version.js',
  './js/app.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache:'reload' = ブラウザの HTTP キャッシュを通さず必ずサーバから取る。
      // （GitHub Pages は max-age=600。通すとデプロイ直後に古い JS を新キャッシュへ入れてしまう）
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      // 失敗（通信断など）は握りつぶさない → install 失敗としてブラウザが次の update で再試行する。
      // 握りつぶすと空キャッシュの SW が waiting で固まり、更新が届かなくなる。
      // アセットの欠損は verify_version.js（ASSETS が全て実在する）で事前に防ぐ。
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* 戦略（PWAの「更新が効かない罠」を避ける）:
 *   - ナビゲーション(HTML): network-first。オンライン時は常に最新HTMLを取得し、
 *     失敗時のみキャッシュ(index.html)へフォールバック → デプロイが即反映される。
 *   - 静的アセット(CSS/JS/アイコン等): stale-while-revalidate。まずキャッシュを即返し、
 *     裏で fetch して新しければキャッシュを更新 → 次回アクセスから最新になる。
 *   activate 時の旧キャッシュ削除（上）と組み合わせ、CACHE 名を上げれば確実に総入れ替えできる。
 */
// SW からの取得は HTTP キャッシュを経由せず必ずサーバに再検証させる（cache:'no-cache'）。
// GitHub Pages は max-age=600 なので、通常の fetch だとデプロイ直後 10 分は古い HTML/JS が返り、
// それを新しいキャッシュへ put して「新しい JS × 古い HTML」などの食い違いを作ってしまう。
// navigate モードの Request に init を付けて作り直すのは環境により失敗するので URL で取る。
// ※ URL で取るとリダイレクトを追う。スコープ内のページ遷移先がリダイレクトされる構成にすると
//   「リダイレクト済み応答」をナビゲーションに返して失敗するので、URL 構成を変える時は要注意。
function freshFetch(req) {
  return fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
}

function networkFirst(req) {
  return freshFetch(req)
    .then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })
    .catch(() => caches.match(req).then((c) => c || caches.match('./index.html')));
}

function staleWhileRevalidate(req) {
  return caches.open(CACHE).then((cache) =>
    cache.match(req).then((cached) => {
      const network = freshFetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached); // オフライン時はキャッシュで代替
      // キャッシュがあれば即返す（裏で network が更新）。無ければ network を待つ。
      return cached || network;
    })
  );
}

// ページから「この SW の版は？」を問い合わせる（MessageChannel で返答）。
// ページ側は自分の APP_VERSION と比べ、SW の方が新しければ「更新があります」を出す。
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_VERSION' && event.ports[0]) {
    event.ports[0].postMessage({ type: 'VERSION', version: VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 同一オリジンのみキャッシュ対象（音声Blob URL 等は対象外）
  if (url.origin !== self.location.origin) return;

  const isNav = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  event.respondWith(isNav ? networkFirst(req) : staleWhileRevalidate(req));
});
