"use strict";
// End to end: sound → render muxes it → a timeline edit makes render re-mix on its own.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const CLI = path.join(__dirname, "..", "cli.js");
const run = (...args) => execFileSync("node", [CLI, ...args], { encoding: "utf8" });
const probe = (file, entries) => spawnSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "json", file], { encoding: "utf8" });

let work;
test.before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "mytoma-sound-"));
  run("new", work, "--format", "square", "--duration", "3");
});
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

test("sound writes a mix at -14 LUFS that render muxes into the mp4", () => {
  const out = run("sound", work);
  assert.match(out, /cues placed/);
  assert.match(out, /-1[34]\.\d LUFS/);
  const mix = JSON.parse(fs.readFileSync(path.join(work, "audio", "mix.json"), "utf8"));
  assert.ok(mix.placed.length > 0);

  const r = run("render", work, "--draft");
  assert.match(r, /with sound/);
  const mp4 = path.join(work, "out", `${path.basename(work)}-draft.mp4`);
  const info = JSON.parse(probe(mp4, "stream=codec_type,codec_name,sample_rate,channels:format=duration").stdout);
  const a = info.streams.find((s) => s.codec_type === "audio");
  assert.ok(a, "mp4 has an audio stream");
  assert.strictEqual(a.codec_name, "aac");
  assert.strictEqual(a.sample_rate, "48000");
  assert.strictEqual(a.channels, 2);
  assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.05, `duration ${info.format.duration}`);
});

test("editing the timeline's cues makes render re-mix with the same options", () => {
  run("sound", work, "--music", "none");
  const before = JSON.parse(fs.readFileSync(path.join(work, "audio", "mix.json"), "utf8"));
  const html = path.join(work, "index.html");
  fs.writeFileSync(html, fs.readFileSync(html, "utf8").replace("// END TIMELINE", "cue(2.5, \"shutter\");\n// END TIMELINE"));
  const r = run("render", work, "--draft");
  assert.match(r, /cues changed since the last mix: re-mixing/);
  const after = JSON.parse(fs.readFileSync(path.join(work, "audio", "mix.json"), "utf8"));
  assert.notStrictEqual(after.cues_sha, before.cues_sha);
  assert.strictEqual(after.options.music, "none", "kept the options of the previous mix");
  assert.ok(after.placed.some((p) => p.entry === "foley.shutter"));
});

test("render without a mix says so and still makes a video", () => {
  fs.rmSync(path.join(work, "audio"), { recursive: true, force: true });
  const r = run("render", work, "--draft");
  assert.match(r, /no soundtrack yet/);
});
