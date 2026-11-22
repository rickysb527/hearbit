# CLAUDE.md

このリポジトリで作業する際の指針。**Hearbit** — ユーザーが手元の単語帳音声を持ち込み、ブラウザ内で単語単位に分割して再生する「汎用の単語帳プレーヤー（PWA）」。

- サービス名: **Hearbit**（Hear + bit）／タグライン「聞きたい言葉を、すぐそこに。」
- テーマカラー: ティール（通常）× オレンジ（再生中）。詳細は `data/brand.md`。

## コンセプト

**音声を同梱するアプリではなく、音声を持ち込んで使う汎用プレーヤー。**
- ユーザーが自分の単語帳音声フォルダをアプリに読み込む → ブラウザ内で分割 → 端末内に保存
- 音声はサーバに一切上がらない（著作権クリア・非商用の前提を守る）
- 複数の単語帳を登録・切り替えて使える（HSK3級・4級…）
- アプリのコードだけをクラウド（Vercel等）に無料デプロイ可能

## プロジェクトの目的（機能）

1. **機能A**: 単語をタップ → その単語（単語→訳→例文2つ）を再生。「聞きたい単語にすぐ戻れる」
2. **機能B**: 単語部分だけを50語/100語で連続再生する「聞き流し」（散歩用）
3. **機能C**: PWA本体。単語帳の読み込み・分割・管理・再生UI

### アプリの画面構成（3階層）
```
① 単語帳を選ぶ（複数の単語帳が並ぶ／新規追加）
    ↓
② ページ/単語一覧（単語はまず番号表示：ページ001 / 単語1,2,3…）
    ↓
③ 再生（機能A: タップ再生 ／ 機能B: まとめ聞き流し）
```

## 重要な前提・制約

- **最終形はブラウザ内完結**: 音声の読み込み・無音検知・分割・再生をすべて端末内で行う。音声は外に出さない。
- **技術スタック**: 素のHTML/CSS/JS（フレームワークなし・ビルド不要・依存最小）＋ PWA。音声の解析（decode・無音検知・分割）は Web Audio API、**再生は `<audio>` 要素**（機能A・Bとも。理由は「設計上の重要ポイント」）。
- **容量最適化**: 端末に保存するのは【元音声 + 分割位置JSON（数KB）】のみ。分割後の音声は別途保存せず、再生時に「元音声の◯秒〜◯秒」を位置指定で鳴らす。HSK3級で元音声139MB程度。
- **保存先**: IndexedDB（Service Workerキャッシュより堅く、明示管理できる）。
- **著作権**: 完全個人利用・非商用。音声はリポジトリにもサーバにも置かない。
- **git管理外**: 音声ファイルはすべて `.gitignore` で除外。コミット対象はコード・メタデータ（JSON/MD）のみ。

### Python版（Mac上）の位置づけ
`src/*.py` は**分割ロジックの検証・正解データ作成の土台**。最終アプリはJSに移植するが、
Python版は「分割ロジックが正しいことの証明」「segments.json の生成」として価値を残す。
- ffmpeg/ffprobe は `/opt/homebrew/bin/`。PATH に無ければ `export PATH="/opt/homebrew/bin:$PATH"`。
- 元音声の原本は `~/Downloads/HSK3級単語/`（001.mp3〜098.mp3）。作業用コピーが `audio/raw/`。
- **元音声（`audio/raw/`）は消さない**。JS移植時の検証データに使う。

## 音声構造（解析で確定済み）

各ページ音声（約60〜95秒）の中身:

```
[冒頭アナウンス（任意）]  ← 品詞「動詞」等(短) or セクション見出し(長)。40ページに存在
[単語1] [単語2] ...       ← 1単語 = 単語(中)→日本語訳→例文1(中)→例文2(中)
```

- **2種類のページ構成**:
  - `word_with_examples`（87ページ）: 1単語≈14秒（例文あり）
  - `word_only`（11ページ）: 1単語≈5秒（例文なし・単語+訳のみ）。086-090は各16単語
