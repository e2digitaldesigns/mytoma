"use strict";
// photo(): full-frame, cover-cropped photos with a Ken Burns move and a brand tint, and the checks around them
// (WCAG AA contrast of text over a photo, a photo file missing from assets/, a photo with no credit).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { launch, openComposition, capture } = require("../lib/browser");

const CLI = path.join(__dirname, "..", "cli.js");
const FORMATS = { vertical: [1080, 1920], landscape: [1920, 1080], square: [1080, 1080], portrait: [1080, 1350] };
const hash = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
let root, browser;

function makeImage(file, colour, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=${size}`, "-frames:v", "1", file]);
}

// A work folder with one photo shot over [0, 2): `shots` and `timeline` replace the template's demo
function makeWork(name, { format = "vertical", shots, timeline, style = "", credits = true, captions = null }) {
  const work = path.join(root, name);
  execFileSync("node", [CLI, "new", work, "--format", format, "--duration", "2"], { stdio: "ignore" });
  makeImage(path.join(work, "assets", "white-01.jpg"), "white", "1600x1200");
  // a horizontal gradient, so the Ken Burns move changes pixels from frame to frame
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "gradients=s=1600x1200:c0=0x203040:c1=0xd0a070:x0=0:y0=0:x1=1600:y1=0",
    "-frames:v", "1", path.join(work, "assets", "gradient-01.jpg")]);
  if (credits) {
    fs.writeFileSync(path.join(work, "credits.json"), JSON.stringify(["white-01", "gradient-01"].map((stem) => ({
      file: `assets/${stem}.jpg`, title: stem, author: "test", source: "test", source_url: "", licence: "CC0 1.0", licence_url: "" }))));
  }
  if (captions) fs.writeFileSync(path.join(work, "words.js"), `window.CAPTIONS = ${JSON.stringify(captions)};\n`);
  const html = path.join(work, "index.html");
  let text = fs.readFileSync(html, "utf8");
  text = text.replace(/<!-- BEGIN SHOTS -->[\s\S]*<!-- END SHOTS -->/, `<!-- BEGIN SHOTS -->\n<style>${style}</style>\n${shots}\n<!-- END SHOTS -->`);
  text = text.replace(/\/\/ BEGIN TIMELINE[\s\S]*\/\/ END TIMELINE/, `// BEGIN TIMELINE\n${timeline}\n// END TIMELINE`);
  fs.writeFileSync(html, text);
  return work;
}

function check(work) {
  try {
    return { code: 0, output: execFileSync("node", [CLI, "check", work], { encoding: "utf8" }) };
  } catch (error) {
    return { code: error.status, output: String(error.stdout) + String(error.stderr) };
  }
}

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mytoma-photo-"));
  browser = await launch();
});
test.after(async () => {
  await browser?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a photo covers the whole frame in every format, behind the shot's text, all through its move", async () => {
  for (const [format, [width, height]] of Object.entries(FORMATS)) {
    for (const move of ["in", "left", "down"]) {
      const work = makeWork(`cover-${format}-${move}`, {
        format,
        shots: `<section class="shot" id="s01"><img id="p1" src="assets/gradient-01.jpg" alt=""><h1 class="lg" id="headline">headline</h1></section>`,
        timeline: `shot("s01", 0, 2); photo("#p1", 0, 2, {move: "${move}"}); MT.finish();`,
      });
      const { page, context } = await openComposition(browser, path.join(work, "index.html"));
      for (const time of [0, 1, 1.99]) {
        const layout = await page.evaluate((t) => {
          window.renderAt(t);
          const image = document.getElementById("p1");
          const box = image.getBoundingClientRect();
          const style = getComputedStyle(image);
          const headline = document.getElementById("headline").getBoundingClientRect();
          const onTop = document.elementFromPoint(headline.left + headline.width / 2, headline.top + headline.height / 2);
          return { box: [box.left, box.top, box.right, box.bottom], fit: style.objectFit, transform: style.transform,
            tints: document.querySelectorAll("#s01 .mt-photo-tint").length, headlineOnTop: onTop.id === "headline" };
        }, time);
        const where = `${format} ${move} @${time}s`;
        assert.ok(layout.box[0] <= 0.5 && layout.box[1] <= 0.5 && layout.box[2] >= width - 0.5 && layout.box[3] >= height - 0.5,
          `${where}: the photo leaves an edge of the frame uncovered: ${layout.box}`);
        assert.strictEqual(layout.fit, "cover", where);
        assert.ok(!layout.transform.startsWith("matrix3d"), `${where}: 2D transforms only`);
        assert.strictEqual(layout.tints, 2, `${where}: a colour wash and a shade from the brand`);
        assert.ok(layout.headlineOnTop, `${where}: the text sits above the photo`);
      }
      await context.close();
    }
  }
});

test("photo frames are a pure function of t: same pixels in any seek order", async () => {
  const work = makeWork("determinism", {
    shots: `<section class="shot" id="s01"><img id="p1" src="assets/gradient-01.jpg" alt=""><h1 class="lg">moving</h1></section>`,
    timeline: `shot("s01", 0, 2); photo("#p1", 0, 2, {move: "right", mono: true}); MT.finish();`,
  });
  const frames = async (order) => {
    const { page, context } = await openComposition(browser, path.join(work, "index.html"));
    const session = await context.newCDPSession(page);
    const result = {};
    for (const time of order) {
      await page.evaluate((t) => window.renderAt(t), time);
      result[time] = hash(await capture(page, session, { format: "png" }));
    }
    await context.close();
    return result;
  };
  const forward = await frames([0.2, 1.0, 1.8]);
  const backward = await frames([1.8, 0.2, 1.0, 0.2]);
  for (const time of [0.2, 1.0, 1.8]) assert.strictEqual(backward[time], forward[time], `frame at ${time}s differs by seek order`);
  assert.notStrictEqual(forward[0.2], forward[1.8], "the Ken Burns move changes the frame");
});

