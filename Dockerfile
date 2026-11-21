# myToma studio: the editor UI plus everything the skill runs (Node, Chromium, Python, ffmpeg).
#   docker compose up -d --build            (see ui/README.md; GPU: add -f docker-compose.gpu.yml)
FROM node:22-bookworm-slim

ARG GPU=0
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Python: sound and transcription. With GPU=1, the CUDA libraries faster-whisper needs on an Nvidia card.
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir numpy scipy faster-whisper \
 && if [ "$GPU" = "1" ]; then /opt/venv/bin/pip install --no-cache-dir nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"; fi
ENV MYTOMA_PYTHON=/opt/venv/bin/python \
    LD_LIBRARY_PATH=/opt/venv/lib/python3.11/site-packages/nvidia/cublas/lib:/opt/venv/lib/python3.11/site-packages/nvidia/cudnn/lib

WORKDIR /app

# the skill's Node side, and the Chromium it renders with (plus that Chromium's system libraries)
COPY skills/mytoma/scripts/package.json skills/mytoma/scripts/package-lock.json skills/mytoma/scripts/
RUN cd skills/mytoma/scripts \
 && npm ci --no-audit --no-fund \
 && npx playwright-core install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY ui/package.json ui/package-lock.json ui/
RUN cd ui && npm ci --no-audit --no-fund

COPY skills skills
COPY ui ui
RUN cd ui && npm run build && npm prune --omit=dev

# projects and the speech-model cache live on volumes; run as the unprivileged node user
RUN mkdir -p /data/projects /data/models && chown -R node:node /data
USER node

ENV MYTOMA_HOST=0.0.0.0 \
    MYTOMA_PORT=4173 \
    MYTOMA_PROJECTS=/data/projects \
    MYTOMA_MEDIA=/media \
    HF_HOME=/data/models \
    MYTOMA_CHROME_ARGS=--no-sandbox

EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4173/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "ui/server/index.js"]
