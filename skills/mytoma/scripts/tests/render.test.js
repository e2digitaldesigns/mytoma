"use strict";
// Render pipeline: chunking, resume, and re-use safety.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const CLI = path.join(__dirname, "..", "cli.js");
const run = (...args) => execFileSync("node", [CLI, ...args], { encoding: "utf8" });
const frames = (f) => Number(spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets",
  "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.replace(/\D/g, ""));

let work, mp4;
test.before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "mytoma-render-"));
  run("new", work, "--format", "square", "--duration", "2");
  mp4 = path.join(work, "out", `${path.basename(work)}-draft.mp4`);
});
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

test("a different --chunk size never re-uses chunks holding other frames", () => {
  run("render", work, "--draft", "--chunk", "0.5", "--no-audio");
  assert.strictEqual(frames(mp4), 60);
  const r = run("render", work, "--draft", "--chunk", "1", "--no-audio");
  assert.match(r, /0 already done/);
  assert.strictEqual(frames(mp4), 60);
});

test("a killed render resumes from the chunks it finished", () => {
  run("render", work, "--draft", "--chunk", "0.5", "--no-audio");
  const dir = fs.readdirSync(path.join(work, "chunks")).map((d) => path.join(work, "chunks", d))[0];
  const chunks = fs.readdirSync(dir).filter((f) => /^f\d+-\d+\.mp4$/.test(f)).sort();
  assert.strictEqual(chunks.length, 4);
  fs.rmSync(path.join(dir, chunks[2]));
  const r = run("render", work, "--draft", "--chunk", "0.5", "--no-audio");
  assert.match(r, /4 chunk\(s\), 3 already done/);
  assert.strictEqual(frames(mp4), 60);
});
