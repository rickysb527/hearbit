/* 分割の手動編集（残タスク #4）の純ロジック。
 *
 * ここでは「分割ロジック（splitter.js）のアルゴリズム自体」は一切変えない。
 * ユーザーが手で決めた境界(cut点)・type・announce_end から、segments.json と
 * 同一形式の segments を組み立て直す（結果の手動上書き）だけ。
 *
 * ブラウザ(app.js の編集UI)と Node検証(verify_editor.js)で同一ロジックを共有するため分離する。
 *
 * ============================================================================
 * データモデル（1ページの編集状態）
 * ----------------------------------------------------------------------------
 *   bounds:  [0, cut1, cut2, ..., duration]  昇順。隣り合う2点が1セグメント。
 *            先頭は必ず 0、末尾は必ず duration。内部の点(bounds[1..n-2])が「単語境界」。
 *   types:   セグメントごとの 'word' | 'word+announce'（bounds.length-1 個）。
 *   announceEnds: セグメントごとの announce_end（word+announce のときだけ意味を持つ）。
 *            null なら未設定（type=word+announce でも announce_end 無しは許容）。
 *
 * pageToState(page) : 保存済み page → 編集状態（bounds/types/announceEnds）
 * stateToPage(page, state) : 編集状態 → 新しい page（segments 再構築 + manualEdited:true）
 *
 * 付随フィールドの整合:
 *   - length は end-start を都度再計算（round2）。
 *   - announce_end は type=word+announce かつ start<announce_end<end のときだけ付与。
 *     announce_low_confidence は「自動判定の低信頼」を示す実聴用フラグなので、手動編集後は
 *     ユーザーが確定した扱いとみなして落とす（手で直したものは low_confidence にしない）。
 *   - merged は自動分割（短小結合）の由来を示すだけの情報。手動で境界を作り直したら
 *     由来が変わるため落とす（再生・聞き流しは merged を参照しない）。
 *   - has_announce / word_count / layout は再計算する（layout は splitter と同じ中央値ルール）。
 */
