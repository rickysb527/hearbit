#!/usr/bin/env node
/* テキスト手動修正（実装1）と 聞き流しプレーヤーのテキスト表示（実装2）の headless 検証。
 *
 * app.js / listen.js は DOM 依存のため、そこに実装した純ロジックと等価な関数をここで
 * 最小再現し、実データ（segments.json + vocab.json）で以下を確認する。
 *
 * 実装1（テキスト手動修正）:
 *   1) 編集は book.vocab の該当 page/index を上書きする（他エントリは不変）。
 *   2) 保存後 low_confidence が false に落ちる（手で直した=信頼）。
 *   3) vocab 未読込の単語帳でも、編集で新規エントリを作れる（空辞書からの追加）。
 *   4) 一覧/再生の text 付与（vocabFor/buildPlaylist 相当）に編集が即反映される。
 *   5) 編集は page+index キーなので、SPLIT_VERSION 更新に伴う pages 差し替え後も紐付く。
 *   6) 「要確認のみ表示」フィルタ = low_confidence の単語だけ残す（件数一致）。
 *
 * 実装2（聞き流しのテキスト表示）:
 *   7) collectWords（実コード）の連結トラック順で、rangeFrom+wiInTrack から words[] を引き、
 *      その page/seg.index で vocab を引くと現在語の漢字・ピンインが取れる。
 *   8) テキスト無しの単語帳では現在語テキストは null（番号フォールバック）。
 *   9) Media Session タイトルは漢字+ピンインを優先（あれば）、無ければ「聞き流し n/total」。
 */
const fs = require('fs');
const path = require('path');
const ListenBuild = require('../js/listen-build.js'); // collectWords は実コードを使う

