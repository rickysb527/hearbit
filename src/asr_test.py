#!/usr/bin/env python3
"""ASR precision test for HSK word audio (pages 001-003).

Goal: check whether Chinese speech recognition (Whisper) can auto-extract
hanzi + pinyin from each word's audio, before rolling out to all 650 words.

- Reads latest data/segments.json (start/end, type, announce_end).
- Cuts each word segment. For type=word+announce, start from announce_end.
- Also isolates the LEADING pronunciation block (word only, before the
  Japanese translation) by finding the first intra-word silence.
- Transcribes with faster-whisper (zh), then adds pinyin via pypinyin.

This is an INVESTIGATION script. It does not modify segments.json or audio/raw.
Work files go to /tmp/asr_test/.
"""
import json
import os
import subprocess
import sys

# ---- tunable params -------------------------------------------------------
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
PROJECT = "/Users/rikikun/dev/vocab-audio-separator"
RAW_DIR = os.path.join(PROJECT, "audio", "raw")
SEGMENTS = os.path.join(PROJECT, "data", "segments.json")
WORK = "/tmp/asr_test"
PAGES = {"001", "002", "003"}

# intra-word silence detection (word -> translation -> examples)
BLOCK_SILENCE_DB = "-35dB"
BLOCK_SILENCE_MIN = 0.4      # seconds; a gap >= this ends the leading block
LEAD_MIN = 0.8               # min length of leading block to trust it
LEAD_MAX = 4.0               # cap; the pronounced word is short
PAD = 0.15                   # small pad added after detected block end

MODEL_SIZE = os.environ.get("ASR_MODEL", "medium")
# --------------------------------------------------------------------------


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def cut(src, start, end, dst):
    dur = end - start
    run([FFMPEG, "-y", "-ss", f"{start:.3f}", "-i", src,
         "-t", f"{dur:.3f}", "-ar", "16000", "-ac", "1", dst])


def first_block_end(src, start, end):
    """Find end (relative to `start`) of the leading pronunciation block by
    locating the first silence >= BLOCK_SILENCE_MIN within [start, end]."""
    dur = end - start
    tmp = os.path.join(WORK, "_probe.wav")
    run([FFMPEG, "-y", "-ss", f"{start:.3f}", "-i", src,
         "-t", f"{dur:.3f}", "-ar", "16000", "-ac", "1", tmp])
    res = run([FFMPEG, "-i", tmp, "-af",
               f"silencedetect=noise={BLOCK_SILENCE_DB}:d={BLOCK_SILENCE_MIN}",
               "-f", "null", "-"])
    # parse first "silence_start"
    for line in res.stderr.splitlines():
        if "silence_start" in line:
            try:
                t = float(line.split("silence_start:")[1].strip().split()[0])
            except (IndexError, ValueError):
                continue
            if LEAD_MIN <= t <= LEAD_MAX:
                return t
    return None


def probe_dur(path):
    r = run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path])
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def main():
    os.makedirs(WORK, exist_ok=True)
    data = json.load(open(SEGMENTS))

    # lazy import so venv errors surface clearly
    from faster_whisper import WhisperModel
    from pypinyin import lazy_pinyin, Style

    sys.stderr.write(f"Loading faster-whisper model '{MODEL_SIZE}' (int8 cpu)...\n")
    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")

    def transcribe(path):
        segs, _ = model.transcribe(
            path, language="zh", beam_size=5,
            initial_prompt="以下是普通话的词语。",
            condition_on_previous_text=False,
        )
        return "".join(s.text for s in segs).strip()

    rows = []
    seq = 0
    for page in data["pages"]:
        if page["page"] not in PAGES:
            continue
        src = os.path.join(RAW_DIR, page["page"] + ".mp3")
        for s in page["segments"]:
            seq += 1
            start = s["start"]
            if s["type"] == "word+announce" and s.get("announce_end"):
                start = s["announce_end"]
            end = s["end"]

            full = os.path.join(WORK, f"{page['page']}_{s['index']:02d}_full.wav")
            cut(src, start, end, full)

            # leading block only
            be = first_block_end(src, start, end)
            if be is not None:
                lead_end = start + min(be + PAD, LEAD_MAX)
                lead = os.path.join(WORK, f"{page['page']}_{s['index']:02d}_lead.wav")
                cut(src, start, lead_end, lead)
                lead_len = probe_dur(lead)
            else:
                lead, lead_len = None, None

            txt_full = transcribe(full)
            txt_lead = transcribe(lead) if lead else ""

            def to_py(hz):
                if not hz:
                    return ""
                only = "".join(c for c in hz if "一" <= c <= "鿿")
                if not only:
                    return ""
                return " ".join(lazy_pinyin(only, style=Style.TONE))

            rows.append({
                "seq": seq,
                "page": page["page"],
                "idx": s["index"],
                "full_len": round(probe_dur(full), 2),
                "lead_len": round(lead_len, 2) if lead_len else None,
                "hz_full": txt_full,
                "py_full": to_py(txt_full),
                "hz_lead": txt_lead,
                "py_lead": to_py(txt_lead),
            })
            sys.stderr.write(f"  done seq {seq} {page['page']}_{s['index']:02d}\n")

    json.dump(rows, open(os.path.join(WORK, "results.json"), "w"),
              ensure_ascii=False, indent=2)

    # print table
    print("\n=== ASR results (model=%s) ===\n" % MODEL_SIZE)
    hdr = f"{'#':>2} {'page':>4} {'idx':>3} {'full_len':>8} {'lead_len':>8}  hanzi(full) | pinyin(full)"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(f"{r['seq']:>2} {r['page']:>4} {r['idx']:>3} "
              f"{r['full_len']:>8} {str(r['lead_len']):>8}  "
              f"{r['hz_full']} | {r['py_full']}")
    print("\n--- leading-block-only recognition ---")
    for r in rows:
        print(f"{r['seq']:>2} {r['page']}_{r['idx']:02d}  "
              f"lead='{r['hz_lead']}' ({r['py_lead']})")
    print("\nresults.json ->", os.path.join(WORK, "results.json"))


if __name__ == "__main__":
    main()
