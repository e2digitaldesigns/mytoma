#!/usr/bin/env python3
"""Find openly licensed photos for a myToma video, save them into <work>/assets/ and keep the credits.

  find_media.py <work> "<query>" [--count 5] [--orientation portrait|landscape] [--min-width 1080]
                [--name fries] [--sources commons,openverse,archive,pexels]
        searches, downloads the best <count> into <work>/assets/<name>-01.jpg, -02.jpg, … and lists them
  find_media.py <work> "<query>" --search-only [--json]
        lists candidates without downloading (kept in <work>/media/search.json for --add)
  find_media.py <work> --add c3,c7 [--name fries]
        downloads candidates from the last search by id
  find_media.py <work>
        rewrites credits.json and credits.txt from the files still in assets/ (run it after deleting the
        ones you did not pick)

Sources: Wikimedia Commons, Openverse and the Internet Archive need no key; Pexels is searched only when
PEXELS_API_KEY is set. Only openly licensed images are kept: public domain, CC0, CC BY, CC BY-SA and the
Pexels licence. Anything else (NC, ND, GFDL only, no stated licence, an attribution licence with no
author) is skipped, and the reason is printed.

Every saved image is a JPEG (at most 3840 px on its long side) with its credit in <work>/credits.json
(file, title, author, source, source URL, licence, licence URL) and <work>/credits.txt, ready to paste into
a YouTube description.
"""

import argparse
import html
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps

USER_AGENT = "myToma/0.1 (find_media.py; image search for a private video tool)"
SOURCE_ORDER = ["pexels", "commons", "openverse", "archive"]
SOURCE_NAMES = {"commons": "Wikimedia Commons", "openverse": "Openverse", "archive": "Internet Archive", "pexels": "Pexels"}
LONGEST_SIDE = 3840                    # more than any frame needs, even a 2x supersampled landscape render
MAX_DOWNLOAD_BYTES = 80_000_000
Image.MAX_IMAGE_PIXELS = 250_000_000   # archive scans are large, not decompression bombs
ALLOWED = "public domain, CC0, CC BY, CC BY-SA, Pexels licence"
PUBLIC_DOMAIN_URL = "https://creativecommons.org/publicdomain/mark/1.0/"
CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/"
PEXELS_LICENCE_URL = "https://www.pexels.com/license/"


class SkipCandidate(Exception):
    """A candidate that cannot be used; the message says why."""


# ---------- network: the one function tests replace ----------

def fetch_url(url, headers=None):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(request, timeout=40) as response:
        body = response.read(MAX_DOWNLOAD_BYTES + 1)
    if len(body) > MAX_DOWNLOAD_BYTES:
        raise SkipCandidate(f"file is over {MAX_DOWNLOAD_BYTES // 1_000_000} MB")
    return body


def fetch_json(url, headers=None):
    return json.loads(fetch_url(url, headers).decode("utf-8"))


# ---------- licences ----------

def plain_text(markup):
    text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", markup or ""))).strip()
    # Commons renders some names twice (a visible label and a hidden copy): "Unknown artist Unknown artist"
    words = text.split(" ")
    half = len(words) // 2
    return " ".join(words[:half]) if len(words) % 2 == 0 and half and words[:half] == words[half:] else text


