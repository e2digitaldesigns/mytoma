import React from "react";

export default function RendersPanel({ state }) {
  const base = `/files/${state.id}`;
  return (
    <div className="renders">
      <h2>Renders</h2>
      {!state.outputs.length && <p className="hint">Nothing rendered yet. Use Render draft for a quick look, Render for the final.</p>}
      {state.outputs.map((o) => (
        <div key={o.file} style={{ marginBottom: 18 }}>
          <div className="row">
            <b className="grow">{o.draft ? "Draft" : "Final"}</b>
            <span className="muted small">{(o.size / 1e6).toFixed(1)} MB · {new Date(o.mtime).toLocaleString()}</span>
          </div>
          <video controls preload="metadata" src={`${base}/${o.url}?v=${Math.round(o.mtime)}`} />
          <a href={`${base}/${o.url}`} download={o.file}>Download {o.file}</a>
        </div>
      ))}
      {state.captions && (
        <p className="hint">Subtitles for upload: <a href={`${base}/captions.srt`} download>captions.srt</a> · <a href={`${base}/captions.vtt`} download>captions.vtt</a></p>
      )}
    </div>
  );
}
