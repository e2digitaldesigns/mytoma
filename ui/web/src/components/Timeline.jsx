import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { fmt } from "../api.js";

const LEVEL_LABEL = { none: "No graphics", limited: "Limited", full: "Full" };
const MIN_LEN = 0.2;

// The timeline: shots (from the composition), graphics stretches and chapters (yours to mark), captions,
// and the voice's words. Drag on an empty Graphics or Chapters track to mark a stretch; drag a block to
// move it, its edges to resize it; click anywhere else to move the playhead.
export default function Timeline({ duration, t, onSeek, playing, shots, faces, phrases, capWords, words, edit, onChangeEdit,
  selection, onSelect, pps, setPps }) {
  const scrollRef = useRef(null);
  const innerRef = useRef(null);
  const [ghost, setGhost] = useState(null);       // {track, a, b} while marking
  const width = Math.max(200, duration * pps + 60);

  // keep the playhead in view while playing
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const x = t * pps;
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 80) el.scrollLeft = x - 80;
  }, [t, playing, pps]);

  const timeAt = useCallback((clientX) => {
    const r = innerRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - r.left) / pps));
  }, [duration, pps]);

  // snap to word starts/ends and the playhead when within 7 px
  const snap = useCallback((v) => {
    const tol = 7 / pps;
    let best = v, dist = tol;
    for (const w of words) {
      for (const p of [w.s, w.e]) if (Math.abs(p - v) < dist) { best = p; dist = Math.abs(p - v); }
    }
    if (Math.abs(t - v) < dist) best = t;
    return Math.round(best * 1000) / 1000;
  }, [words, pps, t]);

  const drag = (e, onMove, onUp) => {
    e.preventDefault();
    const move = (ev) => onMove(ev);
    const up = (ev) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); onUp && onUp(ev); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const scrub = (e) => {
    onSeek(timeAt(e.clientX));
    drag(e, (ev) => onSeek(timeAt(ev.clientX)));
  };

  // a stable handle for the memoised tracks, so they don't redraw on every frame of playback
  const scrubRef = useRef(scrub);
  scrubRef.current = scrub;
  const stableScrub = useCallback((e) => scrubRef.current(e), []);

  const listKey = (track) => (track === "stretch" ? "stretches" : "chapters");

  // free space around time v on a track (marks on one track never overlap)
  const bounds = (track, skip = -1) => {
    const list = edit[listKey(track)];
    return (v) => {
      let lo = 0, hi = duration;
      list.forEach((x, i) => {
        if (i === skip) return;
        if (x.b <= v + 1e-6) lo = Math.max(lo, x.b);
        if (x.a >= v - 1e-6) hi = Math.min(hi, x.a);
      });
      return [lo, hi];
    };
  };

  const startMark = (track) => (e) => {
    if (e.button !== 0) return;
    const a0 = snap(timeAt(e.clientX));
    const [lo, hi] = bounds(track)(a0);
    if (hi - lo < MIN_LEN) return;
    let a = a0, b = a0;
    setGhost({ track, a, b });
    drag(e, (ev) => {
      const v = Math.max(lo, Math.min(hi, snap(timeAt(ev.clientX))));
      a = Math.min(a0, v); b = Math.max(a0, v);
      setGhost({ track, a, b });
    }, () => {
      setGhost(null);
      if (b - a < MIN_LEN) { onSeek(a0); return; }
      const key = listKey(track);
      const item = track === "stretch" ? { a, b, level: "limited", subtitles: true } : { a, b, title: `Chapter ${edit.chapters.length + 1}` };
      const next = [...edit[key], item].sort((x, y) => x.a - y.a);
      onChangeEdit({ [key]: next });
      onSelect({ kind: track, index: next.indexOf(item) });
    });
  };

  const startEdit = (track, index, mode) => (e) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    onSelect({ kind: track, index });
    const key = listKey(track);
    const orig = edit[key][index];
    const x0 = timeAt(e.clientX);
    const [lo, hi] = bounds(track, index)((orig.a + orig.b) / 2);
    drag(e, (ev) => {
      const dx = timeAt(ev.clientX) - x0;
      let { a, b } = orig;
      if (mode === "move") {
        const len = b - a;
        a = Math.max(lo, Math.min(hi - len, snap(orig.a + dx)));
        b = a + len;
      } else if (mode === "l") {
        a = Math.max(lo, Math.min(b - MIN_LEN, snap(orig.a + dx)));
      } else {
        b = Math.min(hi, Math.max(a + MIN_LEN, snap(orig.b + dx)));
      }
      const list = edit[key].slice();
      list[index] = { ...orig, a: Math.round(a * 1000) / 1000, b: Math.round(b * 1000) / 1000 };
      onChangeEdit({ [key]: list });
    });
  };

  const tickEvery = pps >= 120 ? 1 : pps >= 50 ? 2 : pps >= 20 ? 5 : 10;

  return (
    <>
      <div className="tl-tools">
        <span className="muted small">Drag on <b>Graphics</b> or <b>Chapters</b> to mark a stretch · drag a mark to move it, its edges to resize · Delete removes it</span>
        <span className="grow" />
        <span className="muted small">Zoom</span>
        <input type="range" min="10" max="240" value={pps} onChange={(e) => setPps(Number(e.target.value))} style={{ width: 140 }} />
      </div>
      <div className="tl">
        <div className="tl-labels">
          <div>Shots</div><div>Graphics</div><div>Chapters</div><div>Captions</div><div>Voice</div>
        </div>
        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-inner" ref={innerRef} style={{ width }}>
            <div className="ruler" onPointerDown={scrub}>
              {Array.from({ length: Math.floor(duration / tickEvery) + 1 }, (_, i) => (
                <div key={i} className="tick" style={{ left: i * tickEvery * pps }}>{fmt(i * tickEvery).replace(/\.00$/, "")}</div>
              ))}
            </div>
            <Static shots={shots} faces={faces} phrases={phrases} capWords={capWords} words={words} pps={pps} onScrub={stableScrub} />
            {/* graphics */}
            <div className="track markable" style={{ position: "absolute", left: 0, right: 0, top: 24 + 38 }} onPointerDown={startMark("stretch")}>
              {edit.stretches.map((s, i) => (
                <div key={i} className={`block stretch ${s.level} ${selection?.kind === "stretch" && selection.index === i ? "selected" : ""}`}
                  style={{ left: s.a * pps, width: (s.b - s.a) * pps }} onPointerDown={startEdit("stretch", i, "move")}
                  title={`${LEVEL_LABEL[s.level]} · ${fmt(s.a)}–${fmt(s.b)}${s.subtitles ? "" : " · no subtitles"}`}>
                  {LEVEL_LABEL[s.level]}{!s.subtitles && <span className="sub-off">CC off</span>}
                  <span className="edge l" onPointerDown={startEdit("stretch", i, "l")} />
                  <span className="edge r" onPointerDown={startEdit("stretch", i, "r")} />
                </div>
              ))}
              {ghost?.track === "stretch" && <div className="ghost-range" style={{ left: ghost.a * pps, width: (ghost.b - ghost.a) * pps }} />}
            </div>
            {/* chapters */}
            <div className="track markable" style={{ position: "absolute", left: 0, right: 0, top: 24 + 38 * 2 }} onPointerDown={startMark("chapter")}>
              {edit.chapters.map((c, i) => (
                <div key={i} className={`block chapter ${selection?.kind === "chapter" && selection.index === i ? "selected" : ""}`}
                  style={{ left: c.a * pps, width: (c.b - c.a) * pps }} onPointerDown={startEdit("chapter", i, "move")} title={`${c.title} · ${fmt(c.a)}–${fmt(c.b)}`}>
                  {c.title}
                  <span className="edge l" onPointerDown={startEdit("chapter", i, "l")} />
                  <span className="edge r" onPointerDown={startEdit("chapter", i, "r")} />
                </div>
              ))}
              {ghost?.track === "chapter" && <div className="ghost-range" style={{ left: ghost.a * pps, width: (ghost.b - ghost.a) * pps }} />}
            </div>
            <div className="playhead" style={{ left: t * pps }} />
          </div>
        </div>
      </div>
    </>
  );
}

