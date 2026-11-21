"use strict";
// node --test tests/   (from scripts/)
// Proves the engine's core promise: a frame is a pure function of t.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { launch, openComposition, capture } = require("../lib/browser");

const CLI = path.join(__dirname, "..", "cli.js");
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

let work, browser;

test.before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "mytoma-test-"));
  execFileSync("node", [CLI, "new", work, "--duration", "10"], { stdio: "ignore" });
  browser = await launch();
});
test.after(async () => {
  await browser?.close();
  fs.rmSync(work, { recursive: true, force: true });
});

async function frameHashes(order, scale = 1) {
  const { page, context } = await openComposition(browser, path.join(work, "index.html"), { scale });
  const cdp = await context.newCDPSession(page);
  const out = {};
  for (const t of order) {
    await page.evaluate((t) => window.renderAt(t), t);
    out[t] = sha(await capture(page, cdp, { format: "png" }));
  }
  await context.close();
  return out;
}

test("same frame, same pixels: in order, out of order, and from a fresh page", async () => {
  // 2.6 is mid-shake after a hit, 4.0 mid-stamp, 6.0 mid-counter: the moments most likely to drift
  const times = [0.5, 2.6, 4.0, 6.0, 9.6];
  const forward = await frameHashes(times);
  const shuffled = await frameHashes([9.6, 4.0, 0.5, 6.0, 2.6]);
  const revisited = await frameHashes([6.0, 2.6, 9.9, 2.6, 0.1, 6.0, 4.0, 0.5, 9.6]);
  for (const t of times) {
    assert.strictEqual(shuffled[t], forward[t], `frame at ${t}s differs when rendered out of order`);
    assert.strictEqual(revisited[t], forward[t], `frame at ${t}s differs after seeking elsewhere first`);
  }
});

test("grain changes every frame but repeats exactly for the same frame", async () => {
  const a = await frameHashes([1.0, 1.0 + 1 / 30]);
  const b = await frameHashes([1.0 + 1 / 30, 1.0]);
  assert.notStrictEqual(a[1.0], a[1.0 + 1 / 30], "consecutive frames should differ (grain)");
  assert.strictEqual(a[1.0], b[1.0]);
});

test("helpers push their sound cues", async () => {
  const { page, context } = await openComposition(browser, path.join(work, "index.html"));
  const cues = await page.evaluate(() => window.SFX);
  await context.close();
  const at = (type, t) => cues.some((c) => c.type === type && Math.abs(c.t - t) < 1e-6);
  assert.ok(at("hit", 0.5), "slam() pushes a hit");
  assert.ok(at("whoosh", 2.28), "a whip entry pushes a whoosh 0.12s before the cut");
  assert.ok(at("stamp", 3.95), "stamp() pushes a stamp");
  assert.ok(at("type", 4.95) && at("tick", 5.6), "typer() and counter() push type and tick");
  assert.strictEqual(cues.filter((c) => c.type === "pop" && c.t >= 7.55 && c.t < 8.2).length, 3, "stagger() pushes one pop per element");
  assert.deepStrictEqual(cues.map((c) => c.t), cues.map((c) => c.t).slice().sort((x, y) => x - y), "cues are sorted by time");
});

test("check flags text that runs off the frame", async () => {
  const html = path.join(work, "index.html");
  const original = fs.readFileSync(html, "utf8");
  fs.writeFileSync(html, original.replace("<p class=\"md\" id=\"s01b\">voice in, picture out</p>",
    "<p class=\"xl\" id=\"s01b\" style=\"white-space:nowrap\">voice in, picture out</p>"));
  try {
    let out = "";
    try { execFileSync("node", [CLI, "check", work], { encoding: "utf8" }); } catch (e) { out = e.stdout; }
    assert.match(out, /s01b.*runs past the frame edge/);
  } finally {
    fs.writeFileSync(html, original);
  }
});
