#!/usr/bin/env python3
"""機能B（聞き流し用まとめ音声）: segments.json を元に、各単語の音声を
50語 / 100語ごとに 1本の mp3 へ連結して audio/chunks/ に出力する。

連結を1本にする理由（CLAUDE.md）: iOS はロック中に JS 実行を絞るため、
audio.onended で次を鳴らす方式は止まりうる。連結した1本なら確実に流れる。

この第一段階では 2 バージョンを並行生成し、聴き比べで良し悪しを判断できるようにする:
  - full     : 単語セグメント全体（単語→訳→例文2つ）をそのまま繋ぐ
  - wordonly : セグメント内を無音でブロック分割し、先頭2ブロック（単語＋訳）だけを繋ぐ
               ※ word_only ページは元々「単語＋訳」なので full と実質同じ素材になる

各単語の再生範囲:
  - type=word+announce の先頭セグメントは announce_end 以降が単語（アナウンスを除外）
  - それ以外は start〜end

出力ファイル名:
  chunk_050_001.mp3 (1〜50語) / chunk_100_001.mp3 (1〜100語)
  版ごとにサブフォルダ audio/chunks/full/ , audio/chunks/wordonly/ に出す。

元音声（audio/raw/）は読み取り専用。出力のみ audio/chunks/。
"""
import subprocess
import os
import re
import json
import shutil

FFMPEG = "/opt/homebrew/bin/ffmpeg"
ROOT = "/Users/rikikun/dev/vocab-audio-separator-summary"
RAW_DIR = f"{ROOT}/audio/raw"
CHUNK_DIR = f"{ROOT}/audio/chunks"
META = f"{ROOT}/data/segments.json"

# --- パラメータ（変更しやすいよう先頭に集約）---
NOISE_DB = -30            # 無音判定レベル（build_metadata.py と同じ）
MIN_SILENCE = 0.4         # ブロック境界とみなす最小無音長（秒）
WORDONLY_BLOCKS = 2       # 「単語＋訳」= セグメント内 先頭ブロック数
EDGE_EPS = 0.15           # セグメント端の無音(単語境界)を内部境界から除外する余白(秒)
GAP_SEC = 0.3             # 単語間に挟む無音（聞きやすさ用）
CHUNK_SIZES = [50, 100]   # まとめる語数
VERSIONS = ["full", "wordonly"]

SAMPLE_RATE = 44100       # 元音声のサンプルレート（全ファイル統一済み）
CHANNELS_LAYOUT = "stereo"  # 元音声のチャンネルレイアウト（ギャップ無音を揃える用）


def detect_silences(path):
    """全無音区間 (start, end, dur) を絶対秒で返す。"""
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


def word_play_range(seg):
    """その単語セグメントの「単語本体」再生範囲 (start, end)。
    アナウンス結合セグメントは announce_end 以降を単語とみなす。
    """
    start = seg.get("announce_end", seg["start"])
    return round(start, 3), round(seg["end"], 3)


def wordonly_range(seg, sils):
    """セグメント内を無音ブロック分割し、先頭 WORDONLY_BLOCKS ブロック（単語＋訳）の
    範囲 (start, end) を返す。内部境界が足りなければ full と同じ範囲にフォールバック。

    内部境界 = start<mid<end を満たす無音の中点。ブロック k の終端 =
    内部境界[k-1]。単語＋訳 = start 〜 内部境界[WORDONLY_BLOCKS-1]。
    """
    start, end = word_play_range(seg)
    # セグメント端(=単語境界の無音)の中点は start/end とほぼ一致する。これを内部境界に
    # 含めると「単語→訳」ではなく「単語」だけで切れてしまうため EDGE_EPS 余白で除外する。
    inner = sorted(round((s + e) / 2, 3) for s, e, d in sils
                   if start + EDGE_EPS < (s + e) / 2 < end - EDGE_EPS)
    # WORDONLY_BLOCKS ブロック取るには境界が WORDONLY_BLOCKS 個必要
    # （先頭2ブロック = 内部境界[1] まで）。無ければ全境界の最後まで＝実質full。
    if len(inner) >= WORDONLY_BLOCKS:
        return start, inner[WORDONLY_BLOCKS - 1]
    if inner:
        return start, inner[-1]
    return start, end   # 内部無音なし → セグメント全体（例文なしの短い語など）


def collect_words(data):
    """segments.json から順序どおりに単語リストを作る。
    各要素: dict(page, src, full=(s,e), wordonly=(s,e))。
    """
    words = []
    sil_cache = {}
    for page in data["pages"]:
        pid = page["page"]
        src = f"{RAW_DIR}/{pid}.mp3"
        if src not in sil_cache:
            sil_cache[src] = detect_silences(src)
        sils = sil_cache[src]
        for seg in page["segments"]:
            if seg["type"] not in ("word", "word+announce"):
                continue
            words.append({
                "page": pid,
                "src": src,
                "full": word_play_range(seg),
                "wordonly": wordonly_range(seg, sils),
            })
    return words


def extract_clip(src, s, e, out):
    """単語区間を mp3 で切り出す。
    元音声は全ファイル 44100Hz/stereo で統一されているため（build_chunks 実行前に検証）、
    再エンコードせず -c copy で切り出す（音質劣化なし・高速）。
    -map 0:a で埋め込みカバー画像(mjpeg)を除外する。
    """
    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-i", src,
         "-ss", str(s), "-to", str(e), "-map", "0:a", "-c", "copy", out],
        check=True)


def make_silence(out, dur):
    """指定秒の無音 mp3 を作る（単語間ギャップ用）。元音声と同じ 44100Hz/stereo。"""
    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", f"anullsrc=r={SAMPLE_RATE}:cl={CHANNELS_LAYOUT}", "-t", str(dur),
         "-q:a", "2", out],
        check=True)