(function (root) {
  const round2 = (x) => Math.round(x * 100) / 100;
  const round3 = (x) => Math.round(x * 1000) / 1000;

  function median(arr) {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /* 保存済み page → 編集状態 */
  function pageToState(page) {
    const segs = page.segments || [];
    const bounds = [];
    if (segs.length) {
      bounds.push(round3(segs[0].start));
      for (const s of segs) bounds.push(round3(s.end));
    } else {
      bounds.push(0, round3(page.duration || 0));
    }
    const types = segs.map((s) => (s.type === 'word+announce' ? 'word+announce' : 'word'));
    const announceEnds = segs.map((s) => (s.announce_end != null ? round3(s.announce_end) : null));
    // duration は最後の境界(=末尾セグメントの end)を真実とする。page.duration は round2 で
    // 保存されており、末尾 end(round3) と食い違うと無編集の往復で末尾境界がズレるため。
    return {
      duration: bounds[bounds.length - 1],
      bounds, types, announceEnds,
    };
  }

  /* 編集状態を正規化: bounds を昇順ソート・端を固定・重複/範囲外を除去。
   * types/announceEnds は「セグメント数（bounds.length-1）」に合わせて調整する。
   * bounds 変更（追加/削除/微調整）後は必ずこれを通す。 */
  function normalizeState(state) {
    const dur = round3(state.duration);
    let bs = state.bounds.map(round3).filter((b) => b > 0 && b < dur); // 内部点のみ
    bs = [...new Set(bs)].sort((a, b) => a - b);
    const bounds = [0, ...bs, dur];
    const segCount = bounds.length - 1;
    // types/announceEnds を新しいセグメント数へ合わせる（先頭側の対応を保つ）。
    const types = [];
    const announceEnds = [];
    for (let i = 0; i < segCount; i++) {
      types.push(state.types[i] === 'word+announce' ? 'word+announce' : 'word');
      const ae = state.announceEnds[i];
      // announce_end はそのセグメント範囲内にあるときだけ引き継ぐ
      announceEnds.push((ae != null && ae > bounds[i] && ae < bounds[i + 1]) ? round3(ae) : null);
    }
    return { duration: dur, bounds, types, announceEnds };
  }

  /* 編集状態 → 新しい page（segments 再構築）。manualEdited:true を立てる。 */
  function stateToPage(page, rawState) {
    const state = normalizeState(rawState);
    const { bounds, types, announceEnds, duration } = state;
    const segLengths = [];
    for (let i = 0; i < bounds.length - 1; i++) segLengths.push(round2(bounds[i + 1] - bounds[i]));

    const segments = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const seg = {
        index: i,
        start: round3(bounds[i]),
        end: round3(bounds[i + 1]),
        length: segLengths[i],
        type: types[i],
      };
      if (types[i] === 'word+announce' && announceEnds[i] != null) {
        seg.announce_end = round3(announceEnds[i]);
      }
      segments.push(seg);
    }

    // layout は splitter.js と同一ルール（本体中央値 < 9 → word_only）
    const body = segLengths.length > 1 ? segLengths.slice(1) : segLengths;
    const med = median(body);
    const layout = med < 9 ? 'word_only' : 'word_with_examples';
    const wordCount = types.filter((t) => t === 'word' || t === 'word+announce').length;

    return {
      page: page.page,
      duration: round2(duration),
      num_segments: segments.length,
      layout,
      word_count: wordCount,
      has_announce: types.some((t) => t === 'word+announce'),
      manualEdited: true,
      segments,
    };
  }

  /* 境界を1つ追加（時刻 t を内部点として挿入）。追加位置のセグメントを2分割する形。
   * t は 0<t<duration の内部でなければ無視。既存点と近すぎ（<0.02s）なら無視。 */
  function addBoundary(state, t) {
    const s = normalizeState(state);
    t = round3(t);
    if (!(t > 0 && t < s.duration)) return s;
    if (s.bounds.some((b) => Math.abs(b - t) < 0.02)) return s;
    // 挿入先セグメント index を求める
    let segIdx = 0;
    for (let i = 0; i < s.bounds.length - 1; i++) {
      if (t > s.bounds[i] && t < s.bounds[i + 1]) { segIdx = i; break; }
    }
    const bounds = [...s.bounds, t].sort((a, b) => a - b);
    // 分割された2セグメントの type は元セグメントを継ぐ（前半=元、後半=word）。
    const types = [...s.types];
    const announceEnds = [...s.announceEnds];
    types.splice(segIdx + 1, 0, 'word');       // 後半は word
    announceEnds.splice(segIdx + 1, 0, null);
    return normalizeState({ duration: s.duration, bounds, types, announceEnds });
  }

  /* 内部境界（index は bounds のインデックス, 1..n-2）を削除。前後セグメントを結合。 */
  function removeBoundary(state, boundIndex) {
    const s = normalizeState(state);
    if (boundIndex <= 0 || boundIndex >= s.bounds.length - 1) return s; // 端は消せない
    const bounds = s.bounds.filter((_, i) => i !== boundIndex);
    // 消した境界の「後ろ」セグメント(index=boundIndex)が前へ吸収される。
    const types = s.types.filter((_, i) => i !== boundIndex);
    const announceEnds = s.announceEnds.filter((_, i) => i !== boundIndex);
    return normalizeState({ duration: s.duration, bounds, types, announceEnds });
  }

  /* 内部境界を delta 秒だけ動かす（±0.1 等）。隣接点を越えない範囲にクランプ。 */
  function nudgeBoundary(state, boundIndex, delta) {
    const s = normalizeState(state);
    if (boundIndex <= 0 || boundIndex >= s.bounds.length - 1) return s;
    const lo = s.bounds[boundIndex - 1] + 0.05;
    const hi = s.bounds[boundIndex + 1] - 0.05;
    let t = round3(s.bounds[boundIndex] + delta);
    t = Math.min(Math.max(t, lo), hi);
    const bounds = [...s.bounds];
    bounds[boundIndex] = t;
    return normalizeState({ duration: s.duration, bounds, types: s.types, announceEnds: s.announceEnds });
  }

  /* announce_end を delta 秒動かす（そのセグメント範囲内でクランプ）。null は seg中央から開始。 */
  function nudgeAnnounceEnd(state, segIndex, delta) {
    const s = normalizeState(state);
    if (segIndex < 0 || segIndex >= s.types.length) return s;
    const lo = s.bounds[segIndex] + 0.05;
    const hi = s.bounds[segIndex + 1] - 0.05;
    const cur = s.announceEnds[segIndex] != null
      ? s.announceEnds[segIndex]
      : (s.bounds[segIndex] + s.bounds[segIndex + 1]) / 2; // 未設定なら中央を起点
    let t = round3(cur + delta);
    t = Math.min(Math.max(t, lo), hi);
    const announceEnds = [...s.announceEnds];
    announceEnds[segIndex] = t;
    return normalizeState({ duration: s.duration, bounds: s.bounds, types: s.types, announceEnds });
  }

  /* セグメントの type を設定。word→word+announce にしたら announce_end を初期化（seg頭寄り）。 */
  function setType(state, segIndex, type) {
    const s = normalizeState(state);
    if (segIndex < 0 || segIndex >= s.types.length) return s;
    const types = [...s.types];
    const announceEnds = [...s.announceEnds];
    types[segIndex] = (type === 'word+announce') ? 'word+announce' : 'word';
    if (types[segIndex] === 'word') {
      announceEnds[segIndex] = null;
    } else if (announceEnds[segIndex] == null) {
      // アナウンス開始位置の初期値: セグメント先頭から2秒後（範囲内にクランプ）。
      const lo = s.bounds[segIndex], hi = s.bounds[segIndex + 1];
      announceEnds[segIndex] = round3(Math.min(lo + 2.0, (lo + hi) / 2));
    }
    return normalizeState({ duration: s.duration, bounds: s.bounds, types, announceEnds });
  }

  const api = {
    median,
    pageToState, normalizeState, stateToPage,
    addBoundary, removeBoundary, nudgeBoundary, nudgeAnnounceEnd, setType,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SplitEditor = api;
})(typeof self !== 'undefined' ? self : this);
