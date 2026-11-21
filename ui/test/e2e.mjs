// End to end through the browser, the way a person uses the studio:
//   log in → create a project → upload a take → transcribe → mark a stretch from the transcript → preview.
// Needs a running studio and a take:  MYTOMA_URL=http://127.0.0.1:4173 MYTOMA_PASSWORD=… node test/e2e.mjs take.mp4
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("../../skills/mytoma/scripts/node_modules/playwright-core");
const { findChrome } = require("../../skills/mytoma/scripts/lib/browser.js");

const url = process.env.MYTOMA_URL || "http://127.0.0.1:4173";
const take = process.argv[2];
const shots = process.env.SHOTS_DIR;
if (!take || !fs.existsSync(take)) { console.error("usage: node test/e2e.mjs <take.mp4>"); process.exit(2); }
const step = (s) => console.log(`· ${s}`);

const browser = await chromium.launch({ executablePath: findChrome(), args: ["--no-first-run", "--disable-background-networking"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(url);
  if (await page.$('input[type=password]')) {
    await page.fill('input[type=password]', process.env.MYTOMA_PASSWORD || "");
    await page.click('button:has-text("Log in")');
    step("logged in");
  }
  await page.fill('input[placeholder^="e.g."]', `E2E ${Date.now()}`);
  await page.click('button:has-text("Create")');
  await page.waitForSelector(".editor");
  step("project created");
  await page.setInputFiles('.drop input[type=file]', take);
  await page.waitForFunction(() => document.querySelector(".tab-body")?.textContent.includes(".mp4"), null, { timeout: 120000 });
  step("take uploaded");
  await page.click('.step:has-text("Transcribe, trim and caption") button');
  await page.waitForFunction(() => /Transcribe, trim and caption(done|failed)/.test(document.querySelector(".jobs header")?.textContent || ""), null, { timeout: 600000 });
  const status = await page.textContent(".jobs header");
  if (!/done/.test(status)) throw new Error("transcription failed: " + (await page.textContent(".jobs pre")));
  step("transcribed, trimmed, captioned");
  await page.click('.tabs button:has-text("Transcript")');
  const words = await page.$$(".transcript .w");
  if (words.length < 3) throw new Error("no transcript words");
  const a = await words[0].boundingBox(), b = await words[2].boundingBox();
  await page.mouse.move(a.x + 4, a.y + 8); await page.mouse.down();
  await page.mouse.move(b.x + 4, b.y + 8, { steps: 6 }); await page.mouse.up();
  await page.click('.selbar button:has-text("None")');
  await page.waitForSelector(".block.stretch.none");
  step("stretch marked from the transcript");
  await page.waitForFunction(() => !document.querySelector(".stage-msg"), null, { timeout: 60000 });
  await page.keyboard.press("Space"); await page.waitForTimeout(1200); await page.keyboard.press("Space");
  const tc = await page.textContent(".timecode");
  if (/^0:00\.00/.test(tc)) throw new Error("preview did not play");
  step(`preview played to ${tc.split(" /")[0]}`);
  if (shots) await page.screenshot({ path: `${shots}/e2e-final.png` });
  if (errors.length) throw new Error("page errors: " + errors.join("; "));
  console.log("e2e: ok");
} catch (e) {
  console.error("e2e: FAILED", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
