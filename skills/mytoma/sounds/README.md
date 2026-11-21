# myToma sound library

Real audio files, described by `library.json`. Every sound in a video comes from here.

## What's in it

The built-in entries are myToma's own sounds, designed in code (`scripts/audio/recipes.py`) and baked to
`.ogg` once. They are owned by this project, so they can live in the repo and be shared.

| Category | Entries | For |
|---|---|---|
| `impact` | `punch` `heavy` `stamp` `soft` | slams and emphasis · cinematic reveals · stamps · quiet beats |
| `whoosh` | `fast` `slow` | cuts and whips · fades and reveals |
| `riser` / `down` | `riser.tension` `riser.short` `down.drop` | builds that stop dead on a reveal · a let-down |
| `ui` | `pop` `tick` `ding` `error` `click` | items appearing · counters · right · wrong · toggles |
| `foley` | `key` `typewriter` `shutter` `paper` | typing (modern / archival) · a photo landing · a document |
| `texture` | `projector` `crackle` | loops under archival footage |
| `bed` | `drone` `heartbeat` | loops under tense stretches |

`python3 scripts/audio/library.py list` shows every entry with its tags. `library.py preview reel.wav`
renders them all into one file to listen to.

## How a cue finds its sound

The engine's helpers push cue types (`hit`, `whoosh`, `type`, …). The `cues` block in `library.json` maps
each type to an entry, e.g. `"hit": "impact.punch"`. A composition can also name an entry directly:

```js
sfx(4.2, "impact.heavy");             // a one-shot
bed(0, 12, "texture.projector");      // a loop across a stretch
typer("#date", "1921", 6.0, 6.8);     // pushes "type"; remap it per video with --map type=foley.typewriter
```

When an entry has several files, they play in a fixed rotation, so repeats vary and every render sounds
the same.

## Adding your own recordings

```bash
python3 scripts/audio/library.py add ~/Recordings/door-slam.wav --id impact.heavy --licence own
python3 scripts/audio/library.py add ~/Downloads/whoosh.wav --id whoosh.fast --licence CC0 --credit "Name, freesound.org/s/123"
python3 scripts/audio/library.py add ~/Recordings/rain.wav --id texture.rain --kind loop --licence own --tags texture,weather
```

`add` trims silence, converts to 48 kHz, and matches the entry's peak level so a swap doesn't change the
mix. A recording **replaces** an entry's synthesized variants; adding more recordings to the same id adds
variants. A new id creates a new entry.

**Only redistributable sounds go here**: `own`, `CC0`, or `CC-BY`/`CC-BY-SA` with `--credit`. Most
commercial "royalty-free" packs let you use sounds in videos but not share the files. Keep those outside
the repo.

`library.py check` confirms every file exists and every entry has a licence. `library.py build`
re-bakes the recipes and leaves your recordings alone.

## Phones

Most Shorts are heard on phone speakers, which play almost nothing below ~150 Hz. The impacts carry a
150–800 Hz body so they still land there. The `bed.drone` and `bed.heartbeat` loops are deliberately
sub-heavy and sit quieter on phones. Listen on a phone before posting.