- **単語境界**: 2.0秒以上の無音（実測2.2秒前後で安定）
- **単語内ブロック境界**: 0.5〜1.7秒の無音（単語→訳→例文の区切り）
- 総計 98ページ / 654単語 / アナウンス付き40ページ

### アナウンスの扱い（ラベル方式）
音声だけからアナウンスを機械判定するのは単語帳ごとにバラつき信頼性が低い。そこで:
- 分割は無音境界で機械的に行う（確実）
- 各セグメントに `type`（word / word+announce）を付与
- HSK3級は正解データ `data/announce_pages.json`（ユーザー提供）で確定（40/40一致）
- 他の単語帳では超過分ヒューリスティック（先頭が本体中央値+1.0秒以上）で自動判定

## ディレクトリ構成

```
audio/
  raw/      元ページ音声（001.mp3…）※手動配置・git管理外
  words/    分割後の単語ごと音声（001_01.mp3…654個）※自動生成・git管理外
  chunks/   50/100語まとめ音声 ※機能Bで生成・git管理外
data/
  segments.json       全ページの分割メタデータ（境界・type・layout・word_count）
  announce_pages.json アナウンス付きページの正解データ（ユーザー提供）
  split_config.md     分割ロジックの決定事項
src/
  analyze_silence.py  1ファイルの無音解析（調査用）
  build_metadata.py   全ページ解析→segments.json 生成
  split_one.py        1ファイル試し切り（調査用）
  split_all.py        segments.json を元に全セグメントを audio/words/ へ分割
```

## よく使うコマンド

```bash
export PATH="/opt/homebrew/bin:$PATH"

# メタデータ再生成（無音解析やり直し）
python3 src/build_metadata.py

# 全セグメントを実ファイルに分割（audio/words/ へ）
python3 src/split_all.py

# 1ファイルの無音を調査
python3 src/analyze_silence.py audio/raw/001.mp3

# 音声を確認再生（Mac）
afplay audio/words/002_02.mp3
```

## データ形式: segments.json

```json
{
  "book": "HSK3級単語",
  "pages": [
    {
      "page": "001",
      "duration": 95.03,
      "num_segments": 6,
      "layout": "word_with_examples",   // or "word_only"
      "word_count": 6,
      "has_announce": true,
      "segments": [
        { "index": 0, "start": 0.0, "end": 25.87, "length": 25.87, "type": "word+announce" },
        { "index": 1, "start": 25.87, "end": 39.84, "length": 13.97, "type": "word" }
      ]
    }
  ]
}
```

分割音声のファイル名は `<page>_<seg2桁>.mp3`（例: `001_02.mp3` = 001ページの2セグメント目）。

## 開発手法

### 開発フロー（段階式）
各機能は **設計 → 実装 → レビュー → 検証 → マージ** の順で進める。

```
① 設計    メイン(or Planエージェント)が仕様・段取りを決める
② 実装    担当エージェントが領域を実装（audio-engineer / frontend-dev / ui-designer）
③ レビュー code-reviewer がコード・仕様をチェック → 指摘を実装者に戻す
④ 検証    verifier が自動テスト（数値検証）を実行 ＋ 実聴/実操作サンプルを提示
          → ユーザーが音・UXを最終確認
⑤ マージ   品質ゲートを通過したら PR作成 → main へマージ
```

### サブエージェントと役割分担（.claude/agents/）
| エージェント | 役割 | モデル | 担当 |
|---|---|---|---|
| `audio-engineer` | 音声処理（ffmpeg/Python）実装 | opus | 機能B・分割ロジック |
| `frontend-dev` | PWA（HTML/CSS/JS）実装 | opus | 機能C |
| `ui-designer` | UI/UXデザイン | opus | 機能Cの見た目 |
| `code-reviewer` | コード・仕様レビュー | opus | 全機能（マージ前） |
| `verifier` | 動作検証・自動テスト | sonnet | 全機能（マージ前） |

