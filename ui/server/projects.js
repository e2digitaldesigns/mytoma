// Projects: one folder per video under MYTOMA_PROJECTS. The folder is a myToma work dir (index.html,
// words.js, edit.js, take.json, …) plus project.json with what the studio needs to remember.

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export const MEDIA_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mp3|m4a|wav|aac|flac|ogg)$/i;

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "video";
}

export function projectDir(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw httpError(400, "bad project id");
  return path.join(config.projects, id);
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// window.X = {...}; files written by the skill's tools
export function readWindowJS(file, name) {
  try {
    // "window.X = <json>;  // comment": take what lies between the "=" and the last ";" (words may contain ";")
    const text = fs.readFileSync(file, "utf8").trim();
    const start = text.indexOf("=");
    if (!text.startsWith(`window.${name}`) || start < 0) return null;
    const body = text.slice(start + 1, text.lastIndexOf(";") > start ? text.lastIndexOf(";") : undefined).trim();
    return body === "null" ? null : JSON.parse(body);
  } catch { return null; }
}

export function listProjects() {
  if (!fs.existsSync(config.projects)) return [];
  return fs.readdirSync(config.projects, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(config.projects, d.name, "project.json")))
    .map((d) => summary(d.name))
    .sort((a, b) => b.updated - a.updated);
}

export function summary(id) {
  const dir = projectDir(id);
  const p = readJSON(path.join(dir, "project.json"), {});
  const stat = fs.statSync(dir);
  return {
    id, name: p.name || id, format: p.format, created: p.created,
    updated: Math.max(stat.mtimeMs, ...["index.html", "edit.json", "project.json"].map((f) => mtime(path.join(dir, f)))),
    source: p.source ? path.basename(p.source) : null,
    transcribed: fs.existsSync(path.join(dir, "take.json")),
    outputs: outputs(dir).length,
  };
}

function mtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }

export function outputs(dir) {
  const out = path.join(dir, "out");
  if (!fs.existsSync(out)) return [];
  return fs.readdirSync(out).filter((f) => f.endsWith(".mp4")).map((f) => {
    const st = fs.statSync(path.join(out, f));
    return { file: f, url: `out/${f}`, size: st.size, mtime: st.mtimeMs, draft: f.endsWith("-draft.mp4") };
  }).sort((a, b) => b.mtime - a.mtime);
}

