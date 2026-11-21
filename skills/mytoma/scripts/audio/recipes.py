"""Sound designs for myToma's built-in library.

Each recipe is a function (rng, variant) -> float32 stereo at 48 kHz. `build_library.py` renders every
variant once to an .ogg in skills/mytoma/sounds/ and records it in library.json, so the library is real
files, owned by this project, that a recorded sound can replace one entry at a time.

RECIPES maps an entry id to its design and metadata:
  kind  oneshot  placed at the cue time
        repeat   one file per stroke, repeated across the cue's dur (typing, ticking)
        riser    ends at cue t + dur (trimmed from the front to fit)
        tail     starts at the cue and is cut to dur with a fade (falls, drops)
        loop     seamless loop, tiled across the cue's dur (textures, beds)
"""

import numpy as np
from scipy import signal

from dsp import (SR, adsr, bandpass, exp_decay, fade, highpass, lowpass, pan, stereo, sweep_lowpass, t_axis)


# ---------- helpers ----------

def noise(rng, seconds):
    return rng.standard_normal(int(round(seconds * SR))).astype(np.float32)


def sine_sweep(f0, f1, seconds, curve=30.0):
    """Sine whose frequency falls (or rises) exponentially from f0 to f1."""
    t = t_axis(seconds)
    f = f1 + (f0 - f1) * np.exp(-t * curve)
    return np.sin(2 * np.pi * np.cumsum(f) / SR).astype(np.float32)


def reverb(x, rng, seconds=1.2, mix=0.25, damp=4000):
    """Cheap stereo room: x convolved with decorrelated, damped noise tails."""
    x = stereo(x)
    n = int(seconds * SR)
    env = np.exp(-np.arange(n) / SR * (6.9 / seconds))
    irs = [lowpass(rng.standard_normal(n).astype(np.float32), damp) * env for _ in range(2)]
    wet = np.stack([signal.fftconvolve(x[:, i], irs[i])[: len(x) + n] for i in range(2)], axis=1)
    wet /= max(np.max(np.abs(wet)), 1e-9)
    dry = np.pad(x, ((0, len(wet) - len(x)), (0, 0)))
    return (dry * (1 - mix) + wet * mix * np.max(np.abs(x))).astype(np.float32)


def seamless(x, crossfade=0.25):
    """Make a loop: blend the tail into the head so the end runs straight back into the start."""
    x = stereo(x)
    xf = int(crossfade * SR)
    body = x[:-xf].copy()
    ramp = np.linspace(0, 1, xf)[:, None]
    body[:xf] = body[:xf] * ramp + x[-xf:] * (1 - ramp)
    return body


def widen(x, rng, amount=0.3):
    """Mono → stereo with a slightly different filtered copy per side."""
    x = stereo(x)
    d = int(rng.uniform(0.0004, 0.0009) * SR)
    left = x[:, 0]
    right = np.concatenate([np.zeros(d, np.float32), x[:-d, 1]]) if d else x[:, 1]
    return np.stack([left, left * (1 - amount) + right * amount], axis=1).astype(np.float32)


# ---------- impacts ----------

def impact_punch(rng, v):
    dur = 0.9
    body = sine_sweep(rng.uniform(110, 140), rng.uniform(40, 50), dur, curve=rng.uniform(24, 32)) * exp_decay(int(dur * SR), 5.5)
    click = highpass(noise(rng, dur), 1800) * exp_decay(int(dur * SR), 70) * 0.5
    boom = lowpass(noise(rng, dur), 180) * exp_decay(int(dur * SR), 3.2) * 2.2
    # 150-600 Hz knock: what a phone speaker actually plays of a punch
    knock = bandpass(noise(rng, dur), 150, 600) * exp_decay(int(dur * SR), 18) * 1.6
    x = np.tanh((body + click + boom + knock) * 2.4)
    return reverb(widen(x, rng), rng, 0.6, 0.12)


