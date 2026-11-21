// Thin client for the studio API. Every call throws an Error carrying the server's message.

async function call(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined && !(body instanceof Blob) ? { "Content-Type": "application/json", ...headers } : headers,
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) {
    const e = new Error(data?.error || `${res.status} ${res.statusText}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

export const api = {
  session: () => call("GET", "/api/session"),
  login: (password) => call("POST", "/api/login", { password }),
  config: () => call("GET", "/api/config"),
  projects: () => call("GET", "/api/projects"),
  create: (p) => call("POST", "/api/projects", p),
  project: (id) => call("GET", `/api/projects/${id}`),
  patch: (id, p) => call("PATCH", `/api/projects/${id}`, p),
  saveEdit: (id, edit) => call("PUT", `/api/projects/${id}/edit`, edit),
  saveTranscript: (id, fixes, keywords) => call("PUT", `/api/projects/${id}/transcript`, { fixes, keywords }),
  setSource: (id, path) => call("POST", `/api/projects/${id}/source`, { path }),
  browse: (path) => call("GET", `/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  run: (id, step) => call("POST", `/api/projects/${id}/run/${step}`, {}),
  searchImages: (id, search) => call("POST", `/api/projects/${id}/images/search`, search),
  addImages: (id, ids, name) => call("POST", `/api/projects/${id}/images/add`, { ids, name }),
  jobs: () => call("GET", "/api/jobs"),
  job: (id) => call("GET", `/api/jobs/${id}`),
};

// Upload with progress: fetch has no upload progress, XHR does
export function upload(id, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/projects/${id}/upload`);
    xhr.setRequestHeader("X-Filename", file.name);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
      xhr.status < 300 ? resolve(data) : reject(new Error(data?.error || `upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("upload failed: network error"));
    xhr.send(file);
  });
}

export const fmt = (t) => {
  if (!Number.isFinite(t)) return "--:--";
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
};
