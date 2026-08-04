#!/usr/bin/env node
/* 分割の手動編集（#4）の headless 検証。
 *
 * 検証したいこと:
 *   A) editor.js の純ロジック（pageToState / stateToPage / add/remove/nudge/type/announce）が
 *      segments.json と同一形式の page を正しく組み立て、付随フィールドの整合を保つ。
 *   B) 手動編集ページが manualEdited:true になり、SPLIT_VERSION が上がっても
 *      ensureSplitCurrent（app.js と同一の意思決定）で自動再分割から保護される。
 *   C) 編集していないページは従来どおり再分割される（保護は該当ページ限定）。
 *
 * editor.js は純ロジックなので直接 require。ensureSplitCurrent は DOM 依存の app.js 内に
 * あるため、同一ロジックをここで最小再現する（manualEdited のスキップを含む）。
 * 元音声は audio/raw の実mp3を ffmpeg decode（verify_split/verify_cache と同方式）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Splitter = require('../js/splitter.js');
const SplitEditor = require('../js/editor.js');

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const ROOT = path.resolve(__dirname, '../..');
const RAW = path.join(ROOT, 'audio/raw');
const SEG = path.join(ROOT, 'data/segments.json');
const SR = 44100;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? '  ' + extra : ''}`); }
}

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

/* app.js の ensureSplitCurrent と同一の意思決定（manualEdited スキップ込み）。 */
function ensureSplitCurrent(db, meta, counters) {
  if (meta.splitVersion === Splitter.SPLIT_VERSION) return meta;
  const pages = (meta.book && meta.book.pages) || [];
  const canResplit = pages.length > 0 && pages.every((p) => db.audio.has(`${meta.id}/${p.page}`));
  if (!canResplit) return Object.assign({}, meta, { needsReimport: true });
  const newPages = pages.map((p) => {
    if (p.manualEdited) { counters.protectedPages.push(p.page); return p; } // 保護
    counters.resplitPages.push(p.page);
    const store = db.audio.get(`${meta.id}/${p.page}`);
    return Splitter.analyzeFromSamples(store.samples, SR, store.duration, p.page);
  });
  const updated = Object.assign({}, meta, {
    splitVersion: Splitter.SPLIT_VERSION,
    book: Object.assign({}, meta.book, { pages: newPages }),
  });
  delete updated.needsReimport;
  db.books.set(meta.id, updated);
  return updated;
}

