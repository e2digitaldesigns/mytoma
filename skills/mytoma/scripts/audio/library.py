#!/usr/bin/env python3
"""myToma's sound library: real files in skills/mytoma/sounds/, described by sounds/library.json.

  library.py build   [--force]                  bake the built-in recipes into .ogg files (keeps your entries)
  library.py add     <file> --id <entry> --licence own|CC0|CC-BY [--credit "…"] [--tags a,b] [--kind oneshot]
                     [--replace] [--peak -6]    add a recording as a variant of an entry (or a new entry)
  library.py list    [--tag dark]               every entry: kind, variants, licence, tags
  library.py check                              files exist, licences present, sizes
  library.py preview <out.wav> [--tag dark]     every sound in turn with a spoken-length gap, for listening

An entry id is <category>.<name>, e.g. impact.heavy. The engine's cue types (hit, whoosh, type …) map to
entries through library.json's "cues" block; a cue can also name an entry directly: cue(t, "impact.heavy").

Only sounds this project may redistribute belong here: your own recordings, or CC0 / CC-BY with credit.
Royalty-free packs that forbid redistribution (most commercial libraries) stay on your machine instead.
"""

import argparse
import json
import sys
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import dsp  # noqa: E402
from recipes import DEFAULT_CUES, RECIPES  # noqa: E402

SOUNDS = Path(__file__).resolve().parents[2] / "sounds"
MANIFEST = SOUNDS / "library.json"
KINDS = ("oneshot", "repeat", "riser", "tail", "loop")
LICENCES = ("own", "CC0", "CC-BY", "CC-BY-SA")


def load_manifest(path=MANIFEST):
    if path.exists():
        return json.loads(path.read_text())
    return {"version": 1, "sample_rate": dsp.SR, "cues": dict(DEFAULT_CUES), "sounds": {}}


def save_manifest(data, path=MANIFEST):
    data["sounds"] = dict(sorted(data["sounds"].items()))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def entry_dir(entry_id):
    category, _, name = entry_id.partition(".")
    if not category or not name:
        raise SystemExit(f"Entry ids look like category.name (impact.heavy), got: {entry_id}")
    return SOUNDS / category, name


def seed_for(entry_id, variant):
    return zlib.crc32(f"{entry_id}#{variant}".encode())


def render_recipe(entry_id, variant):
    spec = RECIPES[entry_id]
    rng = np.random.default_rng(seed_for(entry_id, variant))
    audio = dsp.stereo(spec["fn"](rng, variant))
    if spec["kind"] != "loop":
        audio = dsp.trim_silence(audio, -70)
        audio = dsp.fade(audio, 0.0005, min(0.02, len(audio) / dsp.SR / 4))
    return dsp.normalize_peak(audio, spec["peak_db"])


# ---------- commands ----------

def cmd_build(args):
    data = load_manifest()
    data.setdefault("cues", {})
    for k, v in DEFAULT_CUES.items():
        data["cues"].setdefault(k, v)
    built = skipped = 0
    for entry_id, spec in RECIPES.items():
        existing = data["sounds"].get(entry_id)
        if existing and existing.get("source") != "recipe" and not args.force:
            print(f"keep   {entry_id:<20} your entry ({existing.get('licence')}) replaces the recipe; --force to rebuild")
            skipped += 1
            continue
        folder, name = entry_dir(entry_id)
        files = []
        for v in range(spec["variants"]):
            out = folder / f"{name}-{v + 1:02d}.ogg"
            dsp.save(out, render_recipe(entry_id, v))
            files.append(str(out.relative_to(SOUNDS)))
        entry = {
            "files": files, "kind": spec["kind"], "peak_db": spec["peak_db"], "tags": spec["tags"],
            "description": spec["description"], "licence": "own", "credit": "myToma built-in (synthesized)",
            "source": "recipe",
        }
        for key in ("interval", "jitter"):
            if key in spec:
                entry[key] = spec[key]
        data["sounds"][entry_id] = entry
        built += 1
        print(f"built  {entry_id:<20} {len(files)} file(s)")
    save_manifest(data)
    total = sum(f.stat().st_size for f in SOUNDS.rglob("*.ogg"))
    print(f"{built} built · {skipped} kept · {total / 1e6:.2f} MB of sounds → {MANIFEST}")


