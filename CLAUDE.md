# CLAUDE.md

このリポジトリで作業する際の指針。HSK中国語単語帳の音声を単語単位に分割し、スマホ（PWA）で再生する個人利用ツール。

## プロジェクトの目的

1. **機能A（実装済み）**: ページ単位の音声を単語ごとに分割 → 「もう一度聞きたい単語をタップですぐ再生」
2. **機能B（未実装）**: 単語部分だけを50語/100語で結合した「聞き流し用まとめ音声」
3. **機能C（未実装）**: 再生アプリ（PWA）。単語一覧タップ再生＋まとめ音声再生

> 完全個人利用。音声の商用利用はしない。元音声は著作物のため git 管理外。

## 重要な前提・制約

- **元音声・分割音声・まとめ音声はすべて git 管理外**（`.gitignore` で除外）。コミットされるのはコードとメタデータ（JSON/MD）のみ。
- 元音声の原本は `~/Downloads/HSK3級単語/`（001.mp3〜098.mp3）。作業用コピーが `audio/raw/`。
- **元音声（`audio/raw/`）は消さない**。分割やり直し・まとめ音声再生成に必要。
- 音声処理は `ffmpeg`/`ffprobe`（`/opt/homebrew/bin/`）。PATH に無い場合は `export PATH="/opt/homebrew/bin:$PATH"`。
- Python 3 標準ライブラリのみで動く（外部依存なし）。

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

## 開発運用

- **ブランチ運用**: 機能ごとにブランチを切る。`feat/summary-audio`（機能B）, `feat/pwa-app`（機能C）。
- **並行開発**: git worktree を使い、機能B/Cを別フォルダで並行実装。
- **Issue**: GitHub Issue でタスク管理（機能B/Cを起票）。
- **コミット**: 音声はコミットされない前提。スクリプト・メタデータ・アプリコードを対象に。
- リモート: `origin`（GitHub, private, rickysb527/vocab-audio-separator）

## 現在の状況

- [x] 音声解析・分割ロジック確定
- [x] 機能A: 654セグメントを audio/words/ に分割（検証済み）
- [ ] 機能B: 聞き流しまとめ音声（要: 単語部分だけの抽出）
- [ ] 機能C: PWAアプリ（単語一覧はまず番号表示）
