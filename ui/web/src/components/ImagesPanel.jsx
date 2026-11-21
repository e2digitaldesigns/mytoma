import React, { useState } from "react";
import { api } from "../api.js";

// Find images: openly licensed photos from Wikimedia Commons, Openverse, the Internet Archive (and Pexels with a key),
// through the skill's find_media.py. Picked ones are saved into the project's assets/ with their credits.
export default function ImagesPanel({ state, onChanged, notify }) {
  const [search, setSearch] = useState({ query: "", orientation: "", minWidth: 1080 });
  const [result, setResult] = useState(null);
  const [picked, setPicked] = useState([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const base = `/files/${state.id}`;

  const find = async (event) => {
    event.preventDefault();
    if (!search.query.trim()) return;
    setBusy("Searching…");
    setPicked([]);
    try {
      const found = await api.searchImages(state.id, search);
      setResult(found);
      setName(search.query);
    } catch (error) { notify(error.message, true); }
    setBusy("");
  };
  const toggle = (identifier) => setPicked((current) => (current.includes(identifier)
    ? current.filter((other) => other !== identifier) : [...current, identifier]));
  const add = async () => {
    setBusy("Downloading…");
    try {
      const added = await api.addImages(state.id, picked, name);
      notify(`Added ${added.saved.map((entry) => entry.file.replace("assets/", "")).join(", ") || "nothing"}`, !added.saved.length);
      setPicked([]);
      onChanged(added.state);
    } catch (error) { notify(error.message, true); }
    setBusy("");
  };

  return (
    <div className="images">
      <h2>Find images</h2>
      <p className="hint">Openly licensed photos only (public domain, CC0, CC BY, CC BY-SA, Pexels). Never photos of private
        people; logos come from your brand, not a search.</p>
      <form onSubmit={find}>
        <div className="row">
          <input type="search" placeholder="e.g. thick french fries" value={search.query} autoFocus
            onChange={(event) => setSearch({ ...search, query: event.target.value })} />
          <button className="primary" type="submit" disabled={!!busy || !search.query.trim()}>Search</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <select value={search.orientation} onChange={(event) => setSearch({ ...search, orientation: event.target.value })} title="Orientation">
            <option value="">Any shape</option>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
          <label className="row small muted" style={{ gap: 6, whiteSpace: "nowrap" }}>min width
            <input type="number" min="0" step="10" style={{ width: 84 }} value={search.minWidth}
              onChange={(event) => setSearch({ ...search, minWidth: event.target.value })} /> px
          </label>
        </div>
      </form>
      {busy && <p className="hint" style={{ marginTop: 10 }}>{busy}</p>}

      {result && (
        <>
          <p className="hint" style={{ marginTop: 12 }}>
            {result.candidates.length} result{result.candidates.length === 1 ? "" : "s"} for “{result.query}”
            {result.skipped.length > 0 && <> · {result.skipped.length} skipped (<span title={result.skipped.slice(0, 12)
              .map((skip) => `${skip.title}: ${skip.reason}`).join("\n")}>why?</span>)</>}
          </p>
          <div className="image-grid">
            {result.candidates.map((candidate) => (
              <button key={candidate.id} type="button" className={`image-card ${picked.includes(candidate.id) ? "on" : ""}`}
                onClick={() => toggle(candidate.id)} title={candidate.title}>
                <img src={candidate.thumb_url} alt={candidate.title} loading="lazy" referrerPolicy="no-referrer" />
                <span className="pill">{candidate.licence}</span>
                <span className="small clip">{candidate.title}</span>
                <span className="muted small clip">by {candidate.author || "unknown"} · {candidate.width ? `${candidate.width}×${candidate.height}` : "size ?"}</span>
                <a className="small" href={candidate.page_url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>source ↗</a>
                {candidate.people && <span className="error small">shows identifiable people</span>}
              </button>
            ))}
          </div>
          {picked.length > 0 && (
            <div className="row add-bar">
              <input type="text" value={name} onChange={(event) => setName(event.target.value)} title="File name, e.g. fries → assets/fries-01.jpg" />
              <button className="primary" onClick={add} disabled={!!busy}>Add {picked.length} to project</button>
            </div>
          )}
        </>
      )}

      <h2 style={{ marginTop: 22 }}>In this project</h2>
      {!state.images.length && <p className="hint">No images yet. Added ones land in assets/ with their credit.</p>}
      <div className="image-list">
        {state.images.map((image) => (
          <div key={image.file} className="row">
            <img src={`${base}/${image.file}?v=${Math.round(image.mtime)}`} alt="" />
            <div className="grow">
              <div className="small">{image.file}</div>
              {image.credit
                ? <div className="muted small">{image.credit.licence} · by {image.credit.author} · <a href={image.credit.source_url} target="_blank" rel="noreferrer">{image.credit.source}</a></div>
                : <div className="error small">no credit in credits.json</div>}
            </div>
          </div>
        ))}
      </div>
      {state.credits && <p className="hint" style={{ marginTop: 10 }}>Credits for the description: <a href={`${base}/${state.credits}`} download="credits.txt">credits.txt</a></p>}
      <p className="hint">Ask Claude to place them: <code>photo("#p1", start, end)</code> puts one behind a shot with the brand tint.</p>
    </div>
  );
}