def classify_licence(licence_text, licence_url="", author=""):
    """Return (licence name, licence URL) for an allowed licence; raise SkipCandidate saying why not."""
    stated = f"{licence_text or ''} {licence_url or ''}".strip()
    if not stated:
        raise SkipCandidate("no licence stated")
    lowered = stated.lower()
    if re.search(r"\bnc\b|non-?commercial|by-nc", lowered):
        raise SkipCandidate(f"non-commercial (NC): {licence_text or licence_url}")
    if re.search(r"\bnd\b|no-?deriv|by-nd", lowered):
        raise SkipCandidate(f"no derivatives (ND), and cropping and tinting is a derivative: {licence_text or licence_url}")
    if re.search(r"\bcc0\b|cc-zero|publicdomain/zero", lowered):
        return "CC0 1.0", CC0_URL
    if re.search(r"public ?domain|\bpd\b|\bpd-|\bpdm\b|publicdomain/mark", lowered):
        return "Public domain", licence_url if "publicdomain/mark" in (licence_url or "") else PUBLIC_DOMAIN_URL
    if "pexels" in lowered:
        return "Pexels License", PEXELS_LICENCE_URL
    share_alike = re.search(r"cc[ -]?by[ -]?sa\b|licenses/by-sa/", lowered)
    attribution = share_alike or re.search(r"cc[ -]?by\b|licenses/by/", lowered)
    if attribution:
        code = "by-sa" if share_alike else "by"
        version_match = re.search(r"(\d\.\d)", stated)
        if not version_match:
            raise SkipCandidate(f"licence unclear: {stated!r} names no version")
        if not author or author.lower() in ("unknown", "unknown author", "anonymous"):
            raise SkipCandidate(f"CC {code.upper()} needs attribution, but no author is stated")
        version = version_match.group(1)
        url = licence_url if licence_url and f"/{code}/" in licence_url else f"https://creativecommons.org/licenses/{code}/{version}/"
        url = url.replace("http://", "https://")
        return f"CC {code.upper()} {version}", url if url.endswith("/") else url + "/"
    if re.search(r"gfdl|gnu free documentation", lowered):
        raise SkipCandidate("GFDL only, which is not one of: " + ALLOWED)
    if "no known copyright" in lowered:
        raise SkipCandidate("\"no known copyright restrictions\" is not a licence")
    raise SkipCandidate(f"licence unclear: {stated!r}")


# ---------- searches: each returns candidate dicts ----------

def candidate(source, title, author, licence_text, licence_url, page_url, file_url, thumb_url, width, height, **extra):
    return {"source": source, "title": (title or "untitled").strip(), "author": (author or "").strip(),
            "licence_text": licence_text or "", "licence_url_given": licence_url or "", "page_url": page_url,
            "file_url": file_url, "thumb_url": thumb_url, "width": width, "height": height, **extra}


