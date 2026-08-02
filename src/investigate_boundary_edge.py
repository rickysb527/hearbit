#!/usr/bin/env python3
"""境界きわ（2.0秒付近）の無音による誤分割/見逃しの影響範囲を全98ページ調査する。

【調査フェーズ専用】096のように「ちょうど2.00秒の無音」がWORD_GAP=2.0の閾値に
ギリギリ引っかかり、本来は単語内区切りなのに単語境界と誤判定される問題の影響を数える。

出力は集計のみ。元音声・segments.json は変更しない。
"""
import subprocess
import re
import os
import json
import statistics

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
ROOT = "/Users/rikikun/dev/vocab-audio-separator"
RAW_DIR = f"{ROOT}/audio/raw"
SEGMENTS = f"{ROOT}/data/segments.json"

WORD_GAP = 2.0      # 現行の単語境界閾値
NOISE_DB = -30
MIN_SILENCE = 0.4

# きわどい帯
EDGE_LOW = 1.8      # これ以上を「きわ」として観察
EDGE_HIGH = 2.3     # これ以下
MISFIRE_LOW = 2.0   # 2.0〜2.15: 誤分割リスク（境界判定されたが単語内かも）
MISFIRE_HIGH = 2.15
MISS_LOW = 1.85     # 1.85〜2.0: 見逃しリスク（単語内と判定されたが境界かも）
MISS_HIGH = 2.0

# セグメント長の外れ判定
SHORT_RATIO = 0.40  # 中央値のこの割合未満 = 短すぎ
LONG_RATIO = 1.80   # 中央値のこの倍超 = 長すぎ

# 閾値変更の比較候補
ALT_GAPS = [2.05, 2.1, 2.15, 2.2]


def duration(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True).stdout.strip()
    return float(out)


