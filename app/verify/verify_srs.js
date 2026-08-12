#!/usr/bin/env node
/* 忘却曲線復習（SRS）の純ロジック検証。
 *
 * srs.js は日付を引数で受け取る純関数群なので、Node で決定的にテストできる。
 * 仕様（app/ の spec）で決めたルールを1つずつ確認する:
 *
 *   1) 日付ユーティリティ: toDateStr / addDays / isOnOrBefore がローカル日付で正しく動く。
 *   2) 不正解 → level=0, nextDue=翌日, wrongCount+1 でキュー入り（既存でも level=0 に戻す）。
 *   3) 正解・キュー外 → SRS に触れない（early 正解でキューを増やさない）。
 *   4) 正解・キュー内・期限到来 → 昇級（level+1, nextDue=今日+間隔[新level]）。
 *   5) 正解・キュー内・期限未到来・通常セッション → level 据え置き（早回し防止）。
 *   6) 正解・キュー内・期限未到来・復習セッション → 昇級する。
 *   7) level=5 で正解 → 卒業（エントリ削除）。
 *   8) applyResult はイミュータブル（元 srs を変更しない）。他キーは不変。
 *   9) dueKeys / dueCount が期限到来（nextDue <= today）を正しく集計。keyOrder で順序指定できる。
 *  10) 間隔テーブルは [1,3,7,14,30,60]。level→nextDue が仕様どおり。
 */
const SRS = require('../js/srs.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra != null ? '  ' + extra : ''}`); }
}

