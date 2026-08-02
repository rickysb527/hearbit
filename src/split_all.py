#!/usr/bin/env python3
"""segments.json を元に、全ページの各セグメント（=1単語ワンセット）を
audio/words/ に切り出す。機能A（単語タップ再生）用。

出力ファイル名: <page>_<seg2桁>.mp3   例: 001_02.mp3
※ アナウンスが結合した先頭セグメント(type=word+announce)もそのまま1ファイルにする。
"""
import subprocess
import os
import json

FFMPEG = "/opt/homebrew/bin/ffmpeg"
ROOT = "/Users/rikikun/dev/vocab-audio-separator"
RAW_DIR = f"{ROOT}/audio/raw"
OUT_DIR = f"{ROOT}/audio/words"
META = f"{ROOT}/data/segments.json"


def main():
    with open(META, encoding="utf-8") as f:
        data = json.load(f)
    os.makedirs(OUT_DIR, exist_ok=True)

    total = 0
    for page in data["pages"]:
        pid = page["page"]
        src = f"{RAW_DIR}/{pid}.mp3"
        for seg in page["segments"]:
            idx = seg["index"]
            s, e = seg["start"], seg["end"]
            out = f"{OUT_DIR}/{pid}_{idx+1:02d}.mp3"
            # 単語IDを 01始まり にして直感的にする
            subprocess.run(
                [FFMPEG, "-y", "-loglevel", "error", "-i", src,
                 "-ss", str(s), "-to", str(e), "-c", "copy", out],
                check=True)
            total += 1
        print(f"{pid}: {len(page['segments'])}語 切り出し完了")
    print(f"\n→ 合計 {total} セグメントを {OUT_DIR} に出力")


if __name__ == "__main__":
    main()
