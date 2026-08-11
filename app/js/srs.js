/* 忘却曲線復習（SRS）の純ロジック。
 *
 * ここは「日付」を必ず引数で受け取る純関数の集まりにする（DOM・IndexedDB・Date.now に依存しない）。
 * これにより Node で決定的にテストでき、タイピング側（typing.js）と検証（verify_srs.js）で
 * 同一ロジックを共有できる。
 *
 * ============================================================================
 * データモデル（book.srs）
 * ----------------------------------------------------------------------------
 *   book.srs = { "page/index": { level, nextDue, wrongCount, lastReviewed } }
 *     - vocab と同様、page+index をキーにした辞書。元音声から再計算される派生 pages とは独立。
 *     - level     : 間隔テーブル INTERVALS のインデックス（0..5）。
 *     - nextDue   : "YYYY-MM-DD"（端末ローカル日付）。日単位で判定・時刻は見ない。
 *     - wrongCount: これまで間違えた累計回数（統計・並び替え用）。
 *     - lastReviewed: 最後に出題（正誤確定）した日付 "YYYY-MM-DD"。
 *
 * ルール（仕様）:
 *   - INTERVALS = [1, 3, 7, 14, 30, 60] 日。
 *   - 不正解 → level=0, nextDue=翌日, wrongCount+1 でキュー入り（既存でも level=0 に戻す）。
 *   - 正解:
 *       ・キューに居ない単語は SRS に触れない（early 正解でキューを増やさない）。
 *       ・キューに居て「復習モード」または「期限到来（nextDue <= today）」なら昇級:
 *           level+1, nextDue = today + INTERVALS[新level]。level 5 で正解したら卒業（エントリ削除）。
 *       ・期限が来ていない単語を通常セッションで正解しても level は動かさない（早回し防止）。
 *   - 「実は正解」は正解と同じ扱い（typing.js 側で正解扱いに変換して applyResult を呼ぶ）。
 */
(function (root) {
  const INTERVALS = [1, 3, 7, 14, 30, 60]; // 日。level はこの配列のインデックス。
  const MAX_LEVEL = INTERVALS.length - 1;   // 5。ここで正解すると卒業。

  /* Date → "YYYY-MM-DD"（端末ローカル日付）。UTC ではなくローカル年月日で日境界を判定する。 */
  function toDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /* "YYYY-MM-DD" に days 日を足して "YYYY-MM-DD" を返す（純関数・ローカル日付演算）。 */
  function addDays(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d); // ローカル日付。時刻は 00:00。
    dt.setDate(dt.getDate() + days);
    return toDateStr(dt);
  }

  /* a <= b（日付文字列の比較）。"YYYY-MM-DD" は辞書順 = 日付順なので文字列比較でよい。 */
  function isOnOrBefore(a, b) { return a <= b; }

  /* エントリが「期限到来（今日以前が nextDue）」か。エントリ無しは false。 */
  function isDue(entry, today) {
    return !!(entry && entry.nextDue && isOnOrBefore(entry.nextDue, today));
  }

  /* 今日の復習キュー（page/index の配列）。nextDue <= today のエントリを集める。
   * order: 元音声の並び順に合わせたい場合、keyOrder（["page/index", ...]）を渡すとその順で返す。
   * 渡さなければ srs のキー列挙順（挿入順に準ずる）。 */
  function dueKeys(srs, today, keyOrder) {
    if (!srs) return [];
    const keys = keyOrder && keyOrder.length ? keyOrder : Object.keys(srs);
    const out = [];
    for (const k of keys) {
      if (isDue(srs[k], today)) out.push(k);
    }
    return out;
  }

  /* 期限到来（today 以前）の件数。単語帳一覧/単語帳内のバッジ用。 */
  function dueCount(srs, today) {
    if (!srs) return 0;
    let n = 0;
    for (const k of Object.keys(srs)) {
      if (isDue(srs[k], today)) n++;
    }
    return n;
  }

  /* 正誤1件を srs へ反映した「新しい srs 辞書」を返す（元は変更しない＝イミュータブル）。
   *   srs      : 現在の book.srs（無ければ null/undefined でよい）
   *   key      : "page/index"
   *   correct  : true=正解 / false=不正解（「実は正解」は correct=true で呼ぶ）
   *   today    : "YYYY-MM-DD"（呼び出し側で toDateStr(new Date()) を渡す）
   *   isReview : このセッションが「復習キュー」範囲か（true なら期限未到来でも昇級させる）
   *
   * 戻り値: 新しい srs 辞書（該当キーだけ差し替え・削除。他キーは不変）。
   */
  function applyResult(srs, key, correct, today, isReview) {
    const next = Object.assign({}, srs || {});
    const cur = next[key] || null;

    if (!correct) {
      // 不正解: level=0・翌日・wrongCount+1 でキュー入り（既存でも level を 0 に戻す）。
      const wrongCount = (cur && cur.wrongCount ? cur.wrongCount : 0) + 1;
      next[key] = {
        level: 0,
        nextDue: addDays(today, 1),
        wrongCount,
        lastReviewed: today,
      };
      return next;
    }

    // ここから正解。キューに居ない単語は SRS に触れない（early 正解でキューを増やさない）。
    if (!cur) return next;

    // 昇級条件: 復習モード or 期限到来。どちらでもなければ level は動かさない（早回し防止）。
    const canPromote = isReview || isDue(cur, today);
    if (!canPromote) {
      // 触るのは lastReviewed だけ（統計目的）。level/nextDue は保持。
      next[key] = Object.assign({}, cur, { lastReviewed: today });
      return next;
    }

    if (cur.level >= MAX_LEVEL) {
      // 最上位で正解 → 卒業（エントリ削除）。
      delete next[key];
      return next;
    }

    const newLevel = cur.level + 1;
    next[key] = {
      level: newLevel,
      nextDue: addDays(today, INTERVALS[newLevel]),
      wrongCount: cur.wrongCount || 0,
      lastReviewed: today,
    };
    return next;
  }

  /* あるキーを「以前の状態」へ復元した新しい srs 辞書を返す（イミュータブル）。
   *   prevEntry が null/undefined → そのキーを削除（＝以前はキューに無かった状態へ戻す）。
   *   prevEntry がオブジェクト     → そのキーを prevEntry にそっくり戻す（level/nextDue 等を復元）。
   *
   * 用途:「実は正解」（ASR誤りの訂正）。ユーザーの誤答ではないので、直前の
   * applyResult(false) でキュー入り/リセットした結果を取り消し、回答前の状態へ戻す。
   * （元々キューに無ければ削除、元々あれば元の level/nextDue に復元。）
   */
  function restore(srs, key, prevEntry) {
    const next = Object.assign({}, srs || {});
    if (prevEntry == null) delete next[key];
    else next[key] = Object.assign({}, prevEntry);
    return next;
  }

  const api = {
    INTERVALS, MAX_LEVEL,
    toDateStr, addDays, isOnOrBefore,
    isDue, dueKeys, dueCount, applyResult, restore,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SRS = api;
})(typeof self !== 'undefined' ? self : this);
