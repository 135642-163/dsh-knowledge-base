/**
 * /kb/api/* 路由分发。Slice 1：status / kbs / detail / docs / source。
 */
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, join } from "node:path";
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
import {
  convertOfficeToPdf,
  getOrCreateOfficePreview,
  inlineTypeFor,
  isOffice,
  resolveOfficeCli,
} from "./preview.js";
import { readStdStatus, startStdJob } from "./std.js";
import { archiveKb, createKb, listTrash, purgeKb, restoreKb, syncSchemaTitle, updateKbMeta } from "../kbmeta.js";
import {
  kbDirPath,
  listKbs,
  readManifest,
  removeDoc,
  renameKb,
  restoreDoc,
  sanitizeKbName,
  softDeleteDoc,
} from "../store.js";
import { appendLog, refreshIndexIfStale } from "../wiki.js";
import { refreshKbIndex } from "../import-job.js";
import { importFileInto } from "../pipeline.js";
import { TransferError, moveDocs, preflightMove, undoMove } from "../transfer.js";
import { VERSION } from "../version.js";
import { normalizeSessionId, resolveScope, setScope } from "../scope.js";
import { readScopes, renameScopeKb } from "../scope-store.js";
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

/**
 * 跨库移动错误码 → HTTP 状态。未列出的 TransferError 按 500 处理；
 * 所有 message 由 transfer.js 保证不含绝对路径。
 */
const TRANSFER_STATUS = {
  TRANSFER_INVALID_REQUEST: 400,
  TRANSFER_SAME_KB: 400,
  TRANSFER_KB_NOT_FOUND: 404,
  TRANSFER_DOC_NOT_FOUND: 404,
  TRANSFER_DOC_NOT_READY: 409,
  TRANSFER_DOC_DELETED: 409,
  TRANSFER_SOURCE_MISSING: 409,
  TRANSFER_TARGET_MERGED: 409,
  TRANSFER_CONFLICT: 409,
  TRANSFER_SOURCE_CHANGED: 409,
  TRANSFER_UNDO_UNAVAILABLE: 409,
  TRANSFER_TOO_MANY: 413,
  TRANSFER_TOO_LARGE: 413,
};

function mapError(error) {
  if (error instanceof WebError) return error;
  if (error instanceof TransferError) {
    const status = TRANSFER_STATUS[error.code] ?? 500;
    return new KbError(error.code, status, error.message, status >= 500 ? undefined : error.details);
  }
  if (error?.name === "ScopeError") {
    const status = error.code === "KB_NOT_FOUND"
      ? 404
      : error.code === "KB_ARCHIVED"
        ? 409
        : error.code === "SCOPE_WRITE_FAILED"
          ? 500
          : 400;
    const safeDetails = status >= 500 ? undefined : error.details;
    return new KbError(error.code, status, error.message, safeDetails);
  }
  const message = String(error?.message ?? error);
  if (/归档记录不存在/.test(message)) return new KbError("TRASH_NOT_FOUND", 404, message);
  if (/归档目录名无效/.test(message)) return new KbError("TRASH_INVALID", 400, message);
  if (/kb\.json 损坏|缺少知识库名称/.test(message)) return new KbError("TRASH_INVALID", 409, message);
  // 文档生命周期错误：先于通用「不存在」「已存在」匹配，避免被映射成 KB_* 错误码。
  if (/文档不存在/.test(message)) return new KbError("DOC_NOT_FOUND", 404, message);
  if (/文档已删除/.test(message)) return new KbError("DOC_DELETED", 409, message);
  if (/文档正在导入/.test(message)) return new KbError("DOC_IMPORTING", 409, message);
  if (/文档未处于删除状态/.test(message)) return new KbError("DOC_NOT_DELETED", 409, message);
  if (/内容已不存在，无法恢复/.test(message)) return new KbError("DOC_CONTENT_MISSING", 409, message);
  if (/暂不能软删除/.test(message)) return new KbError("DOC_NOT_DELETABLE", 409, message);
  if (/已存在/.test(message)) return new KbError("KB_EXISTS", 409, message);
  if (/不存在/.test(message)) return new KbError("KB_NOT_FOUND", 404, message);
  if (/名称|非法|不能为空/.test(message)) return new KbError("KB_NAME_INVALID", 400, message);
  return error;
}

/** 失败文档重试的导入配置：沿用工作台的导入配置，并强制走一次完整重解析。 */
function buildRetryConfig(opts) {
  const base = typeof opts.importConfig === "function" ? opts.importConfig() : {};
  return { ...(base && typeof base === "object" ? base : {}), forceReparse: true };
}

