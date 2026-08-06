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
  const fpText = document.getElementById('fp-text');
  const fpHanzi = document.getElementById('fp-hanzi');
  const fpPinyin = document.getElementById('fp-pinyin');
  const fpGloss = document.getElementById('fp-gloss');
  const fpBlocks = document.getElementById('fp-blocks');
  const fpCollapse = document.getElementById('fp-collapse');
  const fpStar = document.getElementById('fp-star');
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
  let onToggleStar = null;// async (page, segIndex) => void  スター切替（app.jsから注入）

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

  // 実効再生開始位置: word+announce はアナウンスを飛ばして単語本体（effStart）から鳴らす。
  // app.js が playlist 各要素に effStart を持たせる。無ければ start にフォールバック。
  function startOf(w) { return (w && w.effStart != null) ? w.effStart : (w ? w.start : 0); }
  // 実効の尺（アナウンスを除いた単語本体の長さ）。シークバー/時間表示に使う。
  function lengthOf(w) { return w ? Math.max(0, w.end - startOf(w)) : 0; }

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
    // 漢字・ピンイン（テキストがあれば表示。番号は上部に残す）。無ければ hidden。
    const t = w.text;
    const hasText = !!(t && (t.hanzi || t.pinyin));
    fpText.classList.toggle('hidden', !hasText);
    if (hasText) {
      fpHanzi.textContent = t.hanzi || '';
      fpPinyin.textContent = t.pinyin || '';
      fpText.classList.toggle('low-conf', !!t.low_confidence);
      const hasGloss = !!(t.gloss && t.gloss.trim());
      fpGloss.classList.toggle('hidden', !hasGloss);
      fpGloss.textContent = hasGloss ? t.gloss : '';
    }
    fpBlocks.textContent = (w.length >= 8) ? '単語 → 訳 → 例文' : '単語 → 訳';
    updateStar();
    fpDur.textContent = fmt(lengthOf(w));
    // 全画面プレーヤーの ◀◀/▶▶ も先頭/末尾で無効化（ロック画面と挙動を揃える）
    fpPrev.disabled = currentIndex <= 0;
    fpNext.disabled = currentIndex >= playlist.length - 1;
    updateMediaMetadata();
  }

  // 全画面プレーヤーのスターボタン表示を現在語の starred で更新。
  function updateStar() {
    if (!fpStar) return;
    const w = playlist[currentIndex];
    const on = !!(w && w.starred);
    fpStar.classList.toggle('on', on);
    fpStar.setAttribute('aria-pressed', String(on));
    fpStar.setAttribute('aria-label', on ? 'スターを外す' : 'スターを付ける');
  }

  function updateSeek() {
    const w = playlist[currentIndex];
    if (!w || seeking) return;
    const st = startOf(w), len = lengthOf(w);
    const pos = Math.min(Math.max(audio.currentTime - st, 0), len);
    const ratio = len > 0 ? pos / len : 0;
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
    // ロック画面のタイトルは漢字(+ピンイン)があればそれを優先。無ければ番号。
    let title = `単語 ${w.wordNo} (#${w.serial})`;
    if (w.text && (w.text.hanzi || w.text.pinyin)) {
      title = [w.text.hanzi, w.text.pinyin].filter(Boolean).join('  ');
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: bookName || 'Hearbit',
        album: w.pageLabel,
        artwork: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
    } catch (e) { /* MediaMetadata 未対応環境 */ }
  }

  function msSet(action, handler) {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.setActionHandler(action, handler); }
    catch (e) { /* 未対応アクションは無視 */ }
  }

  // Media Session ハンドラは【一度だけ】登録する（冪等）。
  // configure()（単語帳を開くたび）や loadAndPlay から再登録すると、iOS Safari では
  // 同じ操作（例: nexttrack）が2回発火して「次へ」で単語が1個飛ばしになる不具合が出る。
  // ハンドラは module-level の prev/next/resume/pause/seekBy/stop クロージャを参照し、
  // playlist / currentIndex はハンドラ内で毎回ライブに読むため、初回登録だけで単語帳を
  // 切り替えても正しく動く。
  // Media Session は機能A(Player)と機能B(Listen)で【共有】する。ハンドラは Player が
  // 一度だけ登録し、Listen が鳴っている間（Listen.isActive()）は Listen へ委譲する。
  // これにより「先に登録した方だけが操作できる」問題を避け、ロック画面の play/pause/prev/next
  // が常に「いま鳴っているモード」を操作する。metadata / playbackState は各モードが直接更新する。
  function listenActive() {
    return typeof Listen !== 'undefined' && Listen.isActive && Listen.isActive();
  }
  let mediaSessionReady = false;
  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    if (mediaSessionReady) return; // 二重登録防止（冪等）
    mediaSessionReady = true;
    msSet('play', () => listenActive() ? Listen.resume() : resume());
    msSet('pause', () => listenActive() ? Listen.pause() : pause());
    msSet('previoustrack', () => listenActive() ? Listen.prev() : prev());
    msSet('nexttrack', () => listenActive() ? Listen.next() : next());
    msSet('seekbackward', (d) => { if (!listenActive()) seekBy(-(d && d.seekOffset ? d.seekOffset : 5)); });
    msSet('seekforward', (d) => { if (!listenActive()) seekBy(d && d.seekOffset ? d.seekOffset : 5); });
    msSet('stop', () => listenActive() ? Listen.stop() : stop());
    console.log('[Hearbit] Media Session handlers set (once)');
  }

  /* 先頭/末尾の扱い（iOS実機バグ対策で方針変更）:
   * 以前は setActionHandler を null/関数でトグルして OS 側のボタンを無効化していたが、
   * iOS Safari には「一度 null にしたハンドラを関数へ戻してもボタンが無効のまま」に
   * なる既知の不具合があり、途中の単語（例: 001の単語2）で次へが出なくなる症状を招いた。
   * → Media Session の previoustrack / nexttrack は【常に登録しっぱなし】（setupMediaSession）。
   *   先頭/末尾の抑止は prev()/next() 側の no-op（境界ガード）で担保する。
   *   ボタンの見た目上の無効化は、確実に効く DOM（全画面プレーヤーの ◀◀/▶▶ の disabled、
   *   updateLabels 内）だけで行う。ロック画面のボタンは常に押せ、境界では no-op になる
   *   （誤作動せず、途中でボタンが消える問題も起きない）。 */

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
    // 排他制御: 機能B(聞き流し)が鳴っていたら停止する（同時に鳴らさない）。
    if (typeof Listen !== 'undefined' && Listen.isActive && Listen.isActive()) Listen.stop();
    const w = playlist[index];
    const myToken = ++playToken;
    stopWatch();
    audio.pause();

    currentIndex = index;
    if (onCellChange) onCellChange(index);
    updateLabels(); // ラベル更新 + 全画面 ◀◀/▶▶ の境界 disabled 反映
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

    const st = startOf(w); // アナウンス付きは announce_end から（単語本体の頭）
    stopAt = w.end;
    try { audio.currentTime = st; } catch (e) { /* Safari: play後に再設定 */ }

    if (!autoplay) { setPlayingUI(false); updateSeek(); return; }

    try {
      await audio.play();
    } catch (e) {
      if (myToken === playToken && e && e.name !== 'AbortError') console.warn('play() failed', e);
      setPlayingUI(false);
      return;
    }
    if (myToken !== playToken) { audio.pause(); return; }
    if (Math.abs(audio.currentTime - st) > 0.3) audio.currentTime = st;

    setPlayingUI(true);
    startWatch();
  }

  // ---------- 公開操作 ----------
  function playIndex(index) { return loadAndPlay(index, { autoplay: true }); }

  async function resume() {
    if (currentIndex < 0) return;
    const w = playlist[currentIndex];
    const st = startOf(w); // アナウンス付きは単語本体の頭から
    // 末尾で止まっていたら（実効の）頭から鳴らし直す
    if (audio.currentTime >= (stopAt ?? w.end) - 0.02 || audio.currentTime < st) {
      try { audio.currentTime = st; } catch (e) {}
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

  /* 仕様（末尾/先頭の扱い）:
   *   - 先頭(index 0)での prev は no-op（境界ガード）。同じ単語の頭出しはしない＝対称。
   *   - 末尾(index length-1)での next は no-op。onEnded は timeupdate 監視からのみ呼ぶ。
   * ロック画面のボタンは常に押せるが、境界ではこのガードで何も起きない（誤作動しない）。
   * 全画面プレーヤーの ◀◀/▶▶ は updateLabels() で境界時に disabled 表示にする。
   *
   * 二重発火ガード: iOS の Media Session は同一操作を極短時間に2回発火することがある。
   * 根本原因（ハンドラ二重登録）は setupMediaSession の冪等化で解消済みだが、保険として
   * 250ms 以内の連続した prev/next は1回だけ受け付ける（人手の連打は250ms超なので影響なし）。 */
  let lastNavAt = 0;
  function navDebounced() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - lastNavAt < 250) return false;
    lastNavAt = now;
    return true;
  }
  function prev() {
    if (!navDebounced()) return;
    if (currentIndex > 0) playIndex(currentIndex - 1);
  }
  function next() {
    if (!navDebounced()) return;
    if (currentIndex >= 0 && currentIndex < playlist.length - 1) playIndex(currentIndex + 1);
  }

  function seekBy(delta) {
    const w = playlist[currentIndex];
    if (!w) return;
    let t = audio.currentTime + delta;
    // 下限は実効start（アナウンス部へは戻さない）
    t = Math.min(Math.max(t, startOf(w)), w.end - 0.05);
    try { audio.currentTime = t; } catch (e) {}
    updateSeek();
  }

  function seekToRatio(ratio) {
    const w = playlist[currentIndex];
    if (!w) return;
    ratio = Math.min(Math.max(ratio, 0), 1);
    // シークは実効区間（単語本体 startOf〜end）に対して行う
    const t = startOf(w) + ratio * lengthOf(w);
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
  if (fpStar) fpStar.addEventListener('click', () => {
    const w = playlist[currentIndex];
    if (!w || !onToggleStar) return;
    // 楽観更新（即時にトグル反映）。app.js 側で永続化 → refreshCurrent で確定表示。
    w.starred = !w.starred;
    updateStar();
    Promise.resolve(onToggleStar(w.page, w.segIndex)).catch(() => {
      w.starred = !w.starred; updateStar(); // 失敗時は戻す
    });
  });

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
    const prevLen = playlist.length;
    const prevIndex = currentIndex;
    playlist = opts.playlist || [];
    bookName = opts.bookName || '';
    getBlobFor = opts.getBlobFor;
    onCellChange = opts.onCellChange || null;
    if (opts.onToggleStar !== undefined) onToggleStar = opts.onToggleStar;
    // テキスト編集など「同じ単語帳の再構成」では、再生位置を保つ（-1 に落とさない）。
    // 単語数が変わった（＝別の単語帳/分割変更）場合のみ位置をリセットする。
    if (opts.preserveIndex && playlist.length === prevLen && prevIndex >= 0 && prevIndex < playlist.length) {
      currentIndex = prevIndex;
    } else {
      currentIndex = -1;
      currentBlobPage = null;
    }
    setupMediaSession();
  }

  // 現在再生中の単語のラベル/メタデータを再表示（テキスト編集の即反映用）。
  // playlist は configure で差し替え済み。currentIndex が有効ならラベルを描き直す。
  function refreshCurrent() {
    if (currentIndex < 0 || currentIndex >= playlist.length) return;
    updateLabels();
    updateSeek();
  }

  return {
    configure,
    playIndex, prev, next, toggle, pause, resume, stop,
    showFull, hideFull, refreshCurrent,
    getIndex: () => currentIndex,
  };
})();
