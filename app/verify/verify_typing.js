#!/usr/bin/env node
/* タイピング学習の純ロジック検証。
 *
 * typing.js の normalize（回答判定の正規化）は実コードを require して検証する。
 * app.js 側の純ロジック（mergeVocabPreserveStar / typingCandidates）は DOM 依存の中にあるため、
 * verify の流儀に従って等価な関数をここで最小再現し、実データ（segments.json + vocab.json）で確認する。
 *
 * 確認項目:
 *   A) normalize: 前後空白除去・内部空白/全角スペース除去・全角英数→半角。簡体字はそのまま。
 *   B) 判定: 正規化して完全一致で正解／不一致で不正解。
 *   C) mergeVocabPreserveStar: 再読み込みで starred を page/index キーで引き継ぐ（テキストは新優先）。
 *      新ファイルに無い既存 starred エントリも残す。
 *   D) typingCandidates: scope=all/starred/review の絞り込み（hanzi 空除外・訳モードは別途）。
 */
const fs = require('fs');
const path = require('path');
const Typing = require('../js/typing.js'); // normalize は実コードを使う
const SRS = require('../js/srs.js');
const ListenBuild = require('../js/listen-build.js');

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
  else { fail++; console.log(`  NG  ${name}${extra != null ? '  ' + extra : ''}`); }
}

// ---- app.js と等価な純ロジック ----
function mergeVocabPreserveStar(oldVocab, newMap) {
  if (!oldVocab) return newMap;
  const merged = {};
  for (const k of Object.keys(newMap)) {
    const wasStar = !!(oldVocab[k] && oldVocab[k].starred);
    merged[k] = wasStar ? Object.assign({}, newMap[k], { starred: true }) : newMap[k];
  }
  for (const k of Object.keys(oldVocab)) {
    if (merged[k]) continue;
    if (oldVocab[k] && oldVocab[k].starred) {
      merged[k] = { hanzi: '', pinyin: '', gloss: '', low_confidence: false, starred: true };
    }
  }
  return merged;
}

// typingCandidates 相当。playlist の代わりに collectWords + vocab から w を作る。
function typingCandidates(book, srs, scope, today) {
  const words = ListenBuild.collectWords(book.book);
  const dueSet = (scope === 'review') ? new Set(SRS.dueKeys(srs, today)) : null;
  const out = [];
  for (const w of words) {
    const t = book.vocab ? book.vocab[`${w.page}/${w.seg.index}`] : null;
    const hanzi = t && t.hanzi ? String(t.hanzi).trim() : '';
    if (!hanzi) continue;
    const starred = !!(t && t.starred);
    if (scope === 'starred' && !starred) continue;
    if (scope === 'review' && !dueSet.has(`${w.page}/${w.seg.index}`)) continue;
    out.push({ page: w.page, segIndex: w.seg.index, hanzi, starred, gloss: t.gloss || '' });
  }
  return out;
}

