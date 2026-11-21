---
name: mytoma
description: "Build animated, brand-styled videos as HTML/GSAP compositions rendered frame by frame in headless Chromium, with a soundtrack built from the timeline's own sound cues, and encoded with ffmpeg. Use when asked to make or edit a video with myToma, animate a script or narration, or render a composition to mp4. Edits talking-head takes: local word-level transcription, trimmed dead air, word-timed captions, face shots at the open and close with animated shots between, the voice mixed with ducked music."
compatibility: "Requires Node 18+, Python 3.10+ with numpy, scipy and faster-whisper, and ffmpeg on macOS or Linux (WSL on Windows). setup.sh installs GSAP, Playwright, fonts, Chromium and the Python packages; the first transcription downloads the speech model once."
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

## 2. From a recorded take (talking head, voice note)

Skip this section when there is no recording. `<work>` is a new folder per video; every time after
the trim is an edit time.

```bash
python3 SKILL_DIR/scripts/audio/transcribe.py <take.mp4> --outdir <work> --vocab "names, terms, the speaker's name"
python3 SKILL_DIR/scripts/take.py trim <take.mp4> <work>          # cuts dead air → voice.wav, take.json
```

Transcription runs locally (roughly 3-4x realtime on a CPU, far faster on an Nvidia GPU; tell the
user the estimate first). `--vocab` spells names right at the source. Read `transcript.txt`: one
phrase per line, every word with its start time. `trim` warns about HDR recordings (face shots wash
out: ask for an SDR re-record) and variable frame rates (resampled to 30 fps, nothing to do).

**Proofread before anything else.** Misheard names and terms go in `<work>/fixes.json`
(`{"Icon": "iCon", "that@12.40": "data", "um": ""}`: a plain key fixes every occurrence, `word@time`
one word, `""` drops it). Words the video is about go in `<work>/keywords.json` (`["Claude",
"spaghetti"]`): they stay in the accent colour once said. Then:

```bash
python3 SKILL_DIR/scripts/captions.py <work>                       # words.js + captions.srt/.vtt
```

Never change a word's meaning in fixes.json; tell the user about anything you could not resolve.

**Plan the shots on the word times** (step 4). With a video take, the opening line and the sign-off
stay on camera as face shots; the lines between are animated. Numbers the speaker says can become
charts (Infographics); never put numbers on screen that were not said or sourced.

```bash
node SKILL_DIR/scripts/cli.js new <work> --duration <take.json duration>
python3 SKILL_DIR/scripts/take.py face <work> 0-3.5,19.25-20.1     # the face-shot ranges, edit seconds
```

A face shot is `<section class="shot bleed" id="s01"><img class="face" id="face1"></section>` with
`faceCam("#face1", a, b)` over the same range as `take.py face` (and `punchIn` for a slow push). Put
a name on it with `<span class="tag">`. Captions draw themselves from words.js; call `nocap(a, b)`
over shots whose on-screen words already say the line. Mix with the voice:
`cli.js sound <work> --voice <work>/voice.wav`.

Show the user the shot list (time, line, what it shows) before authoring. Ask them to watch the
result for lip sync and to listen to the mix: you can check neither by eye or ear.

## 3. Start a composition

```bash
node SKILL_DIR/scripts/cli.js new <work> --format vertical --duration <seconds>
# --format vertical 1080x1920 (default) · landscape 1920x1080 · square 1080x1080 · portrait 1080x1350
```

Writes `<work>/index.html` (a demo you replace) and copies the engine, theme, GSAP and fonts into
`<work>/vendor/`. Re-running without `--force` keeps your shots and changes only size and duration.

## 4. Author the shots

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
| `faceCam(img, a, b)` · `nocap(a, b)` | the speaker's frames for [a, b) (from `take.py face`) · no captions over [a, b) | none |
| `hit(t, power)` · `shake(t, power)` | impact on a beat | hit · none |
| `riser(s, e)` · `down(s, e)` | sound only | riser · down |
| `sfx(t, entry, opts)` | any library sound by id, e.g. `sfx(4.2, "impact.heavy")` | that entry |
| `bed(s, e, entry)` | a loop across [s, e), e.g. `bed(0, 12, "texture.projector")` | that loop |

