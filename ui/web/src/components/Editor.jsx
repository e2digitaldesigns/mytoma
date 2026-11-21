import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import Preview from "./Preview.jsx";
import Timeline from "./Timeline.jsx";
import Transcript from "./Transcript.jsx";
import Inspector from "./Inspector.jsx";
import MediaPanel from "./MediaPanel.jsx";
import ClaudePanel from "./ClaudePanel.jsx";
import RendersPanel from "./RendersPanel.jsx";
import ImagesPanel from "./ImagesPanel.jsx";
import JobsDrawer from "./JobsDrawer.jsx";

export default function Editor({ id }) {
  const [state, setState] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState(null);       // {kind: "stretch" | "chapter", index}
  const [tab, setTab] = useState("media");
  const [jobs, setJobs] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [toast, setToast] = useState(null);
  const [overlay, setOverlay] = useState("off");
  const [pps, setPps] = useState(60);                     // timeline zoom: pixels per second
  const saveTimer = useRef(null);

  const notify = useCallback((text, bad = false) => {
    setToast({ text, bad });
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => setToast(null), bad ? 6000 : 2500);
  }, []);

  const load = useCallback(async (reloadPreview = false) => {
    try {
      const s = await api.project(id);
      setState(s);
      setEdit((cur) => cur ?? s.edit);
      if (reloadPreview) setReloadKey((k) => k + 1);
    } catch (e) { setError(e.message); }
  }, [id]);

  useEffect(() => {
    load();
    api.config().then(setCfg).catch(() => {});
    api.jobs().then(setJobs).catch(() => {});
  }, [load]);

  // live job updates, and "Claude changed the timeline" → reload state + preview
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("job", (e) => {
      const j = JSON.parse(e.data);
      setJobs((list) => [...list.filter((x) => x.id !== j.id), j]);
      if (j.project === id && (j.status === "done" || j.status === "failed")) {
        notify(`${j.label}: ${j.status === "done" ? (j.summary || "done") : "failed"}`, j.status === "failed" || /finding/.test(j.summary || ""));
      }
    });
    es.addEventListener("log", (e) => {
      const l = JSON.parse(e.data);
      setJobs((list) => list.map((j) => (j.id === l.id ? { ...j, progress: l.progress, tail: [...(j.tail || []).slice(-40), l.line] } : j)));
    });
    es.addEventListener("files", (e) => {
      const f = JSON.parse(e.data);
      if (f.project === id) load(true);
    });
    return () => es.close();
  }, [id, load, notify]);

  // marks: update locally at once, save after a short pause
  const changeEdit = useCallback((patch) => {
    setEdit((cur) => {
      const next = { ...cur, ...patch };
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          const saved = await api.saveEdit(id, next);
          setEdit((now) => (now === next ? saved : now));
        } catch (e) { notify(e.message, true); }
      }, 350);
      return next;
    });
  }, [id, notify]);

  const duration = state?.comp?.duration || 0;
  const seek = useCallback((v) => setT(Math.max(0, Math.min(duration, v))), [duration]);

  const run = useCallback(async (step) => {
    try { await api.run(id, step); } catch (e) { notify(e.message, true); }
  }, [id, notify]);

  // keyboard: space play/pause, ←/→ one frame (shift: one second), Delete removes the selected mark
  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.code === "Space") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setPlaying(false); seek(t + (e.shiftKey ? 1 : 1 / 30)); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); setPlaying(false); seek(t - (e.shiftKey ? 1 : 1 / 30)); }
      else if ((e.key === "Delete" || e.key === "Backspace") && selection && edit) {
        const key = selection.kind === "stretch" ? "stretches" : "chapters";
        changeEdit({ [key]: edit[key].filter((_, i) => i !== selection.index) });
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t, seek, selection, edit, changeEdit]);

  const projectJobs = useMemo(() => jobs.filter((j) => j.project === id), [jobs, id]);
  const busy = projectJobs.find((j) => j.status === "running" || j.status === "queued");

  if (error) return <div className="center-page"><div className="card"><p className="error">{error}</p><a href="#/">Back to projects</a></div></div>;
  if (!state || !edit) return <div className="center-page muted">Loading…</div>;

  const words = state.words || [];
  const audioUrl = state.audio.mix || state.audio.voice;

  return (
    <div className="editor">
      <div className="topbar">
        <button className="ghost icon" onClick={() => { window.location.hash = "#/"; }} title="All projects">◀</button>
        <span className="brand" style={{ fontSize: 15 }}>my<span>Toma</span></span>
        <span className="name">{state.project.name}</span>
        <span className="pill">{state.project.format} · {state.comp?.width}×{state.comp?.height}</span>
        <span className="grow" />
        {busy && <span className="muted small">{busy.label}… {busy.progress != null ? `${Math.round(busy.progress * 100)}%` : ""}</span>}
        <button onClick={() => run("check")} disabled={!!busy}>Check</button>
        <button onClick={() => run("sound")} disabled={!!busy || !state.take}>Mix sound</button>
        <button onClick={() => run("draft")} disabled={!!busy}>Render draft</button>
        <button className="primary" onClick={() => run("render")} disabled={!!busy}>Render</button>
      </div>

      <div className="left">
        <div className="tabs">
          {[["media", "Media"], ["transcript", "Transcript"], ["images", "Find images"], ["claude", "Claude"], ["renders", `Renders${state.outputs.length ? ` (${state.outputs.length})` : ""}`]].map(([k, label]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        <div className="tab-body">
          {tab === "media" && <MediaPanel state={state} cfg={cfg} jobs={projectJobs} onRun={run} onChanged={() => load(true)} notify={notify} />}
          {tab === "transcript" && (
            <Transcript id={id} words={words} fixes={state.fixes} keywords={state.keywords} t={t} playing={playing}
              stretches={edit.stretches} chapters={edit.chapters} onSeek={(v) => { setPlaying(false); seek(v); }}
              onMark={(kind, item) => {
                const key = kind === "stretch" ? "stretches" : "chapters";
                const list = edit[key].filter((x) => x.b <= item.a || x.a >= item.b);   // a new mark replaces what it overlaps
                const next = [...list, item].sort((x, y) => x.a - y.a);
                changeEdit({ [key]: next });
                setSelection({ kind, index: next.indexOf(item) });
              }}
              onSaved={(s) => { setState(s); setReloadKey((k) => k + 1); }} notify={notify} />
          )}
          {tab === "images" && <ImagesPanel state={state} onChanged={(next) => setState(next)} notify={notify} />}
          {tab === "claude" && <ClaudePanel state={state} />}
          {tab === "renders" && <RendersPanel state={state} />}
        </div>
      </div>

      <div className="center">
        <Preview id={id} comp={state.comp} t={t} setT={setT} playing={playing} setPlaying={setPlaying}
          reloadKey={reloadKey} audioUrl={audioUrl} overlay={overlay} setOverlay={setOverlay} />
      </div>

      <div className="right">
        <Inspector state={state} cfg={cfg} edit={edit} selection={selection} setSelection={setSelection}
          duration={duration} t={t} onChangeEdit={changeEdit} onSettings={async (settings) => {
            try { await api.patch(id, { settings }); load(); } catch (e) { notify(e.message, true); }
          }} />
      </div>

      <div className="bottom">
        <Timeline duration={duration} t={t} onSeek={(v) => { setPlaying(false); seek(v); }} playing={playing}
          shots={state.timeline.shots} faces={state.timeline.faces} phrases={state.captions?.phrases || []}
          capWords={state.captions?.words || []} words={words} edit={edit} onChangeEdit={changeEdit}
          selection={selection} onSelect={setSelection} pps={pps} setPps={setPps} />
      </div>

      <JobsDrawer jobs={projectJobs} />
      {toast && <div className={`toast ${toast.bad ? "bad" : ""}`}>{toast.text}</div>}
    </div>
  );
}
