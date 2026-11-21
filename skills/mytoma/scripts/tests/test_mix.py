"""python3 -m unittest discover -s tests   (from scripts/)

Each test writes a cues.json by hand, runs mix.py, and measures the stems it wrote.
"""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS / "audio"))
import dsp  # noqa: E402

MIX = SCRIPTS / "audio" / "mix.py"
SR = dsp.SR


def run_mix(work, cues, duration=4.0, *extra):
    work = Path(work)
    (work / "cues.json").write_text(json.dumps(cues))
    res = subprocess.run([sys.executable, str(MIX), str(work), "--duration", str(duration), *extra],
                         capture_output=True, text=True)
    if res.returncode != 0:
        raise AssertionError(res.stderr + res.stdout)
    return res.stdout


def level(x, a, b):
    seg = dsp.mono(x)[int(a * SR):int(b * SR)]
    return dsp.db(np.sqrt(np.mean(seg ** 2))) if len(seg) else -240


class MixTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name) / "mix-test"
        self.work.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def stem(self, name):
        return dsp.load(self.work / "audio" / f"{name}.wav")

    def test_oneshot_lands_on_its_cue(self):
        run_mix(self.work, [{"t": 1.0, "type": "hit", "power": 1}], 3, "--music", "none")
        sfx = self.stem("sfx")
        self.assertLess(level(sfx, 0.0, 0.995), -100, "silence before the cue")
        self.assertGreater(level(sfx, 1.0, 1.03), -30, "sound right after the cue")

    def test_riser_ends_on_the_reveal(self):
        run_mix(self.work, [{"t": 1.0, "type": "riser", "dur": 1.5}], 4, "--music", "none")
        sfx = self.stem("sfx")
        self.assertLess(level(sfx, 0.0, 0.99), -100, "nothing before the riser starts")
        self.assertGreater(level(sfx, 2.42, 2.49), -40, "loudest at the end")
        self.assertLess(level(sfx, 2.52, 3.0), -100, "stops dead at t + dur")

    def test_typing_repeats_across_its_duration(self):
        run_mix(self.work, [{"t": 0.5, "type": "type", "dur": 1.2}], 3, "--music", "none")
        x = np.abs(dsp.mono(self.stem("sfx")))
        hop = int(0.01 * SR)
        env = np.array([x[i:i + hop].max() for i in range(0, len(x), hop)])
        onsets = np.sum((env[1:] > 0.02) & (env[:-1] <= 0.02))
        self.assertGreaterEqual(onsets, 10)     # interval 0.06 s + jitter over 1.2 s → ~15 strokes
        self.assertLess(level(self.stem("sfx"), 1.8, 3.0), -100, "typing stops after its duration")

    def test_loop_fills_exactly_its_range(self):
        run_mix(self.work, [{"t": 1.0, "type": "texture.crackle", "dur": 2.0}], 4, "--music", "none")
        sfx = self.stem("sfx")
        self.assertGreater(level(sfx, 1.5, 2.5), -60)
        self.assertLess(level(sfx, 3.05, 4.0), -100)

    def test_variants_rotate(self):
        out = run_mix(self.work, [{"t": 0.5, "type": "pop"}, {"t": 1.0, "type": "pop"}, {"t": 1.5, "type": "pop"}],
                      2, "--music", "none")
        self.assertIn("ui.pop 3", out)
        sfx = dsp.mono(self.stem("sfx"))
        clips = [sfx[int(t * SR):int(t * SR) + 2000] for t in (0.5, 1.0, 1.5)]
        self.assertEqual(len({hashlib.sha1(c.tobytes()).hexdigest() for c in clips}), 3, "three different variants")

    def test_same_cues_same_file(self):
        cues = [{"t": 0.3, "type": "whoosh"}, {"t": 0.5, "type": "hit", "power": 0.8}, {"t": 1.0, "type": "type", "dur": 0.6}]
        run_mix(self.work, cues, 3)
        a = (self.work / "audio" / "mix.wav").read_bytes()
        run_mix(self.work, cues, 3)
        self.assertEqual(a, (self.work / "audio" / "mix.wav").read_bytes())

    def test_loudness_target(self):
        run_mix(self.work, [{"t": 0.5, "type": "hit"}, {"t": 2.0, "type": "stamp"}], 6)
        lufs, tp, _ = dsp.loudness(self.work / "audio" / "mix.wav")
        self.assertAlmostEqual(lufs, -14.0, delta=0.7)
        self.assertLessEqual(tp, -1.8)

    def test_music_ducks_under_the_voice(self):
        # a "voice": band-limited noise from 2 s to 4 s, silence elsewhere
        rng = np.random.default_rng(1)
        voice = np.zeros(int(6 * SR), np.float32)
        voice[2 * SR:4 * SR] = dsp.bandpass(rng.standard_normal(2 * SR).astype(np.float32), 200, 3000) * 0.3
        dsp.save(self.work / "voice.wav", voice)
        run_mix(self.work, [], 6, "--voice", str(self.work / "voice.wav"), "--music", "bed.drone")
        music = self.stem("music")
        self.assertGreater(level(music, 1.0, 1.8) - level(music, 2.6, 3.6), 6, "music at least 6 dB down under speech")
        self.assertGreater(level(music, 5.0, 5.4) - level(music, 2.6, 3.6), 3, "and swells back after it")

    def test_drop_clears_the_music_before_the_final_hit(self):
        run_mix(self.work, [], 6, "--music", "bed.drone", "--drop", "4.0")
        music = self.stem("music")
        self.assertLess(level(music, 3.5, 3.99), -100)
        self.assertGreater(level(music, 4.05, 4.4), -60)

    def test_unknown_cue_is_reported_not_fatal(self):
        out = run_mix(self.work, [{"t": 0.5, "type": "hit"}, {"t": 1.0, "type": "kazoo"}], 2, "--music", "none")
        self.assertIn("kazoo: no library entry", out)
        report = json.loads((self.work / "audio" / "mix.json").read_text())
        self.assertEqual(len(report["placed"]), 1)

    def test_map_remaps_a_cue_for_one_video(self):
        out = run_mix(self.work, [{"t": 0.5, "type": "hit"}], 3, "--music", "none", "--map", "hit=impact.heavy")
        self.assertIn("impact.heavy 1", out)


if __name__ == "__main__":
    unittest.main()
