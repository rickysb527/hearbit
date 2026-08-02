/* ブラウザ内 無音検知・分割ロジック（Web Audio API）。
 *
 * Python版（src/build_metadata.py）の ffmpeg silencedetect を移植:
 *   noise = -30dB, min_silence = 0.4s, word_gap = 2.0s
 *   分割点 = 単語境界となる無音区間の中点。
 *
 * ffmpeg の silencedetect は「短い窓の RMS レベルが noise 閾値を下回る区間が
 * min_silence 以上続いたら無音」と判定する。ここでは 20ms 窓の RMS(dBFS) を計算し、
 * -30dBFS を下回る連続区間を無音とみなして同等に再現する。
 */
const Splitter = (() => {
  const NOISE_DB = -30;      // dBFS 閾値
  const MIN_SILENCE = 0.4;   // これ以上続けば無音とみなす（秒）
  const WORD_GAP = 2.0;      // これ以上の無音を単語境界とみなす（秒）
  const WIN_MS = 10;         // RMS 計算窓（ミリ秒）。Python版(ffmpeg silencedetect)との一致率が最良
  const DB_FLOOR = -90;      // 完全無音の下限

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

  /* 1ページを解析してセグメント配列を返す（segments.json の1ページ分と同形式） */
  async function analyzePage(arrayBuffer, pageId) {
    const { samples, sampleRate, duration } = await decode(arrayBuffer);
    const cuts = detectCuts(samples, sampleRate);
    const bounds = [0.0, ...cuts, Math.round(duration * 1000) / 1000];
    const segLengths = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      segLengths.push(Math.round((bounds[i + 1] - bounds[i]) * 100) / 100);
    }

    // アナウンス自動判定（汎用ヒューリスティック：先頭が本体中央値+1.0秒以上なら結合）
    const types = segLengths.map(() => 'word');
    if (segLengths.length >= 2) {
      const bodyMedian = median(segLengths.slice(1));
      if (segLengths[0] - bodyMedian >= 1.0) types[0] = 'word+announce';
    }

    const segments = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      segments.push({
        index: i,
        start: Math.round(bounds[i] * 1000) / 1000,
        end: Math.round(bounds[i + 1] * 1000) / 1000,
        length: segLengths[i],
        type: types[i],
      });
    }

    const body = segLengths.length > 1 ? segLengths.slice(1) : segLengths;
    const layout = median(body) < 9 ? 'word_only' : 'word_with_examples';
    const wordCount = types.filter(t => t === 'word' || t === 'word+announce').length;

    return {
      page: pageId,
      duration: Math.round(duration * 100) / 100,
      num_segments: segments.length,
      layout,
      word_count: wordCount,
      has_announce: types[0] === 'word+announce',
      segments,
    };
  }

  return { decode, detectSilences, detectCuts, analyzePage, NOISE_DB, MIN_SILENCE, WORD_GAP };
})();
