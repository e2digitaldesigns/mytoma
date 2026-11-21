import React from "react";
import { fmt } from "../api.js";

const LEVELS = [
  ["none", "No graphics", "Only you on screen. Captions and the chapter bar still follow their own settings."],
  ["limited", "Limited", "You stay on screen; light touches over you: a name tag, a number, a small chart in a corner."],
  ["full", "Full", "Anything goes: the animated treatment."],
];

// Properties of whatever is selected; with nothing selected, the project's settings.
export default function Inspector({ state, cfg, edit, selection, setSelection, duration, t, onChangeEdit, onSettings }) {
  if (selection) {
    const key = selection.kind === "stretch" ? "stretches" : "chapters";
    const item = edit[key][selection.index];
    if (!item) return null;
    const list = edit[key];
    const set = (patch) => {
      const next = list.slice();
      next[selection.index] = { ...item, ...patch };
      onChangeEdit({ [key]: next });
    };
    const lo = list[selection.index - 1]?.b ?? 0;
    const hi = list[selection.index + 1]?.a ?? duration;
    const time = (field) => (e) => {
      const v = Math.round(Number(e.target.value) * 100) / 100;
      if (!Number.isFinite(v)) return;
      if (field === "a") set({ a: Math.max(lo, Math.min(item.b - 0.2, v)) });
      else set({ b: Math.min(hi, Math.max(item.a + 0.2, v)) });
    };
    return (
      <div>
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }} className="grow">{selection.kind === "stretch" ? "Graphics stretch" : "Chapter"}</h2>
          <button className="ghost icon" onClick={() => setSelection(null)} title="Close">✕</button>
        </div>
        {selection.kind === "chapter" && (
          <label className="field">Title
            <input type="text" value={item.title} onChange={(e) => set({ title: e.target.value })} />
          </label>
        )}
        <div className="row">
          <label className="field grow">Start (s)
            <input type="number" step="0.01" min={lo} max={item.b} value={item.a} onChange={time("a")} />
          </label>
          <label className="field grow">End (s)
            <input type="number" step="0.01" min={item.a} max={hi} value={item.b} onChange={time("b")} />
          </label>
        </div>
        <div className="row" style={{ marginBottom: 14 }}>
          <button onClick={() => set({ a: Math.max(lo, Math.min(item.b - 0.2, t)) })}>Start at playhead</button>
          <button onClick={() => set({ b: Math.min(hi, Math.max(item.a + 0.2, t)) })}>End at playhead</button>
        </div>
        <p className="hint">{fmt(item.a)} – {fmt(item.b)} · {(item.b - item.a).toFixed(2)} s</p>
        {selection.kind === "stretch" && (
          <>
            <h3>Graphics</h3>
            {LEVELS.map(([lvl, label, text]) => (
              <label key={lvl} className="check" style={{ alignItems: "flex-start" }}>
                <input type="radio" name="level" checked={item.level === lvl} onChange={() => set({ level: lvl })} />
                <span><b>{label}</b><br /><span className="muted small">{text}</span></span>
              </label>
            ))}
            <label className="check">
              <input type="checkbox" checked={item.subtitles !== false} onChange={(e) => set({ subtitles: e.target.checked })} />
              Show subtitles in this stretch
            </label>
          </>
        )}
        <button className="danger" onClick={() => { onChangeEdit({ [key]: list.filter((_, i) => i !== selection.index) }); setSelection(null); }}>
          Delete {selection.kind}
        </button>
      </div>
    );
  }

  const s = state.project.settings || {};
  const cs = edit.chapterStyle || { mode: "both", position: "auto" };
  const autoPos = state.comp && state.comp.width > state.comp.height ? "bottom" : "top";
  return (
    <div>
      <h2>Chapters</h2>
      <label className="field">Show
        <select value={cs.mode} onChange={(e) => onChangeEdit({ chapterStyle: { ...cs, mode: e.target.value } })}>
          <option value="both">Name and progress bar</option>
          <option value="name">Chapter name only</option>
          <option value="bar">Progress bar only</option>
          <option value="off">Nothing</option>
        </select>
      </label>
      <label className="field">Position
        <select value={cs.position} onChange={(e) => onChangeEdit({ chapterStyle: { ...cs, position: e.target.value } })}>
          <option value="auto">Automatic ({autoPos} for this format)</option>
          <option value="top">Top</option>
          <option value="bottom">Bottom</option>
        </select>
      </label>
      <p className="hint">Mark chapters on the Chapters track or from the transcript. Turn on the platform overlay under the preview to see what the app's buttons cover.</p>

      <h2 style={{ marginTop: 22 }}>Sound</h2>
      <label className="field">Music
        <select value={s.music || "synth"} onChange={(e) => onSettings({ music: e.target.value })}>
          {(cfg?.music || [{ id: "synth", description: "" }]).map((m) => <option key={m.id} value={m.id}>{m.id}{m.description ? ` · ${m.description}` : ""}</option>)}
        </select>
      </label>
      <label className="field">Music level ({Number(s.musicLevel ?? 0.22).toFixed(2)})
        <input type="range" min="0" max="0.6" step="0.01" defaultValue={s.musicLevel ?? 0.22}
          onMouseUp={(e) => onSettings({ musicLevel: Number(e.target.value) })} onKeyUp={(e) => onSettings({ musicLevel: Number(e.target.value) })} />
      </label>
      {state.audio.mixReport && (
        <p className="hint">Last mix: {state.audio.mixReport.loudness?.lufs} LUFS · {state.audio.mixReport.placed?.length} sound cues{state.audio.mixReport.skipped?.length ? ` · ${state.audio.mixReport.skipped.length} skipped` : ""}</p>
      )}

      <h2 style={{ marginTop: 22 }}>Transcription</h2>
      <label className="field">Names and terms (spelling hints)
        <input type="text" defaultValue={s.vocab || ""} placeholder="iCon, Claude, Tulsa" onBlur={(e) => onSettings({ vocab: e.target.value })} />
      </label>
      <div className="row">
        <label className="field grow">Model
          <select value={s.model || ""} onChange={(e) => onSettings({ model: e.target.value })}>
            <option value="">small (default)</option>
            <option value="base">base · faster</option>
            <option value="medium">medium · more accurate</option>
            <option value="large-v3-turbo">large-v3-turbo · best, GPU</option>
          </select>
        </label>
        <label className="field" style={{ width: 90 }}>Language
          <input type="text" defaultValue={s.language || ""} placeholder="auto" onBlur={(e) => onSettings({ language: e.target.value })} />
        </label>
      </div>
    </div>
  );
}