/**
 * 默认的重试实现：用 sources/ 里保存的原件重新跑导入管线，成功后刷新索引。
 * 测试可传 opts.reparseImpl 注入替身（返回导入报告即可）。
 */
async function defaultReparseImpl({ dir, doc, sourcePath, config }) {
  try {
    return await importFileInto(dir, {
      sourcePath,
      relKey: doc.sourceFile || doc.id,
      title: doc.title,
      docId: doc.id,
      sourceFile: doc.sourceFile || "",
      storedSourcePath: doc.sourcePath ?? "",
      forceReparse: true,
      config,
    });
  } finally {
    // 成功/再次失败都会更新清单（ready 或 failed），索引都应按最新清单刷新。
    await refreshKbIndex(dir);
  }
}

async function scopeResponse(opts, scope, sessionId) {
  let resolved = [];
  if (scope.mode === "selected") {
    // 范围条目是目录名：清单 name 与目录名不一致时仍按目录名匹配。
    const live = await listKbs(opts.kbRoot);
    const byDir = new Map();
    for (const kb of live) {
      if (kb.mergedInto == null) byDir.set(kb.dir ?? kb.name, kb);
    }
    resolved = scope.kbs
      .filter((name) => byDir.has(name))
      .map((name) => {
        const kb = byDir.get(name);
        const docs = kb.docs ?? 0;
        return { name, docs, empty: docs === 0 };
      });
  }
  // 读失败（权限/IO）按空表降级：GET 不应因范围文件不可读而 500（设计 §6/§13）。
  const data = await readScopes(opts.kbRoot).catch(() => ({ scopes: {} }));
  return {
    scope: { mode: scope.mode, kbs: [...scope.kbs], inheritedFrom: scope.inheritedFrom ?? null },
    resolved,
    updatedAt: data.scopes[sessionId]?.updatedAt ?? null,
  };
}

/** 从宿主 agent 注册表查父会话；查不到或宿主接口异常时按无父会话处理。 */
function parentSessionOf(ctx, sessionId) {
  try {
    return ctx?.get?.("agents")?.get?.(sessionId)?.session?.header?.parentSession ?? null;
  } catch {
    return null;
  }
}

function ensureKb(opts, name) {
  const clean = sanitizeKbName(name);
  const dir = kbDirPath(opts.kbRoot, clean);
  if (!existsSync(join(dir, "kb.json"))) {
    throw new KbError("KB_NOT_FOUND", 404, `知识库不存在: ${clean}`);
  }
  return { name: clean, dir };
}

/** 任务列表行省略 result：单条 result 最多可含 1000 个文件，50 条会放大响应体。 */
function listJobRow(job) {
  const { result: _result, ...row } = job;
  return row;
}

const CONTENT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 读取文本预览的前 2 MB：先 stat 再按需读，避免把整本大文件载入内存。
 * 截断时去掉末尾可能被切断的 UTF-8 替换字符，并返回 truncated 标记。
 */
