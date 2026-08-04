/* Hearbit Service Worker
 * アプリのコード・アセット（App Shell）をキャッシュしてオフライン起動を可能にする。
 * 音声Blobは IndexedDB に保存されるため、ここではキャッシュしない（コード/アセットのみ）。
 *
 * 戦略:
 *   - 同一オリジンの App Shell: cache-first（オフラインで確実に起動）
 *   - それ以外: network-first フォールバック（開発中の外部取得など）
 */
const CACHE = 'hearbit-v3';

// スコープ（app/）基準の相対パス。sw.js は app/ 直下に置く前提。
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/db.js',
  './js/splitter.js',
  './js/listen-build.js',
  './js/player.js',
  './js/listen.js',
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
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => {
        // 一部アセットが欠けていても install 自体は続行（開発時の欠損に強く）
        console.warn('[SW] precache partial failure', err);
      })
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
function networkFirst(req) {
  return fetch(req)
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
      const network = fetch(req)
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