function main() {
  console.log('=== 忘却曲線復習（SRS）検証 ===\n');
  const T = '2026-08-12'; // 「今日」の基準

  // ===== 1) 日付ユーティリティ =====
  console.log('1) 日付ユーティリティ');
  check('toDateStr(ローカル日付)', SRS.toDateStr(new Date(2026, 7, 12)) === '2026-08-12');
  check('addDays(+1) 翌日', SRS.addDays(T, 1) === '2026-08-13');
  check('addDays(+3)', SRS.addDays(T, 3) === '2026-08-15');
  check('addDays 月跨ぎ', SRS.addDays('2026-08-31', 1) === '2026-09-01');
  check('addDays 年跨ぎ', SRS.addDays('2026-12-31', 1) === '2027-01-01');
  check('addDays うるう年 2/28→2/29', SRS.addDays('2028-02-28', 1) === '2028-02-29');
  check('isOnOrBefore 同日=true', SRS.isOnOrBefore(T, T) === true);
  check('isOnOrBefore 過去<=今日=true', SRS.isOnOrBefore('2026-08-11', T) === true);
  check('isOnOrBefore 未来<=今日=false', SRS.isOnOrBefore('2026-08-13', T) === false);

  // ===== 2) 不正解でキュー入り =====
  console.log('\n2) 不正解でキュー入り');
  let srs = SRS.applyResult({}, 'p1/0', false, T, false);
  check('不正解: level=0', srs['p1/0'].level === 0);
  check('不正解: nextDue=翌日', srs['p1/0'].nextDue === '2026-08-13', srs['p1/0'].nextDue);
  check('不正解: wrongCount=1', srs['p1/0'].wrongCount === 1);
  check('不正解: lastReviewed=今日', srs['p1/0'].lastReviewed === T);
  // 既に level>0 の単語を不正解 → level=0 に戻し wrongCount++
  const seeded = { 'p1/0': { level: 3, nextDue: '2026-09-01', wrongCount: 2, lastReviewed: '2026-08-01' } };
  const reset = SRS.applyResult(seeded, 'p1/0', false, T, false);
  check('既存を不正解: level=0 に戻る', reset['p1/0'].level === 0);
  check('既存を不正解: wrongCount+1', reset['p1/0'].wrongCount === 3);
  check('既存を不正解: nextDue=翌日', reset['p1/0'].nextDue === '2026-08-13');

  // ===== 3) 正解・キュー外 → 触れない =====
  console.log('\n3) 正解・キュー外は SRS を増やさない');
  const untouched = SRS.applyResult({}, 'pX/9', true, T, false);
  check('キュー外を正解: エントリを作らない', untouched['pX/9'] === undefined);
  check('キュー外を正解: 辞書は空のまま', Object.keys(untouched).length === 0);

  // ===== 4) 正解・キュー内・期限到来 → 昇級 =====
  console.log('\n4) 正解・キュー内・期限到来で昇級');
  // level=0, nextDue=今日（期限到来）
  const due0 = { 'p1/0': { level: 0, nextDue: T, wrongCount: 1, lastReviewed: '2026-08-11' } };
  const up = SRS.applyResult(due0, 'p1/0', true, T, false); // 通常セッションでも期限到来なら昇級
  check('昇級: level 0→1', up['p1/0'].level === 1);
  check('昇級: nextDue=今日+間隔[1]=3日後', up['p1/0'].nextDue === SRS.addDays(T, 3), up['p1/0'].nextDue);
  check('昇級: wrongCount 保持', up['p1/0'].wrongCount === 1);
  check('昇級: lastReviewed=今日', up['p1/0'].lastReviewed === T);

  // ===== 5) 正解・キュー内・期限未到来・通常 → 据え置き =====
  console.log('\n5) 期限未到来を通常セッションで正解しても据え置き（早回し防止）');
  const notDue = { 'p1/0': { level: 2, nextDue: '2026-09-01', wrongCount: 1, lastReviewed: '2026-08-05' } };
  const keep = SRS.applyResult(notDue, 'p1/0', true, T, false);
  check('据え置き: level 変わらない', keep['p1/0'].level === 2);
  check('据え置き: nextDue 変わらない', keep['p1/0'].nextDue === '2026-09-01');
  check('据え置き: lastReviewed だけ更新', keep['p1/0'].lastReviewed === T);

  // ===== 6) 正解・キュー内・期限未到来・復習セッション → 昇級 =====
  console.log('\n6) 復習セッションなら期限未到来でも昇級');
  const rev = SRS.applyResult(notDue, 'p1/0', true, T, true);
  check('復習昇級: level 2→3', rev['p1/0'].level === 3);
  check('復習昇級: nextDue=今日+間隔[3]=14日後', rev['p1/0'].nextDue === SRS.addDays(T, 14), rev['p1/0'].nextDue);

  // ===== 7) level=5 で正解 → 卒業 =====
  console.log('\n7) 最上位で正解すると卒業（削除）');
  const top = { 'p1/0': { level: 5, nextDue: T, wrongCount: 4, lastReviewed: '2026-06-01' } };
  const grad = SRS.applyResult(top, 'p1/0', true, T, false);
  check('卒業: エントリ削除', grad['p1/0'] === undefined);
  check('卒業: 辞書から消える', Object.keys(grad).length === 0);
  // level 4 → 5（間隔[5]=60日）はまだ卒業しない
  const l4 = { 'p1/0': { level: 4, nextDue: T, wrongCount: 1, lastReviewed: T } };
  const l5 = SRS.applyResult(l4, 'p1/0', true, T, false);
  check('level 4→5 は卒業しない', l5['p1/0'] && l5['p1/0'].level === 5);
  check('level 5: nextDue=今日+60日', l5['p1/0'].nextDue === SRS.addDays(T, 60), l5['p1/0'].nextDue);

  // ===== 8) イミュータブル・他キー不変 =====
  console.log('\n8) イミュータブル・他キー不変');
  const orig = {
    'a/0': { level: 1, nextDue: '2026-08-20', wrongCount: 1, lastReviewed: '2026-08-13' },
    'b/1': { level: 3, nextDue: '2026-09-10', wrongCount: 2, lastReviewed: '2026-08-01' },
  };
  const snapshot = JSON.stringify(orig);
  const res = SRS.applyResult(orig, 'a/0', false, T, false);
  check('元の srs を変更しない（イミュータブル）', JSON.stringify(orig) === snapshot);
  check('返り値は新オブジェクト', res !== orig);
  check('無関係キー b/1 は不変', JSON.stringify(res['b/1']) === JSON.stringify(orig['b/1']));

  // ===== 9) dueKeys / dueCount =====
  console.log('\n9) dueKeys / dueCount（期限到来の集計）');
  const mix = {
    'p/0': { level: 0, nextDue: '2026-08-10', wrongCount: 1, lastReviewed: '2026-08-09' }, // 過去=期限到来
    'p/1': { level: 1, nextDue: T,            wrongCount: 1, lastReviewed: '2026-08-11' }, // 今日=期限到来
    'p/2': { level: 2, nextDue: '2026-08-20', wrongCount: 1, lastReviewed: '2026-08-05' }, // 未来=まだ
  };
  check('dueCount = 2（過去+今日）', SRS.dueCount(mix, T) === 2, String(SRS.dueCount(mix, T)));
  const dk = SRS.dueKeys(mix, T);
  check('dueKeys は p/0,p/1 を含む', dk.includes('p/0') && dk.includes('p/1'));
  check('dueKeys は p/2 を含まない', !dk.includes('p/2'));
  // keyOrder で順序を指定できる
  const ordered = SRS.dueKeys(mix, T, ['p/2', 'p/1', 'p/0']);
  check('dueKeys(keyOrder): 指定順で期限到来のみ', JSON.stringify(ordered) === JSON.stringify(['p/1', 'p/0']), JSON.stringify(ordered));
  check('空/undefined でも安全', SRS.dueCount(undefined, T) === 0 && SRS.dueKeys(null, T).length === 0);

  // ===== 9.5) restore（「実は正解」で不正解の結果を取り消す）=====
  console.log('\n9.5) restore（実は正解で回答前へ戻す）');
  // (a) 元々キューに無い単語を誤答 → キュー入り → 実は正解: エントリごと削除される。
  //     typing.js の流れを模す: 回答前に snapshot（無いので null）を取り、false 反映 → restore(null)。
  {
    const before = {}; // このキーは元々キューに無い
    const key = 'q/0';
    const snapshot = before[key] ? Object.assign({}, before[key]) : null; // = null
    const afterWrong = SRS.applyResult(before, key, false, T, false);
    check('（a）誤答でキュー入りする', afterWrong[key] && afterWrong[key].level === 0);
    const undone = SRS.restore(afterWrong, key, snapshot);
    check('（a）実は正解で削除され回答前（キュー外）へ戻る', undone[key] === undefined);
    check('（a）辞書は空に戻る', Object.keys(undone).length === 0);
  }
  // (b) 元々キューに居た単語（level=2, 未来nextDue）を誤答 → level=0 に落ちる → 実は正解:
  //     元の level/nextDue に完全復元される（昇級もしない）。
  {
    const orig = { 'q/1': { level: 2, nextDue: '2026-09-01', wrongCount: 1, lastReviewed: '2026-08-05' } };
    const key = 'q/1';
    const snapshot = Object.assign({}, orig[key]);
    const afterWrong = SRS.applyResult(orig, key, false, T, false);
    check('（b）誤答で level=0 に落ちる', afterWrong[key].level === 0 && afterWrong[key].nextDue === '2026-08-13');
    const undone = SRS.restore(afterWrong, key, snapshot);
    check('（b）実は正解で元の level に復元', undone[key].level === 2);
    check('（b）実は正解で元の nextDue に復元', undone[key].nextDue === '2026-09-01');
    check('（b）実は正解で元の wrongCount/lastReviewed に復元',
      undone[key].wrongCount === 1 && undone[key].lastReviewed === '2026-08-05');
    check('（b）restore はイミュータブル（afterWrong 不変）', afterWrong[key].level === 0);
  }
  // (c) restore は他キーを触らない
  {
    const s = { 'a/0': { level: 1, nextDue: '2026-08-20', wrongCount: 0, lastReviewed: T }, 'b/0': { level: 0, nextDue: '2026-08-13', wrongCount: 1, lastReviewed: T } };
    const r = SRS.restore(s, 'b/0', null);
    check('（c）restore は指定キーだけ削除', r['b/0'] === undefined && JSON.stringify(r['a/0']) === JSON.stringify(s['a/0']));
  }

  // ===== 10) 間隔テーブル 0→5 の連続昇級 =====
  console.log('\n10) 間隔テーブル [1,3,7,14,30,60] 連続昇級');
  const intervals = [3, 7, 14, 30, 60]; // level 0→1..4→5 の各昇級後 nextDue の間隔
  let s = { 'w/0': { level: 0, nextDue: T, wrongCount: 1, lastReviewed: T } };
  let day = T;
  for (let lv = 0; lv < 5; lv++) {
    const before = s['w/0'].level;
    s = SRS.applyResult(s, 'w/0', true, day, true); // 復習で毎回昇級
    check(`level ${before}→${before + 1}`, s['w/0'].level === before + 1);
    check(`level ${before + 1}: nextDue=+${intervals[lv]}日`, s['w/0'].nextDue === SRS.addDays(day, intervals[lv]), s['w/0'].nextDue);
    day = s['w/0'].nextDue; // 次はその期限日に復習した体
  }
  // level 5 で正解 → 卒業
  s = SRS.applyResult(s, 'w/0', true, day, true);
  check('連続昇級後 level5 で卒業', s['w/0'] === undefined);

  console.log(`\n=> ${fail === 0 ? '全チェック PASS' : `${fail}件 NG`}  (PASS ${pass} / NG ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
