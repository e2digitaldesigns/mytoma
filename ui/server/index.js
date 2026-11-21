// myToma studio server: the editor UI and a small API around the myToma skill's tools.
//
//   MYTOMA_PROJECTS  where projects live              (default ~/mytoma/projects)
//   MYTOMA_MEDIA     folders recordings may be picked from by path, comma-separated (default: home)
//   MYTOMA_SKILL     the skill folder                  (default: ../skills/mytoma in this repo)
//   MYTOMA_PASSWORD  require this password             (set it whenever other machines can reach the studio)
//   MYTOMA_HOST / MYTOMA_PORT                          (default 127.0.0.1:4173; 0.0.0.0 in Docker)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import express from "express";
import { config } from "./config.js";
import { STEPS, enqueue, events, getJob, listJobs, watchProject } from "./jobs.js";
import {
  MEDIA_EXT, browse, httpError, listProjects, projectDir, projectState, readJSON, resolveMedia, saveEdit, slugify,
  summary, writeJSON,
} from "./projects.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

/* ---------- auth: one shared password, an HMAC cookie ---------- */

const secret = crypto.createHash("sha256").update("mytoma:" + config.password).digest();
const token = crypto.createHmac("sha256", secret).update("studio").digest("hex");
const authed = (req) => !config.password || (req.headers.cookie || "").split(/;\s*/).includes(`mt_auth=${token}`);

