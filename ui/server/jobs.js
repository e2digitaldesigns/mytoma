// Jobs: the pipeline steps, run one at a time (the machine has one GPU and the renderer wants every core),
// with their output streamed to the browser.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { httpError, parseTimeline, projectDir, readJSON } from "./projects.js";

export const events = new EventEmitter();
events.setMaxListeners(100);

const jobs = [];          // newest last; finished jobs kept for the session
const queue = [];
let running = null;
let seq = 0;

const SCRIPTS = () => path.join(config.skill, "scripts");
const CLI = () => path.join(SCRIPTS(), "cli.js");

export const STEPS = {
  prepare: "Transcribe, trim and caption",
  captions: "Rebuild captions",
  face: "Extract face frames",
  check: "Check the composition",
  sound: "Mix the soundtrack",
  draft: "Render a draft",
  render: "Render the final",
};

export function listJobs() { return jobs.map(view); }

function view(j) {
  const { log, ...rest } = j;
  return { ...rest, tail: log.slice(-12) };
}

export function getJob(id) {
  const j = jobs.find((x) => x.id === id);
  if (!j) throw httpError(404, "no such job");
  return { ...j };
}

export function enqueue(project, step, options = {}) {
  if (!STEPS[step]) throw httpError(400, `unknown step ${step}`);
  if ([running, ...queue].some((j) => j && j.project === project && j.step === step)) {
    throw httpError(409, `${STEPS[step]} is already queued for this project`);
  }
  const job = { id: String(++seq), project, step, label: STEPS[step], options, status: "queued", progress: null,
    created: Date.now(), started: null, ended: null, error: null, log: [] };
  jobs.push(job);
  if (jobs.length > 200) jobs.splice(0, jobs.length - 200);
  queue.push(job);
  events.emit("job", view(job));
  pump();
  return view(job);
}

async function pump() {
  if (running || !queue.length) return;
  running = queue.shift();
  const job = running;
  job.status = "running";
  job.started = Date.now();
  events.emit("job", view(job));
  try {
    await RUN[job.step](job, projectDir(job.project));
    job.status = "done";
    job.progress = 1;
  } catch (e) {
    job.status = "failed";
    job.error = e.message;
    line(job, `ERROR ${e.message}`);
  }
  job.ended = Date.now();
  events.emit("job", view(job));
  events.emit("files", { project: job.project });
  running = null;
  pump();
}

function line(job, text) {
  job.log.push(text);
  if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
  // progress lines the tools already print
  let m = text.match(/progress (\d+)\/(\d+) frames/);
  if (m) job.progress = Number(m[1]) / Number(m[2]);
  m = text.match(/^\s+([\d.]+)s \/ ([\d.]+)s$/);
  if (m) job.progress = Math.min(0.95, Number(m[1]) / Number(m[2]));
  events.emit("log", { id: job.id, project: job.project, line: text, progress: job.progress });
}

