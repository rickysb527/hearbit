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
  sw.js                Service Worker（App Shellをキャッシュ・オフライン起動）
  icons/               波形ロゴのSVG + PNG（192/512/maskable/apple-touch/favicon）
  css/styles.css       Hearbitデザインシステム（ティール×オレンジ・ライト/ダーク変数）
  js/
    db.js              IndexedDB: 単語帳メタ + 元音声Blob（分割音声は保存しない）
    splitter.js        Web Audio API 無音検知・分割（Python版ロジック移植・不変）
    player.js          再生エンジン: 区間再生 + 前/次の単語 + シーク + Media Session
    app.js             3階層ナビ・カード/番号グリッド・ミニ/全画面プレーヤー連携
  verify/
    verify_split.js    JS分割ロジックを Node で走らせ segments.json と突き合わせ
```

## 実装した画面（Hearbit）

- **① 単語帳リスト**: 本アイコンの角丸チップ + 語数 + `✓ オフライン` のカード、下部タブ（単語帳 / 設定）、0件時の空状態、`⊕ 音声を読み込む` 主ボタン（ティール塗り）。
- **② ページ/単語一覧**: 上部タブ（単語 / 聞き流し）、ページ = sticky セクション、番号グリッド（上段=ページ内番号・下段=通し番号 `#128`、アナウンス付きページは `📢` とドット）。再生中セルはオレンジハイライト。
- **③ 再生（機能A）**: 下部常駐のミニプレーヤー（オレンジ波形アニメ + 再生/一時停止）と、拡大した全画面プレーヤー（中央に大きな単語番号・通し番号、シークバー、前/再生/次）。同一の再生状態を共有し拡大縮小しても途切れない。
- **設定**: テーマ切替（自動 / ライト / ダーク）。
- **聞き流しタブ（機能B）**: 枠のみ（連結再生の中身は次段階）。

配色は 2色運用を徹底: **ティール**=通常/選択/ブランド、**オレンジ**=いま再生中（再生中セル・一時停止ボタン・波形・シーク進行）。ライト/ダークは `prefers-color-scheme` + 設定の手動 `data-theme` 上書き。

## PWA機能

- **manifest.json**: `name/short_name: Hearbit`, `theme_color: #0E7C86`(ティール), `background_color: #F7F8FA`, `display: standalone`, アイコン（PNG 192/512/maskable）。
- **Service Worker（sw.js）**: App Shell を保持。**ナビゲーション(HTML)は network-first**（オンライン時は最新を取得・失敗時のみキャッシュ）、**静的アセット(CSS/JS/アイコン)は stale-while-revalidate**（キャッシュを即返しつつ裏で更新）。音声Blobは IndexedDB 側に保存（SWキャッシュ対象外）。
  - **SW更新運用**: `sw.js` の `CACHE`（現在 `hearbit-v1`）を、アセットを変更したコミットで**必ず1つ上げる**（例: `hearbit-v2`）。`activate` で旧キャッシュを削除するため、名前を上げれば総入れ替えで確実に反映される。日常の CSS/JS 変更は stale-while-revalidate で次回アクセス時に自動更新される。
- **iOS standalone**: `apple-mobile-web-app-capable` / `apple-mobile-web-app-title` / `apple-touch-icon` を用意。ホーム画面に追加でフルスクリーン起動。
- **Media Session API**（`js/player.js`）: `play` / `pause` / `previoustrack`（前の単語）/ `nexttrack`（次の単語）/ `seekbackward` / `seekforward` を登録。メタデータは `title=単語 N (#通し)`, `artist=単語帳名`, `album=ページNNN`。ロック画面・イヤホン操作に対応。単語はページを跨いで連続移動する（フラットな単語リストで管理）。
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
```

現状: 全98ページで セグメント数・cut点（±0.15s）ともに 98/98 一致。
（分割ロジック `splitter.js` は本作業では変更していません。）
