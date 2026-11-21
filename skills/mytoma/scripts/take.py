#!/usr/bin/env python3
"""Prepare a recorded take for editing.

  take.py trim <source> <work> [--in auto|<s>] [--out auto|<s>] [--pre 0.5] [--post auto]
  take.py face <work> <a-b>[,<c-d>…]      frames of the speaker for face shots, by edit time

trim  needs <work>/words.json from transcribe.py. It cuts the dead air before the first word (keeps
      --pre seconds) and after the last (keeps --post: 1.0 s for a video, 2.5 s for audio), writes a
      lossless <work>/voice.wav, shifts words.json and transcript.txt so the first kept moment is 0,
      and records the cut and a probe of the source in <work>/take.json. After trimming, every time
      you handle is an edit time. Re-running trims from the raw transcript again (words.raw.json).
      Cut points inside the speech make an excerpt: the words outside them are dropped.

face  extracts the speaker's frames for the given edit-time ranges into <work>/face/fNNNNN.jpg, one
      per edit frame (30 fps whatever the phone recorded: variable frame rate is resampled), rotated
      upright and cropped to the composition's frame. faceCam() in the composition plays them.
"""

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

FPS = 30


def run(cmd):
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"{cmd[0]} failed: {res.stderr.strip()}")
    return res.stdout


def probe(src):
    data = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(src)]))
    v = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
    info = {"duration": float(data["format"]["duration"]), "audio": bool(a), "video": bool(v)}
    if v:
        rot = 0
        for sd in v.get("side_data_list", []):
            if "rotation" in sd:
                rot = int(float(sd["rotation"]))
        rot = int(v.get("tags", {}).get("rotate", rot))
        w, h = int(v["width"]), int(v["height"])
        if abs(rot) % 180 == 90:
            w, h = h, w                      # as it plays: a phone's portrait take is stored landscape
        num, den = (int(x) for x in v.get("avg_frame_rate", "0/1").split("/"))
        rnum, rden = (int(x) for x in v.get("r_frame_rate", "0/1").split("/"))
        avg = num / den if den else 0
        nominal = rnum / rden if rden else 0
        transfer = v.get("color_transfer", "")
        info.update({
            "width": w, "height": h, "rotation": rot, "codec": v.get("codec_name"),
            "fps": round(avg, 3), "vfr": abs(avg - nominal) > 0.01,
            "bitrate_mbps": round(int(v.get("bit_rate") or data["format"].get("bit_rate") or 0) / 1e6, 1),
            "hdr": transfer in ("smpte2084", "arib-std-b67"), "color_transfer": transfer,
        })
    return info


def phrases(words, max_gap=0.45, max_words=12):
    out, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if w["w"].endswith((".", "?", "!")) or nxt is None or nxt["s"] - w["e"] > max_gap or len(cur) >= max_words:
            out.append(cur)
            cur = []
    return out


def cmd_trim(args):
    src = Path(args.source).expanduser().resolve()
    work = Path(args.work).resolve()
    if not src.is_file():
        sys.exit(f"Not a file: {src}")
    raw = work / "words.raw.json"
    if not raw.exists():
        if not (work / "words.json").exists():
            sys.exit(f"{work / 'words.json'} missing: run transcribe.py {src} --outdir {work} first")
        raw.write_text((work / "words.json").read_text())
    words = json.loads(raw.read_text())
    info = probe(src)
    if not info["audio"]:
        sys.exit(f"{src} has no audio track")

    post = args.post if args.post is not None else (1.0 if info["video"] else 2.5)
    t_in = max(0.0, words[0]["s"] - args.pre) if args.in_ == "auto" else float(args.in_)
    t_out = min(info["duration"], words[-1]["e"] + post) if args.out == "auto" else min(info["duration"], float(args.out))
    if t_out <= t_in:
        sys.exit(f"--out ({t_out}) must be after --in ({t_in})")
    # snap the cut to whole edit frames, so face frames and audio share one clock
    t_in = math.floor(t_in * FPS) / FPS
    dur = math.floor((t_out - t_in) * FPS) / FPS

    kept = [dict(w, s=round(w["s"] - t_in, 3), e=round(w["e"] - t_in, 3)) for w in words
            if w["s"] >= t_in - 1e-6 and w["e"] <= t_in + dur + 1e-6]
    dropped = len(words) - len(kept)

    run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t_in:.6f}", "-i", str(src), "-t", f"{dur:.6f}", "-vn",
         "-ac", "2", "-ar", "48000", "-c:a", "pcm_s24le", str(work / "voice.wav")])
    (work / "words.json").write_text(json.dumps(kept, indent=1) + "\n")
    lines = [f"[{ph[0]['s']:.2f}] " + " ".join(f"{w['w']}@{w['s']:.2f}" for w in ph) for ph in phrases(kept)]
    (work / "transcript.txt").write_text("\n".join(lines) + "\n")
    take = {"source": str(src), "in": round(t_in, 6), "out": round(t_in + dur, 6), "duration": round(dur, 6),
            "fps": FPS, "probe": info}
    (work / "take.json").write_text(json.dumps(take, indent=1) + "\n")

    print(f"trimmed {t_in:.2f}s → {t_in + dur:.2f}s of {info['duration']:.2f}s · {dur:.2f}s kept · {len(kept)} words"
          + (f" ({dropped} outside the cut dropped)" if dropped else ""))
    if info["video"]:
        print(f"source {info['width']}x{info['height']} (as played; rotation {info['rotation']}°) · "
              f"{info['fps']} fps{' variable' if info['vfr'] else ''} · {info['bitrate_mbps']} Mbps · {info['codec']}")
        if info["hdr"]:
            print("WARNING: HDR recording (" + info["color_transfer"] + "). Face shots will look washed out; "
                  "re-record in SDR (turn off HDR video in the camera settings).")
        if info["vfr"] or abs(info["fps"] - FPS) > 0.05:
            print(f"note: the edit renders at {FPS} fps; the face frames are resampled to it")
    print(f"→ voice.wav · words.json · transcript.txt · take.json\nNext: fixes.json if needed, then captions.py {work}")


