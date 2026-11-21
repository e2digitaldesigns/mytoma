"""Audio building blocks for myToma: file I/O through ffmpeg, filters, envelopes, levels.

Every buffer is float32, shape (n, 2), at SR = 48 kHz. Nothing here uses the clock or unseeded
randomness: the same inputs always give the same samples.
"""

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
from scipy import signal

SR = 48000


def require_ffmpeg():
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg not found: install it (brew install ffmpeg · sudo apt install ffmpeg)")


# ---------- I/O ----------

def load(path, sr=SR):
    """Decode any audio file ffmpeg reads into float32 stereo at `sr`."""
    require_ffmpeg()
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "2", "-ar", str(sr), "-"],
        capture_output=True, check=False)
    if raw.returncode != 0:
        raise RuntimeError(f"ffmpeg could not decode {path}: {raw.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(raw.stdout, dtype=np.float32).reshape(-1, 2).copy()


def save(path, audio, sr=SR, codec=None):
    """Write float32 stereo. .wav → 24-bit PCM; .ogg → Vorbis q6; anything else: ffmpeg's default."""
    require_ffmpeg()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    audio = stereo(audio).astype(np.float32)
    if codec is None:
        codec = {".wav": ["-c:a", "pcm_s24le"], ".ogg": ["-c:a", "libvorbis", "-q:a", "6"],
                 ".m4a": ["-c:a", "aac", "-b:a", "256k"]}.get(path.suffix.lower(), [])
    # -bitexact keeps encoder/version strings out of the header, so identical audio gives identical files
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "-",
           *codec, "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", str(path)]
    res = subprocess.run(cmd, input=np.ascontiguousarray(audio).tobytes(), capture_output=True)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg could not write {path}: {res.stderr.decode(errors='replace').strip()}")
    return path


# ---------- shape ----------

def stereo(x):
    x = np.asarray(x, dtype=np.float32)
    if x.ndim == 1:
        return np.stack([x, x], axis=1)
    return x


def mono(x):
    x = np.asarray(x, dtype=np.float32)
    return x.mean(axis=1) if x.ndim == 2 else x


def pan(x, position):
    """Constant-power pan of a mono signal; position -1 (left) … 1 (right)."""
    angle = (position + 1) * np.pi / 4
    x = mono(x)
    return np.stack([x * np.cos(angle), x * np.sin(angle)], axis=1).astype(np.float32)


def t_axis(seconds, sr=SR):
    return np.arange(int(round(seconds * sr)), dtype=np.float64) / sr


def silence(seconds, sr=SR):
    return np.zeros((int(round(seconds * sr)), 2), dtype=np.float32)


# ---------- filters ----------

def _sos(kind, freq, order=2, sr=SR):
    nyq = sr / 2
    if kind == "band":
        lo, hi = freq
        return signal.butter(order, [max(lo, 5) / nyq, min(hi, nyq * 0.98) / nyq], btype="band", output="sos")
    return signal.butter(order, min(max(freq, 5), nyq * 0.98) / nyq, btype=kind, output="sos")


def lowpass(x, freq, order=2):
    return signal.sosfilt(_sos("low", freq, order), x, axis=0).astype(np.float32)


def highpass(x, freq, order=2):
    return signal.sosfilt(_sos("high", freq, order), x, axis=0).astype(np.float32)


def bandpass(x, lo, hi, order=2):
    return signal.sosfilt(_sos("band", (lo, hi), order), x, axis=0).astype(np.float32)


def sweep_lowpass(x, f_start, f_end, steps=64):
    """Lowpass whose cutoff moves from f_start to f_end across the signal (block-wise, state carried)."""
    x = np.asarray(x, dtype=np.float64)
    out = np.zeros_like(x)
    edges = np.linspace(0, len(x), steps + 1).astype(int)
    zi = None
    for i in range(steps):
        f = f_start * (f_end / f_start) ** (i / max(steps - 1, 1))
        sos = _sos("low", f, 2)
        if zi is None:
            zi = np.zeros((sos.shape[0], 2) + x.shape[1:])
        out[edges[i]:edges[i + 1]], zi = signal.sosfilt(sos, x[edges[i]:edges[i + 1]], axis=0, zi=zi)
    return out.astype(np.float32)


# ---------- envelopes ----------

def adsr(n, attack, decay, sustain, release, sr=SR):
    a, d, r = int(attack * sr), int(decay * sr), int(release * sr)
    s = max(0, n - a - d - r)
    env = np.concatenate([np.linspace(0, 1, a, endpoint=False), np.linspace(1, sustain, d, endpoint=False),
                          np.full(s, sustain), np.linspace(sustain, 0, r)])
    return np.pad(env, (0, max(0, n - len(env))))[:n].astype(np.float32)


def exp_decay(n, rate, sr=SR):
    return np.exp(-np.arange(n) / sr * rate).astype(np.float32)