def search_commons(query, limit, orientation):
    parameters = {
        "action": "query", "format": "json", "generator": "search", "gsrnamespace": "6", "gsrlimit": str(limit),
        "gsrsearch": f"{query} filetype:bitmap -filemime:image/gif", "prop": "imageinfo",
        "iiprop": "url|size|mime|extmetadata", "iiurlwidth": "2560",
        "iiextmetadatafilter": "LicenseShortName|LicenseUrl|Artist|Attribution|ObjectName|Restrictions",
    }
    data = fetch_json("https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(parameters))
    pages = sorted(data.get("query", {}).get("pages", {}).values(), key=lambda page: page.get("index", 0))
    results = []
    for page in pages:
        info = (page.get("imageinfo") or [{}])[0]
        metadata = {key: plain_text(value.get("value")) for key, value in info.get("extmetadata", {}).items()}
        file_url = info.get("thumburl") or info.get("url")
        thumb_url = re.sub(r"/\d+px-", "/480px-", file_url) if "/thumb/" in (file_url or "") else file_url
        title = metadata.get("ObjectName") or re.sub(r"\.\w+$", "", page.get("title", "").removeprefix("File:"))
        results.append(candidate(
            "commons", title, metadata.get("Attribution") or metadata.get("Artist"),
            metadata.get("LicenseShortName"), metadata.get("LicenseUrl"), info.get("descriptionurl"), file_url, thumb_url,
            info.get("width"), info.get("height"),
            people="personality" in metadata.get("Restrictions", "").lower()))
    return results


def openverse_licence(code, version):
    code = (code or "").lower()
    if code in ("cc0", "pdm"):
        return {"cc0": "CC0", "pdm": "Public Domain Mark"}[code]
    return f"CC {code.upper()} {version or ''}".strip()


def search_openverse(query, limit, orientation):
    parameters = {"q": query, "page_size": str(min(limit, 20)), "license": "cc0,pdm,by,by-sa", "mature": "false"}
    if orientation:
        parameters["aspect_ratio"] = {"portrait": "tall", "landscape": "wide"}[orientation]
    data = fetch_json("https://api.openverse.org/v1/images/?" + urllib.parse.urlencode(parameters))
    return [candidate(
        "openverse", item.get("title"), item.get("creator"),
        openverse_licence(item.get("license"), item.get("license_version")), item.get("license_url"),
        item.get("foreign_landing_url"), item.get("url"), item.get("thumbnail") or item.get("url"),
        item.get("width"), item.get("height"), provider=item.get("provider") or item.get("source") or "")
        for item in data.get("results", [])]


def search_archive(query, limit, orientation):
    # Most Archive uploads state no licence at all; only items that declare one can be used
    parameters = [("q", f"({query}) AND mediatype:image AND licenseurl:*"), ("rows", str(min(limit, 25))), ("output", "json")]
    parameters += [("fl[]", field) for field in ("identifier", "title", "creator", "licenseurl")]
    data = fetch_json("https://archive.org/advancedsearch.php?" + urllib.parse.urlencode(parameters))
    results = []
    for document in data.get("response", {}).get("docs", []):
        identifier = document["identifier"]
        creator = document.get("creator")
        licence_url = document.get("licenseurl") or ""
        results.append(candidate(
            "archive", document.get("title") or identifier, ", ".join(creator) if isinstance(creator, list) else creator,
            licence_url, licence_url, f"https://archive.org/details/{identifier}", None,
            f"https://archive.org/services/img/{identifier}", None, None, identifier=identifier))
    return results


def archive_file_url(identifier):
    """The item's largest original image file; the Archive's search results do not carry one."""
    metadata = fetch_json(f"https://archive.org/metadata/{urllib.parse.quote(identifier)}")
    images = [entry for entry in metadata.get("files", [])
              if entry.get("source") == "original" and re.search(r"\.(jpe?g|png|tiff?)$", entry.get("name", ""), re.IGNORECASE)]
    if not images:
        raise SkipCandidate("the Archive item has no JPEG, PNG or TIFF original")
    largest = max(images, key=lambda entry: int(entry.get("size") or 0))
    return f"https://archive.org/download/{urllib.parse.quote(identifier)}/{urllib.parse.quote(largest['name'])}"


def search_pexels(query, limit, orientation):
    key = os.environ.get("PEXELS_API_KEY")
    if not key:
        return []
    parameters = {"query": query, "per_page": str(min(limit, 40))}
    if orientation:
        parameters["orientation"] = orientation
    data = fetch_json("https://api.pexels.com/v1/search?" + urllib.parse.urlencode(parameters), headers={"Authorization": key})
    results = []
    for photo in data.get("photos", []):
        width = photo.get("width") or 0
        file_url = photo["src"]["original"] + f"?auto=compress&cs=tinysrgb&w={min(width, 2560) or 2560}"
        results.append(candidate(
            "pexels", photo.get("alt") or f"Pexels photo {photo.get('id')}", photo.get("photographer"),
            "Pexels License", PEXELS_LICENCE_URL, photo.get("url"), file_url, photo["src"].get("medium") or file_url,
            photo.get("width"), photo.get("height")))
    return results


SEARCHERS = {"commons": search_commons, "openverse": search_openverse, "archive": search_archive, "pexels": search_pexels}


# ---------- choosing ----------

def orientation_of(width, height):
    if not width or not height:
        return None
    return "portrait" if height > width else "landscape" if width > height else "square"


def size_problem(width, height, min_width, orientation):
    """Why this size does not fit the request, or None (unknown sizes pass until the file is downloaded)."""
    if width and width < min_width:
        return f"{width} px wide, smaller than --min-width {min_width}"
    shape = orientation_of(width, height)
    if orientation and shape and shape not in (orientation, "square"):
        return f"{shape}, not {orientation}"
    return None


def title_key(title):
    return re.sub(r"[^a-z0-9]+", " ", re.sub(r"\.\w{3,4}$", "", title.lower())).strip()


def search(query, sources, count, min_width, orientation, log):
    """Candidates that pass licence and size, interleaved across sources, and the ones skipped with why."""
    per_source = {}
    for source in sources:
        if source == "pexels" and not os.environ.get("PEXELS_API_KEY"):
            continue
        try:
            per_source[source] = SEARCHERS[source](query, max(count * 4, 12), orientation)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError, SkipCandidate) as error:
            log(f"{SOURCE_NAMES[source]} search failed: {error}")
    accepted, skipped, seen_titles, seen_files = [], [], set(), set()
    # round robin across sources, so one source's near-duplicates do not fill the list
    queues = [list(per_source.get(source, [])) for source in sources]
    while any(queues):
        for queue in queues:
            if not queue:
                continue
            result = queue.pop(0)
            key = title_key(result["title"])
            if key in seen_titles or (result["file_url"] and result["file_url"] in seen_files):
                continue
            seen_titles.add(key)
            seen_files.add(result["file_url"])
            try:
                result["licence"], result["licence_url"] = classify_licence(
                    result["licence_text"], result["licence_url_given"], result["author"])
            except SkipCandidate as reason:
                skipped.append((result, str(reason)))
                continue
            problem = size_problem(result["width"], result["height"], min_width, orientation)
            if problem:
                skipped.append((result, problem))
                continue
            accepted.append(result)
    return accepted, skipped


