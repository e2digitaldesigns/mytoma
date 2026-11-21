/* myToma infographics: D3 builds each graphic once, GSAP (or a t-driven drawer) animates it.
 *
 * Loaded after engine.js. Every helper takes a container element (size it with CSS: the graphic fills it),
 * the data, and times in seconds of the video. Each pushes its own sound cues, like the engine's helpers.
 *
 *   barChart(sel, data, t, opts)          horizontal bars grow in turn, values count up
 *   lineChart(sel, points, s, e, opts)    the line draws itself across [s, e), a dot rides its tip
 *   donut(sel, data, s, opts)             segments sweep in turn, centre value counts up
 *   mapReveal(sel, s, opts)               borders draw, the camera flies to a region, countries light up,
 *                                         a route traces between places, pins drop
 *   timeline(sel, events, s, opts)        an axis draws, dates and labels land one by one
 *
 * Colours come from --brand-* tokens. Nothing here reads the clock: D3 transitions are never used.
 */
(function () {
  "use strict";
  if (!window.d3) throw new Error("charts.js needs d3.min.js loaded first");
  gsap.registerPlugin(DrawSVGPlugin, MotionPathPlugin, MorphSVGPlugin);

  const { tl, cue, addDrawer, rand } = window.MT;
  const NS = "http://www.w3.org/2000/svg";
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function box(sel, helper) {
    const el = typeof sel === "string" ? document.querySelector(sel) : sel;
    if (!el) throw new Error(`${helper}(): no element matches ${sel}`);
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) throw new Error(`${helper}(): ${sel} has no size; give it a width and height in CSS`);
    el.innerHTML = "";
    const svg = d3.select(el).append("svg").attr("width", w).attr("height", h).attr("viewBox", `0 0 ${w} ${h}`)
      .attr("class", "mt-chart").style("overflow", "visible");
    return { el, svg, w, h };
  }

  function fmt(v, o = {}) {
    const d = o.decimals ?? (Math.abs(v) < 10 && v % 1 ? 1 : 0);
    let s = Number(v).toFixed(d);
    if (o.sep !== false) s = Number(s).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    return (o.prefix || "") + s + (o.suffix || "");
  }

  // A value that counts from 0 to `to` across [s, s+d), written into an SVG/HTML text node from t alone
  function countText(node, to, s, d, o, ease = "power2.out") {
    const e = gsap.parseEase(ease);
    addDrawer((t) => {
      const k = e(Math.max(0, Math.min(1, (t - s) / d)));
      node.textContent = fmt(to * k, o);
    });
  }

  /* ---------- bar chart ---------- */

  // barChart("#bars", [{label: "Paris", value: 2100}, …], 4.2, {highlight: "Paris", suffix: "k", gap: 0.18})
  function barChart(sel, data, t, opts = {}) {
    const { svg, w, h } = box(sel, "barChart");
    const o = Object.assign({ gap: 0.15, dur: 0.7, labelSize: 46, valueSize: 46, sort: false }, opts);
    const rows = o.sort ? data.slice().sort((a, b) => b.value - a.value) : data;
    const max = o.max ?? d3.max(rows, (d) => d.value);
    const y = d3.scaleBand().domain(rows.map((d) => d.label)).range([0, h]).paddingInner(0.32);
    const labelW = o.labelWidth ?? Math.round(w * 0.3);
    const valueW = Math.round(w * 0.2);
    const x = d3.scaleLinear().domain([0, max]).range([0, w - labelW - valueW]);
    const accent = (d) => (!o.highlight || o.highlight === d.label ? "var(--brand-primary)" : "color-mix(in srgb, var(--brand-text) 28%, transparent)");

    rows.forEach((d, i) => {
      const at = t + i * o.gap;
      const g = svg.append("g").attr("transform", `translate(0,${y(d.label)})`);
      const label = g.append("text").attr("x", labelW - 24).attr("y", y.bandwidth() / 2).attr("dy", "0.35em")
        .attr("text-anchor", "end").attr("class", "mt-label").style("font-size", o.labelSize + "px").text(d.label);
      const bar = g.append("rect").attr("x", labelW).attr("y", 0).attr("height", y.bandwidth())
        .attr("width", Math.max(2, x(d.value))).attr("rx", Math.min(14, y.bandwidth() / 4)).style("fill", accent(d));
      const value = g.append("text").attr("x", labelW + x(d.value) + 18).attr("y", y.bandwidth() / 2).attr("dy", "0.35em")
        .attr("class", "mt-value").style("font-size", o.valueSize + "px").style("fill", o.highlight === d.label ? "var(--brand-primary)" : null);
      tl.fromTo(label.node(), { opacity: 0, x: -30 }, { opacity: 1, x: 0, duration: 0.35 }, at);
      tl.fromTo(bar.node(), { scaleX: 0 }, { scaleX: 1, duration: o.dur, ease: "power3.out", svgOrigin: `${labelW} 0` }, at);
      // the value label rides the bar's tip, then counts up
      tl.fromTo(value.node(), { x: -x(d.value), opacity: 0 }, { x: 0, opacity: 1, duration: o.dur, ease: "power3.out" }, at);
      countText(value.node(), d.value, at, o.dur, o);
      cue(at, "pop");
    });
    return t + (rows.length - 1) * o.gap + o.dur;
  }

  /* ---------- line chart ---------- */

  // lineChart("#line", [{x: "1990", y: 12}, …], 6.0, 8.4, {annotate: [{x: "2008", text: "crash"}], suffix: "%"})
  function lineChart(sel, points, s, e, opts = {}) {
    const { svg, w, h } = box(sel, "lineChart");
    const o = Object.assign({ pad: 70, axisSize: 34, ease: "power1.inOut", area: true }, opts);
    const x = d3.scalePoint().domain(points.map((p) => String(p.x))).range([o.pad, w - o.pad]);
    const ymax = o.max ?? d3.max(points, (p) => p.y) * 1.12;
    const top = (opts.annotate || []).length ? 150 : o.pad * 0.6;   // room above the line for annotations
    const y = d3.scaleLinear().domain([o.min ?? 0, ymax]).range([h - o.pad, top]);
    const id = "mt" + Math.round(rand(points.length * 7919 + Math.round(s * 1000)) * 1e9);

    // faint grid and the first/last x labels
    y.ticks(4).forEach((v) => {
      svg.append("line").attr("x1", o.pad).attr("x2", w - o.pad).attr("y1", y(v)).attr("y2", y(v)).attr("class", "mt-grid");
    });
    const xs = points.map((p) => String(p.x));
    [xs[0], xs[xs.length - 1]].concat(opts.ticks || []).forEach((v) => {
      svg.append("text").attr("x", x(v)).attr("y", h - o.pad + 50).attr("text-anchor", "middle").attr("class", "mt-axis")
        .style("font-size", o.axisSize + "px").text(v);
    });
    const line = d3.line().x((p) => x(String(p.x))).y((p) => y(p.y)).curve(d3.curveMonotoneX);
    const defs = svg.append("defs");
    const clip = defs.append("clipPath").attr("id", id + "c").append("rect").attr("x", 0).attr("y", 0).attr("height", h).attr("width", w);
    if (o.area) {
      const grad = defs.append("linearGradient").attr("id", id + "g").attr("x1", 0).attr("x2", 0).attr("y1", 0).attr("y2", 1);
      grad.append("stop").attr("offset", "0%").style("stop-color", "var(--brand-primary)").style("stop-opacity", 0.35);
      grad.append("stop").attr("offset", "100%").style("stop-color", "var(--brand-primary)").style("stop-opacity", 0);
      const area = d3.area().x((p) => x(String(p.x))).y0(y(o.min ?? 0)).y1((p) => y(p.y)).curve(d3.curveMonotoneX);
      svg.append("path").attr("d", area(points)).attr("fill", `url(#${id}g)`).attr("clip-path", `url(#${id}c)`);
    }
    const path = svg.append("path").attr("d", line(points)).attr("class", "mt-line");
    const dot = svg.append("circle").attr("r", 16).attr("class", "mt-dot");
    const dur = e - s;

    tl.fromTo(path.node(), { drawSVG: "0%" }, { drawSVG: "100%", duration: dur, ease: o.ease }, s);
    tl.fromTo(clip.node(), { attr: { width: o.pad } }, { attr: { width: w - o.pad }, duration: dur, ease: o.ease }, s);
    tl.fromTo(dot.node(), { opacity: 0 }, { opacity: 1, duration: 0.2 }, s);
    tl.to(dot.node(), { motionPath: { path: path.node(), align: path.node(), alignOrigin: [0.5, 0.5] }, duration: dur, ease: o.ease, immediateRender: true }, s);
    cue(s, "whoosh.slow", { gain: 0.6 });

    // annotations appear when the drawing tip reaches their x
    const ease = gsap.parseEase(o.ease);
    const inv = (k) => { let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; ease(m) < k ? (lo = m) : (hi = m); } return lo; };
    (o.annotate || []).forEach((a) => {
      const p = points.find((q) => String(q.x) === String(a.x));
      if (!p) throw new Error(`lineChart(): annotate x ${a.x} is not in the data`);
      const k = (x(String(a.x)) - o.pad) / (w - 2 * o.pad);
      const at = s + inv(k) * dur;
      // position on an outer group, animate an inner one: GSAP reads an SVG transform attribute as its own
      // x/y, so tweening y on the positioned group would replace the position itself
      const g = svg.append("g").attr("transform", `translate(${x(String(a.x))},${y(p.y)})`).append("g");
      const below = a.below ?? y(p.y) - 140 < 0;          // no room above: hang the label below the point
      const dir = below ? 1 : -1;
      g.append("line").attr("y1", 24 * dir).attr("y2", 96 * dir).attr("class", "mt-annot-line");
      g.append("text").attr("y", below ? 140 : -118).attr("text-anchor", "middle").attr("class", "mt-annot").text(a.text);
      tl.fromTo(g.node(), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.35, ease: "back.out(2)" }, at);
      cue(at, "pop");
    });
    if (o.endLabel !== false) {
      const last = points[points.length - 1];
      const label = svg.append("text").attr("x", x(String(last.x))).attr("y", y(last.y) - 40).attr("text-anchor", "end")
        .attr("class", "mt-value").style("font-size", (o.valueSize || 64) + "px");
      countText(label.node(), last.y, s, dur, o, o.ease);
      tl.fromTo(label.node(), { opacity: 0 }, { opacity: 1, duration: 0.3 }, e - 0.3);
    }
    return e;
  }

  /* ---------- donut ---------- */

  // donut("#donut", [{label: "Yes", value: 62}, {label: "No", value: 38}], 9.0, {center: "62%", seg: 0.5})
  function donut(sel, data, s, opts = {}) {
    const { svg, w, h } = box(sel, "donut");
    const o = Object.assign({ seg: 0.45, thickness: 0.26, gap: 0.012 }, opts);
    const r = Math.min(w, h) / 2;
    const g = svg.append("g").attr("transform", `translate(${w / 2},${h / 2})`);
    const total = d3.sum(data, (d) => d.value);
    const arc = d3.arc().innerRadius(r * (1 - o.thickness)).outerRadius(r).cornerRadius(6);
    const fills = ["var(--brand-primary)", "var(--brand-secondary)", "color-mix(in srgb, var(--brand-text) 35%, transparent)",
      "color-mix(in srgb, var(--brand-primary) 45%, transparent)", "color-mix(in srgb, var(--brand-text) 18%, transparent)"];
    g.append("circle").attr("r", r * (1 - o.thickness / 2)).attr("class", "mt-donut-track").style("stroke-width", r * o.thickness);
    let a0 = 0;
    const segs = data.map((d, i) => {
      const a1 = a0 + (d.value / total) * Math.PI * 2;
      const seg = { from: a0, to: a1, at: s + i * o.seg, node: g.append("path").style("fill", d.color || fills[i % fills.length]).node() };
      a0 = a1;
      cue(seg.at, "pop");
      return seg;
    });
    const ease = gsap.parseEase("power2.inOut");
    addDrawer((t) => {
      for (const sg of segs) {
        const k = ease(Math.max(0, Math.min(1, (t - sg.at) / o.seg)));
        sg.node.setAttribute("d", k <= 0 ? "" : arc({ startAngle: sg.from + o.gap, endAngle: Math.max(sg.from + o.gap, sg.from + (sg.to - sg.from) * k - o.gap) }));
      }
    });
    if (o.center !== undefined) {
      const c = g.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").attr("class", "mt-donut-center").style("font-size", r * 0.42 + "px");
      const m = String(o.center).match(/^([^\d-]*)(-?[\d.,]+)(.*)$/);
      if (m) countText(c.node(), Number(m[2].replace(/,/g, "")), s, data.length * o.seg, { prefix: m[1], suffix: m[3], decimals: (m[2].split(".")[1] || "").length });
      else c.text(o.center);
      tl.fromTo(c.node(), { opacity: 0, scale: 0.6, transformOrigin: "50% 50%" }, { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2)" }, s);
    }
    return s + data.length * o.seg;
  }

  /* ---------- map ---------- */

  function worldFeatures(detail) {
    const topo = detail === "50m" ? window.WORLD_50M : window.WORLD_110M;
    if (!topo) throw new Error(`mapReveal(): world ${detail} data not loaded (vendor/data/world-${detail}.js)`);
    return topojson.feature(topo, topo.objects.countries).features;
  }

  /* mapReveal("#map", 12.0, {
   *   detail: "110m" | "50m",
   *   borders: 1.6,                                   // seconds for every border to draw on
   *   focus: {names: ["France", "Germany"], at: 13.0, dur: 1.4, pad: 0.15},   // or {center: [lon, lat], zoom: 4}
   *   highlight: [{name: "France", at: 14.2}],
   *   route: {points: [[2.35, 48.85], [13.4, 52.52]], at: 14.6, dur: 1.2},
   *   pins: [{at: 15.8, lonlat: [13.4, 52.52], text: "Berlin"}],
   * }) */
  function mapReveal(sel, s, opts = {}) {
    const { el, svg, w, h } = box(sel, "mapReveal");
    el.style.overflow = "hidden";
    const o = Object.assign({ detail: "110m", borders: 1.6 }, opts);
    const features = worldFeatures(o.detail).filter((f) => f.properties.name !== "Antarctica");
    const byName = new Map(features.map((f) => [f.properties.name, f]));
    const need = (name) => { const f = byName.get(name); if (!f) throw new Error(`mapReveal(): no country named "${name}" (Natural Earth names, e.g. "United States of America")`); return f; };
    const projection = d3.geoNaturalEarth1().fitExtent([[20, 20], [w - 20, h - 20]], { type: "FeatureCollection", features });
    // In a tall frame the 2:1 world would be a thin strip: fill the height and crop the sides instead
    if ((o.fit || (h > w ? "cover" : "contain")) === "cover") {
      const [[x0, y0], [x1, y1]] = d3.geoPath(projection).bounds({ type: "FeatureCollection", features });
      const k = Math.max(w / (x1 - x0), h / (y1 - y0));
      const [tx, ty] = projection.translate();
      projection.scale(projection.scale() * k).translate([w / 2 + (tx - (x0 + x1) / 2) * k, h / 2 + (ty - (y0 + y1) / 2) * k]);
      if (o.center) { const [cx, cy] = projection(o.center); projection.translate([projection.translate()[0] + w / 2 - cx, projection.translate()[1] + h / 2 - cy]); }
    }
    const geo = d3.geoPath(projection);
    // A country's main landmass: France's frame should be France, not France plus French Guiana
    const mainland = (f) => {
      if (f.geometry.type !== "MultiPolygon") return f;
      const polys = f.geometry.coordinates.map((c) => ({ type: "Feature", geometry: { type: "Polygon", coordinates: c } }));
      return polys.reduce((a, b) => (geo.area(a) >= geo.area(b) ? a : b));
    };
    const cam = svg.append("g").attr("class", "mt-map-cam");
    const nodes = new Map();
    features.forEach((f) => {
      const p = cam.append("path").attr("d", geo(f)).attr("class", "mt-country");
      nodes.set(f.properties.name, p.node());
    });

    // borders draw on in a seeded random order: same order every render
    const all = Array.from(nodes.values());
    all.forEach((n, i) => {
      const at = s + rand(i, 31) * o.borders * 0.7;
      tl.fromTo(n, { drawSVG: "0%", fillOpacity: 0 }, { drawSVG: "100%", duration: o.borders * 0.3, ease: "power1.inOut" }, at);
      tl.to(n, { fillOpacity: 1, duration: 0.4 }, at + o.borders * 0.3);
    });
    cue(s, "whoosh.slow");

    // camera: GSAP tweens plain numbers, the drawer applies them (k = zoom, x/y = translation)
    const view = { k: 1, x: 0, y: 0 };
    if (o.focus) {
      const f = o.focus;
      let k, cx, cy;
      if (f.names) {
        const [[x0, y0], [x1, y1]] = geo.bounds({ type: "FeatureCollection", features: f.names.map((n) => mainland(need(n))) });
        const pad = f.pad ?? 0.15;
        k = Math.min(f.maxZoom ?? 12, (1 - pad * 2) / Math.max((x1 - x0) / w, (y1 - y0) / h));
        cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
      } else {
        [cx, cy] = projection(f.center); k = f.zoom || 3;
      }
      tl.to(view, { k, x: w / 2 - cx * k, y: h / 2 - cy * k, duration: f.dur || 1.4, ease: "power3.inOut" }, f.at);
      cue(f.at, "whoosh.slow", { gain: 0.7 });
    }
    addDrawer(() => cam.attr("transform", `translate(${view.x},${view.y}) scale(${view.k})`));

    (o.highlight || []).forEach((hl) => {
      const n = nodes.get(need(hl.name).properties.name);
      // GSAP interpolates real colours, not var(): resolve the token first
      tl.to(n, { fill: hl.color || css("--brand-primary"), duration: 0.35, ease: "power2.out" }, hl.at);
      cue(hl.at, hl.sound || "impact.soft");
    });

    if (o.route) {
      const pts = o.route.points;
      const line = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const interp = d3.geoInterpolate(pts[i], pts[i + 1]);
        for (let j = 0; j <= 40; j++) line.push(projection(interp(j / 40)));
      }
      const path = cam.append("path").attr("d", d3.line().curve(d3.curveCatmullRom)(line)).attr("class", "mt-route");
      const head = cam.append("circle").attr("r", 9).attr("class", "mt-route-head");
      const { at, dur = 1.2 } = o.route;
      tl.fromTo(path.node(), { drawSVG: "0%" }, { drawSVG: "100%", duration: dur, ease: "power2.inOut" }, at);
      tl.fromTo(head.node(), { opacity: 0 }, { opacity: 1, duration: 0.15 }, at);
      tl.to(head.node(), { motionPath: { path: path.node(), align: path.node(), alignOrigin: [0.5, 0.5] }, duration: dur, ease: "power2.inOut", immediateRender: true }, at);
      cue(at, "whoosh.fast", { gain: 0.6 });
      cue(at + dur, "pop");
    }

    (o.pins || []).forEach((pin) => {
      const [px, py] = projection(pin.lonlat);
      const g = cam.append("g").attr("class", "mt-pin").attr("transform", `translate(${px},${py})`);
      g.append("circle").attr("r", 10);
      if (pin.text) g.append("text").attr("x", 18).attr("dy", "0.35em").text(pin.text);
      // pins and their labels keep their size while the camera zooms
      addDrawer(() => g.attr("transform", `translate(${px},${py}) scale(${1 / view.k})`));
      tl.fromTo(g.node(), { opacity: 0 }, { opacity: 1, duration: 0.25 }, pin.at);
      cue(pin.at, "pop");
    });
    return s + o.borders;
  }

  /* ---------- timeline ---------- */

  // timeline("#years", [{date: "1914", text: "war begins"}, …], 16.0, {gap: 0.7})
  function timeline(sel, events, s, opts = {}) {
    const { svg, w, h } = box(sel, "timeline");
    const o = Object.assign({ gap: 0.7, axis: 0.6, vertical: h > w, sound: "foley.typewriter" }, opts);
    const n = events.length;
    const axis = o.vertical
      ? svg.append("line").attr("x1", 60).attr("x2", 60).attr("y1", 20).attr("y2", h - 20)
      : svg.append("line").attr("x1", 20).attr("x2", w - 20).attr("y1", h / 2).attr("y2", h / 2);
    axis.attr("class", "mt-axis-line");
    tl.fromTo(axis.node(), { drawSVG: "0%" }, { drawSVG: "100%", duration: o.axis, ease: "power2.inOut" }, s);
    cue(s, "whoosh.fast", { gain: 0.5 });
    events.forEach((ev, i) => {
      const at = s + o.axis + i * o.gap;
      const pos = 20 + ((i + 0.5) / n) * ((o.vertical ? h : w) - 40);
      const g = svg.append("g").attr("transform", o.vertical ? `translate(60,${pos})` : `translate(${pos},${h / 2})`);
      g.append("circle").attr("r", 14).attr("class", "mt-tick");
      const date = g.append("text").attr("class", "mt-date");
      const text = g.append("text").attr("class", "mt-event").text(ev.text);
      if (o.vertical) { date.attr("x", 44).attr("dy", "-0.15em"); text.attr("x", 44).attr("dy", "1.25em"); }
      else { date.attr("y", -44).attr("text-anchor", "middle"); text.attr("y", 74).attr("text-anchor", "middle"); }
      tl.fromTo(g.select("circle").node(), { scale: 0, transformOrigin: "50% 50%" }, { scale: 1, duration: 0.3, ease: "back.out(3)" }, at);
      // the date types itself in, then its label rises
      const node = date.node(), str = String(ev.date), typeDur = Math.min(0.45, 0.09 * str.length);
      addDrawer((t) => { node.textContent = str.slice(0, Math.round(Math.max(0, Math.min(1, (t - at) / typeDur)) * str.length)); });
      cue(at, o.sound, { dur: typeDur });
      tl.fromTo(text.node(), { opacity: 0, y: o.vertical ? 0 : 20, x: o.vertical ? 20 : 0 }, { opacity: 1, x: 0, y: 0, duration: 0.35 }, at + typeDur);
    });
    return s + o.axis + n * o.gap;
  }

  Object.assign(window.MT, { barChart, lineChart, donut, mapReveal, timeline, fmt });
  Object.assign(window, { barChart, lineChart, donut, mapReveal, timeline });
})();
