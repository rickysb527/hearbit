# Hearbit（機能C: PWA本体）

**聞きたい言葉を、すぐそこに。**
音声を持ち込んでブラウザ内で単語単位に分割・再生する汎用プレーヤー（PWA）。
素のHTML/CSS/JS。ビルド・CDN・依存なし。オフラインで動作。

ブランド: **Hearbit**（ティール=通常/選択/ブランド × オレンジ=いま再生中）。
デザインは `DESIGN.md`、ブランド定義は `../../vocab-audio-separator/data/brand.md` 準拠。

## 構成

```
app/
  index.html          Hearbitブランドの3画面UI + PWAメタ + SW登録
  manifest.json        PWAマニフェスト（Hearbit / theme_color=ティール / standalone）
  sw.js                Service Worker（App Shellをキャッシュ・オフライン起動）＋ VERSION（版番号）
  icons/               波形ロゴのSVG + PNG（192/512/maskable/apple-touch/favicon）
  css/styles.css       Hearbitデザインシステム（ティール×オレンジ・ライト/ダーク変数）
  js/
    db.js              IndexedDB: 単語帳メタ(+splitVersion) + 元音声Blob（分割結果は派生キャッシュ）
    splitter.js        Web Audio API 無音検知・分割（Python版ロジック移植）＋ SPLIT_VERSION 定義
    editor.js          分割の手動編集（#4）の純ロジック（境界/type/announce_end の再構築）
    player.js          機能Aの再生エンジン: 区間再生 + 前/次の単語 + シーク + Media Session（ハンドラは聞き流しにも委譲）
    listen-build.js    機能Bの純関数: wordonly（単語+訳）抽出・チャンク分割・WAV 変換（encodeWav）
    listen.js          機能Bの再生: 連結1本を WAV(blob) にして <audio> 要素で再生（decode 用 AudioContext は再生に使わない）
    typing.js / srs.js タイピング学習・忘却曲線復習
    version.js         APP_VERSION（いま動いているコードの版。sw.js の VERSION と一致させる）
    app.js             3階層ナビ・番号グリッド・プレーヤー/ミニ連携 + 分割の再計算 + 手動編集UI + 更新バナー
  verify/
    verify_split.js    JS分割ロジックを Node で走らせ segments.json と突き合わせ
    verify_listen.js   機能B（wordonly抽出/チャンク）を build_chunks.py と突き合わせ
    verify_cache.js    データ保持方式（バージョン付きキャッシュ・再分割・移行）の headless 検証
    verify_editor.js   分割の手動編集（純ロジック + 手編集ページの再分割保護）の headless 検証
    verify_listen_playback.js  機能Bの再生ロジック（<audio> 方式・アンロック・中断・WAV 変換）
    verify_version.js  APP_VERSION と sw.js VERSION の一致・SW プリキャッシュの整合
    verify_update.mjs  更新導線（新しい版のデプロイ→バナー→タップで更新）を実Chromeで検証
    verify_dom.mjs     実Chromeの UI 統合テスト（テキスト編集・スター・聞き流し・ミニプレーヤー）
    ほか verify_star / verify_srs / verify_textedit / verify_typing / verify_vocab
```

## データ保持方式（分割のバージョン付きキャッシュ）

**元音声だけが「真実の源」。分割結果は元音声から再計算できる派生キャッシュ**として扱う。

- IndexedDB に保存するのは【元音声Blob群（`audio`ストア）＋ 単語帳メタ（`books`ストア: 名前・ページ順・`book.pages`＝分割結果・`splitVersion`）】。
- `splitter.js` に `SPLIT_VERSION`（分割ロジックのバージョン）を定義。保存時に `meta.splitVersion` として刻む。
- **単語帳オープン時（`app.js` の `ensureSplitCurrent`）**:
  - `meta.splitVersion === Splitter.SPLIT_VERSION` → キャッシュ（`book.pages`）をそのまま使う（速い・再計算なし）。
  - 不一致（コード更新後の初回）→ 元音声Blobから**自動で再分割**してキャッシュと `splitVersion` を更新。`分割を更新中…` オーバーレイを表示。**ユーザーの音声再投入は不要**。