# ---------- saving ----------

def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower().replace("'", "")).strip("-")[:48] or "image"


def next_number(assets, stem):
    numbers = [int(match.group(1)) for path in assets.glob(f"{stem}-*.jpg")
               if (match := re.fullmatch(re.escape(stem) + r"-(\d+)\.jpg", path.name))]
    return max(numbers, default=0) + 1


def download(result, destination, min_width, orientation):
    """Fetch, verify and re-encode one image as a clean JPEG; returns its (width, height)."""
    file_url = result["file_url"] or archive_file_url(result["identifier"])
    data = fetch_url(file_url)
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (OSError, Image.DecompressionBombError) as error:
        raise SkipCandidate(f"not a readable image ({error})") from error
    image = ImageOps.exif_transpose(image)
    problem = size_problem(image.width, image.height, min_width, orientation)
    if problem:
        raise SkipCandidate(problem)
    if max(image.size) > LONGEST_SIDE:
        image.thumbnail((LONGEST_SIDE, LONGEST_SIDE), Image.LANCZOS)
    if image.mode != "RGB":
        background = Image.new("RGB", image.size, (0, 0, 0))
        rgba = image.convert("RGBA")
        background.paste(rgba, mask=rgba.getchannel("A"))
        image = background
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(".part")
    image.save(partial, "JPEG", quality=90, optimize=True, progressive=True)   # no EXIF/GPS carried over
    partial.replace(destination)
    return image.width, image.height


def credit_entry(result, file, width, height):
    return {"file": file, "title": result["title"], "author": result["author"] or "unknown",
            "source": SOURCE_NAMES[result["source"]], "source_url": result["page_url"],
            "licence": result["licence"], "licence_url": result["licence_url"],
            "width": width, "height": height}


