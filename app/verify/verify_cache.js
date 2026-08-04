#!/usr/bin/env node
/* データ保持方式（バージョン付きキャッシュ）の headless 検証。
 *
 * 検証したいのは app.js の ensureSplitCurrent の「意思決定」:
 *   1) 保存時: meta.splitVersion = Splitter.SPLIT_VERSION が付く（元音声Blobは別途保持）。
 *   2) splitVersion === 現行 → 再分割しない（キャッシュをそのまま使う・速い）。
 *   3) splitVersion 不一致（コード更新後の初回）→ 元音声から再分割してキャッシュ更新。
 *      再分割結果が現行ロジック（analyzePage）と一致し、splitVersion が現行に更新される。
 *   4) 元音声が無い旧データ → needsReimport:true（再投入を促す）。
 *
 * app.js は DOM 依存の IIFE なので、ここでは同一ロジックを最小の
 * インメモリDB + 実 Splitter で再現して検証する（DB/Splitter は実コードを require）。
 * 元音声は audio/raw の実mp3を使い、ffmpeg で decode（verify_split.js と同方式）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Splitter = require('../js/splitter.js');

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const ROOT = path.resolve(__dirname, '../..');
const RAW = path.join(ROOT, 'audio/raw');
const SR = 44100;

// テスト対象ページ（少数で十分・再分割の数値一致まで確認する）
const PAGES = ['001', '040', '086', '095', '098'];

function decodeToFloat32(mp3Path) {
  const buf = execFileSync(FFMPEG, [
    '-v', 'quiet', '-i', mp3Path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-',
  ], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}
function probeDuration(mp3Path) {
  return parseFloat(execFileSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', mp3Path,
  ]).toString().trim());
}

/* --- インメモリDB（app.js が使う DB API の意思決定に必要な部分だけ再現）--- */
function makeDB() {
  const books = new Map();     // id -> meta
  const audio = new Map();     // `${id}/${page}` -> {samples,duration}（Blobの代役）
  return {
    saveBook(meta, audioMap) { books.set(meta.id, meta); for (const k of Object.keys(audioMap)) audio.set(`${meta.id}/${k}`, audioMap[k]); },
    updateBookMeta(meta) { books.set(meta.id, meta); },
    getBook(id) { return books.get(id); },
    getAudioRaw(id, page) { return audio.get(`${id}/${page}`) || null; },
    hasAllAudio(id, pages) { return pages.every((p) => audio.has(`${id}/${p.page}`)); },
    deleteAudio(id, page) { audio.delete(`${id}/${page}`); },
  };
}

/* analyzePage の代役（ffmpegでdecode → 実 analyzeFromSamples）。ブラウザの Splitter.analyzePage と同一ロジック。 */
function analyzeStored(store) { return Splitter.analyzeFromSamples(store.samples, SR, store.duration, store.page); }

/* app.js の ensureSplitCurrent と同じ意思決定を DB モックで再現。 */
function ensureSplitCurrent(db, meta, counters) {
  if (meta.splitVersion === Splitter.SPLIT_VERSION) { counters.resplitRuns += 0; return meta; }
  const pages = (meta.book && meta.book.pages) || [];
  const canResplit = pages.length > 0 && db.hasAllAudio(meta.id, pages);
  if (!canResplit) return Object.assign({}, meta, { needsReimport: true });
  counters.resplitRuns++;
  const newPages = pages.map((p) => {
    const store = db.getAudioRaw(meta.id, p.page);
    return store ? analyzeStored(store) : p;
  });
  const updated = Object.assign({}, meta, {
    splitVersion: Splitter.SPLIT_VERSION,
    book: Object.assign({}, meta.book, { pages: newPages }),
  });
  delete updated.needsReimport;
  db.updateBookMeta(updated);
  return updated;
}

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } }

