#!/usr/bin/env node
"use strict";
/*
 * myToma command line. Every command takes a work folder holding index.html (made by `new`).
 *
 *   node cli.js new     <work> [--format vertical|landscape|square|portrait] [--duration 10] [--fps 30] [--force]
 *   node cli.js check   <work>                       layout problems, page errors; exit 1 on findings
 *   node cli.js stills  <work> <t,t,t> [--scale 1]   one JPEG per time into <work>/stills/, plus contact.jpg
 *   node cli.js cues    <work>                       sound cues the timeline pushed → <work>/cues.json
 *   node cli.js render  <work> [--draft] [--workers N] [--chunk 10] [--out file.mp4]
 *   node cli.js doctor                               Chromium, ffmpeg and Node, with the fix for anything missing
 *
 * render streams frames from Chromium straight into ffmpeg in chunks (no frames on disk), encodes each
 * chunk in parallel, and joins them. A killed render resumes: finished chunks are kept, keyed by a hash of
 * the composition, so any edit to it starts fresh automatically.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { launch, openComposition, findChrome, capture } = require("./lib/browser");

const SKILL_DIR = path.resolve(__dirname, "..");
const TEMPLATE_DIR = path.join(SKILL_DIR, "template");
const MODULES = path.join(__dirname, "node_modules");
const FORMATS = { vertical: [1080, 1920], landscape: [1920, 1080], square: [1080, 1080], portrait: [1080, 1350] };

/* ---------- args ---------- */

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opt[key] = true;
      else { opt[key] = next; i++; }
    } else pos.push(a);
  }
  return { pos, opt };
}
function die(msg, code = 2) { console.error(msg); process.exit(code); }
function workPaths(work) {
  if (!work) die("Missing <work> folder");
  const dir = path.resolve(work);
  return { dir, html: path.join(dir, "index.html") };
}
function num(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) die(`--${name} must be a positive number, got: ${v}`);
  return n;
}
function fmtTime(s) { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; }

/* ---------- new ---------- */

const VENDOR_FILES = [
  [path.join(TEMPLATE_DIR, "engine.js"), "engine.js"],
  [path.join(TEMPLATE_DIR, "theme.css"), "theme.css"],
  [path.join(MODULES, "gsap/dist/gsap.min.js"), "gsap.min.js"],
  [path.join(MODULES, "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2"), "fonts/archivo-wdth.woff2"],
  [path.join(MODULES, "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2"), "fonts/jetbrains-mono-400.woff2"],
  [path.join(MODULES, "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2"), "fonts/jetbrains-mono-700.woff2"],
];

