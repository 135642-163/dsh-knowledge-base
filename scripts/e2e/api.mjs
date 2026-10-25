/**
 * 最小 HTTP 客户端：所有写请求带同源 Origin 与 x-kb-ui，和真实工作台一致。
 * 宿主 403 大多来自这两个头（assertSameOrigin / requireUiHeader），因此不要省。
 */
export class ApiError extends Error {
  constructor(status, code, message, payload) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export function createApi(baseUrl) {
  const root = baseUrl.replace(/\/+$/, "");
  const origin = new URL(root).origin;

  async function request(method, path, body) {
    const headers = { origin };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && method !== "HEAD") headers["x-kb-ui"] = "1";
    let response;
    try {
      response = await fetch(`${root}/kb/api${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ApiError(0, "NETWORK_ERROR", `${method} ${path} 失败：${String(error?.cause?.code ?? error?.message ?? error)}`);
    }
    const text = await response.text();
    let payload = null;
    try { payload = text === "" ? null : JSON.parse(text); } catch { payload = null; }
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new ApiError(
        response.status,
        error.code ?? "HTTP_ERROR",
        error.message ?? `请求失败 (${response.status})`,
        payload,
      );
    }
    return payload;
  }

  return {
    origin,
    request,
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
    createKb: (name, extra = {}) => request("POST", "/kbs", { name, ...extra }),
    archiveKb: (name) => request("POST", `/kbs/${encodeURIComponent(name)}/archive`, { confirm: name }),
    trash: () => request("GET", "/trash"),
    trashDocs: () => request("GET", "/trash/docs"),
    purgeDocs: (name, { ids = [], all = false } = {}) => request(
      "POST",
      `/kbs/${encodeURIComponent(name)}/docs/purge`,
      { ...(all ? { all: true } : { ids }), confirm: name },
    ),
    restoreDoc: (name, id) => request("POST", `/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/restore`, {}),
    deleteDoc: (name, id) => request("POST", `/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/delete`, {}),
    undoMove: (name, id, target) => request(
      "POST",
      `/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/undo-move`,
      { target },
    ),
    officeStatus: () => request("GET", "/office/status"),
    docContent: (name, id) => request("GET", `/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/content`),
    sourceInlinePath: (name, id) => `/kb/api/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/source?inline=1`,
    previewPdfPath: (name, id) => `/kb/api/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/preview.pdf`,
  };
}