def concat_mp3(clip_paths, out):
    """concat demuxer で mp3 群を1本に連結する（-c copy・無劣化）。
    独立した mp3 を繋ぐと各クリップ由来のタイムスタンプが非単調になり
    「non monotonically increasing dts」警告が出る。再生自体は問題ないが、
    -avoid_negative_ts make_zero + -fflags +genpts でタイムスタンプを振り直して
    クリーンな1本にする（尺は不変）。
    """
    listfile = out + ".txt"
    with open(listfile, "w") as f:
        for p in clip_paths:
            f.write(f"file '{p}'\n")
    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", listfile, "-c", "copy",
         "-avoid_negative_ts", "make_zero", "-fflags", "+genpts", out],
        check=True)
    os.remove(listfile)


def probe_audio_params(path):
    """(sample_rate, channels) を返す。-c copy 連結の前提検証用。"""
    out = subprocess.run(
        ["/opt/homebrew/bin/ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=sample_rate,channels",
         "-of", "csv=p=0", path],
        capture_output=True, text=True).stdout.strip().split("\n")[0]
    sr, ch = out.split(",")
    return int(sr), int(ch)


def preflight(data):
    """全 raw ファイルが同一フォーマットか検証する。
    -c copy での切り出し・連結は同一 sample_rate/channels が前提。
    """
    params = set()
    for page in data["pages"]:
        src = f"{RAW_DIR}/{page['page']}.mp3"
        params.add(probe_audio_params(src))
    if len(params) != 1:
        raise SystemExit(f"raw のフォーマットが不統一: {params}（-c copy 不可）")
    sr, ch = next(iter(params))
    if (sr, ch) != (SAMPLE_RATE, 2):
        raise SystemExit(f"想定外フォーマット {sr}Hz/{ch}ch（定数を見直すこと）")
    print(f"preflight: raw 全ファイル {sr}Hz/{ch}ch で統一 => -c copy 可")


def probe_duration(path):
    out = subprocess.run(
        ["/opt/homebrew/bin/ffprobe", "-v", "error",
         "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True).stdout.strip()
    return float(out) if out else 0.0


def build_version(words, version, workdir):
    """1バージョン分の単語クリップ＋ギャップを生成し、50/100語チャンクへ連結する。
    戻り値: 検証用サマリ dict。
    """
    vdir = f"{CHUNK_DIR}/{version}"
    os.makedirs(vdir, exist_ok=True)
    clipdir = f"{workdir}/{version}"
    os.makedirs(clipdir, exist_ok=True)

    # 単語クリップを全て切り出す（両サイズで共有）
    clip_paths = []
    for i, w in enumerate(words):
        s, e = w[version]
        cp = f"{clipdir}/w{i+1:03d}.mp3"
        extract_clip(w["src"], s, e, cp)
        clip_paths.append(cp)

    gap = f"{clipdir}/_gap.mp3"
    make_silence(gap, GAP_SEC)

    summary = {"version": version, "chunks": []}
    for size in CHUNK_SIZES:
        n_chunks = (len(words) + size - 1) // size
        for c in range(n_chunks):
            group = clip_paths[c*size:(c+1)*size]
            # 単語間にギャップを挟む（末尾には付けない）
            seq = []
            for j, cp in enumerate(group):
                if j > 0:
                    seq.append(gap)
                seq.append(cp)
            out = f"{vdir}/chunk_{size:03d}_{c+1:03d}.mp3"
            concat_mp3(seq, out)
            summary["chunks"].append({
                "file": out,
                "size": size,
                "index": c + 1,
                "words": len(group),
                "duration": round(probe_duration(out), 2),
            })
    return summary


def main():
    with open(META, encoding="utf-8") as f:
        data = json.load(f)

    preflight(data)
    words = collect_words(data)
    print(f"素材: {len(words)} 単語（type=word / word+announce）")

    workdir = f"{CHUNK_DIR}/_clips"
    os.makedirs(workdir, exist_ok=True)

    all_summaries = []
    for version in VERSIONS:
        print(f"\n--- version: {version} ---")
        summary = build_version(words, version, workdir)
        all_summaries.append(summary)
        for size in CHUNK_SIZES:
            chs = [c for c in summary["chunks"] if c["size"] == size]
            total_words = sum(c["words"] for c in chs)
            total_dur = sum(c["duration"] for c in chs)
            print(f"  {size}語版: {len(chs)}本 / 収録 {total_words}語 / "
                  f"合計 {round(total_dur/60,1)}分")

    # 自己検証（数値）
    print("\n=== 自己検証 ===")
    ok = True
    for summary in all_summaries:
        for size in CHUNK_SIZES:
            chs = [c for c in summary["chunks"] if c["size"] == size]
            total_words = sum(c["words"] for c in chs)
            expect_chunks = (len(words) + size - 1) // size
            status = "OK" if (total_words == len(words)
                              and len(chs) == expect_chunks) else "NG"
            if status == "NG":
                ok = False
            print(f"  [{summary['version']}/{size}] 本数 {len(chs)}"
                  f"(期待{expect_chunks}) / 収録語 {total_words}(期待{len(words)}) => {status}")
    print("=> " + ("全チェックPASS" if ok else "検証NGあり"))

    # 中間クリップ（単語切り出し）は最終成果物ではないので掃除する
    shutil.rmtree(workdir, ignore_errors=True)
    print(f"\n中間クリップ {workdir} を削除")
    print(f"成果物: {CHUNK_DIR}/full/ , {CHUNK_DIR}/wordonly/")


if __name__ == "__main__":
    main()