// vendor/ holds copies, not links, so a work folder survives skill updates and moves between machines.
function installVendor(dir) {
  const missing = VENDOR_FILES.filter(([src]) => !fs.existsSync(src));
  if (missing.length) die(`Missing ${missing.map(([s]) => path.relative(SKILL_DIR, s)).join(", ")}\nRun scripts/setup.sh first.`);
  for (const [src, rel] of VENDOR_FILES) {
    const dest = path.join(dir, "vendor", rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function cmdNew(pos, opt) {
  const { dir, html } = workPaths(pos[0]);
  const format = opt.format || "vertical";
  if (!FORMATS[format]) die(`--format must be one of ${Object.keys(FORMATS).join(", ")}`);
  const [width, height] = FORMATS[format];
  const fps = opt.fps ? num(opt.fps, "fps") : 30;
  const duration = Math.ceil(num(opt.duration || 10, "duration") * fps) / fps;   // whole frames
  const comp = { width, height, fps, duration: Number(duration.toFixed(4)), seed: 1 };
  fs.mkdirSync(dir, { recursive: true });

  const block = `window.COMP = ${JSON.stringify(comp)};`;
  let text;
  if (fs.existsSync(html) && !opt.force) {
    // Keep authored shots and timeline; rewrite only the COMP line
    text = fs.readFileSync(html, "utf8").replace(/window\.COMP\s*=\s*\{.*?\};/s, block);
    console.log(`kept your shots and timeline; updated ${format} ${width}x${height}, ${comp.duration}s`);
  } else {
    text = fs.readFileSync(path.join(TEMPLATE_DIR, "index.html"), "utf8").replace(/window\.COMP\s*=\s*\{.*?\};/s, block);
    console.log(`new composition (demo shots) · ${format} ${width}x${height} · ${comp.duration}s @ ${fps} fps`);
  }
  fs.writeFileSync(html, text);
  installVendor(dir);
  console.log(`${html}\nNext: author shots between BEGIN/END SHOTS and BEGIN/END TIMELINE, then: node cli.js check ${pos[0]}`);
}

/* ---------- check ---------- */

async function cmdCheck(pos) {
  const { html } = workPaths(pos[0]);
  const browser = await launch();
  try {
    const { page, info, warnings } = await openComposition(browser, html);
    const issues = [];
    for (const s of info.shots) {
      for (const k of [0.25, 0.5, 0.85]) {
        const t = s.s + (s.e - s.s) * k;
        issues.push(...(await page.evaluate((t) => window.MT.check(t), t)));
      }
    }
    const unique = [...new Set(issues.map((i) => i.replace(/ @[\d.]+s:/, ":")))];
    warnings.forEach((w) => console.log("warn  " + w));
    if (unique.length) {
      unique.forEach((i) => console.log("FAIL  " + i));
      console.log(`${unique.length} finding(s) across ${info.shots.length} shots`);
      process.exitCode = 1;
    } else {
      console.log(`clean · ${info.shots.length} shots · ${info.width}x${info.height} · ${info.duration}s\nNext: node cli.js stills ${pos[0]} <one time per shot>`);
    }
  } finally { await browser.close(); }
}

/* ---------- stills + contact sheet ---------- */

async function cmdStills(pos, opt) {
  const { dir, html } = workPaths(pos[0]);
  if (!pos[1]) die("stills needs a comma-separated list of times, e.g. 0.8,3.2,6.1");
  const times = pos[1].split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (times.some((t) => !Number.isFinite(t))) die(`Bad times (no spaces between commas?): ${pos[1]}`);
  const scale = opt.scale ? num(opt.scale, "scale") : 1;
  const out = path.join(dir, "stills");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const browser = await launch();
  try {
    const { page } = await openComposition(browser, html, { scale });
    const cdp = await page.context().newCDPSession(page);
    const index = [];
    for (const [i, t] of times.entries()) {
      await page.evaluate((t) => window.renderAt(t), t);
      const file = path.join(out, `${String(i + 1).padStart(3, "0")}.jpg`);
      fs.writeFileSync(file, await capture(page, cdp, { format: "jpeg", quality: 90 }));
      index.push({ file: path.basename(file), t });
    }
    fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 1));
  } finally { await browser.close(); }
  const cols = Math.min(times.length, Number(opt.cols) || 4);
  const rows = Math.ceil(times.length / cols);
  const sheet = path.join(dir, "contact.jpg");
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-framerate", "1", "-i", path.join(out, "%03d.jpg"),
    "-vf", `scale=360:-2,tile=${cols}x${rows}:padding=10:color=0x202020`, "-frames:v", "1", sheet], { stdio: "inherit" });
  if (r.status !== 0) die("ffmpeg failed to build the contact sheet");
  console.log(`${times.length} stills → ${path.relative(process.cwd(), out)}/ · contact sheet → ${path.relative(process.cwd(), sheet)}`);
}

/* ---------- cues ---------- */

