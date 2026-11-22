/* 機能B（聞き流し / Listen）: 単語部分だけを 50語/100語で連結し、
 * 1本の音声として連続再生する散歩用プレーヤー。
 *
 * ============================================================================
 * なぜ「連結して1本」なのか（CLAUDE.md / DESIGN.md の設計ポイント）
 * ----------------------------------------------------------------------------
 * iOS はロック中にバックグラウンドの JS 実行を絞る。機能A(player.js)のように
 * audio.onended → 次を再生 という「都度JSで繋ぐ」方式は、ロック中に止まりうる。
 * 機能Bは散歩用途（画面オフ・ロック中）が主眼なので、
 *   各単語の「単語+訳」区間の PCM を切り出して 1本に連結し、WAV にして <audio> 要素で再生する。
 * 1本なので、いったん play すればロック中も OS 側でそのまま流れ続ける。
 *
 * なぜ Web Audio(AudioBufferSourceNode) ではなく <audio> で鳴らすのか:
 *   iOS では Web Audio の AudioContext が suspended / interrupted になったり、running のまま
 *   時計が止まったりして「⏸表示なのに無音」になり、ホーム画面に戻る/画面を消すと止まることもあった。
 *   <audio> 要素は機能A(player.js)と同じ「メディア再生」扱いで、バックグラウンド・ロック中も流れ、
 *   消音スイッチの影響も受けない。AudioContext は decode（PCM 取得）にだけ使う。
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

  // --- decode 用 AudioContext（再生には使わない。suspended のままでも decode はできる）---
  let ctx = null;
  function audioCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    return ctx;
  }

  // --- 再生用 <audio> 要素（機能A の #audio-el とは別。排他は Player.stop / Listen.stop で取る）---
  let audioEl = null;
  function el() {
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.preload = 'auto';
      // OS 側の操作（着信での中断・イヤホン操作など）も含め、要素の状態に UI を合わせる。
      audioEl.addEventListener('play', onElPlay);
      audioEl.addEventListener('pause', onElPause);
      audioEl.addEventListener('ended', onElEnded);
    }
    return audioEl;
  }
  // いまの要素が現在トラックを鳴らしているか（アンロック用の無音や前トラックのイベントを無視するため）
  function isTrackSrc() { return !!(track && audioEl && audioEl.src === track.url); }

  /* iOS は play() をユーザー操作の中でしか許さない。トラック構築は数秒かかり操作の外になるので、
   * タップ直後（同期）に短い無音を play して要素を「操作で再生した」状態にしておく。
   * 以後、同じ要素の play() は操作外でも通る。 */
  let silentUrl = null;
  function unlock() {
    try {
      if (!silentUrl) {
        const { wav } = ListenBuild.encodeWav(new Float32Array(2205), 22050); // 0.1 秒の無音
        silentUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      }
      const a = el();
      a.src = silentUrl;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  // --- 状態 ---
  let bookName = '';
  let words = [];             // ListenBuild.collectWords の結果（全単語・順序どおり）
  let getBlobFor = null;      // async (page) => Blob
  let textFor = null;         // (page, segIndex) => { hanzi, pinyin, gloss, low_confidence } | null
  let onBoundary = null;      // (wordIdxInTrack) => void  UI更新コールバック

  // 現在ロード中のトラック（連結1本）の情報
  let track = null;           // { url(WAV blob URL), duration, boundaries[], wordCount, indices, ... }
  let isPlaying = false;
  let playToken = 0;

  // 停止中の再生位置（秒）。再生中は audioEl.currentTime が正。
  let offsetInBuffer = 0;
  let rafId = null;
  let currentWordInTrack = -1;

  // 無音検知結果のキャッシュ（ページ単位）: 同じページを何度も decode しないため
  const pageCache = new Map(); // page -> { audioBuffer }

  // ================= トラック構築 =================
  /* 単語の global index 配列（words[] への参照。順序どおり）を切り出して
   * 1本に連結し WAV（<audio> 用の blob URL）にする。境界(各単語の先頭秒)配列も返す。
   *
   * 範囲再生（50/100語）もスター単語再生も、この共通ルートで作る。範囲は
   * [rangeFrom, rangeTo) の連番 index、スターは starred の global index 配列（飛び番あり）。
   * meta には表示用の情報（mode/label/size など）を持たせる。
   */
  async function buildTrackFromIndices(indices, meta, onProgress) {
    const myToken = ++buildToken;
    const sr = audioCtx().sampleRate;
    const gapSamples = Math.round(GAP_SEC * sr);

    // 1) 必要ページを decode（キャッシュ利用）し、各単語の [start,end] サンプル区間を集める。
    //    wordonly 範囲（単語+訳の先頭2ブロック）は、そのページの無音区間から遅延確定する
    //    （元音声139MBを一度に decode しないため、必要ページだけ処理）。
    const clips = [];
    for (let i = 0; i < indices.length; i++) {
      if (myToken !== buildToken) return null; // 途中でキャンセル
      const w = words[indices[i]];
      const { audioBuffer, silences } = await getDecoded(w.page);
      if (myToken !== buildToken) return null;
      const [s, e] = ListenBuild.wordonlyRange(w.seg, silences);
      const data = extractMono(audioBuffer, s, e);
      clips.push(data);
      if (onProgress) onProgress(i + 1, indices.length);
      // decode/切り出しは重いので UI に制御を返す
      await new Promise((r) => setTimeout(r, 0));
    }

    // 2) 連結長を計算（クリップ + 単語間ギャップ）
    let totalLen = 0;
    for (let i = 0; i < clips.length; i++) {
      if (i > 0) totalLen += gapSamples;
      totalLen += clips[i].length;
    }
    const outData = new Float32Array(Math.max(1, totalLen));

    // 3) 連結しつつ、各単語の先頭秒（境界）を記録
    const boundaries = [];
    let pos = 0;
    for (let i = 0; i < clips.length; i++) {
      if (i > 0) pos += gapSamples; // ギャップ（無音なので書き込み不要, out は0埋め）
      boundaries.push(pos / sr);
      outData.set(clips[i], pos);
      pos += clips[i].length;
    }

    // 4) WAV にして <audio> 用の URL に（PCM はここで手放す）
    const { wav } = ListenBuild.encodeWav(outData, sr);
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));

    return Object.assign({
      url,
      boundaries,
      wordCount: clips.length,
      indices: indices.slice(), // トラック内語順(0-based) → words[] の global index
      duration: outData.length / sr,
    }, meta);
  }

  /* 指定範囲(rangeFrom..rangeTo, 0-based 半開区間) の単語を切り出して連結する。
   * 連番 index を作って buildTrackFromIndices に委譲。
   */
  async function buildTrack(rangeFrom, rangeTo, size, onProgress) {
    const indices = [];
    for (let i = rangeFrom; i < rangeTo; i++) indices.push(i);
    return buildTrackFromIndices(indices, { mode: 'range', rangeFrom, rangeTo, size }, onProgress);
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
  function stopWatch() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }
  function revokeTrack(t) { if (t && t.url) { try { URL.revokeObjectURL(t.url); } catch (e) {} } }

  /* offsetSec から再生する。要素に現在トラックが載っていなければ載せて metadata を待つ。
   * ▶ タップ（ユーザー操作）から呼ばれた時は、載っていれば await を挟まず同期で play() する。 */
  async function playFrom(offsetSec) {
    if (!track) return;
    const myToken = ++playToken;
    const a = el();
    offsetInBuffer = Math.min(Math.max(offsetSec, 0), track.duration);
    if (!isTrackSrc()) {
      a.src = track.url;
      a.load();
      await new Promise((resolve) => {
        if (a.readyState >= 1) { resolve(); return; }
        const done = () => { a.removeEventListener('loadedmetadata', done); a.removeEventListener('error', done); resolve(); };
        a.addEventListener('loadedmetadata', done);
        a.addEventListener('error', done);
      });
      if (myToken !== playToken || !track) return; // 待機中に stop/pause/別の playFrom が入った
    }
    try { a.currentTime = offsetInBuffer; } catch (e) {}
    try {
      await a.play();
    } catch (e) {
      if (myToken !== playToken) return;
      // NotAllowedError 等: 自動では鳴らせない → 一時停止表示にして ▶ タップ（ユーザー操作）を促す
      console.warn('[Listen] play() failed', e);
      isPlaying = false;
      setPlayingUI(false);
      updateProgressUI(offsetInBuffer);
      ui.onNotice('blocked');
    }
  }

  // <audio> のイベント → 状態/UI。自分の play/pause だけでなく OS 側の中断・再開もここで拾う。
  function onElPlay() {
    if (!isTrackSrc()) return;
    isPlaying = true;
    setPlayingUI(true);
    startWatch();
    updateMediaMetadata();
  }
  function onElPause() {
    if (!isTrackSrc() || audioEl.ended) return; // 末尾は ended で処理
    offsetInBuffer = audioEl.currentTime;
    isPlaying = false;
    stopWatch();
    setPlayingUI(false);
    updateProgressUI(offsetInBuffer);
    updateMediaMetadata();
  }
  function onElEnded() {
    if (!isTrackSrc()) return;
    onTrackEnded();
  }

  function currentPos() {
    if (!track) return 0;
    if (!isPlaying || !isTrackSrc()) return offsetInBuffer;
    return Math.min(audioEl.currentTime, track.duration);
  }

  // 連結トラック内の語順(0-based) → 元の words[] の要素（page/seg を持つ）。
  // track.indices が語順→global index の対応表（範囲/スターとも共通）。
  function trackWord(wiInTrack) {
    if (!track || wiInTrack < 0 || !track.indices) return null;
    const globalIdx = track.indices[wiInTrack];
    return words[globalIdx] != null ? words[globalIdx] : null;
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
    stopWatch();
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
  // トラック構築 → 状態確定 → 再生開始 の共通処理（範囲/スターで共有）。
  async function startTrack(buildFn, { autoplay = true } = {}) {
    // 排他制御: 機能A(Player)と同時に鳴らさない。聞き流し開始時は必ず機能Aを停止する。
    if (typeof Player !== 'undefined' && Player.stop) Player.stop();
    // 前のトラックは準備中に鳴らし続けない（進捗表示が新トラックの見出しと混ざるのも防ぐ）。
    playToken++;
    stopWatch();
    isPlaying = false;
    const prevTrack = track;
    track = null; // 準備中の ▶（全画面/ミニ/ロック画面）で前のトラックを鳴らし直さない
    // タップ直後（ユーザー操作の中）に要素をアンロック。前トラックの再生もこれで止まる。
    unlock();
    revokeTrack(prevTrack);
    onLoadingUI(true);
    let built;
    try {
      built = await buildFn((done, all) => onLoadingUI(true, done, all));
    } catch (e) {
      console.warn('[Listen] buildTrack failed', e);
      onLoadingUI(false);
      // 無言で止まると原因が分からないので UI に知らせる（再発時の切り分け用にエラー名も渡す）。
      ui.onNotice('build-failed', e);
      return;
    }
    if (!built) { onLoadingUI(false); return; } // キャンセル（構築済みなら URL は作られていない）
    track = built;
    currentWordInTrack = -1;
    offsetInBuffer = 0;
    onLoadingUI(false);
    setupMediaSession();
    updateHeaderUI();
    if (autoplay) await playFrom(0);
    else { updateProgressUI(0); currentWordInTrack = 0; if (onBoundary) onBoundary(0); updateMediaMetadata(); }
  }

  /* トラックを構築して再生開始。rangeFrom/To は 0-based 半開。 */
  async function playRange(rangeFrom, rangeTo, size, opts = {}) {
    return startTrack((prog) => buildTrack(rangeFrom, rangeTo, size, prog), opts);
  }

  /* スター単語だけを連結1本で再生（チャンク分けなし）。
   * indices は words[] の global index 配列（順序どおり・飛び番あり）。
   */
  async function playStarred(indices, opts = {}) {
    const list = (indices || []).slice();
    if (list.length === 0) return; // 0件は呼び出し側でガードするが二重に防ぐ
    return startTrack(
      (prog) => buildTrackFromIndices(list, { mode: 'starred', wordTotal: list.length }, prog),
      opts,
    );
  }

  function pause() {
    if (!track) return;
    playToken++; // metadata 待ち中の playFrom を無効化
    if (isTrackSrc()) offsetInBuffer = audioEl.currentTime;
    if (audioEl) audioEl.pause(); // 'pause' イベントで UI も揃う
    isPlaying = false;
    stopWatch();
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
    stopWatch();
    isPlaying = false;
    offsetInBuffer = 0;
    currentWordInTrack = -1;
    // track は保持しない（メモリ解放）。UI も閉じる。
    const prevTrack = track;
    track = null;
    if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); try { audioEl.load(); } catch (e) {} }
    revokeTrack(prevTrack);
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
    // 番号は通し番号（No.51）＋トラック内の位置（1/50）。
    const w = trackWord(currentWordInTrack >= 0 ? currentWordInTrack : 0);
    const pos = w ? `No.${w.serial} (${n}/${track.wordCount})` : `${n}/${track.wordCount}`;
    let title = `聞き流し ${pos}`;
    if (t && (t.hanzi || t.pinyin)) {
      title = [t.hanzi, t.pinyin].filter(Boolean).join('  ') + `  ${pos}`;
    }
    const album = track.mode === 'starred'
      ? `★ スター単語 · ${track.wordCount}語`
      : `${track.size}語 · ${track.rangeFrom + 1}–${track.rangeTo}`;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: bookName || 'Hearbit',
        album,
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
    onNotice: () => {},     // (kind: 'blocked' | 'build-failed', error?)
  };
  function setPlayingUI(p) { ui.onPlaying(p); if (navigator.mediaSession) { try { navigator.mediaSession.playbackState = p ? 'playing' : 'paused'; } catch (e) {} } }
  function updateProgressUI(pos) {
    if (!track) return;
    const ratio = track.duration > 0 ? Math.min(pos / track.duration, 1) : 0;
    const wi = wordIndexAt(pos);
    // 第4引数: 現在語のテキスト（漢字・ピンイン・訳）。無ければ null（番号フォールバック）。
    // 第5引数: 単語帳全体での通し番号（51–100 の1語目なら 51）。
    const w = trackWord(wi);
    ui.onProgress(ratio, wi + 1, track.wordCount, textForTrackWord(wi), w ? w.serial : null);
  }
  function onLoadingUI(loading, done, all) { ui.onLoading(loading, done, all); }
  function updateHeaderUI() {
    if (!track) return;
    if (track.mode === 'starred') {
      ui.onHeader({ mode: 'starred', wordCount: track.wordCount });
    } else {
      ui.onHeader({ mode: 'range', size: track.size, from: track.rangeFrom + 1, to: track.rangeTo, wordCount: track.wordCount });
    }
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

  /* あるページ・セグメントの「単語+訳」範囲 [startSec, endSec] を返す（機能Bと同一ロジック）。
   * タイピング（typing.js）の音声モードから流用する共通口。ページを decode + 無音解析して
   * wordonlyRange を確定する。結果は getDecoded の pageCache に載る（機能Bと共有・セッション内キャッシュ）。
   * Listen は現在の単語帳で configure 済み（getBlobFor が現行 book）なので、typing も同じ book で使う。
   * decode/解析に失敗したら null を返す → 呼び出し側は effStart〜end にフォールバックする。 */
  async function resolveWordonly(page, seg) {
    if (!getBlobFor) return null;
    try {
      const { silences } = await getDecoded(page);
      return ListenBuild.wordonlyRange(seg, silences); // [s, e] 秒
    } catch (e) {
      return null;
    }
  }

  // 現在トラックで鳴っている語の { page, segIndex } を返す（スター操作用）。無ければ null。
  function currentWord() {
    const w = trackWord(currentWordInTrack >= 0 ? currentWordInTrack : 0);
    if (!w) return null;
    return { page: w.page, segIndex: w.seg.index };
  }

  return {
    configure,
    playRange, playStarred, prev, next, toggle, pause, resume, stop, refreshText,
    currentWord, resolveWordonly,
    getWordCount: () => words.length,
    isActive: () => !!track,
    isPlaying: () => isPlaying,
    // 検証用
    _extractMono: extractMono,
    _audioEl: () => audioEl,
  };
})();
