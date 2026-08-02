# 単語帳プレーヤー（機能C 基盤）

音声を持ち込んでブラウザ内で単語単位に分割・再生する汎用プレーヤー（PWA基盤）。
素のHTML/CSS/JS。ビルド・CDN・依存なし。オフラインで動作。

## 構成

```
app/
  index.html          3階層UIのマークアップ
  css/styles.css       最小スタイル（ダーク）
  js/
    db.js              IndexedDB: 単語帳メタ + 元音声Blob を保存（分割音声は保存しない）
    splitter.js        Web Audio API 無音検知・分割（Python版ロジック移植）
    player.js          機能A: 元音声の start〜end を位置指定再生
    app.js             3階層ナビ・読み込み/分割/保存・タップ再生
  verify/
    verify_split.js    JS分割ロジックを Node で走らせ segments.json と突き合わせ
```

## 実装済み（この段階のスコープ）

1. 音声フォルダ読み込み（input[type=file] multiple, mp3等）
2. ブラウザ内 無音検知・分割（noise=-30dBFS / min_silence=0.4s / word_gap=2.0s、分割点=無音中点）
3. 分割結果のデバッグ表示（読み込み時にページ毎のセグメント数/レイアウト/語数/アナウンス）
4. IndexedDB保存・複数単語帳の登録/切り替え/削除
5. 3階層UI骨格（①単語帳 ②ページ一覧[番号] ③再生[単語番号]）
6. 機能A: 単語タップで元音声の該当区間を位置指定再生（分割音声は保存せず容量最適化）

## 未実装（次段階）

- 機能B（まとめ聞き流し・連結1本再生）
- PWA化（manifest / Service Worker / Media Session）
- テキスト表示（現状は番号のみ）・デザイン作り込み（ui-designer 並行）

## ローカルで動かす

```bash
# リポジトリ直下（worktree: vocab-audio-separator-pwa）で
python3 -m http.server 8000
# ブラウザで http://localhost:8000/app/ を開く
```

操作: 「＋ 単語帳を追加」→ 名前を入力 →「音声ファイル」で mp3 を複数選択
（audio/raw/001.mp3〜098.mp3 が使える）→「読み込んで分割・保存」。
デバッグ欄に分割結果が出る。一覧 → ページ → 単語番号タップで再生。

## iPhoneで確認（同一Wi-Fi）

```bash
# MacのローカルmIPを確認
ipconfig getifaddr en0        # 例: 192.168.1.23
python3 -m http.server 8000
```

iPhoneのSafariで `http://192.168.1.23:8000/app/` を開く。
（ファイル選択は iOS の「ファイル」アプリ経由で mp3 を選べる。PWA化は次段階。）

## Python版との一致検証

Web Audio API は Node に無いため、検証は ffmpeg で mp3→raw PCM に変換し
splitter.js と同一の RMS アルゴリズムを Node で適用して data/segments.json と比較する。

```bash
export PATH="/opt/homebrew/bin:$PATH"
node app/verify/verify_split.js       # 代表10ページ
node app/verify/verify_split.js all   # 全98ページ
```

現状: 全98ページで セグメント数・cut点（±0.15s）ともに 98/98 一致。
```
セグメント数一致: 98/98
cut点一致(±0.15s): 98/98
```
（2.0秒境界ぎわのページは窓幅に敏感。窓幅10msで最良の一致。将来の手動トグルUIで補正可能。）
