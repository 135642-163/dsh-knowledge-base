/**
 * /kb 路由的 HTTP 工具：JSON、body、信任围栏、同源检查、静态文件。
 */
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { extname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "no-referrer",
};

/** 带 HTTP 状态与机器码的业务错误；api.js 统一映射成 { error: { code, message } }。 */
export class WebError extends Error {
  constructor(code, status, message, details) {
    super(message);
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

export function sendError(res, status, code, message, details) {
  // 5xx 一律不回显 details：内部错误可能带绝对路径 / errno，集中在此拦截，
  // 不依赖每个调用点自觉（4xx 的业务 details（如 jobId）照常返回）。
  const safeDetails = Number(status) >= 500 ? undefined : details;
  sendJson(res, status, { error: { code, message, ...(safeDetails ? { details: safeDetails } : {}) } });
}

export function sendRedirect(res, location) {
  res.writeHead(308, { location });
  res.end();
}

export async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new WebError("BAD_REQUEST", 400, "请求体过大");
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WebError("BAD_REQUEST", 400, "请求体不是合法 JSON");
  }
}

export function isLoopbackHostname(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isTrustedApiRequest(req, trustedHosts = []) {
  const host = String(req.headers?.host ?? "").trim().toLowerCase();
  if (host === "") return false;
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (isLoopbackHostname(parsed.hostname)) return true;
  const authority = `${parsed.hostname}:${parsed.port}`;
  return (Array.isArray(trustedHosts) ? trustedHosts : []).some((raw) => {
    const entry = String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    return entry === parsed.hostname || entry === authority;
  });
}

export function assertSameOrigin(req) {
  const origin = String(req.headers?.origin ?? "").trim();
  const host = String(req.headers?.host ?? "").trim();
  if (origin !== "") {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new WebError("FORBIDDEN", 403, "Origin 非法");
    }
    if (parsed.host !== host) {
      throw new WebError("FORBIDDEN", 403, "跨站请求被拒绝");
    }
  }
  const site = String(req.headers?.["sec-fetch-site"] ?? "").trim();
  if (site !== "" && site !== "same-origin" && site !== "none") {
    throw new WebError("FORBIDDEN", 403, "跨站请求被拒绝");
  }
}

export function requireUiHeader(req) {
  if (String(req.headers?.["x-kb-ui"] ?? "") !== "1") {
    throw new WebError("FORBIDDEN", 403, "缺少工作台请求头");
  }
}

/**
 * 宿主可能把挂载前缀剥掉再交给 handler（DSH webServer 的 prefix 路由就是如此），
 * 也可能传完整 URL；两种形式都归一化成 /status、/kbs/... 形式。
 */
export function relativeApiPath(pathname) {
  const raw = String(pathname ?? "");
  if (raw === "/kb/api" || raw.startsWith("/kb/api/")) {
    const rest = raw.slice("/kb/api".length);
    return rest === "" ? "/" : rest;
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/** 同上：把 /kb/app.js 与 /app.js 都归一化成 ui/ 下的相对路径。 */
export function relativeUiPath(pathname) {
  const raw = String(pathname ?? "");
  if (raw === "/kb" || raw === "/kb/") return "index.html";
  if (raw.startsWith("/kb/")) return raw.slice("/kb/".length) || "index.html";
  const rel = raw.replace(/^\/+/, "");
  return rel === "" ? "index.html" : rel;
}

export function contentTypeFor(path) {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export async function serveFile(res, absPath, { headers = {}, cache = "no-cache" } = {}) {
  let st;
  try {
    st = await stat(absPath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const type = contentTypeFor(absPath);
  res.writeHead(200, {
    "content-type": type,
    "content-length": st.size,
    "cache-control": cache,
    "x-content-type-options": "nosniff",
    ...SECURITY_HEADERS,
    ...(type.startsWith("text/html")
      ? { "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:" }
      : {}),
    ...headers,
  });
  createReadStream(absPath).pipe(res);
  return true;
}

/**
 * 把请求体流式写到 dest（不缓冲整个文件），超过 maxBytes 时中断并清理临时文件。
 * dest 必须以 "wx" 打开（调用方用随机临时名，避免 clobber）。
 * 用 stream/promises.pipeline 统一处理背压、错误与关闭，超限时销毁整条管线。
 */
export async function readRawToFile(source, dest, { maxBytes = 0 } = {}) {
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (maxBytes > 0 && size > maxBytes) {
        callback(new WebError("UPLOAD_TOO_LARGE", 413, `文件超过上限 ${maxBytes} 字节`, { maxBytes }));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, limiter, createWriteStream(dest, { flags: "wx" }));
    return { size };
  } catch (error) {
    await rm(dest, { force: true }).catch(() => {});
    throw error;
  }
}
