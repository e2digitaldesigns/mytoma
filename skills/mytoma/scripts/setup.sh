#!/usr/bin/env bash
# myToma setup: Node packages (GSAP, Playwright, fonts) and a Chromium to render with.
# Safe to re-run: it only installs what is missing, then prints `ready` or names the missing piece.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPTS"

need() { command -v "$1" >/dev/null 2>&1 || { echo "MISS  $1 → $2"; exit 1; }; }
need node   "install Node 18+ (https://nodejs.org)"
need npm    "install npm with Node"
need ffmpeg "install ffmpeg (macOS: brew install ffmpeg · Debian/Ubuntu: sudo apt install ffmpeg)"

if [ ! -f node_modules/gsap/dist/gsap.min.js ] || [ ! -d node_modules/playwright-core ]; then
  echo "installing node packages…"
  npm ci --no-audit --no-fund --loglevel=error 2>/dev/null || npm install --no-audit --no-fund --loglevel=error
fi

# Playwright's own headless Chromium gives the same pixels on every machine. Where it can't be
# downloaded (a locked-down sandbox), cli.js falls back to a system Chrome or MYTOMA_CHROME.
if ! node -e 'const p=require("playwright-core").chromium.executablePath(); process.exit(require("fs").existsSync(p)?0:1)' 2>/dev/null; then
  echo "installing Chromium for rendering (one time, ~100 MB)…"
  npx --yes playwright-core install chromium >/dev/null 2>&1 \
    || echo "note: Chromium download failed; using a system Chrome if one is installed (set MYTOMA_CHROME to choose)"
fi

# Sound: Python 3.10+ with numpy and scipy (MYTOMA_PYTHON picks another interpreter, e.g. a venv's)
PY="${MYTOMA_PYTHON:-python3}"
if ! "$PY" -c 'import sys, numpy, scipy; assert sys.version_info >= (3, 10)' 2>/dev/null; then
  echo "installing numpy + scipy for sound…"
  "$PY" -m pip install --quiet numpy scipy 2>/dev/null \
    || "$PY" -m pip install --quiet --user numpy scipy 2>/dev/null \
    || echo "note: could not install numpy/scipy. On macOS/Homebrew use a venv:
      python3 -m venv ~/.mytoma-venv && ~/.mytoma-venv/bin/pip install numpy scipy
      export MYTOMA_PYTHON=~/.mytoma-venv/bin/python"
fi

# The built-in sound library ships as files; rebuild it only if it is missing
[ -f ../sounds/library.json ] || "$PY" audio/library.py build

node cli.js doctor
