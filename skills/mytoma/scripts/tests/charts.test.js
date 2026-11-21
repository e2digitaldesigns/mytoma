"use strict";
// Infographics: the example builds, its layout is clean, and every chart frame is a pure function of t.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { launch, openComposition, capture } = require("../lib/browser");

const CLI = path.join(__dirname, "..", "cli.js");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let work, browser;

test.before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "mytoma-charts-"));
  execFileSync("node", [CLI, "new", work, "--example", "infographics", "--duration", "21"], { stdio: "ignore" });
  browser = await launch();
});
test.after(async () => { await browser?.close(); fs.rmSync(work, { recursive: true, force: true }); });

test("the infographics example passes check", () => {
  const out = execFileSync("node", [CLI, "check", work], { encoding: "utf8" });
  assert.match(out, /^clean · 5 shots/m);
});

test("chart frames are identical in any seek order", async () => {
  // mid-bar-growth, mid-line-draw, mid-donut-sweep, mid-camera-move, mid-route, mid-date-typing
  const times = [1.3, 6.1, 9.4, 13.8, 15.1, 17.9];
  async function hashes(order) {
    const { page, context } = await openComposition(browser, path.join(work, "index.html"));
    const cdp = await context.newCDPSession(page);
    const out = {};
    for (const t of order) { await page.evaluate((t) => window.renderAt(t), t); out[t] = sha(await capture(page, cdp)); }
    await context.close();
    return out;
  }
  const a = await hashes(times);
  const b = await hashes(times.slice().reverse());
  const c = await hashes([20.9, 13.8, 0, 6.1, 15.1, 1.3, 17.9, 9.4]);
  for (const t of times) {
    assert.strictEqual(b[t], a[t], `frame at ${t}s differs in reverse order`);
    assert.strictEqual(c[t], a[t], `frame at ${t}s differs in shuffled order`);
  }
});

test("chart helpers push their sound cues", async () => {
  const { page, context } = await openComposition(browser, path.join(work, "index.html"));
  const cues = await page.evaluate(() => window.SFX);
  await context.close();
  const n = (type, a, b) => cues.filter((c) => c.type === type && c.t >= a && c.t < b).length;
  assert.strictEqual(n("pop", 0.9, 2.0), 5, "one pop per bar");
  assert.strictEqual(n("pop", 8.9, 10.5), 3, "one pop per donut segment");
  assert.strictEqual(n("impact.soft", 14, 16), 2, "one impact per highlighted country");
  assert.strictEqual(n("foley.typewriter", 17, 20), 4, "one typewriter run per date");
});

test("an unknown country name fails loudly", async () => {
  const html = path.join(work, "index.html");
  const orig = fs.readFileSync(html, "utf8");
  fs.writeFileSync(html, orig.replace('{ name: "Germany", at: 15.6 }', '{ name: "Germanyy", at: 15.6 }'));
  try {
    await assert.rejects(openComposition(browser, html), /no country named "Germanyy"/);
  } finally { fs.writeFileSync(html, orig); }
});
