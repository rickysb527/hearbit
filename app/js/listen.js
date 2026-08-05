/* 機能B（聞き流し / Listen）: 単語部分だけを 50語/100語で連結し、
 * 1本の音声として連続再生する散歩用プレーヤー。
 *
 * ============================================================================
 * なぜ「連結して1本」なのか（CLAUDE.md / DESIGN.md の設計ポイント）
 * ----------------------------------------------------------------------------
 * iOS はロック中にバックグラウンドの JS 実行を絞る。機能A(player.js)のように
 * audio.onended → 次を再生 という「都度JSで繋ぐ」方式は、ロック中に止まりうる。
 * 機能Bは散歩用途（画面オフ・ロック中）が主眼なので、
 *   各単語の「単語+訳」区間の PCM を切り出して 1本の AudioBuffer に連結し、
 *   AudioBufferSourceNode 1ソースとして再生する。
 * ソースは1つなので、いったん start すればロック中も OS 側でそのまま流れ続ける
 * （JS が動かなくても最後まで途切れない）。これが最も確実な方式。
 *
 * ============================================================================
 * wordonly の抽出ロジック（build_chunks.py 準拠 / listen-build.js に純関数化）
 * ----------------------------------------------------------------------------
 * 各単語セグメント内を無音(0.4秒以上)でブロック分割し、先頭2ブロック（単語・訳）を取る。
 * word_only ページは元々「単語+訳」なので実質そのまま。アナウンス付きセグメントは
 * announce_end 以降が単語なのでそこから抽出。詳細は listen-build.js を参照。
 *
 * 排他制御: 機能A(Player) とは同時に鳴らさない。listen 再生開始時に Player.stop() を
 * 呼び、Player 側の再生開始時に Listen.stop() を呼ぶ（app.js が仲介）。
 */