def impact_heavy(rng, v):
    """Cinematic boom: sub drop, distorted thud, long rumbling tail. For reveals and dark turns."""
    dur = 3.2
    n = int(dur * SR)
    sub = sine_sweep(rng.uniform(70, 85), rng.uniform(28, 34), dur, curve=6) * exp_decay(n, 1.4)
    thud = np.tanh(sine_sweep(160, 50, dur, curve=40) * 3) * exp_decay(n, 9) * 0.8
    rumble = lowpass(noise(rng, dur), 120, order=4) * exp_decay(n, 1.6) * 3.5
    crack = bandpass(noise(rng, dur), 900, 5000) * exp_decay(n, 45) * 0.35
    # mid-range body (harmonics of a driven low tone + a 200-800 Hz layer) so the boom survives phone speakers
    body = np.tanh(sine_sweep(rng.uniform(210, 240), 70, dur, curve=10) * 4) * exp_decay(n, 5) * 1.8
    mid = bandpass(noise(rng, dur), 200, 800) * exp_decay(n, 7) * 2.6
    x = sub + thud + rumble + crack + body + mid
    return reverb(widen(x, rng, 0.4), rng, 2.4, 0.3, damp=2200)


def impact_stamp(rng, v):
    dur = 0.45
    n = int(dur * SR)
    thump = lowpass(noise(rng, dur), 500) * exp_decay(n, 22) * 2.5
    knock = bandpass(noise(rng, dur), rng.uniform(280, 360), rng.uniform(800, 1000)) * exp_decay(n, 35) * 1.4
    slap = highpass(noise(rng, dur), 2500) * exp_decay(n, 90) * 0.25
    return reverb(widen(thump + knock + slap, rng), rng, 0.35, 0.1)


def impact_soft(rng, v):
    dur = 0.6
    n = int(dur * SR)
    body = np.tanh(sine_sweep(rng.uniform(150, 180), 60, dur, curve=18) * 2.5) * exp_decay(n, 9)
    air = bandpass(noise(rng, dur), 150, 900) * exp_decay(n, 14) * 1.2
    return widen(body + air, rng)


# ---------- whooshes ----------

def whoosh(rng, v, dur, f_lo, f_hi):
    n = int(dur * SR)
    t = np.linspace(0, 1, n)
    env = np.sin(np.pi * t) ** 2 * (1 + 0.6 * t)                      # swells, peaks late
    src = noise(rng, dur)
    # band centre rises then falls, so it reads as something passing
    centre = f_lo * (f_hi / f_lo) ** np.sin(np.pi * t) ** 1.5
    blocks = np.linspace(0, n, 41).astype(int)
    out = np.zeros(n, np.float32)
    for i in range(40):
        c = centre[(blocks[i] + blocks[i + 1]) // 2]
        seg = bandpass(src[max(0, blocks[i] - 512):blocks[i + 1]], c * 0.55, c * 1.8)
        out[blocks[i]:blocks[i + 1]] = seg[-(blocks[i + 1] - blocks[i]):]
    out *= env.astype(np.float32)
    pos = np.linspace(-0.7, 0.7, n) * (1 if v % 2 == 0 else -1)          # travels across the stereo field
    left, right = np.cos((pos + 1) * np.pi / 4), np.sin((pos + 1) * np.pi / 4)
    return np.stack([out * left, out * right], axis=1).astype(np.float32)


def whoosh_fast(rng, v):
    return whoosh(rng, v, rng.uniform(0.36, 0.5), rng.uniform(500, 800), rng.uniform(3500, 5500))


def whoosh_slow(rng, v):
    return reverb(whoosh(rng, v, rng.uniform(0.9, 1.2), 250, rng.uniform(1800, 2600)), rng, 0.8, 0.2)


# ---------- risers and drops ----------

def riser(rng, v, dur):
    n = int(dur * SR)
    k = np.linspace(0, 1, n)
    hiss = highpass(noise(rng, dur), 1500) * 0.25
    hiss = sweep_lowpass(hiss, 2000, 14000)
    tone = np.zeros(n, np.float32)
    for detune in (1.0, 1.007, 0.994):                                   # thick, rising, slightly detuned
        f = (110 + 770 * k ** 2) * detune
        tone += np.sin(2 * np.pi * np.cumsum(f) / SR).astype(np.float32)
    trem = 0.75 + 0.25 * np.sin(2 * np.pi * np.cumsum(2 + 14 * k ** 2) / SR)  # tremolo speeds up
    x = (hiss + tone * 0.12 * trem) * (k ** 2.2)
    x[-int(0.012 * SR):] *= np.linspace(1, 0, int(0.012 * SR))           # hard stop at the reveal
    return widen(x, rng, 0.5)


def riser_tension(rng, v):
    return riser(rng, v, 4.0)


def riser_short(rng, v):
    return riser(rng, v, 1.5)


def down_drop(rng, v):
    dur = 1.0
    n = int(dur * SR)
    k = np.linspace(0, 1, n)
    tone = np.sin(2 * np.pi * np.cumsum(60 + 640 * (1 - k) ** 2) / SR) * (1 - k) ** 1.5 * 0.5
    air = sweep_lowpass(noise(rng, dur), 6000, 200) * (1 - k) * 0.15
    return widen(fade(tone + air, 0.01, 0.1), rng)


# ---------- interface ----------

def ui_pop(rng, v):
    dur = 0.14
    base = [520, 640, 760][v % 3]
    x = sine_sweep(base * 2.4, base, dur, curve=45) * exp_decay(int(dur * SR), 30) * 0.8
    return widen(fade(x, 0.002, 0.02), rng, 0.2)


def ui_tick(rng, v):
    dur = 0.05
    f = [2400, 3000][v % 2]
    x = np.sin(2 * np.pi * f * t_axis(dur)) * exp_decay(int(dur * SR), 110)
    x += highpass(noise(rng, dur), 4000) * exp_decay(int(dur * SR), 300) * 0.3
    return stereo(fade(x.astype(np.float32), 0.0005, 0.005))


def ui_ding(rng, v):
    dur = 1.4
    t = t_axis(dur)
    x = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t * d) for f, a, d in
            ((1318.5, 1.0, 4.0), (1975.5, 0.5, 5.5), (2637, 0.25, 8), (3951, 0.12, 12)))
    return reverb(widen(fade(x.astype(np.float32), 0.002, 0.2), rng), rng, 1.0, 0.18)