- **SPLIT_VERSION 運用ルール（重要）**: `splitter.js`（無音検知・単語境界・短小結合・アナウンス切り離し）または `listen-build.js`（wordonly 抽出）の**分割・抽出ロジックを変更したら `SPLIT_VERSION` を +1** する。これだけで、既存ユーザーの単語帳が次回オープン時に自動で作り直される（現在 `SPLIT_VERSION = 3`。3 でアナウンス境界の候補からページ冒頭の無音余白を除外）。
- **マイグレーション**: `splitVersion` を持たない旧データも、元音声Blobが揃っていれば同じ経路で自動再分割して移行する。元音声が無い旧データは `needsReimport` として再投入を促す（旧キャッシュのままでも閲覧・再生は可能）。
- **容量**: 派生キャッシュ（`book.pages`）は元々数KB〜数十KBの位置JSONのみ（分割後音声は保存しない方針は不変）。よって「元音声＋派生キャッシュ」の総容量は従来とほぼ同じで、削減の主眼は容量ではなく**再投入不要で修正が反映される運用性**。

## 分割の手動編集（#4）

自動分割で境界ズレ／アナウンス誤判定が残るページを、**手で直して per-book に上書き保存**できる。

- **入口**: ②ページ/単語一覧の各ページ見出しの `✎ 編集` ボタン → 編集画面（`view-editor`）。
- **できること**（1ページ単位）:
  - 各単語（セグメント）の**境界（頭）を ±0.1秒で微調整**／**境界を追加**（時刻入力・最長区間の中央を既定）／**境界を削除**（前後を結合）。
  - **type を `単語`/`📢付`（word/word+announce）で切替**。`📢付` にすると `本体の頭`（announce_end＝アナウンスを飛ばして単語本体が始まる位置）を ±0.1秒で調整できる。
  - **試聴**: `▶ この単語`（境界〜次境界）／`▶ 本体`（announce_end〜end）を編集用 audio 要素（`editor-audio`）で再生。メインの再生（機能A/B）とは独立。
  - `自動分割に戻す`（保存済み＝元の状態へ復帰）／`キャンセル`／`この編集を保存`。
- **保存の中身**: `editor.js` の `stateToPage` が **segments.json と同一形式**の page を再構築し、`manualEdited:true` を付けて `book.pages[idx]` を上書き → `DB.updateBookMeta` で per-book キャッシュを更新。保存後は playlist / 聞き流し / グリッドを作り直す。
  - 付随フィールドの整合: `length=round2(end-start)` を都度再計算。`announce_end` は type=word+announce かつ範囲内のときだけ付与。自動由来の `merged` / `announce_low_confidence` は手動編集で意味が変わるため落とす（再生・聞き流しは参照しない）。`has_announce`/`word_count`/`layout` は再計算（layout は splitter と同一の本体中央値ルール）。
- **保護ロジック（手編集を守る）**: `ensureSplitCurrent` は `page.manualEdited===true` のページを**自動再分割の対象外**にする。よって `SPLIT_VERSION` を上げても、手で直したページだけは上書きされず、同じ単語帳の未編集ページは通常どおり再分割される。
- **アルゴリズム不変**: `splitter.js` / `listen-build.js` の分割・抽出アルゴリズムは変更していない。手動編集は「結果（境界/type/announce_end）の上書き」だけを行う。既存の機能A/B再生は編集後 segments をそのまま使う（型が同一なので追加対応不要）。

## 実装した画面（Hearbit）

