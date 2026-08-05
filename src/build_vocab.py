#!/usr/bin/env python3
"""全650単語の漢字・ピンインを音声認識で自動生成し data/vocab.json を作る。

方針（精度テスト src/asr_test.py で検証済み・16/18→照合で実質全問）:
- data/segments.json の各単語（type=word / word+announce）を対象。
  word+announce は announce_end 以降が単語本体。
- 各単語について2通り認識し照合して信頼度を付ける:
    lead : 先頭ブロックのみ（単語→訳の間の無音まで）= 単語の発音部分だけ。本命。
    full : セグメント全体の「冒頭トークン」（アナウンサーは単語→訳→例文の順で
           最初に単語を読むため、full の先頭も単語になる）。照合用。
- 判定:
    lead と full冒頭が一致 → confidence "high"
    不一致 → full冒頭を採用しつつ low_confidence=true（要人手確認）
    lead が取れない/空 → full冒頭、無ければ空欄で low_confidence=true
- ピンインは pypinyin(TONE) で漢字から機械付与。
- 訳(日本語)は音声から取れないので "" のまま（後で辞書/手動で補完）。

出力: data/vocab.json  … segments.json と同じ順で 650 件。
  各要素: { seq, page, index, hanzi, pinyin, gloss:"", low_confidence, source }
レジューム: 既存 vocab.json があれば処理済み seq をスキップ（再開可能）。

元音声(audio/raw)・segments.json は読み取り専用。
"""
import json
import os
import re
import subprocess
import sys

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
PROJECT = "/Users/rikikun/dev/vocab-audio-separator"
RAW_DIR = os.path.join(PROJECT, "audio", "raw")
SEGMENTS = os.path.join(PROJECT, "data", "segments.json")
OUT = os.path.join(PROJECT, "data", "vocab.json")
WORK = "/tmp/vocab_build"

# 先頭ブロック（単語部分）分離のパラメータ（asr_test.py と同じ）
BLOCK_SILENCE_DB = "-35dB"
BLOCK_SILENCE_MIN = 0.4
LEAD_MIN = 0.8
LEAD_MAX = 4.0
PAD = 0.15

MODEL_SIZE = os.environ.get("ASR_MODEL", "medium")

# 短音で出やすい Whisper の幻聴フレーズ（学習データ由来の定型句）を除去する
HALLUCINATION = ["点赞", "订阅", "转发", "字幕", "关注", "谢谢观看", "请不吝",
                 "明镜", "点点栏目", "感谢"]


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def cut(src, start, end, dst):
    dur = max(0.05, end - start)
    run([FFMPEG, "-y", "-ss", f"{start:.3f}", "-i", src,
         "-t", f"{dur:.3f}", "-ar", "16000", "-ac", "1", dst])


def first_block_end(src, start, end):
    """先頭ブロック（単語）の終端を、最初の無音>=BLOCK_SILENCE_MIN で探す。"""
    dur = end - start
    tmp = os.path.join(WORK, "_probe.wav")
    run([FFMPEG, "-y", "-ss", f"{start:.3f}", "-i", src,
         "-t", f"{dur:.3f}", "-ar", "16000", "-ac", "1", tmp])
    res = run([FFMPEG, "-i", tmp, "-af",
               f"silencedetect=noise={BLOCK_SILENCE_DB}:d={BLOCK_SILENCE_MIN}",
               "-f", "null", "-"])
    for line in res.stderr.splitlines():
        if "silence_start" in line:
            try:
                t = float(line.split("silence_start:")[1].strip().split()[0])
            except (IndexError, ValueError):
                continue
            if LEAD_MIN <= t <= LEAD_MAX:
                return t
    return None


def only_hanzi(s):
    return "".join(c for c in s if "一" <= c <= "鿿")


def clean_hallucination(s):
    for h in HALLUCINATION:
        if h in s:
            s = s.replace(h, "")
    return s


def first_token_hanzi(text, max_len=4):
    """full 認識テキストの「冒頭の単語」を漢字だけで取り出す。
    句読点や空白で最初のまとまりを取り、幻聴語を除去。
    HSK単語は最長でも4文字程度（办公室=3, 笔记本=3）なので、句読点で
    区切れない（単語＋例文が連続認識された）場合に備え max_len で頭を丸める。
    """
    text = clean_hallucination(text)
    m = re.match(r"[一-鿿]+", text)
    tok = m.group(0) if m else only_hanzi(text)[:max_len]
    # 単語＋例文が句読点なしで繋がったケース: 冒頭 max_len 文字に丸める
    if len(tok) > max_len:
        tok = tok[:max_len]
    return tok


