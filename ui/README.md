# myToma studio

A browser editor around the myToma skill, laid out like a desktop video editor: project and pipeline on the
left, the live preview in the middle, properties on the right, a timeline with tracks along the bottom.

The studio is the kitchen; Claude is the chef. The studio uploads, transcribes, trims, captions, previews,
mixes and renders. Claude plans the shots and writes the animation (the Claude tab hands it the job in one
message). When Claude saves the timeline, the preview reloads by itself.

## What you can do in it

- **Bring in a recording:** drop it on the Media tab, or pick it from the recordings folder by path (best for
  big 4K takes: nothing is copied).
- **Run the pipeline:** transcribe, trim and caption · face frames · check · mix sound · render draft · render.
  One job at a time, with a live log and progress.
- **Fix the transcript:** click a word to jump there; select one to fix its spelling (here or everywhere) or
  make it a keyword. Captions rebuild on save.
- **Mark stretches:** drag on the Graphics track, select words in the transcript, or type start/end times in
  the inspector. Each stretch is **No graphics** (only you), **Limited** (you stay on screen with light touches)
  or **Full**, with its own subtitles checkbox. `check` enforces them.
- **Mark chapters:** the same three ways, each with a title. Show the name, a progress bar split into
  chapters, or both, at the top or bottom (automatic: top for vertical, bottom for landscape).
- **Preview live:** play, scrub, step frame by frame (← →, Shift for 1 s, Space to play), with an optional
  overlay of YouTube Shorts / TikTok / YouTube's own buttons.
- **Watch and download renders**, and the `.srt` / `.vtt` subtitles.

## Run it directly

```bash
cd ui
npm install
npm run build
MYTOMA_MEDIA=~/Videos npm start          # http://127.0.0.1:4173
```

The skill must be set up first (`bash skills/mytoma/scripts/setup.sh`).

| Variable | Default | |
|---|---|---|
| `MYTOMA_PROJECTS` | `~/mytoma/projects` | one folder per video |
| `MYTOMA_MEDIA` | your home folder | folders recordings may be picked from, comma-separated |
| `MYTOMA_PASSWORD` | none | **set it whenever other machines can reach the studio** |
| `MYTOMA_HOST` / `MYTOMA_PORT` | `127.0.0.1` / `4173` | your Tailscale IP to reach it from other devices |
| `MYTOMA_SKILL` | `../skills/mytoma` | |
| `MYTOMA_WHISPER_MODEL` | `small` | any faster-whisper model name or folder |

Developing the UI: `npm start` in one terminal, `npm run dev` in another (Vite on :5173, proxying the API).

## Run it in Docker

```bash
cp .env.example .env        # at the repo root: password, projects folder, recordings folder, bind address
docker compose up -d --build
# with the Nvidia GPU for transcription (NVIDIA Container Toolkit / Docker Desktop on WSL2):
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

- **Projects are a normal folder on your computer** (`MYTOMA_PROJECTS_DIR`), mounted into the container, so
  Claude, running on the computer, edits them directly. The studio tells Claude that path.
- **Recordings are mounted read-only** (`MYTOMA_RECORDINGS`): pick takes by path, nothing copied.
- **Reach it from your other computers over Tailscale:** set `MYTOMA_BIND` to the PC's Tailscale address
  (`tailscale ip -4`) and open `http://<that address>:4173` from the laptop or phone. Don't forward the port
  on your router. The password is required.
- The speech model downloads once into a Docker volume.

**Ollama on the same GPU:** a loaded Ollama model takes most of the card's memory. Transcribe when Ollama
isn't running, or stop it first (`ollama stop <model>`); transcription can also run on the CPU (Model: base or
small) at a few times realtime.

## Tests

```bash
cd ui && npm test          # the API, against a real server with temporary folders
```