def save_candidates(work, results, stem, wanted, min_width, orientation, log):
    """Download until `wanted` images are saved; returns (saved entries, [(result, reason)] that failed)."""
    assets = work / "assets"
    saved, failed = [], []
    for result in results:
        if len(saved) >= wanted:
            break
        number = next_number(assets, stem)
        destination = assets / f"{stem}-{number:02d}.jpg"
        try:
            width, height = download(result, destination, min_width, orientation)
        except (SkipCandidate, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as reason:
            failed.append((result, str(reason)))
            continue
        saved.append(credit_entry(result, f"assets/{destination.name}", width, height))
        if result.get("people"):
            log(f"note: {destination.name} is marked as showing identifiable people; use it only for public figures")
    return saved, failed


# ---------- credits ----------

def load_credits(work):
    path = work / "credits.json"
    if not path.is_file():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("images", []) if isinstance(data, dict) else data


def credit_line(entry):
    title = f"\"{entry['title']}\""
    if entry["source"] == "Pexels":
        return f"Photo by {entry['author']} on Pexels: {entry['source_url']}"
    if entry["licence"] in ("Public domain", "CC0 1.0"):
        by = f" by {entry['author']}" if entry["author"] and entry["author"] != "unknown" else ""
        return f"{title}{by} ({entry['licence'].lower() if entry['licence'] == 'Public domain' else entry['licence']}), via {entry['source']}: {entry['source_url']}"
    return f"{title} by {entry['author']}, {entry['licence']} ({entry['licence_url']}), via {entry['source']}: {entry['source_url']}"


def write_credits(work, entries):
    """Keep entries whose file is still in assets/ (one per file, newest wins); write credits.json and .txt."""
    by_file = {}
    for entry in entries:
        if (work / entry["file"]).is_file():
            by_file[entry["file"]] = entry
    kept = sorted(by_file.values(), key=lambda entry: entry["file"])
    (work / "credits.json").write_text(json.dumps(kept, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    lines = ["Image credits:"] + [credit_line(entry) for entry in kept]
    if any(entry["licence"].startswith("CC BY") for entry in kept):
        lines.append("Images are cropped and colour-tinted.")
    (work / "credits.txt").write_text(("\n".join(lines) if kept else "") + "\n", encoding="utf-8")
    return kept


# ---------- output ----------

def print_table(saved, out):
    if not saved:
        return
    rows = [(entry["file"], f"{entry['width']}x{entry['height']}", entry["licence"],
             f"{entry['source']} · {entry['title'][:48]} · by {entry['author'][:32]}") for entry in saved]
    widths = [max(len(row[column]) for row in rows + [("file", "size", "licence", "")]) for column in range(3)]
    print(f"  {'file':<{widths[0]}}  {'size':<{widths[1]}}  {'licence':<{widths[2]}}  source", file=out)
    for row in rows:
        print(f"  {row[0]:<{widths[0]}}  {row[1]:<{widths[1]}}  {row[2]:<{widths[2]}}  {row[3]}", file=out)


def print_skipped(skipped, out, limit=8):
    if not skipped:
        return
    print(f"skipped {len(skipped)}:", file=out)
    for result, reason in skipped[:limit]:
        print(f"  - {SOURCE_NAMES[result['source']]} \"{result['title'][:50]}\": {reason}", file=out)
    if len(skipped) > limit:
        print(f"  … and {len(skipped) - limit} more", file=out)


def public(result):
    keys = ("id", "source", "title", "author", "licence", "licence_url", "page_url", "thumb_url", "width", "height", "people")
    return {key: result.get(key) for key in keys}


def save_search(work, query, results):
    (work / "media").mkdir(parents=True, exist_ok=True)
    for index, result in enumerate(results, start=1):
        result["id"] = f"c{index}"
    (work / "media" / "search.json").write_text(
        json.dumps({"query": query, "candidates": results}, indent=1, ensure_ascii=False), encoding="utf-8")


# ---------- main ----------

def parse_arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("work", type=Path)
    parser.add_argument("query", nargs="?")
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument("--orientation", choices=["portrait", "landscape"])
    parser.add_argument("--min-width", type=int, default=1080)
    parser.add_argument("--name", help="file name stem (default: the query), e.g. fries → assets/fries-01.jpg")
    parser.add_argument("--sources", default=",".join(SOURCE_ORDER))
    parser.add_argument("--search-only", action="store_true", help="list candidates, download nothing")
    parser.add_argument("--add", help="download candidates from the last search by id, e.g. c2,c5")
    parser.add_argument("--json", action="store_true", help="machine-readable output (the studio uses it)")
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    work = arguments.work.resolve()
    if not work.is_dir():
        print(f"No such work folder: {work}", file=sys.stderr)
        return 2
    sources = [source.strip() for source in arguments.sources.split(",") if source.strip()]
    unknown = [source for source in sources if source not in SEARCHERS]
    if unknown:
        print(f"Unknown source {', '.join(unknown)}; use any of {', '.join(SEARCHERS)}", file=sys.stderr)
        return 2
    human = sys.stderr if arguments.json else sys.stdout
    messages = []

    def log(message):
        messages.append(message)
        print(message, file=human)

    def finish(payload, code=0):
        if arguments.json:
            print(json.dumps({**payload, "messages": messages}, ensure_ascii=False))
        return code

    if arguments.add:
        cache_path = work / "media" / "search.json"
        if not cache_path.is_file():
            log("No search to add from: run a search first")
            return finish({"saved": []}, 1)
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
        by_id = {result["id"]: result for result in cache["candidates"]}
        wanted = [identifier.strip() for identifier in arguments.add.split(",") if identifier.strip()]
        missing = [identifier for identifier in wanted if identifier not in by_id]
        if missing:
            log(f"Not in the last search (\"{cache['query']}\"): {', '.join(missing)}")
            return finish({"saved": []}, 1)
        stem = slugify(arguments.name or cache["query"])
        saved = []
        for identifier in wanted:
            entries, failed = save_candidates(work, [by_id[identifier]], stem, 1, 0, None, log)
            saved += entries
            for result, reason in failed:
                log(f"{identifier} not saved: {reason}")
        write_credits(work, load_credits(work) + saved)
        print_table(saved, human)
        return finish({"saved": saved}, 0 if saved else 1)

    if not arguments.query:
        kept = write_credits(work, load_credits(work))
        log(f"credits.json and credits.txt list {len(kept)} image(s) in assets/")
        return finish({"credits": kept})

    if "pexels" in sources and not os.environ.get("PEXELS_API_KEY") and arguments.sources != ",".join(SOURCE_ORDER):
        log("Pexels skipped: PEXELS_API_KEY is not set (free key at https://www.pexels.com/api/)")
    accepted, skipped = search(arguments.query, sources, arguments.count, arguments.min_width, arguments.orientation, log)
    save_search(work, arguments.query, accepted)

    if arguments.search_only:
        if not arguments.json:
            for result in accepted:
                size = f"{result['width']}x{result['height']}" if result["width"] else "size ?"
                print(f"  {result['id']:<4} {size:<10} {result['licence']:<14} {SOURCE_NAMES[result['source']]} · "
                      f"{result['title'][:50]} · by {(result['author'] or 'unknown')[:30]}", file=human)
            print_skipped(skipped, human)
            print(f"{len(accepted)} candidate(s). Next: find_media.py <work> --add c1,c3 --name <stem>", file=human)
        return finish({"query": arguments.query, "candidates": [public(result) for result in accepted],
                       "skipped": [{**public(result), "reason": reason} for result, reason in skipped]})

    stem = slugify(arguments.name or arguments.query)
    saved, failed = save_candidates(work, accepted, stem, arguments.count, arguments.min_width, arguments.orientation, log)
    write_credits(work, load_credits(work) + saved)
    print_table(saved, human)
    print_skipped(skipped + failed, human)
    if not saved:
        log(f"Nothing usable for \"{arguments.query}\". Try a broader query, a lower --min-width, or no --orientation.")
        return finish({"saved": [], "skipped": [{**public(result), "reason": reason} for result, reason in skipped + failed]}, 1)
    print(f"{len(saved)} saved, credits in credits.json and credits.txt. Delete the ones you don't use, then run "
          f"find_media.py <work> to tidy the credits. Never use photos of private people.", file=human)
    return finish({"saved": saved, "skipped": [{**public(result), "reason": reason} for result, reason in skipped + failed]})


if __name__ == "__main__":
    sys.exit(main())
