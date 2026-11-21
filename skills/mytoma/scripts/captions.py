#!/usr/bin/env python3
"""Build the burned-in captions and subtitle files from <work>/words.json.

  captions.py <work> [--max-words 3] [--max-chars 18]

Reads (all optional except words.json):
  fixes.json     {"Icon": "iCon", "that@12.40": "data", "um": ""}: a plain key fixes that token
                 everywhere; token@time fixes one word (time as printed in transcript.txt); "" drops it
  keywords.json  ["Claude", "spaghetti@14.25"]: words that stay in the accent colour once spoken

Writes:
  words.js       window.CAPTIONS = {words, phrases}: what the composition's caption layer draws
  captions.srt   subtitle lines for YouTube/TikTok uploads (longer lines than the burned-in ones)
  captions.vtt

Word times are never changed: only spelling. A fix that differs from what was said should be a
re-record, not a caption edit.
"""

import argparse
import json
import re
import sys
from pathlib import Path


def norm(token):
    return re.sub(r"[^\w'%$€£#+-]", "", token).lower()


def apply_fixes(words, fixes):
    used = set()
    out = []
    for w in words:
        key_t = f"{w['w']}@{w['s']:.2f}"
        rep = None
        for k in (key_t, w["w"], norm(w["w"])):
            if k in fixes:
                rep, used = fixes[k], used | {k}
                break
        if rep is None:
            # a plain key matches the token without its punctuation too, keeping the punctuation
            bare = re.sub(r"[.,!?;:]+$", "", w["w"])
            if bare in fixes:
                rep = fixes[bare] + w["w"][len(bare):] if fixes[bare] else ""
                used.add(bare)
        if rep == "":
            continue
        out.append(dict(w, w=rep if rep is not None else w["w"]))
    return out, [k for k in fixes if k not in used]


def mark_keywords(words, keywords):
    plain = {norm(k) for k in keywords if "@" not in k}
    timed = {k for k in keywords if "@" in k}
    for w in words:
        if norm(w["w"]) in plain or f"{norm(w['w'])}@{w['s']:.2f}" in {f"{norm(k.split('@')[0])}@{float(k.split('@')[1]):.2f}" for k in timed}:
            w["k"] = 1
    return words


JOINERS = {"and", "but", "or", "so", "because", "then", "while", "with", "when", "which", "that"}
ENDS = (".", ",", "?", "!", ";", ":")


def group(words, max_words, max_chars, gap=0.3):
    """Short phrases for burned-in captions.

    Break on punctuation and pauses; break before a joining word ("and", "but", "so" …) so it opens the
    next line instead of dangling; respect the length caps, except that a sentence's last word is never
    left alone on a line ("ice / cream." becomes "ice cream.").
    """
    out, cur = [], []
    for i, w in enumerate(words):
        cur.append(i)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if nxt is None:
            out.append(cur)
            break
        text = " ".join(words[j]["w"] for j in cur)
        hard = w["w"].endswith(ENDS) or nxt["s"] - w["e"] > gap
        full = len(cur) >= max_words or len(text) + 1 + len(nxt["w"]) > max_chars
        joiner = norm(nxt["w"]) in JOINERS
        # would breaking here strand the sentence's final word on its own line?
        strands = nxt["w"].endswith(ENDS) and (i + 2 >= len(words) or words[i + 2]["s"] - nxt["e"] > gap
                                               or nxt["w"].endswith((".", "?", "!")))
        if hard or joiner:
            out.append(cur)
            cur = []
        elif full and strands and len(cur) >= 2:
            # break one word earlier, so the last word goes down with its neighbour: "ice cream."
            out.append(cur[:-1])
            cur = cur[-1:]
        elif full and not strands:
            out.append(cur)
            cur = []
    return out


def stamp(t, sep):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("work")
    p.add_argument("--max-words", type=int, default=3)
    p.add_argument("--max-chars", type=int, default=18)
    args = p.parse_args()
    work = Path(args.work)
    src = work / "words.json"
    if not src.exists():
        sys.exit(f"{src} missing: transcribe (and trim) the take first")
    words = json.loads(src.read_text())
    fixes = json.loads((work / "fixes.json").read_text()) if (work / "fixes.json").exists() else {}
    keywords = json.loads((work / "keywords.json").read_text()) if (work / "keywords.json").exists() else []

    words, unused = apply_fixes(words, fixes)
    words = mark_keywords([{"w": w["w"], "s": w["s"], "e": w["e"]} for w in words], keywords)
    short = group(words, args.max_words, args.max_chars)
    phrases = [{"a": ph[0], "b": ph[-1] + 1, "s": words[ph[0]]["s"], "e": words[ph[-1]]["e"]} for ph in short]
    (work / "words.js").write_text("window.CAPTIONS = " + json.dumps({"words": words, "phrases": phrases}) + ";\n")

    # subtitles: longer lines (≤ 7 words / 42 chars), each held until the next starts (max +1.5 s)
    subs = group(words, 7, 42, gap=0.6)
    srt, vtt = [], ["WEBVTT", ""]
    for n, ph in enumerate(subs):
        s = words[ph[0]]["s"]
        nxt = words[subs[n + 1][0]]["s"] if n + 1 < len(subs) else None
        e = min(words[ph[-1]]["e"] + 1.5, nxt - 0.02) if nxt else words[ph[-1]]["e"] + 1.0
        text = " ".join(words[j]["w"] for j in ph)
        srt += [str(n + 1), f"{stamp(s, ',')} --> {stamp(e, ',')}", text, ""]
        vtt += [f"{stamp(s, '.')} --> {stamp(e, '.')}", text, ""]
    (work / "captions.srt").write_text("\n".join(srt))
    (work / "captions.vtt").write_text("\n".join(vtt))

    print(f"{len(words)} words · {len(phrases)} caption phrases · {len(subs)} subtitle lines · "
          f"{sum(1 for w in words if w.get('k'))} keyword(s)")
    for k in unused:
        print(f"warning: fixes.json key {k!r} matched no word")
    print("→ words.js · captions.srt · captions.vtt")


if __name__ == "__main__":
    main()
