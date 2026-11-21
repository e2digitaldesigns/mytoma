import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

// The most recent job for this project, with its live log; collapses to a status line.
export default function JobsDrawer({ jobs }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(null);
  const pre = useRef(null);
  const job = jobs[jobs.length - 1];

  // opens while a job runs; folds away after a clean finish, stays open on failures and findings
  useEffect(() => {
    if (job?.status === "running") setOpen(true);
    if (job?.status === "done" && !/finding/.test(job.summary || "")) {
      const timer = setTimeout(() => setOpen(false), 3000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [job?.id, job?.status, job?.summary]);
  useEffect(() => {
    if (open && job && job.status !== "running") api.job(job.id).then(setFull).catch(() => {});
  }, [open, job?.id, job?.status]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [job?.tail?.length, open, full]);

  if (!job) return null;
  const lines = full?.id === job.id && job.status !== "running" ? full.log : job.tail || [];
  const dot = job.status === "done" ? "var(--ok)" : job.status === "failed" ? "var(--bad)" : "var(--warn)";
  return (
    <div className="jobs" style={open ? {} : { maxHeight: 42 }}>
      <header onClick={() => setOpen(!open)}>
        <span style={{ width: 9, height: 9, borderRadius: 9, background: dot }} />
        <b className="grow">{job.label}</b>
        <span className="muted small">{job.summary || job.status}{job.progress != null && job.status === "running" ? ` · ${Math.round(job.progress * 100)}%` : ""}</span>
        <span className="muted">{open ? "▾" : "▴"}</span>
      </header>
      {open && <pre ref={pre}>{lines.join("\n")}</pre>}
    </div>
  );
}