async function readTextCapped(absPath, maxBytes) {
  const handle = await open(absPath, "r");
  try {
    const info = await handle.stat();
    const total = Number(info.size) || 0;
    const limit = Math.min(total, maxBytes);
    let text = "";
    if (limit > 0) {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    }
    const truncated = total > maxBytes;
    if (truncated) text = text.replace(/\uFFFD+$/u, "");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { text, truncated };
  } finally {
    await handle.close().catch(() => {});
  }
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
        features: { ui: true, merge: false, std: true, upload: true, jobs: true, scope: true },
        limits,
      });
    }
    if (segments.length === 1 && segments[0] === "scope" && method === "GET") {
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const sessionId = normalizeSessionId(url.searchParams.get("session") ?? "");
      if (sessionId === null) {
        throw new KbError("SCOPE_INVALID", 400, "session 必须是 1–200 字符、无控制字符");
      }
      const scope = await resolveScope(opts.kbRoot, {
        sessionId,
        parentSession: parentSessionOf(ctx, sessionId),
        snapshot: false,
        ttlDays: opts.scope?.ttlDays,
      });
      return sendJson(res, 200, await scopeResponse(opts, scope, sessionId));
    }

    if (segments.length === 1 && segments[0] === "scope" && method === "PUT") {
      const body = await readJsonBody(req);
      const scope = await setScope(opts.kbRoot, {
        sessionId: body?.session,
        mode: body?.mode,
        kbs: body?.kbs,
      });
      return sendJson(res, 200, await scopeResponse(opts, scope, normalizeSessionId(body?.session)));
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
    if (segments[0] === "kbs" && segments.length === 3 && segments[2] === "std" && method === "GET") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const status = await readStdStatus({
        kbDir: dir,
        kb: name,
        configured: opts.std?.configured === true,
        ttlDays: opts.std?.maxAgeDays ?? 7,
      });
      const related = await opts.jobs.list({ kb: name, kind: "kb-std", limit: 10 });
      const active = related.find((job) => job.status === "running") ?? null;
      const last = related.find((job) => job.status !== "running") ?? null;
      return sendJson(res, 200, {
        ...status,
        activeJobId: active?.id ?? null,
        lastJob: last
          ? { id: last.id, status: last.status, finishedAt: last.finishedAt, summary: last.result?.counts ?? null }
          : null,
      });
    }

    if (segments[0] === "kbs" && segments.length === 3 && segments[2] === "std-check" && method === "POST") {
      const body = await readJsonBody(req);
      const { name, dir } = ensureKb(opts, segments[1]);
      const result = await startStdJob({
        kb: name,
        kbDir: dir,
        kbRoot: opts.kbRoot,
        body,
        jobs: opts.jobs,
        stdOpts: opts.std ?? {},
        importConfig: opts.std?.importConfig ?? {},
        ...(opts.std?.runStdCheck ? { runStdCheckImpl: opts.std.runStdCheck } : {}),
        ...(opts.std?.importDownloadedImpl ? { importDownloadedImpl: opts.std.importDownloadedImpl } : {}),
      });
      return sendJson(res, 202, result);
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

    // 跨库移动：预检（只读）→ 移动（同步逐篇事务）→ 撤销。
    // 目标库缺失/合并/冲突/容量上限都由 transfer.js 抛 TransferError，mapError 统一映射。
    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[3] === "move" && segments[4] === "preflight" && method === "POST") {
      const { name } = ensureKb(opts, segments[1]);
      const body = await readJsonBody(req);
      const result = await preflightMove({
        kbRoot: opts.kbRoot,
        sourceKb: name,
        targetKb: body?.target,
        docIds: body?.ids,
      });
      return sendJson(res, 200, result);
    }

    if (segments[0] === "kbs" && segments.length === 4 && segments[2] === "docs" && segments[3] === "move" && method === "POST") {
      const { name } = ensureKb(opts, segments[1]);
      const body = await readJsonBody(req);
      const result = await moveDocs({
        kbRoot: opts.kbRoot,
        sourceKb: name,
        targetKb: body?.target,
        docIds: body?.ids,
        onConflict: body?.onConflict ?? "skip",
      });
      return sendJson(res, 200, result);
    }

    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "undo-move" && method === "POST") {
      const { name } = ensureKb(opts, segments[1]);
      const body = await readJsonBody(req);
      const targetName = sanitizeKbName(body?.target);
      const result = await undoMove({
        kbRoot: opts.kbRoot,
        sourceKb: name,
        targetKb: targetName,
        sourceDocId: segments[3],
      });
      return sendJson(res, 200, {
        source: await readDoc(opts.kbRoot, name, result.source.id),
        target: await readDoc(opts.kbRoot, targetName, result.target.id),
      });
    }

    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "delete" && method === "POST") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const body = await readJsonBody(req);
      const manifest = await readManifest(dir);
      const doc = (manifest.docs ?? []).find((item) => item.id === segments[3]);
      if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
      // 导入中的文档正文可能还在写：软删/永久删都拒绝（409），避免半成品进入回收站。
      if (doc.status === "importing") {
        throw new KbError("DOC_IMPORTING", 409, "文档正在导入，暂不能删除");
      }
      if (body?.permanent !== true) {
        const result = await softDeleteDoc(dir, doc.id);
        await appendLog(dir, { action: "remove", title: doc.title, docId: doc.id, detail: "软删除" });
        await refreshKbIndex(dir);
        return sendJson(res, 200, { docId: doc.id, deletedAt: result.deletedAt, soft: true });
      }
      // 永久删除不可恢复：必须逐字确认标题（去首尾空白），避免列表误点。
      if (String(body?.confirm ?? "").trim() !== String(doc.title ?? "").trim()) {
        throw new KbError("CONFIRM_REQUIRED", 400, `彻底删除需要确认标题：${doc.title}`);
      }
      await removeDoc(dir, doc.id);
      await appendLog(dir, { action: "remove", title: doc.title, docId: doc.id, detail: "永久删除" });
      await refreshKbIndex(dir);
      return sendJson(res, 200, { docId: doc.id, removed: true });
    }

    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "restore" && method === "POST") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const doc = await readDoc(opts.kbRoot, name, segments[3]);
      if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
      await restoreDoc(dir, doc.id);
      await appendLog(dir, { action: "restore", title: doc.title, docId: doc.id, detail: "恢复软删除" });
      await refreshKbIndex(dir);
      return sendJson(res, 200, { doc: await readDoc(opts.kbRoot, name, doc.id) });
    }

    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "reparse" && method === "POST") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const manifest = await readManifest(dir);
      const doc = (manifest.docs ?? []).find((item) => item.id === segments[3]);
      if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
      if (doc.status !== "failed") {
        throw new KbError(
          "DOC_NOT_FAILED",
          409,
          `文档状态为 ${doc.status ?? "unknown"}，仅导入失败的文档可以重试`
        );
      }
      const found = await findSource(opts.kbRoot, name, doc.id);
      if (!found) throw new KbError("SOURCE_MISSING", 409, "原件不存在，无法重试");
      const reparse = typeof opts.reparseImpl === "function" ? opts.reparseImpl : defaultReparseImpl;
      const jobId = opts.jobs.start({
        kind: "kb-reparse",
        kb: name,
        label: `重试 ${name}: ${doc.title}`,
        run: async () => {
          const result = await reparse({ dir, doc, sourcePath: found.path, config: buildRetryConfig(opts) });
          return { status: "succeeded", detail: `重试完成：${doc.title}`, result };
        },
      });
      return sendJson(res, 202, { jobId });
    }
    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "source" && method === "GET") {
      const { name } = ensureKb(opts, segments[1]);
      const found = await findSource(opts.kbRoot, name, segments[3]);
      if (!found) throw new KbError("SOURCE_NOT_FOUND", 404, "原件不存在");
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const inline = url.searchParams.get("inline") === "1";
      const filename = encodeURIComponent(found.name);
      if (!inline) {
        const ok = await serveFile(res, found.path, {
          headers: { "content-disposition": `attachment; filename*=UTF-8''${filename}` },
        });
        if (!ok) throw new KbError("SOURCE_NOT_FOUND", 404, "原件不存在");
        return;
      }
      // 内联只放行白名单扩展名（PDF/位图/纯文本）；HTML/SVG 等可能执行脚本的
      // 格式仍必须走附件下载，避免同源 XSS。
      const inlineType = inlineTypeFor(found.name);
      if (!inlineType) {
        throw new KbError("SOURCE_NOT_PREVIEWABLE", 415, "该格式不支持内联预览，请下载原件");
      }
      const ok = await serveFile(res, found.path, {
        cache: "private, no-store",
        headers: {
          "content-type": inlineType,
          "content-disposition": `inline; filename*=UTF-8''${filename}`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
      if (!ok) throw new KbError("SOURCE_NOT_FOUND", 404, "原件不存在");
      return;
    }
    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "preview.pdf" && method === "GET") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const doc = await readDoc(opts.kbRoot, name, segments[3]);
      if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
      const found = await findSource(opts.kbRoot, name, doc.id);
      if (!found) throw new KbError("SOURCE_NOT_FOUND", 404, "原件不存在");
      if (!isOffice(found.name)) {
        throw new KbError("PREVIEW_UNSUPPORTED", 415, "该格式不支持 PDF 预览，请下载原件");
      }
      const engine = opts.previewEngine && typeof opts.previewEngine === "object" ? opts.previewEngine : null;
      // previewEngine.cliPath 显式给出时用它（含 null：测试/部署可强制"引擎缺失"）；
      // 未给出时按配置 → 环境变量 → 默认安装 → PATH 的顺序探测。
      const cliPath = engine?.cliPath !== undefined
        ? engine.cliPath
        : resolveOfficeCli(opts.officeKitCli);
      if (!cliPath) {
        throw new KbError("PREVIEW_ENGINE_MISSING", 501, "未安装 Office 转换引擎（LibreOfficeKit），请安装后重试");
      }
      const convert = typeof engine?.convert === "function" ? engine.convert : convertOfficeToPdf;
      let previewPath;
      try {
        previewPath = await getOrCreateOfficePreview({
          kbDir: dir,
          docId: doc.id,
          sourcePath: found.path,
          cliPath,
          convert,
        });
      } catch (error) {
        // 转换器/文件系统错误可能带绝对路径，只记错误码，对外固定文案。
        console.error("[kb-web] preview conversion failed", error?.code ?? error?.name ?? "unknown");
        throw new KbError("PREVIEW_FAILED", 500, "原件预览转换失败");
      }
      const ok = await serveFile(res, previewPath, {
        cache: "private, no-store",
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${doc.id}.pdf`)}`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
      if (!ok) throw new KbError("PREVIEW_FAILED", 500, "原件预览转换失败");
      return;
    }
    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "content" && method === "GET") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const doc = await readDoc(opts.kbRoot, name, segments[3]);
      if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
      let contentPath;
      if (doc.type === "note") {
        // 笔记没有原件：内容来自派生层的合并版 markdown。
        contentPath = join(dir, "markdown", doc.id, `${doc.id}.md`);
      } else {
        const found = await findSource(opts.kbRoot, name, doc.id);
        if (!found) throw new KbError("SOURCE_NOT_FOUND", 404, "原件不存在");
        const ext = extname(found.name).toLowerCase();
        if (ext !== ".txt" && ext !== ".md") {
          throw new KbError("SOURCE_NOT_PREVIEWABLE", 415, "该格式不支持内容预览，请下载原件");
        }
        contentPath = found.path;
      }
      let content;
      try {
        content = await readTextCapped(contentPath, CONTENT_MAX_BYTES);
      } catch (error) {
        if (error?.code === "ENOENT") throw new KbError("SOURCE_NOT_FOUND", 404, "原件不存在");
        throw error;
      }
      return sendJson(res, 200, {
        title: doc.title,
        markdown: content.text,
        ...(content.truncated ? { truncated: true } : {}),
      });
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
      const result = await importBatch({
        jobs: opts.jobs,
        spawn: opts.spawn,
        kbRoot: opts.kbRoot,
        kbDir,
        batchId: segments[1],
        body,
        importConfig: opts.importConfig ?? (() => ({})),
        dedup: opts.dedup,
      });
      return sendJson(res, result.jobId ? 202 : 200, result);
    }

    if (segments.length === 1 && segments[0] === "jobs" && method === "GET") {
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const params = url.searchParams;
      const jobs = await opts.jobs.list({
        ...(params.get("kb") ? { kb: params.get("kb") } : {}),
        ...(params.get("kind") ? { kind: params.get("kind") } : {}),
        ...(params.get("limit") ? { limit: params.get("limit") } : {}),
      });
      return sendJson(res, 200, { jobs: jobs.map(listJobRow) });
    }

    if (segments[0] === "jobs" && segments.length === 3 && segments[2] === "cancel" && method === "POST") {
      const id = segments[1];
      const job = await opts.jobs.get(id);
      if (!job) throw new KbError("JOB_NOT_FOUND", 404, "任务不存在或已过期");
      if (job.status !== "running") {
        throw new KbError("JOB_NOT_RUNNING", 409, "任务已结束，无法取消", { jobId: job.id });
      }
      opts.jobs.cancel(id);
      return sendJson(res, 200, { job: await opts.jobs.get(id) });
    }

    if (segments[0] === "jobs" && segments.length === 2 && method === "GET") {
      const job = await opts.jobs.get(segments[1]);
      if (!job) throw new KbError("JOB_NOT_FOUND", 404, "任务不存在或已过期");
      return sendJson(res, 200, { job });
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
          await renameScopeKb(opts.kbRoot, current, next).catch(() => {});
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

    if (segments.length === 2 && segments[0] === "trash" && method === "DELETE") {
      const dirName = segments[1];
      if (dirName === "" || dirName === "." || dirName === ".." || /[/\\]/.test(dirName) || /[\u0000-\u001f]/.test(dirName)) {
        throw new KbError("TRASH_INVALID", 400, "归档目录名无效");
      }
      const purged = await purgeKb(opts.kbRoot, dirName);
      return sendJson(res, 200, { ok: true, ...purged });
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
      const uploadRoute = String(req.url ?? "").includes("/upload-batches");
      console.error(`[kb-web] ${uploadRoute ? "upload" : "api"} failed`, rawError);
      return uploadRoute
        ? sendError(res, 500, "UPLOAD_FAILED", "上传写入失败")
        : sendError(res, 500, "INTERNAL", "服务器内部错误");
    }
    const status = Number(error.status) || 500;
    if (status >= 500) console.error("[kb-web] api error", error);
    return sendError(res, status, error.code, String(error.message ?? error), error.details);
  }
}
