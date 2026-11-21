---
name: mytoma
description: "Build animated, brand-styled videos as HTML/GSAP compositions rendered frame by frame in headless Chromium and encoded with ffmpeg. Use when asked to make or edit a video with myToma, animate a script or narration, or render a composition to mp4. (Step 1 of the build: the render engine. Talking-head editing, captions, sound and the full workflow arrive in later steps.)"
compatibility: "Requires Node 18+ and ffmpeg on macOS or Linux (WSL on Windows). setup.sh installs GSAP, Playwright, fonts and Chromium."
---

# myToma

Every shot is an HTML scene on one paused GSAP timeline. `renderAt(t)` seeks it to an exact time; the
renderer screenshots each frame and pipes it into ffmpeg. The same composition always renders the
same video.

`SKILL_DIR` = the directory containing this SKILL.md. Commands run from `SKILL_DIR/scripts`.

## 1. Setup (first run)

```bash
bash SKILL_DIR/scripts/setup.sh
```

Prints `ready`, or names what is missing and how to fix it. `node cli.js doctor` re-checks any time.

## 2. Start a composition

```bash
node SKILL_DIR/scripts/cli.js new <work> --format vertical --duration <seconds>
# --format vertical 1080x1920 (default) · landscape 1920x1080 · square 1080x1080 · portrait 1080x1350
```

Writes `<work>/index.html` (a demo you replace) and copies the engine, theme, GSAP and fonts into
`<work>/vendor/`. Re-running without `--force` keeps your shots and changes only size and duration.

## 3. Author the shots

Replace the markup between `BEGIN SHOTS`/`END SHOTS` and the code between `BEGIN TIMELINE`/`END TIMELINE`.
Each shot is a `<section class="shot" id="sNN">`; times are seconds of the final video.

| Helper | Does | Sound cue |
|---|---|---|
| `shot(id, in, out, enter)` | shows the shot for [in, out); enter `cut` `fade` `whip` `whipUp` `slide` `zoom` `flash` | whoosh on whip/slide/zoom |
| `slam(sel, t, power)` | headline slams in, shake + flash | hit |
| `pop(sel, t)` · `stagger(sel, t, gap)` | scale-in, one per element | pop each |
| `rise(sel, t)` · `fadeIn(sel, t)` | soft entries | none |
| `stamp(sel, t)` | rubber stamp (`.stamp`) | stamp |
| `highlight(sel, t)` | box sweeps behind text (`.hl`) | soft whoosh |
| `strike(sel, t)` | strike-through (`.strike`) | hit 0.6 |
| `typer(sel, text, s, e)` | text types across [s, e) | type |
| `counter(sel, from, to, s, e, opts)` | number counts up | tick |
| `kenBurns` `drift` `punchIn` | slow camera moves on a held element | none |
| `hit(t, power)` · `shake(t, power)` | impact on a beat | hit · none |
| `riser(s, e)` · `down(s, e)` | sound only | riser · down |

Anything else: `tl.fromTo(...)` at a time, or `addDrawer(t => …)` for content drawn from `t` (canvas,
Three.js, Lottie). Colours always come from `var(--brand-*)` tokens.

## 4. Check, look, render

```bash
node SKILL_DIR/scripts/cli.js check  <work>                 # text off-frame or in the safe margin, empty shots, page errors
node SKILL_DIR/scripts/cli.js stills <work> 0.8,3.1,5.6     # no spaces; writes stills/ and contact.jpg
node SKILL_DIR/scripts/cli.js render <work> --draft         # fast preview
node SKILL_DIR/scripts/cli.js render <work>                 # final: 2x supersampled, lossless frames, CRF 16, BT.709
node SKILL_DIR/scripts/cli.js cues   <work>                 # the sound cues the timeline pushed → cues.json
```

Fix every `check` finding and look at `contact.jpg` before a final render. A killed render resumes from
its finished chunks; editing the composition starts a fresh render automatically. Verify the result
from the encoded file, not a still:

```bash
ffmpeg -v error -y -ss <t> -i <work>/out/<name>.mp4 -frames:v 1 -vf scale=360:-1 <work>/verify.jpg
```

## Non-negotiables

- Every frame is a pure function of `t`: no `Math.random()` (use `MT.rand(key)`), no `Date.now()`, no
  CSS animations or transitions, no `<video>` or `.gif` elements, no `will-change` or 3D transforms.
- Every helper that makes a sound pushes its cue; a plug-in that makes noise calls `cue(t, type)`.
- Colours come from `--brand-*` tokens, never hex values in shots.
- `check` is clean and the contact sheet has been looked at before a final render.
