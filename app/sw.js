/* Hearbit Service Worker
 * アプリのコード・アセット（App Shell）をキャッシュしてオフライン起動を可能にする。
 * 音声Blobは IndexedDB に保存されるため、ここではキャッシュしない（コード/アセットのみ）。
 *
 * 戦略:
 *   - 同一オリジンの App Shell: cache-first（オフラインで確実に起動）
 *   - それ以外: network-first フォールバック（開発中の外部取得など）
 */
const CACHE = 'hearbit-v1';

// スコープ（app/）基準の相対パス。sw.js は app/ 直下に置く前提。
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/db.js',
  './js/splitter.js',
  './js/player.js',
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 同一オリジンのみキャッシュ対象（音声Blob URL 等は対象外）
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // 取得できたら動的にキャッシュへ（App Shell 更新に追随）
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // オフラインでナビゲーション要求ならトップにフォールバック
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        });
    })
  );
});
