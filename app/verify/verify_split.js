#!/usr/bin/env node
/* JS移植の検証:
 * splitter.js の無音検知アルゴリズムと同一ロジックを Node で走らせ、
 * Python版 data/segments.json と分割結果（cut点・セグメント数）を突き合わせる。
 *
 * Web Audio API は Node に無いので、ffmpeg で mp3 → モノラルf32 raw PCM に変換し
 * 同じ RMS(10ms窓=WIN_MS, -30dBFS, 0.4s無音, 2.0s単語境界) を適用する。
 *
 * 使い方:
 *   node app/verify/verify_split.js            # 代表10ページ
 *   node app/verify/verify_split.js all        # 全98ページ
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const ROOT = path.resolve(__dirname, '../..');
const RAW = path.join(ROOT, 'audio/raw');
const SEG = path.join(ROOT, 'data/segments.json');

const NOISE_DB = -30, MIN_SILENCE = 0.4, WORD_GAP = 2.0, WIN_MS = 10, SR = 44100;

function decodeToFloat32(mp3Path) {
  // f32le モノラル 44100Hz raw
  const buf = execFileSync(FFMPEG, [
    '-v', 'quiet', '-i', mp3Path,
    '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-',
  ], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

function detectCuts(samples, sampleRate) {
  const win = Math.round(sampleRate * WIN_MS / 1000);
  const nWin = Math.floor(samples.length / win);
  const silences = [];
  let inSil = false, silStart = 0;
  for (let w = 0; w < nWin; w++) {
    let sum = 0; const base = w * win;
    for (let i = 0; i < win; i++) { const s = samples[base + i]; sum += s * s; }
    const rms = Math.sqrt(sum / win);
    const db = rms > 0 ? 20 * Math.log10(rms) : -90;
    const t = base / sampleRate;
    if (db < NOISE_DB) { if (!inSil) { inSil = true; silStart = t; } }
    else { if (inSil) { const dur = t - silStart; if (dur >= MIN_SILENCE) silences.push({ start: silStart, end: t, dur }); inSil = false; } }
  }
  if (inSil) { const end = samples.length / sampleRate; const dur = end - silStart; if (dur >= MIN_SILENCE) silences.push({ start: silStart, end, dur }); }
  return silences.filter(s => s.dur >= WORD_GAP).map(s => Math.round((s.start + s.end) / 2 * 1000) / 1000);
}

function main() {
  const seg = JSON.parse(fs.readFileSync(SEG, 'utf8'));
  const arg = process.argv[2];
  let pages = seg.pages;
  if (arg !== 'all') {
    // 代表: アナウンス有/無、word_only含む
    const pick = ['001', '002', '021', '040', '086', '051', '076', '010', '050', '098'];
    pages = seg.pages.filter(p => pick.includes(p.page));
  }

  let okCuts = 0, okSegs = 0, total = 0;
  const rows = [];
  for (const p of pages) {
    const mp3 = path.join(RAW, p.page + '.mp3');
    if (!fs.existsSync(mp3)) continue;
    total++;
    const samples = decodeToFloat32(mp3);
    const jsCuts = detectCuts(samples, SR);
    const pyCuts = p.segments.slice(1).map(s => s.start); // 各セグメント開始=cut点
    const segMatch = (jsCuts.length + 1) === p.num_segments;
    // cut点が ±0.15秒以内で一致するか
    let cutMatch = jsCuts.length === pyCuts.length;
    let maxDiff = 0;
    if (cutMatch) {
      for (let i = 0; i < jsCuts.length; i++) {
        const d = Math.abs(jsCuts[i] - pyCuts[i]);
        maxDiff = Math.max(maxDiff, d);
        if (d > 0.15) cutMatch = false;
      }
    }
    if (segMatch) okSegs++;
    if (cutMatch) okCuts++;
    rows.push(`${p.page}: JS ${jsCuts.length + 1}seg / PY ${p.num_segments}seg  ${segMatch ? '✓seg' : '✗seg'} ${cutMatch ? '✓cut' : '✗cut(Δmax=' + maxDiff.toFixed(3) + ')'}`);
  }
  console.log(rows.join('\n'));
  console.log(`\nセグメント数一致: ${okSegs}/${total}`);
  console.log(`cut点一致(±0.15s): ${okCuts}/${total}`);
}

main();
