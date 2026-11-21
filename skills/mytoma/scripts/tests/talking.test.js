"use strict";
// Talking-head layer in the browser: captions and faceCam, driven from t alone.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { launch, openComposition, capture } = require("../lib/browser");

const CLI = path.join(__dirname, "..", "cli.js");
let work, browser;

const WORDS = [
  { w: "Hey,", s: 0.2, e: 0.5 }, { w: "my", s: 0.6, e: 0.7 }, { w: "name", s: 0.72, e: 0.95 },
  { w: "is", s: 1.0, e: 1.1 }, { w: "iCon.", s: 1.15, e: 1.6, k: 1 },
];
const PHRASES = [{ a: 0, b: 1, s: 0.2, e: 0.5 }, { a: 1, b: 4, s: 0.6, e: 1.1 }, { a: 4, b: 5, s: 1.15, e: 1.6 }];

test.before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "mytoma-talk-"));
  execFileSync("node", [CLI, "new", work, "--format", "square", "--duration", "2"], { stdio: "ignore" });
  fs.writeFileSync(path.join(work, "words.js"), `window.CAPTIONS = ${JSON.stringify({ words: WORDS, phrases: PHRASES })};\n`);
  // a face shot over [0, 1): frames made by ffmpeg, each a different grey
  fs.mkdirSync(path.join(work, "face"));
  for (let f = 0; f < 30; f++) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x${(f * 8).toString(16).padStart(2, "0").repeat(3)}:s=64x64`,
      "-frames:v", "1", path.join(work, "face", `f${String(f).padStart(5, "0")}.jpg`)]);
  }
  const html = path.join(work, "index.html");
  let text = fs.readFileSync(html, "utf8");
  text = text.replace(/<!-- BEGIN SHOTS -->[\s\S]*<!-- END SHOTS -->/, `<!-- BEGIN SHOTS -->
    <section class="shot bleed" id="s01"><img class="face" id="face" alt=""></section>
    <section class="shot" id="s02"><h1 class="lg">after</h1></section>
<!-- END SHOTS -->`);
  text = text.replace(/\/\/ BEGIN TIMELINE[\s\S]*\/\/ END TIMELINE/, `// BEGIN TIMELINE
shot("s01", 0, 1); faceCam("#face", 0, 1);
shot("s02", 1, 2); nocap(1.3, 1.5);
// END TIMELINE`);
  fs.writeFileSync(html, text);
  browser = await launch();
});
test.after(async () => { await browser?.close(); fs.rmSync(work, { recursive: true, force: true }); });

async function at(page, t) {
  await page.evaluate((t) => window.renderAt(t), t);
  return page.evaluate(() => {
    const layer = document.getElementById("captions");
    return {
      visible: layer && layer.style.visibility !== "hidden",
      text: layer ? layer.textContent.trim().replace(/\s+/g, " ") : "",
      on: Array.from(document.querySelectorAll(".cap-line .w.on")).map((s) => s.textContent),
      key: Array.from(document.querySelectorAll(".cap-line .w.key")).map((s) => s.textContent),
      face: document.getElementById("face").getAttribute("src"),
    };
  });
}

test("captions follow the words, highlight the one being said, and obey nocap", async () => {
  const { page, context } = await openComposition(browser, path.join(work, "index.html"));
  assert.strictEqual((await at(page, 0.05)).visible, false, "nothing before the first word");
  let s = await at(page, 0.75);
  assert.strictEqual(s.text, "my name is");
  assert.deepStrictEqual(s.on, ["name"]);
  s = await at(page, 1.2);
  assert.strictEqual(s.text, "iCon.", "case as written");
  assert.deepStrictEqual(s.key, ["iCon."]);
  assert.strictEqual((await at(page, 1.4)).visible, false, "hidden inside nocap(1.3, 1.5)");
  assert.strictEqual((await at(page, 1.55)).visible, true);
  assert.strictEqual((await at(page, 0.3)).text, "Hey,", "seeking back rebuilds the earlier phrase");
  await context.close();
});