def cmd_add(args):
    src = Path(args.file).expanduser()
    if not src.is_file():
        raise SystemExit(f"Not a file: {src}")
    if args.licence not in LICENCES:
        raise SystemExit(f"--licence must be one of {', '.join(LICENCES)} (sounds here must be redistributable)")
    if args.licence.startswith("CC-BY") and not args.credit:
        raise SystemExit(f"{args.licence} needs --credit \"Author, source URL\"")
    data = load_manifest()
    entry = data["sounds"].get(args.id)
    kind = args.kind or (entry or {}).get("kind") or "oneshot"
    if kind not in KINDS:
        raise SystemExit(f"--kind must be one of {', '.join(KINDS)}")
    peak_db = args.peak if args.peak is not None else (entry or {}).get("peak_db", -6)

    audio = dsp.load(src)
    if kind != "loop":
        audio = dsp.trim_silence(audio, -60)
        audio = dsp.fade(audio, 0.001, min(0.03, len(audio) / dsp.SR / 4))
    if not len(audio):
        raise SystemExit(f"{src} is silent")
    audio = dsp.normalize_peak(audio, peak_db)   # matched to the entry's level, so a swap keeps the mix balanced

    folder, name = entry_dir(args.id)
    if entry and (args.replace or entry.get("source") == "recipe"):
        # A recording replaces the synthesized variants; the recipe files are removed
        for f in entry["files"]:
            (SOUNDS / f).unlink(missing_ok=True)
        entry = None
    files = list((entry or {}).get("files", []))
    n = 1
    while (folder / f"{name}-{n:02d}.ogg").exists() and str((folder / f"{name}-{n:02d}.ogg").relative_to(SOUNDS)) in files:
        n += 1
    out = folder / f"{name}-{n:02d}.ogg"
    dsp.save(out, audio)
    files.append(str(out.relative_to(SOUNDS)))
    credits = list(filter(None, [(entry or {}).get("credit"), args.credit]))
    data["sounds"][args.id] = {
        **(entry or {}),
        "files": files, "kind": kind, "peak_db": peak_db,
        "tags": sorted(set((entry or {}).get("tags", [])) | set(filter(None, (args.tags or "").split(",")))),
        "description": args.description or (entry or {}).get("description", ""),
        "licence": args.licence if not entry else (entry["licence"] if entry["licence"] == args.licence else "mixed"),
        "credit": "; ".join(dict.fromkeys(credits)) or "own recording",
        "source": "file",
    }
    save_manifest(data)
    print(f"added  {out.relative_to(SOUNDS)} → {args.id} ({len(files)} variant(s), {len(audio) / dsp.SR:.2f}s, peak {peak_db} dB)")


def cmd_list(args):
    data = load_manifest()
    for entry_id, e in data["sounds"].items():
        if args.tag and args.tag not in e.get("tags", []):
            continue
        print(f"{entry_id:<20} {e['kind']:<8} {len(e['files'])}x  {e['licence']:<6} {','.join(e.get('tags', []))}")
    print("cues: " + " · ".join(f"{k}→{v}" for k, v in data.get("cues", {}).items()))


def cmd_check(args):
    data = load_manifest()
    problems = []
    for entry_id, e in data["sounds"].items():
        if e.get("licence") not in LICENCES + ("mixed",):
            problems.append(f"{entry_id}: licence {e.get('licence')!r} is not redistributable or missing")
        if e.get("kind") not in KINDS:
            problems.append(f"{entry_id}: unknown kind {e.get('kind')!r}")
        for f in e.get("files", []):
            if not (SOUNDS / f).is_file():
                problems.append(f"{entry_id}: missing file {f}")
    for cue, target in data.get("cues", {}).items():
        if target not in data["sounds"]:
            problems.append(f"cue {cue} → {target}: no such entry")
    listed = {f for e in data["sounds"].values() for f in e.get("files", [])}
    for f in SOUNDS.rglob("*.ogg"):
        if str(f.relative_to(SOUNDS)) not in listed:
            problems.append(f"{f.relative_to(SOUNDS)}: on disk but in no entry")
    total = sum(f.stat().st_size for f in SOUNDS.rglob("*.ogg"))
    for p in problems:
        print("FAIL  " + p)
    print(f"{len(data['sounds'])} entries · {len(listed)} files · {total / 1e6:.2f} MB · " + ("clean" if not problems else f"{len(problems)} problem(s)"))
    sys.exit(1 if problems else 0)


def cmd_preview(args):
    data = load_manifest()
    parts = []
    for entry_id, e in data["sounds"].items():
        if args.tag and args.tag not in e.get("tags", []):
            continue
        for f in e["files"]:
            audio = dsp.load(SOUNDS / f)
            if e["kind"] == "loop":
                audio = np.concatenate([audio, audio])[: int(6 * dsp.SR)]
            parts += [audio, dsp.silence(0.6)]
            print(f"{sum(len(p) for p in parts[:-2]) / dsp.SR:7.2f}s  {entry_id}  {f}")
    dsp.save(args.out, np.concatenate(parts))
    print(f"→ {args.out}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build"); b.add_argument("--force", action="store_true"); b.set_defaults(fn=cmd_build)
    a = sub.add_parser("add")
    a.add_argument("file"); a.add_argument("--id", required=True); a.add_argument("--licence", required=True)
    a.add_argument("--credit"); a.add_argument("--tags"); a.add_argument("--kind"); a.add_argument("--description")
    a.add_argument("--peak", type=float); a.add_argument("--replace", action="store_true"); a.set_defaults(fn=cmd_add)
    ls = sub.add_parser("list"); ls.add_argument("--tag"); ls.set_defaults(fn=cmd_list)
    c = sub.add_parser("check"); c.set_defaults(fn=cmd_check)
    pv = sub.add_parser("preview"); pv.add_argument("out"); pv.add_argument("--tag"); pv.set_defaults(fn=cmd_preview)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