def ui_error(rng, v):
    dur = 0.32
    t = t_axis(dur)
    sq = np.sign(np.sin(2 * np.pi * 180 * t)) * 0.5 + np.sign(np.sin(2 * np.pi * 186 * t)) * 0.5
    gate = ((t < 0.11) | ((t > 0.16) & (t < 0.28))).astype(np.float32)
    return stereo(lowpass(fade((sq * gate).astype(np.float32), 0.002, 0.03), 3500))


def ui_click(rng, v):
    dur = 0.04
    x = bandpass(noise(rng, dur), [2500, 4200][v % 2], 9000) * exp_decay(int(dur * SR), 220)
    return stereo(x)


# ---------- foley ----------

def foley_key(rng, v):
    """Keyboard key: plastic click plus a soft low thock."""
    dur = 0.09
    n = int(dur * SR)
    click = bandpass(noise(rng, dur), rng.uniform(1800, 2600), 7000) * exp_decay(n, 160)
    thock = sine_sweep(rng.uniform(260, 340), 150, dur, curve=60) * exp_decay(n, 70) * 0.45
    return pan(click + thock, rng.uniform(-0.25, 0.25))


def foley_typewriter(rng, v):
    """Typewriter strike: metal slap, a short ring, the platen clack."""
    dur = 0.16
    n = int(dur * SR)
    slap = bandpass(noise(rng, dur), 2200, 9000) * exp_decay(n, 120) * 1.2
    ring = np.sin(2 * np.pi * rng.uniform(1150, 1350) * t_axis(dur)) * exp_decay(n, 55) * 0.18
    clack = bandpass(noise(rng, dur), 350, 1400) * exp_decay(n, 80) * 0.9
    return pan(slap + ring + clack, rng.uniform(-0.2, 0.2))


def foley_shutter(rng, v):
    """Camera shutter: two mechanical clicks with a short whir between. For an archival photo landing."""
    dur = 0.3
    n = int(dur * SR)
    out = np.zeros(n, np.float32)
    for at, level in ((0.0, 1.0), (0.085, 0.75)):
        c = bandpass(noise(rng, 0.05), 1500, 8000) * exp_decay(int(0.05 * SR), 150) * level
        i = int(at * SR)
        out[i:i + len(c)] += c[: n - i]
    whir = bandpass(noise(rng, dur), 3000, 6000) * adsr(n, 0.005, 0.05, 0.2, 0.1) * 0.08
    return reverb(widen(out + whir, rng), rng, 0.3, 0.08)


