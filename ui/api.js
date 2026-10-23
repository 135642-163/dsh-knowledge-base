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
};
