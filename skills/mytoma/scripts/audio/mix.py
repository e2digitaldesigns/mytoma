#!/usr/bin/env python3
"""Turn a composition's sound cues into its soundtrack.

  mix.py <work> --duration <s> [--music synth|none|<file>|<library entry>] [--voice <file>]
         [--drop <t>] [--drums-from <t>] [--sfx 0.5] [--music-level 0.22] [--map hit=impact.heavy,…]

Reads <work>/cues.json (written by `cli.js cues`), places a library sound for every cue, builds a music
bed, ducks it under the voice, and writes to <work>/audio/:
  sfx.wav     every cue, placed
  music.wav   the bed, after ducking
  mix.wav     voice + music + sfx, normalised to -14 LUFS / -2 dBTP (what `cli.js render` muxes; the
              headroom absorbs lossy-codec overshoot, and render checks the encoded peak again)
  mix.json    what was placed, what was skipped, the options used (render re-runs the mix with them
              when the cues change) and the measured loudness

Deterministic: variants rotate in a fixed order and every random choice comes from a seed derived from
the work folder's name, so the same cues always give the same file.
"""

import argparse
import hashlib
import json
import sys
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import dsp  # noqa: E402
from library import MANIFEST, load_manifest  # noqa: E402

SR = dsp.SR


class Library:
    def __init__(self, manifest=MANIFEST, overrides=None):
        self.data = load_manifest(Path(manifest))
        self.root = Path(manifest).parent
        self.cues = dict(self.data.get("cues", {}))
        self.cues.update(overrides or {})
        self._cache = {}
        self._occurrence = {}

    def resolve(self, cue_type):
        """A cue names an entry directly (impact.heavy) or a cue type mapped to one (hit)."""
        if cue_type in self.data["sounds"]:
            return cue_type
        return self.cues.get(cue_type)

    def entry(self, entry_id):
        return self.data["sounds"][entry_id]

    def audio(self, rel):
        if rel not in self._cache:
            self._cache[rel] = dsp.load(self.root / rel)
        return self._cache[rel]

    def next_variant(self, entry_id):
        """Rotate through an entry's files in a fixed order, starting at a per-entry offset."""
        files = self.entry(entry_id)["files"]
        k = self._occurrence.get(entry_id, 0)
        self._occurrence[entry_id] = k + 1
        return files[(k + zlib.crc32(entry_id.encode())) % len(files)]


# ---------- sound effects ----------

def build_sfx(cues, duration, lib, rng):
    buf = np.zeros((int(round(duration * SR)) + SR, 2), np.float32)
    placed, skipped = [], []
    for cue in cues:
        entry_id = lib.resolve(cue["type"])
        if not entry_id:
            skipped.append(f"{cue['t']:.2f}s {cue['type']}: no library entry (add one, or map it in library.json cues)")
            continue
        e = lib.entry(entry_id)
        t = float(cue["t"])
        gain = float(cue.get("gain", 1.0))
        if cue["type"] == "hit" or e["kind"] == "oneshot":
            gain *= float(cue.get("power", 1.0)) ** 0.7 if "power" in cue else 1.0
        dur = cue.get("dur")
        kind = e["kind"]

        if kind == "oneshot":
            dsp.place(buf, lib.audio(lib.next_variant(entry_id)), t, gain)
        elif kind == "repeat":
            interval, jitter = e.get("interval", 0.07), e.get("jitter", 0.0)
            end = t + (dur if dur else interval)
            pos, strokes = t, 0
            while pos < end - 1e-6:
                stroke = lib.audio(lib.next_variant(entry_id))
                dsp.place(buf, stroke, pos, gain * (0.7 + 0.3 * rng.random()))
                pos += interval + jitter * rng.random()
                strokes += 1
        elif kind == "riser":
            sound = lib.audio(lib.next_variant(entry_id))
            want = int(round((dur if dur else len(sound) / SR) * SR))
            if want < len(sound):                      # trim from the front: it still lands on the reveal
                sound = dsp.fade(sound[-want:], 0.03, 0)
            dsp.place(buf, sound, t + want / SR - len(sound) / SR, gain)
        elif kind == "tail":
            sound = lib.audio(lib.next_variant(entry_id))
            if dur and dur * SR < len(sound):
                sound = dsp.fade(sound[: int(dur * SR)], 0, min(0.08, dur / 3))
            dsp.place(buf, sound, t, gain)
        elif kind == "loop":
            if not dur:
                skipped.append(f"{t:.2f}s {cue['type']}: a loop needs a duration (cue(t, type, {{dur}}))")
                continue
            loop = lib.audio(lib.next_variant(entry_id))
            reps = int(np.ceil(dur * SR / len(loop)))
            bed = np.concatenate([loop] * reps)[: int(dur * SR)]
            dsp.place(buf, dsp.fade(bed, min(0.3, dur / 4), min(0.5, dur / 4)), t, gain)
        placed.append({"t": t, "cue": cue["type"], "entry": entry_id})
    return buf[: int(round(duration * SR))], placed, skipped


# ---------- music ----------

