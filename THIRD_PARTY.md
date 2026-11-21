# Third-party software and credits

myToma is private (all rights reserved). It installs and uses the following, each under its own licence.
None of them is committed to this repository; `setup.sh` installs them from npm and pip.

| Component | Use | Licence |
|---|---|---|
| [GSAP](https://gsap.com) | animation timeline | GreenSock Standard "no charge" licence (free, including commercial use): https://gsap.com/standard-license |
| [Playwright](https://playwright.dev) (`playwright-core`) | drives headless Chromium | Apache-2.0 |
| [Archivo](https://github.com/Omnibus-Type/Archivo) via Fontsource | display and caption type | SIL Open Font License 1.1 |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) via Fontsource | monospace type | SIL Open Font License 1.1 |
| [D3](https://d3js.org) | chart scales, shapes, map projections | ISC |
| [TopoJSON client](https://github.com/topojson/topojson-client) | decodes the world map | ISC |
| [world-atlas](https://github.com/topojson/world-atlas) | country shapes, from [Natural Earth](https://www.naturalearthdata.com) (public domain) | ISC |
| GSAP DrawSVG, MorphSVG and MotionPath plugins | line drawing, morphs, motion along paths | GreenSock Standard "no charge" licence (as GSAP) |
| [Pillow](https://python-pillow.org) | verifies and re-encodes downloaded photos (find_media.py) | MIT-CMU (HPND) |
| [FFmpeg](https://ffmpeg.org) | encoding (installed separately) | LGPL/GPL, depending on the build |

## Photos in videos

`find_media.py` downloads photos into a video's own folder, never into this repository. It keeps only openly
licensed images (public domain, CC0, CC BY, CC BY-SA, the [Pexels licence](https://www.pexels.com/license/)) from
[Wikimedia Commons](https://commons.wikimedia.org), [Openverse](https://openverse.org), the
[Internet Archive](https://archive.org) and, with an API key, [Pexels](https://www.pexels.com), and writes each
image's credit to the video's `credits.json` and `credits.txt` for its description. Shenghua's `find_media.py`
showed which of these APIs to use; myToma's is written independently.

## Inspiration

The architecture (a paused GSAP timeline seeked per frame, frames streamed from Chromium into ffmpeg in
resumable chunks, helpers that push their own sound cues, a BT.709-tagged encode) follows
[Shenghua](https://github.com/Dancan254/shenghua) by Dancan254, MIT License, Copyright (c) 2026
Dancan254. myToma's code is written independently; where code is adapted from Shenghua in later steps,
the file says so and this notice covers it under the MIT terms.