- **① 単語帳リスト**: 本アイコンの角丸チップ + 語数 + `✓ オフライン` のカード、下部タブ（単語帳 / 設定）、0件時の空状態、`⊕ 音声を読み込む` 主ボタン（ティール塗り）。
- **② ページ/単語一覧**: 上部タブ（単語 / 聞き流し）、ページ = sticky セクション、番号グリッド（上段=ページ内番号・下段=通し番号 `#128`、アナウンス付きページは `📢` とドット）。再生中セルはオレンジハイライト。
- **③ 再生（機能A）**: 下部常駐のミニプレーヤー（オレンジ波形アニメ + 再生/一時停止）と、拡大した全画面プレーヤー（中央に大きな単語番号・通し番号、シークバー、前/再生/次）。同一の再生状態を共有し拡大縮小しても途切れない。
- **聞き流し（機能B）**: 50/100語の範囲チップ・スター単語の聞き流し → 円形プログレスの全画面プレーヤー（大きく通し番号「No. 51」、小さく範囲内の位置「1 / 50」、漢字・ピンイン・訳）。▼でミニプレーヤー（「聞き流し No.51 (1/50) · 漢字」＋進捗バー）になり、再生を続けたまま単語タブ・単語帳一覧・設定を操作できる。単語帳を開く・単語タップ・タイピング・分割編集・単語帳削除で停止。
- **ミニプレーヤーの位置**: ルート画面（単語帳一覧・設定）では下部タブバーの上に出す（タブバーを覆わない）。
- **設定**: テーマ切替（自動 / ライト / ダーク）、バージョン表示と「更新を確認」。

配色は 2色運用を徹底: **ティール**=通常/選択/ブランド、**オレンジ**=いま再生中（再生中セル・一時停止ボタン・波形・シーク進行）。ライト/ダークは `prefers-color-scheme` + 設定の手動 `data-theme` 上書き。

## PWA機能

- **manifest.json**: `name/short_name: Hearbit`, `theme_color: #0E7C86`(ティール), `background_color: #F7F8FA`, `display: standalone`, アイコン（PNG 192/512/maskable）。
- **Service Worker（sw.js）**: App Shell を保持。**ナビゲーション(HTML)は network-first**（オンライン時は最新を取得・失敗時のみキャッシュ）、**静的アセット(CSS/JS/アイコン)は stale-while-revalidate**（キャッシュを即返しつつ裏で更新）。音声Blobは IndexedDB 側に保存（SWキャッシュ対象外）。
  - **版番号の運用（重要）**: デプロイのたびに `js/version.js` の `APP_VERSION` と `sw.js` の `VERSION` を**両方 +1**（キャッシュ名 `hearbit-v<VERSION>` は自動生成。`activate` で旧キャッシュを削除）。一致は `verify_version.js` で確認。
  - **更新導線**: ホーム画面の PWA はリロードできないため、起動時・SW 入れ替わり時・前面復帰時（60秒間引き）に SW の版を問い合わせ（`GET_VERSION`）、動いているコードより新しければ「新しいバージョンがあります — タップで更新」バナーを出す。再生中に音を止めないよう自動ではなくタップで再読み込み。
  - **取得の新鮮さ**: プリキャッシュは `cache:'reload'`、ページ/アセットの取得は `cache:'no-cache'` で HTTP キャッシュ（GitHub Pages は max-age=600）を経由しない。install 失敗は握りつぶさない（ブラウザが次の update で再試行）。
- **iOS standalone**: `apple-mobile-web-app-capable` / `apple-mobile-web-app-title` / `apple-touch-icon` を用意。ホーム画面に追加でフルスクリーン起動。
- **聞き流しの再生方式**（`js/listen.js`）: 連結1本を WAV(16bit モノラル、44.1/48kHz→1/2) の blob URL にして `<audio>` 要素で再生。Web Audio（AudioBufferSourceNode）で鳴らすと iOS で「⏸表示なのに無音」やホーム画面/画面オフでの停止が起きたため。iOS は操作外の `play()` を拒否するので、範囲チップのタップ直後に無音を play して要素をアンロックしてから構築→再生。拒否された時は一時停止表示＋「▶ をタップして再生」。着信等で OS が要素を止めた時は pause イベントで UI を揃える（自動再開はしない）。
- **Media Session API**（`js/player.js`）: `play` / `pause` / `previoustrack`（前の単語）/ `nexttrack`（次の単語）/ `seekbackward` / `seekforward` を登録。聞き流し中（`Listen.isActive()`）は Listen に委譲し、タイトルは「漢字 ピンイン No.51 (1/50)」。メタデータは `title=単語 N (#通し)`, `artist=単語帳名`, `album=ページNNN`。ロック画面・イヤホン操作に対応。単語はページを跨いで連続移動する（フラットな単語リストで管理）。
  - **末尾/先頭の扱い**: `previoustrack` / `nexttrack` ハンドラは**常に登録しっぱなし**にし、先頭/末尾の抑止は `prev()` / `next()` 側の境界ガード（no-op）で担保する。全画面プレーヤーの ◀◀/▶▶ は境界時に DOM の `disabled` で無効表示。
    - ※以前はハンドラを `null` にトグルして OS 側でボタンを無効化していたが、iOS Safari には「一度 `null` にしたハンドラを関数へ戻してもボタンが無効のまま」になる不具合があり、途中の単語で「次へ」が使えなくなる症状を招いたため、この方針に変更した。

