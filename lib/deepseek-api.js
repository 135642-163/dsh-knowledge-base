/**
 * DeepSeek 全家桶工具 API 客户端（Search / Fetch / OCR）。
 *
 * 只调用官方 REST：
 *  - POST /v1/tools/search
 *  - POST /v1/tools/fetch
 *  - POST /v1/tools/ocr
 *
 * 密钥优先复用宿主的 credentials 服务（DEEPSEEK_API_KEY），其次读同名环境变量；
 * 本模块不把密钥写进配置、日志或返回值。后台 worker 由父进程通过 env 注入同一个键。
 */
export const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** 工具 API 的错误：保留状态码与安全截断的消息，便于调用方决定是否重试。 */
export class DeepSeekApiError extends Error {
  constructor(message, { status = 0, code = "", retryable = false, cause = null } = {}) {
    super(message);
    this.name = "DeepSeekApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

/** 归一化 base URL：去掉尾部斜杠；只接受 http/https。 */
export function normalizeDeepSeekBaseUrl(value) {
  const raw = String(value ?? "").trim() || DEFAULT_DEEPSEEK_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`DeepSeek API 地址不合法：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("DeepSeek API 地址必须是 http(s)");
  }
  return url.toString().replace(/\/+$/, "");
}

/**
 * 解析宿主密钥：credentials 服务 → 环境变量。
 * @returns {Promise<{value: string, source: "credentials"|"env"} | null>}
 */
export async function resolveDeepSeekApiKey({ ctx, env = process.env, ref = DEEPSEEK_API_KEY_REF } = {}) {
  let store = null;
  try {
    store = typeof ctx?.get === "function" ? ctx.get("credentials") : null;
  } catch {
    store = null;
  }
  if (store && typeof store.resolve === "function") {
    try {
      const hit = await store.resolve(ref);
      const value = typeof hit === "string" ? hit : hit?.value;
      if (typeof value === "string" && value.trim() !== "") {
        return { value: value.trim(), source: "credentials" };
      }
    } catch {
      /* 宿主没有该条目时继续找环境变量 */
    }
  }
  const envValue = String(env?.[ref] ?? "").trim();
  if (envValue !== "") return { value: envValue, source: "env" };
  return null;
}

/** 重试判断：限流/服务繁忙/超时可重试；鉴权与参数错误不重试。 */
export function retryableStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function readErrorPayload(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    try {
      body = { error: { message: (await response.text()).slice(0, 300) } };
    } catch {
      body = null;
    }
  }
  const message = String(body?.error?.message ?? body?.message ?? "").trim();
  const code = String(body?.error?.code ?? body?.error?.type ?? "").trim();
  return { message: message || `HTTP ${response.status}`, code };
}

async function callJson(url, { apiKey, body, timeoutMs, fetchImpl = fetch, method = "POST" }) {
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new DeepSeekApiError(`请求 ${url} 失败：${error?.message ?? error}`, {
      retryable: true,
      cause: error,
    });
  }
  if (!response.ok) {
    const { message, code } = await readErrorPayload(response);
    throw new DeepSeekApiError(message, {
      status: response.status,
      code,
      retryable: retryableStatus(response.status),
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new DeepSeekApiError(`响应不是合法 JSON（${Date.now() - started}ms）`, {
      status: response.status,
      retryable: false,
      cause: error,
    });
  }
  return payload;
}

/**
 * 抓取单个网页，返回 Markdown 正文。
 * @returns {Promise<{title: string, content: string}>}
 */
export async function deepseekFetchPage({
  url,
  apiKey,
  baseUrl = DEFAULT_DEEPSEEK_BASE_URL,
  timeoutMs = 90_000,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new DeepSeekApiError("缺少 DeepSeek API Key，无法抓取网页", { code: "no_api_key" });
  assertHttpUrl(url);
  const payload = await callJson(`${normalizeDeepSeekBaseUrl(baseUrl)}/v1/tools/fetch`, {
    apiKey,
    body: { url: String(url) },
    timeoutMs,
    fetchImpl,
  });
  return {
    title: String(payload?.title ?? "").trim(),
    content: String(payload?.content ?? ""),
  };
}

/**
 * 网页搜索。query 支持 site:/lang:/after: 等搜索语法。
 * @returns {Promise<Array<object>>} 原始 results（保留 rerank_score/authority/date 等字段）
 */
export async function deepseekSearch({
  query,
  apiKey,
  baseUrl = DEFAULT_DEEPSEEK_BASE_URL,
  count = 10,
  needContent = false,
  oriQuestion = "",
  localization = "",
  timeoutMs = 45_000,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new DeepSeekApiError("缺少 DeepSeek API Key，无法搜索", { code: "no_api_key" });
  const q = String(query ?? "").trim();
  if (q === "") throw new DeepSeekApiError("搜索词不能为空", { code: "invalid_query" });
  const body = {
    query: q.slice(0, 128),
    count: Math.min(50, Math.max(1, Math.round(Number(count) || 10))),
    need_content: needContent === true,
  };
  if (oriQuestion) body.ori_question = String(oriQuestion).slice(0, 128);
  if (localization) body.localization = String(localization).slice(0, 64);
  const payload = await callJson(`${normalizeDeepSeekBaseUrl(baseUrl)}/v1/tools/search`, {
    apiKey,
    body,
    timeoutMs,
    fetchImpl,
  });
  return Array.isArray(payload?.results) ? payload.results : [];
}

/**
 * OCR 单张图片（PNG/JPEG 等）。返回模型原始文本（已去掉版式标记）。
 * @returns {Promise<{text: string, pageCount: number, truncated: boolean}>}
 */
export async function deepseekOcrImage({
  png,
  apiKey,
  baseUrl = DEFAULT_DEEPSEEK_BASE_URL,
  purpose = "text_recognition",
  timeoutMs = 180_000,
  fetchImpl = fetch,
  filename = "page.png",
} = {}) {
  if (!apiKey) throw new DeepSeekApiError("缺少 DeepSeek API Key，无法使用云端 OCR", { code: "no_api_key" });
  const bytes = png instanceof Uint8Array ? png : new Uint8Array(png ?? []);
  if (bytes.byteLength === 0) throw new DeepSeekApiError("OCR 输入为空", { code: "empty_file" });
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", new Blob([bytes], { type: "image/png" }), filename);
  let response;
  try {
    response = await fetchImpl(`${normalizeDeepSeekBaseUrl(baseUrl)}/v1/tools/ocr`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new DeepSeekApiError(`OCR 请求失败：${error?.message ?? error}`, { retryable: true, cause: error });
  }
  // 识别开始后状态码已是 200；失败会以 error 对象放在响应体里。
  let payload = null;
  try {
    const raw = await response.text();
    payload = raw.trim() === "" ? null : JSON.parse(raw);
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.error) {
    const message = String(payload?.error?.message ?? "").trim() || `HTTP ${response.status}`;
    throw new DeepSeekApiError(message, {
      status: response.status,
      code: String(payload?.error?.code ?? ""),
      retryable: retryableStatus(response.status) || /temporarily unavailable|Internal Server Error/i.test(message),
    });
  }
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  if (pages.length === 0) {
    // 识别已经开始但没返回任何页：按临时失败处理，让调用方重试/回退。
    throw new DeepSeekApiError("OCR 返回空结果", { status: response.status, retryable: true });
  }
  const text = pages.map((page) => stripOcrMarkup(page?.text ?? "")).filter(Boolean).join("\n\n");
  return {
    text,
    pageCount: Number(payload?.page_count) || pages.length,
    truncated: pages.some((page) => page?.finish_reason === "length"),
  };
}

/** 去掉 OCR 返回里的 <｜ref｜>…<｜/ref｜> 与 <｜box｜>[[x1,y1,x2,y2]]<｜/box｜> 标记。 */
export function stripOcrMarkup(text) {
  return String(text ?? "")
    .replace(/<[｜|]box[｜|]>\s*\[\[[\s\S]*?\]\]\s*<[｜|]\/box[｜|]>/g, "")
    .replace(/<[｜|]\s*\/?\s*(?:ref|box)\s*[｜|]>/g, "")
    // 其他同形标记（如 <｜caption｜>）一并去掉，避免污染正文
    .replace(/<[｜|][^｜|>\n]{1,24}[｜|]>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 只用 http/https、且不带用户名密码。 */
export function assertHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`不是合法链接：${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只支持 http/https 链接");
  }
  if (url.username || url.password) throw new Error("链接不能携带用户名或密码");
  return url;
}
