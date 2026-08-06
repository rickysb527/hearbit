#!/usr/bin/env node
/* スター（お気に入り）機能の純ロジック検証。
 *
 * app.js の DOM 依存を避け、実装した純ロジックと等価な関数をここで最小再現し、
 * 実データ（segments.json + vocab.json）で以下を確認する。
 *
 *   1) toggleStar 相当: book.vocab[page/index].starred をトグルする（未エントリは新規作成）。
 *   2) スターは該当キーだけを変更し、他エントリ（テキスト・low_confidence）は不変。
 *   3) vocab 未読込の単語帳でもスターできる（空辞書からの新規作成・starred のみ）。
 *   4) テキスト（漢字/ピンイン）と独立: 既存テキストは保持したまま starred を足せる。
 *   5) countStarred = starred が付いた実セグメント数（フィルタ件数バッジと一致）。
 *   6) スターフィルタで残るセル = starred の単語だけ（件数一致）。
 *   7) starredListenIndices 相当: collectWords 順で starred の global index 配列（順序どおり・
 *      飛び番あり）。連結トラックの対象はこの index だけ・順序が保たれる。
 *   8) スター0件なら対象 index は空（＝入口は無効表示）。
 *   9) page+index キーなので pages 差し替え（SPLIT_VERSION更新）後もスターは紐付く。
 */
const fs = require('fs');
const path = require('path');
const ListenBuild = require('../js/listen-build.js'); // collectWords は実コードを使う

