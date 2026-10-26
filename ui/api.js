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
    let finished = false;
    const onAbort = () => xhr.abort();
    const settle = (fn, value) => {
      if (finished) return;
      finished = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      xhr.onload = null;
      xhr.onerror = null;
      xhr.onabort = null;
      fn(value);
    };
    xhr.onload = () => {
      const payload = xhr.response ?? null;
      if (xhr.status >= 200 && xhr.status < 300) {
        settle(resolve, payload);
        return;
      }
      settle(reject, new ApiError(xhr.status, payload?.error?.code ?? "HTTP_ERROR", payload?.error?.message ?? `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => settle(reject, new ApiError(0, "NETWORK_ERROR", "上传失败（网络错误）"));
    xhr.onabort = () => settle(reject, new ApiError(0, "ABORTED", "上传已取消"));
    if (signal?.aborted) {
      settle(reject, new ApiError(0, "ABORTED", "上传已取消"));
      return;
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
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
  /** 全文检索（跨库）：q 必须有值；其余条件是 manifest 过滤。 */
  search: (params = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const search = query.toString();
    return request("GET", `/search${search ? `?${search}` : ""}`);
  },
  /** 人工编目：摘要/标签；summarySource 由服务端置为 manual。 */
  patchDocMetadata: (name, id, body) => request(
    "PATCH",
    `/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/metadata`,
    body,
  ),
  /** 软删除（默认）或永久删除；永久删除必须逐字给出 confirm=标题。 */
  deleteDoc: (name, id, { permanent = false, confirm } = {}) => request(
    "POST",
    `/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/delete`,
    {
      permanent: permanent === true,
      ...(confirm !== undefined ? { confirm: String(confirm) } : {}),
    },
  ),
  restoreDoc: (name, id) => request("POST", `/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/restore`, {}),
  reparseDoc: (name, id) => request("POST", `/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/reparse`, {}),
  /** 移动预检：只读，返回逐篇文件大小与目标库冲突。 */
  movePreflight: (name, { ids = [], target = "" } = {}) => request(
    "POST",
    `/kbs/${encodeURIComponent(name)}/docs/move/preflight`,
    { ids, target },
  ),
  /** 跨库移动：onConflict=skip（默认）或 rename。 */
  moveDocs: (name, { ids = [], target = "", onConflict = "skip" } = {}) => request(
    "POST",
    `/kbs/${encodeURIComponent(name)}/docs/move`,
    { ids, target, onConflict },
  ),
  undoMove: (name, id, { target = "" } = {}) => request(
    "POST",
    `/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/undo-move`,
    { target },
  ),
  createKb: (body) => request("POST", "/kbs", body),
  patchKb: (name, body) => request("PATCH", `/kbs/${encodeURIComponent(name)}`, body),
  archiveKb: (name, confirm) => request("POST", `/kbs/${encodeURIComponent(name)}/archive`, { confirm }),
  trash: () => request("GET", "/trash"),
  /** 全局回收站：所有活跃库里的软删除资料（只读，最多 500 条）；支持搜索与排序。 */
  trashDocs: ({ query = "", sort = "deleted_desc" } = {}) => {
    const params = new URLSearchParams();
    const search = query === undefined || query === null ? "" : String(query);
    const order = sort === undefined || sort === null || String(sort).trim() === ""
      ? "deleted_desc"
      : String(sort);
    if (search !== "") params.set("query", search);
    params.set("sort", order);
    return request("GET", `/trash/docs?${params.toString()}`);
  },
  /** 跨库批量彻底删除：confirm 必须逐字输入「彻底删除 N 篇」。 */
  purgeTrashDocs: (items, confirm) => request("POST", "/trash/docs/purge", {
    items: (Array.isArray(items) ? items : []).map((item) => ({
      kb: String(item?.kb ?? ""),
      id: String(item?.id ?? ""),
    })),
    confirm: String(confirm ?? ""),
  }),
  /** 批量彻底删除本库回收站资料：confirm=库名，all 与 ids 二选一。 */
  purgeDocs: (name, { ids = [], all = false, confirm = "" } = {}) => request(
    "POST",
    `/kbs/${encodeURIComponent(name)}/docs/purge`,
    {
      ...(all === true ? { all: true } : { ids: Array.isArray(ids) ? ids : [] }),
      confirm: String(confirm),
    },
  ),
  restoreKb: (dir, name) => request("POST", `/trash/${encodeURIComponent(dir)}/restore`, name ? { name } : {}),
  purgeTrash: (dir) => request("DELETE", `/trash/${encodeURIComponent(dir)}`),
  sourceUrl: (name, id) => `${BASE}/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/source`,
  sourceInlineUrl: (name, id) => `${BASE}/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/source?inline=1`,
  previewPdfUrl: (name, id) => `${BASE}/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/preview.pdf`,
  /** 服务端逐页 viewer（PDF/Office 转换件）：page 可选（缺省=命中最多的页），terms 用 | 连接。 */
  viewerUrl: (name, id, { page, terms, rotate } = {}) => {
    const params = new URLSearchParams();
    if (Number.isInteger(page) && page > 0) params.set("page", String(page));
    const list = (Array.isArray(terms) ? terms : [])
      .map((term) => String(term ?? "").trim())
      .filter((term) => term.length >= 2)
      .slice(0, 8);
    if (list.length > 0) params.set("q", list.join("|"));
    if (Number.isInteger(rotate) && rotate !== 0) params.set("rotate", String(rotate));
    const query = params.toString();
    return `${BASE}/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/viewer.html${query ? `?${query}` : ""}`;
  },
  docContent: (name, id) => request("GET", `/kbs/${encodeURIComponent(name)}/docs/${encodeURIComponent(id)}/content`),
  createBatch: (body) => request("POST", "/upload-batches", body),
  batch: (id) => request("GET", `/upload-batches/${encodeURIComponent(id)}`),
  deleteBatch: (id) => request("DELETE", `/upload-batches/${encodeURIComponent(id)}`),
  importBatch: (id, body) => request("POST", `/upload-batches/${encodeURIComponent(id)}/import`, body),
  uploadFile,
  job: async (id) => (await request("GET", `/jobs/${encodeURIComponent(id)}`)).job,
  cancelJob: async (id) => (await request("POST", `/jobs/${encodeURIComponent(id)}/cancel`)).job,
  jobs: async (params = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    return (await request("GET", `/jobs?${query.toString()}`)).jobs;
  },
  stdStatus: (name) => request("GET", `/kbs/${encodeURIComponent(name)}/std`),
  stdCheck: (name, body) => request("POST", `/kbs/${encodeURIComponent(name)}/std-check`, body),
  /** Office 转换引擎状态（可选安装 LibreOfficeKit）。 */
  officeStatus: () => request("GET", "/office/status"),
  /** 一键安装引擎：必须显式 confirm；返回 { jobId }，进度用 job() 轮询。 */
  installOffice: () => request("POST", "/office/install", { confirm: true }),
};