// Tracks that don't change with the playhead: drawn once per data change, not every frame
const Static = memo(function Static({ shots, faces, phrases, capWords, words, pps, onScrub }) {
  const faceAt = (s) => faces.some((f) => f.a < s.e && f.b > s.s);
  return (
    <>
      <div className="track" onPointerDown={onScrub}>
        {shots.map((s) => (
          <div key={s.id + s.s} className={`block shot ${faceAt(s) ? "face" : ""}`} style={{ left: s.s * pps, width: Math.max(2, (s.e - s.s) * pps - 2) }}
            title={`${s.id} · ${fmt(s.s)}–${fmt(s.e)} · ${s.enter}${faceAt(s) ? " · face" : ""}`}>{s.id}{faceAt(s) ? " · face" : ""}</div>
        ))}
      </div>
      <div className="track" style={{ marginTop: 38 * 2 }} onPointerDown={onScrub}>
        {phrases.map((p, i) => (
          <div key={i} className="block caption" style={{ left: p.s * pps, width: Math.max(2, (p.e - p.s) * pps) }}>
            {capWords.slice(p.a, p.b).map((w) => w.w).join(" ")}
          </div>
        ))}
      </div>
      <div className="track" onPointerDown={onScrub}>
        {words.map((w, i) => <div key={i} className="word-tick" style={{ left: w.s * pps, width: Math.max(1, (w.e - w.s) * pps) }} title={w.w} />)}
      </div>
    </>
  );
});
