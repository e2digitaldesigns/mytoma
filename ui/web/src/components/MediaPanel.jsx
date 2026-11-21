import React, { useState } from "react";
import { api, upload } from "../api.js";

const size = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`);

const STEPS = [
  ["prepare", "Transcribe, trim and caption", "Words with timestamps, dead air cut, captions built. Re-run after changing the recording."],
  ["face", "Face frames", "Your frames for face shots and for no-graphics / limited stretches. Render does this by itself when needed."],
  ["check", "Check", "Text off the frame, captions too wide, and graphics inside your no-graphics stretches."],
  ["sound", "Mix sound", "Voice, music ducked under it, and every sound cue: -14 LUFS."],
  ["draft", "Render draft", "Fast, lower quality: for checking timing."],
  ["render", "Render final", "Full quality."],
];

export default function MediaPanel({ state, cfg, jobs, onRun, onChanged, notify }) {
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState(null);
  const [browser, setBrowser] = useState(null);
  const id = state.id;
  const take = state.take;

  const send = async (file) => {
    if (!file) return;
    setProgress(0);
    try {
      await upload(id, file, setProgress);
      notify(`Uploaded ${file.name}`);
      onChanged();
    } catch (e) { notify(e.message, true); }
    setProgress(null);
  };
  const open = async (p) => {
    try { setBrowser(await api.browse(p)); } catch (e) { notify(e.message, true); }
  };
  const pick = async (p) => {
    try { await api.setSource(id, p); setBrowser(null); notify("Recording set"); onChanged(); } catch (e) { notify(e.message, true); }
  };
  const last = (step) => [...jobs].reverse().find((j) => j.step === step);

  return (
    <div>
      <h2>Recording</h2>
      {state.project.source
        ? <p style={{ marginTop: 0, wordBreak: "break-all" }}>{state.project.source.split("/").pop()}<br /><span className="muted small">{state.project.source}</span></p>
        : <p className="hint">Drop your take below, or pick it from this computer's folders (best for big files: nothing is copied).</p>}
      {take?.probe && (
        <p className="hint">
          {take.probe.width}×{take.probe.height} · {take.probe.fps} fps{take.probe.vfr ? " (variable)" : ""} · {take.probe.bitrate_mbps} Mbps
          · kept {take.duration.toFixed(1)} s of {take.probe.duration.toFixed(1)} s
          {take.probe.hdr && <><br /><span className="error">HDR recording: face shots will look washed out. Re-record in SDR.</span></>}
        </p>
      )}
      <label className={`drop ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files[0]); }}>
        <input type="file" accept="video/*,audio/*" style={{ display: "none" }} onChange={(e) => send(e.target.files[0])} />
        {progress != null ? <>Uploading… {Math.round(progress * 100)}%<div className="progress" style={{ marginTop: 8 }}><div style={{ width: `${progress * 100}%` }} /></div></>
          : <>Drop a video or audio file here, or click to choose</>}
      </label>
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => (browser ? setBrowser(null) : open(null))}>{browser ? "Close folders" : "Pick from this computer's folders"}</button>
      </div>
      {browser && (
        <div className="browser">
          {browser.parent !== undefined && browser.path && (
            <div onClick={() => open(browser.parent)}>⬑ {browser.parent || "media folders"}</div>
          )}
          {browser.entries.map((e) => (
            <div key={e.path} onClick={() => (e.dir ? open(e.path) : pick(e.path))}>
              <span>{e.dir ? "📁" : "🎞"} {e.name}</span>
              {!e.dir && <span className="muted small">{size(e.size)}</span>}
            </div>
          ))}
          {!browser.entries.length && <div className="muted">No video or audio files here</div>}
        </div>
      )}

      <h2 style={{ marginTop: 22 }}>Pipeline</h2>
      <div className="steps">
        {STEPS.map(([step, label, text]) => {
          const j = last(step);
          const st = j?.status;
          return (
            <div key={step} className="step">
              <span className={`dot ${st === "done" ? "done" : st === "failed" ? "failed" : st ? "running" : ""}`} />
              <div className="grow">
                <div>{label}</div>
                <div className="muted small">{st === "failed" ? <span className="error">{j.error}</span>
                  : j?.summary ? <span className={/finding/.test(j.summary) ? "error" : ""}>{j.summary}: see the log</span> : text}</div>
                {(st === "running") && j.progress != null && <div className="progress" style={{ marginTop: 5 }}><div style={{ width: `${j.progress * 100}%` }} /></div>}
              </div>
              <button onClick={() => onRun(step)} disabled={st === "running" || st === "queued" || (step === "prepare" && !state.project.source)}>Run</button>
            </div>
          );
        })}
      </div>
      <p className="hint" style={{ marginTop: 14 }}>Projects live in <span style={{ wordBreak: "break-all" }}>{cfg?.projects}</span>.</p>
    </div>
  );
}
