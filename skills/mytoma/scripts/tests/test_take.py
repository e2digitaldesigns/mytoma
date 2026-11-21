"""Tests for take.py (trim, face) and captions.py. No speech model needed: words.json is written by hand.

The test video encodes its own frame number in its brightness (frame n has luma (n * 8) mod 256), so
extracted face frames can be checked against the exact source frame they must come from.
"""

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

SCRIPTS = Path(__file__).resolve().parents[1]
TAKE = SCRIPTS / "take.py"
CAPTIONS = SCRIPTS / "captions.py"
CLI = SCRIPTS / "cli.js"


def sh(*cmd):
    res = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    if res.returncode != 0:
        raise AssertionError(f"{cmd[0]} failed:\n{res.stderr}\n{res.stdout}")
    return res.stdout


def make_take(path, seconds=6.0, rotation=None):
    """320x180 @ 30 fps; luma encodes the frame number; a 440 Hz tone on the audio track."""
    v = f"color=c=black:s=320x180:r=30:d={seconds},geq=lum='mod(N*8\\,256)':cb=128:cr=128"
    sh("ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", v, "-f", "lavfi", "-i", f"sine=f=440:d={seconds}",
       "-shortest", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path) + ".tmp.mp4")
    if rotation is None:
        Path(str(path) + ".tmp.mp4").rename(path)
    else:
        sh("ffmpeg", "-v", "error", "-y", "-display_rotation", str(rotation), "-i", str(path) + ".tmp.mp4", "-c", "copy", path)
        Path(str(path) + ".tmp.mp4").unlink()