def main():
    os.makedirs(WORK, exist_ok=True)
    data = json.load(open(SEGMENTS))

    from faster_whisper import WhisperModel
    from pypinyin import lazy_pinyin, Style

    def to_py(hz):
        h = only_hanzi(hz)
        return " ".join(lazy_pinyin(h, style=Style.TONE)) if h else ""

    # レジューム: 既存の処理済み seq を読み込む
    done = {}
    if os.path.exists(OUT):
        try:
            for e in json.load(open(OUT)):
                done[e["seq"]] = e
        except (json.JSONDecodeError, KeyError):
            done = {}

    # 対象単語リストを作る（seq は segments.json 順の通し番号）
    targets = []
    seq = 0
    for page in data["pages"]:
        for s in page["segments"]:
            if s["type"] not in ("word", "word+announce"):
                continue
            seq += 1
            start = s["start"]
            if s["type"] == "word+announce" and s.get("announce_end"):
                start = s["announce_end"]
            targets.append({"seq": seq, "page": page["page"],
                            "index": s["index"],
                            "start": round(start, 3), "end": round(s["end"], 3)})
    total = len(targets)
    sys.stderr.write(f"targets={total}, already done={len(done)}\n")

    sys.stderr.write(f"Loading faster-whisper '{MODEL_SIZE}' (int8 cpu)...\n")
    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")

    def transcribe(path):
        segs, _ = model.transcribe(
            path, language="zh", beam_size=5,
            initial_prompt="以下是普通话的词语。",
            condition_on_previous_text=False,
            no_speech_threshold=0.6, compression_ratio_threshold=2.0)
        return "".join(s.text for s in segs).strip()

    results = dict(done)  # seq -> entry
    processed = 0
    for t in targets:
        if t["seq"] in results and results[t["seq"]].get("hanzi"):
            continue  # 既に漢字ありは再処理しない（レジューム）
        src = os.path.join(RAW_DIR, t["page"] + ".mp3")
        start, end = t["start"], t["end"]

        full = os.path.join(WORK, f"{t['page']}_{t['index']:02d}_full.wav")
        cut(src, start, end, full)
        be = first_block_end(src, start, end)
        lead = None
        if be is not None:
            lead = os.path.join(WORK, f"{t['page']}_{t['index']:02d}_lead.wav")
            cut(src, start, start + min(be + PAD, LEAD_MAX), lead)

        hz_full_raw = transcribe(full)
        hz_lead_raw = transcribe(lead) if lead else ""
        # lead は単語部分だけを無音で切り出しているので例文が混ざらない → 主軸。
        # ただし lead 自体も長すぎる（幻聴・訳混入）場合に備え頭を丸める。
        lead_tok = first_token_hanzi(clean_hallucination(hz_lead_raw))
        full_tok = first_token_hanzi(hz_full_raw)

        # 判定（lead主軸・full照合）:
        #   lead と full冒頭が一致 → 最も信頼できる（high）
        #   lead はあるが full と不一致 → lead 採用（単語部分の切り出しは確実）だが要確認
        #   lead 無し → full冒頭にフォールバック（要確認）
        if lead_tok and full_tok and lead_tok == full_tok:
            hanzi, low, source = lead_tok, False, "lead==full"
        elif lead_tok:
            hanzi, low, source = lead_tok, (lead_tok != full_tok), \
                ("lead(=full頭)" if lead_tok == full_tok else "lead(mismatch)")
        elif full_tok:
            hanzi, low, source = full_tok, True, "full-only"
        else:
            hanzi, low, source = "", True, "empty"

        results[t["seq"]] = {
            "seq": t["seq"], "page": t["page"], "index": t["index"],
            "hanzi": hanzi, "pinyin": to_py(hanzi), "gloss": "",
            "low_confidence": low, "source": source,
            "asr_lead": lead_tok, "asr_full": full_tok,
        }
        processed += 1
        sys.stderr.write(
            f"  seq {t['seq']}/{total} {t['page']}_{t['index']:02d} "
            f"-> '{hanzi}' low={low} ({source})\n")

        # 逐次保存（レジューム＆途中経過確認のため）
        if processed % 2 == 0:
            ordered = [results[k] for k in sorted(results)]
            json.dump(ordered, open(OUT, "w"), ensure_ascii=False, indent=2)

    ordered = [results[k] for k in sorted(results)]
    json.dump(ordered, open(OUT, "w"), ensure_ascii=False, indent=2)

    filled = sum(1 for e in ordered if e.get("hanzi"))
    low = sum(1 for e in ordered if e.get("low_confidence"))
    sys.stderr.write(
        f"\nDONE: {len(ordered)}/{total} entries, hanzi filled {filled}, "
        f"low_confidence {low}\n")
    print(json.dumps({"total_targets": total, "entries": len(ordered),
                      "hanzi_filled": filled, "low_confidence": low},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
