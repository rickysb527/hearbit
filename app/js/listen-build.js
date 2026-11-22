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
 *   セグメント内を無音(0.4秒以上)で「発話ブロック」に分割し、先頭2ブロック（単語+訳）を取る。
 *   - まず冒頭の無音余白をスキップする。各ページの1単語目セグメントは start=0.00 で
 *     冒頭に無音余白（実測 約0.45秒）があり、これを1ブロック目と誤カウントすると
 *     「(余白)+単語」で切れて訳が落ちる（実機バグ）。よって start<=seg開始+EDGE_EPS の
 *     無音（＝冒頭余白）は「発話の開始点」まで start を進め、内部境界から除外する。
 *   - 内部境界 = 冒頭余白スキップ後の start より後で、かつ end-EDGE_EPS より前の無音中点（昇順）。
 *     セグメント末尾の無音（=単語境界）は EDGE_EPS 余白で除外（さもないと訳の直後で切れない）。
 *   - ブロック = 発話区間。無音は区切りとしてのみ扱い、ブロックに数えない。
 *   - 境界が2個以上 → 先頭2ブロック（単語+訳）= start 〜 inner[1]。
 *   - 2個未満（例: word_only は 単語→訳 の1境界のみ）→ start 〜 end（残り全ブロックを含める）。
 *     inner[last] で切ると最後のブロック（＝訳）が落ちるため end まで含める。
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
    const [rawStart, end] = wordPlayRange(seg);
    // 冒頭の無音余白をスキップ：seg開始付近(=start+EDGE_EPS以内)から始まる無音は
    // 「発話前の余白」なので、その終端（＝最初の発話の開始点）まで start を進める。
    // 複数連続することは通常ないが、念のため最も後ろの余白終端を採用する。
    let start = rawStart;
    silences.forEach((s) => {
      if (s.start <= rawStart + EDGE_EPS && s.end > start && s.end < end - EDGE_EPS) {
        start = round3(s.end);
      }
    });
    // 内部境界 = 発話開始後 〜 末尾余白手前 の無音中点（＝発話ブロックの区切り）。
    const inner = silences
      .map((s) => round3((s.start + s.end) / 2))
      .filter((mid) => start < mid && mid < (end - EDGE_EPS))
      .sort((a, b) => a - b);
    // N 境界 → N+1 ブロック。先頭 WORDONLY_BLOCKS ブロックには境界が WORDONLY_BLOCKS 個必要。
    if (inner.length >= WORDONLY_BLOCKS) return [start, inner[WORDONLY_BLOCKS - 1]];
    // 境界不足 → 残り全ブロックを含め end まで（最後のブロック＝訳を落とさない）。
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

  /* 連結済みモノラル PCM(Float32) → WAV(16bit PCM モノラル) の ArrayBuffer。
   * 聞き流しは <audio> 要素で鳴らす（iOS でバックグラウンド/ロック中も止まらない「メディア再生」扱い）
   * ため、連結1本をファイルにする。音声(話し声)なので 44.1/48kHz は 1/2 に間引いて容量を半分に
   * （隣り合う2サンプルの平均 = 簡易ローパス）。100語(約5分)で約14MB。
   * 戻り値: { wav: ArrayBuffer, sampleRate: 出力レート } */
  function encodeWav(samples, srcRate) {
    const factor = Math.max(1, Math.floor(srcRate / 22050));
    const rate = Math.round(srcRate / factor);
    const n = Math.floor(samples.length / factor);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0, o = 44; i < n; i++, o += 2) {
      let x = 0;
      for (let k = 0; k < factor; k++) x += samples[i * factor + k];
      x /= factor;
      x = x < -1 ? -1 : (x > 1 ? 1 : x);
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return { wav: buf, sampleRate: rate };
  }

  const api = {
    GAP_SEC, EDGE_EPS, WORDONLY_BLOCKS,
    wordPlayRange, wordonlyRange, collectWords, chunkRange, numChunks, encodeWav,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ListenBuild = api;
})(typeof self !== 'undefined' ? self : this);
