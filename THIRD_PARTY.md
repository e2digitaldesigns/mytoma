# Third-party software and credits

myToma is private (all rights reserved). It installs and uses the following, each under its own licence.
None of them is committed to this repository; `setup.sh` installs them from npm.

| Component | Use | Licence |
|---|---|---|
| [GSAP](https://gsap.com) | animation timeline | GreenSock Standard "no charge" licence (free, including commercial use): https://gsap.com/standard-license |
| [Playwright](https://playwright.dev) (`playwright-core`) | drives headless Chromium | Apache-2.0 |
| [Archivo](https://github.com/Omnibus-Type/Archivo) via Fontsource | display and caption type | SIL Open Font License 1.1 |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) via Fontsource | monospace type | SIL Open Font License 1.1 |
| [FFmpeg](https://ffmpeg.org) | encoding (installed separately) | LGPL/GPL, depending on the build |

## Inspiration

The architecture (a paused GSAP timeline seeked per frame, frames streamed from Chromium into ffmpeg in
resumable chunks, helpers that push their own sound cues, a BT.709-tagged encode) follows
[Shenghua](https://github.com/Dancan254/shenghua) by Dancan254, MIT License, Copyright (c) 2026
Dancan254. myToma's code is written independently; where code is adapted from Shenghua in later steps,
the file says so and this notice covers it under the MIT terms.