def source_frame(jpg):
    """The source frame number a face JPEG came from. The JPEG is full range; the source's luma was
    TV range (16-235), so undo that scaling before reading the frame number back out."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(jpg), "-vf", "extractplanes=y", "-f", "rawvideo", "-"],
                         capture_output=True).stdout
    full = float(np.frombuffer(raw, np.uint8).mean())
    return (full * 219 / 255 + 16) / 8


WORDS = [{"w": "Hey,", "s": 1.20, "e": 1.50, "p": 0.9}, {"w": "my", "s": 1.60, "e": 1.70, "p": 0.9},
         {"w": "name", "s": 1.72, "e": 1.95, "p": 0.9}, {"w": "is", "s": 2.00, "e": 2.10, "p": 0.9},
         {"w": "Icon.", "s": 2.15, "e": 2.60, "p": 0.9}, {"w": "I", "s": 3.00, "e": 3.10, "p": 0.9},
         {"w": "eat", "s": 3.15, "e": 3.40, "p": 0.9}, {"w": "spaghetti", "s": 3.45, "e": 3.90, "p": 0.9},
         {"w": "and", "s": 3.95, "e": 4.05, "p": 0.9}, {"w": "ice", "s": 4.10, "e": 4.30, "p": 0.9},
         {"w": "cream.", "s": 4.32, "e": 4.70, "p": 0.9}]


class TakeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.work = self.dir / "work"
        self.work.mkdir()
        (self.work / "words.json").write_text(json.dumps(WORDS))

    def tearDown(self):
        self.tmp.cleanup()

    def test_trim_cuts_dead_air_and_shifts_words(self):
        src = self.dir / "take.mp4"
        make_take(src)
        out = sh(sys.executable, TAKE, "trim", src, self.work)
        take = json.loads((self.work / "take.json").read_text())
        self.assertAlmostEqual(take["in"], 0.7, places=6)              # 1.20 - 0.5, on a frame boundary
        self.assertAlmostEqual(take["in"] * 30, round(take["in"] * 30), places=6)
        self.assertAlmostEqual(take["out"], 5.7, delta=1 / 30)         # last word 4.70 + 1.0 for a video
        words = json.loads((self.work / "words.json").read_text())
        self.assertAlmostEqual(words[0]["s"], 0.5, places=3)
        self.assertEqual(len(words), len(WORDS))
        dur = float(sh("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", self.work / "voice.wav"))
        self.assertAlmostEqual(dur, take["duration"], delta=0.01)
        self.assertIn("30.0 fps", out)

    def test_retrim_starts_from_the_raw_words(self):
        src = self.dir / "take.mp4"
        make_take(src)
        sh(sys.executable, TAKE, "trim", src, self.work)
        sh(sys.executable, TAKE, "trim", src, self.work, "--in", "2.9", "--out", "5")
        words = json.loads((self.work / "words.json").read_text())
        self.assertEqual([w["w"] for w in words][:2], ["I", "eat"], "an excerpt keeps only the words inside it")
        self.assertAlmostEqual(words[0]["s"], 3.00 - 29 / 10, places=2)

    def test_probe_reports_rotation_as_played(self):
        src = self.dir / "rot.mp4"
        make_take(src, rotation=90)
        out = sh(sys.executable, TAKE, "trim", src, self.work)
        self.assertIn("180x320 (as played; rotation 90", out)

    def test_face_frames_match_the_edit_clock(self):
        src = self.dir / "take.mp4"
        make_take(src)
        sh(sys.executable, TAKE, "trim", src, self.work)
        sh("node", CLI, "new", self.work, "--format", "square", "--duration", "4")
        sh(sys.executable, TAKE, "face", self.work, "0-0.5,2-2.2")
        take = json.loads((self.work / "take.json").read_text())
        for f in (0, 7, 14, 60, 65):                          # frames whose luma stays clear of the 0/255 wrap
            src_frame = round(take["in"] * 30) + f            # edit frame f is source frame in*30 + f
            got = source_frame(self.work / "face" / f"f{f:05d}.jpg")
            self.assertAlmostEqual(got, src_frame % 32, delta=0.25, msg=f"edit frame {f} should be source frame {src_frame}")
        self.assertFalse((self.work / "face" / "f00015.jpg").exists(), "nothing outside the ranges")

    def test_face_rejects_ranges_past_the_take(self):
        src = self.dir / "take.mp4"
        make_take(src)
        sh(sys.executable, TAKE, "trim", src, self.work)
        sh("node", CLI, "new", self.work, "--format", "square", "--duration", "4")
        res = subprocess.run([sys.executable, str(TAKE), "face", str(self.work), "4-9"], capture_output=True, text=True)
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("ends after the trimmed take", res.stderr)


class CaptionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name)
        (self.work / "words.json").write_text(json.dumps(WORDS))

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, *extra):
        sh(sys.executable, CAPTIONS, self.work, *extra)
        data = json.loads(re.sub(r"^window\.CAPTIONS = |;\s*$", "", (self.work / "words.js").read_text()))
        lines = [" ".join(w["w"] for w in data["words"][p["a"]:p["b"]]) for p in data["phrases"]]
        return data, lines

    def test_fixes_keep_punctuation_and_can_drop_words(self):
        (self.work / "fixes.json").write_text(json.dumps({"Icon": "iCon", "eat@3.15": "ate", "I": ""}))
        data, lines = self.build()
        text = " ".join(lines)
        self.assertIn("iCon.", text)
        self.assertIn("ate", text)
        self.assertNotIn(" I ", f" {text} ")
        self.assertEqual(len(data["words"]), len(WORDS) - 1)

    def test_no_stranded_last_word_and_joiners_open_lines(self):
        _, lines = self.build()
        self.assertTrue(any(l.endswith("ice cream.") for l in lines), "a sentence's last word goes down with its neighbour")
        self.assertNotIn("cream.", lines)
        self.assertTrue(any(l.startswith("and") for l in lines), "'and' opens a line instead of dangling")
        for l in lines:
            self.assertLessEqual(len(l.split()), 3)

    def test_keywords_marked(self):
        (self.work / "keywords.json").write_text(json.dumps(["spaghetti", "cream@4.32"]))
        data, _ = self.build()
        marked = [w["w"] for w in data["words"] if w.get("k")]
        self.assertEqual(marked, ["spaghetti", "cream."])

    def test_srt_and_vtt(self):
        self.build()
        srt = (self.work / "captions.srt").read_text()
        self.assertTrue(srt.startswith("1\n00:00:01,200 --> "))
        self.assertTrue((self.work / "captions.vtt").read_text().startswith("WEBVTT"))
        times = re.findall(r"(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)", srt)
        self.assertTrue(all(a < b for a, b in times))
        self.assertTrue(all(times[i][1] <= times[i + 1][0] for i in range(len(times) - 1)), "subtitles never overlap")


if __name__ == "__main__":
    unittest.main()
