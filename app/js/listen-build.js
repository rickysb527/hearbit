/* 機能B（聞き流し）の「単語+訳」抽出ロジック（純関数）。
 * build_chunks.py の word_play_range / wordonly_range / collect_words を JS へ移植。
 * ブラウザ(listen.js)と Node検証(verify_listen.js)で同一ロジックを共有するため分離する。
 *
 * ============================================================================
 * build_chunks.py との対応（wordonly 版を採用。full 版は今回不要）
 * ----------------------------------------------------------------------------
 * word_play_range(seg):
 *   単語本体の再生範囲。type=word+announce は announce_end 以降が単語なので
 *   start = announce_end（無ければ seg.start）、end = seg.end。
 *
 * wordonly_range(seg, silences):
 *   セグメント内を無音(0.4秒以上)でブロック分割し、先頭2ブロック（単語+訳）を取る。
 *   - 内部境界 = start+EDGE_EPS < 無音中点 < end-EDGE_EPS を満たす無音の中点（昇順）。
 *     セグメント端の無音（=単語境界）は EDGE_EPS 余白で除外（さもないと「単語」だけで切れる）。
 *   - 境界が2個以上 → 先頭2ブロック = start 〜 inner[1]。
 *   - 1個 → start 〜 inner[0]。
 *   - 0個（例文なしの短い語など）→ セグメント全体（= word_play_range）。
 *
 * 無音検知は Splitter.detectSilences（noise=-30dB, min_silence=0.4s）を流用する。
 * build_chunks.py の silencedetect(noise=-30dB:d=0.4) と同一パラメータ。
 */
(function (root) {
  const GAP_SEC = 0.3;         // 単語間ギャップ（build_chunks.py と同じ）
  const EDGE_EPS = 0.15;       // セグメント端の無音を内部境界から除外する余白（秒）
  const WORDONLY_BLOCKS = 2;   // 「単語+訳」= 先頭ブロック数

  const round3 = (x) => Math.round(x * 1000) / 1000;

  /* 単語本体の再生範囲 [start, end]。announce は announce_end 以降。 */
  function wordPlayRange(seg) {
    const start = (seg.announce_end != null) ? seg.announce_end : seg.start;
    return [round3(start), round3(seg.end)];
  }

  /* セグメント内 無音ブロック分割 → 先頭2ブロック（単語+訳）の範囲 [start, end]。
   * silences: そのページ全体の無音区間 [{start,end,dur}]（絶対秒）。
   */
  function wordonlyRange(seg, silences) {
    const [start, end] = wordPlayRange(seg);
    const inner = silences
      .map((s) => round3((s.start + s.end) / 2))
      .filter((mid) => (start + EDGE_EPS) < mid && mid < (end - EDGE_EPS))
      .sort((a, b) => a - b);
    if (inner.length >= WORDONLY_BLOCKS) return [start, inner[WORDONLY_BLOCKS - 1]];
    if (inner.length) return [start, inner[inner.length - 1]];
    return [start, end];
  }

  /* book(segments.json の1冊) から順序どおりの単語リストを作る。
   *
   * ブラウザでは元音声139MBを一度に decode したくないため、wordonly の範囲確定は
   * トラック構築時（そのページを decode したタイミング）に遅延させる。ここでは
   * セグメント参照だけを保持し、wordonly は resolveWordonly で後から埋める。
   *
   * silencesByPage を渡した場合（Node検証など）は即座に wordonly を確定する。
   * 各要素: { page, pageNo, wordNo, serial, seg, wordonly:[s,e]|null }。
   */
  function collectWords(book, silencesByPage) {
    const words = [];
    let serial = 0;
    book.pages.forEach((page, pageIdx) => {
      const sils = silencesByPage ? (silencesByPage[page.page] || []) : null;
      let wordNo = 0;
      page.segments.forEach((seg) => {
        if (seg.type !== 'word' && seg.type !== 'word+announce') return;
        wordNo += 1; serial += 1;
        words.push({
          page: page.page,
          pageNo: pageIdx + 1,
          wordNo, serial,
          seg,
          wordonly: sils ? wordonlyRange(seg, sils) : null,
        });
      });
    });
    return words;
  }

  /* 範囲(1-based, 両端含む)とチャンクサイズから、トラックの [from,to)（0-based 半開）を返す。
   * 例: chunkRange(total=650, size=50, chunkIndex=0) => [0,50]。
   */
  function chunkRange(total, size, chunkIndex) {
    const from = chunkIndex * size;
    const to = Math.min(from + size, total);
    return [from, to];
  }
  function numChunks(total, size) { return Math.ceil(total / size); }

  const api = {
    GAP_SEC, EDGE_EPS, WORDONLY_BLOCKS,
    wordPlayRange, wordonlyRange, collectWords, chunkRange, numChunks,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ListenBuild = api;
})(typeof self !== 'undefined' ? self : this);
