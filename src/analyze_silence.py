#!/usr/bin/env python3
"""1ファイルの無音区間を解析し、単語境界（長い無音）とブロック境界（中くらいの無音）を分類して表示する。
分割ロジックを決めるための調査用スクリプト。
"""
import subprocess
import re
import sys

FFMPEG = "/opt/homebrew/bin/ffmpeg"


def detect_silences(path, noise_db=-30, min_dur=0.4):
    """(start, end, duration) のリストを返す。"""
    cmd = [FFMPEG, "-i", path, "-af",
           f"silencedetect=noise={noise_db}dB:d={min_dur}", "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True).stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", out)]
    ends = re.findall(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", out)
    silences = []
    for i, (end, dur) in enumerate(ends):
        # start は同順で対応する（silencedetectは start→end の順で出力）
        s = starts[i] if i < len(starts) else None
        silences.append((s, float(end), float(dur)))
    return silences


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else \
        "/Users/rikikun/dev/vocab-audio-separator/audio/raw/001.mp3"
    silences = detect_silences(path)
    print(f"ファイル: {path}")
    print(f"無音区間 数: {len(silences)}\n")
    print(f"{'#':>3} {'start':>8} {'end':>8} {'dur':>6}  種別")
    for i, (s, e, d) in enumerate(silences):
        # 2.0秒以上を単語境界候補、それ未満をブロック境界候補とする
        kind = "★単語境界候補" if d >= 2.0 else "  ブロック境界"
        ss = f"{s:8.2f}" if s is not None else "    ----"
        print(f"{i:>3} {ss} {e:8.2f} {d:6.2f}  {kind}")

    # 単語境界候補（2.0秒以上）の中点を分割点とする
    print("\n=== 単語境界候補（2.0秒以上の無音の中点を分割点に）===")
    cuts = [round((s + e) / 2, 2) for (s, e, d) in silences if d >= 2.0 and s is not None]
    print("分割点(秒):", cuts)
    print(f"→ 推定単語数: {len(cuts) + 1}")


if __name__ == "__main__":
    main()