test("contrast ratios follow WCAG", async () => {
  const work = makeWork("ratio", {
    shots: `<section class="shot" id="s01"><p class="md">x</p></section>`, timeline: `shot("s01", 0, 2); MT.finish();`,
  });
  const { page, context } = await openComposition(browser, path.join(work, "index.html"));
  const ratios = await page.evaluate(() => [MT.contrastRatio([255, 255, 255], [0, 0, 0]), MT.contrastRatio([118, 118, 118], [255, 255, 255])]);
  await context.close();
  assert.ok(Math.abs(ratios[0] - 21) < 1e-9);
  assert.ok(Math.abs(ratios[1] - 4.54) < 0.01, `#767676 on white is 4.54:1, got ${ratios[1]}`);
});

test("check fails text over a photo below WCAG AA, and passes it once the tint is strong enough", () => {
  const shots = `<section class="shot" id="s01"><img id="p1" src="assets/white-01.jpg" alt="">
    <p id="small" style="font-size:36px;font-weight:500;color:var(--brand-text);margin:0">small print over the photo</p>
    <h1 class="xl" id="big" style="font-size:150px">big</h1></section>`;
  const bare = check(makeWork("contrast-bare", { shots, timeline: `shot("s01", 0, 2); photo("#p1", 0, 2, {tint: "none"}); MT.finish();` }));
  assert.strictEqual(bare.code, 1, bare.output);
  assert.match(bare.output, /s01: #small "small print over the pho" over a photo has 1\.\d:1 contrast, needs 4\.5:1 \(WCAG AA\)/);
  assert.match(bare.output, /s01: #big "big" over a photo has 1\.\d:1 contrast, needs 3:1 \(WCAG AA, large text\)/);
  // a light tint fixes the big type (3:1) but not the small print (4.5:1)
  const light = check(makeWork("contrast-light", { shots, timeline: `shot("s01", 0, 2); photo("#p1", 0, 2, {tint: "dark", strength: 0.5}); MT.finish();` }));
  assert.doesNotMatch(light.output, /#big/, light.output);
  assert.match(light.output, /#small .* needs 4\.5:1/, light.output);
  const strong = check(makeWork("contrast-strong", { shots, timeline: `shot("s01", 0, 2); photo("#p1", 0, 2, {tint: "brand", strength: 0.72}); MT.finish();` }));
  assert.strictEqual(strong.code, 0, strong.output);
  assert.match(strong.output, /^clean/m);
});

test("captions over a photo need 4.5:1; their outline counts", () => {
  const captions = { words: [{ w: "readable", s: 0.1, e: 1.9 }], phrases: [{ a: 0, b: 1, s: 0.1, e: 1.9 }] };
  const shots = `<section class="shot" id="s01"><img id="p1" src="assets/white-01.jpg" alt=""></section>`;
  const timeline = `shot("s01", 0, 2); photo("#p1", 0, 2, {tint: "none"}); MT.finish();`;
  // the theme's caption outline is near-black: readable on a white photo
  const outlined = check(makeWork("captions-outlined", { shots, timeline, captions }));
  assert.doesNotMatch(outlined.output, /captions "readable"/, outlined.output);
  // without the outline, bone-white caption words on a white photo fail
  const bare = check(makeWork("captions-bare", { shots, timeline, captions,
    style: ".cap-line, .cap-line .w { -webkit-text-stroke: 0 !important; text-shadow: none !important; } .cap-line .w.on { background: none !important; color: var(--brand-text) !important; }" }));
  assert.strictEqual(bare.code, 1, bare.output);
  assert.match(bare.output, /captions: captions "readable" over a photo has 1\.\d:1 contrast, needs 4\.5:1 \(WCAG AA\)/);
});

test("check flags a photo missing from assets/ and a photo with no credit", () => {
  const missing = check(makeWork("missing", {
    shots: `<section class="shot" id="s01"><img id="p1" src="assets/fries-01.jpg" alt=""><h1 class="lg">fries</h1></section>`,
    timeline: `shot("s01", 0, 2); photo("#p1", 0, 2); MT.finish();`,
  }));
  assert.strictEqual(missing.code, 1, missing.output);
  assert.match(missing.output, /#p1 \(0-2s\): photo assets\/fries-01\.jpg is missing from assets\//);
  assert.doesNotMatch(missing.output, /PAGE ERROR/);
  const uncredited = check(makeWork("uncredited", {
    credits: false,
    shots: `<section class="shot" id="s01"><img id="p1" src="assets/white-01.jpg" alt=""><h1 class="lg">snow</h1></section>`,
    timeline: `shot("s01", 0, 2); photo("#p1", 0, 2, {strength: 0.8}); MT.finish();`,
  }));
  assert.match(uncredited.output, /photo assets\/white-01\.jpg has no entry in credits\.json/);
});

test("render refuses to start with a photo missing", () => {
  const work = makeWork("render-missing", {
    shots: `<section class="shot" id="s01"><img id="p1" src="assets/nope.jpg" alt=""><h1 class="lg">x</h1></section>`,
    timeline: `shot("s01", 0, 2); photo("#p1", 0, 2); MT.finish();`,
  });
  assert.throws(() => execFileSync("node", [CLI, "stills", work, "0.5"], { encoding: "utf8", stdio: "pipe" }), /Missing photos: assets\/nope\.jpg/);
});