def all_silences(path):
    """全無音区間 (start, end, dur) を返す（絶対秒）。"""
    cmd = [FFMPEG, "-i", path, "-af",
           f"silencedetect=noise={NOISE_DB}dB:d={MIN_SILENCE}", "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True).stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([-\d.]+)", out)]
    ends = re.findall(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", out)
    sils = []
    for i, (e, d) in enumerate(ends):
        s = starts[i] if i < len(starts) else None
        if s is None:
            continue
        sils.append((float(s), float(e), float(d)))
    return sils


def segments_for_gap(total, sils, gap):
    """指定 gap で単語境界（無音長>=gap）を切って、セグメント長リストを返す。"""
    cuts = [round((s + e) / 2, 3) for s, e, d in sils if d >= gap]
    bounds = [0.0] + cuts + [round(total, 3)]
    return [round(bounds[i + 1] - bounds[i], 2) for i in range(len(bounds) - 1)]


def main():
    data = json.load(open(SEGMENTS, encoding="utf-8"))
    pages_meta = {p["page"]: p for p in data["pages"]}
    files = sorted(f for f in os.listdir(RAW_DIR) if f.endswith(".mp3"))

    edge_rows = []      # きわどい無音
    short_rows = []     # 短すぎセグメント
    long_rows = []      # 長すぎセグメント
    gap_change = {g: {"lost_cuts": 0, "pages": set()} for g in ALT_GAPS}

    per_page = {}       # pid -> {sils,total,meta}

    for fname in files:
        pid = os.path.splitext(fname)[0]
        path = os.path.join(RAW_DIR, fname)
        total = duration(path)
        sils = all_silences(path)
        per_page[pid] = (total, sils)
        meta = pages_meta.get(pid)
        layout = meta["layout"] if meta else "?"

        # 1) きわどい無音
        for s, e, d in sils:
            if EDGE_LOW <= d <= EDGE_HIGH:
                is_cut = d >= WORD_GAP
                if MISFIRE_LOW <= d <= MISFIRE_HIGH:
                    suspect = "誤分割リスク(境界判定/単語内かも)"
                elif MISS_LOW <= d < MISS_HIGH:
                    suspect = "見逃しリスク(単語内判定/境界かも)"
                else:
                    suspect = ""
                edge_rows.append((pid, layout, round(s, 2), round(d, 3),
                                  "境界" if is_cut else "単語内", suspect))

        # 2) 短すぎ/長すぎセグメント（本体=先頭以外で中央値を取る）
        seglens = [seg["length"] for seg in meta["segments"]] if meta else []
        body = seglens[1:] if len(seglens) > 1 else seglens
        if body:
            med = statistics.median(body)
            for i, L in enumerate(seglens):
                if i == 0:
                    continue  # 先頭はアナウンス結合ありなので除外
                if L < med * SHORT_RATIO:
                    short_rows.append((pid, layout, i, L, round(med, 2),
                                       round(L / med * 100)))
                elif L > med * LONG_RATIO:
                    long_rows.append((pid, layout, i, L, round(med, 2),
                                      round(L / med * 100)))

        # 4) 閾値変更で消える cut を数える
        base_cuts = sum(1 for s, e, d in sils if d >= WORD_GAP)
        for g in ALT_GAPS:
            new_cuts = sum(1 for s, e, d in sils if d >= g)
            lost = base_cuts - new_cuts
            if lost > 0:
                gap_change[g]["lost_cuts"] += lost
                gap_change[g]["pages"].add(pid)

    # ---- 出力 ----
    print("#" * 100)
    print("【1】きわどい無音（長さ 1.8〜2.3秒）")
    print(f"{'page':>4} {'layout':>18} {'時刻s':>8} {'無音長':>7} {'現判定':>6}  疑い")
    print("-" * 100)
    misfire_pages, miss_pages = set(), set()
    for pid, layout, t, d, judge, suspect in edge_rows:
        mark = ""
        if MISFIRE_LOW <= d <= MISFIRE_HIGH:
            misfire_pages.add(pid); mark = "  ★"
        elif MISS_LOW <= d < MISS_HIGH:
            miss_pages.add(pid)
        print(f"{pid:>4} {layout:>18} {t:>8.2f} {d:>7.3f} {judge:>6}  {suspect}{mark}")
    print(f"\nきわどい無音 総数: {len(edge_rows)}")
    print(f"  誤分割リスク(2.0〜2.15s・境界判定): {sum(1 for r in edge_rows if MISFIRE_LOW<=r[3]<=MISFIRE_HIGH)} 件 / {len(misfire_pages)} ページ")
    print(f"  見逃しリスク(1.85〜2.0s・単語内判定): {sum(1 for r in edge_rows if MISS_LOW<=r[3]<MISS_HIGH)} 件 / {len(miss_pages)} ページ")

    print("\n" + "#" * 100)
    print(f"【2a】短すぎセグメント（本体中央値の{int(SHORT_RATIO*100)}%未満＝例文分離の疑い）")
    print(f"{'page':>4} {'layout':>18} {'segIdx':>6} {'長さ':>6} {'中央値':>7} {'比率%':>5}")
    print("-" * 60)
    short_pages = set()
    for pid, layout, i, L, med, pct in short_rows:
        short_pages.add(pid)
        print(f"{pid:>4} {layout:>18} {i:>6} {L:>6.2f} {med:>7.2f} {pct:>5}")
    print(f"短すぎセグメント: {len(short_rows)} 件 / {len(short_pages)} ページ")

    print("\n" + "#" * 100)
    print(f"【2b】長すぎセグメント（本体中央値の{int(LONG_RATIO*100)}%超＝2単語結合の疑い）")
    print(f"{'page':>4} {'layout':>18} {'segIdx':>6} {'長さ':>6} {'中央値':>7} {'比率%':>5}")
    print("-" * 60)
    long_pages = set()
    for pid, layout, i, L, med, pct in long_rows:
        long_pages.add(pid)
        print(f"{pid:>4} {layout:>18} {i:>6} {L:>6.2f} {med:>7.2f} {pct:>5}")
    print(f"長すぎセグメント: {len(long_rows)} 件 / {len(long_pages)} ページ")

    # ---- 突き合わせ: 要対処の疑いが濃いページ ----
    print("\n" + "#" * 100)
    print("【3】要対処の疑いが濃いページ（きわどい無音 かつ 短/長セグメント同居）")
    print("-" * 100)
    edge_all_pages = misfire_pages | miss_pages
    hot = sorted(edge_all_pages & (short_pages | long_pages))
    for pid in hot:
        reasons = []
        if pid in misfire_pages: reasons.append("2.0〜2.15s無音を境界判定")
        if pid in miss_pages: reasons.append("1.85〜2.0s無音を単語内判定")
        if pid in short_pages: reasons.append("短すぎseg有(例文分離疑い)")
        if pid in long_pages: reasons.append("長すぎseg有(2単語結合疑い)")
        print(f"  {pid}: {' / '.join(reasons)}")
    print(f"\n要対処の疑いが濃いページ数: {len(hot)}")
    print(f"（参考）きわどい無音を持つ全ページ: {len(edge_all_pages)}")
    print(f"（参考）短/長セグメントを持つ全ページ: {len(short_pages | long_pages)}")

    # ---- 閾値変更の影響見積り ----
    print("\n" + "#" * 100)
    print("【4】閾値変更の影響見積り（WORD_GAP=2.0 から上げた場合に消える境界cut数）")
    print(f"  消える境界 = 現状 境界判定されている無音のうち、新閾値未満になるもの")
    print("-" * 100)
    for g in ALT_GAPS:
        gc = gap_change[g]
        print(f"  GAP={g}: 消える境界 {gc['lost_cuts']} 件 / 影響 {len(gc['pages'])} ページ  {sorted(gc['pages'])}")
    print("\n※ 消える境界の多くが『2.0〜2.15sの誤分割』であれば改善。"
          "\n※ ただし本来の単語境界がちょうど2.0〜2.1sのページがあると新たな見逃しになる → 下の帯別内訳で判断。")

    # 帯別内訳（2.0-2.05, 2.05-2.1, 2.1-2.15, 2.15-2.2）
    print("\n【4補】現状『境界判定』されている無音の長さ分布（2.0〜2.3s帯）")
    band = {"2.00-2.05":0,"2.05-2.10":0,"2.10-2.15":0,"2.15-2.20":0,"2.20-2.30":0}
    band_pages = {k:set() for k in band}
    for pid,(total,sils) in per_page.items():
        for s,e,d in sils:
            if d < WORD_GAP: continue
            if d<2.05: k="2.00-2.05"
            elif d<2.10: k="2.05-2.10"
            elif d<2.15: k="2.10-2.15"
            elif d<2.20: k="2.15-2.20"
            elif d<2.30: k="2.20-2.30"
            else: continue
            band[k]+=1; band_pages[k].add(pid)
    for k,v in band.items():
        print(f"  {k}s: {v} 件 / {len(band_pages[k])} ページ  {sorted(band_pages[k])}")


if __name__ == "__main__":
    main()