test("faceCam shows the frame for t, in any seek order", async () => {
  const { page, context } = await openComposition(browser, path.join(work, "index.html"));
  const cdp = await context.newCDPSession(page);
  const shot = async (t) => { await page.evaluate((t) => window.renderAt(t), t); return crypto.createHash("sha1").update(await capture(page, cdp)).digest("hex"); };
  assert.strictEqual((await at(page, 0.5)).face, "face/f00015.jpg");
  assert.strictEqual((await at(page, 0.99)).face, "face/f00029.jpg");
  const a = await shot(0.4), b = await shot(0.8);
  await shot(0.1);
  assert.strictEqual(await shot(0.8), b);
  assert.strictEqual(await shot(0.4), a);
  assert.notStrictEqual(a, b);
  await context.close();
});

test("a missing face frame fails loudly", async () => {
  fs.renameSync(path.join(work, "face", "f00020.jpg"), path.join(work, "face", "gone.jpg"));
  const { page, context } = await openComposition(browser, path.join(work, "index.html"));
  await assert.rejects(page.evaluate(() => window.renderAt(20 / 30)), /missing face\/f00020\.jpg; run take\.py face/);
  await context.close();
  fs.renameSync(path.join(work, "face", "gone.jpg"), path.join(work, "face", "f00020.jpg"));
});

test("chapters draw from edit.js, and a stretch can turn subtitles off", async () => {
  const editFile = path.join(work, "edit.js");
  fs.writeFileSync(editFile, `window.EDIT = ${JSON.stringify({
    stretches: [{ a: 0, b: 0.5, level: "none", subtitles: true }, { a: 0.5, b: 0.9, level: "limited", subtitles: false }],
    chapters: [{ a: 0, b: 1, title: "Intro" }, { a: 1, b: 2, title: "After" }],
    chapterStyle: { mode: "both", position: "auto" },
  })};\n`);
  const { page, context } = await openComposition(browser, path.join(work, "index.html"));
  const read = async (t) => {
    await page.evaluate((t) => window.renderAt(t), t);
    return page.evaluate(() => ({
      pos: document.getElementById("chapters").className,
      name: document.querySelector(".ch-name").textContent,
      on: Array.from(document.querySelectorAll(".ch-seg")).findIndex((s) => s.classList.contains("on")),
      caps: document.getElementById("captions").style.visibility !== "hidden",
    }));
  };
  let s = await read(0.3);
  assert.deepStrictEqual([s.pos, s.name, s.on, s.caps], ["ch-top", "Intro", 0, true], "square → chapters on top; captions on");
  s = await read(0.75);
  assert.strictEqual(s.caps, false, "subtitles: false hides captions in that stretch");
  s = await read(1.2);
  assert.deepStrictEqual([s.name, s.on], ["After", 1]);
  await context.close();
});

test("check enforces the marks: none = only the face, limited = the face stays", async () => {
  // 0-0.5 none over the face shot (clean); 1.0-2.0 limited over the text shot (no face: a finding)
  fs.writeFileSync(path.join(work, "edit.js"), `window.EDIT = ${JSON.stringify({
    stretches: [{ a: 0, b: 0.5, level: "none", subtitles: true }, { a: 1, b: 2, level: "limited", subtitles: true }], chapters: [],
  })};\n`);
  let out = "";
  try { out = execFileSync("node", [CLI, "check", work], { encoding: "utf8" }); } catch (e) { out = e.stdout; }
  assert.doesNotMatch(out, /none stretch 0\.00-0\.50s/, "the face shot alone satisfies a none stretch");
  assert.match(out, /limited stretch 1\.00-2\.00s: the speaker's face is not on screen/);
  // graphics inside a none stretch are flagged
  fs.writeFileSync(path.join(work, "edit.js"), `window.EDIT = ${JSON.stringify({ stretches: [{ a: 1, b: 2, level: "none" }], chapters: [] })};\n`);
  try { out = execFileSync("node", [CLI, "check", work], { encoding: "utf8" }); } catch (e) { out = e.stdout; }
  assert.match(out, /none stretch 1\.00-2\.00s: graphics on screen/);
  fs.writeFileSync(path.join(work, "edit.js"), "window.EDIT = null;\n");
});

test("re-running new keeps the composition's duration and format", () => {
  execFileSync("node", [CLI, "new", work], { stdio: "ignore" });
  const comp = JSON.parse(fs.readFileSync(path.join(work, "index.html"), "utf8").match(/window\.COMP\s*=\s*(\{.*?\});/s)[1]);
  assert.deepStrictEqual([comp.width, comp.height, comp.duration], [1080, 1080, 2]);
});