NOTE = {"A": 57, "B": 59, "C": 60, "D": 62, "E": 64, "F": 65, "G": 67}
PROGRESSIONS = [  # minor-key loops, as (root note, minor?) per bar
    [("A", True), ("F", False), ("C", False), ("G", False)],
    [("A", True), ("A", True), ("F", False), ("E", False)],
    [("D", True), ("F", False), ("C", False), ("A", True)],
]


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def saw(f, n, phase=0.0):
    return (2 * ((phase + f * np.arange(n) / SR) % 1) - 1).astype(np.float32)


def synth_music(duration, rng, drums_from=0.0):
    """A dark, steady bed: pad chords, a sub bass, soft kick/hat/clap. Tempo and progression vary by seed."""
    bpm = float(rng.choice([88, 92, 96, 100, 104]))
    prog = PROGRESSIONS[int(rng.integers(len(PROGRESSIONS)))]
    beat = 60 / bpm
    bar = beat * 4
    n = int(round(duration * SR)) + SR
    pad = np.zeros(n, np.float32)
    bass = np.zeros(n, np.float32)
    drums = np.zeros((n, 2), np.float32)

    t, i = 0.0, 0
    while t < duration + bar:
        root, minor = prog[i % len(prog)]
        midi = NOTE[root] - 12
        chord = [midi, midi + (3 if minor else 4), midi + 7, midi + 12]
        a, m = int(t * SR), int(bar * SR)
        if a >= n:
            break
        m = min(m, n - a)
        env = dsp.adsr(m, 0.35, 0.4, 0.75, 0.6)
        voice = np.zeros(m, np.float32)
        for note in chord:
            for detune in (0.996, 1.004):
                voice += saw(hz(note) * detune, m, phase=rng.random())
        pad[a:a + m] += voice * env * 0.08
        bass_env = dsp.adsr(m, 0.02, 0.3, 0.6, 0.3)
        bass[a:a + m] += (np.sin(2 * np.pi * hz(midi - 12) * np.arange(m) / SR) * 0.9 + saw(hz(midi - 12), m) * 0.15) * bass_env * 0.35
        t += bar
        i += 1
    pad = dsp.lowpass(pad, 1400, order=2)
    bass = dsp.lowpass(bass, 300)

    kick = (np.sin(2 * np.pi * np.cumsum(50 + 110 * np.exp(-np.arange(int(0.35 * SR)) / SR * 30)) / SR) *
            dsp.exp_decay(int(0.35 * SR), 9)).astype(np.float32) * 0.7
    hat_src = rng.standard_normal(int(0.06 * SR)).astype(np.float32)
    hat = dsp.highpass(hat_src, 7000) * dsp.exp_decay(len(hat_src), 70) * 0.12
    clap_src = rng.standard_normal(int(0.2 * SR)).astype(np.float32)
    clap = dsp.bandpass(clap_src, 900, 3500) * dsp.exp_decay(len(clap_src), 22) * 0.18
    k = 0
    while True:
        bt = drums_from + k * beat / 2                  # eighth notes
        if bt >= duration:
            break
        if k % 4 == 0:
            dsp.place(drums, kick, bt)
        if k % 4 == 2:
            dsp.place(drums, clap, bt, 0.9)
        dsp.place(drums, dsp.pan(hat, 0.3 if k % 2 else -0.3), bt, 0.6 + 0.4 * (k % 2))
        k += 1
    music = dsp.stereo(pad) * 1.0 + dsp.stereo(bass) + drums
    # gentle stereo width on the pad
    music[:, 0] += pad * 0.05
    music[:, 1] -= pad * 0.05
    return music[: int(round(duration * SR))], {"bpm": bpm, "progression": [r + ("m" if mi else "") for r, mi in prog]}


