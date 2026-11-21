"use strict";
// Headless Chromium for rendering: find a browser, open a composition, wait until it is ready.

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright-core");

const SYSTEM_CHROMES = [
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

// MYTOMA_CHROME, then Playwright's own build (setup.sh installs it), then a system Chrome/Chromium.
function findChrome() {
  if (process.env.MYTOMA_CHROME) {
    if (!fs.existsSync(process.env.MYTOMA_CHROME)) throw new Error(`MYTOMA_CHROME points at a missing file: ${process.env.MYTOMA_CHROME}`);
    return process.env.MYTOMA_CHROME;
  }
  try {
    const own = chromium.executablePath();
    if (own && fs.existsSync(own)) return own;
  } catch (_) { /* not installed */ }
  const system = SYSTEM_CHROMES.find((p) => fs.existsSync(p));
  if (system) return system;
  throw new Error("No Chromium found. Run scripts/setup.sh, or set MYTOMA_CHROME to a Chrome/Chromium binary.");
}

const ARGS = [
  "--force-color-profile=srgb",      // colours as authored, not the machine's display profile
  "--font-render-hinting=none",      // identical glyph shapes on every machine
  "--disable-lcd-text",
  "--hide-scrollbars",
  "--allow-file-access-from-files",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--mute-audio",
];

async function launch() {
  const executablePath = findChrome();
  const extra = (process.env.MYTOMA_CHROME_ARGS || "").split(" ").filter(Boolean); // e.g. GPU flags on a desktop
  return chromium.launch({ executablePath, headless: true, args: ARGS.concat(extra) });
}

// Open index.html at `scale` device pixels per CSS pixel; resolves once fonts and images are loaded.
async function openComposition(browser, html, { scale = 1 } = {}) {
  const file = path.resolve(html);
  if (!fs.existsSync(file)) throw new Error(`Composition not found: ${file}`);
  // Read the canvas size from the COMP block so the viewport matches before the page loads
  const comp = readComp(file);
  const context = await browser.newContext({ viewport: { width: comp.width, height: comp.height }, deviceScaleFactor: scale });
  const page = await context.newPage();
  const errors = [];
  const warnings = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
    if (m.type() === "warning" && m.text().startsWith("[mytoma]")) warnings.push(m.text());
  });
  page.on("requestfailed", (r) => errors.push(`failed to load ${r.url().replace(pathToFileURL(path.dirname(file)).href + "/", "")}`));
  await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
  if (errors.length) throw new Error("PAGE ERROR\n  " + errors.join("\n  "));
  const ok = await page.evaluate(() => typeof window.renderAt === "function" && !!window.MT_READY);
  if (!ok) throw new Error("Composition did not initialise: window.renderAt or MT_READY missing (did the timeline call MT.finish()?)");
  try {
    await page.evaluate(() => window.MT_READY);
  } catch (e) {
    throw new Error("Composition failed to become ready: " + e.message);
  }
  if (errors.length) throw new Error("PAGE ERROR\n  " + errors.join("\n  "));
  const info = await page.evaluate(() => window.MT_INFO);
  return { page, context, info, errors, warnings };
}

function readComp(file) {
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/window\.COMP\s*=\s*(\{.*?\});/s);
  if (!m) throw new Error(`${file}: no window.COMP block (BEGIN COMP … END COMP)`);
  return JSON.parse(m[1]);
}

// One frame as image bytes. CDP's optimizeForSpeed skips the slow PNG compression level; the bytes are
// still lossless.
async function capture(page, cdp, { format = "png", quality = 92 } = {}) {
  const params = { format, captureBeyondViewport: false, optimizeForSpeed: true };
  if (format === "jpeg") params.quality = quality;
  const { data } = await cdp.send("Page.captureScreenshot", params);
  return Buffer.from(data, "base64");
}

module.exports = { findChrome, launch, openComposition, readComp, capture };
