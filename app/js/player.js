/* 機能A: 元音声の該当区間（start〜end）を位置指定で再生する。
 * 分割後の音声は保存していないので、元ページ音声Blobをロードし
 * currentTime=start で再生 → end に達したら即停止する。
 *
 * end判定は timeupdate（〜250ms間隔）では粗く、単語の頭が漏れ聞こえるため、
 * 再生中のみ requestAnimationFrame ループで currentTime を監視して即停止する。
 */
const Player = (() => {
  const audio = document.getElementById('audio-el');
  const bar = document.getElementById('player-bar');
  const info = document.getElementById('player-info');
  const stopBtn = document.getElementById('player-stop');

  let currentUrl = null;
  let stopAt = null;
  let onStopCb = null;
  let rafId = null;
  let playToken = 0; // 連続タップ時に古い再生の解決を無効化するための世代トークン

  function tick() {
    if (stopAt != null && audio.currentTime >= stopAt) {
      stop();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function startWatch() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  function stopWatch() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // ended でも念のため止める（末尾セグメントで end が duration を僅かに超える場合）
  audio.addEventListener('ended', () => stop());

  function revoke() {
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  }

  function stop() {
    playToken++;         // 進行中の playSegment の後続処理を無効化
    stopWatch();
    audio.pause();
    stopAt = null;
    bar.classList.add('hidden');
    if (onStopCb) { const cb = onStopCb; onStopCb = null; cb(); }
  }

  stopBtn.addEventListener('click', stop);

  /* blob: 元ページ音声 / seg: {start,end} / label: 表示 / onStop: 終了コールバック */
  async function playSegment(blob, seg, label, onStop) {
    stop();                 // 直前の再生を確実に停止（playToken も進む）
    const myToken = ++playToken;
    revoke();

    currentUrl = URL.createObjectURL(blob);
    audio.src = currentUrl;
    audio.load();           // readyState を確実にリセットしてから loadedmetadata を待つ
    onStopCb = onStop || null;
    stopAt = seg.end;
    info.textContent = label || '再生中…';
    bar.classList.remove('hidden');

    // メタデータ（尺・シーク可能）を待つ
    await new Promise((resolve) => {
      const onReady = () => { audio.removeEventListener('loadedmetadata', onReady); resolve(); };
      if (audio.readyState >= 1) resolve();
      else audio.addEventListener('loadedmetadata', onReady);
    });
    if (myToken !== playToken) return; // 待機中に別の再生/停止が来たら破棄

    try {
      audio.currentTime = seg.start;
    } catch (e) { /* Safari: seek不可時は play後に再設定 */ }

    try {
      await audio.play();
    } catch (e) {
      // 連続タップで src 差し替え時に "play() request was interrupted" 等が出る。
      // 自分の世代が最新なら想定外エラーのみログ、古い世代は無視。
      if (myToken === playToken && e && e.name !== 'AbortError') {
        console.warn('playSegment: play() failed', e);
      }
      return;
    }
    if (myToken !== playToken) { audio.pause(); return; } // play解決中に別再生が来た

    // 一部ブラウザで play前の currentTime 設定が効かないことがあるので再設定
    if (Math.abs(audio.currentTime - seg.start) > 0.3) {
      audio.currentTime = seg.start;
    }

    startWatch(); // end 監視開始（再生中のみ回す）
  }

  return { playSegment, stop };
})();
