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

# 【修正②】短小セグメント結合（例文分離の修正）:
# 2.0秒ちょうど付近の無音が WORD_GAP にギリギリ引っかかり、本来「例文の間（単語内区切り）」
# なのに単語境界と誤判定されるページがある（050/095/096/098）。結果、例文が独立した
# 極端に短いセグメントに分離する。本体(index1以降)で「そのページ本体中央値の45%未満」の
# セグメントを例文分離とみなし、直前セグメントに結合して単語に戻す。
# 45%: 調査で 095 が中央値の43% と判明したため 40%→45% に緩めて拾う。
# 巻き込み検証済み（050/095/096/098 の各1セグメントのみヒット・他ページ不変）。
SHORT_MERGE_RATIO = 0.45

# 【修正①】アナウンス切り離し（案①(a)中央値基準・検証済み）:
# has_announce の先頭セグメント末尾から「本体中央値ぶん」遡った時刻を単語1開始の目安とし、
# 最も近い内部無音境界(0.4秒以上の中点)にスナップして announce_end を確定する。
LEAD_EDGE = 0.15          # 冒頭の無音余白とみなす範囲（seg0 開始からこの秒数以内に始まる無音）
ANNOUNCE_LOW_CONF = 0.5   # アナウンス長がこれ未満なら low_confidence フラグ（実聴確認用）

# 今回のHSK3級は正解データがあるので、それを優先してラベルを確定する。
ANNOUNCE_JSON = "/Users/rikikun/dev/vocab-audio-separator/data/announce_pages.json"


def duration(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True).stdout.strip()
    return float(out)


