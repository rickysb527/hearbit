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

# アナウンス自動判定（汎用ヒューリスティック）:
# 先頭セグメント長 - 本体セグメント長の中央値 = 超過分。
# アナウンスが単語1に結合すると先頭が長くなる。正解データ検証で 1.0秒が再現率最良。
EXCESS_THRESHOLD = 1.0

# 今回のHSK3級は正解データがあるので、それを優先してラベルを確定する。
ANNOUNCE_JSON = "/Users/rikikun/dev/vocab-audio-separator/data/announce_pages.json"


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


def load_truth():
    """正解データ（ユーザー提供）を読み込む。無ければ空。"""
    try:
        with open(ANNOUNCE_JSON, encoding="utf-8") as f:
            a = json.load(f)
        return set(a.get("short_announce_pages", [])), set(a.get("long_announce_pages", []))
    except FileNotFoundError:
        return set(), set()


def label_segments(seg_lengths, page_id, truth_short, truth_long):
    """各セグメントの type を判定する。
    - has_announce: 先頭セグメントにアナウンスが含まれるか
      正解データがあればそれを優先、無ければ超過分ヒューリスティックで自動判定。
    - 先頭のtypeは、アナウンス有りなら "word+announce"（アナウンスと単語1が結合）。
    """
    types = ["word"] * len(seg_lengths)
    if len(seg_lengths) < 2:
        return types

    pid = int(page_id)
    if truth_short or truth_long:
        # 正解データがある → それで確定
        has_announce = pid in truth_short or pid in truth_long
    else:
        # 汎用: 先頭が本体中央値をEXCESS_THRESHOLD秒以上超えていたらアナウンス結合とみなす
        body_median = statistics.median(seg_lengths[1:])
        has_announce = (seg_lengths[0] - body_median) >= EXCESS_THRESHOLD

    if has_announce:
        types[0] = "word+announce"
    return types


def main():
    truth_short, truth_long = load_truth()
    files = sorted(f for f in os.listdir(RAW_DIR) if f.endswith(".mp3"))
    pages = []
    for fname in files:
        path = os.path.join(RAW_DIR, fname)
        page_id = os.path.splitext(fname)[0]
        total = duration(path)
        cuts = detect_cuts(path)
        bounds = [0.0] + cuts + [round(total, 3)]
        seg_lengths = [round(bounds[i+1] - bounds[i], 2) for i in range(len(bounds)-1)]
        types = label_segments(seg_lengths, page_id, truth_short, truth_long)
        segments = []
        for i in range(len(bounds) - 1):
            segments.append({
                "index": i,
                "start": round(bounds[i], 3),
                "end": round(bounds[i+1], 3),
                "length": seg_lengths[i],
                "type": types[i],
            })
        # ページ構成の推定: 本体セグメント長の中央値が短ければ「単語のみ」
        body = seg_lengths[1:] if len(seg_lengths) > 1 else seg_lengths
        med = statistics.median(body)
        layout = "word_only" if med < 9 else "word_with_examples"
        word_count = sum(1 for t in types if t in ("word", "word+announce"))
        pages.append({
            "page": page_id,
            "duration": round(total, 2),
            "num_segments": len(segments),
            "layout": layout,          # word_only / word_with_examples
            "word_count": word_count,  # このページの単語数
            "has_announce": types[0] == "word+announce",
            "segments": segments,
        })
        flag = "★アナウンス" if types[0] == "word+announce" else ""
        print(f"{page_id}: {len(segments)}seg / {layout} / {word_count}語 {flag}")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"book": "HSK3級単語", "pages": pages}, f, ensure_ascii=False, indent=2)
    print(f"\n→ {OUT} に書き出し（{len(pages)}ページ）")


if __name__ == "__main__":
    main()
