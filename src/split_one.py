#!/usr/bin/env python3
"""1ファイルを単語境界（2.0秒以上の無音の中点）で試し切りする調査用スクリプト。
出力先: audio/words/<basename>_NN.mp3
"""
import subprocess
import re
import sys
import os

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
WORD_GAP = 2.0  # これ以上の無音を単語境界とみなす


def duration(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True).stdout.strip()
    return float(out)


def detect_cuts(path, noise_db=-30, min_dur=0.4):
    cmd = [FFMPEG, "-i", path, "-af",
           f"silencedetect=noise={noise_db}dB:d={min_dur}", "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True).stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", out)]
    ends = re.findall(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", out)
    cuts = []
    for i, (end, dur) in enumerate(ends):
        s = starts[i] if i < len(starts) else None
        if s is not None and float(dur) >= WORD_GAP:
            cuts.append(round((s + float(end)) / 2, 3))
    return cuts


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else \
        "/Users/rikikun/dev/vocab-audio-separator/audio/raw/001.mp3"
    outdir = "/Users/rikikun/dev/vocab-audio-separator/audio/words"
    os.makedirs(outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(path))[0]

    total = duration(path)
    cuts = detect_cuts(path)
    bounds = [0.0] + cuts + [total]
    print(f"総尺 {total:.2f}s / 分割点 {cuts} / セグメント数 {len(bounds)-1}")

    for i in range(len(bounds) - 1):
        s, e = bounds[i], bounds[i + 1]
        out = os.path.join(outdir, f"{base}_{i+1:02d}.mp3")
        subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error", "-i", path,
             "-ss", str(s), "-to", str(e), "-c", "copy", out],
            check=True)
        print(f"  {base}_{i+1:02d}.mp3  [{s:6.2f} - {e:6.2f}]  {e-s:5.2f}s")


if __name__ == "__main__":
    main()