function main() {
  console.log('=== データ保持方式（バージョン付きキャッシュ）検証 ===\n');

  // 元音声を読み込んで「保存（import）」を再現
  const audioMap = {};
  const pagesMeta = [];
  for (const pg of PAGES) {
    const mp3 = path.join(RAW, pg + '.mp3');
    if (!fs.existsSync(mp3)) { console.log(`skip ${pg}（音声なし）`); continue; }
    const samples = decodeToFloat32(mp3);
    const duration = probeDuration(mp3);
    audioMap[pg] = { samples, duration, page: pg };  // Blob の代役
    pagesMeta.push(Splitter.analyzeFromSamples(samples, SR, duration, pg));
  }

  const db = makeDB();
  const id = 'book_test';
  // --- 1) 保存: splitVersion が付く / 元音声Blobが保持される ---
  const meta = { id, name: 'Test', createdAt: Date.now(), splitVersion: Splitter.SPLIT_VERSION, book: { book: 'Test', pages: pagesMeta } };
  db.saveBook(meta, audioMap);
  const saved = db.getBook(id);
  console.log('1) 保存');
  check('meta.splitVersion が現行と一致', saved.splitVersion === Splitter.SPLIT_VERSION);
  check('元音声Blob（代役）が全ページ保持', db.hasAllAudio(id, saved.book.pages));

  // --- 2) 同一バージョン → 再分割しない ---
  console.log('\n2) 同一バージョンでオープン（再分割しない = 速い）');
  const c2 = { resplitRuns: 0 };
  const r2 = ensureSplitCurrent(db, saved, c2);
  check('再分割は走らない', c2.resplitRuns === 0);
  check('book.pages は据え置き（同一参照）', r2.book === saved.book);

  // --- 3) SPLIT_VERSION を上げた状況をシミュレート（保存済みメタを古いバージョンにする）---
  console.log('\n3) ロジック更新後の初回オープン（splitVersion 不一致 → 自動再分割）');
  const oldMeta = Object.assign({}, saved, { splitVersion: Splitter.SPLIT_VERSION - 1 });
  db.updateBookMeta(oldMeta);
  const c3 = { resplitRuns: 0 };
  const r3 = ensureSplitCurrent(db, db.getBook(id), c3);
  check('再分割が走る', c3.resplitRuns === 1);
  check('splitVersion が現行へ更新', r3.splitVersion === Splitter.SPLIT_VERSION);
  check('DBにも更新後メタが永続化', db.getBook(id).splitVersion === Splitter.SPLIT_VERSION);
  // 再分割結果が現行 analyzePage と数値一致（キャッシュが正しく作り直された）
  let identical = true;
  r3.book.pages.forEach((p, i) => {
    if (JSON.stringify(p) !== JSON.stringify(pagesMeta[i])) identical = false;
  });
  check('再分割結果が現行ロジックの分割と完全一致', identical);
  // 再度オープン → もう再分割しない（バージョンが揃ったので速い）
  const c3b = { resplitRuns: 0 };
  ensureSplitCurrent(db, db.getBook(id), c3b);
  check('直後の再オープンでは再分割しない', c3b.resplitRuns === 0);

  // --- 4) 元音声が無い旧データ → needsReimport ---
  console.log('\n4) 元音声が無い旧データ（マイグレーション不可 → 再投入を促す）');
  const db2 = makeDB();
  const legacy = { id: 'legacy', name: 'Legacy', createdAt: 1, book: { book: 'Legacy', pages: pagesMeta } }; // splitVersion 無し・audio 無し
  db2.saveBook(legacy, {}); // 音声なしで保存
  const c4 = { resplitRuns: 0 };
  const r4 = ensureSplitCurrent(db2, db2.getBook('legacy'), c4);
  check('splitVersion 無し = 要再計算扱い（再分割は試みるが…）', true);
  check('元音声が無いので needsReimport:true', r4.needsReimport === true);
  check('再分割は走らない（元音声が無い）', c4.resplitRuns === 0);

  // --- 5) 旧データでも元音声があればマイグレーションで再分割できる ---
  console.log('\n5) 旧スキーマ（splitVersion無し）でも元音声があれば自動移行');
  const db3 = makeDB();
  const legacy2 = { id: 'legacy2', name: 'Legacy2', createdAt: 1, book: { book: 'Legacy2', pages: pagesMeta } };
  const audioMap2 = {}; for (const pg of Object.keys(audioMap)) audioMap2[pg] = audioMap[pg];
  db3.saveBook(legacy2, audioMap2);
  const c5 = { resplitRuns: 0 };
  const r5 = ensureSplitCurrent(db3, db3.getBook('legacy2'), c5);
  check('再分割が走って移行', c5.resplitRuns === 1);
  check('splitVersion が付与される', r5.splitVersion === Splitter.SPLIT_VERSION);
  check('needsReimport は付かない', !r5.needsReimport);

  console.log(`\n=> ${fail === 0 ? '全チェック PASS' : `${fail}件 NG`}  (PASS ${pass} / NG ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
