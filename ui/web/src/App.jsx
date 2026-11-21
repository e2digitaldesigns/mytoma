import React, { useEffect, useState } from "react";
import { api } from "./api.js";
import Editor from "./components/Editor.jsx";

// #/ → projects, #/p/<id> → editor
function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const m = hash.match(/^#\/p\/([a-z0-9-]+)/);
  return m ? { page: "editor", id: m[1] } : { page: "home" };
}

export default function App() {
  const [session, setSession] = useState(null);
  const route = useRoute();
  useEffect(() => { api.session().then(setSession).catch(() => setSession({ authed: false, passwordRequired: true })); }, []);
  if (!session) return null;
  if (!session.authed) return <Login onDone={() => setSession({ ...session, authed: true })} />;
  return route.page === "editor" ? <Editor key={route.id} id={route.id} /> : <Home />;
}

function Login({ onDone }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    try { await api.login(password); onDone(); } catch (err) { setError(err.message); }
  };
  return (
    <div className="center-page">
      <form className="card" style={{ width: 340 }} onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 18 }}>my<span>Toma</span> studio</div>
        <label className="field">Password
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error small">{error}</p>}
        <button className="primary" type="submit" style={{ width: "100%", justifyContent: "center" }}>Log in</button>
      </form>
    </div>
  );
}

function Home() {
  const [projects, setProjects] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState({ name: "", format: "vertical", template: "starter" });
  const [error, setError] = useState("");
  useEffect(() => {
    api.projects().then(setProjects).catch((e) => setError(e.message));
    api.config().then(setCfg).catch(() => {});
  }, []);
  const create = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const p = await api.create(form);
      window.location.hash = `#/p/${p.id}`;
    } catch (err) { setError(err.message); }
  };
  return (
    <div className="home">
      <header>
        <div className="brand">my<span>Toma</span> studio</div>
        <span className="muted small">{cfg?.projects}</span>
      </header>
      <form className="card" onSubmit={create} style={{ marginBottom: 26 }}>
        <h2>New video</h2>
        <div className="row wrap" style={{ alignItems: "flex-end" }}>
          <label className="field grow" style={{ marginBottom: 0, minWidth: 220 }}>Name
            <input type="text" placeholder="e.g. Dark Truth: the Tulsa massacre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field" style={{ marginBottom: 0 }}>Format
            <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
              <option value="vertical">Vertical 1080×1920 (Shorts)</option>
              <option value="landscape">Landscape 1920×1080 (long form)</option>
              <option value="square">Square 1080×1080</option>
              <option value="portrait">Portrait 1080×1350</option>
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0 }}>Start from
            <select value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })}>
              {(cfg?.templates || ["starter"]).map((t) => <option key={t} value={t}>{t === "starter" ? "Blank (starter)" : `Example: ${t}`}</option>)}
            </select>
          </label>
          <button className="primary" type="submit">Create</button>
        </div>
        {error && <p className="error small">{error}</p>}
      </form>
      <h2>Projects</h2>
      {projects && !projects.length && <p className="muted">No projects yet.</p>}
      <div className="projects">
        {(projects || []).map((p) => (
          <button key={p.id} className="project-card" onClick={() => { window.location.hash = `#/p/${p.id}`; }}>
            <span className="title">{p.name}</span>
            <span className="row wrap">
              <span className="pill">{p.format}</span>
              {p.transcribed ? <span className="pill">transcribed</span> : <span className="pill">no transcript</span>}
              {p.outputs > 0 && <span className="pill">{p.outputs} render{p.outputs > 1 ? "s" : ""}</span>}
            </span>
            <span className="muted small">{p.source || "no recording yet"} · {new Date(p.updated).toLocaleString()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