function exec(job, cmd, args, { cwd, okCodes = [0] } = {}) {
  line(job, `$ ${[path.basename(cmd), ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: cwd || SCRIPTS(), env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    job.pid = child.pid;
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop();
      parts.filter((p) => p.trim()).forEach((p) => line(job, p));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => reject(new Error(`${cmd}: ${e.message}`)));
    child.on("close", (code) => {
      if (buf.trim()) line(job, buf);
      okCodes.includes(code) ? resolve(code) : reject(new Error(`${path.basename(cmd)} ${args[0] ? path.basename(args[0]) : ""} exited with ${code}`));
    });
  });
}

const py = (job, script, args) => exec(job, config.python, [path.join(SCRIPTS(), ...script.split("/")), ...args]);
const node = (job, args, opts) => exec(job, process.execPath, [CLI(), ...args], opts);

function project(dir) {
  const p = readJSON(path.join(dir, "project.json"));
  if (!p) throw new Error("project.json missing");
  return p;
}

// Face frames are needed wherever the timeline calls faceCam, and over every none/limited stretch
function faceRanges(dir) {
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const take = readJSON(path.join(dir, "take.json"));
  const edit = readJSON(path.join(dir, "edit.json"), { stretches: [] });
  const want = parseTimeline(html).faces.map((f) => [f.a, f.b])
    .concat((edit.stretches || []).filter((s) => s.level !== "full").map((s) => [s.a, s.b]));
  const max = take ? take.duration : Infinity;
  const merged = [];
  for (const [a, b] of want.map(([a, b]) => [Math.max(0, a), Math.min(max, b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

function faceMissing(dir) {
  // no trimmed recording yet: nothing to extract from (check still runs, and reports the missing face)
  if (!fs.existsSync(path.join(dir, "take.json"))) return false;
  const ranges = faceRanges(dir);
  return ranges.some(([a, b]) => {
    for (let f = Math.round(a * 30); f < Math.round(b * 30); f++) {
      if (!fs.existsSync(path.join(dir, "face", `f${String(f).padStart(5, "0")}.jpg`))) return true;
    }
    return false;
  });
}

const RUN = {
  async prepare(job, dir) {
    const p = project(dir);
    if (!p.source) throw new Error("add a recording first (upload it or pick it by path)");
    const s = p.settings || {};
    const args = [p.source, "--outdir", dir];
    if (s.model) args.push("--model", s.model);
    if (s.vocab) args.push("--vocab", s.vocab);
    if (s.language) args.push("--language", s.language);
    // a fresh transcript: the old raw words belong to the old recording
    fs.rmSync(path.join(dir, "words.raw.json"), { force: true });
    await py(job, "audio/transcribe.py", args);
    await py(job, "take.py", ["trim", p.source, dir]);
    await py(job, "captions.py", [dir]);
    const take = readJSON(path.join(dir, "take.json"));
    await node(job, ["new", dir, "--duration", String(take.duration), "--format", p.format]);
    fs.rmSync(path.join(dir, "face"), { recursive: true, force: true });   // frames of an older cut
  },
  async captions(job, dir) {
    await py(job, "captions.py", [dir]);
  },
  async face(job, dir) {
    const ranges = faceRanges(dir);
    if (!ranges.length) { line(job, "no face shots or none/limited stretches: nothing to extract"); return; }
    if (!fs.existsSync(path.join(dir, "take.json"))) throw new Error("transcribe the recording first");
    await py(job, "take.py", ["face", dir, ranges.map(([a, b]) => `${a}-${b}`).join(",")]);
  },
  // findings are a result, not a failure: the job is done, its summary says what check found
  async check(job, dir) {
    if (faceMissing(dir)) await RUN.face(job, dir);
    await node(job, ["check", dir], { okCodes: [0, 1] });
    const findings = job.log.filter((l) => l.startsWith("FAIL"));
    job.summary = findings.length ? `${findings.length} finding${findings.length > 1 ? "s" : ""}` : "clean";
  },
  async sound(job, dir) {
    const s = project(dir).settings || {};
    const args = ["sound", dir, "--music", s.music || "synth"];
    if (fs.existsSync(path.join(dir, "voice.wav"))) args.push("--voice", path.join(dir, "voice.wav"));
    if (s.musicLevel) args.push("--music-level", String(s.musicLevel));
    await node(job, args);
  },
  async draft(job, dir) { await render(job, dir, true); },
  async render(job, dir) { await render(job, dir, false); },
};

async function render(job, dir, draft) {
  if (faceMissing(dir)) await RUN.face(job, dir);
  if (!fs.existsSync(path.join(dir, "audio", "mix.wav")) && fs.existsSync(path.join(dir, "voice.wav"))) await RUN.sound(job, dir);
  const args = ["render", dir];
  if (draft) args.push("--draft");
  await node(job, args);
}

// Claude (or the user) edits index.html in another window: tell the browser so the preview reloads
const watchers = new Map();
export function watchProject(id) {
  if (watchers.has(id)) return;
  const dir = projectDir(id);
  let timer = null;
  try {
    const w = fs.watch(dir, (ev, file) => {
      if (!file || !/^(index\.html|edit\.js|words\.js|take\.json)$/.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => events.emit("files", { project: id, file }), 250);
    });
    watchers.set(id, w);
  } catch { /* folder gone */ }
}