def foley_paper(rng, v):
    """Paper sliding across a desk."""
    dur = rng.uniform(0.55, 0.75)
    n = int(dur * SR)
    grain = bandpass(noise(rng, dur), 900, 6000)
    flutter = lowpass(np.abs(noise(rng, dur)), 25) * 3                    # slow, uneven friction
    env = adsr(n, 0.06, 0.1, 0.8, 0.25)
    return widen(grain * flutter * env * 0.6, rng, 0.4)


# ---------- textures and beds (loops) ----------

def texture_projector(rng, v):
    """Film projector: motor hum, the 24 fps sprocket clatter, a little hiss. Loops seamlessly."""
    dur = 4.25
    t = t_axis(dur)
    hum = (np.sin(2 * np.pi * 50 * t) * 0.5 + np.sin(2 * np.pi * 100 * t) * 0.3 + np.sin(2 * np.pi * 150 * t) * 0.1)
    clatter_env = (0.5 + 0.5 * np.sin(2 * np.pi * 24 * t)) ** 8
    clatter = bandpass(noise(rng, dur), 800, 4000) * clatter_env * 0.9
    hiss = highpass(noise(rng, dur), 3000) * 0.06
    x = (hum * 0.25 + clatter + hiss).astype(np.float32)
    return seamless(widen(x, rng, 0.35))


def texture_crackle(rng, v):
    """Old record or worn film: sparse pops over soft hiss. Loops seamlessly."""
    dur = 4.25
    n = int(dur * SR)
    x = lowpass(highpass(noise(rng, dur), 800), 6000) * 0.04
    pops = np.zeros(n, np.float32)
    for i in rng.integers(0, n - 400, size=int(dur * 14)):
        pops[i:i + 300] += rng.standard_normal(300).astype(np.float32) * np.exp(-np.arange(300) / 30) * rng.uniform(0.2, 1.0)
    return seamless(widen(x + bandpass(pops, 1000, 9000), rng, 0.6))


def bed_drone(rng, v):
    """Dark drone: detuned low saws on A and E, a slowly breathing filter. Loops seamlessly."""
    dur = 8.25
    t = t_axis(dur)
    x = np.zeros(len(t), np.float32)
    for f, level in ((55.0, 1.0), (55.3, 0.8), (82.4, 0.55), (110.1, 0.3)):
        x += (2 * ((f * t) % 1) - 1).astype(np.float32) * level
    lfo = 0.5 + 0.5 * np.sin(2 * np.pi * t / dur * 2)                  # two breaths per loop, so it tiles
    filtered = lowpass(x, 520) * (0.7 + 0.3 * lfo).astype(np.float32)   # harmonics up to ~500 Hz carry it on phones
    air = bandpass(noise(rng, dur), 400, 1600) * 0.02
    return seamless(widen(filtered * 0.3 + air, rng, 0.5), crossfade=0.25)


def bed_heartbeat(rng, v):
    """Heartbeat at 60 bpm: lub-dub. One beat per loop."""
    dur = 1.0
    n = int(dur * SR)
    out = np.zeros(n, np.float32)
    for at, f, level in ((0.0, 62, 1.0), (0.22, 55, 0.7)):
        n_b = int(0.25 * SR)
        beat = np.tanh(sine_sweep(f * 1.8, f, 0.25, curve=20) * 2.2) * exp_decay(n_b, 16) * level
        beat += bandpass(noise(rng, 0.25), 120, 380) * exp_decay(n_b, 30) * level * 3.0   # the audible "lub"
        out[int(at * SR):int(at * SR) + n_b] += beat
    return stereo(lowpass(out, 420))


