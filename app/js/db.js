/* IndexedDB ラッパー。
 * 単語帳ごとに【元音声Blob群 + 分割位置JSON(=派生キャッシュ)】を保存する。
 *
 * ストア構成:
 *   books  : { id, name, createdAt, splitVersion, book(segments.json相当) }
 *            splitVersion = book.pages を生成した分割ロジックの Splitter.SPLIT_VERSION。
 *            book.pages（分割結果）は「元音声から再計算できる派生キャッシュ」で、
 *            オープン時に splitVersion が現行と不一致なら元音声から作り直す。
 *            → 元音声Blobが常に真実の源。分割ロジックを直しても再投入不要で反映される。
 *   audio  : { key, blob }  key = `${bookId}/${page}`          ← 元音声Blob（重い・別ストア／真実の源）
 *
 * 分割後の音声は保存しない。再生時に元音声の start〜end を位置指定で鳴らす（容量最適化）。
 */
const DB = (() => {
  const DB_NAME = 'vocab-player';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('audio')) {
          db.createObjectStore('audio', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      let fnDone = false;
      let txDone = false;
      let failed = false;

      const settle = () => {
        // fn（reqPの解決 = request値の確定）と oncomplete の両方が揃ってから解決する。
        // これにより oncomplete が先に発火しても result を取りこぼさない。
        if (fnDone && txDone && !failed) resolve(result);
      };
      const fail = (err) => { if (!failed) { failed = true; reject(err); } };

      Promise.resolve(fn(s)).then(
        r => { result = r; fnDone = true; settle(); },
        err => fail(err)
      );
      t.oncomplete = () => { txDone = true; settle(); };
      t.onerror = () => fail(t.error);
      t.onabort = () => fail(t.error);
    }));
  }

  function reqP(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return {
    /* 単語帳メタデータ一覧 */
    async listBooks() {
      return tx('books', 'readonly', s => reqP(s.getAll()));
    },

    async getBook(id) {
      return tx('books', 'readonly', s => reqP(s.get(id)));
    },

    /* 単語帳を保存（メタ + 各ページ音声Blob）
     * meta: { id, name, createdAt, splitVersion, book }
     * audioMap: { [page]: Blob }
     */
    async saveBook(meta, audioMap) {
      await tx('books', 'readwrite', s => s.put(meta));
      // 音声は件数が多いので1トランザクションでまとめて put
      await tx('audio', 'readwrite', s => {
        for (const page of Object.keys(audioMap)) {
          s.put({ key: `${meta.id}/${page}`, blob: audioMap[page] });
        }
      });
      return meta;
    },

    /* 派生キャッシュ（分割結果 book + splitVersion）だけを更新する。
     * 元音声Blob（audioストア）はそのまま。再分割の結果を書き戻すのに使う。
     * meta は最新の book / splitVersion を含む完全なメタオブジェクト。
     */
    async updateBookMeta(meta) {
      await tx('books', 'readwrite', s => s.put(meta));
      return meta;
    },

    /* あるページの元音声Blobを取得 */
    async getAudio(bookId, page) {
      const rec = await tx('audio', 'readonly', s => reqP(s.get(`${bookId}/${page}`)));
      return rec ? rec.blob : null;
    },

    /* 元音声Blobが全ページ揃っているか（マイグレーション可否の判定に使う）。
     * pages: book.pages（page識別子を持つ配列）。1つでも欠けたら false。
     */
    async hasAllAudio(bookId, pages) {
      for (const p of pages) {
        const rec = await tx('audio', 'readonly', s => reqP(s.get(`${bookId}/${p.page}`)));
        if (!rec || !rec.blob) return false;
      }
      return true;
    },

    async deleteBook(id) {
      const book = await this.getBook(id);
      await tx('books', 'readwrite', s => s.delete(id));
      if (book && book.book && book.book.pages) {
        await tx('audio', 'readwrite', s => {
          for (const p of book.book.pages) s.delete(`${id}/${p.page}`);
        });
      }
    },
  };
})();