Anything else: `tl.fromTo(...)` at a time, or `addDrawer(t => …)` for content drawn from `t` (canvas,
Three.js, Lottie). Colours always come from `var(--brand-*)` tokens.

### Infographics

Charts are D3-built SVG animated on the same timeline. Give each a container with a CSS size
(`<div class="chart" id="bars" style="height:820px"></div>`); the graphic fills it.

| Helper | Does | Sound cues |
|---|---|---|
| `barChart(sel, [{label, value}], t, {highlight, gap, prefix, suffix, decimals, sort})` | horizontal bars grow in turn, values count up | pop per bar |
| `lineChart(sel, [{x, y}], s, e, {annotate: [{x, text}], suffix, min, max, ticks})` | line draws across [s, e), a dot rides the tip, annotations land as the tip reaches them | slow whoosh, pop per annotation |
| `donut(sel, [{label, value}], s, {center: "62%", seg})` | segments sweep in turn, centre value counts up | pop per segment |
| `mapReveal(sel, s, {borders, focus: {names, at, dur}, highlight: [{name, at}], route: {points, at, dur}, pins: [{lonlat, text, at}], detail, center})` | world borders draw on, the camera flies to the focus countries, countries light up, a great-circle route traces, pins drop | slow whooshes, soft impact per country, pops |
| `timeline(sel, [{date, text}], s, {gap})` | an axis draws, each date types itself in and its label rises | typewriter per date |

Country names are Natural Earth's (`"United States of America"`, `"United Kingdom"`); an unknown name
fails loudly. Maps fill a tall frame's height (cover) and focus on each country's mainland; `detail:
"50m"` gives finer borders for close zooms. Each helper returns the time it finishes. Start from
`node cli.js new <work> --example infographics` to see all five.

Never put invented numbers on screen as fact: data shown must come from the script or a cited source,
and sample data says so on screen.

## 5. Sound

Every helper above pushes its own cue; `SKILL_DIR/sounds/library.json` maps each cue type to a sound in
the bundled library (`python3 SKILL_DIR/scripts/audio/library.py list` shows them with tags). Pick
entries by mood: `impact.heavy` for a reveal or a dark turn, `foley.typewriter` for archival dates and
names, `foley.shutter` when a photo lands, `texture.projector` / `texture.crackle` under old footage,
`bed.drone` / `bed.heartbeat` under tension. One heavy impact per video, at most two.

```bash
node SKILL_DIR/scripts/cli.js sound <work> [--music synth|none|<file>|bed.drone] [--voice <file>] \
     [--drop <time of the final hit>] [--map hit=impact.heavy,type=foley.typewriter]
```

Writes `<work>/audio/mix.wav` at -14 LUFS / -2 dBTP: voice, a music bed ducked under it (it swells back
in pauses), and every cue placed. `--drop` clears the music for the half second before the final hit.
Unknown cues are listed, not fatal. `render` muxes the mix, and re-runs it with the same options if
the cues changed since. **You cannot hear the result: say so and ask the user to listen.**

## 6. Check, look, render

```bash
node SKILL_DIR/scripts/cli.js check  <work>                 # text off-frame or in the safe margin, empty shots, page errors
node SKILL_DIR/scripts/cli.js stills <work> 0.8,3.1,5.6     # no spaces; writes stills/ and contact.jpg
node SKILL_DIR/scripts/cli.js render <work> --draft         # fast preview
node SKILL_DIR/scripts/cli.js render <work>                 # final: 2x supersampled, lossless frames, CRF 16, BT.709
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
- Every helper that makes a sound pushes its cue; a plug-in that makes noise calls `sfx(t, entry)`.
- Sounds in the library are redistributable only: `own`, `CC0` or `CC-BY` with credit
  (`library.py add … --licence`). Never add files from packs that forbid sharing them.
- Colours come from `--brand-*` tokens, never hex values in shots.
- `check` is clean and the contact sheet has been looked at before a final render.