def file_music(path_or_audio, duration):
    """Loop a track to the duration with 2 s crossfades between repeats."""
    track = path_or_audio if isinstance(path_or_audio, np.ndarray) else dsp.load(path_or_audio)
    n = int(round(duration * SR))
    if len(track) >= n:
        return track[:n]
    xf = min(int(2 * SR), len(track) // 4)
    out = track.copy()
    while len(out) < n:
        ramp = np.linspace(0, 1, xf)[:, None]
        out[-xf:] = out[-xf:] * (1 - ramp) + track[:xf] * ramp
        out = np.concatenate([out, track[xf:]])
    return out[:n]


def music_envelope(duration, drop=None, fade_in=1.0, fade_out=1.5):
    n = int(round(duration * SR))
    t = np.arange(n) / SR
    env = np.ones(n, np.float32)
    env *= np.clip(t / fade_in, 0, 1) if fade_in else 1
    env *= np.clip((duration - t) / fade_out, 0, 1) if fade_out else 1
    if drop is not None:
        # a breath before the final hit: out over 0.25 s, silent for the last 0.5 s before `drop`, back on it
        a, b = drop - 0.75, drop - 0.5
        env *= np.where(t < a, 1, np.where(t < b, 1 - (t - a) / (b - a), np.where(t < drop, 0, 1))).astype(np.float32)
    return env


def duck(music, voice, depth=0.7):
    """Lower the music while the voice speaks; it swells back in the pauses."""
    env = dsp.follow(voice, attack=0.04, release=0.35)
    ref = np.percentile(env[env > 1e-4], 90) if np.any(env > 1e-4) else 1.0
    gain = 1 - depth * np.clip(env / ref, 0, 1)
    return music * gain[: len(music), None]


# ---------- main ----------

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("work")
    p.add_argument("--duration", type=float, required=True)
    p.add_argument("--music", default="synth", help="synth · none · a file · a library loop entry (bed.drone)")
    p.add_argument("--voice")
    p.add_argument("--drop", type=float)
    p.add_argument("--drums-from", type=float, default=0.0)
    p.add_argument("--sfx", type=float, default=0.5, help="sound-effects level (0-2)")
    p.add_argument("--music-level", type=float, default=0.22)
    p.add_argument("--map", default="", help="cue remaps for this video: hit=impact.heavy,type=foley.typewriter")
    p.add_argument("--library", default=str(MANIFEST))
    p.add_argument("--target", type=float, default=-14.0, help="loudness target in LUFS")
    p.add_argument("--true-peak", type=float, default=-2.0,
                   help="true-peak ceiling in dBTP; -2 leaves room for AAC/Opus overshoot after encoding")
    args = p.parse_args()

    work = Path(args.work).resolve()
    cues_file = work / "cues.json"
    if not cues_file.exists():
        sys.exit(f"{cues_file} missing: run `node cli.js cues {args.work}` first")
    cues_bytes = cues_file.read_bytes()
    cues = sorted(json.loads(cues_bytes), key=lambda c: c["t"])
    overrides = dict(kv.split("=", 1) for kv in args.map.split(",") if "=" in kv)
    lib = Library(args.library, overrides)
    bad = [f"{k}={v}" for k, v in overrides.items() if v not in lib.data["sounds"]]
    if bad:
        sys.exit("--map names unknown entries: " + ", ".join(bad))

    seed = zlib.crc32(work.name.encode())
    out = work / "audio"
    out.mkdir(exist_ok=True)
    D = args.duration
    n = int(round(D * SR))

    sfx, placed, skipped = build_sfx(cues, D, lib, np.random.default_rng(seed + 1))
    sfx *= args.sfx

    music_info = {"source": args.music}
    if args.music == "none":
        music = np.zeros((n, 2), np.float32)
    elif args.music == "synth":
        music, info = synth_music(D, np.random.default_rng(seed + 2), args.drums_from)
        music_info.update(info)
    elif args.music in lib.data["sounds"]:
        e = lib.entry(args.music)
        music = file_music(np.concatenate([lib.audio(f) for f in e["files"]]), D)
    elif Path(args.music).expanduser().is_file():
        music = file_music(Path(args.music).expanduser(), D)
    else:
        sys.exit(f"--music: not synth/none, a library entry or a file: {args.music}")
    if dsp.peak(music) > 0:
        music = dsp.normalize_peak(music, -3) * music_envelope(D, args.drop)[:, None] * args.music_level

    voice = np.zeros((n, 2), np.float32)
    if args.voice:
        v = dsp.load(Path(args.voice).expanduser())
        voice[: min(n, len(v))] = v[:n]
        music = duck(music, voice)

    pad = lambda x: np.pad(x, ((0, max(0, n - len(x))), (0, 0)))[:n]  # noqa: E731
    sfx, music = pad(sfx), pad(music)
    mix = voice + music + sfx
    if dsp.peak(mix) == 0:
        sys.exit("Nothing to mix: no cues placed, no music, no voice")

    dsp.save(out / "sfx.wav", sfx)
    dsp.save(out / "music.wav", music)
    # headroom before loudnorm so nothing clips on the way in
    premix = out / "premix.wav"
    dsp.save(premix, mix / max(1.0, dsp.peak(mix) / dsp.gain_db(-1)))
    dsp.loudnorm(premix, out / "mix.wav", target=args.target, true_peak=args.true_peak)
    premix.unlink()
    lufs, tp, _ = dsp.loudness(out / "mix.wav")

    report = {
        "cues_sha": hashlib.sha256(cues_bytes).hexdigest()[:16],
        "options": {k: v for k, v in vars(args).items() if k not in ("work",)},
        "duration": D, "placed": placed, "skipped": skipped, "music": music_info,
        "loudness": {"lufs": round(lufs, 1), "true_peak": round(tp, 1)},
    }
    (out / "mix.json").write_text(json.dumps(report, indent=1) + "\n")

    counts = {}
    for pl in placed:
        counts[pl["entry"]] = counts.get(pl["entry"], 0) + 1
    print(f"{len(placed)} cues placed · " + " · ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    for s in skipped:
        print("skip  " + s)
    extra = f" · {music_info['bpm']:.0f} bpm {'-'.join(music_info['progression'])}" if "bpm" in music_info else ""
    print(f"music {args.music}{extra} · voice {'yes, music ducked' if args.voice else 'none'}")
    print(f"{out / 'mix.wav'} · {D:.2f}s · {lufs:.1f} LUFS · {tp:.1f} dBTP")
    print("You cannot hear this from here: ask the user to listen before posting.")


if __name__ == "__main__":
    main()