function main() {
  console.log('=== タイピング学習 検証 ===\n');

  // ===== A) normalize =====
  console.log('A) 回答の正規化（normalize）');
  check('前後空白を除去', Typing.normalize('  你好 ') === '你好');
  check('内部の半角空白を除去', Typing.normalize('你 好') === '你好');
  check('全角スペースを除去', Typing.normalize('你　好') === '你好');
  check('全角英数→半角', Typing.normalize('ＡＢＣ１２３') === 'ABC123');
  check('簡体字はそのまま', Typing.normalize('喜欢') === '喜欢');
  check('空文字・null 安全', Typing.normalize('') === '' && Typing.normalize(null) === '' && Typing.normalize(undefined) === '');

  // ===== B) 判定 =====
  console.log('\nB) 判定（正規化して完全一致）');
  const eq = (a, b) => Typing.normalize(a) === Typing.normalize(b);
  check('空白違いでも正解扱い', eq(' 你 好 ', '你好'));
  check('全角スペース混じりでも正解', eq('你　好', '你好'));
  check('別の漢字は不正解', eq('你好', '再见') === false);
  check('部分一致は不正解', eq('你', '你好') === false);

  // ===== C) mergeVocabPreserveStar =====
  console.log('\nC) 再読み込み時の starred 引き継ぎ');
  const oldV = {
    '001/0': { hanzi: '旧漢字', pinyin: 'jiù', gloss: '旧訳', low_confidence: true, starred: true },
    '001/1': { hanzi: 'ノースター', pinyin: '', gloss: '', low_confidence: false }, // starred なし
    '099/9': { hanzi: '', pinyin: '', gloss: '', low_confidence: false, starred: true }, // スターのみ・新ファイルに無い
  };
  const newMap = {
    '001/0': { hanzi: '新漢字', pinyin: 'xīn', gloss: '新訳', low_confidence: false }, // テキストは新優先
    '001/1': { hanzi: '新ノースター', pinyin: 'n', gloss: '', low_confidence: false },
    '002/0': { hanzi: '追加', pinyin: 'a', gloss: '', low_confidence: false }, // 新規
  };
  const oldSnapshot = JSON.stringify(oldV);
  const merged = mergeVocabPreserveStar(oldV, newMap);
  check('テキストは新ファイル優先', merged['001/0'].hanzi === '新漢字' && merged['001/0'].pinyin === 'xīn');
  check('starred は引き継がれる', merged['001/0'].starred === true);
  check('low_confidence は新ファイル値', merged['001/0'].low_confidence === false);
  check('元 starred 無しのキーは starred 付かない', !merged['001/1'].starred);
  check('新規キーはそのまま', merged['002/0'].hanzi === '追加');
  check('新ファイルに無い既存 starred は残る', merged['099/9'] && merged['099/9'].starred === true);
  check('残した starred エントリのテキストは空', merged['099/9'].hanzi === '');
  check('元 vocab を変更しない（イミュータブル）', JSON.stringify(oldV) === oldSnapshot);
  check('oldVocab 無しなら newMap をそのまま返す', mergeVocabPreserveStar(null, newMap) === newMap);

  // ===== D) typingCandidates（実データ）=====
  console.log('\nD) 出題候補の絞り込み（実データ）');
  if (!fs.existsSync(VOCAB)) {
    console.log('  [SKIP] data/vocab.json が無いため実データ検証はスキップ');
  } else {
    const seg = JSON.parse(fs.readFileSync(SEG, 'utf8'));
    const rawVocab = JSON.parse(fs.readFileSync(VOCAB, 'utf8'));
    const vocab = {};
    for (const it of rawVocab) {
      if (!it || it.page == null || it.index == null) continue;
      vocab[`${String(it.page)}/${Number(it.index)}`] = {
        hanzi: it.hanzi != null ? String(it.hanzi) : '',
        pinyin: it.pinyin != null ? String(it.pinyin) : '',
        gloss: it.gloss != null ? String(it.gloss) : '',
        low_confidence: !!it.low_confidence,
      };
    }
    const book = { name: 'HSK3', book: { book: seg.book, pages: seg.pages }, vocab };
    const today = '2026-08-12';

    // all: hanzi が空でない単語だけ
    const all = typingCandidates(book, {}, 'all', today);
    check('all: 1件以上（hanzi あり）', all.length > 0, `n=${all.length}`);
    check('all: 全て hanzi 非空', all.every((w) => w.hanzi && w.hanzi.length > 0));

    // starred: 2件スターを付けて対象を確認
    const bookStar = Object.assign({}, book, {
      vocab: Object.assign({}, vocab, {
        '001/0': Object.assign({}, vocab['001/0'], { starred: true }),
        '002/1': Object.assign({}, vocab['002/1'], { starred: true }),
      }),
    });
    const starred = typingCandidates(bookStar, {}, 'starred', today);
    // hanzi が空のスターは除外されるので <=2
    check('starred: スターのみ（<=2、hanzi 空は除外）', starred.length <= 2 && starred.every((w) => w.starred));
    check('starred は all の部分集合', starred.every((w) => all.some((a) => a.page === w.page && a.segIndex === w.segIndex)));

    // review: SRS 復習キューの今日分だけ。002/0 と 003/0 を期限到来にする。
    const srs = {
      '002/0': { level: 0, nextDue: '2026-08-10', wrongCount: 1, lastReviewed: '2026-08-09' }, // 期限到来
      '003/0': { level: 1, nextDue: today,        wrongCount: 1, lastReviewed: '2026-08-11' }, // 今日
      '004/0': { level: 2, nextDue: '2026-09-01', wrongCount: 1, lastReviewed: '2026-08-05' }, // まだ
    };
    const review = typingCandidates(book, srs, 'review', today);
    const reviewKeys = review.map((w) => `${w.page}/${w.segIndex}`);
    // hanzi が空でないキーだけが残る。002/0・003/0 のうち hanzi ありのものが対象、004/0 は期限未到来で除外。
    check('review: 004/0（期限未到来）は含まれない', !reviewKeys.includes('004/0'));
    check('review: 全て hanzi 非空', review.every((w) => w.hanzi));
    const dueWithHanzi = ['002/0', '003/0'].filter((k) => vocab[k] && vocab[k].hanzi);
    check('review: 期限到来かつ hanzi ありのみ', reviewKeys.slice().sort().join(',') === dueWithHanzi.slice().sort().join(','),
      `got=[${reviewKeys}] exp=[${dueWithHanzi}]`);
  }

  console.log(`\n=> ${fail === 0 ? '全チェック PASS' : `${fail}件 NG`}  (PASS ${pass} / NG ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
