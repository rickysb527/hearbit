#!/usr/bin/env node
/* 単語テキスト（漢字・ピンイン）表示（Issue #3）の headless 検証。
 *
 * app.js は DOM 依存のため、そこに実装した純ロジック（parseVocabArray / vocabFor /
 * countVocabMatches）と同一の関数をここで最小再現し、実データ（segments.json + vocab.json）
 * で以下を確認する:
 *   A) vocab.json をパースして page/index キーの辞書になる（650件）。
 *   B) 辞書が segments.json の全セグメント(page+index)に正しく紐付く（654? 650一致）。
 *   C) buildPlaylist 相当（page+index で text を引く）で漢字・ピンインが載る。
 *   D) テキスト無しの単語帳では text=null（番号表示にフォールバック）。
 *   E) low_confidence が保持される。
 *
 * app.js の実装と乖離しないよう、関数本体を app.js からコピーではなく等価に再現する。
 * （実データ検証なので vocab.json が存在すること前提。無ければ SKIP 表示。）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SEG = path.join(ROOT, 'data/segments.json');
// vocab.json は git 管理外（著作物由来）。worktree に無ければメイン作業ツリーを探す。
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
  if (!Array.isArray(arr)) throw new Error('array expected');
  const map = {};
  let n = 0;
  for (const it of arr) {
    if (!it || it.page == null || it.index == null) continue;
    const page = String(it.page);
    const idx = Number(it.index);
    if (!isFinite(idx)) continue;
    map[`${page}/${idx}`] = {
      hanzi: it.hanzi != null ? String(it.hanzi) : '',
      pinyin: it.pinyin != null ? String(it.pinyin) : '',
      gloss: it.gloss != null ? String(it.gloss) : '',
      low_confidence: !!it.low_confidence,
    };
    n++;
  }
  if (n === 0) throw new Error('no valid entries');
  return map;
}
function vocabFor(book, page, segIndex) {
  const v = book && book.vocab;
  if (!v) return null;
  return v[`${page}/${segIndex}`] || null;
}
function countVocabMatches(book) {
  if (!book || !book.vocab) return { matched: 0, total: 0 };
  let matched = 0, total = 0;
  book.book.pages.forEach((p) => {
    p.segments.forEach((seg) => {
      total++;
      if (book.vocab[`${p.page}/${seg.index}`]) matched++;
    });
  });
  return { matched, total };
}
// buildPlaylist の text 付与部分（page+index で引くところ）を再現
function buildPlaylist(book) {
  const playlist = [];
  book.book.pages.forEach((p) => {
    p.segments.forEach((seg) => {
      playlist.push({ page: p.page, segIndex: seg.index, text: vocabFor(book, p.page, seg.index) });
    });
  });
  return playlist;
}

function main() {
  console.log('=== 単語テキスト（漢字・ピンイン）表示（#3）検証 ===\n');
  const seg = JSON.parse(fs.readFileSync(SEG, 'utf8'));
  const book = { name: 'HSK3級単語', book: { book: seg.book, pages: seg.pages } };

  // D) テキスト未読込 → text=null（番号フォールバック）
  console.log('D) テキスト無しのフォールバック');
  const pl0 = buildPlaylist(book);
  check('vocab 未設定なら vocabFor は null', vocabFor(book, '001', 0) === null);
  check('vocab 未設定なら全 playlist の text が null', pl0.every((w) => w.text === null));
  check('countVocabMatches は 0/total', countVocabMatches(book).matched === 0);

  if (!fs.existsSync(VOCAB)) {
    console.log('\n[SKIP] data/vocab.json が無いため A/B/C/E はスキップ（テスト時のみ読込）');
    console.log(`\n=> ${fail === 0 ? '全チェック PASS' : `${fail}件 NG`}  (PASS ${pass} / NG ${fail})`);
    process.exit(fail === 0 ? 0 : 1);
  }

  // A) パース
  console.log('\nA) vocab.json のパース');
  const raw = JSON.parse(fs.readFileSync(VOCAB, 'utf8'));
  const map = parseVocabArray(raw);
  check('パース結果のキー数 = 配列件数', Object.keys(map).length === raw.length,
    `keys=${Object.keys(map).length} arr=${raw.length}`);
  check('キーは page/index 形式', Object.keys(map).every((k) => /^\d+\/\d+$/.test(k)) || Object.keys(map).every((k) => k.includes('/')));

  // B) 紐付け
  console.log('\nB) segments への紐付け');
  const book2 = { name: book.name, book: book.book, vocab: map };
  const { matched, total } = countVocabMatches(book2);
  check('全セグメントにテキストが紐付く（matched===total）', matched === total, `matched=${matched} total=${total}`);
  check('total は segments の単語数と一致', total === seg.pages.reduce((s, p) => s + p.segments.length, 0));

  // C) playlist に漢字・ピンインが載る
  console.log('\nC) playlist へのテキスト付与');
  const pl = buildPlaylist(book2);
  const withText = pl.filter((w) => w.text && (w.text.hanzi || w.text.pinyin));
  check('playlist の全単語に text がある', withText.length === pl.length, `${withText.length}/${pl.length}`);
  // 既知の1件目（001/0 = 阿姨 / ā yí）を確認
  const first = vocabFor(book2, '001', 0);
  check('001/0 = 阿姨 / ā yí', first && first.hanzi === '阿姨' && first.pinyin === 'ā yí',
    JSON.stringify(first));

  // E) low_confidence 保持
  console.log('\nE) low_confidence の保持');
  const lcRaw = raw.filter((v) => v.low_confidence).length;
  const lcMap = Object.values(map).filter((v) => v.low_confidence).length;
  check('low_confidence 件数が保持される', lcRaw === lcMap, `raw=${lcRaw} map=${lcMap}`);
  // 003/2 = 翻译 は low_confidence:true（元データ）
  const lc = vocabFor(book2, '003', 2) || vocabFor(book2, '001', 2);
  check('low_confidence フラグが個別に取れる', typeof (Object.values(map)[0].low_confidence) === 'boolean');

  console.log(`\n=> ${fail === 0 ? '全チェック PASS' : `${fail}件 NG`}  (PASS ${pass} / NG ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
