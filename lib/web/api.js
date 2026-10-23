/**
 * /kb/api/* 路由分发。Slice 1：status / kbs / detail / docs / source。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  assertSameOrigin,
  requireUiHeader,
  sendError,
  sendJson,
  serveFile,
} from "./http.js";
import { findSource, listDocs, readDoc, readKbDetail, summarizeKb } from "./data.js";
import { kbDirPath, listKbs, sanitizeKbName } from "../store.js";

class KbError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const VERSION = "0.19.0-alpha.1";

function ensureKb(opts, name) {
  const clean = sanitizeKbName(name);
  const dir = kbDirPath(opts.kbRoot, clean);
  if (!existsSync(join(dir, "kb.json"))) {
    throw new KbError("KB_NOT_FOUND", 404, `知识库不存在: ${clean}`);
  }
  return { name: clean, dir };
}

export async function handleApi(req, res, { ctx, opts, fence }) {
  if (!fence(req)) return sendError(res, 403, "FORBIDDEN", "请求来源不受信任");
  const method = req.method ?? "GET";
  let path;
  try {
    const url = new URL(req.url ?? "/", "http://dsh.internal");
    path = url.pathname.startsWith("/kb/api") ? url.pathname.slice("/kb/api".length) || "/" : "/";
  } catch {
    return sendError(res, 400, "BAD_REQUEST", "invalid url");
  }
  const segments = path.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  try {
    if (method !== "GET" && method !== "HEAD") {
      requireUiHeader(req);
      assertSameOrigin(req);
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "status") {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        kbRoot: opts.kbRoot,
        features: { ui: true, merge: false, std: false, upload: false },
      });
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "kbs") {
      const entries = await listKbs(opts.kbRoot);
      const kbs = [];
      for (const entry of entries) kbs.push(await summarizeKb(opts.kbRoot, entry));
      return sendJson(res, 200, { kbs });
    }
    if (segments[0] === "kbs" && segments.length === 2 && method === "GET") {
      const { name } = ensureKb(opts, segments[1]);
      const detail = await readKbDetail(opts.kbRoot, name);
      return sendJson(res, 200, detail);
    }
    if (segments[0] === "kbs" && segments.length === 3 && segments[2] === "docs" && method === "GET") {
      const { name } = ensureKb(opts, segments[1]);
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const result = await listDocs(opts.kbRoot, name, {
        query: url.searchParams.get("query") ?? undefined,
        type: url.searchParams.get("type") ?? undefined,
        trust: url.searchParams.get("trust") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        offset: url.searchParams.get("offset") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
      });
      return sendJson(res, 200, result);
    }
    if (segments[0] === "kbs" && segments.length === 4 && segments[2] === "docs" && method === "GET") {
      const { name } = ensureKb(opts, segments[1]);
      const doc = await readDoc(opts.kbRoot, name, segments[3]);
      if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
      return sendJson(res, 200, doc);
    }
    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "source" && method === "GET") {
      const { name } = ensureKb(opts, segments[1]);
      const found = await findSource(opts.kbRoot, name, segments[3]);
      if (!found) throw new KbError("SOURCE_NOT_FOUND", 404, "原件不存在");
      const filename = encodeURIComponent(found.name);
      const ok = await serveFile(res, found.path, {
        headers: { "content-disposition": `attachment; filename*=UTF-8''${filename}` },
      });
      if (!ok) throw new KbError("SOURCE_NOT_FOUND", 404, "原件不存在");
      return;
    }
    // 写接口在 Task 6 加入
    throw new KbError("NOT_FOUND", 404, "not found");
  } catch (error) {
    const status = Number(error?.status) || (error?.code === "FORBIDDEN" ? 403 : 500);
    const code = error?.code ?? "INTERNAL";
    if (status >= 500) console.error("[kb-web] api error", error);
    return sendError(res, status, code, String(error?.message ?? error));
  }
}
