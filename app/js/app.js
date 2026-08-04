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
      el.addEventListener('click', () => {
        openBook(b).catch((err) => { hideResplit(); alert('単語帳を開けませんでした: ' + err.message); });
      });
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

  // ================= 機能B: 聞き流し =================
  // 単語リスト（単語+訳の抽出は再生時に遅延確定）を Listen に渡す。
  function configureListen(book) {
    listenWords = ListenBuild.collectWords(book.book); // silences 無し = wordonly は遅延確定
    Listen.configure({
      bookName: book.name,
      words: listenWords,
      getBlobFor: (page) => DB.getAudio(book.id, page),
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

  // ---- 聞き流し 全画面プレーヤー（円形プログレス）の DOM とコントローラ ----
  const lp = document.getElementById('listen-player');
  const lpSub = document.getElementById('lp-sub');
  const lpWord = document.getElementById('lp-word');
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

  function showListenFull(info) {
    lpSub.textContent = `単語のみ · ${info.size}語（${info.from}–${info.to}）`;
    lpTotal.textContent = String(info.wordCount);
    lpCur.textContent = '1';
    lpWord.textContent = `単語 ${info.from}`;
    setRing(0);
    lp.classList.remove('hidden');
  }

  // Listen → UI（app.js が注入）
  const listenUI = {
    onPlaying(playing) {
      lp.classList.toggle('paused', !playing);
      lp.classList.toggle('playing-anim', playing);
      lpToggle.querySelector('.ic-play').classList.toggle('hidden', playing);
      lpToggle.querySelector('.ic-pause').classList.toggle('hidden', !playing);
    },
    onProgress(ratio, wordNo, wordCount) {
      setRing(ratio);
      lpCur.textContent = String(wordNo);
      lpTotal.textContent = String(wordCount);
      // 中央表示: 通し番号ではなくトラック内の語順（散歩中のチラ見で「今何語目か」）
      lpWord.textContent = `単語 ${wordNo}`;
    },
    onLoading(loading, done, all) {
      lpLoading.classList.toggle('hidden', !loading);
      lpRingWrap.classList.toggle('dim', loading);
      if (loading && done != null) lpLoadingText.textContent = `音声を用意中… ${done}/${all}`;
    },
    onHeader(h) {
      lpSub.textContent = `単語のみ · ${h.size}語（${h.from}–${h.to}）`;
      lpTotal.textContent = String(h.wordCount);
    },
    hideFull() { lp.classList.add('hidden'); },
  };

  lpToggle.addEventListener('click', () => Listen.toggle());
  lpPrev.addEventListener('click', () => Listen.prev());
  lpNext.addEventListener('click', () => Listen.next());
  lpCollapse.addEventListener('click', () => { Listen.stop(); });

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
