#!/usr/bin/env python3
"""Word-level transcription with faster-whisper, run locally.

  transcribe.py <audio-or-video> --outdir <work> [--model small] [--vocab "Kafka, Jane Doe"]
                [--language en] [--device auto|cpu|cuda] [--compute-type auto|int8|float16]

Writes to <work>:
  words.json       every word: {"w": "Kafka,", "s": 3.12, "e": 3.48, "p": 0.97}  (seconds of the input)
  transcript.txt   one phrase per line: "[3.12] Kafka,@3.12 keeps@3.50 …"  (the times you cut to)

--model is a faster-whisper name (tiny, base, small, medium, large-v3, large-v3-turbo) or a local
CTranslate2 model folder. Defaults: MYTOMA_WHISPER_MODEL, else "small". --device auto uses an Nvidia
GPU when CUDA is available (several times faster), else the CPU with int8.

The audio never leaves the machine. The first run downloads the model once (from Hugging Face).
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path


def pick_device(device, compute_type):
    if device == "auto":
        try:
            import ctranslate2
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            device = "cpu"
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    return device, compute_type


def phrases(words, max_gap=0.45, max_words=12):
    """Group words into readable lines: break on sentence ends, pauses, and a length cap."""
    out, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        end = w["w"].rstrip().endswith((".", "?", "!"))
        gap = nxt is not None and nxt["s"] - w["e"] > max_gap
        if end or gap or len(cur) >= max_words or nxt is None:
            out.append(cur)
            cur = []
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("input")
    p.add_argument("--outdir", required=True)
    p.add_argument("--model", default=os.environ.get("MYTOMA_WHISPER_MODEL", "small"))
    p.add_argument("--vocab", default="", help="names and terms the speaker uses, to spell them right")
    p.add_argument("--language", default=None, help="e.g. en; detected when omitted")
    p.add_argument("--device", default="auto")
    p.add_argument("--compute-type", default="auto")
    args = p.parse_args()

    src = Path(args.input).expanduser()
    if not src.is_file():
        sys.exit(f"Not a file: {src}")
    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper is not installed: pip install faster-whisper  (scripts/setup.sh does this)")

    # Decode with ffmpeg ourselves (16 kHz mono float), not through faster-whisper's PyAV: PyAV releases
    # break it (av 19 fails on open), and ffmpeg already handles every container and rotation we meet.
    import subprocess
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(src), "-vn", "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                         capture_output=True)
    if raw.returncode != 0:
        sys.exit(f"ffmpeg could not read the audio of {src}: {raw.stderr.decode(errors='replace').strip()}")
    audio = np.frombuffer(raw.stdout, dtype=np.float32)

    device, compute_type = pick_device(args.device, args.compute_type)
    started = time.time()
    print(f"loading {args.model} on {device} ({compute_type})…", flush=True)
    model = WhisperModel(args.model, device=device, compute_type=compute_type)
    prompt = f"Vocabulary: {args.vocab}." if args.vocab.strip() else None
    segments, info = model.transcribe(
        audio, word_timestamps=True, language=args.language, initial_prompt=prompt,
        vad_filter=True, vad_parameters={"min_silence_duration_ms": 300}, beam_size=5,
        condition_on_previous_text=False,
    )
    words = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"w": text, "s": round(w.start, 3), "e": round(w.end, 3), "p": round(w.probability, 3)})
        print(f"  {seg.end:6.1f}s / {info.duration:.1f}s", flush=True)
    if not words:
        sys.exit("No speech found. Is the audio silent, or in a language the model doesn't know?")

    (out / "words.json").write_text(json.dumps(words, indent=1) + "\n")
    lines = [f"[{ph[0]['s']:.2f}] " + " ".join(f"{w['w']}@{w['s']:.2f}" for w in ph) for ph in phrases(words)]
    (out / "transcript.txt").write_text("\n".join(lines) + "\n")
    unsure = [w for w in words if w["p"] < 0.5]
    took = time.time() - started
    print(f"{len(words)} words · {info.language} · {info.duration:.1f}s of audio in {took:.0f}s ({info.duration / max(took, 0.1):.1f}x realtime)")
    if unsure:
        print("low confidence (check spelling): " + ", ".join(f"{w['w']}@{w['s']:.2f}" for w in unsure[:20]))
    print(f"→ {out / 'words.json'} · {out / 'transcript.txt'}")
    print("Next: proofread transcript.txt, then trim the take (take.py trim)")


if __name__ == "__main__":
    main()
