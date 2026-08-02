/* 機能A: 元音声の該当区間（start〜end）を位置指定で再生する再生エンジン。
 * 分割後の音声は保存していないので、元ページ音声Blobをロードし
 * currentTime=start で再生 → end に達したら停止/次へ。
 *
 * この Player は「単語の連番リスト」を持ち、prev/next で前後の単語へ移動できる。
 * ミニプレーヤー / 全画面プレーヤー / Media Session（ロック画面）は同一の再生状態を共有する。
 *
 * end判定は timeupdate（〜250ms間隔）では粗く単語の頭が漏れ聞こえるため、
 * 再生中のみ requestAnimationFrame ループで currentTime を監視して即停止する。
 */
const Player = (() => {
  const audio = document.getElementById('audio-el');

  // ミニプレーヤー
  const mini = document.getElementById('mini-player');
  const miniLabel = document.getElementById('mini-label');
  const miniToggle = document.getElementById('mini-toggle');
  const miniExpand = document.getElementById('mini-expand');

  // 全画面プレーヤー
  const full = document.getElementById('full-player');
  const fpPage = document.getElementById('fp-page');
  const fpNum = document.getElementById('fp-num');
  const fpSerial = document.getElementById('fp-serial');
  const fpBlocks = document.getElementById('fp-blocks');
  const fpCollapse = document.getElementById('fp-collapse');
  const fpToggle = document.getElementById('fp-toggle');
  const fpPrev = document.getElementById('fp-prev');
  const fpNext = document.getElementById('fp-next');
  const fpWave = document.getElementById('fp-wave');
  const fpCur = document.getElementById('fp-cur');
  const fpDur = document.getElementById('fp-dur');
  const seekbar = document.getElementById('seekbar');
  const seekFill = document.getElementById('seek-fill');
  const seekThumb = document.getElementById('seek-thumb');

  // --- 再生状態 ---
  let playlist = [];      // [{ page, segIndex, start, end, length, type, wordNo, serial, pageLabel }]
  let currentIndex = -1;  // playlist 内の現在位置
  let bookName = '';      // Media Session artist
  let getBlobFor = null;  // async (page) => Blob  ページ音声Blob取得関数（app.jsから注入）
  let onCellChange = null;// (index) => void  一覧セルのハイライト更新（app.jsから注入）

  let currentUrl = null;
  let currentBlobPage = null; // 現在ロード中の元音声ページ（同ページ内移動でsrc再利用）
  let stopAt = null;
  let rafId = null;
  let playToken = 0;
  let isPlaying = false;
  let seeking = false;

  // ---------- 表示ユーティリティ ----------
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function setPlayingUI(playing) {
    isPlaying = playing;
    mini.classList.toggle('paused', !playing);
    full.classList.toggle('paused', !playing);
    full.classList.toggle('playing-state', playing);
    mini.classList.toggle('playing-anim', playing);
    fpWave.classList.toggle('playing-anim', playing);
    // アイコン切替
    for (const btn of [miniToggle, fpToggle]) {
      btn.querySelector('.ic-play').classList.toggle('hidden', playing);
      btn.querySelector('.ic-pause').classList.toggle('hidden', !playing);
    }
    if (navigator.mediaSession) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }

  function updateLabels() {
    const w = playlist[currentIndex];
    if (!w) return;
    miniLabel.textContent = `${w.pageLabel} · 単語${w.wordNo}`;
    fpPage.textContent = w.pageLabel;
    fpNum.textContent = String(w.wordNo);
    fpSerial.textContent = `#${w.serial}`;
    fpBlocks.textContent = (w.length >= 8) ? '単語 → 訳 → 例文' : '単語 → 訳';
    fpDur.textContent = fmt(w.length);
    updateMediaMetadata();
  }

  function updateSeek() {
    const w = playlist[currentIndex];
    if (!w || seeking) return;
    const pos = Math.min(Math.max(audio.currentTime - w.start, 0), w.length);
    const ratio = w.length > 0 ? pos / w.length : 0;
    seekFill.style.width = `${ratio * 100}%`;
    seekThumb.style.left = `${ratio * 100}%`;
    fpCur.textContent = fmt(pos);
    seekbar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  // ---------- Media Session ----------
  function updateMediaMetadata() {
    if (!('mediaSession' in navigator)) return;
    const w = playlist[currentIndex];
    if (!w) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `単語 ${w.wordNo} (#${w.serial})`,
        artist: bookName || 'Hearbit',
        album: w.pageLabel,
        artwork: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
    } catch (e) { /* MediaMetadata 未対応環境 */ }
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, handler) => {
      try { ms.setActionHandler(action, handler); }
      catch (e) { /* 未対応アクションは無視 */ }
    };
    set('play', () => resume());
    set('pause', () => pause());
    set('previoustrack', () => prev());
    set('nexttrack', () => next());
    set('seekbackward', (d) => seekBy(-(d && d.seekOffset ? d.seekOffset : 5)));
    set('seekforward', (d) => seekBy(d && d.seekOffset ? d.seekOffset : 5));
    set('stop', () => stop());
    console.log('[Hearbit] Media Session handlers set');
  }

  // ---------- end 監視 ----------
  function tick() {
    updateSeek();
    if (stopAt != null && audio.currentTime >= stopAt) {
      onEnded();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }
  function startWatch() { if (rafId != null) cancelAnimationFrame(rafId); rafId = requestAnimationFrame(tick); }
  function stopWatch() { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } }

  function onEnded() {
    stopWatch();
    audio.pause();
    setPlayingUI(false);
    updateSeek();
    // 機能A（1語再生）: 末尾に達したら一時停止で待機（自動で次へは進まない）。
    // ロック画面/イヤホンの next で明示的に次へ進める。
  }

  audio.addEventListener('ended', onEnded);

  function revoke() {
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; currentBlobPage = null; }
  }

  // ---------- 再生コア ----------
  async function loadAndPlay(index, { autoplay = true } = {}) {
    if (index < 0 || index >= playlist.length) return;
    const w = playlist[index];
    const myToken = ++playToken;
    stopWatch();
    audio.pause();

    currentIndex = index;
    if (onCellChange) onCellChange(index);
    updateLabels();
    showMini();

    // 同じページ音声なら src を再利用（seek のみ）。ページが変わる時だけ差し替える。
    if (currentBlobPage !== w.page || !currentUrl) {
      revoke();
      const blob = await getBlobFor(w.page);
      if (myToken !== playToken) return;
      if (!blob) { console.warn('音声が見つかりません', w.page); return; }
      currentUrl = URL.createObjectURL(blob);
      currentBlobPage = w.page;
      audio.src = currentUrl;
      audio.load();
      await new Promise((resolve) => {
        const onReady = () => { audio.removeEventListener('loadedmetadata', onReady); resolve(); };
        if (audio.readyState >= 1) resolve();
        else audio.addEventListener('loadedmetadata', onReady);
      });
      if (myToken !== playToken) return;
    }

    stopAt = w.end;
    try { audio.currentTime = w.start; } catch (e) { /* Safari: play後に再設定 */ }

    if (!autoplay) { setPlayingUI(false); updateSeek(); return; }

    try {
      await audio.play();
    } catch (e) {
      if (myToken === playToken && e && e.name !== 'AbortError') console.warn('play() failed', e);
      setPlayingUI(false);
      return;
    }
    if (myToken !== playToken) { audio.pause(); return; }
    if (Math.abs(audio.currentTime - w.start) > 0.3) audio.currentTime = w.start;

    setPlayingUI(true);
    startWatch();
  }

  // ---------- 公開操作 ----------
  function playIndex(index) { return loadAndPlay(index, { autoplay: true }); }

  async function resume() {
    if (currentIndex < 0) return;
    const w = playlist[currentIndex];
    // 末尾で止まっていたら頭から鳴らし直す
    if (audio.currentTime >= (stopAt ?? w.end) - 0.02 || audio.currentTime < w.start) {
      try { audio.currentTime = w.start; } catch (e) {}
    }
    try { await audio.play(); setPlayingUI(true); startWatch(); }
    catch (e) { if (e && e.name !== 'AbortError') console.warn('resume failed', e); }
  }

  function pause() {
    // playToken を進めることで、進行中の loadAndPlay の後続 play() を無効化する
    // （prev/next 直後に pause した際の再生ちらつきを防ぐ）。
    playToken++;
    audio.pause();
    stopWatch();
    setPlayingUI(false);
    updateSeek();
  }

  function toggle() { if (isPlaying) pause(); else resume(); }

  function prev() {
    if (currentIndex > 0) playIndex(currentIndex - 1);
    else { const w = playlist[currentIndex]; if (w) { audio.currentTime = w.start; resume(); } }
  }
  function next() {
    if (currentIndex < playlist.length - 1) playIndex(currentIndex + 1);
    else onEnded();
  }

  function seekBy(delta) {
    const w = playlist[currentIndex];
    if (!w) return;
    let t = audio.currentTime + delta;
    t = Math.min(Math.max(t, w.start), w.end - 0.05);
    try { audio.currentTime = t; } catch (e) {}
    updateSeek();
  }

  function seekToRatio(ratio) {
    const w = playlist[currentIndex];
    if (!w) return;
    ratio = Math.min(Math.max(ratio, 0), 1);
    const t = w.start + ratio * w.length;
    try { audio.currentTime = Math.min(t, w.end - 0.02); } catch (e) {}
    updateSeek();
  }

  function stop() {
    playToken++;
    stopWatch();
    audio.pause();
    revoke();
    stopAt = null;
    currentIndex = -1;
    isPlaying = false;
    hideMini(); hideFull();
    if (onCellChange) onCellChange(-1);
    if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none';
  }

  // ---------- プレーヤーUIの表示制御 ----------
  function showMini() { mini.classList.remove('hidden'); document.body.classList.add('mini-open'); }
  function hideMini() { mini.classList.add('hidden'); document.body.classList.remove('mini-open'); }
  function showFull() { updateLabels(); updateSeek(); full.classList.remove('hidden'); }
  function hideFull() { full.classList.add('hidden'); }

  // ---------- UIイベント ----------
  miniToggle.addEventListener('click', toggle);
  fpToggle.addEventListener('click', toggle);
  fpPrev.addEventListener('click', prev);
  fpNext.addEventListener('click', next);
  miniExpand.addEventListener('click', showFull);
  mini.addEventListener('click', (e) => { if (e.target.closest('button')) return; showFull(); });
  fpCollapse.addEventListener('click', hideFull);

  // シークバー（タップ/ドラッグ）
  function seekFromEvent(e) {
    const rect = seekbar.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    seekToRatio(rect.width > 0 ? x / rect.width : 0);
  }
  seekbar.addEventListener('pointerdown', (e) => { seeking = true; seekbar.setPointerCapture(e.pointerId); seekFromEvent(e); });
  seekbar.addEventListener('pointermove', (e) => { if (seeking) seekFromEvent(e); });
  seekbar.addEventListener('pointerup', (e) => { seeking = false; });
  seekbar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') seekBy(1);
    else if (e.key === 'ArrowLeft') seekBy(-1);
  });

  // ---------- app.js からの設定 ----------
  function configure(opts) {
    playlist = opts.playlist || [];
    bookName = opts.bookName || '';
    getBlobFor = opts.getBlobFor;
    onCellChange = opts.onCellChange || null;
    currentIndex = -1;
    currentBlobPage = null;
    setupMediaSession();
  }

  return {
    configure,
    playIndex, prev, next, toggle, pause, resume, stop,
    showFull, hideFull,
    getIndex: () => currentIndex,
  };
})();