const Listen = (() => {
  const GAP_SEC = ListenBuild.GAP_SEC; // 単語間ギャップ（build_chunks.py と同じ 0.3s）

  // --- Web Audio ---
  let ctx = null;
  function audioCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    return ctx;
  }

  // --- 状態 ---
  let bookName = '';
  let words = [];             // ListenBuild.collectWords の結果（全単語・順序どおり）
  let getBlobFor = null;      // async (page) => Blob
  let textFor = null;         // (page, segIndex) => { hanzi, pinyin, gloss, low_confidence } | null
  let onBoundary = null;      // (wordIdxInTrack) => void  UI更新コールバック

  // 現在ロード中のトラック（連結1本）の情報
  let track = null;           // { buffer, boundaries[], wordCount, rangeFrom, rangeTo, size }
  let sourceNode = null;      // 現在の AudioBufferSourceNode
  let gainNode = null;
  let isPlaying = false;
  let playToken = 0;

  // 再生位置の基準（AudioContext.currentTime ベースで算出）
  let startedAtCtxTime = 0;   // source.start した時の ctx.currentTime
  let offsetInBuffer = 0;     // その時のバッファ内オフセット（pause/seek 用）
  let rafId = null;
  let currentWordInTrack = -1;

  // 無音検知結果のキャッシュ（ページ単位）: 同じページを何度も decode しないため
  const pageCache = new Map(); // page -> { audioBuffer }

  // ================= トラック構築 =================
  /* 指定範囲(rangeFrom..rangeTo, 0-based 半開区間) の単語を切り出して
   * 1本の AudioBuffer に連結する。境界(各単語の先頭サンプル秒)配列も返す。
   */
  async function buildTrack(rangeFrom, rangeTo, size, onProgress) {
    const myToken = ++buildToken;
    const sr = audioCtx().sampleRate;
    const channels = 1; // モノラルで連結（容量/処理を軽く。散歩用途で十分）
    const gapSamples = Math.round(GAP_SEC * sr);

    const slice = words.slice(rangeFrom, rangeTo);

    // 1) 必要ページを decode（キャッシュ利用）し、各単語の [start,end] サンプル区間を集める。
    //    wordonly 範囲（単語+訳の先頭2ブロック）は、そのページの無音区間から遅延確定する
    //    （元音声139MBを一度に decode しないため、必要ページだけ処理）。
    const clips = [];
    for (let i = 0; i < slice.length; i++) {
      if (myToken !== buildToken) return null; // 途中でキャンセル
      const w = slice[i];
      const { audioBuffer, silences } = await getDecoded(w.page);
      if (myToken !== buildToken) return null;
      const [s, e] = ListenBuild.wordonlyRange(w.seg, silences);
      const data = extractMono(audioBuffer, s, e);
      clips.push(data);
      if (onProgress) onProgress(i + 1, slice.length);
      // decode/切り出しは重いので UI に制御を返す
      await new Promise((r) => setTimeout(r, 0));
    }

    // 2) 連結長を計算（クリップ + 単語間ギャップ）
    let totalLen = 0;
    for (let i = 0; i < clips.length; i++) {
      if (i > 0) totalLen += gapSamples;
      totalLen += clips[i].length;
    }
    const out = audioCtx().createBuffer(channels, Math.max(1, totalLen), sr);
    const outData = out.getChannelData(0);

    // 3) 連結しつつ、各単語の先頭秒（境界）を記録
    const boundaries = [];
    let pos = 0;
    for (let i = 0; i < clips.length; i++) {
      if (i > 0) pos += gapSamples; // ギャップ（無音なので書き込み不要, out は0埋め）
      boundaries.push(pos / sr);
      outData.set(clips[i], pos);
      pos += clips[i].length;
    }

    return {
      buffer: out,
      boundaries,
      wordCount: clips.length,
      rangeFrom, rangeTo, size,
      duration: out.duration,
    };
  }
  let buildToken = 0;

  async function getDecoded(page) {
    if (pageCache.has(page)) return pageCache.get(page);
    const blob = await getBlobFor(page);
    if (!blob) throw new Error('audio not found: ' + page);
    const arr = await blob.arrayBuffer();
    const audioBuffer = await new Promise((resolve, reject) => {
      audioCtx().decodeAudioData(arr.slice(0), resolve, reject);
    });
    // wordonly 用の無音区間を検出（Splitter と同一: noise=-30dB, min_silence=0.4s）。
    // ページ全体をモノラル化してから detectSilences（build_chunks.py の silencedetect 相当）。
    const mono = toMono(audioBuffer);
    const silences = Splitter.detectSilences(mono, audioBuffer.sampleRate);
    const rec = { audioBuffer, silences };
    pageCache.set(page, rec);
    return rec;
  }

  function toMono(audioBuffer) {
    const len = audioBuffer.length;
    const chs = audioBuffer.numberOfChannels;
    const out = new Float32Array(len);
    for (let c = 0; c < chs; c++) {
      const d = audioBuffer.getChannelData(c);
      for (let i = 0; i < len; i++) out[i] += d[i];
    }
    if (chs > 1) for (let i = 0; i < len; i++) out[i] /= chs;
    return out;
  }

  /* AudioBuffer の [s,e] 秒をモノラル Float32 で取り出す（複数chは平均）。 */
  function extractMono(audioBuffer, s, e) {
    const sr = audioBuffer.sampleRate;
    const total = audioBuffer.length;
    let i0 = Math.max(0, Math.round(s * sr));
    let i1 = Math.min(total, Math.round(e * sr));
    if (i1 <= i0) i1 = Math.min(total, i0 + 1);
    const n = i1 - i0;
    const out = new Float32Array(n);
    const chs = audioBuffer.numberOfChannels;
    for (let c = 0; c < chs; c++) {
      const d = audioBuffer.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i0 + i];
    }
    if (chs > 1) for (let i = 0; i < n; i++) out[i] /= chs;
    return out;
  }

  // ================= 再生コア =================
  function stopSource() {
    if (sourceNode) {
      try { sourceNode.onended = null; sourceNode.stop(); } catch (e) {}
      try { sourceNode.disconnect(); } catch (e) {}
      sourceNode = null;
    }
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function playFrom(offsetSec) {
    if (!track) return;
    stopSource();
    const c = audioCtx();
    if (c.state === 'suspended') c.resume();
    const src = c.createBufferSource();
    src.buffer = track.buffer;
    if (!gainNode) { gainNode = c.createGain(); gainNode.connect(c.destination); }
    src.connect(gainNode);
    const myToken = ++playToken;
    src.onended = () => {
      if (myToken !== playToken) return; // stop/seek による差し替えは無視
      onTrackEnded();
    };
    offsetInBuffer = Math.min(Math.max(offsetSec, 0), track.duration);
    startedAtCtxTime = c.currentTime;
    src.start(0, offsetInBuffer);
    sourceNode = src;
    isPlaying = true;
    setPlayingUI(true);
    startWatch();
  }

  function currentPos() {
    if (!track) return 0;
    if (!isPlaying) return offsetInBuffer;
    return Math.min(offsetInBuffer + (audioCtx().currentTime - startedAtCtxTime), track.duration);
  }

  // 連結トラック内の語順(0-based) → 元の words[] の要素（page/seg を持つ）。
  function trackWord(wiInTrack) {
    if (!track || wiInTrack < 0) return null;
    const globalIdx = track.rangeFrom + wiInTrack;
    return words[globalIdx] || null;
  }
  // 現在語のテキスト（漢字・ピンイン・訳）。textFor が無い/未紐付けなら null。
  function textForTrackWord(wiInTrack) {
    const w = trackWord(wiInTrack);
    if (!w || !textFor) return null;
    const t = textFor(w.page, w.seg.index);
    if (!t || (!t.hanzi && !t.pinyin && !t.gloss)) return null;
    return t;
  }

  function wordIndexAt(posSec) {
    if (!track) return -1;
    const b = track.boundaries;
    let idx = 0;
    for (let i = 0; i < b.length; i++) {
      if (posSec >= b[i]) idx = i; else break;
    }
    return idx;
  }

  function onTrackEnded() {
    isPlaying = false;
    offsetInBuffer = track ? track.duration : 0;
    stopSource();
    setPlayingUI(false);
    // 末尾で停止（機能A同様、自動で次トラックへは進まない）。UI は最終語で止める。
    currentWordInTrack = track ? track.wordCount - 1 : -1;
    updateProgressUI(track ? track.duration : 0);
    if (onBoundary) onBoundary(currentWordInTrack);
    updateMediaMetadata();
  }

  // ================= 監視ループ（進捗/境界更新） =================
  function tick() {
    const pos = currentPos();
    updateProgressUI(pos);
    const wi = wordIndexAt(pos);
    if (wi !== currentWordInTrack) {
      currentWordInTrack = wi;
      if (onBoundary) onBoundary(wi);
      updateMediaMetadata();
    }
    rafId = requestAnimationFrame(tick);
  }
  function startWatch() { if (rafId != null) cancelAnimationFrame(rafId); rafId = requestAnimationFrame(tick); }

  // ================= 公開操作 =================
  /* トラックを構築して再生開始。rangeFrom/To は 0-based 半開。 */
  async function playRange(rangeFrom, rangeTo, size, { autoplay = true } = {}) {
    // 排他制御: 機能A(Player)と同時に鳴らさない。聞き流し開始時は必ず機能Aを停止する。
    if (typeof Player !== 'undefined' && Player.stop) Player.stop();
    audioCtx(); // ユーザー操作起点で AudioContext を起こす（iOS）
    if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    onLoadingUI(true);
    let built;
    try {
      built = await buildTrack(rangeFrom, rangeTo, size, (done, all) => onLoadingUI(true, done, all));
    } catch (e) {
      console.warn('[Listen] buildTrack failed', e);
      onLoadingUI(false);
      return;
    }
    if (!built) { onLoadingUI(false); return; } // キャンセル
    track = built;
    currentWordInTrack = -1;
    offsetInBuffer = 0;
    onLoadingUI(false);
    setupMediaSession();
    updateHeaderUI();
    if (autoplay) playFrom(0);
    else { updateProgressUI(0); currentWordInTrack = 0; if (onBoundary) onBoundary(0); updateMediaMetadata(); }
  }

  function pause() {
    if (!track || !isPlaying) return;
    offsetInBuffer = currentPos();
    isPlaying = false;
    stopSource();
    setPlayingUI(false);
    updateMediaMetadata();
  }

  function resume() {
    if (!track || isPlaying) return;
    // 末尾で止まっていたら頭から
    if (offsetInBuffer >= track.duration - 0.02) offsetInBuffer = 0;
    playFrom(offsetInBuffer);
    updateMediaMetadata();
  }

  function toggle() { if (isPlaying) pause(); else resume(); }

  /* 単語境界へシーク（連結1本の中でジャンプ）。dir: -1 前 / +1 次。 */
  let lastNavAt = 0;
  function nav(dir) {
    if (!track) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - lastNavAt < 250) return; // iOS Media Session 二重発火ガード（player.js と同方針）
    lastNavAt = now;
    const pos = currentPos();
    let wi = wordIndexAt(pos);
    if (dir < 0) {
      // 現在語の頭から2秒以内なら前の語へ、それ以外は現在語の頭へ（一般的なプレーヤー挙動）
      const curHead = track.boundaries[wi];
      if (pos - curHead < 1.5 && wi > 0) wi -= 1;
    } else {
      if (wi < track.wordCount - 1) wi += 1;
      else return; // 末尾で次は no-op
    }
    const target = track.boundaries[wi];
    offsetInBuffer = target;
    currentWordInTrack = wi;
    if (isPlaying) playFrom(target);
    else { updateProgressUI(target); }
    if (onBoundary) onBoundary(wi);
    updateMediaMetadata();
  }
  function prev() { nav(-1); }
  function next() { nav(1); }

  function stop() {
    playToken++;
    buildToken++;
    stopSource();
    isPlaying = false;
    offsetInBuffer = 0;
    currentWordInTrack = -1;
    // track は保持しない（メモリ解放）。UI も閉じる。
    track = null;
    setPlayingUI(false);
    hideFull();
    if (navigator.mediaSession) {
      try { navigator.mediaSession.playbackState = 'none'; } catch (e) {}
    }
  }

  // ================= Media Session =================
  // ハンドラ登録は player.js が一括で行い、Listen が鳴っている間は player.js が
  // Listen.resume/pause/prev/next/stop へ委譲する（listenActive 経由）。
  // ここでは metadata / playbackState の更新のみ担当する（二重登録を避ける）。
  function setupMediaSession() { /* no-op: handlers are owned by player.js */ }
  function updateMediaMetadata() {
    if (!('mediaSession' in navigator) || !track) return;
    const n = currentWordInTrack >= 0 ? currentWordInTrack + 1 : 1;
    // ロック画面タイトル: 漢字(+ピンイン)があればそれを優先。無ければ「聞き流し n/total」。
    const t = textForTrackWord(currentWordInTrack >= 0 ? currentWordInTrack : 0);
    let title = `聞き流し ${n}/${track.wordCount}`;
    if (t && (t.hanzi || t.pinyin)) {
      title = [t.hanzi, t.pinyin].filter(Boolean).join('  ') + `  (${n}/${track.wordCount})`;
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: bookName || 'Hearbit',
        album: `${track.size}語 · ${track.rangeFrom + 1}–${track.rangeTo}`,
        artwork: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } catch (e) {}
  }

  // ================= UI コールバック（app.js が注入） =================
  let ui = {
    onPlaying: () => {},
    onProgress: () => {},   // (ratio, wordNo, wordCount)
    onLoading: () => {},    // (loading, done, all)
    onHeader: () => {},     // ({ size, from, to, wordCount })
    hideFull: () => {},
  };
  function setPlayingUI(p) { ui.onPlaying(p); if (navigator.mediaSession) { try { navigator.mediaSession.playbackState = p ? 'playing' : 'paused'; } catch (e) {} } }
  function updateProgressUI(pos) {
    if (!track) return;
    const ratio = track.duration > 0 ? Math.min(pos / track.duration, 1) : 0;
    const wi = wordIndexAt(pos);
    // 第4引数: 現在語のテキスト（漢字・ピンイン・訳）。無ければ null（番号フォールバック）。
    ui.onProgress(ratio, wi + 1, track.wordCount, textForTrackWord(wi));
  }
  function onLoadingUI(loading, done, all) { ui.onLoading(loading, done, all); }
  function updateHeaderUI() {
    if (!track) return;
    ui.onHeader({ size: track.size, from: track.rangeFrom + 1, to: track.rangeTo, wordCount: track.wordCount });
  }
  function hideFull() { ui.hideFull(); }

  // ================= app.js からの設定 =================
  function configure(opts) {
    bookName = opts.bookName || '';
    words = opts.words || [];
    getBlobFor = opts.getBlobFor;
    if (opts.textFor !== undefined) textFor = opts.textFor; // page/index → テキスト解決
    ui = Object.assign(ui, opts.ui || {});
    // 単語帳が変わったのでページ decode キャッシュを破棄
    pageCache.clear();
    stop();
  }

  // テキスト編集後、いま表示中の語のテキストを引き直して再描画（再生位置は変えない）。
  function refreshText() {
    if (!track) return;
    updateProgressUI(currentPos());
    updateMediaMetadata();
  }

  return {
    configure,
    playRange, prev, next, toggle, pause, resume, stop, refreshText,
    getWordCount: () => words.length,
    isActive: () => !!track,
    isPlaying: () => isPlaying,
    // 検証用
    _extractMono: extractMono,
  };
})();
