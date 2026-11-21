# myToma

An agent skill that turns a talking-head take, a voice note or a script into an animated, brand-styled video.

Every shot is an HTML scene on one paused GSAP timeline. Headless Chromium seeks that timeline to each
frame's exact time, screenshots it, and pipes the frames into ffmpeg, so the same composition always
renders the same video.

Private repository. All rights reserved.

## Quickstart

```bash
cd skills/mytoma/scripts
bash setup.sh                                   # GSAP, Playwright, fonts, Chromium → prints "ready"
node cli.js new ~/mytoma/demo                   # a 10-second demo composition
node cli.js check ~/mytoma/demo                 # layout and page-error check
node cli.js stills ~/mytoma/demo 1.6,3.6,6.6,9.6  # stills + contact.jpg
node cli.js sound ~/mytoma/demo --drop 9.3      # soundtrack from the timeline's cues → audio/mix.wav
node cli.js render ~/mytoma/demo --draft        # fast preview (muxes the soundtrack)
node cli.js render ~/mytoma/demo                # final: 2x supersampled, CRF 16, BT.709
$MYTOMA_PYTHON find_media.py ~/mytoma/demo "potato chips" --count 3   # openly licensed photos → assets/, credits.txt
npm test                                        # engine, sound and mixer tests
python3 audio/library.py preview ~/reel.wav     # every sound in the library, to listen to
```

On a machine with an Nvidia GPU, `MYTOMA_CHROME_ARGS="--enable-gpu --use-angle=vulkan"` lets Chromium
render WebGL plug-ins on the GPU (step 6).

Install as a Claude Code plugin (needs `gh`/git signed in to an account with access to this repo):

```
/plugin marketplace add e2digitaldesigns/mytoma
/plugin install mytoma@mytoma
```

## Status

Built in steps, one pull request each:

1. Render engine: template, `renderAt(t)`, helpers, Playwright → ffmpeg ✅
2. Sound: cue extraction, bundled sound library, mix ✅
3. Talking-head workflow: transcription, trim, word-timed captions, face shots ✅
4. The skill layer: `SKILL.md`, block catalogue, worked example
5. Claude app compatibility
6. Generated voice, Three.js / Lottie blocks, content profiles

**myToma studio** (`ui/`): a browser editor around the skill, laid out like a desktop video editor. Upload or
pick a take, run the pipeline, fix the transcript, mark graphics stretches and chapters, preview live, render.
Runs directly or in Docker; see [ui/README.md](ui/README.md).

**Photos**: `find_media.py` finds openly licensed photos (Wikimedia Commons, Openverse, Internet Archive, Pexels
with a key) and writes the credits; `photo()` puts one behind a shot with a Ken Burns move and a brand tint, and
`check` holds text over it to WCAG AA. The studio has a Find images tab.

Done ahead of schedule: **infographics** (D3 + GSAP): bar, line, donut, map and timeline helpers.
`node cli.js new ~/mytoma/charts --example infographics` starts from a demo of all five.