- モデルは**役割で使い分け**（実装・レビューはopus、検証はsonnet）。
- 独立した実装（機能B/C）は複数エージェントで**並行**して進めてよい。

### 品質ゲート（マージ前に3つとも必須）
1. **レビュー**: code-reviewer が「マージ可」と判定
2. **自動テスト**: verifier の数値検証がPASS（ファイル数・命名・JSON整合・尺など）
3. **実聴/実操作確認**: ユーザーが代表サンプルを聴く/操作して問題なし

> このPJの核心（音が正しく切れているか）は自動テストでは判定できず、人間の耳が必要。
> よって「数値で検証できる部分は自動テスト」「音・UXの最終判断は人間」と役割分担する。

### テストの考え方
- **自動テスト**: 単語数・境界・ファイル数・JSON整合性など数値化できるもの → verifier
- **実聴テスト**: 音がちゃんと切れているか → ユーザーが数サンプル確認
- **実操作テスト**: タップ再生・ロック画面操作 → ユーザーが実機で確認

### ブランチ・並行開発
- **ブランチ運用**: 機能ごとにブランチを切る。`feat/summary-audio`（機能B）, `feat/pwa-app`（機能C）。
- **並行開発**: git worktree を使い、機能B/Cを別フォルダで並行実装。
  - メイン: `dev/vocab-audio-separator`（main）
  - 機能B: `dev/vocab-audio-separator-summary`（feat/summary-audio）
  - 機能C: `dev/vocab-audio-separator-pwa`（feat/pwa-app）
  - 各worktreeの `audio/` はメインへのシンボリックリンク（音声は1コピーで共有、gitは無視）
- **Issue**: GitHub Issue でタスク管理（#1 機能B, #2 機能C）。
- **コミット**: 音声はコミットされない前提。スクリプト・メタデータ・アプリコードを対象に。
  - コミットメッセージ末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- リモート: `origin`（GitHub, **public**, rickysb527/hearbit）。公開されるのはコードのみ（音声は git 管理外）。

## 現在の状況

- [x] 音声解析・分割ロジック確定（Python版で検証）
- [x] Python版: 全セグメントを audio/words/ に分割（分割ロジックの正しさを実証）
- [x] 分割ロジック改善: 例文分離の結合・アナウンス切り離し（announce_end）。総単語650
- [x] ブランド確定: **Hearbit**（ティール×オレンジ）
- [x] 開発体制（サブエージェント・段階式フロー）整備
- [x] **機能C**: PWA本体（feat/pwa-app）— 品質ゲート3つ通過・iPhone実機動作確認済み
  - [x] 無音検知・分割ロジックを Web Audio API で JS移植（Python版とcut点98/98一致）
  - [x] 単語帳の登録・切り替え・削除（IndexedDB、複数単語帳）
  - [x] 単語一覧UI（番号表示）＋ 機能A（タップ再生・位置指定・アナウンス飛ばし）
  - [x] PWA化（manifest + Service Worker）＋ Media Session（ロック画面で前/次/再生）
  - [x] iPhone実機: ホーム画面追加・単語タップ再生・ロック画面操作を確認
- [x] **機能B**: 聞き流し — アプリに統合済み・iPhone実機でバックグラウンド/ロック中の連続再生を確認
  - [x] 単語部分抽出（wordonly=単語+訳）・50/100語で連結1本（Python: build_chunks.py / JS: listen-build.js）
  - [x] 聞き流しタブ・円形プログレス・スター単語の聞き流し・ミニプレーヤー（▼で閉じても再生継続）
  - [x] 番号は単語帳全体の通し番号「No.51 (1/50)」で表示
  - [x] 再生は連結1本を WAV(blob) にして `<audio>` 要素で鳴らす（2026-11-23 PR #18）
