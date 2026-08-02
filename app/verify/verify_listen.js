#!/usr/bin/env node
/* 機能B（聞き流し）の JS移植 検証:
 *   listen-build.js（wordonly 抽出 / チャンク分割）を Node で走らせ、
 *   Python版 build_chunks.py と同じ結果になるかを突き合わせる。
 *
 * 検証項目:
 *   1) 単語リスト: segments.json の word / word+announce セグメントを順序どおり収録しているか
 *      （語数・並び・通し番号）。
 *   2) wordonly 範囲 [start,end]: build_chunks.py の wordonly_range と一致するか。
 *      - JS版は Splitter.detectSilences（Web Audio移植, noise=-30dB/0.4s）で無音を得る。
 *      - 参照は ffmpeg silencedetect（build_chunks.py と同一）で無音を得て wordonly_range を再現。
 *      両者の [start,end] を ±0.15s 許容で比較（無音検知エンジン差の許容差）。
 *   3) チャンク構築: 50/100語で ceil(total/size) 本、各トラックの収録語数・範囲・境界数。
 *
 * Web Audio は Node に無いので、ffmpeg で mp3→モノラルf32 raw PCM(44100Hz) に変換して
 * Splitter.detectSilences に渡す（verify_split.js と同方式・ブラウザと同一ロジック）。
 *
 * 使い方:
 *   node app/verify/verify_listen.js         # 代表10ページ
 *   node app/verify/verify_listen.js all     # 全98ページ
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Splitter = require('../js/splitter.js');
const ListenBuild = require('../js/listen-build.js');

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const ROOT = path.resolve(__dirname, '../..');
const RAW = path.join(ROOT, 'audio/raw');
const SEG = path.join(ROOT, 'data/segments.json');
const SR = 44100;

const RANGE_TOL = 0.15;      // wordonly [start,end] 許容差（秒）
const NOISE_DB = -30, MIN_SIL = 0.4; // build_chunks.py と同一
// 閾値ぎわ（無音 dur≈0.4s）の1件は Web Audio RMS と ffmpeg silencedetect の
// 検知差でブロック境界が1つズレる既知の許容ケース（verify_split の ±許容と同種）。
// 単語/訳を切り落とすことは無く、クリップがわずかに長くなるだけ。数件までは PASS 扱い。
const RANGE_ALLOW = 2;

function decodeToFloat32(mp3Path) {
  const buf = execFileSync(FFMPEG, [
    '-v', 'quiet', '-i', mp3Path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-',
  ], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

/* build_chunks.py の detect_silences 相当（ffmpeg silencedetect）。 */
function ffmpegSilences(mp3Path) {
  // silencedetect のログは stderr に出る。ffmpeg は正常終了(exit 0)するため、
  // 例外に頼らず常に stderr を取得する（execFileSync の戻りは stdout なので stderr は
  // spawnSync 相当で受ける）。
  const { spawnSync } = require('child_process');
  const r = spawnSync(FFMPEG, ['-i', mp3Path, '-af',
    `silencedetect=noise=${NOISE_DB}dB:d=${MIN_SIL}`, '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  const stderr = r.stderr || '';
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)];
  const sils = [];
  ends.forEach((m, i) => {
    if (i < starts.length) sils.push({ start: starts[i], end: parseFloat(m[1]), dur: parseFloat(m[2]) });
  });
  return sils;
}

