/* タイピング学習 UI + セッション管理。
 *
 * 単語帳内（ページ一覧）から「タイピング」で開く全画面。出題→入力→判定→次へ、を
 * 最大20問回して結果を出す。SRS（忘却曲線復習）と連動し、間違えた単語をキューへ入れる。
 *
 * 設計方針:
 *   - この Typing は自前の全画面オーバーレイ（#typing-view）と自前の <audio id="typing-audio"> を持ち、
 *     機能A/B の Player/Listen とは独立に鳴らす（プレイリスト状態を汚さない）。音声モードでは
 *     機能Aと同じ「元音声の effStart〜end を位置指定再生」だけをこの要素で行う。
 *   - DB 書き込み（vocab の「実は正解」修正・srs の更新）は app.js のコールバック経由。
 *     この画面は currentBook を直接触らず、判定ロジック（SRS）は srs.js の純関数に委ねる。
 *   - IME（中国語入力）対応: composition 中に Enter で確定判定しない（isComposing / compositionend）。
 *
 * app.js からの注入（Typing.init）:
 *   {
 *     getCandidates(scope) -> [{ page, segIndex, effStart, end, hanzi, pinyin, gloss, starred }]
 *        scope: 'all' | 'starred' | 'review'。hanzi 空は除外済み。訳モードの gloss 空除外は Typing 側で行う。
 *     getBlobFor(page) -> Promise<Blob>   元ページ音声Blob（機能Aと同じ）
 *     getSrs() -> book.srs（辞書 or undefined）
 *     saveSrs(newSrs) -> Promise         book.srs を差し替え保存
 *     markActuallyCorrect(page, segIndex, hanzi) -> Promise
 *        「実は正解」: vocab[page/index].hanzi を上書き・low_confidence=false で保存
 *     today() -> "YYYY-MM-DD"            端末ローカル日付（SRS 判定用）
 *     onClose() -> void                  画面を閉じたとき（app.js が一覧を最新化）
 *   }
 */