def fade(x, fade_in=0.0, fade_out=0.0, sr=SR):
    x = np.array(x, dtype=np.float32, copy=True)
    a, b = int(fade_in * sr), int(fade_out * sr)
    if a:
        x[:a] *= np.linspace(0, 1, a)[:, None] if x.ndim == 2 else np.linspace(0, 1, a)
    if b:
        x[-b:] *= np.linspace(1, 0, b)[:, None] if x.ndim == 2 else np.linspace(1, 0, b)
    return x


def follow(x, attack=0.01, release=0.25, sr=SR, window=0.02):
    """Smoothed RMS envelope of a signal, one value per sample (used to duck music under voice)."""
    m = mono(x).astype(np.float64)
    w = max(1, int(window * sr))
    rms = np.sqrt(np.convolve(m * m, np.ones(w) / w, mode="same"))
    # one-pole attack/release smoothing, computed on a decimated grid for speed then expanded
    hop = 240
    grid = rms[::hop]
    out = np.zeros_like(grid)
    ka, kr = np.exp(-hop / (attack * sr)), np.exp(-hop / (release * sr))
    level = 0.0
    for i, v in enumerate(grid):
        k = ka if v > level else kr
        level = k * level + (1 - k) * v
        out[i] = level
    return np.interp(np.arange(len(m)), np.arange(len(grid)) * hop, out).astype(np.float32)


# ---------- levels ----------

def db(x):
    return 20 * np.log10(max(float(x), 1e-12))


def gain_db(value):
    return 10 ** (value / 20)


def peak(x):
    return float(np.max(np.abs(x))) if len(x) else 0.0


def normalize_peak(x, target_db=-3.0):
    p = peak(x)
    return (x * (gain_db(target_db) / p)).astype(np.float32) if p > 0 else x


def trim_silence(x, threshold_db=-60.0, keep_tail=0.02, sr=SR):
    """Cut leading and trailing silence below threshold (keeps a short tail so decays don't click)."""
    m = np.max(np.abs(stereo(x)), axis=1)
    loud = np.nonzero(m > gain_db(threshold_db))[0]
    if not len(loud):
        return x[:0]
    end = min(len(x), loud[-1] + int(keep_tail * sr))
    return x[loud[0]:end]


def place(buffer, sound, at_seconds, gain=1.0, sr=SR):
    """Add `sound` into `buffer` starting at `at_seconds` (clipped to the buffer)."""
    start = int(round(at_seconds * sr))
    sound = stereo(sound)
    if start < 0:
        sound, start = sound[-start:], 0
    end = min(len(buffer), start + len(sound))
    if end > start:
        buffer[start:end] += sound[:end - start] * gain
    return buffer


def loudness(path):
    """Integrated loudness (LUFS) and true peak (dBTP) of a file, measured by ffmpeg's EBU R128 scanner."""
    res = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af",
                          "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"],
                         capture_output=True, text=True)
    text = res.stderr
    data = json.loads(text[text.rindex("{"):text.rindex("}") + 1])
    return float(data["input_i"]), float(data["input_tp"]), data


def _ffmpeg_af(src, dst, filt):
    res = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af", filt, "-ar", str(SR), "-c:a", "pcm_s24le",
                          "-fflags", "+bitexact", "-flags:a", "+bitexact", str(dst)], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg -af {filt} failed: {res.stderr}")
    return dst


def loudnorm(src, dst, target=-14.0, true_peak=-1.0, max_passes=4):
    """Bring a file to `target` LUFS with true peaks at or under `true_peak` dBTP: 48 kHz 24-bit WAV.

    A plain gain does it when the peaks allow. When they don't (sparse, punchy mixes: a few big hits
    over quiet music), the peaks are limited at 4x oversampling, which catches inter-sample peaks too,
    and the level is measured and corrected again. ffmpeg's own loudnorm is avoided on purpose: on a
    mix with a wide loudness range it silently switches to dynamic mode and lands short of the target.
    """
    src, dst = Path(src), Path(dst)
    lufs, tp, _ = loudness(src)
    if not np.isfinite(lufs):
        raise RuntimeError(f"{src} is silent; nothing to normalise")
    temps = [dst.with_name(f"{dst.stem}.pass{i}.wav") for i in range(max_passes)]
    current = src
    try:
        for i in range(max_passes):
            gain = target - lufs
            if tp + gain <= true_peak + 0.05:
                _ffmpeg_af(current, dst, f"volume={gain:.3f}dB")
                return dst
            ceiling = gain_db(true_peak - 0.8)
            _ffmpeg_af(current, temps[i], f"aresample={SR * 4},volume={gain + 0.6:.3f}dB,"
                                           f"alimiter=limit={ceiling:.4f}:attack=1:release=60:level=disabled,aresample={SR}")
            current = temps[i]
            lufs, tp, _ = loudness(current)
        # Out of passes: land the level as close as the ceiling allows
        _ffmpeg_af(current, dst, f"volume={min(target - lufs, true_peak - tp):.3f}dB")
        return dst
    finally:
        for t in temps:
            t.unlink(missing_ok=True)
