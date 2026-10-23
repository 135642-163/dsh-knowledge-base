const BASE = "/kb/api";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-kb-ui"] = "1";
  const response = await fetch(BASE + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(response.status, error.code ?? "HTTP_ERROR", error.message ?? `请求失败 (${response.status})`);
  }
  return payload;
}

function uploadFile(batchId, item, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${BASE}/upload-batches/${encodeURIComponent(batchId)}/files?path=${encodeURIComponent(item.path)}`);
    xhr.setRequestHeader("x-kb-ui", "1");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.responseType = "json";
    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
      };
    }
    xhr.onload = () => {
      const payload = xhr.response ?? null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      reject(new ApiError(xhr.status, payload?.error?.code ?? "HTTP_ERROR", payload?.error?.message ?? `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, "NETWORK_ERROR", "上传失败（网络错误）"));
    xhr.onabort = () => reject(new ApiError(0, "ABORTED", "上传已取消"));
    if (signal?.aborted) {
      reject(new ApiError(0, "ABORTED", "上传已取消"));
      return;
    }
    if (signal) signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(item.file);
  });
}

export const api = {
  status: () => request("GET", "/status"),
  kbs: () => request("GET", "/kbs"),
  kb: (name) => request("GET", `/kbs/${encodeURIComponent(name)}`),
  docs: (name, params = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    return request("GET", `/kbs/${encodeURIComponent(name)}/docs?${query.toString()}`);
  },
  doc: (name, id) => request("GET", `/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}`),
  createKb: (body) => request("POST", "/kbs", body),
  patchKb: (name, body) => request("PATCH", `/kbs/${encodeURIComponent(name)}`, body),
  archiveKb: (name, confirm) => request("POST", `/kbs/${encodeURIComponent(name)}/archive`, { confirm }),
  trash: () => request("GET", "/trash"),
  restoreKb: (dir, name) => request("POST", `/trash/${encodeURIComponent(dir)}/restore`, name ? { name } : {}),
  sourceUrl: (name, id) => `${BASE}/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/source`,
  createBatch: (body) => request("POST", "/upload-batches", body),
  batch: (id) => request("GET", `/upload-batches/${encodeURIComponent(id)}`),
  deleteBatch: (id) => request("DELETE", `/upload-batches/${encodeURIComponent(id)}`),
  importBatch: (id, body) => request("POST", `/upload-batches/${encodeURIComponent(id)}/import`, body),
  uploadFile,
  job: async (id) => (await request("GET", `/jobs/${encodeURIComponent(id)}`)).job,
  jobs: async (params = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    return (await request("GET", `/jobs?${query.toString()}`)).jobs;
  },
  stdStatus: (name) => request("GET", `/kbs/${encodeURIComponent(name)}/std`),
  stdCheck: (name, body) => request("POST", `/kbs/${encodeURIComponent(name)}/std-check`, body),
};
