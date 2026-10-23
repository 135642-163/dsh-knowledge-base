/**
 * /kb/api/* 路由分发。Slice 1：status / kbs / detail / docs / source。
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  WebError,
  assertSameOrigin,
  readJsonBody,
  relativeApiPath,
  requireUiHeader,
  sendError,
  sendJson,
  serveFile,
} from "./http.js";
import { findSource, listDocs, readDoc, readKbDetail, summarizeKb } from "./data.js";
import { archiveKb, createKb, listTrash, restoreKb, syncSchemaTitle, updateKbMeta } from "../kbmeta.js";
import { kbDirPath, listKbs, readManifest, renameKb, sanitizeKbName } from "../store.js";
import { refreshIndexIfStale } from "../wiki.js";
import { VERSION } from "../version.js";
import {
  addBatchFile,
  createUploadBatch,
  discardOpenBatch,
  findBatchKbDir,
  importBatch,
  normalizeLimits,
  publicBatch,
  readBatch,
  sweepOldBatches,
} from "./upload.js";

const KbError = WebError;

function mapError(error) {
  if (error instanceof WebError) return error;
  const message = String(error?.message ?? error);
  if (/归档记录不存在/.test(message)) return new KbError("TRASH_NOT_FOUND", 404, message);
  if (/kb\.json 损坏|缺少知识库名称|归档目录名无效/.test(message)) return new KbError("TRASH_INVALID", 409, message);
  if (/已存在/.test(message)) return new KbError("KB_EXISTS", 409, message);
  if (/不存在/.test(message)) return new KbError("KB_NOT_FOUND", 404, message);
  if (/名称|非法|不能为空/.test(message)) return new KbError("KB_NAME_INVALID", 400, message);
  return error;
}

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
  const limits = normalizeLimits(opts.limits);
  let path;
  try {
    const url = new URL(req.url ?? "/", "http://dsh.internal");
    path = relativeApiPath(url.pathname);
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
        features: { ui: true, merge: false, std: true, upload: true, jobs: true },
        limits,
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
    if (segments.length === 1 && segments[0] === "upload-batches" && method === "POST") {
      const body = await readJsonBody(req);
      const kb = sanitizeKbName(body?.kb);
      const dir = kbDirPath(opts.kbRoot, kb);
      if (!existsSync(join(dir, "kb.json"))) {
        if (body?.create !== true) throw new KbError("KB_NOT_FOUND", 404, `知识库不存在: ${kb}`);
        await createKb(opts.kbRoot, { name: kb });
      }
      await sweepOldBatches({ kbDir: dir }).catch(() => {});
      const { batch } = await createUploadBatch({ kbDir: dir, kb });
      const view = publicBatch(batch, limits);
      return sendJson(res, 201, { batch: view, limits: view.limits });
    }

    if (segments[0] === "upload-batches" && segments.length === 3 && segments[2] === "files" && method === "PUT") {
      const kbDir = await findBatchKbDir(opts.kbRoot, segments[1]);
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const relPath = url.searchParams.get("path") ?? "";
      const result = await addBatchFile({ kbDir, batchId: segments[1], relPath, source: req, limits });
      return sendJson(res, 200, result);
    }

    if (segments[0] === "upload-batches" && segments.length === 2 && method === "GET") {
      const kbDir = await findBatchKbDir(opts.kbRoot, segments[1]);
      const view = publicBatch(await readBatch(kbDir, segments[1]), limits);
      return sendJson(res, 200, { batch: view, limits: view.limits });
    }

    if (segments[0] === "upload-batches" && segments.length === 2 && method === "DELETE") {
      const kbDir = await findBatchKbDir(opts.kbRoot, segments[1]);
      return sendJson(res, 200, await discardOpenBatch(kbDir, segments[1]));
    }

    if (segments[0] === "upload-batches" && segments.length === 3 && segments[2] === "import" && method === "POST") {
      const body = await readJsonBody(req);
      const kbDir = await findBatchKbDir(opts.kbRoot, segments[1]);
      const batch = await readBatch(kbDir, segments[1]);
      const result = await importBatch({
        jobs: opts.jobs,
        spawn: opts.spawn,
        kbRoot: opts.kbRoot,
        kb: batch.kb,
        kbDir,
        batchId: segments[1],
        body,
        importConfig: opts.importConfig ?? (() => ({})),
      });
      return sendJson(res, result.jobId ? 202 : 200, result);
    }

    if (segments.length === 1 && segments[0] === "kbs" && method === "POST") {
      const body = await readJsonBody(req);
      const clean = sanitizeKbName(body?.name);
      const { manifest } = await createKb(opts.kbRoot, {
        name: clean,
        description: body?.description,
        tags: body?.tags,
      });
      return sendJson(res, 201, { kb: await summarizeKb(opts.kbRoot, { name: manifest.name, dir: manifest.name }) });
    }

    if (segments.length === 2 && segments[0] === "kbs" && method === "PATCH") {
      const body = await readJsonBody(req);
      const current = ensureKb(opts, segments[1]).name;
      let name = current;
      let renamedFrom = null;
      if (body?.name !== undefined) {
        const next = sanitizeKbName(body.name);
        if (next !== current) {
          await renameKb(opts.kbRoot, current, next);
          const dir = join(opts.kbRoot, next);
          await syncSchemaTitle(dir, current, next);
          await refreshIndexIfStale(dir, await readManifest(dir)).catch(() => {});
          name = next;
          renamedFrom = current;
        }
      }
      if (body?.description !== undefined || body?.tags !== undefined) {
        await updateKbMeta(opts.kbRoot, name, {
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
        });
      }
      return sendJson(res, 200, {
        kb: await summarizeKb(opts.kbRoot, { name, dir: name }),
        renamedFrom,
      });
    }

    if (segments.length === 3 && segments[0] === "kbs" && segments[2] === "archive" && method === "POST") {
      const body = await readJsonBody(req);
      const name = ensureKb(opts, segments[1]).name;
      if (String(body?.confirm ?? "") !== name) {
        throw new KbError("BAD_REQUEST", 400, "归档确认名不匹配");
      }
      const trashedTo = await archiveKb(opts.kbRoot, name);
      return sendJson(res, 200, {
        trashedTo,
        dir: basename(trashedTo),
        ...(name === (opts.defaultKb ?? "default")
          ? { warning: "defaultKb 已归档，工具默认库将不可用；请修改 profile 的 defaultKb" }
          : {}),
      });
    }

    if (segments.length === 1 && segments[0] === "trash" && method === "GET") {
      return sendJson(res, 200, { items: await listTrash(opts.kbRoot) });
    }

    if (segments.length === 3 && segments[0] === "trash" && segments[2] === "restore" && method === "POST") {
      const body = await readJsonBody(req);
      const { manifest } = await restoreKb(opts.kbRoot, segments[1], {
        ...(body?.name !== undefined ? { name: body.name } : {}),
      });
      return sendJson(res, 200, {
        kb: await summarizeKb(opts.kbRoot, { name: manifest.name, dir: manifest.name }),
        restoredTo: manifest.name,
      });
    }
    throw new KbError("NOT_FOUND", 404, "not found");
  } catch (rawError) {
    const error = mapError(rawError);
    // 非业务错误（多为 fs/stream 抛出的 Node 错误）不回显 code/message：
    // 它们可能带绝对路径与 errno，对外只给固定文案。
    if (!(error instanceof WebError)) {
      console.error("[kb-web] upload failed", rawError);
      return sendError(res, 500, "UPLOAD_FAILED", "上传写入失败");
    }
    const status = Number(error.status) || 500;
    if (status >= 500) console.error("[kb-web] api error", error);
    return sendError(res, status, error.code, String(error.message ?? error), error.details);
  }
}
