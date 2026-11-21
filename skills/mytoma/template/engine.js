/* myToma engine — one paused GSAP timeline, sampled at exact times.
 *
 * The composition (index.html) sets window.COMP and window.BRAND, loads gsap.min.js and this file,
 * authors its shots with the helpers below, then calls MT.finish(). The renderer then:
 *   await window.MT_READY;          // fonts and images loaded
 *   window.renderAt(t);             // every frame is a pure function of t
 *
 * Rules every helper follows (and every plug-in must follow):
 *   - all motion lives on `tl` (paused) or is drawn by a drawer from t alone;
 *   - nothing reads the wall clock, and randomness comes from MT.rand (seeded);
 *   - anything that makes noise pushes its own cue into SFX.
 */
(function () {
  "use strict";

  const C = Object.assign({ width: 1080, height: 1920, fps: 30, duration: 10, seed: 1 }, window.COMP || {});
  const W = C.width, H = C.height, FPS = C.fps, D = C.duration;

  /* ---------- determinism ---------- */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // A PRNG keyed by a number (a frame index, a time, an element index): same key, same value, any order.
  function rand(key, salt = 0) {
    return mulberry32(((key * 1000003) ^ (salt * 7919) ^ (C.seed * 104729)) | 0)();
  }
  // Math.random would make every render differ; route it through the seed and say so once.
  const seededRandom = mulberry32(C.seed);
  let warnedRandom = false;
  Math.random = function () {
    if (!warnedRandom) { console.warn("[mytoma] Math.random() used: seeded for determinism; use MT.rand(key) instead"); warnedRandom = true; }
    return seededRandom();
  };

  gsap.ticker.lagSmoothing(0);
  // 2D transforms only. force3D would promote tweening elements to GPU layers, and Chromium re-uses a
  // layer's raster from earlier frames: the same t would render differently depending on seek order.
  gsap.config({ force3D: false });
  gsap.globalTimeline.pause();           // stray tweens outside `tl` freeze instead of running on the wall clock
  const tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });

  /* ---------- registries ---------- */

  const SFX = [];          // {t, type, ...} sound cues, read by `cli.js cues`
  const SHOTS = [];        // {id, s, e}
  const DRAWERS = [];      // fn(t) called after every seek: plug-ins draw here
  const NOCAP = [];        // [a, b] ranges with captions hidden (used from step 3)

  function cue(t, type, opts = {}) {
    if (t < 0 || t > D) return;
    SFX.push(Object.assign({ t: Math.round(t * 1000) / 1000, type }, opts));
  }
  function addDrawer(fn) { DRAWERS.push(fn); }

  const $ = (sel) => (typeof sel === "string" ? document.querySelector(sel) : sel);
  const $$ = (sel) => (typeof sel === "string" ? Array.from(document.querySelectorAll(sel)) : [].concat(sel));
  function must(sel, helper) {
    const els = $$(sel);
    if (!els.length || !els[0]) throw new Error(`${helper}(): no element matches ${sel}`);
    return els;
  }

  /* ---------- shots ---------- */

  // shot("s01", 0, 2.3, "whip") — the shot's element is visible for [s, e) and enters with `enter`.
  function shot(id, s, e, enter = "cut") {
    const el = must("#" + id, "shot")[0];
    if (!(e > s)) throw new Error(`shot(${id}): out ${e} must be after in ${s}`);
    SHOTS.push({ id, s, e });
    const whoosh = () => cue(s - 0.12, "whoosh");
    switch (enter) {
      case "cut": break;
      case "fade": tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.35, ease: "power1.out" }, s); break;
      case "whip": tl.fromTo(el, { xPercent: 40, filter: "blur(30px)" }, { xPercent: 0, filter: "blur(0px)", duration: 0.28, ease: "expo.out" }, s); whoosh(); break;
      case "whipUp": tl.fromTo(el, { yPercent: 30, filter: "blur(30px)" }, { yPercent: 0, filter: "blur(0px)", duration: 0.28, ease: "expo.out" }, s); whoosh(); break;
      case "slide": tl.fromTo(el, { xPercent: 100 }, { xPercent: 0, duration: 0.45, ease: "power3.out" }, s); whoosh(); break;
      case "zoom": tl.fromTo(el, { scale: 1.5, opacity: 0, filter: "blur(24px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.35, ease: "expo.out" }, s); whoosh(); break;
      case "flash": hit(s, 0.5); break;
      default: throw new Error(`shot(${id}): unknown enter "${enter}"`);
    }
  }

  /* ---------- kinetic type ---------- */

  function slam(sel, t, power = 1) {
    tl.fromTo(must(sel, "slam"), { scale: 2.2, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.22, ease: "expo.out" }, t);
    hit(t, power);
  }
  function pop(sel, t, d = 0.35) {
    tl.fromTo(must(sel, "pop"), { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: d, ease: "back.out(2)" }, t);
    cue(t, "pop");
  }
  function rise(sel, t, d = 0.45) {
    tl.fromTo(must(sel, "rise"), { y: 70, opacity: 0 }, { y: 0, opacity: 1, duration: d }, t);
  }
  function fadeIn(sel, t, d = 0.4) {
    tl.fromTo(must(sel, "fadeIn"), { opacity: 0 }, { opacity: 1, duration: d, ease: "power1.out" }, t);
  }
  // stagger("#s04 .word", 7.2, 0.18) — each element pops in turn, one cue per element
  function stagger(sel, t, gap = 0.12, kind = "pop") {
    must(sel, "stagger").forEach((el, i) => (kind === "rise" ? rise(el, t + i * gap) : pop(el, t + i * gap)));
  }
  function stamp(sel, t) {
    tl.fromTo(must(sel, "stamp"), { scale: 3, opacity: 0, rotation: -14 }, { scale: 1, opacity: 1, rotation: -6, duration: 0.2, ease: "expo.out" }, t);
    cue(t, "stamp");
    shake(t, 0.5);
  }
  // highlight box sweeping behind the text (element needs class "hl")
  function highlight(sel, t, d = 0.35) {
    tl.fromTo(must(sel, "highlight"), { "--hl": 0 }, { "--hl": 1, duration: d, ease: "power2.inOut" }, t);
    cue(t, "whoosh", { gain: 0.5 });
  }
  // strike-through drawn across the text (element needs class "strike")
  function strike(sel, t, d = 0.25) {
    tl.fromTo(must(sel, "strike"), { "--strike": 0 }, { "--strike": 1, duration: d, ease: "power2.out" }, t);
    hit(t, 0.6);
  }

  /* ---------- camera ---------- */

  // Shake #cam and flash the frame. Offsets come from MT.rand keyed by t, so every render shakes the same.
  function shake(t, power = 1) {
    const amp = 22 * power * (C.theme?.shake ?? 1);
    if (amp <= 0) return;
    const key = Math.round(t * 1000);
    const frames = [0, 1, 2, 3].map((i) => ({
      x: (rand(key, i * 2) - 0.5) * 2 * amp * (1 - i / 4),
      y: (rand(key, i * 2 + 1) - 0.5) * 2 * amp * (1 - i / 4),
      duration: 0.045,
    }));
    tl.to("#cam", { keyframes: frames.concat({ x: 0, y: 0, duration: 0.06 }), ease: "none", immediateRender: false }, t);
  }
  function hit(t, power = 1) {
    cue(t, "hit", { power });
    shake(t, power);
    const flash = 0.55 * power * (C.theme?.flash ?? 1);
    if (flash > 0) tl.fromTo("#flash", { opacity: flash }, { opacity: 0, duration: 0.3, ease: "power2.out", immediateRender: false }, t);
  }
  function kenBurns(sel, s, e, dir = "in") {
    const from = { in: { scale: 1 }, out: { scale: 1.14 }, left: { scale: 1.12, xPercent: 4 }, right: { scale: 1.12, xPercent: -4 } }[dir];
    const to = { in: { scale: 1.14 }, out: { scale: 1 }, left: { scale: 1.12, xPercent: -4 }, right: { scale: 1.12, xPercent: 4 } }[dir];
    if (!from) throw new Error(`kenBurns(): unknown direction "${dir}"`);
    tl.fromTo(must(sel, "kenBurns"), from, Object.assign({ duration: e - s, ease: "none" }, to), s);
  }
  function drift(sel, s, e, from, to) {
    tl.fromTo(must(sel, "drift"), from, Object.assign({ duration: e - s, ease: "none" }, to), s);
  }
  // Slow push on a held element, from scale 1 to `to`
  function punchIn(sel, s, e, to = 1.08) {
    tl.fromTo(must(sel, "punchIn"), { scale: 1 }, { scale: to, duration: e - s, ease: "sine.inOut" }, s);
  }

  /* ---------- t-driven text (drawers, not tweens) ---------- */

  // typer("#s03cmd", "renderAt(t)", 5.0, 6.2) — characters appear across [s, e), with a caret
  function typer(sel, text, s, e, caret = true) {
    const el = must(sel, "typer")[0];
    addDrawer((t) => {
      const k = Math.max(0, Math.min(1, (t - s) / (e - s)));
      const n = Math.round(k * text.length);
      const blink = caret && Math.floor(t * 2) % 2 === 0 && t < e + 1.5;
      el.textContent = text.slice(0, n) + (blink ? "▌" : caret ? " " : "");
    });
    cue(s, "type", { dur: e - s });
  }
  // counter("#n", 0, 300, 4.8, 6.0, {sep: true, suffix: " fps"}) — number eases from→to across [s, e)
  function counter(sel, from, to, s, e, opts = {}) {
    const el = must(sel, "counter")[0];
    const ease = gsap.parseEase(opts.ease || "power2.out");
    const decimals = opts.decimals || 0;
    addDrawer((t) => {
      const k = ease(Math.max(0, Math.min(1, (t - s) / (e - s))));
      let v = (from + (to - from) * k).toFixed(decimals);
      if (opts.sep) v = Number(v).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      el.textContent = (opts.prefix || "") + v + (opts.suffix || "");
    });
    cue(s, "tick", { dur: e - s });
  }
  // Sound-only cues for beats with no element: a riser into a reveal, a "down" out of one
  function riser(s, e) { cue(s, "riser", { dur: e - s }); }
  function down(s, e) { cue(s, "down", { dur: e - s }); }

  /* ---------- film finish ---------- */

  // Grain is redrawn per frame from MT.rand keyed by the frame index: deterministic, any order.
  function grainDrawer() {
    const canvas = document.getElementById("grain");
    if (!canvas || !(C.theme?.grain ?? 0.06)) return;
    const gw = Math.round(W / 3), gh = Math.round(H / 3);
    canvas.width = gw; canvas.height = gh;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(gw, gh);
    const px = img.data;
    addDrawer((t) => {
      const next = mulberry32(Math.round(t * FPS) * 2654435761 + C.seed);
      for (let i = 0; i < px.length; i += 4) {
        const v = (next() * 255) | 0;
        px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
  }

  /* ---------- brand ---------- */

  function applyBrand() {
    const B = window.BRAND || {};
    const c = B.colors || {};
    const root = document.documentElement.style;
    const set = (name, value) => value && root.setProperty(name, value);
    set("--brand-primary", c.primary);
    set("--brand-secondary", c.secondary || c.primary);
    set("--brand-bg", c.bg);
    set("--brand-text", c.text);
    set("--brand-muted", c.muted);
    set("--brand-surface", c.surface);
    set("--brand-success", c.success);
    set("--brand-error", c.error);
    root.setProperty("--W", W + "px");
    root.setProperty("--H", H + "px");
    document.documentElement.dataset.format = W > H ? "landscape" : W === H ? "square" : H / W > 1.5 ? "vertical" : "portrait";
    if (C.theme?.grain !== undefined) root.setProperty("--grain", C.theme.grain);
  }

  /* ---------- render entry points ---------- */

  function renderAt(t) {
    t = Math.max(0, Math.min(D, t));
    tl.seek(t, true);
    for (const s of SHOTS) {
      const el = document.getElementById(s.id);
      el.style.visibility = t >= s.s && t < s.e ? "visible" : "hidden";
    }
    for (const fn of DRAWERS) fn(t);
    return t;
  }

  async function ready() {
    const fams = getComputedStyle(document.documentElement).getPropertyValue("--fonts-to-load").trim();
    const loads = fams ? fams.split(",").map((spec) => document.fonts.load(spec.trim().replace(/^"|"$/g, ""))) : [];
    await Promise.all(loads);
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map((img) => (img.complete ? img.decode().catch(() => {}) : new Promise((r) => { img.onload = img.onerror = r; }).then(() => img.decode().catch(() => {})))));
    const broken = Array.from(document.images).filter((img) => !img.naturalWidth).map((img) => img.getAttribute("src"));
    if (broken.length) throw new Error("images failed to load: " + broken.join(", "));
    renderAt(0);
    return true;
  }

  // Layout check for `cli.js check`: text outside the frame or the safe margin, shots that render nothing.
  function check(t) {
    renderAt(t);
    const issues = [];
    const margin = C.safe ?? Math.round(Math.min(W, H) * 0.04);
    const active = SHOTS.filter((s) => t >= s.s && t < s.e);
    for (const s of active) {
      const root = document.getElementById(s.id);
      const textEls = Array.from(root.querySelectorAll("*")).filter((el) =>
        Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim()));
      for (const el of textEls) {
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || Number(cs.opacity) < 0.05 || el.closest("[data-check=off]")) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const label = (el.id ? "#" + el.id : el.className ? "." + String(el.className).split(" ")[0] : el.tagName.toLowerCase()) + ` "${el.textContent.trim().slice(0, 24)}"`;
        if (r.left < 0 || r.top < 0 || r.right > W || r.bottom > H) issues.push(`${s.id} @${t.toFixed(2)}s: ${label} runs past the frame edge`);
        else if (r.left < margin || r.top < margin || r.right > W - margin || r.bottom > H - margin) issues.push(`${s.id} @${t.toFixed(2)}s: ${label} is inside the ${margin}px safe margin`);
        if (el.scrollWidth > el.clientWidth + 2 && cs.overflow !== "visible") issues.push(`${s.id} @${t.toFixed(2)}s: ${label} overflows its box`);
      }
      const visible = Array.from(root.querySelectorAll("*")).some((el) => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && Number(cs.opacity) > 0.05 && cs.visibility !== "hidden";
      });
      if (!visible) issues.push(`${s.id} @${t.toFixed(2)}s: renders nothing visible`);
    }
    // GPU layers keep raster from earlier frames, so the same t renders differently by seek order
    for (const el of document.querySelectorAll("#world *")) {
      if (el.tagName === "CANVAS") continue;
      const cs = getComputedStyle(el);
      const id = el.id ? "#" + el.id : el.tagName.toLowerCase();
      if (cs.willChange !== "auto") issues.push(`${id}: will-change: ${cs.willChange} makes frames depend on seek order; remove it`);
      if (cs.transform.startsWith("matrix3d")) issues.push(`${id}: 3D transform (${cs.transform.slice(0, 24)}…) makes frames depend on seek order; use 2D transforms`);
    }
    return issues;
  }

  function finish() {
    if (!SHOTS.length) throw new Error("no shots: call shot() for each shot before MT.finish()");
    SHOTS.sort((a, b) => a.s - b.s);
    for (let i = 1; i < SHOTS.length; i++) {
      if (SHOTS[i].s < SHOTS[i - 1].e - 1e-6) console.warn(`[mytoma] ${SHOTS[i].id} starts before ${SHOTS[i - 1].id} ends (overlap is allowed, but check it is intended)`);
    }
    SFX.sort((a, b) => a.t - b.t);
    grainDrawer();
    window.MT_INFO = { width: W, height: H, fps: FPS, duration: D, frames: Math.round(D * FPS), shots: SHOTS.slice() };
    window.MT_READY = ready();
  }

  applyBrand();

  const MT = { tl, cue, addDrawer, rand, shot, slam, pop, rise, fadeIn, stagger, stamp, highlight, strike, shake, hit,
    kenBurns, drift, punchIn, typer, counter, riser, down, renderAt, check, finish, SFX, SHOTS, NOCAP, W, H, FPS, D };
  window.MT = MT;
  window.renderAt = renderAt;
  window.SFX = SFX;
  // Helpers as globals, so a composition reads like a shot list: shot(...); slam(...); hit(...)
  for (const k of ["tl", "cue", "addDrawer", "shot", "slam", "pop", "rise", "fadeIn", "stagger", "stamp", "highlight",
    "strike", "shake", "hit", "kenBurns", "drift", "punchIn", "typer", "counter", "riser", "down"]) window[k] = MT[k];
})();