const Typing = (() => {
  const MAX_QUESTIONS = 20;          // 1セッションの上限
  const MODE_KEY = 'hearbit-typing-mode'; // 出題形式（audio/gloss）を localStorage に記憶

  // --- DOM ---
  // Node（検証）でも normalize などの純関数を require できるよう、DOM 参照は遅延取得にする。
  const hasDOM = (typeof document !== 'undefined');
  const view = hasDOM ? document.getElementById('typing-view') : null;
  const audio = hasDOM ? document.getElementById('typing-audio') : null;

  // 範囲選択（開始画面）
  const setupEl = () => document.getElementById('typing-setup');
  const quizEl = () => document.getElementById('typing-quiz');
  const resultEl = () => document.getElementById('typing-result');

  // --- 注入されるフック ---
  let hooks = null;

  // --- セッション状態 ---
  let queue = [];      // 出題リスト（[{page,segIndex,effStart,end,hanzi,pinyin,gloss,starred}]）
  let pos = 0;         // 現在の出題index
  let scope = 'all';   // 'all' | 'starred' | 'review'
  let mode = 'audio';  // 'audio' | 'gloss'
  let wrong = [];      // 間違えた単語（結果画面用）
  let correctCount = 0;
  let answered = false; // 現在の問題が判定済みか（二重判定防止）
  let curJudgedCorrect = false; // 現在の問題の判定結果（実は正解の切替に使う）
  // 不正解確定の直前に、その単語の SRS エントリを控えておく（無ければ null）。
  // 「実は正解」で不正解のキュー入り/リセットを取り消し、回答前の状態へ戻すために使う。
  let srsSnapshot = null;

  // 音声再生トークン（区間監視の排他）。
  let audioToken = 0;
  let rafId = null;

  function init(injected) { hooks = injected; }

  /* ============ 判定用の正規化 ============
   * 前後空白除去・内部の空白/全角スペース除去・全角英数→半角。簡体字はそのまま。 */
  function normalize(s) {
    if (s == null) return '';
    let t = String(s);
    // 全角英数・記号(U+FF01..FF5E) → 半角。全角スペース(U+3000)は後で除去。
    t = t.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    t = t.replace(/　/g, ' '); // 全角スペースを半角へ寄せてから
    t = t.replace(/\s+/g, '');     // 内部・前後の空白をすべて除去
    return t;
  }

  /* ============ 音声（「単語+訳」だけを位置指定再生） ============ */
  let curBlobUrl = null;
  let curBlobPage = null;
  // wordonly 範囲のセッション内キャッシュ（key="page/segIndex" → [s,e] 秒 or null）。
  // 出題単語のページだけをオンデマンドに無音解析して確定する（機能Bと同じ Listen 側で解析）。
  const wordonlyCache = new Map();

  function stopAudio() {
    audioToken++;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    try { audio.pause(); } catch (e) {}
  }

  // 出題音声の再生範囲 [start, end] 秒を返す。音声モードでは「単語+訳」だけに絞る（例文を流さない）。
  // wordonly が確定できない/解析失敗なら effStart〜end（従来）にフォールバック。
  async function rangeFor(w) {
    const key = `${w.page}/${w.segIndex}`;
    let wo = wordonlyCache.get(key);
    if (wo === undefined) {
      wo = null;
      if (typeof Listen !== 'undefined' && Listen.resolveWordonly && w.seg) {
        try { wo = await Listen.resolveWordonly(w.page, w.seg); } catch (e) { wo = null; }
      }
      wordonlyCache.set(key, wo);
    }
    // wordonly[0..1] が妥当（s<e、範囲内）なら採用。そうでなければ effStart〜end。
    if (wo && wo.length === 2 && wo[1] > wo[0]) return [wo[0], wo[1]];
    return [w.effStart, w.end];
  }

  async function playSegment(w) {
    stopAudio();
    const myToken = ++audioToken;
    // 「単語+訳」範囲を確定（オンデマンド解析・キャッシュ）。解析中に別操作が入ったら中断。
    const [st, end] = await rangeFor(w);
    if (myToken !== audioToken) return;
    // ページが変わるときだけ Blob を差し替え（同ページは seek のみ）。
    if (curBlobPage !== w.page || !curBlobUrl) {
      if (curBlobUrl) { URL.revokeObjectURL(curBlobUrl); curBlobUrl = null; }
      const blob = await hooks.getBlobFor(w.page);
      if (myToken !== audioToken) return;
      if (!blob) return;
      curBlobUrl = URL.createObjectURL(blob);
      curBlobPage = w.page;
      audio.src = curBlobUrl;
      audio.load();
      await new Promise((resolve) => {
        if (audio.readyState >= 1) return resolve();
        const onReady = () => { audio.removeEventListener('loadedmetadata', onReady); resolve(); };
        audio.addEventListener('loadedmetadata', onReady);
      });
      if (myToken !== audioToken) return;
    }
    try { audio.currentTime = st; } catch (e) {}
    try { await audio.play(); } catch (e) { return; }
    if (myToken !== audioToken) { audio.pause(); return; }
    if (Math.abs(audio.currentTime - st) > 0.3) { try { audio.currentTime = st; } catch (e) {} }
    // 区間監視: end に達したら止める（次の単語が漏れ聞こえないように）。
    const watch = () => {
      if (myToken !== audioToken) return;
      if (audio.currentTime >= end - 0.02) { audio.pause(); rafId = null; return; }
      rafId = requestAnimationFrame(watch);
    };
    rafId = requestAnimationFrame(watch);
  }

  /* ============ 開始（範囲選択画面） ============ */
  function open() {
    if (!hooks) return;
    // 機能A（タップ再生）/機能B（聞き流し）が鳴っていたら止める（二重再生を防ぐ）。
    if (typeof Player !== 'undefined' && Player.stop) Player.stop();
    if (typeof Listen !== 'undefined' && Listen.stop) Listen.stop();
    mode = readMode();
    renderSetup();
    view.classList.remove('hidden');
  }

  /* 復習キューのセッションを「範囲選択を飛ばして」直接開始する（仕様: バッジ/専用導線用）。
   * 復習は形式（音声/訳）を問わず対象にしたいので、音声モードで開始する（訳が無い単語も出せる）。
   * 対象0件のときは範囲選択画面にフォールバック（普段の open と同じ体験）。 */
  function openReview() {
    if (!hooks) return;
    if (typeof Player !== 'undefined' && Player.stop) Player.stop();
    if (typeof Listen !== 'undefined' && Listen.stop) Listen.stop();
    mode = 'audio'; // 復習は音声モード固定（訳が無い単語も復習対象に含める）
    view.classList.remove('hidden');
    if (availCount('review') === 0) { renderSetup(); return; }
    startSession('review');
  }

  function close() {
    stopAudio();
    if (curBlobUrl) { URL.revokeObjectURL(curBlobUrl); curBlobUrl = null; curBlobPage = null; }
    wordonlyCache.clear(); // 別の単語帳を開いたときに前の book の範囲を使い回さない
    view.classList.add('hidden');
    if (hooks && hooks.onClose) hooks.onClose();
  }

  function readMode() {
    let m = 'audio';
    try { m = localStorage.getItem(MODE_KEY) || 'audio'; } catch (e) {}
    return (m === 'gloss') ? 'gloss' : 'audio';
  }
  function saveMode(m) { try { localStorage.setItem(MODE_KEY, m); } catch (e) {} }

  // 出題形式に応じて対象語を絞る（訳モードは gloss も必須）。hanzi 空は getCandidates 側で除外済み。
  function filterByMode(list) {
    if (mode === 'gloss') return list.filter((w) => w.gloss && w.gloss.trim());
    return list;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 各範囲の「出題可能数」（20上限適用前）。ボタンの活性/件数表示に使う。
  function availCount(sc) {
    const list = filterByMode(hooks.getCandidates(sc));
    return list.length;
  }

  function renderSetup() {
    const el = setupEl();
    const allN = availCount('all');
    const starN = availCount('starred');
    const revN = availCount('review');
    const modeLabel = mode === 'gloss' ? '訳' : '音声';

    el.innerHTML = `
      <p class="typing-lead">
        単語を<b>タイピング</b>で覚えます。出題→漢字を入力→判定。間違えた単語は
        <b>復習キュー</b>（忘却曲線）に入り、後日また出題されます。
      </p>

      <div class="typing-opt">
        <div class="typing-opt-label">出題形式</div>
        <div class="seg typing-mode" role="tablist" aria-label="出題形式">
          <button data-mode="audio" class="seg-btn${mode === 'audio' ? ' active' : ''}" role="tab">音声</button>
          <button data-mode="gloss" class="seg-btn${mode === 'gloss' ? ' active' : ''}" role="tab">訳</button>
        </div>
        <div class="typing-opt-hint">${mode === 'gloss'
          ? '日本語訳を見て漢字を入力（訳がある単語のみ）。'
          : '単語の音声を聞いて漢字を入力。'}</div>
      </div>

      <div class="typing-opt">
        <div class="typing-opt-label">出題範囲（形式：${modeLabel}）</div>
        <div class="typing-ranges">
          <button class="typing-range" data-scope="all" ${allN === 0 ? 'disabled aria-disabled="true"' : ''}>
            <span class="tr-main">全単語</span><span class="tr-count">${allN}語</span>
          </button>
          <button class="typing-range" data-scope="starred" ${starN === 0 ? 'disabled aria-disabled="true"' : ''}>
            <span class="tr-main"><svg class="tr-star" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.9l-5.81 3.06L7.3 14.48 2.6 9.9l6.5-.95z"/></svg>スターのみ</span><span class="tr-count">${starN}語</span>
          </button>
          <button class="typing-range typing-range-review" data-scope="review" ${revN === 0 ? 'disabled aria-disabled="true"' : ''}>
            <span class="tr-main">復習キュー（今日）</span><span class="tr-count">${revN}語</span>
          </button>
        </div>
        <div class="typing-opt-hint">1回のセッションは最大 ${MAX_QUESTIONS} 問（対象が少なければ全部）。順番はシャッフルします。</div>
      </div>
    `;

    // 出題形式トグル
    el.querySelectorAll('.typing-mode .seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        mode = b.dataset.mode === 'gloss' ? 'gloss' : 'audio';
        saveMode(mode);
        renderSetup(); // 件数（訳モードは gloss 必須）を再計算して描き直す
      });
    });
    // 範囲選択 → セッション開始
    el.querySelectorAll('.typing-range').forEach((b) => {
      if (b.disabled) return;
      b.addEventListener('click', () => startSession(b.dataset.scope));
    });

    // ビューの状態切替（開始画面を表示）
    setupEl().classList.remove('hidden');
    quizEl().classList.add('hidden');
    resultEl().classList.add('hidden');
  }

  /* ============ セッション ============ */
  function startSession(sc) {
    scope = sc;
    const pool = filterByMode(hooks.getCandidates(sc));
    queue = shuffle(pool).slice(0, MAX_QUESTIONS);
    pos = 0;
    wrong = [];
    correctCount = 0;
    if (queue.length === 0) { renderSetup(); return; }
    setupEl().classList.add('hidden');
    resultEl().classList.add('hidden');
    quizEl().classList.remove('hidden');
    renderQuestion();
  }

  function isReviewSession() { return scope === 'review'; }

  function renderQuestion() {
    answered = false;
    curJudgedCorrect = false;
    const w = queue[pos];
    const el = quizEl();

    // 訳モードは gloss を大きく表示・音声は鳴らさない。音声モードは gloss を隠して音声再生。
    const promptHtml = (mode === 'gloss')
      ? `<div class="tq-gloss">${escapeHtml(w.gloss || '')}</div>`
      : `<button class="tq-replay" id="tq-replay" type="button" aria-label="もう一度聞く">
           <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><polygon points="7 4 21 12 7 20"/></svg>
           <span>もう一度聞く</span>
         </button>`;

    el.innerHTML = `
      <div class="tq-top">
        <button class="icon-btn" id="tq-close" aria-label="やめる">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="tq-progress"><span id="tq-cur">${pos + 1}</span> / ${queue.length}</div>
        <div class="tq-scope">${scopeLabel()}</div>
      </div>
      <div class="tq-body">
        <div class="tq-prompt">${promptHtml}</div>
        <input type="text" id="tq-input" class="tq-input" inputmode="text"
          autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
          placeholder="漢字を入力" aria-label="漢字を入力" />
        <div class="tq-feedback hidden" id="tq-feedback"></div>
        <button class="primary-btn tq-submit" id="tq-submit" type="button">こたえあわせ</button>
        <button class="primary-btn tq-next hidden" id="tq-next" type="button">次へ</button>
      </div>
    `;

    const input = document.getElementById('tq-input');
    const submitBtn = document.getElementById('tq-submit');
    const closeBtn = document.getElementById('tq-close');
    closeBtn.addEventListener('click', () => close());

    if (mode === 'gloss') {
      // 訳モードは音声を鳴らさない（答えを聞かせない）。
      stopAudio();
    } else {
      const replay = document.getElementById('tq-replay');
      if (replay) replay.addEventListener('click', () => playSegment(w));
      playSegment(w); // 出題時に自動再生
    }

    // IME 対応: composition 中は Enter で確定判定しない。
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // isComposing（変換確定の Enter）や composition 中は判定しない。
      if (e.isComposing || composing || e.keyCode === 229) return;
      e.preventDefault();
      if (!answered) judge();
    });
    submitBtn.addEventListener('click', () => { if (!answered) judge(); });

    setTimeout(() => { try { input.focus(); } catch (e) {} }, 50);
  }

  function scopeLabel() {
    if (scope === 'starred') return '★ スター';
    if (scope === 'review') return '復習';
    return '全単語';
  }

  /* 判定して SRS を更新し、フィードバックを描画する。 */
  async function judge() {
    answered = true;
    const w = queue[pos];
    const input = document.getElementById('tq-input');
    const userRaw = input.value;
    const correct = normalize(userRaw) === normalize(w.hanzi);
    curJudgedCorrect = correct;
    stopAudio();
    input.disabled = true;

    if (correct) {
      correctCount++;
      srsSnapshot = null;
    } else {
      if (!wrong.some((x) => x.page === w.page && x.segIndex === w.segIndex)) wrong.push(w);
      // 不正解を反映する前の状態を控える（「実は正解」で元へ戻すため）。
      const srs = hooks.getSrs() || {};
      const cur = srs[`${w.page}/${w.segIndex}`];
      srsSnapshot = cur ? Object.assign({}, cur) : null; // 元々キューに無ければ null
    }

    await applySrs(w, correct);
    renderFeedback(w, userRaw, correct);
  }

  // SRS 反映（純関数 srs.js に委譲）。復習セッションかどうかを渡す。
  async function applySrs(w, correct) {
    const key = `${w.page}/${w.segIndex}`;
    const srs = hooks.getSrs() || {};
    const next = SRS.applyResult(srs, key, correct, hooks.today(), isReviewSession());
    await hooks.saveSrs(next);
  }

  function renderFeedback(w, userRaw, correct) {
    const fb = document.getElementById('tq-feedback');
    const submitBtn = document.getElementById('tq-submit');
    const nextBtn = document.getElementById('tq-next');

    const answerBlock = `
      <div class="tq-answer">
        <div class="tq-ans-hanzi">${escapeHtml(w.hanzi || '')}</div>
        ${w.pinyin ? `<div class="tq-ans-pinyin">${escapeHtml(w.pinyin)}</div>` : ''}
        ${w.gloss ? `<div class="tq-ans-gloss">${escapeHtml(w.gloss)}</div>` : ''}
      </div>`;

    if (correct) {
      fb.className = 'tq-feedback correct';
      fb.innerHTML = `<div class="tq-mark">○ 正解</div>${answerBlock}`;
    } else {
      fb.className = 'tq-feedback wrong';
      // 空白のみの入力は escapeHtml しても truthy になるので、trim して空なら「（空）」を出す。
      const yours = String(userRaw).trim() ? escapeHtml(userRaw) : '（空）';
      fb.innerHTML = `
        <div class="tq-mark">✕ ちがう</div>
        <div class="tq-yours">あなたの入力: <b>${yours}</b></div>
        ${answerBlock}
        <button class="ghost-btn tq-actually" id="tq-actually" type="button">実は正解（この入力を正しい漢字にする）</button>
      `;
    }
    fb.classList.remove('hidden');
    submitBtn.classList.add('hidden');
    nextBtn.classList.remove('hidden');
    nextBtn.addEventListener('click', advance);

    if (!correct) {
      const act = document.getElementById('tq-actually');
      if (act) act.addEventListener('click', () => actuallyCorrect(w, userRaw));
    }

    setTimeout(() => { try { nextBtn.focus(); } catch (e) {} }, 30);
  }

  /* 「実は正解」: 入力値を正しい漢字として vocab へ保存し、この問題を正解扱いへ変換。
   * これは ASR 誤りの訂正であってユーザーの誤答ではないので、直前の不正解で入れた
   * キュー入り/リセットを SRS.restore で「回答前の状態」へ戻す（昇級もさせない）。
   *   元々キューに無かった → エントリ削除。元々あった → 元の level/nextDue に復元。 */
  async function actuallyCorrect(w, userRaw) {
    const fixed = String(userRaw).trim();
    if (!fixed) return; // 空入力は「実は正解」にできない
    // vocab を上書き（hanzi=入力値・low_confidence=false）。
    await hooks.markActuallyCorrect(w.page, w.segIndex, fixed);
    // ローカルの出題データにも反映（結果画面や以降の表示のため）。
    w.hanzi = fixed;

    // 判定を正解へ切替: wrong 一覧から外し、正解数を+1、SRS を回答前へ復元。
    if (!curJudgedCorrect) {
      curJudgedCorrect = true;
      correctCount++;
      wrong = wrong.filter((x) => !(x.page === w.page && x.segIndex === w.segIndex));
      const key = `${w.page}/${w.segIndex}`;
      const srs = hooks.getSrs() || {};
      const restored = SRS.restore(srs, key, srsSnapshot);
      await hooks.saveSrs(restored);
    }

    // フィードバックを正解表示へ差し替え。
    const fb = document.getElementById('tq-feedback');
    fb.className = 'tq-feedback correct';
    fb.innerHTML = `<div class="tq-mark">○ 正解（修正しました）</div>
      <div class="tq-answer">
        <div class="tq-ans-hanzi">${escapeHtml(w.hanzi || '')}</div>
        ${w.pinyin ? `<div class="tq-ans-pinyin">${escapeHtml(w.pinyin)}</div>` : ''}
        ${w.gloss ? `<div class="tq-ans-gloss">${escapeHtml(w.gloss)}</div>` : ''}
      </div>
      <div class="tq-fixed-note">この漢字を正しい表記として保存しました。</div>`;
  }

  function advance() {
    pos++;
    if (pos >= queue.length) { renderResult(); return; }
    renderQuestion();
  }

  /* ============ 結果 ============ */
  function renderResult() {
    stopAudio();
    quizEl().classList.add('hidden');
    const el = resultEl();
    const total = queue.length;

    const wrongList = wrong.length
      ? `<div class="tr-wrong-title">間違えた単語（${wrong.length}）</div>
         <div class="tr-wrong-list">${wrong.map((w) => `
           <div class="tr-wrong-item">
             <span class="tr-wh">${escapeHtml(w.hanzi || '')}</span>
             ${w.pinyin ? `<span class="tr-wp">${escapeHtml(w.pinyin)}</span>` : ''}
             ${w.gloss ? `<span class="tr-wg">${escapeHtml(w.gloss)}</span>` : ''}
           </div>`).join('')}</div>`
      : `<div class="tr-allright">全問正解です。よくできました。</div>`;

    el.innerHTML = `
      <div class="tr-score">
        <div class="tr-score-big">${correctCount} / ${total}</div>
        <div class="tr-score-sub">正解</div>
      </div>
      ${wrongList}
      <div class="tr-actions">
        <button class="primary-btn" id="tr-again" type="button">もう一度</button>
        <button class="ghost-btn" id="tr-back" type="button">範囲選択に戻る</button>
        <button class="ghost-btn" id="tr-close" type="button">閉じる</button>
      </div>
    `;
    el.classList.remove('hidden');

    document.getElementById('tr-again').addEventListener('click', () => startSession(scope));
    document.getElementById('tr-back').addEventListener('click', () => renderSetup());
    document.getElementById('tr-close').addEventListener('click', () => close());
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  return { init, open, openReview, close, normalize };
})();

// Node（検証）から normalize 等を require できるようにエクスポート（ブラウザでは無害）。
if (typeof module !== 'undefined' && module.exports) module.exports = Typing;