def frame_at(t):
    """Edit seconds to a frame index, rounding halves up like Math.round in engine.js.
    Python's round() rounds halves to even, so 41.15 s would give frame 1234 here and 1235 in faceCam()."""
    return math.floor(t * FPS + 0.5)


def parse_ranges(text):
    out = []
    for part in text.split(","):
        a, _, b = part.partition("-")
        try:
            a, b = float(a), float(b)
        except ValueError:
            sys.exit(f"Ranges look like 0-2.4,17.6-19.9 (edit seconds), got: {part}")
        if b <= a:
            sys.exit(f"Range end must be after its start: {part}")
        out.append((a, b))
    return out


def comp_size(work):
    html = (work / "index.html").read_text() if (work / "index.html").exists() else ""
    import re
    m = re.search(r"window\.COMP\s*=\s*(\{.*?\});", html, re.S)
    if not m:
        sys.exit(f"{work / 'index.html'} missing: run `node cli.js new {work}` first (the face frames match its size)")
    comp = json.loads(m.group(1))
    return comp["width"], comp["height"]


def cmd_face(args):
    work = Path(args.work).resolve()
    take = json.loads((work / "take.json").read_text()) if (work / "take.json").exists() else None
    if not take:
        sys.exit(f"{work / 'take.json'} missing: run `take.py trim` first")
    if not take["probe"].get("video"):
        sys.exit("The take is audio only: there is no face to extract")
    W, H = comp_size(work)
    face = work / "face"
    face.mkdir(exist_ok=True)
    total = 0
    for a, b in parse_ranges(args.ranges):
        f0, f1 = frame_at(a), frame_at(b)
        if f1 / FPS > take["duration"] + 1e-6:
            sys.exit(f"Range {a}-{b} ends after the trimmed take ({take['duration']:.2f}s)")
        start = take["in"] + f0 / FPS
        # autorotate is on by default; fps resamples variable frame rate onto the edit's frames;
        # scale+crop fill the composition's frame (cover)
        vf = f"fps={FPS},scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,crop={W}:{H}"
        run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.6f}", "-i", take["source"], "-an", "-vf", vf,
             "-frames:v", str(f1 - f0), "-q:v", "2", "-start_number", str(f0), str(face / "f%05d.jpg")])
        got = len([p for p in face.glob("f*.jpg") if f0 <= int(p.stem[1:]) < f1])
        if got != f1 - f0:
            sys.exit(f"Range {a}-{b}: extracted {got} frames, expected {f1 - f0}")
        total += got
        print(f"face {a:.2f}-{b:.2f}s → frames {f0}-{f1 - 1}")
    size = sum(p.stat().st_size for p in face.glob("*.jpg"))
    print(f"{total} frames · {size / 1e6:.1f} MB in face/\nNext: faceCam(\"#img\", a, b) in the timeline, with the same ranges")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("trim")
    t.add_argument("source"); t.add_argument("work")
    t.add_argument("--in", dest="in_", default="auto"); t.add_argument("--out", default="auto")
    t.add_argument("--pre", type=float, default=0.5); t.add_argument("--post", type=float)
    t.set_defaults(fn=cmd_trim)
    f = sub.add_parser("face")
    f.add_argument("work"); f.add_argument("ranges")
    f.set_defaults(fn=cmd_face)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