// shot("s01", 0, 3.5, "whip") and faceCam("#face1", 0, 3.5) calls, read from the timeline source
export function parseTimeline(html) {
  const shots = [];
  const dur = (() => { const m = html.match(/window\.COMP\s*=\s*\{[^}]*"duration"\s*:\s*([\d.]+)/); return m ? Number(m[1]) : 0; })();
  const t = (v) => (v === "MT.D" ? dur : Number(v));          // the starter's shot runs to MT.D, the end
  for (const m of html.matchAll(/\bshot\(\s*["']([^"']+)["']\s*,\s*([\d.]+|MT\.D)\s*,\s*([\d.]+|MT\.D)(?:\s*,\s*["']([^"']+)["'])?/g)) {
    shots.push({ id: m[1], s: t(m[2]), e: t(m[3]), enter: m[4] || "cut" });
  }
  const faces = [];
  for (const m of html.matchAll(/\bfaceCam\(\s*["']([^"']+)["']\s*,\s*([\d.]+)\s*,\s*([\d.]+)/g)) {
    faces.push({ sel: m[1], a: Number(m[2]), b: Number(m[3]) });
  }
  return { shots: shots.sort((a, b) => a.s - b.s), faces };
}

export function projectState(id) {
  const dir = projectDir(id);
  if (!fs.existsSync(path.join(dir, "project.json"))) throw httpError(404, `no project ${id}`);
  const project = readJSON(path.join(dir, "project.json"), {});
  const html = fs.existsSync(path.join(dir, "index.html")) ? fs.readFileSync(path.join(dir, "index.html"), "utf8") : "";
  const comp = (() => { const m = html.match(/window\.COMP\s*=\s*(\{.*?\});/s); return m ? JSON.parse(m[1]) : null; })();
  const faceDir = path.join(dir, "face");
  return {
    id, dir, project, comp,
    // where Claude finds this project: the host path when the studio runs in a container
    hostDir: config.projectsHost ? path.join(config.projectsHost, id) : dir,
    take: readJSON(path.join(dir, "take.json")),
    words: readJSON(path.join(dir, "words.json"), []),
    captions: readWindowJS(path.join(dir, "words.js"), "CAPTIONS"),
    fixes: readJSON(path.join(dir, "fixes.json"), {}),
    keywords: readJSON(path.join(dir, "keywords.json"), []),
    edit: readJSON(path.join(dir, "edit.json"), defaultEdit()),
    timeline: parseTimeline(html),
    audio: {
      voice: fs.existsSync(path.join(dir, "voice.wav")) ? "voice.wav" : null,
      mix: fs.existsSync(path.join(dir, "audio", "mix.wav")) ? "audio/mix.wav" : null,
      mixReport: readJSON(path.join(dir, "audio", "mix.json")),
    },
    faceFrames: fs.existsSync(faceDir) ? fs.readdirSync(faceDir).filter((f) => f.endsWith(".jpg")).length : 0,
    outputs: outputs(dir),
    htmlMtime: mtime(path.join(dir, "index.html")),
  };
}

export function defaultEdit() {
  return { stretches: [], chapters: [], chapterStyle: { mode: "both", position: "auto" } };
}

const LEVELS = new Set(["none", "limited", "full"]);
const MODES = new Set(["off", "name", "bar", "both"]);
const POSITIONS = new Set(["auto", "top", "bottom"]);

// Validate the marks from the UI and write edit.json (the record) and edit.js (what the composition loads)
export function saveEdit(id, body) {
  const dir = projectDir(id);
  const num = (v, what) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw httpError(400, `${what} must be a time in seconds`);
    return Math.round(n * 1000) / 1000;
  };
  const range = (r, what) => {
    const a = num(r.a, `${what} start`), b = num(r.b, `${what} end`);
    if (b <= a) throw httpError(400, `${what}: end must be after start`);
    return { a, b };
  };
  const stretches = (body.stretches || []).map((s, i) => {
    if (!LEVELS.has(s.level)) throw httpError(400, `stretch ${i + 1}: level must be none, limited or full`);
    return { ...range(s, `stretch ${i + 1}`), level: s.level, subtitles: s.subtitles !== false };
  }).sort((x, y) => x.a - y.a);
  for (let i = 1; i < stretches.length; i++) {
    if (stretches[i].a < stretches[i - 1].b - 1e-6) throw httpError(400, `stretches overlap at ${stretches[i].a}s`);
  }
  const chapters = (body.chapters || []).map((c, i) => ({ ...range(c, `chapter ${i + 1}`), title: String(c.title || `Chapter ${i + 1}`).slice(0, 80) }))
    .sort((x, y) => x.a - y.a);
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].a < chapters[i - 1].b - 1e-6) throw httpError(400, `chapters overlap at ${chapters[i].a}s`);
  }
  const cs = body.chapterStyle || {};
  const chapterStyle = { mode: MODES.has(cs.mode) ? cs.mode : "both", position: POSITIONS.has(cs.position) ? cs.position : "auto" };
  const edit = { stretches, chapters, chapterStyle };
  writeJSON(path.join(dir, "edit.json"), edit);
  fs.writeFileSync(path.join(dir, "edit.js"), `window.EDIT = ${JSON.stringify(edit)};  // written by myToma studio\n`);
  return edit;
}

// Media the user may point at: files under the configured media roots only
export function resolveMedia(p) {
  const full = path.resolve(String(p || ""));
  const root = config.media.find((r) => full === r || full.startsWith(r + path.sep));
  if (!root) throw httpError(403, "outside the media folders this studio may read");
  return full;
}

export function browse(p) {
  if (!p) return { path: null, roots: config.media, entries: config.media.map((r) => ({ name: r, path: r, dir: true })) };
  const dir = resolveMedia(p);
  if (!fs.statSync(dir).isDirectory()) throw httpError(400, "not a folder");
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || MEDIA_EXT.test(e.name)))
    .map((e) => {
      const full = path.join(dir, e.name);
      return { name: e.name, path: full, dir: e.isDirectory(), size: e.isDirectory() ? null : fs.statSync(full).size };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const parent = config.media.includes(dir) ? null : path.dirname(dir);
  return { path: dir, parent, roots: config.media, entries };
}