- [x] 単語テキスト（漢字・ピンイン・訳）の紐付け・手動修正、要確認/スター、タイピング＋SRS
- [x] 分割の手動編集（#4）
- [x] PWA 更新導線: 設定にバージョン表示＋「更新があります」バナー（PR #16）
- [x] 短いアナウンス（「形容詞」等）の境界取り違えを修正（PR #19、SPLIT_VERSION 3）
- [ ] 残タスク（Issue管理）: #3 テキスト表示の拡充 / #5 音声の追加読み込み / **#20 汎用化（ブロックの役割モデル＋アナウンスのユーザー確認）**

### 設計上の重要ポイント
- **まとめ音声は1本に連結して再生**: iOSはバックグラウンドでJS実行を絞るため、
  `audio.onended`で次を再生する方式はロック中に止まりうる。連結した1本なら確実に流れる。
- **オフライン再生**: 一度読み込めば端末内データだけで動く（Macも電波も不要）→ 散歩に対応。
- **再生は必ず `<audio>` 要素で（Web Audio で鳴らさない）**: iOS の AudioContext は suspended/interrupted に
  なったり、running のまま時計が止まったりして「⏸表示なのに無音」になる。状態変化に反応して止める処理を
  入れると、今度はホーム画面に戻る/画面オフで止まった（PR #14〜#17 で発生 → #18 で `<audio>` 方式に変更して解消）。
  `<audio>` は「メディア再生」扱いでバックグラウンド・ロック中も流れ、消音スイッチの影響も受けない。
  AudioContext は decode（PCM 取得）専用。iOS は操作外の `play()` を拒否するので、聞き流しはタップ直後に
  無音を play して要素をアンロックしてから構築・再生する。
- **アナウンスの判定は暫定**: 長さヒューリスティック＋HSK3級は正解データ。他の単語帳への汎用化は #20 で設計中
  （ブロックに役割を持たせ、推定＋ユーザー確認で確定）。

## デプロイ・バージョン運用（重要）
- 本番: https://rickysb527.github.io/hearbit/ （GitHub Pages、main のルートを公開。`/hearbit/` は `app/` にリダイレクト）。
  main にマージすると1分弱で反映（`gh api repos/rickysb527/hearbit/pages/builds/latest` が built になる）。
- **アプリのバージョン**: デプロイのたびに `app/js/version.js` の `APP_VERSION` と `app/sw.js` の `VERSION` を
  **両方 +1**（キャッシュ名 `hearbit-v<VERSION>` は自動生成）。`node app/verify/verify_version.js` で一致を確認。
  ホーム画面の PWA はリロードできないため、設定画面に版を表示し、SW の版が新しければ「更新があります」バナー
  （タップで再読み込み）を出す。実機確認を頼む時は、まず設定の版が最新か見てもらう。
- **分割ロジックのバージョン**: `splitter.js` / `listen-build.js` の分割・抽出ロジックを変えたら
  `SPLIT_VERSION`（splitter.js）も +1。既存の単語帳は開いた時に元音声から自動再分割される（手動編集ページは保護）。
  Python 版（build_metadata.py）も同じ修正を入れ、`node app/verify/verify_split.js all` で 98/98 一致を確認する。

## 自動テスト（app/verify）
```bash
export PATH="/opt/homebrew/bin:$PATH"
node app/verify/verify_split.js all        # 分割: JS ⇔ Python 一致（全98ページ）
node app/verify/verify_listen.js all       # 聞き流しの wordonly 抽出・チャンク
node app/verify/verify_listen_playback.js  # 聞き流しの再生ロジック（<audio> 方式・WAV 変換）
node app/verify/verify_version.js          # APP_VERSION と sw.js VERSION の一致・SW プリキャッシュ
node app/verify/verify_update.mjs          # 更新導線（実Chrome・自前サーバ）
# 実Chromeの UI 統合テストは事前に app/ で静的サーバを立てる（無いと "Splitter is not defined" で落ちる）
(cd app && python3 -m http.server 8123 &) && node app/verify/verify_dom.mjs
# その他: verify_cache / verify_editor / verify_star / verify_srs / verify_textedit / verify_typing / verify_vocab
```
