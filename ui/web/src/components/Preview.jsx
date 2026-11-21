import React, { useCallback, useEffect, useRef, useState } from "react";
import { fmt } from "../api.js";

// Where each platform's own buttons and text sit over the video, as fractions of the frame (x, y, w, h)
const ZONES = {
  shorts: [
    ["top bar", 0, 0, 1, 0.07], ["like · comment · share", 0.84, 0.48, 0.16, 0.4], ["title · channel", 0, 0.82, 0.82, 0.18],
  ],
  tiktok: [
    ["top tabs", 0, 0, 1, 0.09], ["actions", 0.84, 0.42, 0.16, 0.44], ["caption · username", 0, 0.78, 0.8, 0.22],
  ],
  youtube: [
    ["title (paused)", 0, 0, 1, 0.1], ["progress bar · controls", 0, 0.88, 1, 0.12],
  ],
};

// The live preview: the real composition in an iframe, drawn by calling its renderAt(t). No render needed.
export default function Preview({ id, comp, t, setT, playing, setPlaying, reloadKey, audioUrl, overlay, setOverlay }) {
  const stageRef = useRef(null);
  const frameRef = useRef(null);
  const audioRef = useRef(null);
  const pending = useRef(false);
  const latest = useRef(t);
  const [scale, setScale] = useState(0.3);
  const [status, setStatus] = useState({ ready: false, error: "" });
  const W = comp?.width || 1080, H = comp?.height || 1920, D = comp?.duration || 0;

  // fit the frame into the stage
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const fit = () => setScale(Math.max(0.05, Math.min((el.clientWidth - 24) / W, (el.clientHeight - 24) / H)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  // draw t; while a frame is still drawing (a face image decoding) only the newest t is kept
  const draw = useCallback((time) => {
    latest.current = time;
    const win = frameRef.current?.contentWindow;
    if (!status.ready || !win?.renderAt || pending.current) return;
    try {
      const r = win.renderAt(time);
      if (r && typeof r.then === "function") {
        pending.current = true;
        r.then(() => {
          pending.current = false;
          if (latest.current !== time) draw(latest.current);
        }, (e) => { pending.current = false; setStatus({ ready: true, error: e.message }); });
      }
    } catch (e) { setStatus({ ready: true, error: e.message }); }
  }, [status.ready]);

  const onLoad = useCallback(async () => {
    const win = frameRef.current?.contentWindow;
    setStatus({ ready: false, error: "" });
    if (!win) return;
    const errors = [];
    win.addEventListener("error", (e) => errors.push(e.message));
    try {
      if (!win.MT_READY) throw new Error(errors[0] || "The composition did not start (is MT.finish() called?)");
      await win.MT_READY;
      setStatus({ ready: true, error: "" });
    } catch (e) {
      setStatus({ ready: false, error: e.message || String(e) });
    }
  }, []);

  useEffect(() => { if (!playing) draw(t); }, [t, playing, draw, status.ready]);

  // play: the audio is the clock when there is audio; otherwise the wall clock
  useEffect(() => {
    if (!playing) { audioRef.current?.pause(); return undefined; }
    let raf, t0 = performance.now(), from = t >= D - 0.05 ? 0 : t;
    const audio = audioRef.current;
    if (audio && audioUrl) {
      audio.currentTime = from;
      audio.play().catch(() => {});
    }
    const tick = () => {
      const now = audio && audioUrl && !audio.paused ? audio.currentTime : from + (performance.now() - t0) / 1000;
      if (now >= D) { setT(D); setPlaying(false); return; }
      setT(now);
      draw(now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);   // eslint-disable-line react-hooks/exhaustive-deps

  const step = (dt) => { setPlaying(false); setT(Math.max(0, Math.min(D, Math.round((t + dt) * 30) / 30))); };

  return (
    <>
      <div className="stage" ref={stageRef}>
        <div className="frame-wrap" style={{ width: W * scale, height: H * scale }}>
          <iframe ref={frameRef} key={reloadKey} title="preview" src={`/files/${id}/index.html?v=${reloadKey}`}
            style={{ width: W, height: H, transform: `scale(${scale})` }} onLoad={onLoad} />
          {overlay !== "off" && (
            <div className="overlay">
              {(ZONES[overlay] || []).map(([label, x, y, w, h]) => (
                <div key={label} className="zone" style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}>{label}</div>
              ))}
            </div>
          )}
          {!status.ready && !status.error && <div className="stage-msg">Loading the composition…</div>}
        </div>
        {status.error && (
          <div className="stage-msg"><div>
            <p className="error">{status.error}</p>
            <p className="small">Fix the composition (or ask Claude to), and the preview reloads by itself.</p>
          </div></div>
        )}
      </div>
      <div className="transport">
        <button className="icon" onClick={() => step(-1)} title="Back 1 s (Shift+←)">⏮</button>
        <button className="icon" onClick={() => step(-1 / 30)} title="Back one frame (←)">◀︎</button>
        <button className="primary icon" style={{ minWidth: 44, justifyContent: "center" }} onClick={() => setPlaying(!playing)} title="Play / pause (Space)">
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="icon" onClick={() => step(1 / 30)} title="Forward one frame (→)">▶︎</button>
        <button className="icon" onClick={() => step(1)} title="Forward 1 s (Shift+→)">⏭</button>
        <span className="timecode">{fmt(t)} / {fmt(D)} · f{Math.round(t * 30)}</span>
        <span className="grow" />
        <span className="muted small">{audioUrl ? (audioUrl.includes("mix") ? "mix" : "voice only") : "no audio"}</span>
        <label className="row small muted">Platform overlay
          <select value={overlay} onChange={(e) => setOverlay(e.target.value)} style={{ width: 130 }}>
            <option value="off">Off</option>
            <option value="shorts">YouTube Shorts</option>
            <option value="tiktok">TikTok</option>
            <option value="youtube">YouTube (landscape)</option>
          </select>
        </label>
        <audio ref={audioRef} src={audioUrl ? `/files/${id}/${audioUrl}?v=${reloadKey}` : undefined} preload="auto" />
      </div>
    </>
  );
}