def detect_silences(path):
    """全無音区間 (start, end, dur) を返す（絶対秒）。単語境界・内部ブロック両方に使う。"""
    cmd = [FFMPEG, "-i", path, "-af",
           f"silencedetect=noise={NOISE_DB}dB:d={MIN_SILENCE}", "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True).stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", out)]
    ends = re.findall(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", out)
    sils = []
    for i, (end, dur) in enumerate(ends):
        s = starts[i] if i < len(starts) else None
        if s is not None:
            sils.append((float(s), float(end), float(dur)))
    return sils


def detect_cuts(sils):
    """無音長 >= WORD_GAP を単語境界とみなし、その中点を切断点として返す。"""
    return [round((s + e) / 2, 3) for s, e, d in sils if d >= WORD_GAP]


def merge_short_segments(bounds, seg_lengths):
    """【修正②】本体(index1以降)の極端に短いセグメント（例文分離）を直前に結合する。
    戻り値: (新bounds, 新seg_lengths, merged_flags)
    merged_flags[i] = そのセグメントが結合を受けた(直後の短小を吸収した)なら True。
    """
    if len(seg_lengths) < 3:
        return bounds, seg_lengths, [False] * len(seg_lengths)
    body = seg_lengths[1:]
    med = statistics.median(body)
    # 結合対象: index>=1 かつ 本体中央値の SHORT_MERGE_RATIO 未満
    drop = set()
    for i in range(1, len(seg_lengths)):
        if seg_lengths[i] < med * SHORT_MERGE_RATIO:
            drop.add(i)  # このセグメント境界(bounds[i])を消して直前に結合
    if not drop:
        return bounds, seg_lengths, [False] * len(seg_lengths)
    # bounds[i]（=セグメントiの開始）を消すとセグメントi-1とiが結合する
    new_bounds = [bounds[0]]
    merged_flags_new = []
    absorbed = False
    for i in range(1, len(bounds)):
        # bounds[i] はセグメント(i-1)の終端 / セグメントiの始端
        if i in drop:
            # このセグメント境界を消す = 直前セグメントに吸収
            absorbed = True
            continue
        new_bounds.append(bounds[i])
    new_lengths = [round(new_bounds[j+1] - new_bounds[j], 2)
                   for j in range(len(new_bounds) - 1)]
    # merged フラグ: 吸収を受けたセグメント（短小の直前）を True にする
    merged_flags = [False] * len(new_lengths)
    if absorbed:
        # drop された index の直前(new側)を特定
        for di in sorted(drop):
            # di の直前セグメント = 元index di-1。結合後もそのセグメントは残っている
            # 新indexは「元index di-1 のうち drop より前で消えた数」を引く
            shift = sum(1 for x in drop if x <= di - 1)
            ni = (di - 1) - shift
            if 0 <= ni < len(merged_flags):
                merged_flags[ni] = True
    return new_bounds, new_lengths, merged_flags


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


def compute_announce_end(seg0_start, seg0_end, body_median, sils):
    """【修正①】案①(a)中央値基準で先頭セグメント内のアナウンス/単語1境界を求める。
    末尾から body_median ぶん遡った目安時刻を、最も近い内部無音境界(中点)にスナップ。
    目安が負なら先頭寄りの最初の境界にスナップ。境界候補が無ければ None。
    """
    # ページ冒頭の無音余白（start≈seg0_start）は境界候補から外す。含めると短いアナウンスで
    # この余白が選ばれ、アナウンスが単語側に残る（021/034/045/095/097）。
    inner = sorted(round((s + e) / 2, 3) for s, e, d in sils
                   if s > seg0_start + LEAD_EDGE and seg0_start < (s + e) / 2 < seg0_end)
    if not inner:
        return None
    target = seg0_end - body_median
    if target <= seg0_start:
        return inner[0]  # 目安が先頭より前 → 最初の内部境界
    return min(inner, key=lambda b: abs(b - target))


def main():
    truth_short, truth_long = load_truth()
    files = sorted(f for f in os.listdir(RAW_DIR) if f.endswith(".mp3"))
    pages = []
    total_merges = 0
    for fname in files:
        path = os.path.join(RAW_DIR, fname)
        page_id = os.path.splitext(fname)[0]
        total = duration(path)
        sils = detect_silences(path)
        cuts = detect_cuts(sils)
        bounds = [0.0] + cuts + [round(total, 3)]
        seg_lengths = [round(bounds[i+1] - bounds[i], 2) for i in range(len(bounds)-1)]

        # 【修正②】短小セグメント結合（例文分離の修正）を先に適用
        bounds, seg_lengths, merged_flags = merge_short_segments(bounds, seg_lengths)
        n_merged = sum(merged_flags)
        total_merges += n_merged

        # 結合を反映した後の本体中央値でラベル・アナウンス切り離しを行う
        types = label_segments(seg_lengths, page_id, truth_short, truth_long)
        body = seg_lengths[1:] if len(seg_lengths) > 1 else seg_lengths
        med = statistics.median(body)

        # 【修正①】アナウンス切り離し: 先頭が word+announce のとき announce_end を算出
        announce_end = None
        announce_low_conf = False
        if types[0] == "word+announce":
            announce_end = compute_announce_end(bounds[0], bounds[1], med, sils)
            if announce_end is not None and (announce_end - bounds[0]) < ANNOUNCE_LOW_CONF:
                announce_low_conf = True

        segments = []
        for i in range(len(bounds) - 1):
            seg = {
                "index": i,
                "start": round(bounds[i], 3),
                "end": round(bounds[i+1], 3),
                "length": seg_lengths[i],
                "type": types[i],
            }
            if merged_flags[i]:
                seg["merged"] = True  # 例文分離を結合して単語に戻したセグメント
            if i == 0 and announce_end is not None:
                seg["announce_end"] = round(announce_end, 3)
                # 単語1再生は announce_end〜end、アナウンス部は start〜announce_end
                if announce_low_conf:
                    seg["announce_low_confidence"] = True
            segments.append(seg)

        # ページ構成の推定: 本体セグメント長の中央値が短ければ「単語のみ」
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
        mflag = f" [結合×{n_merged}]" if n_merged else ""
        print(f"{page_id}: {len(segments)}seg / {layout} / {word_count}語 {flag}{mflag}")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"book": "HSK3級単語", "pages": pages}, f, ensure_ascii=False, indent=2)
    print(f"\n→ {OUT} に書き出し（{len(pages)}ページ / 短小結合 計{total_merges}件）")


if __name__ == "__main__":
    main()
