#!/usr/bin/env node
/* JS移植の検証:
 * splitter.js の分割ロジック（analyzeFromSamples）を Node で走らせ、
 * Python版 data/segments.json と分割結果を突き合わせる。
 *
 * Web Audio API は Node に無いので、ffmpeg で mp3 → モノラルf32 raw PCM(44100Hz) に変換し、
 * そのサンプルを splitter.js の analyzeFromSamples に渡す（ブラウザと同一ロジック）。
 *
 * 検証項目:
 *   - セグメント数の一致
 *   - cut点（各セグメント開始）の一致（±0.15s）
 *   - 【修正②】merged フラグの一致（050/095/096/098）
 *   - 【修正①】announce_end の一致（±0.3s 目安）
 *   - has_announce の一致 …ただし「正解データ(announce_pages.json)を外した Python 汎用
 *     ヒューリスティック」を基準に比較する（下記の注意を参照）。
 *
 * has_announce の比較基準について（重要）:
 *   segments.json の has_announce は HSK3級の正解データ(announce_pages.json)を優先して
 *   確定されている。一方 JS版(splitter.js)はアプリに正解データを持たない汎用プレーヤー
 *   前提で、「先頭セグメントが本体中央値+EXCESS_THRESHOLD秒以上なら announce」という
 *   汎用ヒューリスティックのみで判定する。両者は設計上ズレて当然（HSK3級で約10ページ）。
 *   よってここでは segments.json ではなく、同じ汎用ルールを Python のセグメント長へ適用した
 *   期待値（expectedGenericAnnounce）と JS を比較する。これで「正解データが無い当然の差」を
 *   誤って FAIL にせず、移植（汎用ロジック）の正しさだけを検証できる。
 *   正解データとの最終的な突き合わせ・手動修正は Issue #4（手動修正UI）の範囲。
 *
 * 使い方:
 *   node app/verify/verify_split.js            # 代表10ページ
 *   node app/verify/verify_split.js all        # 全98ページ
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Splitter = require('../js/splitter.js');

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const ROOT = path.resolve(__dirname, '../..');
const RAW = path.join(ROOT, 'audio/raw');
const SEG = path.join(ROOT, 'data/segments.json');
const SR = 44100;

const CUT_TOL = 0.15;       // cut点許容差（秒）
const ANNOUNCE_TOL = 0.3;   // announce_end 許容差（秒）

// splitter.js と同一の汎用ヒューリスティック（正解データを使わない）で has_announce を再計算。
// segments.json は正解データ優先で確定しているため、比較基準にはこの汎用期待値を使う。
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function genericHasAnnounce(segLengths) {
  if (segLengths.length < 2) return false;
  const body = segLengths.slice(1);
  const med = median(body);
  return (segLengths[0] - med) >= Splitter.EXCESS_THRESHOLD;
}

function decodeToFloat32(mp3Path) {
  const buf = execFileSync(FFMPEG, [
    '-v', 'quiet', '-i', mp3Path,
    '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-',
  ], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

function probeDuration(mp3Path) {
  const out = execFileSync('/opt/homebrew/bin/ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', mp3Path,
  ]).toString().trim();
  return parseFloat(out);
}

function main() {
  const seg = JSON.parse(fs.readFileSync(SEG, 'utf8'));
  const arg = process.argv[2];
  let pages = seg.pages;
  if (arg !== 'all') {
    // 代表: アナウンス有/無、word_only、修正②の結合、修正①の低信頼を含む
    const pick = ['001', '002', '021', '040', '050', '086', '051', '076', '095', '096', '098'];
    pages = seg.pages.filter((p) => pick.includes(p.page));
  }

  let okSegs = 0, okCuts = 0, total = 0;
  let okAnnounceFlag = 0, annTotal = 0, okAnnounceEnd = 0, annEndTotal = 0;
  let okMerged = 0, mergedTotal = 0;
  const rows = [];
  const issues = [];

  for (const p of pages) {
    const mp3 = path.join(RAW, p.page + '.mp3');
    if (!fs.existsSync(mp3)) continue;
    total++;
    const samples = decodeToFloat32(mp3);
    const duration = probeDuration(mp3);
    const js = Splitter.analyzeFromSamples(samples, SR, duration, p.page);

    // --- セグメント数 ---
    const segMatch = js.num_segments === p.num_segments;
    if (segMatch) okSegs++;

    // --- cut点（各セグメント開始, index>=1）---
    const jsCuts = js.segments.slice(1).map((s) => s.start);
    const pyCuts = p.segments.slice(1).map((s) => s.start);
    let cutMatch = jsCuts.length === pyCuts.length;
    let maxDiff = 0;
    if (cutMatch) {
      for (let i = 0; i < jsCuts.length; i++) {
        const d = Math.abs(jsCuts[i] - pyCuts[i]);
        maxDiff = Math.max(maxDiff, d);
        if (d > CUT_TOL) cutMatch = false;
      }
    }
    if (cutMatch) okCuts++;

    // --- 修正②: merged フラグ ---
    const jsMerged = js.segments.filter((s) => s.merged).map((s) => s.index);
    const pyMerged = p.segments.filter((s) => s.merged).map((s) => s.index);
    const mergedMatch = JSON.stringify(jsMerged) === JSON.stringify(pyMerged);
    if (pyMerged.length || jsMerged.length) {
      mergedTotal++;
      if (mergedMatch) okMerged++;
      else issues.push(`${p.page}: merged mismatch JS[${jsMerged}] PY[${pyMerged}]`);
    }

    // --- has_announce フラグ ---
    // 基準は segments.json（正解データ優先）ではなく、同じ「汎用ヒューリスティック」を
    // Python版のセグメント長へ適用した期待値。splitter.js と同一ルールで再計算する:
    //   body = segLengths[1:], med = median(body),
    //   announce = (len>=2) && (segLengths[0] - med >= EXCESS_THRESHOLD)
    // これで正解データ由来の当然のズレ（約10ページ）を誤FAILにせず移植の正しさを検証する。
    const pyLens = p.segments.map((s) => s.length);
    const expectedGenericAnnounce = genericHasAnnounce(pyLens);
    annTotal++;
    const annFlagMatch = js.has_announce === expectedGenericAnnounce;
    if (annFlagMatch) okAnnounceFlag++;
    else issues.push(`${p.page}: has_announce(汎用) JS=${js.has_announce} 期待=${expectedGenericAnnounce}`);

    // --- 修正①: announce_end（両方がアナウンス有りのときのみ数値比較）---
    const jsAnn = js.segments[0].announce_end;
    const pyAnn = p.segments[0].announce_end;
    let annEndStr = '';
    if (pyAnn !== undefined || jsAnn !== undefined) {
      if (pyAnn !== undefined && jsAnn !== undefined) {
        annEndTotal++;
        const d = Math.abs(jsAnn - pyAnn);
        if (d <= ANNOUNCE_TOL) okAnnounceEnd++;
        else issues.push(`${p.page}: announce_end JS=${jsAnn} PY=${pyAnn} Δ=${d.toFixed(3)}`);
        annEndStr = ` ann_end JS=${jsAnn} PY=${pyAnn} Δ=${d.toFixed(3)}`;
      } else {
        // 片方だけ announce_end を持つ（has_announce 判定のズレが原因）
        annEndStr = ` ann_end JS=${jsAnn === undefined ? '-' : jsAnn} PY=${pyAnn === undefined ? '-' : pyAnn}`;
      }
    }

    rows.push(
      `${p.page}: JS ${js.num_segments}seg / PY ${p.num_segments}seg ` +
      `${segMatch ? 'OKseg' : 'NGseg'} ` +
      `${cutMatch ? 'OKcut' : 'NGcut(Δmax=' + maxDiff.toFixed(3) + ')'}` +
      `${mergedTotal && (pyMerged.length || jsMerged.length) ? (mergedMatch ? ' OKmerge' : ' NGmerge') : ''}` +
      `${annFlagMatch ? '' : ' NGann'}` +
      annEndStr
    );
  }

  console.log(rows.join('\n'));
  console.log(`\n--- 集計 (${total}ページ) ---`);
  console.log(`セグメント数一致:      ${okSegs}/${total}`);
  console.log(`cut点一致(±${CUT_TOL}s):     ${okCuts}/${total}`);
  console.log(`has_announce一致:      ${okAnnounceFlag}/${annTotal}`);
  console.log(`merged一致(該当ページ): ${okMerged}/${mergedTotal}`);
  console.log(`announce_end一致(±${ANNOUNCE_TOL}s): ${okAnnounceEnd}/${annEndTotal}`);
  if (issues.length) {
    console.log(`\n--- 差異詳細 (${issues.length}件) ---`);
    console.log(issues.join('\n'));
  }
}

main();
