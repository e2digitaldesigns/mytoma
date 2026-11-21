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
  // Any library entry by id, e.g. sfx(4.2, "impact.heavy") or sfx(6, "foley.shutter", {gain: 0.6})
  function sfx(t, entry, opts = {}) { cue(t, entry, opts); }
  // A loop under a stretch: bed(0, 12, "texture.projector") · bed(30, 41, "bed.heartbeat", {gain: 0.5})
  function bed(s, e, entry, opts = {}) { cue(s, entry, Object.assign({ dur: e - s }, opts)); }

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
    set("--cap-on", c.capOn);           // caption pill behind the spoken word
    set("--cap-on-text", c.capOnText);  // the spoken word's text on that pill
    root.setProperty("--W", W + "px");
    root.setProperty("--H", H + "px");
    document.documentElement.dataset.format = W > H ? "landscape" : W === H ? "square" : H / W > 1.5 ? "vertical" : "portrait";
    if (C.theme?.grain !== undefined) root.setProperty("--grain", C.theme.grain);
  }

  /* ---------- render entry points ---------- */

  // Returns t, or a promise of t when a drawer has to wait (an image decoding): the renderer awaits it
  // before the screenshot, so a frame never shows the previous frame's image.
  function renderAt(t) {
    t = Math.max(0, Math.min(D, t));
    tl.seek(t, true);
    for (const s of SHOTS) {
      const el = document.getElementById(s.id);
      el.style.visibility = t >= s.s && t < s.e ? "visible" : "hidden";
    }
    const pending = [];
    for (const fn of DRAWERS) {
      const r = fn(t);
      if (r && typeof r.then === "function") pending.push(r);
    }
    return pending.length ? Promise.all(pending).then(() => t) : t;
  }

  async function ready() {
    const fams = getComputedStyle(document.documentElement).getPropertyValue("--fonts-to-load").trim();
    const loads = fams ? fams.split(",").map((spec) => document.fonts.load(spec.trim().replace(/^"|"$/g, ""))) : [];
    await Promise.all(loads);
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map((img) => (img.complete ? img.decode().catch(() => {}) : new Promise((r) => { img.onload = img.onerror = r; }).then(() => img.decode().catch(() => {})))));
    const unloaded = Array.from(document.images).filter((img) => !img.dataset.frames && !img.naturalWidth);
    // a missing photo is a check finding (and render refuses to start); any other broken image fails the page
    window.MT_INFO.missingPhotos = unloaded.filter((img) => img.classList.contains("mt-photo")).map((img) => img.getAttribute("src"));
    const broken = unloaded.filter((img) => !img.classList.contains("mt-photo")).map((img) => img.getAttribute("src"));
    if (broken.length) throw new Error("images failed to load: " + broken.join(", "));
    await renderAt(0);
    return true;
  }

  // Layout check for `cli.js check`: text outside the frame or the safe margin, shots that render nothing.
  // Is el (or an ancestor inside the shot) in the middle of a tween at t?
  function inMotion(el, root, t) {
    for (let n = el; n && n !== root.parentNode; n = n.parentNode) {
      if (gsap.getTweensOf(n).some((tw) => { const s = tw.startTime(); return t >= s && t < s + tw.duration(); })) return true;
    }
    return false;
  }

  // Opacity as seen: an element's own opacity times its ancestors' inside the shot. Before a slam starts, the
  // slammed heading sits at opacity 0 and scale 2.2, and its child spans (own opacity 1) must not count as on screen.
  function shownOpacity(el, root) {
    let o = 1;
    for (let n = el; n && n !== root.parentNode; n = n.parentNode) o *= Number(getComputedStyle(n).opacity);
    return o;
  }

  async function check(t) {
    await renderAt(t);
    const issues = [];
    const margin = C.safe ?? Math.round(Math.min(W, H) * 0.04);
    const active = SHOTS.filter((s) => t >= s.s && t < s.e);
    for (const s of active) {
      const root = document.getElementById(s.id);
      const textEls = Array.from(root.querySelectorAll("*")).filter((el) =>
        Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim()));
      for (const el of textEls) {
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || shownOpacity(el, root) < 0.05 || el.closest("[data-check=off]")) continue;
        if (inMotion(el, root, t)) continue;   // mid-slam scale etc.: judge the layout it lands on, not the transient
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
    // captions: inside the frame, and not over the face in a face shot is the author's call (nocap)
    const cap = document.getElementById("captions");
    if (cap && cap.style.visibility !== "hidden" && cap.textContent.trim()) {
      const r = cap.firstElementChild?.getBoundingClientRect();
      if (r && (r.left < margin || r.right > W - margin)) issues.push(`captions @${t.toFixed(2)}s: "${cap.textContent.trim().slice(0, 30)}" is wider than the safe area (shorter phrases: captions.py --max-chars)`);
    }
    return issues;
  }

  /* ---------- captions ---------- */

  // nocap(a, b): no captions in [a, b), for shots where the words on screen already say the line
  function nocap(a, b) { NOCAP.push([a, b]); }

  // The caption layer reads window.CAPTIONS (words.js, from captions.py) and draws from t alone: the
  // current phrase pops in, words light up as they are spoken, keywords keep the accent colour.
  function captionsDrawer() {
    const data = window.CAPTIONS;
    if (!data || !data.phrases || !data.phrases.length) return;
    let layer = document.getElementById("captions");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "captions";
      document.getElementById("world").insertBefore(layer, document.getElementById("flash"));
    }
    const line = document.createElement("div");
    line.className = "cap-line";
    layer.appendChild(line);
    const P = data.phrases, Wd = data.words;
    let shown = -1, spans = [];
    const lead = 0.04, hold = 0.6;
    addDrawer((t) => {
      let idx = -1;
      for (let i = 0; i < P.length; i++) {
        const end = i + 1 < P.length ? Math.min(P[i + 1].s - lead, P[i].e + hold) : P[i].e + hold;
        if (t >= P[i].s - lead && t < end) { idx = i; break; }
      }
      const st = stretchAt(t);
      const hidden = idx < 0 || NOCAP.some(([a, b]) => t >= a && t < b) || (st && st.subtitles === false);
      layer.style.visibility = hidden ? "hidden" : "visible";
      if (hidden) return;
      if (idx !== shown) {                       // the phrase changed: rebuild its words (depends on idx only)
        line.textContent = "";
        spans = [];
        for (let j = P[idx].a; j < P[idx].b; j++) {
          const sp = document.createElement("span");
          sp.className = "w" + (Wd[j].k ? " key" : "");
          sp.textContent = Wd[j].w;
          line.appendChild(sp);
          line.appendChild(document.createTextNode(" "));
          spans.push([sp, Wd[j], Wd[j + 1]]);
        }
        shown = idx;
      }
      const k = Math.max(0, Math.min(1, (t - P[idx].s + lead) / 0.14));
      const pop = 0.82 + 0.18 * gsap.parseEase("back.out(2.2)")(k);
      line.style.transform = `scale(${pop.toFixed(4)})`;
      for (const [sp, w, nx] of spans) {
        const on = t >= w.s && t < (nx && nx.s - w.e < 0.35 ? nx.s : w.e + 0.15);
        sp.classList.toggle("said", t >= w.s);
        sp.classList.toggle("on", on);
      }
    });
  }

  /* ---------- edit marks (edit.js, written by the UI) ---------- */

  // window.EDIT = {
  //   stretches: [{a, b, level: "none" | "limited" | "full", subtitles: true}],
  //   chapters: [{a, b, title}],
  //   chapterStyle: {mode: "off" | "name" | "bar" | "both", position: "auto" | "top" | "bottom"}
  // }
  const EDIT = Object.assign({ stretches: [], chapters: [], chapterStyle: { mode: "both", position: "auto" } }, window.EDIT || {});
  function stretchAt(t) { return EDIT.stretches.find((s) => t >= s.a && t < s.b) || null; }

  // Chapters: the current chapter's name, a progress bar split into chapters, or both. Default placement
  // keeps clear of each platform's buttons: top for vertical/square/portrait, bottom for landscape.
  function chaptersDrawer() {
    const ch = (EDIT.chapters || []).slice().sort((x, y) => x.a - y.a);
    const style = Object.assign({ mode: "both", position: "auto" }, EDIT.chapterStyle || {});
    if (!ch.length || style.mode === "off") return;
    const pos = style.position === "auto" ? (W > H ? "bottom" : "top") : style.position;
    const layer = document.createElement("div");
    layer.id = "chapters";
    layer.className = `ch-${pos}`;
    const world = document.getElementById("world");
    world.insertBefore(layer, document.getElementById("flash"));
    if (pos === "bottom") document.documentElement.style.setProperty("--cap-top", W > H ? "70%" : "58%");
    const name = document.createElement("div");
    name.className = "ch-name";
    const bar = document.createElement("div");
    bar.className = "ch-bar";
    const segs = ch.map((c) => {
      const seg = document.createElement("div");
      seg.className = "ch-seg";
      seg.style.flex = `${Math.max(0.001, c.b - c.a)} 0 0`;
      const fill = document.createElement("div");
      fill.className = "ch-fill";
      seg.appendChild(fill);
      bar.appendChild(seg);
      return { c, seg, fill };
    });
    if (style.mode === "name" || style.mode === "both") layer.appendChild(name);
    if (style.mode === "bar" || style.mode === "both") layer.appendChild(bar);
    let shown = null;
    addDrawer((t) => {
      const cur = ch.find((c) => t >= c.a && t < c.b) || null;
      layer.style.visibility = cur ? "visible" : "hidden";
      if (!cur) return;
      if (shown !== cur) { name.textContent = cur.title; shown = cur; }
      // the name eases in over 0.35 s each time a chapter starts
      const k = Math.max(0, Math.min(1, (t - cur.a) / 0.35));
      name.style.opacity = String(k);
      name.style.transform = `translateY(${((1 - k) * (pos === "top" ? -16 : 16)).toFixed(2)}px)`;
      for (const s of segs) {
        const p = Math.max(0, Math.min(1, (t - s.c.a) / (s.c.b - s.c.a)));
        s.fill.style.transform = `scaleX(${p.toFixed(4)})`;
        s.seg.classList.toggle("on", s.c === cur);
      }
    });
  }

  // Does the authored timeline respect the marks? none = only the speaker's face (captions and chapters
  // are separate layers); limited = the face stays on screen, light graphics allowed; full = anything.
  async function checkEdit() {
    const issues = [];
    for (const st of EDIT.stretches || []) {
      if (st.level === "full") continue;
      const span = st.b - st.a;
      let noFace = false;
      const extras = new Set();
      for (const k of [0.1, 0.5, 0.9]) {
        const t = st.a + span * k;
        await renderAt(t);
        const live = SHOTS.filter((s) => t >= s.s && t < s.e).map((s) => document.getElementById(s.id));
        const visible = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          return r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05; };
        const faces = live.flatMap((root) => Array.from(root.querySelectorAll("img[data-frames]"))).filter(visible);
        if (!faces.length) noFace = true;
        if (st.level === "none") {
          live.flatMap((root) => Array.from(root.querySelectorAll("*")))
            .filter((el) => !el.matches("img[data-frames]") && !el.querySelector("img[data-frames]") && visible(el))
            .forEach((el) => extras.add(el.id ? "#" + el.id : String(el.className || el.tagName.toLowerCase()).split(" ")[0]));
        }
      }
      // one line per problem per stretch
      const label = `${st.level} stretch ${st.a.toFixed(2)}-${st.b.toFixed(2)}s`;
      if (noFace) issues.push(`${label}: the speaker's face is not on screen (it must be, in a ${st.level} stretch)`);
      if (extras.size) issues.push(`${label}: graphics on screen (${[...extras].slice(0, 5).join(", ")}); a none stretch shows only the face`);
    }
    return issues;
  }

  /* ---------- face shots ---------- */

  // faceCam("#face", a, b): plays the speaker's frames for [a, b) into an <img>. The frames come from
  // `take.py face <work> a-b`, use the same ranges. Each frame waits for its image to decode.
  function faceCam(sel, a, b, opts = {}) {
    const img = must(sel, "faceCam")[0];
    if (img.tagName !== "IMG") throw new Error(`faceCam(): ${sel} must be an <img>`);
    const dir = opts.dir || "face";
    const f0 = Math.round(a * FPS), f1 = Math.round(b * FPS);
    img.dataset.frames = `${f0}-${f1 - 1}`;
    addDrawer((t) => {
      if (t < a || t >= b) return;
      const f = Math.min(f1 - 1, Math.max(f0, Math.round(t * FPS)));
      if (img.dataset.f === String(f)) return;
      img.dataset.f = String(f);
      const src = `${dir}/f${String(f).padStart(5, "0")}.jpg`;
      img.src = src;
      return img.decode().catch(() => { throw new Error(`faceCam(): missing ${src}; run take.py face <work> ${a}-${b}`); });
    });
  }

  /* ---------- photos (find_media.py saves them into assets/) ---------- */

  const PHOTOS = [];   // {selector, source, start, end}
  const PHOTO_TINTS = ["brand", "dark", "none"];
  const PHOTO_MOVES = ["in", "out", "left", "right", "up", "down", "none"];

  // photo("#p02", 4.7, 8.6, {move: "in", tint: "brand", strength: 0.55, mono: false, focus: "50% 40%", zoom: 1.12})
  // A full-frame <img> behind the shot's text: cover-cropped for any format, a slow Ken Burns move across [start, end),
  // and a tint from the brand colours over it so the text stays readable (check measures that contrast).
  //   tint "brand": the photo takes the primary colour's hue, then darkens toward --brand-bg · "dark": darkens only
  //   strength: how far toward --brand-bg (0..1) · mono: black and white first (archival photos, engravings)
  function photo(selector, start, end, options = {}) {
    const image = must(selector, "photo")[0];
    if (image.tagName !== "IMG") throw new Error(`photo(): ${selector} must be an <img>`);
    if (!(end > start)) throw new Error(`photo(${selector}): end ${end} must be after start ${start}`);
    const settings = Object.assign({ move: "in", tint: "brand", strength: 0.55, mono: false, focus: "50% 50%", zoom: 1.12 }, options);
    if (!PHOTO_TINTS.includes(settings.tint)) throw new Error(`photo(${selector}): tint must be one of ${PHOTO_TINTS.join(", ")}`);
    if (!PHOTO_MOVES.includes(settings.move)) throw new Error(`photo(${selector}): move must be one of ${PHOTO_MOVES.join(", ")}`);
    const strength = Math.max(0, Math.min(1, Number(settings.strength)));
    const shotElement = image.closest(".shot");
    if (shotElement) shotElement.style.isolation = "isolate";   // the photo and its tint stay behind this shot's text only
    image.classList.add("mt-photo");
    image.loading = "eager";
    image.decoding = "sync";
    image.style.objectPosition = settings.focus;
    if (settings.mono) image.style.filter = "grayscale(1) contrast(1.08)";

    // tint layers sit right after the image, in paint order: the colour wash, then the shade
    let anchor = image;
    const layer = (className, background, extra = {}) => {
      const element = document.createElement("div");
      element.className = `mt-photo-tint ${className}`;
      element.style.background = background;
      Object.assign(element.style, extra);
      anchor.after(element);
      anchor = element;
    };
    if (settings.tint === "brand") layer("mt-photo-wash", "var(--brand-primary)", { mixBlendMode: "color", opacity: "0.6" });
    if (settings.tint !== "none" && strength > 0) {
      const percent = (value) => `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
      const shade = (value) => `color-mix(in srgb, var(--brand-bg) ${percent(value)}, transparent)`;
      // a little darker at the top and bottom, where headlines and captions sit
      layer("mt-photo-shade", `linear-gradient(180deg, ${shade(strength + 0.12)} 0%, ${shade(strength)} 30%, ${shade(strength)} 62%, ${shade(strength + 0.15)} 100%)`);
    }

    // Ken Burns: the image stays scaled to at least `zoom` while it pans, so its edges never show
    const zoom = Math.max(1.02, Number(settings.zoom) || 1.12);
    const travel = ((zoom - 1) / 2) * 100 * 0.8;
    const moves = {
      in: [{ scale: 1.02 }, { scale: zoom }],
      out: [{ scale: zoom }, { scale: 1.02 }],
      left: [{ scale: zoom, xPercent: travel }, { scale: zoom, xPercent: -travel }],
      right: [{ scale: zoom, xPercent: -travel }, { scale: zoom, xPercent: travel }],
      up: [{ scale: zoom, yPercent: travel }, { scale: zoom, yPercent: -travel }],
      down: [{ scale: zoom, yPercent: -travel }, { scale: zoom, yPercent: travel }],
    };
    if (settings.move !== "none") {
      const [from, to] = moves[settings.move];
      tl.fromTo(image, from, Object.assign({ duration: end - start, ease: "none" }, to), start);
    }

    PHOTOS.push({ selector: typeof selector === "string" ? selector : "#" + image.id, source: image.getAttribute("src") || "", start, end });
    // The frame is captured only once the photo has decoded (a fresh page, or Chromium dropping a decoded image)
    addDrawer((time) => {
      if (time < start || time >= end || !image.naturalWidth) return;
      return image.decode().catch(() => {});
    });
    return end;
  }

  /* ---------- contrast of text over photos (check) ---------- */

  // WCAG AA: 4.5:1, or 3:1 for large text (24px, or 18.66px bold, on a ~400px-wide phone screen, scaled to this
  // canvas). Captions always need 4.5:1.
  function relativeLuminance([red, green, blue]) {
    const channel = (value) => { const fraction = value / 255; return fraction <= 0.03928 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
  }
  function contrastRatio(first, second) {
    const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((one, other) => other - one);
    return (lighter + 0.05) / (darker + 0.05);
  }
  function parseColour(text) {
    const numbers = (String(text).match(/[\d.]+/g) || []).map(Number);
    const alpha = numbers[3] === undefined ? 1 : numbers[3];
    if (/^color\(srgb/.test(text)) return [numbers[0] * 255, numbers[1] * 255, numbers[2] * 255, alpha];
    return [numbers[0] || 0, numbers[1] || 0, numbers[2] || 0, alpha];
  }
  function opacityInside(element, root) {
    let opacity = 1;
    for (let node = element; node && node !== root.parentNode && node.nodeType === 1; node = node.parentNode) opacity *= Number(getComputedStyle(node).opacity);
    return opacity;
  }
  function overlaps(first, second) {
    return first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
  }

  // The element's four corners on screen, transforms included (a stamp is rotated: its bounding box is not its shape).
  // Inline elements cannot be transformed, so their box is their shape.
  function cornerQuad(element, style) {
    if (style.display === "inline") return null;
    const previous = element.style.position;
    if (style.position === "static") element.style.position = "relative";
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([across, down]) => {
      const marker = document.createElement("i");
      marker.style.cssText = `position:absolute;left:${across * 100}%;top:${down * 100}%;width:0;height:0;margin:0;padding:0;border:0`;
      element.appendChild(marker);
      const point = marker.getBoundingClientRect();
      marker.remove();
      return [point.left, point.top];
    });
    element.style.position = previous;
    return corners;
  }
  function insideQuad(quad, horizontal, vertical) {
    let sign = 0;
    for (let index = 0; index < 4; index++) {
      const [startX, startY] = quad[index], [endX, endY] = quad[(index + 1) % 4];
      const cross = (endX - startX) * (vertical - startY) - (endY - startY) * (horizontal - startX);
      if (Math.abs(cross) < 1e-9) continue;
      if (sign && Math.sign(cross) !== sign) return false;
      sign = Math.sign(cross);
    }
    return true;
  }

  let contrastHidden = [];
  // Step 1, after renderAt(t): the text drawn over a visible photo. Their glyphs stay hidden until contrastMeasure(),
  // so the renderer can screenshot exactly what is behind them.
  function contrastTargets(time) {
    const liveShots = SHOTS.filter((entry) => time >= entry.s && time < entry.e).map((entry) => document.getElementById(entry.id));
    const photoBoxes = [];
    for (const root of liveShots) {
      for (const image of root.querySelectorAll("img.mt-photo")) {
        if (image.naturalWidth && opacityInside(image, root) > 0.05) photoBoxes.push(image.getBoundingClientRect());
      }
    }
    if (!photoBoxes.length) return [];
    const largeSize = (24 * Math.min(W, H)) / 400, largeBoldSize = (18.66 * Math.min(W, H)) / 400;
    const targets = [];
    const consider = (element, root, caption) => {
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || element.closest("[data-check=off]")) return;
      const opacity = opacityInside(element, root);
      if (opacity < 0.05) return;
      // mid-entry (a pop, a rise, a slam) the text and its card are half drawn: judge the frame it settles on
      if (!caption && inMotion(element, root, time)) return;
      let box = element.getBoundingClientRect();
      if (style.display === "inline") {
        // an inline box can hang past its line (font ascent and descent vs line-height); its glyphs stay inside the block
        let block = element.parentElement;
        while (block && block !== root && getComputedStyle(block).display === "inline") block = block.parentElement;
        if (block) {
          const outer = block.getBoundingClientRect();
          const left = Math.max(box.left, outer.left), top = Math.max(box.top, outer.top);
          box = { left, top, width: Math.min(box.right, outer.right) - left, height: Math.min(box.bottom, outer.bottom) - top };
          box.right = box.left + box.width;
          box.bottom = box.top + box.height;
        }
      }
      if (box.width < 2 || box.height < 2 || !photoBoxes.some((photoBox) => overlaps(box, photoBox))) return;
      const fontSize = parseFloat(style.fontSize), bold = Number(style.fontWeight) >= 700;
      const large = !caption && (fontSize >= largeSize || (bold && fontSize >= largeBoldSize));
      const stroke = parseFloat(style.webkitTextStrokeWidth) >= 2 ? parseColour(style.webkitTextStrokeColor) : null;
      const text = `"${element.textContent.trim().slice(0, 24)}"`;
      const name = element.id ? "#" + element.id : element.className ? "." + String(element.className).split(" ")[0] : element.tagName.toLowerCase();
      const colour = parseColour(style.color);
      colour[3] *= opacity;
      targets.push({ label: caption ? `captions ${text}` : `${name} ${text}`, shot: caption ? "captions" : root.id, large, colour, stroke,
        box: { left: box.left, top: box.top, width: box.width, height: box.height }, quad: cornerQuad(element, style) });
      // hidden only after every colour is read: hiding a heading also hides its child spans' colour
      contrastHidden.push(element);
    };
    for (const root of liveShots) {
      for (const element of root.querySelectorAll("*")) {
        if (Array.from(element.childNodes).some((node) => node.nodeType === 3 && node.textContent.trim())) consider(element, root, false);
      }
    }
    const captions = document.getElementById("captions");
    if (captions && captions.style.visibility !== "hidden") {
      for (const word of captions.querySelectorAll(".w")) consider(word, captions, true);
    }
    for (const element of contrastHidden) element.dataset.mtHideGlyphs = "";
    return targets;
  }

  // Step 2: `screenshot` is a data: URL of the frame with those glyphs hidden. Returns {key, measured, message} for each
  // target that fails: the contrast of its colour against what is behind it, judged on the worst 5% of the element's
  // own shape (a few bright specks pass; a bright patch fails). A text outline (the captions' stroke) counts as background.
  async function contrastMeasure(screenshot, targets) {
    for (const element of contrastHidden) delete element.dataset.mtHideGlyphs;
    contrastHidden = [];
    if (!targets.length) return [];
    const picture = new Image();
    picture.src = screenshot;
    await picture.decode();
    const canvas = document.createElement("canvas");
    canvas.width = picture.naturalWidth;
    canvas.height = picture.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(picture, 0, 0);
    const scale = picture.naturalWidth / W;
    const findings = [];
    for (const target of targets) {
      const left = Math.max(0, Math.floor(target.box.left * scale)), top = Math.max(0, Math.floor(target.box.top * scale));
      const right = Math.min(canvas.width, Math.ceil((target.box.left + target.box.width) * scale));
      const bottom = Math.min(canvas.height, Math.ceil((target.box.top + target.box.height) * scale));
      const width = right - left, height = bottom - top;
      if (width < 1 || height < 1) continue;
      const pixels = context.getImageData(left, top, width, height).data;
      const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4000)));
      const alpha = target.colour[3];
      const ratios = [];
      for (let row = 0; row < height; row += step) {
        for (let column = 0; column < width; column += step) {
          if (target.quad && !insideQuad(target.quad, (left + column + 0.5) / scale, (top + row + 0.5) / scale)) continue;
          const offset = (row * width + column) * 4;
          let behind = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
          if (target.stroke) behind = behind.map((value, channel) => target.stroke[channel] * target.stroke[3] + value * (1 - target.stroke[3]));
          const drawn = behind.map((value, channel) => target.colour[channel] * alpha + value * (1 - alpha));
          ratios.push(contrastRatio(drawn, behind));
        }
      }
      ratios.sort((one, other) => one - other);
      if (!ratios.length) continue;
      const measured = ratios[Math.floor(ratios.length * 0.05)];
      const needed = target.large ? 3 : 4.5;
      if (measured < needed) {
        findings.push({ key: `${target.shot}: ${target.label}`, measured,
          message: `${target.shot}: ${target.label} over a photo has ${measured.toFixed(1)}:1 contrast, needs ${needed}:1 ` +
            `(WCAG AA${target.large ? ", large text" : ""}); raise the photo's tint strength or move the text` });
      }
    }
    return findings;
  }

  function finish() {
    if (!SHOTS.length) throw new Error("no shots: call shot() for each shot before MT.finish()");
    SHOTS.sort((a, b) => a.s - b.s);
    for (let i = 1; i < SHOTS.length; i++) {
      if (SHOTS[i].s < SHOTS[i - 1].e - 1e-6) console.warn(`[mytoma] ${SHOTS[i].id} starts before ${SHOTS[i - 1].id} ends (overlap is allowed, but check it is intended)`);
    }
    SFX.sort((a, b) => a.t - b.t);
    captionsDrawer();
    chaptersDrawer();
    grainDrawer();
    window.MT_INFO = { width: W, height: H, fps: FPS, duration: D, frames: Math.round(D * FPS), shots: SHOTS.slice(),
      edit: EDIT, photos: PHOTOS.slice(), missingPhotos: [] };
    window.MT_READY = ready();
  }

  applyBrand();

  const MT = { tl, cue, addDrawer, rand, shot, slam, pop, rise, fadeIn, stagger, stamp, highlight, strike, shake, hit,
    kenBurns, drift, punchIn, typer, counter, riser, down, sfx, bed, nocap, faceCam, photo, stretchAt, checkEdit, renderAt, check,
    contrastTargets, contrastMeasure, contrastRatio, finish, SFX, SHOTS, NOCAP, PHOTOS, W, H, FPS, D };
  window.MT = MT;
  window.renderAt = renderAt;
  window.SFX = SFX;
  // Helpers as globals, so a composition reads like a shot list: shot(...); slam(...); hit(...)
  for (const k of ["tl", "cue", "addDrawer", "shot", "slam", "pop", "rise", "fadeIn", "stagger", "stamp", "highlight",
    "strike", "shake", "hit", "kenBurns", "drift", "punchIn", "typer", "counter", "riser", "down", "sfx", "bed", "nocap", "faceCam",
    "photo"]) window[k] = MT[k];
})();
