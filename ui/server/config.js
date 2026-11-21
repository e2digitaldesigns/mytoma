// Studio settings, all from the environment so the same code runs bare or in Docker.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const list = (v) => (v ? v.split(/[,:;]/).filter(Boolean).map((p) => path.resolve(p.replace(/^~/, os.homedir()))) : []);

export const config = {
  // where projects live (one folder per video)
  projects: path.resolve((process.env.MYTOMA_PROJECTS || path.join(os.homedir(), "mytoma", "projects")).replace(/^~/, os.homedir())),
  // the same projects folder as the host sees it (Docker): what Claude, outside the container, is told
  projectsHost: process.env.MYTOMA_PROJECTS_HOST || "",
  // folders whose recordings may be picked by path (no upload, no copy)
  media: list(process.env.MYTOMA_MEDIA).length ? list(process.env.MYTOMA_MEDIA) : [path.join(os.homedir())],
  // the myToma skill (scripts, templates, sounds)
  skill: path.resolve(process.env.MYTOMA_SKILL || path.join(here, "..", "..", "skills", "mytoma")),
  python: process.env.MYTOMA_PYTHON || "python3",
  host: process.env.MYTOMA_HOST || "127.0.0.1",
  port: Number(process.env.MYTOMA_PORT || 4173),
  // optional: a password for the whole studio (strongly recommended when reachable from other machines)
  password: process.env.MYTOMA_PASSWORD || "",
  // biggest upload accepted, in MB
  maxUploadMB: Number(process.env.MYTOMA_MAX_UPLOAD_MB || 8192),
  web: path.join(here, "..", "web", "dist"),
};
