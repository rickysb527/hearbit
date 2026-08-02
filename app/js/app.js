/* アプリ本体：3階層ナビゲーション、単語帳の読み込み/管理、機能A（タップ再生）。 */
(() => {
  // --- DOM ---
  const views = {
    books: document.getElementById('view-books'),
    import: document.getElementById('view-import'),
    pages: document.getElementById('view-pages'),
    play: document.getElementById('view-play'),
  };
  const headerTitle = document.getElementById('header-title');
  const backBtn = document.getElementById('back-btn');

  const booksList = document.getElementById('books-list');
  const addBookBtn = document.getElementById('add-book-btn');

  const importName = document.getElementById('import-name');
  const importFiles = document.getElementById('import-files');
  const importRunBtn = document.getElementById('import-run-btn');
  const importProgress = document.getElementById('import-progress');
  const importFill = document.getElementById('import-fill');
  const importText = document.getElementById('import-text');
  const importDebug = document.getElementById('import-debug');
  const importDebugOut = document.getElementById('import-debug-out');

  const pagesBookName = document.getElementById('pages-book-name');
  const pagesGrid = document.getElementById('pages-grid');

  const playPageLabel = document.getElementById('play-page-label');
  const wordsGrid = document.getElementById('words-grid');

  // --- ナビゲーション状態 ---
  const stack = ['books'];
  let currentBook = null; // { id, name, book }
  let currentPage = null; // segments.jsonの1ページ分

  function showView(name) {
    Object.values(views).forEach(v => v.classList.remove('active'));
    views[name].classList.add('active');
    backBtn.classList.toggle('hidden', name === 'books');
  }

  function navigate(name, title) {
    stack.push(name);
    headerTitle.textContent = title;
    showView(name);
  }

  function goBack() {
    Player.stop();
    stack.pop();
    const prev = stack[stack.length - 1];
    if (prev === 'books') { headerTitle.textContent = '単語帳'; renderBooks(); }
    else if (prev === 'pages') { headerTitle.textContent = currentBook.name; }
    showView(prev);
  }
  backBtn.addEventListener('click', goBack);

  // --- ① 単語帳一覧 ---
  async function renderBooks() {
    const books = await DB.listBooks();
    booksList.innerHTML = '';
    if (!books.length) {
      booksList.innerHTML = '<div style="color:var(--text-dim);font-size:14px">まだ単語帳がありません。「＋ 単語帳を追加」から音声を読み込んでください。</div>';
    }
    books.sort((a, b) => a.createdAt - b.createdAt);
    for (const b of books) {
      const el = document.createElement('div');
      el.className = 'book-item';
      const pageCount = b.book.pages.length;
      const wordCount = b.book.pages.reduce((s, p) => s + p.word_count, 0);
      const left = document.createElement('div');
      left.innerHTML = `<div>${escapeHtml(b.name)}</div><div class="meta">${pageCount}ページ / ${wordCount}語</div>`;
      left.style.flex = '1';
      left.addEventListener('click', () => openBook(b));
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '🗑';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`「${b.name}」を削除しますか？`)) {
          await DB.deleteBook(b.id);
          renderBooks();
        }
      });
      el.appendChild(left);
      el.appendChild(del);
      booksList.appendChild(el);
    }
  }

  addBookBtn.addEventListener('click', () => {
    importName.value = '';
    importFiles.value = '';
    importRunBtn.disabled = true;
    importProgress.classList.add('hidden');
    importDebug.classList.add('hidden');
    navigate('import', '単語帳を追加');
  });

  // --- 単語帳の読み込み・分割・保存 ---
  function updateImportBtn() {
    importRunBtn.disabled = !(importName.value.trim() && importFiles.files.length);
  }
  importName.addEventListener('input', updateImportBtn);
  importFiles.addEventListener('change', () => {
    if (!importName.value.trim() && importFiles.files.length) {
      // ファイル名から推測しないが、空なら促す
    }
    updateImportBtn();
  });

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
      try {
        pageMeta = await Splitter.analyzePage(buf, pageId);
      } catch (err) {
        debugLines.push(`${pageId}: 解析失敗 ${err.message}`);
        continue;
      }
      pages.push(pageMeta);
      audioMap[pageId] = file; // Blob(File)をそのまま保存
      const flag = pageMeta.has_announce ? ' ★アナウンス' : '';
      debugLines.push(`${pageId}: ${pageMeta.num_segments}seg / ${pageMeta.layout} / ${pageMeta.word_count}語${flag}`);
      await sleep(0); // UIに描画の隙を与える
    }

    importText.textContent = '保存中…';
    importFill.style.width = '100%';

    const meta = {
      id: 'book_' + Date.now(),
      name,
      createdAt: Date.now(),
      book: { book: name, pages },
    };
    await DB.saveBook(meta, audioMap);

    // デバッグ表示（Python版との突き合わせ用）
    const totalSeg = pages.reduce((s, p) => s + p.num_segments, 0);
    const totalWord = pages.reduce((s, p) => s + p.word_count, 0);
    debugLines.unshift(`合計: ${pages.length}ページ / ${totalSeg}セグメント / ${totalWord}語\n`);
    importDebugOut.textContent = debugLines.join('\n');
    importDebug.classList.remove('hidden');

    importText.textContent = '完了。単語帳一覧に戻れます。';
    // 一覧を更新しておく（戻れば反映）
    stack.pop(); // import を抜けたことにする
    headerTitle.textContent = '単語帳';
    await renderBooks();
    showView('books');
    // ナビスタックを books だけに戻す
    stack.length = 1;
  });

  // --- ② ページ一覧 ---
  function openBook(book) {
    currentBook = book;
    pagesBookName.textContent = `${book.book.pages.length}ページ`;
    renderPages();
    navigate('pages', book.name);
  }

  function renderPages() {
    pagesGrid.innerHTML = '';
    const pages = currentBook.book.pages;
    pages.forEach((p, idx) => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.innerHTML = `<div class="num">${idx + 1}</div><div class="sub">${p.word_count}語</div>`;
      cell.addEventListener('click', () => openPage(p, idx));
      pagesGrid.appendChild(cell);
    });
  }

  // --- ③ 再生（機能A） ---
  async function openPage(page, idx) {
    currentPage = page;
    playPageLabel.textContent = `ページ ${String(idx + 1).padStart(3, '0')} — ${page.word_count}語`;
    renderWords(page);
    navigate('play', currentBook.name);
  }

  function renderWords(page) {
    wordsGrid.innerHTML = '';
    // type が word / word+announce のセグメントを単語として番号表示
    let wordNo = 0;
    page.segments.forEach((seg) => {
      wordNo += 1;
      const cell = document.createElement('div');
      cell.className = 'cell' + (seg.type === 'word+announce' ? ' announce' : '');
      const label = seg.type === 'word+announce' ? 'アナウンス+単語' : `単語`;
      cell.innerHTML = `<div class="num">${wordNo}</div><div class="sub">${seg.length.toFixed(1)}s</div>`;
      cell.addEventListener('click', async () => {
        document.querySelectorAll('#words-grid .cell.playing').forEach(c => c.classList.remove('playing'));
        cell.classList.add('playing');
        const blob = await DB.getAudio(currentBook.id, page.page);
        if (!blob) { alert('音声が見つかりません'); return; }
        Player.playSegment(blob, seg, `${label} ${wordNo}`, () => cell.classList.remove('playing'));
      });
      wordsGrid.appendChild(cell);
    });
  }

  // --- ユーティリティ ---
  function pageIdFromName(name, idx) {
    const base = name.replace(/\.[^.]+$/, '');
    const m = base.match(/(\d{1,4})/);
    if (m) return m[1].padStart(3, '0');
    return String(idx + 1).padStart(3, '0');
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // --- 起動 ---
  renderBooks();
})();