function main() {
  console.log('=== 分割の手動編集（#4）検証 ===\n');
  const seg = JSON.parse(fs.readFileSync(SEG, 'utf8'));

  // アナウンス付きページ(001)と通常ページ(002)を代表に使う
  const p001 = seg.pages.find((p) => p.page === '001');
  const p002 = seg.pages.find((p) => p.page === '002');

  // --- A) 純ロジック ---
  console.log('A) editor.js 純ロジック');

  // A1: pageToState → stateToPage の恒等（編集しなければ境界・type・announce_end が保たれる）
  const st1 = SplitEditor.pageToState(p001);
  const rebuilt = SplitEditor.stateToPage(p001, st1);
  const sameBounds = JSON.stringify(rebuilt.segments.map((s) => [s.start, s.end])) ===
    JSON.stringify(p001.segments.map((s) => [s.start, s.end]));
  check('無編集の往復で境界(start/end)が保たれる', sameBounds);
  check('無編集の往復で num_segments 保持', rebuilt.num_segments === p001.num_segments);
  check('無編集の往復で type 列 保持',
    JSON.stringify(rebuilt.segments.map((s) => s.type)) === JSON.stringify(p001.segments.map((s) => s.type)));
  const aeOrig = p001.segments[0].announce_end;
  check('無編集の往復で announce_end(seg0) 保持',
    aeOrig == null ? rebuilt.segments[0].announce_end == null
      : Math.abs(rebuilt.segments[0].announce_end - aeOrig) < 1e-6, `orig=${aeOrig} got=${rebuilt.segments[0].announce_end}`);
  check('stateToPage は manualEdited:true を立てる', rebuilt.manualEdited === true);
  // length 整合
  const lenOK = rebuilt.segments.every((s) => Math.abs(s.length - Math.round((s.end - s.start) * 100) / 100) < 1e-9);
  check('length = round2(end-start) の整合', lenOK);

  // A2: 境界の微調整（seg1 の頭を +0.1s）
  const before = st1.bounds[1];
  let st2 = SplitEditor.nudgeBoundary(st1, 1, 0.1);
  check('nudgeBoundary(+0.1) で境界が約0.1s動く', Math.abs((st2.bounds[1] - before) - 0.1) < 1e-6,
    `Δ=${(st2.bounds[1] - before).toFixed(3)}`);
  // クランプ: 隣接を越えない（巨大 delta）
  let st2b = SplitEditor.nudgeBoundary(st1, 1, +9999);
  check('nudgeBoundary はクランプされ次境界を越えない', st2b.bounds[1] < st2b.bounds[2]);

  // A3: 境界の追加 → num_segments +1、追加点が境界に含まれる
  const nSegBefore = st1.bounds.length - 1;
  const insertAt = (st1.bounds[1] + st1.bounds[2]) / 2;
  const st3 = SplitEditor.addBoundary(st1, insertAt);
  check('addBoundary でセグメントが1つ増える', (st3.bounds.length - 1) === nSegBefore + 1);
  check('addBoundary の点が境界に含まれる', st3.bounds.some((b) => Math.abs(b - Math.round(insertAt * 1000) / 1000) < 1e-6));

  // A4: 境界の削除 → 元に戻る（追加した点を削除）
  const delIdx = st3.bounds.findIndex((b) => Math.abs(b - Math.round(insertAt * 1000) / 1000) < 1e-6);
  const st4 = SplitEditor.removeBoundary(st3, delIdx);
  check('removeBoundary でセグメント数が戻る', (st4.bounds.length - 1) === nSegBefore);
  // 端の境界は消せない
  const st4b = SplitEditor.removeBoundary(st1, 0);
  check('先頭境界(0)は削除できない', st4b.bounds[0] === 0 && (st4b.bounds.length - 1) === nSegBefore);

  // A5: type 切替と announce_end
  // 通常ページ 002 の seg0 を word+announce にする → announce_end が範囲内に初期化される
  const stB = SplitEditor.pageToState(p002);
  const stBann = SplitEditor.setType(stB, 0, 'word+announce');
  check('setType(word+announce) で type が変わる', stBann.types[0] === 'word+announce');
  check('word+announce 化で announce_end が範囲内に初期化',
    stBann.announceEnds[0] != null && stBann.announceEnds[0] > stBann.bounds[0] && stBann.announceEnds[0] < stBann.bounds[1]);
  const pageBann = SplitEditor.stateToPage(p002, stBann);
  check('stateToPage: word+announce セグメントに announce_end が付く', pageBann.segments[0].announce_end != null);
  check('stateToPage: has_announce が true になる', pageBann.has_announce === true);
  // announce_end を動かす → クランプ内
  const stBann2 = SplitEditor.nudgeAnnounceEnd(stBann, 0, -0.1);
  check('nudgeAnnounceEnd(-0.1) が効く（範囲内）',
    stBann2.announceEnds[0] < stBann.announceEnds[0] && stBann2.announceEnds[0] > stBann2.bounds[0]);
  // word に戻すと announce_end が消える
  const stBword = SplitEditor.setType(stBann, 0, 'word');
  const pageBword = SplitEditor.stateToPage(p002, stBword);
  check('word に戻すと announce_end が消える', pageBword.segments[0].announce_end == null && pageBword.has_announce === false);

  // A6: 付随フィールド merged / announce_low_confidence は手動編集後に落ちる
  const pMerged = seg.pages.find((p) => p.segments.some((s) => s.merged));
  if (pMerged) {
    const rp = SplitEditor.stateToPage(pMerged, SplitEditor.pageToState(pMerged));
    check(`merged フラグが手動編集後に落ちる（${pMerged.page}）`, rp.segments.every((s) => s.merged === undefined));
  } else {
    check('merged を持つページが見つかる', false, '（segments.json に merged が無い）');
  }

  // --- B/C) 保護ロジック（ensureSplitCurrent と同一意思決定）---
  console.log('\nB/C) 手動編集ページの保護（SPLIT_VERSION 更新時）');
  const PAGES = ['001', '002', '003'];
  const db = { books: new Map(), audio: new Map() };
  const id = 'book_test';
  const pagesMeta = [];
  for (const pg of PAGES) {
    const mp3 = path.join(RAW, pg + '.mp3');
    if (!fs.existsSync(mp3)) continue;
    const samples = decodeToFloat32(mp3);
    const duration = probeDuration(mp3);
    db.audio.set(`${id}/${pg}`, { samples, duration, page: pg });
    pagesMeta.push(Splitter.analyzeFromSamples(samples, SR, duration, pg));
  }
  // 001 を手動編集した体にする（境界を1つ動かして保存）
  const editedState = SplitEditor.nudgeBoundary(SplitEditor.pageToState(pagesMeta[0]), 1, 0.2);
  const edited001 = SplitEditor.stateToPage(pagesMeta[0], editedState);
  const savedPages = [edited001, pagesMeta[1], pagesMeta[2]];
  const meta = { id, name: 'T', createdAt: 1, splitVersion: Splitter.SPLIT_VERSION, book: { book: 'T', pages: savedPages } };
  db.books.set(id, meta);

  check('保存時 001 は manualEdited:true', db.books.get(id).book.pages[0].manualEdited === true);
  const edited001Snapshot = JSON.stringify(db.books.get(id).book.pages[0]);

  // SPLIT_VERSION を上げた状況をシミュレート（保存済みを古いバージョンに）
  const old = Object.assign({}, db.books.get(id), { splitVersion: Splitter.SPLIT_VERSION - 1 });
  db.books.set(id, old);
  const counters = { resplitPages: [], protectedPages: [] };
  const after = ensureSplitCurrent(db, db.books.get(id), counters);

  check('001（手動編集）は再分割から保護された', counters.protectedPages.includes('001'));
  check('002/003（未編集）は再分割された', counters.resplitPages.includes('002') && counters.resplitPages.includes('003'));
  check('保護された 001 の内容は不変（バイト一致）', JSON.stringify(after.book.pages[0]) === edited001Snapshot);
  check('001 の manualEdited は維持', after.book.pages[0].manualEdited === true);
  check('splitVersion は現行へ更新（全体は移行済み）', after.splitVersion === Splitter.SPLIT_VERSION);
  // 再オープンでは（バージョン一致なので）もう何も再分割しない
  const c2 = { resplitPages: [], protectedPages: [] };
  ensureSplitCurrent(db, db.books.get(id), c2);
  check('直後の再オープンで再分割は走らない', c2.resplitPages.length === 0 && c2.protectedPages.length === 0);

  console.log(`\n=> ${fail === 0 ? '全チェック PASS' : `${fail}件 NG`}  (PASS ${pass} / NG ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
