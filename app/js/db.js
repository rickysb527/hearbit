/* IndexedDB ラッパー。
 * 単語帳ごとに【元音声Blob群 + 分割位置JSON】を保存する。
 *
 * ストア構成:
 *   books  : { id, name, createdAt, book(segments.json相当) }  ← メタデータのみ（軽い）
 *   audio  : { key, blob }  key = `${bookId}/${page}`          ← 元音声Blob（重い・別ストア）
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
      Promise.resolve(fn(s)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
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
     * meta: { id, name, createdAt, book }
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

    /* あるページの元音声Blobを取得 */
    async getAudio(bookId, page) {
      const rec = await tx('audio', 'readonly', s => reqP(s.get(`${bookId}/${page}`)));
      return rec ? rec.blob : null;
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
