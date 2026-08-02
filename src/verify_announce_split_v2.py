#!/usr/bin/env python3
"""案①（時間長逆算＋境界スナップ）でアナウンス/単語1の境界を求める検証スクリプト。

【調査フェーズ専用・確定実装ではない】
アナウンス付きページの先頭セグメント（アナウンス+単語1が結合）について:
  1. 本体単語長の基準値を求める（(a)中央値 / (b)最小値の2種を比較）。
  2. 先頭セグメント末尾から基準値ぶん遡った時刻を単語1開始の「目安」とする。
  3. 目安に最も近い内部無音境界（0.4秒以上の無音の中点）にスナップして境界確定。
  4. 境界より前=アナウンス、後=単語1。

案B（固定ブロック数逆算）が「1単語=4/2ブロック」の前提破綻で失敗したため、
「単語1の尺は本体単語とほぼ同じ」という事実に基づく時間長逆算を検証する。

元音声（audio/raw/）は読み取り専用。表を標準出力するだけ。
"""
import subprocess
import re
import json
import statistics

FFMPEG = "/opt/homebrew/bin/ffmpeg"
ROOT = "/Users/rikikun/dev/vocab-audio-separator"
RAW_DIR = f"{ROOT}/audio/raw"
SEGMENTS = f"{ROOT}/data/segments.json"
ANNOUNCE_JSON = f"{ROOT}/data/announce_pages.json"

NOISE_DB = -30
MIN_SILENCE = 0.4  # 内部ブロック境界とみなす無音長

TOLERANCE = 3.0    # 単語1長が本体中央値からこの秒数以内なら妥当


def internal_boundaries(path, start, end):
    """先頭セグメント範囲内の無音（0.4秒以上）の中点（絶対秒）リストを返す。"""
    dur = end - start
    cmd = [FFMPEG, "-ss", str(start), "-t", str(dur), "-i", path,
           "-af", f"silencedetect=noise={NOISE_DB}dB:d={MIN_SILENCE}",
           "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True).stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([-\d.]+)", out)]
    ends = re.findall(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", out)
    mids = []
    for i, (e, d) in enumerate(ends):
        s = starts[i] if i < len(starts) else None
        if s is None:
            continue
        mid = start + (max(0.0, s) + float(e)) / 2.0
        if start < mid < end:
            mids.append(round(mid, 3))
    return sorted(mids)


def snap(target, boundaries):
    """target に最も近い境界を返す。境界が無ければ None。"""
    if not boundaries:
        return None
    return min(boundaries, key=lambda b: abs(b - target))


def compute(page, path, ref_kind):
    """ref_kind: 'median' or 'min'。境界情報 dict を返す。"""
    seg0 = page["segments"][0]
    s0, e0 = seg0["start"], seg0["end"]
    body = [seg["length"] for seg in page["segments"][1:]]
    if not body:
        return None
    body_median = round(statistics.median(body), 2)
    ref = body_median if ref_kind == "median" else round(min(body), 2)

    target = e0 - ref                       # 単語1開始の目安時刻
    bnds = internal_boundaries(path, s0, e0)
    snapped = snap(target, bnds)
    if snapped is None:
        return {"ok_snap": False, "body_median": body_median, "ref": ref}

    announce_len = round(snapped - s0, 2)
    word1_len = round(e0 - snapped, 2)
    within = abs(word1_len - body_median) <= TOLERANCE
    return {
        "ok_snap": True,
        "s0": s0, "e0": e0, "seg0_len": round(e0 - s0, 2),
        "body_median": body_median, "ref": ref,
        "target": round(target, 3), "boundary": snapped,
        "announce_len": announce_len, "word1_len": word1_len,
        "within": within,
        "snap_shift": round(snapped - target, 2),
    }


def main():
    data = json.load(open(SEGMENTS, encoding="utf-8"))
    pages = {p["page"]: p for p in data["pages"]}
    ann = json.load(open(ANNOUNCE_JSON, encoding="utf-8"))
    short = set(ann["short_announce_pages"])
    long_ = set(ann["long_announce_pages"])
    allp = sorted(short | long_)
    kind = {p: ("long" if p in long_ else "short") for p in allp}

    rows = []
    for pi in allp:
        pid = f"{pi:03d}"
        page = pages.get(pid)
        if page is None or len(page["segments"]) < 2:
            continue
        path = f"{RAW_DIR}/{pid}.mp3"
        a = compute(page, path, "median")
        b = compute(page, path, "min")
        rows.append((pid, kind[pi], page["layout"], a, b))

    # 表
    hdr = (f"{'page':>4} {'kind':>5} {'layout':>18} {'seg0':>6} "
           f"| {'[a]ref':>6} {'目安':>6} {'境界':>7} {'ann':>5} {'単1':>5} {'±3':>3} "
           f"| {'[b]ref':>6} {'目安':>6} {'境界':>7} {'ann':>5} {'単1':>5} {'±3':>3}")
    print("=" * len(hdr))
    print(hdr)
    print("-" * len(hdr))

    a_within = a_snapfail = 0
    b_within = b_snapfail = 0
    a_out, b_out = [], []

    def cell(x):
        if x is None or not x.get("ok_snap"):
            return f"{'--':>6} {'--':>6} {'--':>7} {'--':>5} {'--':>5} {'--':>3}"
        mk = "○" if x["within"] else "×"
        return (f"{x['ref']:>6.2f} {x['target']:>6.2f} {x['boundary']:>7.3f} "
                f"{x['announce_len']:>5.2f} {x['word1_len']:>5.2f} {mk:>3}")

    for pid, k, layout, a, b in rows:
        seg0 = a["seg0_len"] if a else (b["seg0_len"] if b else 0)
        print(f"{pid:>4} {k:>5} {layout:>18} {seg0:>6.2f} | {cell(a)} | {cell(b)}")
        if a and a.get("ok_snap"):
            if a["within"]:
                a_within += 1
            else:
                a_out.append((pid, layout, a["word1_len"], a["body_median"]))
        else:
            a_snapfail += 1
        if b and b.get("ok_snap"):
            if b["within"]:
                b_within += 1
            else:
                b_out.append((pid, layout, b["word1_len"], b["body_median"]))
        else:
            b_snapfail += 1

    n = len(rows)
    print("=" * len(hdr))
    print(f"総アナウンスページ: {n}")
    print(f"[a]中央値基準  : ±{TOLERANCE}s以内 {a_within}/{n}  外れ {len(a_out)}  スナップ失敗 {a_snapfail}")
    print(f"[b]最小値基準  : ±{TOLERANCE}s以内 {b_within}/{n}  外れ {len(b_out)}  スナップ失敗 {b_snapfail}")

    if a_out:
        print("\n--- [a]中央値基準で外れるページ ---")
        for pid, ly, w1, bm in a_out:
            print(f"  {pid} {ly}: 単語1={w1}s 本体中央値={bm}s 差={w1-bm:+.2f}s")
    if b_out:
        print("\n--- [b]最小値基準で外れるページ ---")
        for pid, ly, w1, bm in b_out:
            print(f"  {pid} {ly}: 単語1={w1}s 本体中央値={bm}s 差={w1-bm:+.2f}s")


if __name__ == "__main__":
    main()
