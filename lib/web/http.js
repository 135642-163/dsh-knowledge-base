/**
 * /kb 路由的 HTTP 工具：JSON、body、信任围栏、同源检查、静态文件。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "no-referrer",
};

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
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
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
      const error = new Error("请求体过大");
      error.code = "BAD_REQUEST";
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求体不是合法 JSON");
    error.code = "BAD_REQUEST";
    throw error;
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
      const error = new Error("Origin 非法");
      error.code = "FORBIDDEN";
      throw error;
    }
    if (parsed.host !== host) {
      const error = new Error("跨站请求被拒绝");
      error.code = "FORBIDDEN";
      throw error;
    }
  }
  const site = String(req.headers?.["sec-fetch-site"] ?? "").trim();
  if (site !== "" && site !== "same-origin" && site !== "none") {
    const error = new Error("跨站请求被拒绝");
    error.code = "FORBIDDEN";
    throw error;
  }
}

export function requireUiHeader(req) {
  if (String(req.headers?.["x-kb-ui"] ?? "") !== "1") {
    const error = new Error("缺少工作台请求头");
    error.code = "FORBIDDEN";
    throw error;
  }
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
