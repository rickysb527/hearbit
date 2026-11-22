/* アプリのバージョン（いま動いているコードの版）。
 * sw.js の VERSION と必ず同じ値にする（デプロイごとに両方 +1）。
 * 一致は app/verify/verify_version.js で確認する。
 * 設定画面に表示し、SW が新しい版を持っていたら「更新があります」を出す判定に使う。
 */
(function (root) {
  const APP_VERSION = 12;
  if (typeof module !== 'undefined' && module.exports) module.exports = { APP_VERSION };
  else root.APP_VERSION = APP_VERSION;
})(typeof self !== 'undefined' ? self : this);