const ROOT = path.resolve(__dirname, '../..');
const SEG = path.join(ROOT, 'data/segments.json');
const VOCAB = path.join(ROOT, 'data/vocab.json');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra != null ? '  ' + extra : ''}`); }
}

// ---- app.js と等価な純ロジック ----
function parseVocabArray(arr) {
  const map = {};
  for (const it of arr) {
    if (!it || it.page == null || it.index == null) continue;
    map[`${String(it.page)}/${Number(it.index)}`] = {
      hanzi: it.hanzi != null ? String(it.hanzi) : '',
      pinyin: it.pinyin != null ? String(it.pinyin) : '',
      gloss: it.gloss != null ? String(it.gloss) : '',
      low_confidence: !!it.low_confidence,
    };
  }
  return map;
}
function vocabFor(book, page, segIndex) {
  const v = book && book.vocab;
  return v ? (v[`${page}/${segIndex}`] || null) : null;
}
function isStarred(book, page, segIndex) {
  const t = vocabFor(book, page, segIndex);
  return !!(t && t.starred);
}
// toggleStar の本体（app.js と等価）: 該当キーの starred を反転。未エントリは新規作成。
function applyToggleStar(book, page, segIndex) {
  const key = `${page}/${segIndex}`;
  const cur = (book.vocab && book.vocab[key]) || null;
  const entry = Object.assign(
    { hanzi: '', pinyin: '', gloss: '', low_confidence: false },
    cur,
    { starred: !(cur && cur.starred) },
  );
  const vocab = Object.assign({}, book.vocab || {}, { [key]: entry });
  return Object.assign({}, book, { vocab });
}
function countStarred(book) {
  if (!book.vocab) return 0;
  let n = 0;
  book.book.pages.forEach((p) => p.segments.forEach((seg) => {
    const t = book.vocab[`${p.page}/${seg.index}`];
    if (t && t.starred) n++;
  }));
  return n;
}
// renderPages の「スターのみ表示」フィルタで残るセル数。
function countVisibleStarOnly(book) {
  let n = 0;
  book.book.pages.forEach((p) => p.segments.forEach((seg) => {
    if (isStarred(book, p.page, seg.index)) n++;
  }));
  return n;
}
// starredListenIndices 相当: collectWords 順で starred の global index 配列。
function starredIndices(words, book) {
  const out = [];
  words.forEach((w, i) => { if (isStarred(book, w.page, w.seg.index)) out.push(i); });
  return out;
}

function main() {
  console.log('=== スター（お気に入り）検証 ===\n');
  const seg = JSON.parse(fs.readFileSync(SEG, 'utf8'));
  const baseBook = { name: 'HSK3級単語', book: { book: seg.book, pages: seg.pages } };

  if (!fs.existsSync(VOCAB)) {
    console.log('[SKIP] data/vocab.json が無いため実データ検証はスキップ');
    process.exit(0);
  }
  const raw = JSON.parse(fs.readFileSync(VOCAB, 'utf8'));
  const map = parseVocabArray(raw);
  const words = ListenBuild.collectWords(baseBook.book); // 実コードの語リスト（順序どおり）

  // ===== 1) トグル: off → on → off =====
  console.log('1) スターのトグルと永続化');
  let book = Object.assign({}, baseBook, { vocab: JSON.parse(JSON.stringify(map)) });
  const key = '001/0'; // 阿姨
  check('初期は未スター', isStarred(book, '001', 0) === false);
  book = applyToggleStar(book, '001', 0);
  check('トグルでスターON', isStarred(book, '001', 0) === true);
  book = applyToggleStar(book, '001', 0);
  check('もう一度トグルでスターOFF', isStarred(book, '001', 0) === false);
  // 再ON（以降の検証で使う）
  book = applyToggleStar(book, '001', 0);

  // ===== 2) 他エントリ不変・テキスト保持 =====
  console.log('\n2) 他エントリ不変・テキスト独立');
  const before = JSON.parse(JSON.stringify(map));
  const b2 = applyToggleStar(Object.assign({}, baseBook, { vocab: JSON.parse(JSON.stringify(map)) }), '001', 0);
  const othersUnchanged = Object.keys(before).every((k) =>
    k === '001/0' || JSON.stringify(before[k]) === JSON.stringify(b2.vocab[k]));
  check('スターは他エントリを変えない', othersUnchanged);
  const e = b2.vocab['001/0'];
  check('既存テキスト（漢字/ピンイン）は保持', e.hanzi === map['001/0'].hanzi && e.pinyin === map['001/0'].pinyin,
    JSON.stringify(e));
  check('既存 low_confidence は保持', e.low_confidence === map['001/0'].low_confidence);

  // ===== 3) vocab 未読込でもスター可（新規作成） =====
  console.log('\n3) テキスト未読込の単語帳でもスター可');
  let emptyBook = Object.assign({}, baseBook); // vocab 無し
  emptyBook = applyToggleStar(emptyBook, '002', 1);
  check('空辞書から starred エントリを新規作成', emptyBook.vocab && emptyBook.vocab['002/1'] && emptyBook.vocab['002/1'].starred === true);
  check('新規スターエントリのテキストは空（番号表示のまま）',
    emptyBook.vocab['002/1'].hanzi === '' && emptyBook.vocab['002/1'].pinyin === '');
  check('新規スターは他キーを作らない', Object.keys(emptyBook.vocab).length === 1);

  // ===== 4) フィルタ件数バッジ =====
  console.log('\n4) スター件数（フィルタバッジ）');
  // 3件スター: 001/0（済）, 003/2, 010/1 を付ける
  book = applyToggleStar(book, '003', 2);
  book = applyToggleStar(book, '010', 1);
  check('countStarred = 3', countStarred(book) === 3, `n=${countStarred(book)}`);
  check('スターフィルタ表示件数 = countStarred', countVisibleStarOnly(book) === countStarred(book));

  // ===== 5) スター単語だけの連結トラック対象 index =====
  console.log('\n5) スター単語だけの連結トラック対象');
  const idx = starredIndices(words, book);
  check('対象は 3語', idx.length === 3, `len=${idx.length}`);
  // 各 index が指す words[] が実際に starred（対象は starred のみ）
  const allStarred = idx.every((i) => isStarred(book, words[i].page, words[i].seg.index));
  check('対象は starred のみ', allStarred);
  // starred 以外は含まれない（非対象がスター扱いされない）
  const nonStarredExcluded = words.every((w, i) => idx.includes(i) || !isStarred(book, w.page, w.seg.index));
  check('starred 以外は対象外', nonStarredExcluded);
  // 順序: collectWords（＝単語一覧）の並び順どおり（昇順の global index）
  const sorted = idx.slice().sort((a, b) => a - b);
  check('対象 index は語順どおり（昇順）', JSON.stringify(idx) === JSON.stringify(sorted), JSON.stringify(idx));
  // 対象語の page/index が期待どおり（003/2, 010/1 が含まれ、非スターの隣接語は入らない）
  const pagesInTrack = idx.map((i) => `${words[i].page}/${words[i].seg.index}`);
  check('対象に 003/2 が含まれる', pagesInTrack.includes('003/2'), JSON.stringify(pagesInTrack));
  check('対象に 010/1 が含まれる', pagesInTrack.includes('010/1'));
  check('対象に非スターの 003/1 は含まれない', !pagesInTrack.includes('003/1'));

  // ===== 6) 0件時 =====
  console.log('\n6) スター0件（入口は無効）');
  let zero = Object.assign({}, baseBook, { vocab: JSON.parse(JSON.stringify(map)) });
  check('0件のとき countStarred=0', countStarred(zero) === 0);
  check('0件のとき対象 index は空', starredIndices(words, zero).length === 0);

  // ===== 7) pages 差し替え後もスターが紐付く =====
  console.log('\n7) 分割再計算（pages 差し替え）後もスター保持');
  const reBook = Object.assign({}, book, {
    book: { book: book.book.book, pages: JSON.parse(JSON.stringify(book.book.pages)) },
  });
  check('pages 差し替え後もスターは page+index で紐付く', isStarred(reBook, '003', 2) === true);
  check('差し替え後も countStarred=3', countStarred(reBook) === 3);

  console.log(`\n=> ${fail === 0 ? '全チェック PASS' : `${fail}件 NG`}  (PASS ${pass} / NG ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
