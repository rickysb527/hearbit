/* ブラウザ内 無音検知・分割ロジック（Web Audio API）。
 *
 * Python版（src/build_metadata.py）の ffmpeg silencedetect を移植:
 *   noise = -30dB, min_silence = 0.4s, word_gap = 2.0s
 *   分割点 = 単語境界となる無音区間の中点。
 *
 * ffmpeg の silencedetect は「短い窓の RMS レベルが noise 閾値を下回る区間が
 * min_silence 以上続いたら無音」と判定する。ここでは 10ms 窓の RMS(dBFS) を計算し、
 * -30dBFS を下回る連続区間を無音とみなして同等に再現する（窓幅は WIN_MS）。
 */
const Splitter = (() => {
  /* 分割ロジックのバージョン。
   * splitter.js / listen-build.js の「分割・抽出ロジック」を変更したら、この値を上げる。
   *
   * 【運用ルール（重要）】
   *   保存する単語帳には、生成時の SPLIT_VERSION を meta.splitVersion として付与する。
   *   単語帳オープン時に meta.splitVersion !== SPLIT_VERSION なら、元音声Blobから
   *   自動で再分割してキャッシュ（book.pages[].segments 等）を更新する。
   *   これにより「ロジックを直したら、ユーザーの再投入なしに次回オープンで反映」される。
   *
   *   → 具体的には、無音閾値・単語境界・短小結合・アナウンス切り離し（analyzeFromSamples）、
   *     もしくは listen-build.js の wordonly 抽出（wordonlyRange 等）を変更したら +1 する。
   *
   * 履歴:
   *   1: 初期リリース（無音検知移植 / 短小結合 / アナウンス切り離し / wordonly抽出）。
   *      ※訳スキップ（announce_end による単語本体開始・wordonly の冒頭余白スキップ）を含む
   *        現行ロジック一式をバージョン1と定義。以降の変更でインクリメントする。
   */
  const SPLIT_VERSION = 1;

  const NOISE_DB = -30;      // dBFS 閾値
  const MIN_SILENCE = 0.4;   // これ以上続けば無音とみなす（秒）
  const WORD_GAP = 2.0;      // これ以上の無音を単語境界とみなす（秒）
  const WIN_MS = 10;         // RMS 計算窓（ミリ秒）。Python版(ffmpeg silencedetect)との一致率が最良
  const DB_FLOOR = -90;      // 完全無音の下限

  // アナウンス自動判定（汎用ヒューリスティック）: 先頭が本体中央値+この秒以上ならアナウンス結合
  const EXCESS_THRESHOLD = 1.0;
  // 【修正②】短小セグメント結合: 本体中央値の45%未満のセグメントを直前に結合（例文分離の修正）
  const SHORT_MERGE_RATIO = 0.45;
  // 【修正①】アナウンス長がこれ未満なら low_confidence フラグ（実聴確認用）
  const ANNOUNCE_LOW_CONF = 0.5;

  let sharedCtx = null;
  function audioCtx() {
    if (!sharedCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      sharedCtx = new AC();
    }
    return sharedCtx;
  }

  /* ArrayBuffer(mp3) → モノラル Float32 サンプル + sampleRate + duration */
  async function decode(arrayBuffer) {
    const ctx = audioCtx();
    // decodeAudioData は一部Safariで callback形式なので Promise化
    const buf = await new Promise((resolve, reject) => {
      ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
    });
    const ch = buf.numberOfChannels;
    const len = buf.length;
    const out = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) out[i] += data[i];
    }
    if (ch > 1) for (let i = 0; i < len; i++) out[i] /= ch;
    return { samples: out, sampleRate: buf.sampleRate, duration: buf.duration };
  }

  /* 無音区間 [{start,end,dur}] を検出（ffmpeg silencedetect 相当） */
  function detectSilences(samples, sampleRate) {
    const win = Math.max(1, Math.round(sampleRate * WIN_MS / 1000));
    const nWin = Math.floor(samples.length / win);
    const silences = [];
    let inSilence = false;
    let silStart = 0;

    for (let w = 0; w < nWin; w++) {
      let sum = 0;
      const base = w * win;
      for (let i = 0; i < win; i++) {
        const s = samples[base + i];
        sum += s * s;
      }
      const rms = Math.sqrt(sum / win);
      let db = rms > 0 ? 20 * Math.log10(rms) : DB_FLOOR;
      const t = (base) / sampleRate;
      if (db < NOISE_DB) {
        if (!inSilence) { inSilence = true; silStart = t; }
      } else {
        if (inSilence) {
          const end = t;
          const dur = end - silStart;
          if (dur >= MIN_SILENCE) silences.push({ start: silStart, end, dur });
          inSilence = false;
        }
      }
    }
    // 末尾が無音のまま終わる場合
    if (inSilence) {
      const end = samples.length / sampleRate;
      const dur = end - silStart;
      if (dur >= MIN_SILENCE) silences.push({ start: silStart, end, dur });
    }
    return silences;
  }

  /* 単語境界（WORD_GAP以上の無音の中点）を返す */
  function detectCuts(samples, sampleRate) {
    const silences = detectSilences(samples, sampleRate);
    const cuts = [];
    for (const s of silences) {
      if (s.dur >= WORD_GAP) {
        cuts.push(Math.round(((s.start + s.end) / 2) * 1000) / 1000);
      }
    }
    return cuts;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  const round2 = (x) => Math.round(x * 100) / 100;
  const round3 = (x) => Math.round(x * 1000) / 1000;

  /* 【修正②】本体(index1以降)の極端に短いセグメント（例文分離）を直前に結合する。
   * Python版 merge_short_segments と同一ロジック。
   * 戻り値: { bounds, segLengths, mergedFlags }
   *   mergedFlags[i] = そのセグメントが結合を受けた(直後の短小を吸収した)なら true。
   */
  function mergeShortSegments(bounds, segLengths) {
    const n = segLengths.length;
    if (n < 3) return { bounds, segLengths, mergedFlags: new Array(n).fill(false) };
    const body = segLengths.slice(1);
    const med = median(body);
    const drop = new Set();
    for (let i = 1; i < n; i++) {
      if (segLengths[i] < med * SHORT_MERGE_RATIO) drop.add(i);
    }
    if (drop.size === 0) return { bounds, segLengths, mergedFlags: new Array(n).fill(false) };
    // bounds[i]（=セグメントiの開始）を消すとセグメントi-1とiが結合する
    const newBounds = [bounds[0]];
    for (let i = 1; i < bounds.length; i++) {
      if (drop.has(i)) continue; // このセグメント境界を消す = 直前セグメントに吸収
      newBounds.push(bounds[i]);
    }
    const newLengths = [];
    for (let j = 0; j < newBounds.length - 1; j++) {
      newLengths.push(round2(newBounds[j + 1] - newBounds[j]));
    }
    const mergedFlags = new Array(newLengths.length).fill(false);
    const dropSorted = [...drop].sort((a, b) => a - b);
    for (const di of dropSorted) {
      // di の直前セグメント = 元index di-1。結合後もそのセグメントは残っている。
      // 新indexは「di-1 以下で drop された数」を引く
      let shift = 0;
      for (const x of drop) if (x <= di - 1) shift++;
      const ni = (di - 1) - shift;
      if (ni >= 0 && ni < mergedFlags.length) mergedFlags[ni] = true;
    }
    return { bounds: newBounds, segLengths: newLengths, mergedFlags };
  }

  /* 【修正①】案①(a)中央値基準で先頭セグメント内のアナウンス/単語1境界を求める。
   * 末尾から bodyMedian ぶん遡った目安時刻を、最も近い内部無音境界(中点)にスナップ。
   * 目安が seg0 の始端より前なら先頭寄りの最初の境界。境界候補が無ければ null。
   * silences: detectSilences の全無音区間 [{start,end,dur}]
   */
  function computeAnnounceEnd(seg0Start, seg0End, bodyMedian, silences) {
    const inner = silences
      .map((s) => round3((s.start + s.end) / 2))
      .filter((mid) => seg0Start < mid && mid < seg0End)
      .sort((a, b) => a - b);
    if (inner.length === 0) return null;
    const target = seg0End - bodyMedian;
    if (target <= seg0Start) return inner[0];
    let best = inner[0];
    let bestD = Math.abs(inner[0] - target);
    for (const b of inner) {
      const d = Math.abs(b - target);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /* 1ページを解析してセグメント配列を返す（segments.json の1ページ分と同形式） */
  async function analyzePage(arrayBuffer, pageId) {
    const { samples, sampleRate, duration } = await decode(arrayBuffer);
    return analyzeFromSamples(samples, sampleRate, duration, pageId);
  }

  /* サンプル配列から1ページ分のメタデータを組み立てる（Node検証と共有できるよう分離）。
   * Python版 build_metadata.py の main ループと同一手順：
   *   分割 → ②短小結合 → 結合後の本体中央値でラベル → ①アナウンス切り離し
   */
  function analyzeFromSamples(samples, sampleRate, duration, pageId) {
    const silences = detectSilences(samples, sampleRate);
    const cuts = silences
      .filter((s) => s.dur >= WORD_GAP)
      .map((s) => round3((s.start + s.end) / 2));
    let bounds = [0.0, ...cuts, round3(duration)];
    let segLengths = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      segLengths.push(round2(bounds[i + 1] - bounds[i]));
    }

    // 【修正②】短小セグメント結合（例文分離の修正）を先に適用
    const merged = mergeShortSegments(bounds, segLengths);
    bounds = merged.bounds;
    segLengths = merged.segLengths;
    const mergedFlags = merged.mergedFlags;

    // 結合を反映した後の本体中央値でラベル・アナウンス切り離しを行う
    const body = segLengths.length > 1 ? segLengths.slice(1) : segLengths;
    const med = median(body);

    // アナウンス自動判定（汎用ヒューリスティック：先頭が本体中央値+EXCESS_THRESHOLD以上なら結合）
    const types = segLengths.map(() => 'word');
    if (segLengths.length >= 2) {
      if (segLengths[0] - med >= EXCESS_THRESHOLD) types[0] = 'word+announce';
    }

    // 【修正①】アナウンス切り離し: 先頭が word+announce のとき announce_end を算出
    let announceEnd = null;
    let announceLowConf = false;
    if (types[0] === 'word+announce') {
      announceEnd = computeAnnounceEnd(bounds[0], bounds[1], med, silences);
      if (announceEnd !== null && (announceEnd - bounds[0]) < ANNOUNCE_LOW_CONF) {
        announceLowConf = true;
      }
    }

    const segments = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const seg = {
        index: i,
        start: round3(bounds[i]),
        end: round3(bounds[i + 1]),
        length: segLengths[i],
        type: types[i],
      };
      if (mergedFlags[i]) seg.merged = true; // 例文分離を結合して単語に戻したセグメント
      if (i === 0 && announceEnd !== null) {
        seg.announce_end = round3(announceEnd);
        if (announceLowConf) seg.announce_low_confidence = true;
      }
      segments.push(seg);
    }

    const layout = med < 9 ? 'word_only' : 'word_with_examples';
    const wordCount = types.filter((t) => t === 'word' || t === 'word+announce').length;

    return {
      page: pageId,
      duration: round2(duration),
      num_segments: segments.length,
      layout,
      word_count: wordCount,
      has_announce: types[0] === 'word+announce',
      segments,
    };
  }

  return {
    decode, detectSilences, detectCuts, analyzePage, analyzeFromSamples,
    mergeShortSegments, computeAnnounceEnd, median,
    SPLIT_VERSION,
    NOISE_DB, MIN_SILENCE, WORD_GAP, SHORT_MERGE_RATIO, EXCESS_THRESHOLD, ANNOUNCE_LOW_CONF,
  };
})();

// Node（検証スクリプト）から同一ロジックを再利用するためのエクスポート。
// ブラウザでは module が未定義なので影響しない。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Splitter;
}