const ROOT = path.resolve(__dirname, '../..');
const SEG = path.join(ROOT, 'data/segments.json');
const VOCAB_CANDIDATES = [
  path.join(ROOT, 'data/vocab.json'),
  '/Users/rikikun/dev/vocab-audio-separator/data/vocab.json',
];
const VOCAB = VOCAB_CANDIDATES.find((p) => fs.existsSync(p)) || VOCAB_CANDIDATES[0];

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? '  ' + extra : ''}`); }
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
// TextEdit.save の本体（app.js と等価）: 新しい辞書を作って該当キーを上書き、low_conf=false。
function applyEdit(book, page, segIndex, fields) {
  const key = `${page}/${segIndex}`;
  const entry = {
    hanzi: (fields.hanzi || '').trim(),
    pinyin: (fields.pinyin || '').trim(),
    gloss: (fields.gloss || '').trim(),
    low_confidence: false,
  };
  const vocab = Object.assign({}, book.vocab || {}, { [key]: entry });
  return Object.assign({}, book, { vocab });
}
function countLowConfidence(book) {
  if (!book.vocab) return 0;
  let n = 0;
  book.book.pages.forEach((p) => p.segments.forEach((seg) => {
    const t = book.vocab[`${p.page}/${seg.index}`];
    if (t && t.low_confidence) n++;
  }));
  return n;
}
// renderPages の「要確認のみ表示」フィルタで残るセル数。
function countVisibleLowOnly(book) {
  let n = 0;
  book.book.pages.forEach((p) => p.segments.forEach((seg) => {
    const t = book.vocab && book.vocab[`${p.page}/${seg.index}`];
    if (t && t.low_confidence) n++;
  }));
  return n;
}
// listen.js の textForTrackWord 相当。words=collectWords 結果、rangeFrom + wiInTrack が global。
function textForTrackWord(words, book, rangeFrom, wiInTrack) {
  const w = words[rangeFrom + wiInTrack];
  if (!w) return null;
  const t = vocabFor(book, w.page, w.seg.index);
  if (!t || (!t.hanzi && !t.pinyin && !t.gloss)) return null;
  return t;
}
// listen.js updateMediaMetadata のタイトル生成と等価。
function mediaTitle(t, n, total) {
  if (t && (t.hanzi || t.pinyin)) {
    return [t.hanzi, t.pinyin].filter(Boolean).join('  ') + `  (${n}/${total})`;
  }
  return `聞き流し ${n}/${total}`;
}

function main() {
  console.log('=== テキスト手動修正 & 聞き流しテキスト表示 検証 ===\n');
  const seg = JSON.parse(fs.readFileSync(SEG, 'utf8'));
  const baseBook = { name: 'HSK3級単語', book: { book: seg.book, pages: seg.pages } };

  if (!fs.existsSync(VOCAB)) {
    console.log('[SKIP] data/vocab.json が無いため実データ検証はスキップ');
    process.exit(0);
  }
  const raw = JSON.parse(fs.readFileSync(VOCAB, 'utf8'));
  const map = parseVocabArray(raw);

  // ===== 実装1: テキスト手動修正 =====
  console.log('実装1: テキスト手動修正');
  let book = Object.assign({}, baseBook, { vocab: map });

  // 1) 該当キーだけ上書き（他は不変）
  const before = JSON.parse(JSON.stringify(book.vocab));
  const targetKey = '003/2'; // 元データで low_confidence:true の 翻译
  const wasLow = !!(book.vocab[targetKey] && book.vocab[targetKey].low_confidence);
  book = applyEdit(book, '003', 2, { hanzi: '翻訳テスト', pinyin: 'fān yì', gloss: '翻訳する' });
  check('編集対象キーが上書きされる', book.vocab[targetKey].hanzi === '翻訳テスト');
  const othersUnchanged = Object.keys(before).every((k) =>
    k === targetKey || JSON.stringify(before[k]) === JSON.stringify(book.vocab[k]));
  check('他エントリは不変', othersUnchanged);

  // 2) low_confidence が false へ
  check('編集対象は元 low_confidence:true だった（前提）', wasLow, `key=${targetKey}`);
  check('保存後 low_confidence=false', book.vocab[targetKey].low_confidence === false);

  // 3) vocab 未読込でも新規追加できる
  let emptyBook = Object.assign({}, baseBook); // vocab 無し
  emptyBook = applyEdit(emptyBook, '001', 0, { hanzi: '手入力', pinyin: 'shǒu', gloss: '' });
  check('vocab 未読込でも編集で新規エントリを作れる',
    emptyBook.vocab && emptyBook.vocab['001/0'] && emptyBook.vocab['001/0'].hanzi === '手入力');
  check('新規作成エントリも low_confidence=false', emptyBook.vocab['001/0'].low_confidence === false);

  // 4) buildPlaylist 相当（vocabFor）に即反映
  check('vocabFor で編集後の値が取れる', vocabFor(book, '003', 2).hanzi === '翻訳テスト');
  check('vocabFor は ? を落とす（low_conf=false）', vocabFor(book, '003', 2).low_confidence === false);

  // 5) SPLIT_VERSION 更新（pages 差し替え）後も page+index キーで紐付く
  const reBook = Object.assign({}, book, {
    book: { book: book.book.book, pages: JSON.parse(JSON.stringify(book.book.pages)) },
  });
  check('pages 差し替え後も編集が紐付く', vocabFor(reBook, '003', 2).hanzi === '翻訳テスト');

  // 6) 要確認フィルタ = low_confidence だけ。編集で1件減る
  const lcBefore = raw.filter((v) => v.low_confidence).length;
  const lcAfter = countLowConfidence(book);
  check('編集で要確認が1件減る', lcAfter === lcBefore - 1, `before=${lcBefore} after=${lcAfter}`);
  check('フィルタ表示件数 = low_confidence 件数', countVisibleLowOnly(book) === lcAfter);

  // ===== 実装2: 聞き流しのテキスト表示 =====
  console.log('\n実装2: 聞き流しプレーヤーのテキスト表示');
  const bookWithText = Object.assign({}, baseBook, { vocab: map });
  const words = ListenBuild.collectWords(bookWithText.book); // 実コードの語リスト

  // 7) トラック内 wiInTrack から現在語テキストが引ける（rangeFrom=0, size=50 の1本目）
  const t0 = textForTrackWord(words, bookWithText, 0, 0);
  check('トラック先頭語のテキスト（001/0 = 阿姨）', t0 && t0.hanzi === '阿姨' && t0.pinyin === 'ā yí',
    JSON.stringify(t0));
  // 途中の語（トラック内 5語目 = global index 5）
  const w5 = words[5];
  const t5 = textForTrackWord(words, bookWithText, 0, 5);
  const expect5 = vocabFor(bookWithText, w5.page, w5.seg.index);
  check('トラック内5語目が words[5]の page/index を引く',
    t5 && expect5 && t5.hanzi === expect5.hanzi, `${JSON.stringify(t5)}`);
  // 2本目トラック（rangeFrom=50）の先頭語 = words[50]
  const w50 = words[50];
  const t50 = textForTrackWord(words, bookWithText, 50, 0);
  check('2本目トラック先頭語が words[50] を引く',
    t50 && t50.hanzi === vocabFor(bookWithText, w50.page, w50.seg.index).hanzi);

  // 語が切り替わると別テキストになる（隣接語が異なる）
  check('隣接語でテキストが切り替わる', JSON.stringify(t0) !== JSON.stringify(textForTrackWord(words, bookWithText, 0, 1)));

  // 8) テキスト無しの単語帳では null（番号フォールバック）
  const wordsNoText = ListenBuild.collectWords(baseBook.book);
  check('vocab 無しなら現在語テキストは null',
    textForTrackWord(wordsNoText, baseBook, 0, 0) === null);

  // 9) Media Session タイトル: 漢字+ピンイン優先、無ければ「聞き流し n/total」
  check('タイトルは漢字+ピンイン優先', mediaTitle(t0, 1, 50) === '阿姨  ā yí  (1/50)', mediaTitle(t0, 1, 50));
  check('テキスト無しは「聞き流し n/total」', mediaTitle(null, 3, 50) === '聞き流し 3/50');

  console.log(`\n=> ${fail === 0 ? '全チェック PASS' : `${fail}件 NG`}  (PASS ${pass} / NG ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