async function cmdCues(pos) {
  const { dir, html } = workPaths(pos[0]);
  const browser = await launch();
  try {
    const { page } = await openComposition(browser, html);
    const cues = await page.evaluate(() => window.SFX);
    fs.writeFileSync(path.join(dir, "cues.json"), JSON.stringify(cues, null, 1));
    const counts = cues.reduce((m, c) => ((m[c.type] = (m[c.type] || 0) + 1), m), {});
    console.log(`${cues.length} sound cues → cues.json · ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  } finally { await browser.close(); }
}

/* ---------- render ---------- */

function compositionHash(dir, quality) {
  const h = crypto.createHash("sha256");
  const files = [path.join(dir, "index.html")];
  const walk = (d) => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  });
  for (const sub of ["vendor", "assets", "clips"]) walk(path.join(dir, sub));
  for (const f of files.sort()) { h.update(path.relative(dir, f)); h.update(fs.readFileSync(f)); }
  h.update(JSON.stringify(quality));
  return h.digest("hex").slice(0, 12);
}

function encodeArgs(info, q, input, output) {
  const { width: W, height: H, fps } = info;
  // Bitrate cap scales with the canvas: 16 Mbps at 1080x1920
  const capMbps = Math.round(16 * (W * H) / (1080 * 1920));
  const color = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];
  return [
    "-v", "error", "-y",
    "-f", "image2pipe", "-framerate", String(fps), "-c:v", q.format === "png" ? "png" : "mjpeg", "-i", input,
    "-vf", `scale=${W}:${H}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
    "-c:v", "libx264", "-preset", process.env.MYTOMA_PRESET || q.preset, "-crf", String(q.crf),
    "-maxrate", `${capMbps}M`, "-bufsize", `${capMbps * 2}M`,
    "-g", String(fps * 2), "-pix_fmt", "yuv420p", ...color, "-an", "-f", "mp4", output,
  ];
}

function countFrames(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file], { encoding: "utf8" });
  return parseInt(String(r.stdout).replace(/[^\d]/g, ""), 10) || 0;
}

async function renderChunk(page, cdp, info, q, chunk) {
  const ff = spawn("ffmpeg", encodeArgs(info, q, "-", chunk.part), { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  ff.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => ff.on("close", resolve));
  const write = (buf) => new Promise((resolve, reject) => {
    if (ff.stdin.destroyed) return reject(new Error("ffmpeg exited early:\n" + stderr));
    ff.stdin.write(buf, (err) => (err ? reject(new Error("ffmpeg pipe closed:\n" + stderr)) : resolve()));
  });
  for (let f = chunk.from; f < chunk.to; f++) {
    await page.evaluate((t) => window.renderAt(t), f / info.fps);
    await write(await capture(page, cdp, { format: q.format, quality: 92 }));
  }
  ff.stdin.end();
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg failed on frames ${chunk.from}-${chunk.to - 1}:\n${stderr}`);
  const got = countFrames(chunk.part);
  if (got !== chunk.to - chunk.from) throw new Error(`chunk ${chunk.from}-${chunk.to - 1}: expected ${chunk.to - chunk.from} frames, encoded ${got}`);
  fs.renameSync(chunk.part, chunk.file);   // a chunk exists only once it is complete
}

async function cmdRender(pos, opt) {
  const { dir, html } = workPaths(pos[0]);
  const draft = !!opt.draft || process.env.MYTOMA_QUALITY === "draft";
  // Final: 2x supersampled lossless PNG frames, CRF 16. Draft: 1x JPEG, fast preset.
  const q = draft ? { name: "draft", scale: 1, format: "jpeg", preset: "veryfast", crf: 20 }
                  : { name: "final", scale: opt.scale ? num(opt.scale, "scale") : 2, format: "png", preset: "slow", crf: 16 };
  const chunkSec = opt.chunk ? num(opt.chunk, "chunk") : 10;
  const workers = Math.max(1, Math.min(8, opt.workers ? Math.round(num(opt.workers, "workers")) : Math.floor(os.cpus().length / 2) || 1));
  const out = path.resolve(opt.out || path.join(dir, "out", `${path.basename(dir)}${draft ? "-draft" : ""}.mp4`));

  const hash = compositionHash(dir, q);
  const chunksRoot = path.join(dir, "chunks");
  const chunkDir = path.join(chunksRoot, `${hash}-${q.name}`);
  // Chunks from older versions of the composition are stale: drop them
  if (fs.existsSync(chunksRoot)) for (const d of fs.readdirSync(chunksRoot)) if (d !== path.basename(chunkDir)) fs.rmSync(path.join(chunksRoot, d), { recursive: true, force: true });
  fs.mkdirSync(chunkDir, { recursive: true });

  const browser = await launch();
  try {
    // A probe page reads the composition's size and length
    const probe = await openComposition(browser, html, { scale: 1 });
    const info = probe.info;
    await probe.context.close();
    const per = Math.max(1, Math.round(chunkSec * info.fps));
    const chunks = [];
    for (let from = 0, i = 0; from < info.frames; from += per, i++) {
      const to = Math.min(info.frames, from + per);
      const name = `c${String(i).padStart(4, "0")}`;
      chunks.push({ from, to, file: path.join(chunkDir, `${name}.mp4`), part: path.join(chunkDir, `${name}.part.mp4`) });
    }
    const todo = chunks.filter((c) => !fs.existsSync(c.file));
    const doneFrames = info.frames - todo.reduce((n, c) => n + (c.to - c.from), 0);
    console.log(`${info.frames} frames · ${info.width}x${info.height} @ ${info.fps} fps · ${q.name} (${q.scale}x ${q.format}) · ` +
      `${chunks.length} chunk(s), ${chunks.length - todo.length} already done · ${Math.min(workers, todo.length || 1)} worker(s) · streamed Chromium → ffmpeg, no frames on disk`);

    const started = Date.now();
    let rendered = 0;
    const queue = todo.slice();
    async function worker() {
      if (!queue.length) return;
      const { page, context } = await openComposition(browser, html, { scale: q.scale });
      const cdp = await context.newCDPSession(page);
      try {
        while (queue.length) {
          const chunk = queue.shift();
          fs.rmSync(chunk.part, { force: true });
          await renderChunk(page, cdp, info, q, chunk);
          rendered += chunk.to - chunk.from;
          const secs = (Date.now() - started) / 1000;
          const fps = rendered / secs;
          const left = info.frames - doneFrames - rendered;
          console.log(`progress ${doneFrames + rendered}/${info.frames} frames · ${fps.toFixed(1)} fps · ${fmtTime(left / fps)} left`);
        }
      } finally { await context.close(); }
    }
    await Promise.all(Array.from({ length: Math.min(workers, Math.max(1, todo.length)) }, worker));

    // Join the chunks without re-encoding
    const list = path.join(chunkDir, "concat.txt");
    fs.writeFileSync(list, chunks.map((c) => `file '${c.file.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out], { stdio: "inherit" });
    if (r.status !== 0) die("ffmpeg failed to join the chunks");
    const total = countFrames(out);
    if (total !== info.frames) die(`Joined video has ${total} frames, expected ${info.frames}`);
    const size = fs.statSync(out).size;
    console.log(`${out}\n${info.width}x${info.height} · ${info.duration}s · ${total} frames · ${(size / 1e6).toFixed(1)} MB · rendered in ${fmtTime((Date.now() - started) / 1000)}`);
    console.log("Next: extract a frame from the mp4 and look at it (the encoded file is the proof, not a still)");
  } finally { await browser.close(); }
}

