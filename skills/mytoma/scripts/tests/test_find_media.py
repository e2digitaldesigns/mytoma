"""Tests for find_media.py. Every HTTP request goes to a fake router: no network in tests."""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import find_media  # noqa: E402


def jpeg_bytes(width, height, colour=(200, 160, 60)):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, "JPEG")
    return buffer.getvalue()


def commons_page(index, title, licence, artist, width=2400, height=1600, licence_url="", restrictions=""):
    extmetadata = {"LicenseShortName": {"value": licence}, "Artist": {"value": f"<a href='x'>{artist}</a>"},
                   "LicenseUrl": {"value": licence_url}, "Restrictions": {"value": restrictions}}
    return {"index": index, "title": f"File:{title}.jpg", "imageinfo": [{
        "url": f"https://upload.wikimedia.org/{title}.jpg",
        "thumburl": f"https://upload.wikimedia.org/thumb/{title}.jpg/3840px-{title}.jpg",
        "descriptionurl": f"https://commons.wikimedia.org/wiki/File:{title}.jpg",
        "width": width, "height": height, "extmetadata": extmetadata}]}


COMMONS = {"query": {"pages": {
    "1": commons_page(1, "Thick fries", "CC BY-SA 4.0", "Jane Doe", licence_url="https://creativecommons.org/licenses/by-sa/4.0"),
    "2": commons_page(2, "Fries menu", "CC BY-NC 2.0", "Someone"),
    "3": commons_page(3, "Tiny fries", "Public domain", "Unknown author", width=640, height=480),
    "4": commons_page(4, "Fries in a cone", "Public domain", "Unknown author Unknown author"),
    "5": commons_page(5, "Fries GFDL", "GFDL", "Someone"),
    "6": commons_page(6, "Fries no derivs", "CC BY-ND 4.0", "Someone"),
}}}

OPENVERSE = {"results": [
    {"title": "Fries close-up", "creator": "Sam Cook", "license": "by", "license_version": "2.0",
     "license_url": "https://creativecommons.org/licenses/by/2.0/", "foreign_landing_url": "https://flickr.com/photos/1",
     "url": "https://live.staticflickr.com/1.jpg", "thumbnail": "https://api.openverse.org/v1/images/1/thumb/",
     "width": 2048, "height": 1365},
    # the same file Commons already gave: dropped as a duplicate
    {"title": "Thick fries", "creator": "Jane Doe", "license": "by-sa", "license_version": "4.0",
     "foreign_landing_url": "https://commons.wikimedia.org/wiki/File:Thick_fries.jpg",
     "url": "https://upload.wikimedia.org/x.jpg", "width": 2400, "height": 1600},
]}

ARCHIVE_SEARCH = {"response": {"docs": [
    {"identifier": "fries-scan", "title": "Fries, an engraving", "creator": ["Engraver"],
     "licenseurl": "http://creativecommons.org/publicdomain/mark/1.0/"}]}}
ARCHIVE_METADATA = {"files": [
    {"name": "fries_thumb.jpg", "source": "derivative", "size": "100"},
    {"name": "fries scan.jpg", "source": "original", "size": "5000"},
    {"name": "fries.xml", "source": "original", "size": "10"}]}

PEXELS = {"photos": [{"id": 77, "width": 3000, "height": 4500, "url": "https://www.pexels.com/photo/fries-77/",
                      "photographer": "Pat Lens", "alt": "Fries on a tray",
                      "src": {"original": "https://images.pexels.com/photos/77/a.jpeg", "medium": "https://images.pexels.com/m.jpeg"}}]}


class FakeWeb:
    """Answers find_media.fetch_url by URL prefix and records every request."""

    def __init__(self, images=None, commons=COMMONS):
        self.requests = []
        self.images = images or {}
        self.commons = commons

    def __call__(self, url, headers=None):
        self.requests.append((url, headers or {}))
        if url.startswith("https://commons.wikimedia.org/w/api.php"):
            return json.dumps(self.commons).encode()
        if url.startswith("https://api.openverse.org/v1/images/"):
            return json.dumps(OPENVERSE).encode()
        if url.startswith("https://archive.org/advancedsearch.php"):
            return json.dumps(ARCHIVE_SEARCH).encode()
        if url.startswith("https://archive.org/metadata/"):
            return json.dumps(ARCHIVE_METADATA).encode()
        if url.startswith("https://api.pexels.com/"):
            return json.dumps(PEXELS).encode()
        for prefix, data in self.images.items():
            if url.startswith(prefix):
                return data
        return jpeg_bytes(2400, 1600)

    def urls(self, prefix):
        return [url for url, _ in self.requests if url.startswith(prefix)]


def no_network(*args, **kwargs):
    raise AssertionError("a test tried to reach the network")


class FindMediaTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.work = Path(self.temporary.name)
        self.web = FakeWeb()
        self.patches = [mock.patch.object(find_media, "fetch_url", self.web),
                        mock.patch.object(urllib.request, "urlopen", no_network),
                        mock.patch.dict(os.environ, {}, clear=False)]
        for patch in self.patches:
            patch.start()
        os.environ.pop("PEXELS_API_KEY", None)

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temporary.cleanup()

    def run_tool(self, *arguments):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = find_media.main([str(self.work), *arguments])
        return code, output.getvalue()

    def test_licences_allowed_and_refused_with_reasons(self):
        classify = find_media.classify_licence
        self.assertEqual(classify("Public domain"), ("Public domain", find_media.PUBLIC_DOMAIN_URL))
        self.assertEqual(classify("CC0"), ("CC0 1.0", find_media.CC0_URL))
        self.assertEqual(classify("", "http://creativecommons.org/publicdomain/zero/1.0/"), ("CC0 1.0", find_media.CC0_URL))
        self.assertEqual(classify("CC BY 2.0", "", "Ann"), ("CC BY 2.0", "https://creativecommons.org/licenses/by/2.0/"))
        self.assertEqual(classify("CC BY-SA 3.0", "", "Ann")[0], "CC BY-SA 3.0")
        self.assertEqual(classify("Pexels License")[0], "Pexels License")
        refused = {
            "CC BY-NC 2.0": "non-commercial", "CC BY-NC-SA 4.0": "non-commercial", "CC BY-ND 4.0": "no derivatives",
            "GFDL": "GFDL", "": "no licence", "All rights reserved": "unclear", "CC BY-SA": "no version",
            "No known copyright restrictions": "not a licence",
        }
        for text, reason in refused.items():
            with self.assertRaises(find_media.SkipCandidate, msg=text) as caught:
                classify(text, "", "Ann")
            self.assertIn(reason, str(caught.exception), text)
        with self.assertRaisesRegex(find_media.SkipCandidate, "no author"):
            classify("CC BY 4.0", "", "Unknown author")

    def test_saves_readable_names_and_credits_and_says_what_was_skipped(self):
        code, output = self.run_tool("thick french fries", "--count", "3", "--name", "fries")
        self.assertEqual(code, 0, output)
        names = sorted(path.name for path in (self.work / "assets").iterdir())
        self.assertEqual(names, ["fries-01.jpg", "fries-02.jpg", "fries-03.jpg"])
        credits = json.loads((self.work / "credits.json").read_text())
        self.assertEqual([entry["file"] for entry in credits], ["assets/fries-01.jpg", "assets/fries-02.jpg", "assets/fries-03.jpg"])
        first = credits[0]
        for key in ("file", "title", "author", "source", "source_url", "licence", "licence_url"):
            self.assertTrue(first[key], key)
        # round robin: Commons first, then Openverse, then the Archive (no Pexels key)
        self.assertEqual([entry["source"] for entry in credits], ["Wikimedia Commons", "Openverse", "Internet Archive"])
        self.assertEqual(first["author"], "Jane Doe")
        self.assertEqual(first["licence_url"], "https://creativecommons.org/licenses/by-sa/4.0/")
        self.assertEqual(credits[2]["licence"], "Public domain")
        text = (self.work / "credits.txt").read_text()
        self.assertIn('"Thick fries" by Jane Doe, CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), via Wikimedia Commons', text)
        self.assertIn("Images are cropped and colour-tinted.", text)
        # the pick list: file, size, licence, source
        self.assertRegex(output, r"assets/fries-01\.jpg\s+2400x1600\s+CC BY-SA 4\.0\s+Wikimedia Commons")
        self.assertIn("non-commercial (NC)", output)
        self.assertIn("no derivatives (ND)", output)
        self.assertIn("GFDL only", output)
        self.assertIn("640 px wide, smaller than --min-width 1080", output)
        # the Archive's file comes from the item's largest original
        self.assertTrue(self.web.urls("https://archive.org/download/fries-scan/fries%20scan.jpg"))

    def test_pexels_only_with_a_key(self):
        self.run_tool("fries", "--count", "1")
        self.assertEqual(self.web.urls("https://api.pexels.com/"), [])
        os.environ["PEXELS_API_KEY"] = "test-key"
        self.web.images["https://images.pexels.com/"] = jpeg_bytes(1200, 1800)
        code, output = self.run_tool("fries", "--count", "1", "--orientation", "portrait", "--name", "tray")
        self.assertEqual(code, 0, output)
        searches = [(url, headers) for url, headers in self.web.requests if url.startswith("https://api.pexels.com/")]
        self.assertEqual(len(searches), 1)
        self.assertEqual(searches[0][1]["Authorization"], "test-key")
        self.assertIn("orientation=portrait", searches[0][0])
        credits = json.loads((self.work / "credits.json").read_text())
        tray = [entry for entry in credits if entry["file"] == "assets/tray-01.jpg"][0]
        self.assertEqual((tray["source"], tray["licence"]), ("Pexels", "Pexels License"))
        self.assertIn("Photo by Pat Lens on Pexels", (self.work / "credits.txt").read_text())

    def test_orientation_and_size_are_checked_on_the_real_file(self):
        # the Archive states no size; its file turns out landscape and is refused for a portrait request
        self.web.images["https://archive.org/download/"] = jpeg_bytes(2000, 1000)
        self.web.images["https://upload.wikimedia.org/"] = jpeg_bytes(1200, 2000)
        self.web.images["https://live.staticflickr.com/"] = jpeg_bytes(900, 1600)
        portrait_commons = {"query": {"pages": {"1": commons_page(1, "Tall fries", "CC0", "x", width=1200, height=2000)}}}
        self.web.commons = portrait_commons
        code, output = self.run_tool("fries", "--orientation", "portrait", "--min-width", "1000")
        self.assertEqual(code, 0, output)
        self.assertEqual([path.name for path in (self.work / "assets").iterdir()], ["fries-01.jpg"])
        self.assertIn("landscape, not portrait", output)
        self.assertIn("Openverse \"Fries close-up\": landscape, not portrait", output)

    def test_a_second_search_never_saves_the_same_photo_again(self):
        self.run_tool("fries", "--count", "1", "--sources", "commons", "--name", "fries")
        code, output = self.run_tool("thick fries", "--count", "1", "--sources", "commons", "--name", "chips")
        self.assertEqual(code, 0, output)
        self.assertIn("\"Thick fries\": already in this project's assets/", output)
        sources = [entry["source_url"] for entry in json.loads((self.work / "credits.json").read_text())]
        self.assertEqual(len(sources), len(set(sources)))

    def test_numbering_continues_and_credits_follow_the_files(self):
        self.run_tool("fries", "--count", "2")
        self.run_tool("fries", "--count", "1")
        self.assertTrue((self.work / "assets" / "fries-03.jpg").is_file())
        (self.work / "assets" / "fries-02.jpg").unlink()
        code, output = self.run_tool()
        self.assertEqual(code, 0, output)
        files = [entry["file"] for entry in json.loads((self.work / "credits.json").read_text())]
        self.assertEqual(files, ["assets/fries-01.jpg", "assets/fries-03.jpg"])
        self.assertNotIn("fries-02", (self.work / "credits.txt").read_text())

    def test_saved_files_are_clean_jpegs(self):
        buffer = io.BytesIO()
        Image.new("RGBA", (5000, 2500), (10, 20, 30, 128)).save(buffer, "PNG")
        self.web.images["https://upload.wikimedia.org/"] = buffer.getvalue()
        self.web.images["https://live.staticflickr.com/"] = b"<html>not an image</html>"
        code, output = self.run_tool("fries", "--count", "2", "--sources", "commons,openverse")
        self.assertEqual(code, 0, output)
        with Image.open(self.work / "assets" / "fries-01.jpg") as image:
            self.assertEqual((image.format, image.mode, image.size), ("JPEG", "RGB", (3840, 1920)))
        self.assertIn("not a readable image", output)
        self.assertFalse(list((self.work / "assets").glob("*.part")))

    def test_search_only_then_add_by_id_as_the_studio_does(self):
        code, output = self.run_tool("fries", "--search-only", "--json")
        self.assertEqual(code, 0, output)
        payload = json.loads(output.strip().splitlines()[-1])
        self.assertFalse((self.work / "assets").exists(), "search-only downloads nothing")
        ids = [result["id"] for result in payload["candidates"]]
        self.assertEqual(ids[:2], ["c1", "c2"])
        self.assertTrue(all(result["thumb_url"] and result["licence"] for result in payload["candidates"]))
        self.assertTrue(any("non-commercial" in skipped["reason"] for skipped in payload["skipped"]))
        code, output = self.run_tool("--add", "c2", "--name", "close up", "--json")
        self.assertEqual(code, 0, output)
        saved = json.loads(output.strip().splitlines()[-1])["saved"]
        self.assertEqual([entry["file"] for entry in saved], ["assets/close-up-01.jpg"])
        self.assertEqual(saved[0]["author"], "Sam Cook")
        code, output = self.run_tool("--add", "c99")
        self.assertEqual(code, 1)
        self.assertIn("Not in the last search", output)

    def test_a_failing_source_does_not_stop_the_others(self):
        original = self.web.__call__

        def flaky(url, headers=None):
            if url.startswith("https://api.openverse.org/"):
                raise find_media.urllib.error.URLError("down")
            return original(url, headers)

        with mock.patch.object(find_media, "fetch_url", flaky):
            code, output = self.run_tool("fries", "--count", "1")
        self.assertEqual(code, 0, output)
        self.assertIn("Openverse search failed", output)

    def test_names_are_readable(self):
        self.assertEqual(find_media.slugify("Moon's Lake House"), "moons-lake-house")
        self.assertEqual(find_media.plain_text("Unknown artist Unknown artist"), "Unknown artist")


if __name__ == "__main__":
    unittest.main()
