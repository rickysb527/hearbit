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

  // --- ナビゲーション状態 ---
  // 'books'/'settings' はルート階層（ブランドヘッダ+下部タブ）。
  // 'import'/'pages' は下層（コンテキストヘッダ、下部タブ非表示）。
  let stack = ['books'];
  let currentBook = null; // { id, name, book }
  let playlist = [];      // フラットな単語リスト（Player 用）
  let cellEls = [];       // playlist と同じ index のセルDOM（ハイライト用）

  const ROOTS = ['books', 'settings'];

  function isRoot(name) { return ROOTS.includes(name); }

  function showView(name) {
    Object.values(views).forEach(v => v.classList.remove('active'));
    views[name].classList.add('active');

    const root = isRoot(name);
    headerBrand.classList.toggle('hidden', !root);
    headerContext.classList.toggle('hidden', root);
    tabBar.classList.toggle('hidden', !root);

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
    for (const b of books) {
      const pageCount = b.book.pages.length;
      const wordCount = b.book.pages.reduce((s, p) => s + p.word_count, 0);

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
          <div class="book-name"></div>
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
      el.addEventListener('click', () => openBook(b));
      el.querySelector('.book-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`「${b.name}」を削除しますか？`)) { await DB.deleteBook(b.id); renderBooks(); }
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

    const meta = { id: 'book_' + Date.now(), name, createdAt: Date.now(), book: { book: name, pages } };
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

  // ================= ② ページ/単語一覧（番号グリッド） =================
  function openBook(book) {
    currentBook = book;
    Player.stop();
    const wordCount = book.book.pages.reduce((s, p) => s + p.word_count, 0);
    buildPlaylist(book);
    renderPages(book);
    // タブは「単語」に戻す
    document.querySelectorAll('#book-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'words'));
    document.getElementById('tab-words').classList.add('active');
    document.getElementById('tab-listen').classList.remove('active');
    navigate('pages', book.name, `${book.book.pages.length}ページ · ${wordCount}単語`);
  }

  // フラットな単語リストを構築（prev/next・Media Session のため）
  function buildPlaylist(book) {
    playlist = [];
    cellEls = [];
    let serial = 0;
    book.book.pages.forEach((p, pageIdx) => {
      const pageLabel = `ページ ${String(pageIdx + 1).padStart(3, '0')}`;
      let wordNo = 0;
      p.segments.forEach((seg) => {
        wordNo += 1; serial += 1;
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
        });
      });
    });

    Player.configure({
      playlist,
      bookName: book.name,
      getBlobFor: (page) => DB.getAudio(book.id, page),
      onCellChange: highlightCell,
    });
  }

  function highlightCell(index) {
    cellEls.forEach((c, i) => { if (c) c.classList.toggle('playing', i === index); });
    const cell = cellEls[index];
    if (cell && cell.scrollIntoView) cell.scrollIntoView({ block: 'nearest' });
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
      head.innerHTML = `<span>ページ ${String(pageIdx + 1).padStart(3, '0')}</span>
        <span class="ph-count">${announce}${p.word_count}単語</span>`;
      section.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'words-grid';

      let wordNo = 0;
      p.segments.forEach((seg) => {
        wordNo += 1;
        const myFlatIndex = flatIndex++;
        const w = playlist[myFlatIndex];
        const cell = document.createElement('div');
        cell.className = 'cell' + (seg.type === 'word+announce' ? ' announce' : '');
        cell.setAttribute('role', 'button');
        cell.setAttribute('aria-label', `ページ${pageIdx + 1} 単語${wordNo} 通し${w.serial}`);
        cell.innerHTML = `<div class="num">${wordNo}</div><div class="serial">#${w.serial}</div>`;
        cell.addEventListener('click', () => Player.playIndex(myFlatIndex));
        cellEls[myFlatIndex] = cell;
        grid.appendChild(cell);
      });

      section.appendChild(grid);
      pagesGridWrap.appendChild(section);
    });
  }

  // 上部タブ（単語 / 聞き流し）
  document.getElementById('book-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('#book-tabs .tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-words').classList.toggle('active', btn.dataset.tab === 'words');
    document.getElementById('tab-listen').classList.toggle('active', btn.dataset.tab === 'listen');
  });

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
