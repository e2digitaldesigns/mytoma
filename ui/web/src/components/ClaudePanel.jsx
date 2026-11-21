import React, { useState } from "react";

// Option 2: the studio is the kitchen, Claude is the chef. This panel hands Claude the job in one message.
export default function ClaudePanel({ state }) {
  const [copied, setCopied] = useState(false);
  const dir = state.hostDir || state.dir;
  const s = state.edit.stretches || [];
  const marks = s.length
    ? s.map((x) => `  - ${x.a.toFixed(2)}–${x.b.toFixed(2)} s: ${x.level === "none" ? "no graphics (only my face)" : x.level === "limited" ? "limited (my face stays on screen, light graphics)" : "full graphics"}${x.subtitles ? "" : ", no subtitles"}`).join("\n")
    : "  (none marked: plan the whole video freely)";
  const ch = (state.edit.chapters || []).map((c) => `  - ${c.a.toFixed(2)}–${c.b.toFixed(2)} s: ${c.title}`).join("\n") || "  (none)";
  const prompt = `Use the mytoma skill to plan and author this video.

Project folder: ${dir}
The recording is transcribed and trimmed; transcript.txt has every word with its time.

Stretches I marked (edit.json; they are rules, and check enforces them):
${marks}

Chapters (drawn automatically, keep shots clear of them):
${ch}

1. Read transcript.txt, edit.json and take.json.
2. Write the shot list (time, line, what it shows) and show it to me before authoring.
3. Author index.html between BEGIN/END SHOTS and BEGIN/END TIMELINE. Face shots use faceCam over the take.
4. Run: node <skill>/scripts/cli.js check ${dir}   until it is clean.
Don't render or mix: I'll preview and render in the myToma studio, which reloads when index.html changes.`;

  return (
    <div>
      <h2>Ask Claude</h2>
      <p className="hint">
        Claude plans the shots and writes the animation. Paste this into Claude (Claude Code, or the desktop app with this
        project's folder connected). When Claude saves the timeline, the preview here reloads by itself.
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="primary" onClick={async () => {
          try { await navigator.clipboard.writeText(prompt); } catch { /* no clipboard on plain http: select the text instead */ }
          setCopied(true); setTimeout(() => setCopied(false), 1800);
        }}>{copied ? "Copied" : "Copy for Claude"}</button>
        <span className="muted small">{state.timeline.shots.length} shot{state.timeline.shots.length === 1 ? "" : "s"} in the timeline now</span>
      </div>
      <div className="prompt" onClick={(e) => window.getSelection().selectAllChildren(e.currentTarget)}>{prompt}</div>
      <p className="hint" style={{ marginTop: 10 }}>
        Then ask for changes the same way: “make the intro punchier”, “put the chart on the spaghetti line”, “less graphics in chapter 2”.
      </p>
    </div>
  );
}