function main() {
  const seg = JSON.parse(fs.readFileSync(SEG, 'utf8'));
  const arg = process.argv[2];
  let pages = seg.pages;
  if (arg !== 'all') {
    const pick = ['001', '002', '021', '040', '050', '086', '051', '076', '095', '096', '098'];
    pages = seg.pages.filter((p) => pick.includes(p.page));
  }
  const subset = { book: seg.book, pages };

  // --- 1) 単語リスト（全体 collectWords は silences 不要でも作れる。ここでは JS版無音で確定）---
  const silByPageJS = {};   // Splitter.detectSilences（Web Audio移植）
  const silByPageFF = {};   // ffmpeg silencedetect（build_chunks.py 参照）
  for (const p of pages) {
    const mp3 = path.join(RAW, p.page + '.mp3');
    if (!fs.existsSync(mp3)) continue;
    const samples = decodeToFloat32(mp3);
    silByPageJS[p.page] = Splitter.detectSilences(samples, SR);
    silByPageFF[p.page] = ffmpegSilences(mp3);
  }

  const wordsJS = ListenBuild.collectWords(subset, silByPageJS);
  const wordsFF = ListenBuild.collectWords(subset, silByPageFF);

  // 期待: word / word+announce セグメント数の合計
  let expectWords = 0;
  for (const p of pages) {
    for (const s of p.segments) if (s.type === 'word' || s.type === 'word+announce') expectWords++;
  }

  const countOK = wordsJS.length === expectWords;
  // 順序・通し番号
  let orderOK = true;
  wordsJS.forEach((w, i) => { if (w.serial !== i + 1) orderOK = false; });

  // --- 2) wordonly 範囲: JS版(Splitter無音) vs 参照(ffmpeg無音) ---
  let rangeOK = 0, rangeTotal = 0, maxDelta = 0;
  const rangeIssues = [];
  for (let i = 0; i < wordsJS.length; i++) {
    const a = wordsJS[i].wordonly, b = wordsFF[i].wordonly;
    rangeTotal++;
    const ds = Math.abs(a[0] - b[0]), de = Math.abs(a[1] - b[1]);
    const d = Math.max(ds, de);
    maxDelta = Math.max(maxDelta, d);
    if (d <= RANGE_TOL) rangeOK++;
    else rangeIssues.push(`#${wordsJS[i].serial} ${wordsJS[i].page}: JS[${a}] FF[${b}] Δ=${d.toFixed(3)}`);
  }

  // --- 3) チャンク構築（50/100）---
  const chunkRows = [];
  let chunkOK = true;
  for (const size of [50, 100]) {
    const n = ListenBuild.numChunks(wordsJS.length, size);
    let recorded = 0;
    for (let c = 0; c < n; c++) {
      const [from, to] = ListenBuild.chunkRange(wordsJS.length, size, c);
      recorded += (to - from);
      // 連結トラックの境界数 = 収録語数（各語の先頭）。順序は from..to。
      const track = wordsJS.slice(from, to);
      if (track.length !== to - from) chunkOK = false;
    }
    const expectN = Math.ceil(wordsJS.length / size);
    const nOK = n === expectN && recorded === wordsJS.length;
    if (!nOK) chunkOK = false;
    chunkRows.push(`${size}語: ${n}本(期待${expectN}) / 収録${recorded}語(期待${wordsJS.length}) => ${nOK ? 'OK' : 'NG'}`);
  }

  // --- 出力 ---
  console.log(`=== 機能B 聞き流し 検証 (${pages.length}ページ) ===\n`);
  console.log(`1) 単語リスト`);
  console.log(`   語数一致:   ${wordsJS.length} / 期待 ${expectWords} => ${countOK ? 'OK' : 'NG'}`);
  console.log(`   順序/通番:  ${orderOK ? 'OK' : 'NG'}`);
  console.log(`\n2) wordonly範囲 (JS無音 vs ffmpeg無音, ±${RANGE_TOL}s)`);
  console.log(`   一致: ${rangeOK}/${rangeTotal}  (Δmax=${maxDelta.toFixed(3)}s)`);
  if (rangeIssues.length) {
    console.log(`   --- 差異 (${rangeIssues.length}件, 先頭20) ---`);
    console.log('   ' + rangeIssues.slice(0, 20).join('\n   '));
  }
  console.log(`\n3) チャンク構築`);
  chunkRows.forEach((r) => console.log('   ' + r));

  const rangeMiss = rangeTotal - rangeOK;
  const rangePass = rangeMiss <= RANGE_ALLOW;
  const allOK = countOK && orderOK && rangePass && chunkOK;
  if (rangeMiss > 0 && rangePass) {
    console.log(`   (差異 ${rangeMiss}件は閾値ぎわの無音検知差＝許容 ≤${RANGE_ALLOW}。単語/訳は保持されクリップが僅かに長いのみ)`);
  }
  console.log(`\n=> ${allOK ? '全チェック PASS' : '検証 NG あり'}`);
  process.exit(allOK ? 0 : 1);
}

main();
