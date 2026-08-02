#!/usr/bin/env python3
"""案B（後ろからブロック逆算）でアナウンス/単語1の境界を求める検証スクリプト。

【調査フェーズ専用・確定実装ではない】
アナウンス付きページの先頭セグメント（アナウンス+単語1が結合）を、
セグメント内部の無音（0.4秒以上）でブロックに分割し、末尾から
layout に応じたブロック数（word_with_examples=4, word_only=2）を単語1とみなす。
それより前をアナウンスとして境界時刻を逆算する。

元音声（audio/raw/）は読み取り専用。ファイル出力はしない（表を標準出力するだけ）。
"""
import subprocess
import re
import os
import json
import statistics

FFMPEG = "/opt/homebrew/bin/ffmpeg"
ROOT = "/Users/rikikun/dev/vocab-audio-separator"
RAW_DIR = f"{ROOT}/audio/raw"
SEGMENTS = f"{ROOT}/data/segments.json"
ANNOUNCE_JSON = f"{ROOT}/data/announce_pages.json"

# ブロック検出パラメータ（build_metadata.py と同じ noise/最小無音長）
NOISE_DB = -30
MIN_SILENCE = 0.4  # これ以上の無音を単語内ブロック境界とみなす

# layout ごとの「単語1」を構成するブロック数
BLOCKS_PER_WORD = {
    "word_with_examples": 4,  # 単語→訳→例文1→例文2
    "word_only": 2,           # 単語→訳
}

# 逆算した単語1長が本体中央値からこの秒数以上外れたら要注意
TOLERANCE = 3.0


def detect_silences(path, start, end):
    """[start, end] 範囲の音声を切り出さずに解析し、無音区間 (s, e) のリストを返す。
    -ss/-t で対象範囲だけ silencedetect にかける。返す時刻は元音声の絶対秒。
    """
    dur = end - start
    cmd = [FFMPEG, "-ss", str(start), "-t", str(dur), "-i", path,
           "-af", f"silencedetect=noise={NOISE_DB}dB:d={MIN_SILENCE}",
           "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True).stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([-\d.]+)", out)]
    ends = re.findall(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", out)
    silences = []
    for i, (e, d) in enumerate(ends):
        s = starts[i] if i < len(starts) else None
        if s is None:
            continue
        # silencedetect は -ss 起点からの相対秒を返す → 絶対秒に補正
        silences.append((start + max(0.0, s), start + float(e), float(d)))
    return silences


def blocks_from_silences(start, end, silences):
    """無音区間で区切ったブロック（音のある区間）の境界リストを返す。
    ブロック境界時刻の中点で切る。返り値: [block(start,end), ...]
    """
    # 各無音の中点を切断点に
    cut_points = []
    for s, e, d in silences:
        mid = (s + e) / 2.0
        if start < mid < end:
            cut_points.append(mid)
    cut_points.sort()
    bounds = [start] + cut_points + [end]
    blocks = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
    return blocks


def main():
    data = json.load(open(SEGMENTS, encoding="utf-8"))
    pages = {p["page"]: p for p in data["pages"]}

    ann = json.load(open(ANNOUNCE_JSON, encoding="utf-8"))
    short_pages = ann["short_announce_pages"]
    long_pages = ann["long_announce_pages"]
    all_announce = sorted(set(short_pages) | set(long_pages))

    ann_kind = {}
    for p in short_pages:
        ann_kind[p] = "short"
    for p in long_pages:
        ann_kind[p] = "long"

    rows = []
    warn_word1 = []   # 単語1長が本体中央値から外れる
    warn_blocks = []  # ブロック数不足で切り離し不能

    for pid_int in all_announce:
        pid = f"{pid_int:03d}"
        page = pages.get(pid)
        if page is None:
            warn_blocks.append((pid, "segments.jsonに該当ページなし"))
            continue

        layout = page["layout"]
        need = BLOCKS_PER_WORD.get(layout, 4)
        seg0 = page["segments"][0]
        s0, e0 = seg0["start"], seg0["end"]
        seg0_len = round(e0 - s0, 2)

        # 本体（先頭以外）セグメント長の中央値
        body = [seg["length"] for seg in page["segments"][1:]]
        body_median = round(statistics.median(body), 2) if body else None

        path = f"{RAW_DIR}/{pid}.mp3"
        silences = detect_silences(path, s0, e0)
        blocks = blocks_from_silences(s0, e0, silences)
        n_blocks = len(blocks)

        if n_blocks < need:
            warn_blocks.append((pid, f"ブロック数{n_blocks} < 必要{need}"))
            rows.append({
                "page": pid, "kind": ann_kind[pid_int], "layout": layout,
                "seg0_len": seg0_len, "n_blocks": n_blocks, "need": need,
                "boundary": None, "announce_len": None, "word1_len": None,
                "body_median": body_median, "note": "切り離し不能",
            })
            continue

        # 末尾 need ブロックが単語1。境界 = 末尾からneed番目ブロックの開始
        word1_start = blocks[-need][0]
        boundary = round(word1_start, 3)
        announce_len = round(boundary - s0, 2)
        word1_len = round(e0 - boundary, 2)

        note = ""
        if body_median is not None and abs(word1_len - body_median) > TOLERANCE:
            note = f"要注意(単語1={word1_len} vs 中央値{body_median})"
            warn_word1.append((pid, layout, word1_len, body_median,
                               round(word1_len - body_median, 2)))

        rows.append({
            "page": pid, "kind": ann_kind[pid_int], "layout": layout,
            "seg0_len": seg0_len, "n_blocks": n_blocks, "need": need,
            "boundary": boundary, "announce_len": announce_len,
            "word1_len": word1_len, "body_median": body_median, "note": note,
        })

    # 表出力
    print("=" * 110)
    print(f"{'page':>4} {'kind':>5} {'layout':>18} {'seg0':>6} {'blk':>3} "
          f"{'need':>4} {'境界s':>8} {'ann長':>6} {'単1長':>6} {'本体中央':>7}  備考")
    print("-" * 110)
    for r in rows:
        b = f"{r['boundary']:.3f}" if r["boundary"] is not None else "----"
        al = f"{r['announce_len']:.2f}" if r["announce_len"] is not None else "----"
        wl = f"{r['word1_len']:.2f}" if r["word1_len"] is not None else "----"
        bm = f"{r['body_median']:.2f}" if r["body_median"] is not None else "----"
        print(f"{r['page']:>4} {r['kind']:>5} {r['layout']:>18} "
              f"{r['seg0_len']:>6.2f} {r['n_blocks']:>3} {r['need']:>4} "
              f"{b:>8} {al:>6} {wl:>6} {bm:>7}  {r['note']}")

    # サマリ
    ok = [r for r in rows if r["boundary"] is not None and not r["note"]]
    print("=" * 110)
    print(f"総アナウンスページ: {len(rows)}")
    print(f"OK（境界算出＆単語1長が中央値±{TOLERANCE}s以内）: {len(ok)}")
    print(f"要注意（単語1長が中央値から外れる）: {len(warn_word1)}")
    print(f"切り離し不能（ブロック数不足）: {len(warn_blocks)}")

    if warn_word1:
        print("\n--- 要注意ページ（単語1長ズレ） ---")
        for pid, layout, w1, bm, diff in warn_word1:
            print(f"  {pid} {layout}: 単語1={w1}s 本体中央値={bm}s 差={diff:+.2f}s")
    if warn_blocks:
        print("\n--- 切り離し不能ページ ---")
        for pid, reason in warn_blocks:
            print(f"  {pid}: {reason}")


if __name__ == "__main__":
    main()
