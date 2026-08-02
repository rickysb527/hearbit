#!/usr/bin/env python3
"""全ページ音声を無音境界で分割し、各セグメントに type(word/announce) を付与した
メタデータ JSON を生成する。分割の実ファイル出力は別スクリプト。ここは境界検出とラベル付けのみ。

出力: data/segments.json
"""
import subprocess
import re
import os
import json
import statistics

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
RAW_DIR = "/Users/rikikun/dev/vocab-audio-separator/audio/raw"
OUT = "/Users/rikikun/dev/vocab-audio-separator/data/segments.json"

WORD_GAP = 2.0        # これ以上の無音を単語境界とみなす
NOISE_DB = -30
MIN_SILENCE = 0.4

# アナウンス自動判定のヒューリスティック閾値
SHORT_RATIO = 0.55    # 先頭が全体中央値のこの割合未満なら「短いアナウンス」疑い
LONG_RATIO = 1.6      # 先頭が中央値のこの倍以上なら「長いアナウンス結合」疑い


def duration(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True).stdout.strip()
    return float(out)


def detect_cuts(path):
    cmd = [FFMPEG, "-i", path, "-af",
           f"silencedetect=noise={NOISE_DB}dB:d={MIN_SILENCE}", "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True).stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", out)]
    ends = re.findall(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", out)
    cuts = []
    for i, (end, dur) in enumerate(ends):
        s = starts[i] if i < len(starts) else None
        if s is not None and float(dur) >= WORD_GAP:
            cuts.append(round((s + float(end)) / 2, 3))
    return cuts


def label_segments(seg_lengths):
    """セグメント長リストから各セグメントのtypeを初期判定する。
    先頭セグメントのみアナウンス候補として判定（この教材の構造に基づく）。
    """
    types = ["word"] * len(seg_lengths)
    if len(seg_lengths) < 2:
        return types
    # 先頭を除いた「単語」部分の中央値を基準にする
    body_median = statistics.median(seg_lengths[1:])
    first = seg_lengths[0]
    if first < body_median * SHORT_RATIO:
        types[0] = "announce"      # 極端に短い → 品詞アナウンス
    elif first > body_median * LONG_RATIO:
        types[0] = "word+announce"  # 極端に長い → 長い見出し + 単語1が結合
    return types


def main():
    files = sorted(f for f in os.listdir(RAW_DIR) if f.endswith(".mp3"))
    pages = []
    for fname in files:
        path = os.path.join(RAW_DIR, fname)
        page_id = os.path.splitext(fname)[0]
        total = duration(path)
        cuts = detect_cuts(path)
        bounds = [0.0] + cuts + [round(total, 3)]
        seg_lengths = [round(bounds[i+1] - bounds[i], 2) for i in range(len(bounds)-1)]
        types = label_segments(seg_lengths)
        segments = []
        for i in range(len(bounds) - 1):
            segments.append({
                "index": i,
                "start": round(bounds[i], 3),
                "end": round(bounds[i+1], 3),
                "length": seg_lengths[i],
                "type": types[i],
            })
        pages.append({
            "page": page_id,
            "duration": round(total, 2),
            "num_segments": len(segments),
            "segments": segments,
        })
        print(f"{page_id}: {len(segments)}セグメント / 先頭type={types[0]} (先頭{seg_lengths[0]}s)")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"book": "HSK3級単語", "pages": pages}, f, ensure_ascii=False, indent=2)
    print(f"\n→ {OUT} に書き出し（{len(pages)}ページ）")


if __name__ == "__main__":
    main()
