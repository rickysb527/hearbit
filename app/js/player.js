/* 機能A: 元音声の該当区間（start〜end）を位置指定で再生する。
 * 分割後の音声は保存していないので、元ページ音声Blobをロードし
 * currentTime=start で再生 → end に達したら停止する。
 */
const Player = (() => {
  const audio = document.getElementById('audio-el');
  const bar = document.getElementById('player-bar');
  const info = document.getElementById('player-info');
  const stopBtn = document.getElementById('player-stop');

  let currentUrl = null;
  let stopAt = null;
  let onStopCb = null;

  function tick() {
    if (stopAt != null && audio.currentTime >= stopAt) {
      stop();
    }
  }
  audio.addEventListener('timeupdate', tick);
  audio.addEventListener('ended', () => stop());

  function revoke() {
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  }

  function stop() {
    audio.pause();
    stopAt = null;
    bar.classList.add('hidden');
    if (onStopCb) { const cb = onStopCb; onStopCb = null; cb(); }
  }

  stopBtn.addEventListener('click', stop);

  /* blob: 元ページ音声 / seg: {start,end} / label: 表示 / onStop: 終了コールバック */
  async function playSegment(blob, seg, label, onStop) {
    stop();
    revoke();
    currentUrl = URL.createObjectURL(blob);
    audio.src = currentUrl;
    onStopCb = onStop || null;
    stopAt = seg.end;
    info.textContent = label || '再生中…';
    bar.classList.remove('hidden');

    await new Promise((resolve) => {
      const onReady = () => { audio.removeEventListener('loadedmetadata', onReady); resolve(); };
      if (audio.readyState >= 1) resolve();
      else audio.addEventListener('loadedmetadata', onReady);
    });

    try {
      audio.currentTime = seg.start;
    } catch (e) { /* Safari: seek後にplayで再試行 */ }
    await audio.play();
    // 一部ブラウザで currentTime設定がplay前に効かないことがあるので再設定
    if (Math.abs(audio.currentTime - seg.start) > 0.3) {
      audio.currentTime = seg.start;
    }
  }

  return { playSegment, stop };
})();