RECIPES = {
    "impact.punch":    dict(fn=impact_punch, variants=3, kind="oneshot", peak_db=-3, tags=["hit", "punchy", "slam", "energy"], description="Punchy hit with a short boom: slams, strikes, emphasis"),
    "impact.heavy":    dict(fn=impact_heavy, variants=2, kind="oneshot", peak_db=-2, tags=["hit", "cinematic", "dark", "reveal", "dramatic"], description="Cinematic sub boom with a long tail: reveals, dark turns, endings"),
    "impact.stamp":    dict(fn=impact_stamp, variants=2, kind="oneshot", peak_db=-4, tags=["stamp", "thud", "verdict"], description="Rubber-stamp thud"),
    "impact.soft":     dict(fn=impact_soft, variants=2, kind="oneshot", peak_db=-6, tags=["hit", "soft", "subtle"], description="Soft thud for quiet emphasis"),
    "whoosh.fast":     dict(fn=whoosh_fast, variants=3, kind="oneshot", peak_db=-6, tags=["transition", "whip", "fast"], description="Quick pass-by: whips, slides, zooms"),
    "whoosh.slow":     dict(fn=whoosh_slow, variants=2, kind="oneshot", peak_db=-7, tags=["transition", "airy", "slow"], description="Slow airy sweep: fades, reveals"),
    "riser.tension":   dict(fn=riser_tension, variants=1, kind="riser", peak_db=-6, tags=["build", "tension", "suspense"], description="4 s tension build that stops dead on the reveal"),
    "riser.short":     dict(fn=riser_short, variants=1, kind="riser", peak_db=-6, tags=["build", "short"], description="1.5 s build"),
    "down.drop":       dict(fn=down_drop, variants=1, kind="tail", peak_db=-7, tags=["fall", "deflate", "fail"], description="Falling tone: a let-down, a failure"),
    "ui.pop":          dict(fn=ui_pop, variants=3, kind="oneshot", peak_db=-9, tags=["ui", "appear", "light"], description="Light pop as an item appears"),
    "ui.tick":         dict(fn=ui_tick, variants=2, kind="repeat", peak_db=-14, tags=["ui", "count", "clock"], description="Tick for counters and clocks", interval=0.07),
    "ui.ding":         dict(fn=ui_ding, variants=1, kind="oneshot", peak_db=-10, tags=["ui", "success", "correct"], description="Bell: success, a correct answer"),
    "ui.error":        dict(fn=ui_error, variants=1, kind="oneshot", peak_db=-12, tags=["ui", "wrong", "fail"], description="Buzzer: wrong, failure"),
    "ui.click":        dict(fn=ui_click, variants=2, kind="oneshot", peak_db=-12, tags=["ui", "click", "select"], description="Small click: a selection, a toggle"),
    "foley.key":       dict(fn=foley_key, variants=3, kind="repeat", peak_db=-12, tags=["typing", "keyboard", "modern", "code"], description="Keyboard keystroke, repeated for typing", interval=0.06, jitter=0.035),
    "foley.typewriter":dict(fn=foley_typewriter, variants=3, kind="repeat", peak_db=-10, tags=["typing", "typewriter", "history", "dates", "names"], description="Typewriter strike, repeated: dates, names, archival text", interval=0.1, jitter=0.05),
    "foley.shutter":   dict(fn=foley_shutter, variants=1, kind="oneshot", peak_db=-8, tags=["camera", "photo", "archival"], description="Camera shutter: an archival photo lands"),
    "foley.paper":     dict(fn=foley_paper, variants=2, kind="oneshot", peak_db=-12, tags=["paper", "document", "archival"], description="Paper slide: a document or file appears"),
    "texture.projector": dict(fn=texture_projector, variants=1, kind="loop", peak_db=-16, tags=["texture", "film", "archival", "history", "loop"], description="Film projector loop under archival footage"),
    "texture.crackle": dict(fn=texture_crackle, variants=1, kind="loop", peak_db=-18, tags=["texture", "vinyl", "old", "history", "loop"], description="Old-record crackle loop"),
    "bed.drone":       dict(fn=bed_drone, variants=1, kind="loop", peak_db=-12, tags=["bed", "dark", "drone", "tension", "loop"], description="Dark drone loop under a tense stretch"),
    "bed.heartbeat":   dict(fn=bed_heartbeat, variants=1, kind="loop", peak_db=-10, tags=["bed", "tension", "suspense", "loop"], description="Heartbeat loop at 60 bpm"),
}

# Which library entry each engine cue type plays by default. A kit or profile can remap any of these.
DEFAULT_CUES = {
    "hit": "impact.punch", "stamp": "impact.stamp", "whoosh": "whoosh.fast", "riser": "riser.tension",
    "down": "down.drop", "pop": "ui.pop", "tick": "ui.tick", "type": "foley.key", "ding": "ui.ding",
    "error": "ui.error", "click": "ui.click", "shutter": "foley.shutter", "paper": "foley.paper",
}
