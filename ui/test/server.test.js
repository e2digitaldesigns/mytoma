// The studio API, end to end against a real server on a spare port, with temporary folders.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mytoma-studio-"));
const media = path.join(tmp, "media");
fs.mkdirSync(media);
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2",
  "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(media, "take.mp4")]);
fs.writeFileSync(path.join(tmp, "secret.mp4"), "not media");

// A stand-in for the skill's Python, so the image endpoints run without the network: it answers find_media.py's
// --search-only and --add the way the real script does (find_media.py's own tests cover the searching)
const fakePython = path.join(tmp, "fake-python.js");
fs.writeFileSync(fakePython, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const [script, work, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(tmp, "python-calls.txt"))}, JSON.stringify([path.basename(script), ...args]) + "\\n");
if (args.includes("--search-only")) {
  console.log(JSON.stringify({ query: args[0], candidates: [{ id: "c1", source: "commons", title: "Fries", author: "Jane", licence: "CC BY-SA 4.0",
    thumb_url: "https://upload.wikimedia.org/t.jpg", page_url: "https://commons.wikimedia.org/wiki/File:Fries.jpg", width: 2400, height: 1600 }],
    skipped: [{ title: "Menu", reason: "non-commercial (NC)" }], messages: [] }));
} else if (args.includes("--add")) {
  fs.mkdirSync(path.join(work, "assets"), { recursive: true });
  fs.writeFileSync(path.join(work, "assets", "fries-01.jpg"), "jpeg");
  const entry = { file: "assets/fries-01.jpg", title: "Fries", author: "Jane", source: "Wikimedia Commons",
    source_url: "https://commons.wikimedia.org/wiki/File:Fries.jpg", licence: "CC BY-SA 4.0", licence_url: "https://creativecommons.org/licenses/by-sa/4.0/" };
  fs.writeFileSync(path.join(work, "credits.json"), JSON.stringify([entry]));
  fs.writeFileSync(path.join(work, "credits.txt"), "Image credits:\\n\\"Fries\\" by Jane\\n");
  console.log(JSON.stringify({ saved: [entry], messages: [] }));
}
`);
fs.chmodSync(fakePython, 0o755);

let server, base;
const port = 4300 + Math.floor(Math.random() * 500);

async function start(env) {
  const proc = spawn(process.execPath, [path.join(here, "..", "server", "index.js")], {
    env: { ...process.env, MYTOMA_PROJECTS: path.join(tmp, "projects"), MYTOMA_MEDIA: media, MYTOMA_PORT: String(port), MYTOMA_PYTHON: fakePython, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => d.toString().includes("myToma studio") && resolve());
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  return proc;
}

let cookie = "";
async function req(method, url, body, headers = {}) {
  const res = await fetch(base + url, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

test.before(async () => { server = await start({ MYTOMA_PASSWORD: "hunter2" }); base = `http://127.0.0.1:${port}`; });
test.after(() => { server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("a password protects the API, and the login cookie opens it", async () => {
  assert.equal((await req("GET", "/api/projects")).status, 401);
  assert.equal((await req("POST", "/api/login", { password: "wrong" })).status, 401);
  const ok = await req("POST", "/api/login", { password: "hunter2" });
  assert.equal(ok.status, 200);
  cookie = ok.headers.get("set-cookie").split(";")[0];
  assert.equal((await req("GET", "/api/projects")).status, 200);
});

test("create a project, pick its recording by path, never outside the media folders", async () => {
  const p = await req("POST", "/api/projects", { name: "My first video!", format: "landscape" });
  assert.equal(p.status, 201);
  assert.equal(p.data.id, "my-first-video");
  const dup = await req("POST", "/api/projects", { name: "My first video!" });
  assert.equal(dup.data.id, "my-first-video-2");
  const st = await req("GET", "/api/projects/my-first-video");
  assert.deepEqual([st.data.comp.width, st.data.comp.height], [1920, 1080]);
  assert.equal(st.data.timeline.shots[0].e, st.data.comp.duration, "the starter's shot runs to the end");
  assert.equal((await req("POST", "/api/projects/my-first-video/source", { path: path.join(media, "take.mp4") })).status, 200);
  assert.equal((await req("POST", "/api/projects/my-first-video/source", { path: path.join(tmp, "secret.mp4") })).status, 403);
  assert.equal((await req("POST", "/api/projects/my-first-video/source", { path: media + "/../secret.mp4" })).status, 403);
  const br = await req("GET", `/api/browse?path=${encodeURIComponent(media)}`);
  assert.deepEqual(br.data.entries.map((e) => e.name), ["take.mp4"]);
  assert.equal((await req("GET", `/api/browse?path=${encodeURIComponent(tmp)}`)).status, 403);
});

test("templates are labelled apart from example videos, and a template keeps its colours", async () => {
  const cfg = await req("GET", "/api/config");
  assert.equal(cfg.data.templates[0], "starter");
  assert.equal(cfg.data.templateLabels["dark-truth"], "Dark Truth");
  assert.equal(cfg.data.templateLabels["talking-head"], "Example: talking-head");
  assert.ok(cfg.data.templates.indexOf("dark-truth") < cfg.data.templates.indexOf("talking-head"), "templates before examples");
  const p = await req("POST", "/api/projects", { name: "Dark one", format: "vertical", template: "dark-truth" });
  assert.equal(p.status, 201);
  const html = fs.readFileSync(path.join(tmp, "projects", p.data.id, "index.html"), "utf8");
  assert.match(html, /"name":"Dark Truth"/);
  assert.match(html, /"width":1080,"height":1920/);
});

test("upload streams the file into the project", async () => {
  const bytes = fs.readFileSync(path.join(media, "take.mp4"));
  const r = await fetch(`${base}/api/projects/my-first-video/upload`, { method: "PUT", body: bytes, headers: { Cookie: cookie, "X-Filename": "phone take.mp4" } });
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.size, bytes.length);
  assert.ok(fs.existsSync(path.join(tmp, "projects", "my-first-video", "source", "phone take.mp4")));
  const bad = await fetch(`${base}/api/projects/my-first-video/upload`, { method: "PUT", body: "x", headers: { Cookie: cookie, "X-Filename": "notes.txt" } });
  assert.equal(bad.status, 400);
});

test("stretches and chapters are validated and written where the composition reads them", async () => {
  const id = "my-first-video";
  assert.equal((await req("PUT", `/api/projects/${id}/edit`, { stretches: [{ a: 0, b: 2, level: "loud" }] })).status, 400);
  assert.match((await req("PUT", `/api/projects/${id}/edit`, { stretches: [{ a: 0, b: 2, level: "none" }, { a: 1, b: 3, level: "full" }] })).data.error, /overlap/);
  assert.match((await req("PUT", `/api/projects/${id}/edit`, { chapters: [{ a: 3, b: 2, title: "x" }] })).data.error, /end must be after start/);
  const ok = await req("PUT", `/api/projects/${id}/edit`, {
    stretches: [{ a: 4, b: 6, level: "full" }, { a: 0, b: 2.5, level: "none", subtitles: false }],
    chapters: [{ a: 0, b: 5, title: "Intro" }], chapterStyle: { mode: "bar", position: "bottom" },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.stretches.map((s) => s.a), [0, 4], "sorted");
  const js = fs.readFileSync(path.join(tmp, "projects", id, "edit.js"), "utf8");
  assert.match(js, /^window\.EDIT = \{"stretches":\[\{"a":0,"b":2\.5,"level":"none","subtitles":false\}/);
});

test("project files are served for the preview, with no way out of the project", async () => {
  assert.equal((await req("GET", "/files/my-first-video/index.html")).status, 200);
  assert.equal((await req("GET", "/files/my-first-video/..%2Fmy-first-video-2%2Fproject.json")).status, 400);
  assert.equal((await req("GET", "/files/my-first-video/.hidden")).status, 400);
  assert.equal((await req("GET", "/files/MY-FIRST/index.html")).status, 400);
});

test("find images: search, add to the project, and the credits come with them", async () => {
  const id = "my-first-video";
  assert.equal((await req("POST", `/api/projects/${id}/images/search`, { query: " " })).status, 400);
  const found = await req("POST", `/api/projects/${id}/images/search`, { query: "thick fries", orientation: "portrait", minWidth: 900 });
  assert.equal(found.status, 200, JSON.stringify(found.data));
  assert.deepEqual(found.data.candidates.map((candidate) => [candidate.id, candidate.licence]), [["c1", "CC BY-SA 4.0"]]);
  assert.equal(found.data.skipped[0].reason, "non-commercial (NC)");
  assert.equal((await req("POST", `/api/projects/${id}/images/add`, { ids: ["../x"] })).status, 400);
  const added = await req("POST", `/api/projects/${id}/images/add`, { ids: ["c1"], name: "Thick Fries!" });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.deepEqual(added.data.state.images.map((image) => [image.file, image.credit.author]), [["assets/fries-01.jpg", "Jane"]]);
  assert.equal(added.data.state.credits, "credits.txt");
  const calls = fs.readFileSync(path.join(tmp, "python-calls.txt"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls[0], ["find_media.py", "thick fries", "--search-only", "--orientation", "portrait", "--min-width", "900", "--json"]);
  assert.deepEqual(calls[1], ["find_media.py", "--add", "c1", "--name", "thick-fries", "--json"]);
  // the Renders tab's credits download
  const credits = await req("GET", `/files/${id}/credits.txt`);
  assert.equal(credits.status, 200);
  assert.match(credits.data, /"Fries" by Jane/);
});

test("a job runs to completion and its events stream", async () => {
  const seen = [];
  const ac = new AbortController();
  const stream = fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: ac.signal }).then(async (r) => {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; seen.push(dec.decode(value)); }
  }).catch(() => {});
  const j = await req("POST", "/api/projects/my-first-video/run/check");
  assert.equal(j.status, 202);
  let job;
  for (let i = 0; i < 120; i++) {
    job = (await req("GET", `/api/jobs/${j.data.id}`)).data;
    if (job.status === "done" || job.status === "failed") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  ac.abort();
  await stream;
  assert.equal(job.status, "done", job.error || "");
  // the none stretch marked above has no face shot under it (there is no recording yet): check reports it
  assert.match(job.summary, /^\d+ findings?$/);
  assert.ok(job.log.some((l) => /none stretch 0\.00-2\.50s: the speaker's face is not on screen/.test(l)), job.log.join("\n"));
  const all = seen.join("");
  assert.match(all, /event: job/);
  assert.match(all, /event: log/);
  assert.equal((await req("POST", "/api/projects/my-first-video/run/explode")).status, 400);
});