## ローカルで動かす

```bash
# リポジトリ直下（worktree: vocab-audio-separator-pwa）で
python3 -m http.server 8000
# ブラウザで http://localhost:8000/app/ を開く
```

操作: 下部タブ「単語帳」→「⊕ 音声を読み込む」→ 名前入力 →「音声ファイル」で mp3 を複数選択
（`audio/raw/001.mp3`〜`098.mp3` が使える）→「読み込んで分割・保存」。
一覧のカード → ページ/単語一覧 → 番号セルをタップで再生。ミニプレーヤーの `⌃` で全画面プレーヤー、前/次で単語移動。

> Service Worker / Media Session は `http://localhost` でも動作します（secure context 扱い）。
> Media Session のロック画面表示は実機（iPhone/Android）で確認してください。

## iPhoneで確認（同一Wi-Fi）

```bash
# MacのローカルIPを確認
ipconfig getifaddr en0        # 例: 192.168.1.23
python3 -m http.server 8000
```

1. iPhoneのSafariで `http://192.168.1.23:8000/app/` を開く。
2. 「共有」→「**ホーム画面に追加**」で Hearbit アイコンを追加。ホーム画面のアイコンから起動すると standalone（フルスクリーン）で開く。
3. 音声を読み込む（iOSの「ファイル」アプリ経由で mp3 を複数選択可能）→ 分割・保存。
4. 単語セルをタップ → 再生。**画面ロック中もロック画面のメディアコントロール**（再生/一時停止・前/次）で操作可能。イヤホンのボタン操作にも対応。
5. 一度読み込めば端末内データ（IndexedDB）だけで動作 → 電波の無い散歩中でも再生可能。

> 注: Media Session のロック画面操作は https もしくは `localhost` の secure context が要件です。
> LAN の平文 http（`192.168.x.x`）ではブラウザにより一部の PWA/Media 機能が制限される場合があります。
> 確実に検証するには Vercel 等に https でデプロイして開くのが確実です。

## Python版との一致検証（分割ロジック）

```bash
export PATH="/opt/homebrew/bin:$PATH"
node app/verify/verify_split.js       # 代表10ページ
node app/verify/verify_split.js all   # 全98ページ
node app/verify/verify_listen.js all  # 機能B（wordonly/チャンク）
node app/verify/verify_cache.js       # データ保持方式（バージョン付きキャッシュ・再分割・移行）
node app/verify/verify_editor.js      # 分割の手動編集（純ロジック + 手編集ページの再分割保護）
node app/verify/verify_listen_playback.js  # 機能Bの再生ロジック（<audio> 方式）
node app/verify/verify_version.js     # 版番号の一致・SW プリキャッシュ
node app/verify/verify_update.mjs     # 更新導線（実Chrome・自前サーバ）
(cd app && python3 -m http.server 8123 &) && node app/verify/verify_dom.mjs  # 実Chrome UI 統合（要サーバ）
```

現状: 全98ページで セグメント数・cut点（±0.15s）ともに 98/98 一致。
`verify_listen.js all` は全チェック PASS（wordonly 649/650、閾値ぎわ1件は許容）。
`verify_cache.js` は 15/15 PASS（保存時に splitVersion 付与・不一致で自動再分割・一致なら再分割なし・元音声なし旧データは再投入促し）。
`verify_editor.js` は 26/26 PASS（往復の境界/type/announce_end 保持・境界の追加/削除/微調整・type切替とannounce_end・manualEdited付与・手編集ページが SPLIT_VERSION 更新後も保護され未編集ページは再分割）。
`verify_listen_playback.js` 22/22、`verify_dom.mjs` 51/51、`verify_update.mjs` 9/9、`verify_version.js` PASS（2026-11-23 時点）。
