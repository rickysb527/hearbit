/* Hearbit アプリ本体：3階層ナビ、単語帳の読み込み/管理、機能A（タップ再生）。
 * デザインは DESIGN.md（Hearbit）準拠。ティール=通常/ブランド、オレンジ=再生中。
 */
(() => {
  // --- DOM: views ---
  const views = {
    books: document.getElementById('view-books'),
    settings: document.getElementById('view-settings'),
    import: document.getElementById('view-import'),
    pages: document.getElementById('view-pages'),
    editor: document.getElementById('view-editor'),
  };

  // --- DOM: header ---
  const headerBrand = document.getElementById('header-brand');
  const headerContext = document.getElementById('header-context');
  const ctxTitle = document.getElementById('ctx-title');
  const ctxSub = document.getElementById('ctx-sub');
  const backBtn = document.getElementById('back-btn');
  const ctxAction = document.getElementById('ctx-action');
  const settingsBtn = document.getElementById('settings-btn');
  const tabBar = document.getElementById('tab-bar');

  // --- DOM: books ---
  const booksList = document.getElementById('books-list');
  const booksEmpty = document.getElementById('books-empty');
  const addBookBtn = document.getElementById('add-book-btn');

  // --- DOM: import ---
  const importName = document.getElementById('import-name');
  const importFiles = document.getElementById('import-files');
  const importRunBtn = document.getElementById('import-run-btn');
  const importProgress = document.getElementById('import-progress');
  const importFill = document.getElementById('import-fill');
  const importText = document.getElementById('import-text');
  const importDebug = document.getElementById('import-debug');
  const importDebugOut = document.getElementById('import-debug-out');

  // --- DOM: pages ---
  const pagesGridWrap = document.getElementById('pages-grid-wrap');

  // --- DOM: 単語テキスト(漢字・ピンイン)読み込み ---
  const vocabFile = document.getElementById('vocab-file');
  const vocabClearBtn = document.getElementById('vocab-clear-btn');
  const vocabBarTitle = document.getElementById('vocab-bar-title');
  const vocabBarSub = document.getElementById('vocab-bar-sub');
  const vocabFilterBar = document.getElementById('vocab-filter-bar');
  const vocabFilterBtn = document.getElementById('vocab-filter-btn');
  const vocabFilterCount = document.getElementById('vocab-filter-count');
  const vocabStarFilterBtn = document.getElementById('vocab-star-filter-btn');
  const vocabStarFilterCount = document.getElementById('vocab-star-filter-count');

  // --- DOM: 分割再計算オーバーレイ ---
  const resplitOverlay = document.getElementById('resplit-overlay');
  const resplitText = document.getElementById('resplit-text');

  // --- DOM: 聞き流し（機能B） ---
  const listenSizeSeg = document.getElementById('listen-size');
  const listenRanges = document.getElementById('listen-ranges');

  // --- ナビゲーション状態 ---
  // 'books'/'settings' はルート階層（ブランドヘッダ+下部タブ）。
  // 'import'/'pages' は下層（コンテキストヘッダ、下部タブ非表示）。
  let stack = ['books'];
  let currentBook = null; // { id, name, book }
  let playlist = [];      // フラットな単語リスト（Player 用）
  let cellEls = [];       // playlist と同じ index のセルDOM（ハイライト用）
  let listenWords = [];   // 機能B用の単語リスト（ListenBuild.collectWords）
  let listenSize = 50;    // 現在選択中のチャンクサイズ（50/100）
  let vocabFilterLowOnly = false; // 「要確認のみ表示」フィルタ（low_confidence だけ）
  let vocabFilterStarOnly = false; // 「スターのみ表示」フィルタ（starred だけ）

  const ROOTS = ['books', 'settings'];

  function isRoot(name) { return ROOTS.includes(name); }

  function showView(name) {
    Object.values(views).forEach(v => v.classList.remove('active'));
    views[name].classList.add('active');

    const root = isRoot(name);
    headerBrand.classList.toggle('hidden', !root);
    headerContext.classList.toggle('hidden', root);
    tabBar.classList.toggle('hidden', !root);
    // ミニプレーヤー（単語/聞き流し）をタブバーの上に出すための目印（CSS 側で bottom をずらす）
    document.body.classList.toggle('tabbar-open', root);

    if (root) {
      tabBar.querySelectorAll('.tabbar-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.root === name));
    }
  }

  function navigate(name, title, sub) {
    stack.push(name);
    ctxTitle.textContent = title || '';
    ctxSub.textContent = sub || '';
    ctxSub.classList.toggle('hidden', !sub);
    showView(name);
  }

  function goBack() {
    const leaving = stack[stack.length - 1];
    if (leaving === 'editor') Editor.stopPreview(); // 編集画面を離れるとき試聴を止める
    stack.pop();
    const prev = stack[stack.length - 1] || 'books';
    if (prev === 'books') { renderBooks(); showView('books'); }
    else if (prev === 'pages') {
      ctxTitle.textContent = currentBook.name;
      showView('pages');
    } else { showView(prev); }
  }
  backBtn.addEventListener('click', goBack);

  // 下部タブ（ルート切替）
  tabBar.querySelectorAll('.tabbar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const root = btn.dataset.root;
      stack = [root];
      if (root === 'books') renderBooks();
      showView(root);
    });
  });
  settingsBtn.addEventListener('click', () => { stack = ['settings']; showView('settings'); });

  // --- テーマ切替（設定） ---
  const themeSeg = document.getElementById('theme-seg');
  function applyTheme(mode) {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    try { localStorage.setItem('hearbit-theme', mode); } catch (e) {}
    themeSeg.querySelectorAll('.seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.theme === mode));
  }
  themeSeg.querySelectorAll('.seg-btn').forEach(b =>
    b.addEventListener('click', () => applyTheme(b.dataset.theme)));
  (function initTheme() {
    let m = 'system';
    try { m = localStorage.getItem('hearbit-theme') || 'system'; } catch (e) {}
    applyTheme(m);
  })();

  // ================= ① 単語帳リスト =================
  async function renderBooks() {
    const books = await DB.listBooks();
    booksList.innerHTML = '';
    booksEmpty.classList.toggle('hidden', books.length > 0);

    books.sort((a, b) => a.createdAt - b.createdAt);
    const todayStr = SRS.toDateStr(new Date());
    for (const b of books) {
      const pageCount = b.book.pages.length;
      const wordCount = b.book.pages.reduce((s, p) => s + p.word_count, 0);
      // 復習バッジ: 期限到来（nextDue <= 今日）の単語数。0 のときは出さない。
      const dueN = SRS.dueCount(b.srs, todayStr);
      const dueBadge = dueN > 0
        ? `<span class="book-due-badge" aria-label="復習 ${dueN}語">復習 ${dueN}</span>` : '';

      const el = document.createElement('div');
      el.className = 'book-item';
      el.setAttribute('role', 'button');
      el.innerHTML = `
        <div class="book-chip" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z"/><path d="M18 7a2 2 0 0 1 2-2v13"/>
          </svg>
        </div>
        <div class="book-main">
          <div class="book-name-row"><span class="book-name"></span>${dueBadge}</div>
          <div class="book-meta">${pageCount}ページ · ${wordCount}単語</div>
          <div class="book-offline">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            オフライン
          </div>
        </div>
        <button class="book-del" aria-label="削除">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
        <div class="book-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
        </div>`;
      el.querySelector('.book-name').textContent = b.name;
      el.addEventListener('click', () => {
        openBook(b).catch((err) => { hideResplit(); alert('単語帳を開けませんでした: ' + err.message); });
      });
      el.querySelector('.book-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`「${b.name}」を削除しますか？`)) {
          // 再生中（ミニ表示中）の単語帳なら止めて手放す。残すと★操作で削除済みの単語帳が DB に復活する。
          if (currentBook && currentBook.id === b.id) { Player.stop(); Listen.stop(); currentBook = null; }
          await DB.deleteBook(b.id); renderBooks();
        }
      });
      booksList.appendChild(el);
    }
  }

  addBookBtn.addEventListener('click', () => {
    importName.value = '';
    importFiles.value = '';
    importRunBtn.disabled = true;
    importProgress.classList.add('hidden');
    importDebug.classList.add('hidden');
    navigate('import', '音声を読み込む');
  });

  // ================= 読み込み・分割・保存 =================
  function updateImportBtn() {
    importRunBtn.disabled = !(importName.value.trim() && importFiles.files.length);
  }
  importName.addEventListener('input', updateImportBtn);
  importFiles.addEventListener('change', updateImportBtn);

  importRunBtn.addEventListener('click', async () => {
    const name = importName.value.trim();
    const files = [...importFiles.files]
      .filter(f => /\.(mp3|m4a|aac|wav|ogg)$/i.test(f.name) || f.type.startsWith('audio/'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!name || !files.length) return;

    importRunBtn.disabled = true;
    importProgress.classList.remove('hidden');
    importFill.style.width = '0%';

    const pages = [];
    const audioMap = {};
    const debugLines = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const pageId = pageIdFromName(file.name, i);
      importText.textContent = `分割中 ${i + 1}/${files.length}: ${file.name}`;
      importFill.style.width = `${Math.round((i / files.length) * 100)}%`;

      const buf = await file.arrayBuffer();
      let pageMeta;
      try { pageMeta = await Splitter.analyzePage(buf, pageId); }
      catch (err) { debugLines.push(`${pageId}: 解析失敗 ${err.message}`); continue; }
      pages.push(pageMeta);
      audioMap[pageId] = file;
      const flag = pageMeta.has_announce ? ' ★アナウンス' : '';
      debugLines.push(`${pageId}: ${pageMeta.num_segments}seg / ${pageMeta.layout} / ${pageMeta.word_count}語${flag}`);
      await sleep(0);
    }

    importText.textContent = '保存中…';
    importFill.style.width = '100%';

    const meta = {
      id: 'book_' + Date.now(), name, createdAt: Date.now(),
      splitVersion: Splitter.SPLIT_VERSION, // この分割ロジックのバージョンを刻む
      book: { book: name, pages },
    };
    await DB.saveBook(meta, audioMap);

    const totalSeg = pages.reduce((s, p) => s + p.num_segments, 0);
    const totalWord = pages.reduce((s, p) => s + p.word_count, 0);
    debugLines.unshift(`合計: ${pages.length}ページ / ${totalSeg}セグメント / ${totalWord}語\n`);
    importDebugOut.textContent = debugLines.join('\n');
    importDebug.classList.remove('hidden');
    importText.textContent = '完了。単語帳一覧に戻れます。';

    stack = ['books'];
    await renderBooks();
    showView('books');
  });

  // ================= 分割の再計算（ロジックのバージョン付きキャッシュ） =================
  // 単語帳オープン時、meta.splitVersion が現行 Splitter.SPLIT_VERSION と一致すれば
  // キャッシュ（book.pages）をそのまま使う（速い）。不一致（コード更新後の初回）なら
  // 元音声Blobから再分割してキャッシュを更新する（自動・ユーザー再投入不要）。
  //
  // 戻り値: 最新の meta（再分割した場合は book.pages / splitVersion を更新済み）。
  //   元音声が無く再分割できない旧データは、そのまま返しつつ needsReimport:true を付ける。
  async function ensureSplitCurrent(meta) {
    // 現行と一致 → そのまま（高速パス）。splitVersion 未定義の旧データは「要再計算」扱い。
    if (meta.splitVersion === Splitter.SPLIT_VERSION) return meta;

    const pages = (meta.book && meta.book.pages) || [];
    // 元音声が揃っているか（旧スキーマ・破損データのマイグレーション可否）
    const canResplit = pages.length > 0 && await DB.hasAllAudio(meta.id, pages);
    if (!canResplit) {
      // 元音声が無い旧データ → 再投入を促す（キャッシュはそのまま使わせるが警告）
      return Object.assign({}, meta, { needsReimport: true });
    }

    // 元音声から再分割してキャッシュを作り直す
    showResplit('音声を読み込んでいます');
    const newPages = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      // 手動編集済みページは自動再分割から保護（SPLIT_VERSION が上がっても上書きしない）。
      if (p.manualEdited) { newPages.push(p); continue; }
      resplitText.textContent = `再分割中 ${i + 1}/${pages.length}`;
      const blob = await DB.getAudio(meta.id, p.page);
      if (!blob) { newPages.push(p); continue; } // 念のため（hasAllAudioで担保済み）
      const buf = await blob.arrayBuffer();
      let pageMeta;
      try { pageMeta = await Splitter.analyzePage(buf, p.page); }
      catch (err) { newPages.push(p); continue; } // 解析失敗ページは旧結果を温存
      newPages.push(pageMeta);
      await sleep(0);
    }

    const updated = Object.assign({}, meta, {
      splitVersion: Splitter.SPLIT_VERSION,
      book: Object.assign({}, meta.book, { pages: newPages }),
    });
    delete updated.needsReimport;
    await DB.updateBookMeta(updated);
    hideResplit();
    return updated;
  }

  function showResplit(msg) {
    if (msg) resplitText.textContent = msg;
    resplitOverlay.classList.remove('hidden');
  }
  function hideResplit() { resplitOverlay.classList.add('hidden'); }

  // ================= トースト通知（成功・完了系） =================
  // 成功時に「失敗したように見える」alert を避けるための軽量トースト。
  // 画面下部（safe-area 考慮）に 2.8 秒表示してフェード＆スライドで自動消去。
  //   showToast('保存しました', { type: 'success' })  type: 'success'(既定) | 'info'
  // エラー系は従来どおり alert を使う（このトーストは使わない）。
  const toastHost = document.getElementById('toast-host');
  function showToast(message, opts) {
    if (!toastHost) return;
    const type = (opts && opts.type) || 'success';
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', 'status');
    const icon = type === 'success'
      ? `<svg class="toast-ic" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`
      : `<svg class="toast-ic" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    const span = document.createElement('span');
    span.className = 'toast-msg';
    span.textContent = message; // テキストは textContent（XSS 安全）
    el.innerHTML = icon;
    el.appendChild(span);
    toastHost.appendChild(el);
    // 入場アニメ（次フレームで .show を付ける）
    requestAnimationFrame(() => el.classList.add('show'));
    // 自動消去（フェードアウト後に DOM から除去）
    setTimeout(() => {
      el.classList.remove('show');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      // transitionend が来ない場合の保険
      setTimeout(() => { if (el.parentNode) el.remove(); }, 400);
    }, 2800);
  }

  // ================= ② ページ/単語一覧（番号グリッド） =================
  async function openBook(book) {
    Player.stop();
    Listen.stop();
    // バージョン判定 → 必要なら元音声から再分割してキャッシュ更新（再投入不要で反映）
    book = await ensureSplitCurrent(book);
    if (book.needsReimport) {
      alert(`「${book.name}」は分割ロジックの更新分を反映できません（元音声が見つかりません）。\n` +
        `お手数ですが、この単語帳を削除して音声を読み込み直してください。`);
      // それでも旧キャッシュで開けるなら開く（閲覧・再生自体は可能）
    }
    currentBook = book;
    const wordCount = book.book.pages.reduce((s, p) => s + p.word_count, 0);
    buildPlaylist(book);
    configureListen(book);
    renderListenOptions();
    renderPages(book);
    refreshVocabBar();
    refreshTypingEntry();
    // タブは「単語」に戻す
    document.querySelectorAll('#book-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'words'));
    document.getElementById('tab-words').classList.add('active');
    document.getElementById('tab-listen').classList.remove('active');
    navigate('pages', book.name, `${book.book.pages.length}ページ · ${wordCount}単語`);
  }

  // 単語テキスト（漢字・ピンイン）の紐付け。book.vocab は page/index をキーにした辞書。
  // { "001/0": { hanzi, pinyin, gloss, low_confidence, starred }, ... }。無ければ null を返す。
  function vocabFor(book, page, segIndex) {
    const v = book && book.vocab;
    if (!v) return null;
    return v[`${page}/${segIndex}`] || null;
  }

  // ================= スター（お気に入り） =================
  // スター状態は book.vocab[page/index].starred（真偽）で持つ。テキスト（漢字・ピンイン）が
  // 無いエントリでもスターだけ立てられる（番号表示のままお気に入り可）。page+index キーなので
  // 分割再計算・境界編集後もスターは保たれる（vocab は派生 pages と独立した辞書）。
  function isStarred(book, page, segIndex) {
    const t = vocabFor(book, page, segIndex);
    return !!(t && t.starred);
  }

  // 現在の単語帳でスターが立っている実セグメント数。
  function countStarred(book) {
    if (!book || !book.vocab) return 0;
    let n = 0;
    book.book.pages.forEach((p) => {
      p.segments.forEach((seg) => {
        const t = book.vocab[`${p.page}/${seg.index}`];
        if (t && t.starred) n++;
      });
    });
    return n;
  }

  // 機能B（聞き流し）の listenWords（collectWords 順＝全単語の順序）のうち、
  // starred な要素の global index 配列を順序どおりに返す（スター単語だけの連結トラック用）。
  function starredListenIndices() {
    const out = [];
    listenWords.forEach((w, i) => {
      if (isStarred(currentBook, w.page, w.seg.index)) out.push(i);
    });
    return out;
  }

  // スターをトグルして永続化し、依存表示（一覧・プレーヤー・フィルタ・聞き流し入口）へ即反映。
  // テキスト未読込の単語帳でも空辞書を用意して新規エントリを作る（starred のみ）。
  async function toggleStar(page, segIndex) {
    if (!currentBook) return;
    const key = `${page}/${segIndex}`;
    const cur = (currentBook.vocab && currentBook.vocab[key]) || null;
    const entry = Object.assign(
      { hanzi: '', pinyin: '', gloss: '', low_confidence: false },
      cur,
      { starred: !(cur && cur.starred) },
    );
    const vocab = Object.assign({}, currentBook.vocab || {}, { [key]: entry });
    const meta = Object.assign({}, currentBook, { vocab });
    await DB.updateBookMeta(meta);
    currentBook = meta;
    // 一覧セル・プレーヤー・フィルタ入口・聞き流し入口を最新化。
    // ※ configureListen（= Listen.configure → stop）は呼ばない。スター状態は collectWords の
    //   単語リストに影響せず、聞き流し再生中に星を付けても再生を止めないため。
    //   スター聞き流しの対象は starredListenIndices() で currentBook.vocab から都度計算する。
    buildPlaylist(currentBook, { preserveIndex: true });
    renderPages(currentBook);
    refreshVocabBar();
    renderStarListen(); // 「スター単語を聞き流す」の件数/活性だけ更新（範囲チップは不変）
    if (typeof Player !== 'undefined' && Player.refreshCurrent) Player.refreshCurrent();
    const pIdx = (typeof Player !== 'undefined' && Player.getIndex) ? Player.getIndex() : -1;
    if (pIdx >= 0) highlightCell(pIdx);
    return entry.starred;
  }

  // フラットな単語リストを構築（prev/next・Media Session のため）
  // opts.preserveIndex: 同一単語帳の再構成（テキスト編集）で再生位置を保つ。
  function buildPlaylist(book, opts) {
    playlist = [];
    cellEls = [];
    let serial = 0;
    book.book.pages.forEach((p, pageIdx) => {
      const pageLabel = `ページ ${String(pageIdx + 1).padStart(3, '0')}`;
      let wordNo = 0;
      p.segments.forEach((seg) => {
        wordNo += 1; serial += 1;
        const text = vocabFor(book, p.page, seg.index); // 漢字・ピンイン（無ければ null）
        // 実効start: アナウンス付き単語（word+announce）は冒頭のアナウンスを飛ばし、
        // announce_end（単語本体の開始）から鳴らす → タップですぐ単語が聞こえる。
        // announce_low_confidence:true でも announce_end を採用（境界が多少ズレても
        // 「単語から始める」意図は満たせる。精度改善は Issue #4 の手動修正で）。
        // それ以外のセグメントは従来通り seg.start。end は常に seg.end。
        // ※機能B（聞き流し）の連結時も、単語本体だけを繋ぐには同じ announce_end 考慮が要る。
        const effStart = (seg.type === 'word+announce' && seg.announce_end != null)
          ? seg.announce_end : seg.start;
        playlist.push({
          page: p.page, segIndex: seg.index,
          start: seg.start, effStart, end: seg.end, length: seg.length, type: seg.type,
          announce_end: seg.announce_end != null ? seg.announce_end : null,
          wordNo, serial, pageLabel,
          text, // { hanzi, pinyin, gloss, low_confidence } | null
          starred: !!(text && text.starred),
        });
      });
    });

    Player.configure({
      playlist,
      bookName: book.name,
      getBlobFor: (page) => DB.getAudio(book.id, page),
      onCellChange: highlightCell,
      onToggleStar: (page, segIndex) => toggleStar(page, segIndex),
      preserveIndex: !!(opts && opts.preserveIndex),
    });
  }

  function highlightCell(index) {
    cellEls.forEach((c, i) => { if (c) c.classList.toggle('playing', i === index); });
    const cell = cellEls[index];
    if (cell && cell.scrollIntoView) cell.scrollIntoView({ block: 'nearest' });
  }

  // ================= 機能B: 聞き流し =================
  // 単語リスト（単語+訳の抽出は再生時に遅延確定）を Listen に渡す。
  function configureListen(book) {
    listenWords = ListenBuild.collectWords(book.book); // silences 無し = wordonly は遅延確定
    Listen.configure({
      bookName: book.name,
      words: listenWords,
      getBlobFor: (page) => DB.getAudio(book.id, page),
      // 現在語の漢字・ピンインを引く。currentBook.vocab をライブに読むため、
      // テキスト編集後も（refreshText 経由で）最新値が反映される。
      textFor: (page, segIndex) => vocabFor(currentBook, page, segIndex),
      ui: listenUI,
    });
  }

  // 語数トグル（50/100）
  listenSizeSeg.querySelectorAll('.seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      listenSize = parseInt(b.dataset.size, 10);
      listenSizeSeg.querySelectorAll('.seg-btn').forEach((x) =>
        x.classList.toggle('active', x === b));
      renderListenRanges();
    });
  });

  // 範囲チップ（1–50, 51–100 …）を描画。タップで連結トラックを構築→再生。
  function renderListenOptions() {
    listenSizeSeg.querySelectorAll('.seg-btn').forEach((x) =>
      x.classList.toggle('active', parseInt(x.dataset.size, 10) === listenSize));
    renderListenRanges();
    renderStarListen();
  }

  // 「スター単語を聞き流す」入口の状態更新。スター0件のときは無効（押せない・グレー）。
  function renderStarListen() {
    const btn = document.getElementById('listen-star-btn');
    if (!btn) return;
    const n = starredListenIndices().length;
    const countEl = document.getElementById('listen-star-count');
    if (countEl) countEl.textContent = n ? `${n}語` : '0語';
    btn.disabled = n === 0;
    btn.setAttribute('aria-disabled', String(n === 0));
  }

  function renderListenRanges() {
    const total = listenWords.length;
    listenRanges.innerHTML = '';
    const n = ListenBuild.numChunks(total, listenSize);
    for (let c = 0; c < n; c++) {
      const [from, to] = ListenBuild.chunkRange(total, listenSize, c);
      const chip = document.createElement('button');
      chip.className = 'listen-range-chip';
      chip.setAttribute('role', 'option');
      chip.innerHTML = `<span class="lr-range">${from + 1}–${to}</span>
        <span class="lr-count">${to - from}語</span>`;
      chip.addEventListener('click', () => {
        showListenFull({ size: listenSize, from: from + 1, to, wordCount: to - from });
        Listen.playRange(from, to, listenSize);
      });
      listenRanges.appendChild(chip);
    }
  }

  function renderPages(book) {
    pagesGridWrap.innerHTML = '';
    cellEls = [];
    let flatIndex = 0;

    book.book.pages.forEach((p, pageIdx) => {
      const section = document.createElement('div');
      section.className = 'page-section';

      const head = document.createElement('div');
      head.className = 'page-section-head';
      const announce = p.has_announce
        ? '<span class="ph-announce" aria-label="アナウンス付き">📢</span>' : '';
      const manual = p.manualEdited
        ? '<span class="ph-manual" aria-label="手動編集済み">✎ 編集済</span>' : '';
      head.innerHTML = `<span>ページ ${String(pageIdx + 1).padStart(3, '0')}</span>
        <span class="ph-count">${manual}${announce}${p.word_count}単語
          <button class="ph-edit-btn" type="button" aria-label="このページの分割を編集">✎ 編集</button>
        </span>`;
      head.querySelector('.ph-edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        Editor.open(pageIdx);
      });
      section.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'words-grid';

      let wordNo = 0;
      let visibleInPage = 0;
      p.segments.forEach((seg) => {
        wordNo += 1;
        const myFlatIndex = flatIndex++;
        const w = playlist[myFlatIndex];
        const hasText = !!(w.text && (w.text.hanzi || w.text.pinyin));
        const isLow = !!(w.text && w.text.low_confidence);
        const starred = !!w.starred;
        // 「要確認のみ表示」フィルタ: low_confidence の単語だけ残す。
        if (vocabFilterLowOnly && !isLow) return;
        // 「スターのみ表示」フィルタ: starred の単語だけ残す。
        if (vocabFilterStarOnly && !starred) return;
        visibleInPage++;
        const cell = document.createElement('div');
        cell.className = 'cell' + (seg.type === 'word+announce' ? ' announce' : '')
          + (hasText ? ' has-text' : '')
          + (isLow ? ' low-conf' : '')
          + (starred ? ' starred' : '');
        cell.setAttribute('role', 'button');
        // テキスト編集ボタン（テキスト読込済みのときだけ表示）。長押しでも開ける。
        const editBtn = currentBook && currentBook.vocab
          ? `<button class="cell-edit" type="button" aria-label="テキストを編集" tabindex="-1">` +
            `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>`
          : '';
        // スターボタン（全セルに常設）。テキストの有無に関わらず押せる（番号表示でもスター可）。
        const starBtn = `<button class="cell-star${starred ? ' on' : ''}" type="button" ` +
          `aria-pressed="${starred}" aria-label="${starred ? 'スターを外す' : 'スターを付ける'}" tabindex="-1">` +
          `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.9l-5.81 3.06L7.3 14.48 2.6 9.9l6.5-.95z"/></svg></button>`;
        if (hasText) {
          const t = w.text;
          const lc = t.low_confidence ? '<span class="cell-lc" aria-label="認識が不確か">?</span>' : '';
          cell.setAttribute('aria-label',
            `ページ${pageIdx + 1} 単語${wordNo} ${t.hanzi || ''} ${t.pinyin || ''}`.trim());
          cell.innerHTML =
            `<div class="cell-badge">${wordNo}${lc}</div>` +
            starBtn + editBtn +
            `<div class="cell-hanzi"></div>` +
            `<div class="cell-pinyin"></div>`;
          cell.querySelector('.cell-hanzi').textContent = t.hanzi || '';
          cell.querySelector('.cell-pinyin').textContent = t.pinyin || '';
        } else {
          cell.setAttribute('aria-label', `ページ${pageIdx + 1} 単語${wordNo} 通し${w.serial}`);
          cell.innerHTML = starBtn + editBtn +
            `<div class="num">${wordNo}</div><div class="serial">#${w.serial}</div>`;
        }
        cell.addEventListener('click', () => Player.playIndex(myFlatIndex));
        // スターボタン: タップでトグル（再生はさせない）。
        const sb = cell.querySelector('.cell-star');
        if (sb) sb.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleStar(p.page, seg.index);
        });
        // 編集ボタン: タップで編集モーダル（再生はさせない）
        const eb = cell.querySelector('.cell-edit');
        if (eb) eb.addEventListener('click', (e) => {
          e.stopPropagation();
          TextEdit.open(p.page, seg.index, pageIdx + 1, wordNo);
        });
        // 長押し（タッチ/マウス）でも編集を開く。vocab があるときのみ。
        if (currentBook && currentBook.vocab) {
          attachLongPress(cell, () => TextEdit.open(p.page, seg.index, pageIdx + 1, wordNo));
        }
        cellEls[myFlatIndex] = cell;
        grid.appendChild(cell);
      });

      // フィルタで空になったページは見出しごと隠す（絞り込みを見やすく）
      if ((vocabFilterLowOnly || vocabFilterStarOnly) && visibleInPage === 0) return;
      section.appendChild(grid);
      pagesGridWrap.appendChild(section);
    });

    // フィルタ適用時に該当が1件も無ければ案内を出す
    if ((vocabFilterLowOnly || vocabFilterStarOnly) && !pagesGridWrap.children.length) {
      const empty = document.createElement('div');
      empty.className = 'vocab-filter-empty';
      empty.textContent = vocabFilterStarOnly
        ? 'スター（★）を付けた単語はありません。'
        : '要確認（?）の単語はありません。';
      pagesGridWrap.appendChild(empty);
    }
  }

  // ---- 長押し検出（タッチ/ポインタ共通）。移動やスクロールでキャンセル。 ----
  function attachLongPress(el, onLongPress) {
    let timer = null, sx = 0, sy = 0, fired = false;
    const LONG_MS = 500, MOVE_TOL = 10;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cell-edit') || e.target.closest('.cell-star')) return; // ボタン自身は除外
      fired = false; sx = e.clientX; sy = e.clientY;
      clear();
      timer = setTimeout(() => { fired = true; timer = null; onLongPress(); }, LONG_MS);
    });
    el.addEventListener('pointermove', (e) => {
      if (timer && (Math.abs(e.clientX - sx) > MOVE_TOL || Math.abs(e.clientY - sy) > MOVE_TOL)) clear();
    });
    el.addEventListener('pointerup', clear);
    el.addEventListener('pointercancel', clear);
    el.addEventListener('pointerleave', clear);
    // 長押しで開いた直後の click（=再生）を打ち消す
    el.addEventListener('click', (e) => { if (fired) { fired = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  }

  // ================= 単語テキスト（漢字・ピンイン）の読み込み（Issue #3） =================
  // Mac上のWhisper等で起こした vocab.json（650件の配列）を現在の単語帳に紐付ける。
  //   要素: { seq, page, index, hanzi, pinyin, gloss, low_confidence, ... }
  // 紐付けは page + index をキーにする（確実）。IndexedDB の book.vocab に辞書で保存。
  //   book.vocab = { "001/0": { hanzi, pinyin, gloss, low_confidence }, ... }
  // テキストが無い単語帳は従来通り番号表示（vocab 未設定 → vocabFor が null）。
  // vocab は元音声から再計算される派生キャッシュ(pages)とは独立し、page+index キーで
  // 保持するため、SPLIT_VERSION 更新に伴う自動再分割の後も紐付けが保たれる。
  function parseVocabArray(arr) {
    if (!Array.isArray(arr)) throw new Error('JSONの形式が配列ではありません');
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
    if (n === 0) throw new Error('page/index を持つ有効な項目がありません');
    return map;
  }

  // 単語テキスト再読み込み時のマージ: 新 map（テキストは新ファイル優先）に、既存 vocab の
  // starred を page/index キーで引き継ぐ。既存だけにあるキー（新ファイルに無い＝スターのみの
  // エントリ等）も starred が付いていれば残す（テキストは空のまま番号表示でスター保持）。
  function mergeVocabPreserveStar(oldVocab, newMap) {
    if (!oldVocab) return newMap;
    const merged = {};
    // まず新 map をベースに、既存 starred を上乗せ。
    for (const k of Object.keys(newMap)) {
      const wasStar = !!(oldVocab[k] && oldVocab[k].starred);
      merged[k] = wasStar ? Object.assign({}, newMap[k], { starred: true }) : newMap[k];
    }
    // 新 map に無い既存キーのうち starred のものは残す（スターが消えないように）。
    for (const k of Object.keys(oldVocab)) {
      if (merged[k]) continue;
      if (oldVocab[k] && oldVocab[k].starred) {
        merged[k] = { hanzi: '', pinyin: '', gloss: '', low_confidence: false, starred: true };
      }
    }
    return merged;
  }

  // 現在の単語帳の実セグメント(page+index)のうち、テキスト（漢字/ピンイン）が埋まった数を数える。
  // starred だけのエントリ（テキスト空）は「紐付け済み」に含めない。
  function countVocabMatches(book) {
    if (!book || !book.vocab) return { matched: 0, total: 0 };
    let matched = 0, total = 0;
    book.book.pages.forEach((p) => {
      p.segments.forEach((seg) => {
        total++;
        const t = book.vocab[`${p.page}/${seg.index}`];
        if (t && (t.hanzi || t.pinyin)) matched++;
      });
    });
    return { matched, total };
  }

  // テキスト（漢字/ピンイン）が1件でも紐付いているか。starred のみのエントリは含めない。
  function hasVocabText(book) {
    if (!book || !book.vocab) return false;
    return Object.keys(book.vocab).some((k) => {
      const t = book.vocab[k];
      return t && (t.hanzi || t.pinyin);
    });
  }

  // 現在の単語帳の実セグメントのうち low_confidence が付いた数。
  function countLowConfidence(book) {
    if (!book || !book.vocab) return 0;
    let n = 0;
    book.book.pages.forEach((p) => {
      p.segments.forEach((seg) => {
        const t = book.vocab[`${p.page}/${seg.index}`];
        if (t && t.low_confidence) n++;
      });
    });
    return n;
  }

  function refreshVocabBar() {
    // 「テキスト表示中」は実テキスト（漢字/ピンイン）の有無で判定（starred のみは表示扱いにしない）。
    const hasText = hasVocabText(currentBook);
    vocabClearBtn.classList.toggle('hidden', !(currentBook && currentBook.vocab));
    if (hasText) {
      const { matched, total } = countVocabMatches(currentBook);
      vocabBarTitle.textContent = '漢字・ピンイン表示中';
      vocabBarSub.textContent = `${matched}/${total} 語にテキストを紐付け済み`;
    } else {
      vocabBarTitle.textContent = '漢字・ピンインを表示';
      vocabBarSub.textContent = '単語テキスト(JSON)を読み込むと一覧に表示されます';
    }
    // 要確認フィルタ: テキスト読込済み かつ 要確認が1件以上あるときだけ出す。
    // スターフィルタ: スターが1件以上あるとき出す（テキスト未読込＝番号表示でもスター可）。
    const has = hasText;
    const lowN = has ? countLowConfidence(currentBook) : 0;
    const starN = countStarred(currentBook);
    const showLowFilter = has && lowN > 0;
    const showStarFilter = starN > 0;
    // フィルタバーは「要確認」または「スター」のどちらかが出るときに表示。
    vocabFilterBar.classList.toggle('hidden', !(showLowFilter || showStarFilter));

    vocabFilterBtn.classList.toggle('hidden', !showLowFilter);
    if (!showLowFilter && vocabFilterLowOnly) vocabFilterLowOnly = false; // 無くなったら解除
    vocabFilterBtn.setAttribute('aria-pressed', String(vocabFilterLowOnly));
    vocabFilterCount.textContent = lowN ? `（${lowN}）` : '';

    if (vocabStarFilterBtn) {
      vocabStarFilterBtn.classList.toggle('hidden', !showStarFilter);
      if (!showStarFilter && vocabFilterStarOnly) vocabFilterStarOnly = false; // スター0件で解除
      vocabStarFilterBtn.setAttribute('aria-pressed', String(vocabFilterStarOnly));
      vocabStarFilterCount.textContent = starN ? `（${starN}）` : '';
    }
  }

  vocabFilterBtn.addEventListener('click', () => {
    vocabFilterLowOnly = !vocabFilterLowOnly;
    if (vocabFilterLowOnly) vocabFilterStarOnly = false; // フィルタは排他（同時適用しない）
    vocabFilterBtn.setAttribute('aria-pressed', String(vocabFilterLowOnly));
    if (vocabStarFilterBtn) vocabStarFilterBtn.setAttribute('aria-pressed', String(vocabFilterStarOnly));
    renderPages(currentBook);
  });

  if (vocabStarFilterBtn) vocabStarFilterBtn.addEventListener('click', () => {
    vocabFilterStarOnly = !vocabFilterStarOnly;
    if (vocabFilterStarOnly) vocabFilterLowOnly = false; // フィルタは排他
    vocabStarFilterBtn.setAttribute('aria-pressed', String(vocabFilterStarOnly));
    vocabFilterBtn.setAttribute('aria-pressed', String(vocabFilterLowOnly));
    renderPages(currentBook);
  });

  vocabFile.addEventListener('change', async () => {
    const file = vocabFile.files && vocabFile.files[0];
    vocabFile.value = ''; // 同じファイルを続けて選べるようにリセット
    if (!file || !currentBook) return;
    let map;
    try {
      const text = await file.text();
      map = parseVocabArray(JSON.parse(text));
    } catch (err) {
      alert('単語テキストを読み込めませんでした: ' + err.message);
      return;
    }
    // 既存 vocab の starred を page/index キーで引き継ぐ（テキストは新ファイル優先）。
    // 再読み込みでスターが消えないようにするマージ。srs は vocab と別辞書なので影響しない。
    map = mergeVocabPreserveStar(currentBook.vocab, map);
    const meta = Object.assign({}, currentBook, { vocab: map });
    await DB.updateBookMeta(meta);
    currentBook = meta;
    // 再生データ・一覧を作り直してテキストを反映
    buildPlaylist(currentBook);
    configureListen(currentBook);
    renderPages(currentBook);
    refreshVocabBar();
    const { matched, total } = countVocabMatches(currentBook);
    showToast(`単語テキストを読み込みました（${matched}/${total} 語）`, { type: 'success' });
  });

  vocabClearBtn.addEventListener('click', async () => {
    if (!currentBook || !currentBook.vocab) return;
    if (!confirm('漢字・ピンインの表示を消去し、番号表示に戻しますか？')) return;
    // テキスト（漢字・ピンイン・訳・要確認）だけ消し、スターは残す。starred の付いた
    // エントリはテキストを空にして残す（番号表示のままスターは保持）。それ以外は削除。
    const kept = {};
    for (const k of Object.keys(currentBook.vocab)) {
      if (currentBook.vocab[k] && currentBook.vocab[k].starred) {
        kept[k] = { hanzi: '', pinyin: '', gloss: '', low_confidence: false, starred: true };
      }
    }
    const meta = Object.assign({}, currentBook);
    if (Object.keys(kept).length > 0) meta.vocab = kept;
    else delete meta.vocab;
    await DB.updateBookMeta(meta);
    currentBook = meta;
    buildPlaylist(currentBook);
    configureListen(currentBook);
    renderPages(currentBook);
    refreshVocabBar();
  });

  // ================= 分割の手動編集（残タスク #4） =================
  // 1ページの境界(cut点)・type・announce_end を手で調整し、per-book の分割位置JSONに
  // 上書き保存する。保存したページは manualEdited:true になり、SPLIT_VERSION が上がっても
  // ensureSplitCurrent の自動再分割から除外される（手編集を守る）。
  // 分割アルゴリズム（splitter.js）は変更しない。ここは結果の手動上書きのみ。
  const Editor = (() => {
    const listEl = document.getElementById('editor-list');
    const addBtn = document.getElementById('ed-add-btn');
    const resetBtn = document.getElementById('ed-reset-btn');
    const saveBtn = document.getElementById('ed-save-btn');
    const cancelBtn = document.getElementById('ed-cancel-btn');
    const edAudio = document.getElementById('editor-audio');

    const NUDGE = 0.1; // 微調整ステップ（秒）

    let pageIdx = -1;   // currentBook.book.pages のインデックス
    let page = null;    // 対象ページ（保存済みメタ）
    let state = null;   // SplitEditor の編集状態 { duration, bounds, types, announceEnds }
    let previewUrl = null;
    let previewStopAt = null;
    let previewRaf = null;
    let previewKey = null; // 再生中の対象（ハイライト用）

    const fmt = (t) => (isFinite(t) ? t.toFixed(2) : '0.00');

    // ---- 試聴（編集専用の audio 要素。Player/Listen とは独立）----
    async function ensureSrc() {
      if (previewUrl) return true;
      const blob = await DB.getAudio(currentBook.id, page.page);
      if (!blob) { alert('元音声が見つかりません（試聴できません）'); return false; }
      previewUrl = URL.createObjectURL(blob);
      edAudio.src = previewUrl;
      edAudio.load();
      await new Promise((res) => {
        if (edAudio.readyState >= 1) return res();
        const on = () => { edAudio.removeEventListener('loadedmetadata', on); res(); };
        edAudio.addEventListener('loadedmetadata', on);
      });
      return true;
    }
    function watch() {
      if (previewStopAt != null && edAudio.currentTime >= previewStopAt) { stopPreview(); return; }
      previewRaf = requestAnimationFrame(watch);
    }
    async function play(from, to, key) {
      stopPreview();
      if (!(await ensureSrc())) return;
      previewStopAt = to;
      previewKey = key;
      try { edAudio.currentTime = from; } catch (e) {}
      try { await edAudio.play(); } catch (e) { return; }
      if (Math.abs(edAudio.currentTime - from) > 0.3) { try { edAudio.currentTime = from; } catch (e) {} }
      previewRaf = requestAnimationFrame(watch);
      markPlaying(key);
    }
    function stopPreview() {
      if (previewRaf != null) { cancelAnimationFrame(previewRaf); previewRaf = null; }
      edAudio.pause();
      previewStopAt = null;
      previewKey = null;
      markPlaying(null);
    }
    function markPlaying(key) {
      listEl.querySelectorAll('.ed-play-btn').forEach((b) =>
        b.classList.toggle('playing', key != null && b.dataset.key === key));
    }
    function revoke() { if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; } }

    // ---- open ----
    function open(idx) {
      Player.stop(); Listen.stop();
      pageIdx = idx;
      page = currentBook.book.pages[idx];
      state = SplitEditor.pageToState(page);
      render();
      navigate('editor', `分割を編集`, `ページ ${String(idx + 1).padStart(3, '0')}`);
    }

    // ---- 描画 ----
    function render() {
      stopPreview();
      listEl.innerHTML = '';
      const bounds = state.bounds;
      for (let i = 0; i < bounds.length - 1; i++) {
        const segStart = bounds[i], segEnd = bounds[i + 1];
        const type = state.types[i];
        const ae = state.announceEnds[i];
        const card = document.createElement('div');
        card.className = 'ed-seg' + (type === 'word+announce' ? ' announce' : '');

        // ヘッダ: 単語番号 + 時間 + type トグル
        const head = document.createElement('div');
        head.className = 'ed-seg-head';
        head.innerHTML = `<span class="ed-seg-title">単語 ${i + 1}</span>
          <span class="ed-seg-time">${fmt(segStart)}s – ${fmt(segEnd)}s（${fmt(segEnd - segStart)}s）</span>`;
        const typeSeg = document.createElement('div');
        typeSeg.className = 'seg ed-type-seg';
        typeSeg.innerHTML = `
          <button class="seg-btn ${type === 'word' ? 'active' : ''}" data-type="word">単語</button>
          <button class="seg-btn ${type === 'word+announce' ? 'active' : ''}" data-type="word+announce">📢付</button>`;
        typeSeg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
          state = SplitEditor.setType(state, i, b.dataset.type); render();
        }));
        head.appendChild(typeSeg);
        card.appendChild(head);

        // 試聴（この単語 = start〜end）
        const rowPlay = document.createElement('div');
        rowPlay.className = 'ed-row';
        rowPlay.innerHTML = `<span class="ed-row-label">試聴</span>`;
        const playBtn = playButton('▶ この単語', `seg${i}`, segStart, segEnd);
        rowPlay.appendChild(playBtn);
        card.appendChild(rowPlay);

        // 境界（このセグメントの開始 = bounds[i]）の微調整・削除。i=0 は先頭(0固定)なので不可。
        if (i > 0) {
          const rowB = document.createElement('div');
          rowB.className = 'ed-row';
          rowB.innerHTML = `<span class="ed-row-label">境界(頭)</span>`;
          rowB.appendChild(miniBtn('−', () => { state = SplitEditor.nudgeBoundary(state, i, -NUDGE); render(); }));
          const val = document.createElement('span');
          val.className = 'ed-val'; val.textContent = `${fmt(segStart)}s`;
          rowB.appendChild(val);
          rowB.appendChild(miniBtn('＋', () => { state = SplitEditor.nudgeBoundary(state, i, NUDGE); render(); }));
          rowB.appendChild(miniBtn('🗑', () => { state = SplitEditor.removeBoundary(state, i); render(); }, true));
          card.appendChild(rowB);
        }

        // announce_end（word+announce のみ）：単語本体の開始位置を調整 + 試聴
        if (type === 'word+announce') {
          const rowA = document.createElement('div');
          rowA.className = 'ed-row';
          rowA.innerHTML = `<span class="ed-row-label">本体の頭</span>`;
          rowA.appendChild(miniBtn('−', () => { state = SplitEditor.nudgeAnnounceEnd(state, i, -NUDGE); render(); }));
          const val = document.createElement('span');
          val.className = 'ed-val';
          val.textContent = (ae != null ? `${fmt(ae)}s` : '未設定');
          rowA.appendChild(val);
          rowA.appendChild(miniBtn('＋', () => { state = SplitEditor.nudgeAnnounceEnd(state, i, NUDGE); render(); }));
          const from = (ae != null ? ae : segStart);
          rowA.appendChild(playButton('▶ 本体', `ann${i}`, from, segEnd));
          card.appendChild(rowA);
        }

        listEl.appendChild(card);
      }
    }

    function miniBtn(label, onClick, danger) {
      const b = document.createElement('button');
      b.className = 'ed-mini-btn' + (danger ? ' danger' : '');
      b.type = 'button'; b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    }
    function playButton(label, key, from, to) {
      const b = document.createElement('button');
      b.className = 'ed-play-btn'; b.type = 'button'; b.dataset.key = key; b.textContent = label;
      b.addEventListener('click', () => {
        if (previewKey === key) stopPreview(); else play(from, to, key);
      });
      return b;
    }

    // ---- ツールバー: 境界追加 / 自動分割に戻す ----
    addBtn.addEventListener('click', () => {
      // 追加位置は入力で受ける（素のprompt。最小実装）。既定は最長セグメントの中央。
      let longest = 0, li = 0;
      for (let i = 0; i < state.bounds.length - 1; i++) {
        const len = state.bounds[i + 1] - state.bounds[i];
        if (len > longest) { longest = len; li = i; }
      }
      const suggest = ((state.bounds[li] + state.bounds[li + 1]) / 2).toFixed(2);
      const ans = prompt(`新しい境界の時刻（秒, 0〜${fmt(state.duration)}）`, suggest);
      if (ans == null) return;
      const t = parseFloat(ans);
      if (!isFinite(t)) return;
      state = SplitEditor.addBoundary(state, t);
      render();
    });
    resetBtn.addEventListener('click', () => {
      if (!confirm('この画面を開いたときの状態に戻します（この場の編集を破棄）。よろしいですか？')) return;
      state = SplitEditor.pageToState(page); // 編集画面を開いた時点（保存済み）の状態へ
      render();
    });

    // ---- 保存 / キャンセル ----
    saveBtn.addEventListener('click', async () => {
      stopPreview();
      const newPage = SplitEditor.stateToPage(page, state);
      currentBook.book.pages[pageIdx] = newPage;
      // per-book の派生キャッシュを更新（splitVersion は現行のまま。manualEdited で保護）。
      const meta = Object.assign({}, currentBook, {
        splitVersion: (currentBook.splitVersion != null ? currentBook.splitVersion : Splitter.SPLIT_VERSION),
      });
      await DB.updateBookMeta(meta);
      currentBook = meta;
      // 依存する再生データを作り直す
      buildPlaylist(currentBook);
      configureListen(currentBook);
      renderListenOptions();
      renderPages(currentBook);
      revoke();
      // ②へ戻る
      const li = stack.indexOf('editor');
      if (li >= 0) stack.length = li; // editor を積む前の位置へ
      ctxTitle.textContent = currentBook.name;
      showView('pages');
    });
    cancelBtn.addEventListener('click', () => { revoke(); goBack(); });

    return { open, stopPreview, render };
  })();

  // ================= 単語テキストの手動修正（Issue #4 テキスト編集） =================
  // 単語一覧②のセルの編集ボタン/長押しから開く。漢字・ピンイン・訳を手で直して
  // book.vocab の該当 page/index を上書きし、low_confidence を false に落とす（手で直した=信頼）。
  // 保存は DB.updateBookMeta。vocab は page+index キーの派生とは独立した辞書なので、
  // SPLIT_VERSION 更新・境界編集(editor.js)後も紐付けは保たれる（既存設計を壊さない）。
  const TextEdit = (() => {
    const modal = document.getElementById('text-edit-modal');
    const titleEl = document.getElementById('te-title');
    const subEl = document.getElementById('te-sub');
    const hanziEl = document.getElementById('te-hanzi');
    const pinyinEl = document.getElementById('te-pinyin');
    const glossEl = document.getElementById('te-gloss');
    const noteEl = document.getElementById('te-note');
    const cancelBtn = document.getElementById('te-cancel');
    const saveBtn = document.getElementById('te-save');

    let curPage = null;   // 対象セグメントの page
    let curIndex = -1;    // 対象セグメントの seg.index
    let curWasLow = false;

    function open(page, segIndex, pageNo, wordNo) {
      if (!currentBook) return;
      // vocab がまだ無ければ空辞書を用意（テキスト未読込の単語帳でも手入力で作れる）。
      if (!currentBook.vocab) currentBook.vocab = {};
      curPage = page;
      curIndex = segIndex;
      const key = `${page}/${segIndex}`;
      const t = currentBook.vocab[key] || { hanzi: '', pinyin: '', gloss: '', low_confidence: false };
      curWasLow = !!t.low_confidence;
      subEl.textContent = `ページ ${String(pageNo).padStart(3, '0')} · 単語 ${wordNo}`;
      hanziEl.value = t.hanzi || '';
      pinyinEl.value = t.pinyin || '';
      glossEl.value = t.gloss || '';
      noteEl.textContent = curWasLow
        ? '認識が不確か（?）な単語です。直して保存すると「?」が外れます。'
        : '保存すると一覧・再生画面・ロック画面に即反映されます。';
      noteEl.classList.toggle('warn', curWasLow);
      modal.classList.remove('hidden');
      setTimeout(() => { try { hanziEl.focus(); } catch (e) {} }, 50);
    }

    function close() { modal.classList.add('hidden'); }

    async function save() {
      if (!currentBook || curPage == null) return;
      const key = `${curPage}/${curIndex}`;
      const entry = {
        hanzi: hanziEl.value.trim(),
        pinyin: pinyinEl.value.trim(),
        gloss: glossEl.value.trim(),
        low_confidence: false, // 手で直した = 信頼できる
      };
      // 新しい辞書を作って差し替える（既存参照を壊さず、保存対象を明確に）。
      const vocab = Object.assign({}, currentBook.vocab, { [key]: entry });
      const meta = Object.assign({}, currentBook, { vocab });
      await DB.updateBookMeta(meta);
      currentBook = meta;
      // 依存する表示を全部作り直して即反映（一覧・機能A再生ラベル・機能Bラベル・ロック画面）。
      buildPlaylist(currentBook, { preserveIndex: true }); // text 再付与。再生位置は保つ
      configureListen(currentBook); // 機能B の words を作り直し（テキスト参照は listen 側で毎回引く）
      renderPages(currentBook);     // 一覧セルを再描画（? の有無・漢字/ピンインを更新）
      refreshVocabBar();
      // 全画面プレーヤー表示中なら、いま鳴っている単語のラベルも更新する。
      if (typeof Player !== 'undefined' && Player.refreshCurrent) Player.refreshCurrent();
      // 再描画でセルDOMが差し替わっているので、再生中セルのハイライトを貼り直す。
      const pIdx = (typeof Player !== 'undefined' && Player.getIndex) ? Player.getIndex() : -1;
      if (pIdx >= 0) highlightCell(pIdx);
      if (typeof Listen !== 'undefined' && Listen.refreshText) Listen.refreshText();
      close();
    }

    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', () => { save().catch((e) => alert('保存できませんでした: ' + e.message)); });
    // 背景タップで閉じる（シート外）。Enter で保存。
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    [hanziEl, pinyinEl, glossEl].forEach((el) => el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
    }));

    return { open, close };
  })();

  // ---- 聞き流し 全画面プレーヤー（円形プログレス）の DOM とコントローラ ----
  const lp = document.getElementById('listen-player');
  const lpSub = document.getElementById('lp-sub');
  const lpWord = document.getElementById('lp-word');
  const lpText = document.getElementById('lp-text');
  const lpHanzi = document.getElementById('lp-hanzi');
  const lpPinyin = document.getElementById('lp-pinyin');
  const lpGloss = document.getElementById('lp-gloss');
  const lpCur = document.getElementById('lp-cur');
  const lpTotal = document.getElementById('lp-total');
  const lpRingFg = document.getElementById('lp-ring-fg');
  const lpRingDot = document.getElementById('lp-ring-dot');
  const lpLoading = document.getElementById('lp-loading');
  const lpLoadingText = document.getElementById('lp-loading-text');
  const lpRingWrap = document.getElementById('lp-ring-wrap');
  const lpToggle = document.getElementById('lp-toggle');
  const lpPrev = document.getElementById('lp-prev');
  const lpNext = document.getElementById('lp-next');
  const lpCollapse = document.getElementById('lp-collapse');
  const lpStar = document.getElementById('lp-star');
  // 聞き流しミニ（全画面を閉じても再生を続け、下部に常駐）
  const lm = document.getElementById('listen-mini');
  const lmLabel = document.getElementById('lm-label');
  const lmFill = document.getElementById('lm-progress-fill');
  const lmToggle = document.getElementById('lm-toggle');
  const lmExpand = document.getElementById('lm-expand');
  let lmPrefix = '聞き流し'; // スター聞き流しは「★ 聞き流し」

  // 聞き流しプレーヤーのスターボタンを現在語の starred で更新。
  function updateListenStar() {
    if (!lpStar) return;
    const cw = (typeof Listen !== 'undefined' && Listen.currentWord) ? Listen.currentWord() : null;
    const on = !!(cw && isStarred(currentBook, cw.page, cw.segIndex));
    lpStar.classList.toggle('on', on);
    lpStar.setAttribute('aria-pressed', String(on));
    lpStar.setAttribute('aria-label', on ? 'スターを外す' : 'スターを付ける');
  }

  const RING_R = 106;
  const RING_C = 2 * Math.PI * RING_R; // 円周（stroke-dasharray 用）
  lpRingFg.style.strokeDasharray = String(RING_C);
  lpRingFg.style.strokeDashoffset = String(RING_C);

  function setRing(ratio) {
    ratio = Math.min(Math.max(ratio, 0), 1);
    lpRingFg.style.strokeDashoffset = String(RING_C * (1 - ratio));
    // 先端ドットを弧の終端へ配置（-90°基準＝12時から時計回り）
    const ang = -Math.PI / 2 + ratio * 2 * Math.PI;
    lpRingDot.setAttribute('cx', String(120 + RING_R * Math.cos(ang)));
    lpRingDot.setAttribute('cy', String(120 + RING_R * Math.sin(ang)));
  }

  // 円形プログレス中央の単語表示。text（漢字・ピンイン・訳）があれば漢字(大)・ピンイン(小)・
  // 訳(極小)を出し、無ければ「単語 N」の番号フォールバック。切り替わるたびに呼ぶ。
  function renderListenWord(text, wordNo) {
    const hasText = !!(text && (text.hanzi || text.pinyin));
    lpText.classList.toggle('hidden', !hasText);
    lpWord.classList.toggle('hidden', hasText);
    if (hasText) {
      lpHanzi.textContent = text.hanzi || '';
      lpPinyin.textContent = text.pinyin || '';
      const hasGloss = !!(text.gloss && text.gloss.trim());
      lpGloss.classList.toggle('hidden', !hasGloss);
      lpGloss.textContent = hasGloss ? text.gloss : '';
    } else {
      lpWord.textContent = `単語 ${wordNo}`;
    }
  }

  function showListenFull(info) {
    lpSub.textContent = info.mode === 'starred'
      ? `★ スター単語 · ${info.wordCount}語`
      : `単語のみ · ${info.size}語（${info.from}–${info.to}）`;
    lpTotal.textContent = String(info.wordCount);
    lpCur.textContent = '1';
    // 開始時点は最初の語（テキストは onProgress/refreshText が確定するまで番号表示）。
    renderListenWord(null, 1);
    setRing(0);
    updateListenStar();
    lmPrefix = info.mode === 'starred' ? '★ 聞き流し' : '聞き流し';
    lmLabel.textContent = `${lmPrefix} 1/${info.wordCount}`;
    lmFill.style.width = '0%';
    hideListenMini(); // 新しいトラックは全画面で始める
    listenUI.onPlaying(false); // 準備中は停止表示（準備中にミニ化しても ▶ の見た目を状態と揃える）
    lp.classList.remove('hidden');
  }

  // 全画面 ⇄ ミニ の切替。再生は止めない（停止は Listen.stop → hideFull で両方閉じる）。
  function showListenMini() {
    lp.classList.add('hidden');
    lm.classList.remove('hidden');
    document.body.classList.add('listen-mini-open');
  }
  function hideListenMini() {
    lm.classList.add('hidden');
    document.body.classList.remove('listen-mini-open');
  }
  function expandListen() {
    hideListenMini();
    lp.classList.remove('hidden');
  }

  // Listen → UI（app.js が注入）
  const listenUI = {
    onPlaying(playing) {
      lp.classList.toggle('paused', !playing);
      lp.classList.toggle('playing-anim', playing);
      lpToggle.querySelector('.ic-play').classList.toggle('hidden', playing);
      lpToggle.querySelector('.ic-pause').classList.toggle('hidden', !playing);
      lm.classList.toggle('paused', !playing);
      lm.classList.toggle('playing-anim', playing);
      lmToggle.querySelector('.ic-play').classList.toggle('hidden', playing);
      lmToggle.querySelector('.ic-pause').classList.toggle('hidden', !playing);
    },
    onProgress(ratio, wordNo, wordCount, text) {
      setRing(ratio);
      // ミニ: 「聞き流し 12/50 · 漢字」＋進捗バー
      const hanzi = text && text.hanzi;
      lmLabel.textContent = `${lmPrefix} ${wordNo}/${wordCount}` + (hanzi ? ` · ${hanzi}` : '');
      lmFill.style.width = `${(ratio * 100).toFixed(2)}%`;
      lpCur.textContent = String(wordNo);
      lpTotal.textContent = String(wordCount);
      // 中央表示: テキストがあれば漢字・ピンイン、無ければトラック内の語順「単語 N」。
      renderListenWord(text, wordNo);
      updateListenStar();
    },
    onLoading(loading, done, all) {
      lpLoading.classList.toggle('hidden', !loading);
      lpRingWrap.classList.toggle('dim', loading);
      if (loading && done != null) lpLoadingText.textContent = `音声を用意中… ${done}/${all}`;
      // 準備中にミニ化された場合もミニで進み具合が分かるように
      if (loading) lmLabel.textContent = done != null ? `音声を用意中… ${done}/${all}` : '音声を用意中…';
    },
    onHeader(h) {
      lpSub.textContent = h.mode === 'starred'
        ? `★ スター単語 · ${h.wordCount}語`
        : `単語のみ · ${h.size}語（${h.from}–${h.to}）`;
      lpTotal.textContent = String(h.wordCount);
    },
    hideFull() { lp.classList.add('hidden'); hideListenMini(); }, // 停止時: 全画面もミニも閉じる
    onNotice(kind, err) {
      if (kind === 'blocked') {
        // iOS が自動再開を許さなかった → ▶ タップ（ユーザー操作）なら再開できる。
        showToast('▶ をタップして再生してください', { type: 'info' });
      } else if (kind === 'build-failed') {
        Listen.stop();
        alert('聞き流し音声の準備に失敗しました。もう一度お試しください。\n' +
          `(${(err && (err.name || err.message)) || 'unknown'})`);
      }
    },
  };

  lpToggle.addEventListener('click', () => Listen.toggle());
  lpPrev.addEventListener('click', () => Listen.prev());
  lpNext.addEventListener('click', () => Listen.next());
  // ▼: 再生は続けたままミニ化（他の画面を操作できる）。
  lpCollapse.addEventListener('click', showListenMini);
  lmToggle.addEventListener('click', () => Listen.toggle());
  lmExpand.addEventListener('click', expandListen);
  lm.addEventListener('click', (e) => { if (e.target.closest('button')) return; expandListen(); });
  if (lpStar) lpStar.addEventListener('click', () => {
    const cw = Listen.currentWord && Listen.currentWord();
    if (!cw) return;
    toggleStar(cw.page, cw.segIndex).then(() => updateListenStar());
  });

  // 「スター単語を聞き流す」入口。スター単語だけを連結1本で再生（チャンク分けなし）。
  const listenStarBtn = document.getElementById('listen-star-btn');
  if (listenStarBtn) listenStarBtn.addEventListener('click', () => {
    const indices = starredListenIndices();
    if (indices.length === 0) return; // 0件は無効表示だが二重ガード
    showListenFull({ mode: 'starred', wordCount: indices.length });
    Listen.playStarred(indices);
  });

  // 上部タブ（単語 / 聞き流し）
  document.getElementById('book-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('#book-tabs .tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-words').classList.toggle('active', btn.dataset.tab === 'words');
    document.getElementById('tab-listen').classList.toggle('active', btn.dataset.tab === 'listen');
  });

  // ================= タイピング学習 + 忘却曲線復習（SRS） =================
  // 出題候補は playlist（effStart/end/text/starred を持つ全単語）から組み立てる。
  //   scope='all'     : hanzi が空でない全単語
  //   scope='starred' : そのうち starred のもの
  //   scope='review'  : そのうち SRS 復習キュー（nextDue <= 今日）のもの
  // 訳モードの「gloss も空でない」絞り込みは Typing 側で行う（形式トグルで動的に変わるため）。
  function typingCandidates(scope) {
    const srs = currentBook && currentBook.srs;
    const today = SRS.toDateStr(new Date());
    // review スコープは「期限到来キーの集合」に含まれる単語だけ許可する。
    const dueSet = (scope === 'review')
      ? new Set(SRS.dueKeys(srs, today)) : null;
    const out = [];
    for (const w of playlist) {
      const t = w.text;
      const hanzi = t && t.hanzi ? String(t.hanzi).trim() : '';
      if (!hanzi) continue; // hanzi 空は対象外（音声だけの単語は出題しない）
      if (scope === 'starred' && !w.starred) continue;
      if (scope === 'review') {
        if (!dueSet.has(`${w.page}/${w.segIndex}`)) continue;
      }
      out.push({
        page: w.page,
        segIndex: w.segIndex,
        effStart: w.effStart,
        end: w.end,
        // 「単語+訳」だけを再生する wordonly 抽出（機能Bと同一）に渡す seg 相当。
        // wordPlayRange/wordonlyRange が参照するのは start/end/announce_end/index。
        seg: { index: w.segIndex, start: w.start, end: w.end, type: w.type, announce_end: w.announce_end },
        hanzi,
        pinyin: t && t.pinyin ? String(t.pinyin) : '',
        gloss: t && t.gloss ? String(t.gloss) : '',
        starred: !!w.starred,
      });
    }
    return out;
  }

  // 現在の単語帳の復習キュー件数（今日以前）。バッジ表示に使う。
  function currentDueCount() {
    if (!currentBook) return 0;
    return SRS.dueCount(currentBook.srs, SRS.toDateStr(new Date()));
  }

  // タイピング導線の「復習 N」専用ボタン（復習キュー件数）を更新。0件なら隠す。
  function refreshTypingEntry() {
    const btn = document.getElementById('typing-review-btn');
    const cnt = document.getElementById('typing-review-count');
    if (!btn) return;
    const n = currentDueCount();
    if (cnt) cnt.textContent = n > 0 ? `復習 ${n}` : '復習';
    btn.classList.toggle('hidden', n === 0);
  }

  // SRS を差し替え保存し、currentBook を更新（vocab と同じく book メタの一部）。
  async function saveSrs(newSrs) {
    if (!currentBook) return;
    const meta = Object.assign({}, currentBook, { srs: newSrs });
    await DB.updateBookMeta(meta);
    currentBook = meta;
  }

  // 「実は正解」: vocab[page/index].hanzi を入力値で上書き・low_confidence=false で保存。
  // テキスト未読込の単語帳でも空辞書を用意して作る（TextEdit と同じ流儀）。
  async function markActuallyCorrect(page, segIndex, hanzi) {
    if (!currentBook) return;
    const key = `${page}/${segIndex}`;
    const cur = (currentBook.vocab && currentBook.vocab[key]) || null;
    const entry = Object.assign(
      { hanzi: '', pinyin: '', gloss: '', low_confidence: false },
      cur,
      { hanzi: String(hanzi).trim(), low_confidence: false },
    );
    const vocab = Object.assign({}, currentBook.vocab || {}, { [key]: entry });
    const meta = Object.assign({}, currentBook, { vocab });
    await DB.updateBookMeta(meta);
    currentBook = meta;
    // 一覧・機能A/Bの表示へ即反映（漢字が変わる・? が外れる）。
    buildPlaylist(currentBook, { preserveIndex: true });
    configureListen(currentBook);
    renderPages(currentBook);
    refreshVocabBar();
  }

  // Typing へフックを注入（1回だけ）。
  Typing.init({
    getCandidates: (scope) => typingCandidates(scope),
    getBlobFor: (page) => (currentBook ? DB.getAudio(currentBook.id, page) : null),
    getSrs: () => (currentBook && currentBook.srs) || {},
    saveSrs: (newSrs) => saveSrs(newSrs),
    markActuallyCorrect: (page, segIndex, hanzi) => markActuallyCorrect(page, segIndex, hanzi),
    today: () => SRS.toDateStr(new Date()),
    // 閉じたら一覧・バッジを最新化（間違えた単語のキュー入り等を反映）。
    onClose: () => { renderPages(currentBook); refreshVocabBar(); refreshTypingEntry(); },
  });

  // タイピングを開く導線
  const typingOpenBtn = document.getElementById('typing-open-btn');
  if (typingOpenBtn) typingOpenBtn.addEventListener('click', () => {
    if (!currentBook) return;
    Typing.open();
  });
  // 「復習 N」ボタン: 範囲選択を飛ばして復習キューセッションを直接開始（仕様どおり）。
  const typingReviewBtn = document.getElementById('typing-review-btn');
  if (typingReviewBtn) typingReviewBtn.addEventListener('click', () => {
    if (!currentBook) return;
    Typing.openReview();
  });
  // 全画面の閉じるボタン（ヘッダー）
  const typingCloseBtn = document.getElementById('typing-close');
  if (typingCloseBtn) typingCloseBtn.addEventListener('click', () => Typing.close());

  // --- ユーティリティ ---
  function pageIdFromName(name, idx) {
    const base = name.replace(/\.[^.]+$/, '');
    const m = base.match(/(\d{1,4})/);
    if (m) return m[1].padStart(3, '0');
    return String(idx + 1).padStart(3, '0');
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // --- 起動 ---
  showView('books');
  renderBooks();
})();