/* ---------- doctor ---------- */

function cmdDoctor() {
  let bad = 0;
  const line = (ok, what, fix) => { console.log(`${ok ? "ok  " : "MISS"}  ${what}${ok ? "" : "  → " + fix}`); if (!ok) bad++; };
  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 18, `node ${process.versions.node}`, "install Node 18 or newer");
  let chrome = null;
  try { chrome = findChrome(); } catch (_) { /* reported below */ }
  line(!!chrome, `chromium ${chrome || ""}`, "run scripts/setup.sh, or set MYTOMA_CHROME");
  const ff = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  line(ff.status === 0, "ffmpeg", "install ffmpeg (brew install ffmpeg · sudo apt install ffmpeg)");
  if (ff.status === 0) line(/libx264/.test(ff.stdout), "ffmpeg libx264", "use an ffmpeg build with libx264");
  line(fs.existsSync(path.join(MODULES, "gsap/dist/gsap.min.js")), "gsap + fonts (node_modules)", "run scripts/setup.sh");
  console.log(bad ? `${bad} problem(s)` : "ready");
  process.exitCode = bad ? 1 : 0;
}

/* ---------- main ---------- */

const COMMANDS = { new: cmdNew, check: cmdCheck, stills: cmdStills, cues: cmdCues, render: cmdRender, doctor: cmdDoctor };
const [cmd, ...rest] = process.argv.slice(2);
if (!COMMANDS[cmd]) die("Usage: node cli.js new|check|stills|cues|render|doctor <work> …\nSee the header of cli.js for options.");
const { pos, opt } = parseArgs(rest);
Promise.resolve(COMMANDS[cmd](pos, opt)).catch((e) => { console.error(e.message || e); process.exit(1); });