app.post("/api/login", (req, res) => {
  const given = Buffer.from(String(req.body?.password || ""));
  const want = Buffer.from(config.password);
  if (!config.password || (given.length === want.length && crypto.timingSafeEqual(given, want))) {
    res.setHeader("Set-Cookie", `mt_auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
    return res.json({ ok: true });
  }
  setTimeout(() => res.status(401).json({ error: "wrong password" }), 600);   // slow down guessing
});
app.get("/api/session", (req, res) => res.json({ authed: authed(req), passwordRequired: !!config.password }));
app.use(["/api", "/files"], (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: "log in first" })));

/* ---------- config ---------- */

app.get("/api/config", (req, res) => {
  const examples = fs.readdirSync(path.join(config.skill, "examples"))
    .filter((d) => fs.existsSync(path.join(config.skill, "examples", d, "index.html")));
  // a folder with template.json is a starting look (it opens on a placeholder); the rest are finished demo videos
  const meta = Object.fromEntries(examples.map((d) => [d, readJSON(path.join(config.skill, "examples", d, "template.json"), null)]));
  const templates = examples.filter((d) => meta[d]?.kind === "template");
  const templateLabels = Object.fromEntries([["starter", "Blank (starter)"],
    ...examples.map((d) => [d, meta[d]?.kind === "template" ? (meta[d].label || d) : `Example: ${d}`])]);
  const lib = readJSON(path.join(config.skill, "sounds", "library.json"), { sounds: {} });
  const loops = Object.entries(lib.sounds).filter(([, e]) => e.kind === "loop").map(([id, e]) => ({ id, description: e.description }));
  res.json({
    formats: { vertical: [1080, 1920], landscape: [1920, 1080], square: [1080, 1080], portrait: [1080, 1350] },
    templates: ["starter", ...templates, ...examples.filter((e) => e !== "starter" && !templates.includes(e))],
    templateLabels,
    music: [{ id: "synth", description: "Synthesized bed, seeded per video" }, { id: "none", description: "No music" }, ...loops],
    media: config.media, projects: config.projects, steps: STEPS,
  });
});

/* ---------- projects ---------- */

app.get("/api/projects", (req, res) => res.json(listProjects()));

app.post("/api/projects", (req, res) => {
  const name = String(req.body?.name || "").trim() || "Untitled video";
  const format = req.body?.format || "vertical";
  const template = req.body?.template || "starter";
  if (!["vertical", "landscape", "square", "portrait"].includes(format)) throw httpError(400, "unknown format");
  let id = slugify(name), n = 2;
  while (fs.existsSync(path.join(config.projects, id))) id = `${slugify(name)}-${n++}`;
  const dir = projectDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const args = [path.join(config.skill, "scripts", "cli.js"), "new", dir, "--format", format, "--duration", "10"];
  if (template !== "demo") args.push("--example", template);
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (r.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw httpError(500, (r.stderr || r.stdout || "cli new failed").trim());
  }
  writeJSON(path.join(dir, "project.json"), {
    name, format, template, created: Date.now(), source: null,
    settings: { music: "synth", musicLevel: 0.22, vocab: "", model: "", language: "" },
  });
  saveEdit(id, {});
  res.status(201).json(summary(id));
});

app.get("/api/projects/:id", (req, res) => {
  const state = projectState(req.params.id);
  watchProject(req.params.id);
  res.json(state);
});

app.patch("/api/projects/:id", (req, res) => {
  const file = path.join(projectDir(req.params.id), "project.json");
  const p = readJSON(file);
  if (!p) throw httpError(404, "no such project");
  const s = req.body?.settings || {};
  const allowed = ["music", "musicLevel", "vocab", "model", "language"];
  for (const k of allowed) if (k in s) p.settings[k] = k === "musicLevel" ? Math.max(0, Math.min(1, Number(s[k]) || 0)) : String(s[k]);
  if (typeof req.body?.name === "string" && req.body.name.trim()) p.name = req.body.name.trim().slice(0, 120);
  writeJSON(file, p);
  res.json(p);
});

// Upload a recording: the body is the file itself, streamed to disk (no size held in memory)
app.put("/api/projects/:id/upload", (req, res, next) => {
  const dir = projectDir(req.params.id);
  const name = path.basename(String(req.headers["x-filename"] || "recording.mp4")).replace(/[^\w.\- ]/g, "_");
  if (!MEDIA_EXT.test(name)) return next(httpError(400, "not a video or audio file"));
  const max = config.maxUploadMB * 1e6;
  if (Number(req.headers["content-length"] || 0) > max) return next(httpError(413, `bigger than ${config.maxUploadMB} MB: pick it by path instead`));
  fs.mkdirSync(path.join(dir, "source"), { recursive: true });
  const dest = path.join(dir, "source", name);
  const part = dest + ".part";
  const out = fs.createWriteStream(part);
  let got = 0;
  req.on("data", (d) => { got += d.length; if (got > max) { req.destroy(); out.destroy(); fs.rmSync(part, { force: true }); } });
  req.pipe(out);
  out.on("finish", () => {
    fs.renameSync(part, dest);
    const file = path.join(dir, "project.json");
    const p = readJSON(file);
    p.source = dest;
    writeJSON(file, p);
    res.json({ source: dest, size: got });
  });
  out.on("error", (e) => next(e));
});

// Or point at a recording already on this machine (inside the media folders): nothing is copied
app.post("/api/projects/:id/source", (req, res) => {
  const full = resolveMedia(req.body?.path);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile() || !MEDIA_EXT.test(full)) throw httpError(400, "not a video or audio file");
  const file = path.join(projectDir(req.params.id), "project.json");
  const p = readJSON(file);
  p.source = full;
  writeJSON(file, p);
  res.json({ source: full });
});

app.get("/api/browse", (req, res) => res.json(browse(req.query.path)));

// Stretches, chapters and chapter style
app.put("/api/projects/:id/edit", (req, res) => res.json(saveEdit(req.params.id, req.body || {})));

// Transcript corrections and keywords, then rebuild the captions (fast: runs inline)
app.put("/api/projects/:id/transcript", (req, res) => {
  const dir = projectDir(req.params.id);
  const fixes = req.body?.fixes || {};
  const keywords = req.body?.keywords || [];
  if (typeof fixes !== "object" || Array.isArray(fixes) || !Array.isArray(keywords)) throw httpError(400, "fixes is an object, keywords a list");
  writeJSON(path.join(dir, "fixes.json"), fixes);
  writeJSON(path.join(dir, "keywords.json"), keywords);
  if (!fs.existsSync(path.join(dir, "words.json"))) throw httpError(409, "transcribe the recording first");
  const r = spawnSync(config.python, [path.join(config.skill, "scripts", "captions.py"), dir], { encoding: "utf8" });
  if (r.status !== 0) throw httpError(500, (r.stderr || r.stdout).trim());
  res.json({ ok: true, log: r.stdout.trim(), state: projectState(req.params.id) });
});

/* ---------- jobs ---------- */

app.post("/api/projects/:id/run/:step", (req, res) => {
  projectDir(req.params.id);
  res.status(202).json(enqueue(req.params.id, req.params.step, req.body || {}));
});
app.get("/api/jobs", (req, res) => res.json(listJobs()));
app.get("/api/jobs/:id", (req, res) => res.json(getJob(req.params.id)));

// Server-sent events: job state, log lines, and "files changed" (Claude edited the timeline)
app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (type) => (data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const handlers = { job: send("job"), log: send("log"), files: send("files") };
  for (const [k, fn] of Object.entries(handlers)) events.on(k, fn);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => { clearInterval(ping); for (const [k, fn] of Object.entries(handlers)) events.off(k, fn); });
});

/* ---------- project files (the preview loads the composition from here) ---------- */

app.get("/files/:id/*", (req, res, next) => {
  const dir = projectDir(req.params.id);
  const rel = req.params[0];
  if (!rel || rel.split("/").some((p) => p === ".." || p.startsWith("."))) return next(httpError(400, "bad path"));
  res.sendFile(rel, { root: dir, dotfiles: "deny", headers: { "Cache-Control": "no-store" } }, (e) => {
    // a request the browser dropped mid-file (a seek, or the preview moving to the next frame) is not an error
    if (!e || res.headersSent) return;
    next(httpError(404, "not found"));
  });
});

/* ---------- the web app ---------- */

if (fs.existsSync(config.web)) {
  app.use(express.static(config.web, { index: false }));
  app.get(/^\/(?!api|files).*/, (req, res) => res.sendFile(path.join(config.web, "index.html")));
}

app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  if (res.headersSent) return res.end();
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

fs.mkdirSync(config.projects, { recursive: true });
const server = app.listen(config.port, config.host, () => {
  const addr = server.address();
  console.log(`myToma studio · http://${addr.address === "0.0.0.0" ? "localhost" : addr.address}:${addr.port}`);
  console.log(`projects ${config.projects} · media ${config.media.join(", ")} · skill ${config.skill}`);
  if (!config.password && config.host !== "127.0.0.1" && config.host !== "localhost") {
    console.log("WARNING: reachable from other machines with no password. Set MYTOMA_PASSWORD.");
  }
});

export default server;
