import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, fmt } from "../api.js";

const bare = (w) => w.replace(/[.,!?;:"“”]+$/g, "").replace(/^["“”]+/, "");
const norm = (w) => bare(w).toLowerCase();

// Lines like transcript.txt: a sentence end or a pause starts a new line
function toLines(words) {
  const lines = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(i);
    const nxt = words[i + 1];
    if (!nxt || /[.?!]$/.test(w.w) || nxt.s - w.e > 0.6 || cur.length >= 16) { lines.push(cur); cur = []; }
  });
  return lines;
}

// The transcript: click a word to jump there; drag across words to select, then mark the selection as a
// graphics stretch or a chapter; with one word selected, fix its spelling or make it a keyword.
export default function Transcript({ id, words, fixes, keywords, t, playing, stretches, chapters, onSeek, onMark, onSaved, notify }) {
  const [sel, setSel] = useState(null);            // [i0, i1]
  const [fixText, setFixText] = useState("");
  const [chapterTitle, setChapterTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const dragging = useRef(null);
  const [held, setHeld] = useState(false);          // the selection bar waits for release: it would shift the words mid-drag
  const nowRef = useRef(null);
  const lines = useMemo(() => toLines(words), [words]);
  const kw = useMemo(() => new Set(keywords.map((k) => norm(k.split("@")[0]))), [keywords]);

  const display = (w) => {
    const timed = `${w.w}@${w.s.toFixed(2)}`;
    if (timed in fixes) return fixes[timed];
    if (w.w in fixes) return fixes[w.w];
    if (bare(w.w) in fixes) return fixes[bare(w.w)] + w.w.slice(bare(w.w).length);
    return null;
  };
  const levelAt = (w) => stretches.find((s) => (w.s + w.e) / 2 >= s.a && (w.s + w.e) / 2 < s.b)?.level;
  const chapterAt = (i) => chapters.find((c) => words[i].s >= c.a && words[i].s < c.b);
  const nowIdx = words.findIndex((w, i) => t >= w.s && t < (words[i + 1]?.s ?? w.e + 0.3));

  useEffect(() => { if (playing) nowRef.current?.scrollIntoView({ block: "nearest" }); }, [nowIdx, playing]);
  // drag-select: follow the pointer at the window level and find the word under it (hover events are not
  // reliable while a button is held, and touch has none)
  useEffect(() => {
    const move = (e) => {
      if (dragging.current == null) return;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-i]");
      if (el) setSel([dragging.current, Number(el.dataset.i)]);
    };
    const up = () => { dragging.current = null; setHeld(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  const range = sel ? [Math.min(...sel), Math.max(...sel)] : null;
  const selA = range ? words[range[0]].s : 0;
  const selB = range ? words[range[1]].e : 0;
  const single = range && range[0] === range[1] ? words[range[0]] : null;

  const save = async (nextFixes, nextKeywords) => {
    setSaving(true);
    try {
      const r = await api.saveTranscript(id, nextFixes, nextKeywords);
      onSaved(r.state);
      notify("Captions rebuilt");
    } catch (e) { notify(e.message, true); }
    setSaving(false);
  };

  if (!words.length) {
    return <p className="hint">No transcript yet. Add a recording on the Media tab and run <b>Transcribe, trim and caption</b>.</p>;
  }

  return (
    <div>
      {range && !held && (
        <div className="selbar">
          <div className="small muted" style={{ marginBottom: 6 }}>
            {range[1] - range[0] + 1} word{range[0] !== range[1] ? "s" : ""} · {fmt(selA)}–{fmt(selB)}
          </div>
          <div className="row wrap" style={{ marginBottom: 6 }}>
            <span className="small muted">Graphics:</span>
            {[["none", "None"], ["limited", "Limited"], ["full", "Full"]].map(([lvl, label]) => (
              <button key={lvl} onClick={() => { onMark("stretch", { a: selA, b: selB, level: lvl, subtitles: true }); setSel(null); }}>{label}</button>
            ))}
          </div>
          <div className="row" style={{ marginBottom: single ? 6 : 0 }}>
            <input type="text" placeholder="Chapter title" value={chapterTitle} onChange={(e) => setChapterTitle(e.target.value)} />
            <button onClick={() => { onMark("chapter", { a: selA, b: selB, title: chapterTitle.trim() || "Chapter" }); setChapterTitle(""); setSel(null); }}>Mark chapter</button>
          </div>
          {single && (
            <>
              <div className="row" style={{ marginBottom: 6 }}>
                <input type="text" placeholder={`Spell "${single.w}" as…`} value={fixText} onChange={(e) => setFixText(e.target.value)} />
                <button disabled={saving} onClick={() => {
                  const key = `${single.w}@${single.s.toFixed(2)}`;
                  const next = { ...fixes };
                  if (fixText.trim() === "" || fixText.trim() === single.w) delete next[key]; else next[key] = fixText.trim();
                  setFixText("");
                  save(next, keywords);
                }}>Fix</button>
                <button disabled={saving} title="Fix it everywhere it appears" onClick={() => {
                  if (!fixText.trim()) return;
                  save({ ...fixes, [bare(single.w)]: bare(fixText.trim()) }, keywords);
                  setFixText("");
                }}>Everywhere</button>
              </div>
              <button disabled={saving} onClick={() => {
                const k = norm(single.w);
                save(fixes, kw.has(k) ? keywords.filter((x) => norm(x.split("@")[0]) !== k) : [...keywords, bare(single.w)]);
              }}>{kw.has(norm(single.w)) ? "Remove keyword" : "Make keyword"}</button>
            </>
          )}
        </div>
      )}
      <p className="hint">Click a word to jump there. Drag across words to select a stretch. Underlines: <span style={{ color: "var(--none)" }}>none</span> · <span style={{ color: "var(--limited)" }}>limited</span> · <span style={{ color: "var(--full)" }}>full</span>. Yellow words were heard with low confidence.</p>
      <div className="transcript">
        {lines.map((line, li) => {
          const ch = chapterAt(line[0]);
          const showCh = ch && (li === 0 || chapterAt(lines[li - 1][0]) !== ch);
          return (
            <React.Fragment key={li}>
              {showCh && <div className="pill" style={{ margin: "8px 0 2px", borderColor: "var(--chapter)" }}>{ch.title}</div>}
              <span className="line">
                <span className="t">{fmt(words[line[0]].s)}</span>
                {line.map((i) => {
                  const w = words[i];
                  const fixed = display(w);
                  const lvl = levelAt(w);
                  const inSel = range && i >= range[0] && i <= range[1];
                  const cls = ["w", i === nowIdx ? "now" : "", inSel ? "sel" : "", kw.has(norm(fixed ?? w.w)) || kw.has(norm(w.w)) ? "key" : "",
                    fixed != null ? "fixed" : "", lvl ? `lvl-${lvl}` : "", w.p != null && w.p < 0.5 ? "unsure" : ""].filter(Boolean).join(" ");
                  return (
                    <React.Fragment key={i}>
                      <span ref={i === nowIdx ? nowRef : null} className={cls} data-i={i} title={`${fmt(w.s)}${fixed != null ? ` · heard "${w.w}"` : ""}`}
                        onPointerDown={(e) => { e.preventDefault(); dragging.current = i; setHeld(true); setSel([i, i]); }}
                        onClick={() => { if (!range || range[0] === range[1]) onSeek(w.s); }}>
                        {fixed === "" ? <s>{w.w}</s> : fixed ?? w.w}
                      </span>{" "}
                    </React.Fragment>
                  );
                })}
              </span>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
