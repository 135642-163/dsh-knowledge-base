/**
 * /kb/api/* 路由分发。Slice 1：status / kbs / detail / docs / source。
 */
import { existsSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
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
import { pageOfClause } from "../sources.js";
import {
  clampViewerPage,
  normalizeRotate,
  normalizeViewerTerms,
  parseViewerPage,
  renderPdfViewerHtml,
} from "./pdf-viewer.js";
import { renderPdfPage } from "./pdf-pages.js";
import { installOfficeKit, officeEngineStatus } from "./office-install.js";
import { readStdStatus, startStdJob } from "./std.js";
import { archiveKb, createKb, listTrash, purgeKb, restoreKb, syncSchemaTitle, updateKbMeta } from "../kbmeta.js";
import {
  expandRoot,
  isDeleted,
  kbDirPath,
  listKbs,
  readManifest,
  removeDoc,
  renameKb,
  restoreDoc,
  sanitizeKbName,
  softDeleteDoc,
  TRASH_REVALIDATION_MESSAGE,
  tryReadManifest,
  updateDocMetaLocked,
  withManifestLock,
} from "../store.js";
import { normalizeDocSummary } from "../doc-meta.js";
import { appendLog, normalizeTags, refreshIndexIfStale } from "../wiki.js";
import { refreshKbIndex } from "../import-job.js";
import { importFileInto } from "../pipeline.js";
import { TransferError, moveDocs, preflightMove, undoMove } from "../transfer.js";
import { VERSION } from "../version.js";
import { searchKb, shouldUseFts } from "../query.js";
import { buildSearchResponse, normalizeSearchFilters, searchAll, SearchError, validateQuery } from "../search.js";
import { createSemanticChannel } from "../semantic-service.js";
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

/** 导入中超过 30 分钟没有 updatedAt 更新（或缺失/非法）视为卡死，可用永久删除清掉。 */
const STALE_IMPORTING_MS = 30 * 60 * 1000;

function isStaleImportingDoc(doc, now = Date.now()) {
  const stamp = Date.parse(String(doc?.updatedAt ?? ""));
  return !Number.isFinite(stamp) || now - stamp > STALE_IMPORTING_MS;
}

/** 全局回收站单次最多返回多少篇已删除资料（超出部分用 truncated 标记）。 */
const TRASH_DOCS_CAP = 500;
/** 跨库批量彻底删除单次最多处理多少篇（防止一次请求无限放大写操作）。 */
const TRASH_PURGE_MAX = 500;
/** 回收站自动清理：同一 kbRoot 最多每小时扫描一次。 */
const TRASH_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const TRASH_SWEEP_DAY_MS = 24 * 60 * 60 * 1000;
/** 自动清理单轮最多彻底删除多少篇：命中后干净停止，避免一次扫描放大成无界写操作。 */
const MAX_SWEEP_PER_RUN = 500;
/** sweep 只接受 ISO 日期时间前缀（YYYY-MM-DDT...）的 deletedAt，再做 Date.parse。 */
const SWEEP_DELETED_AT_PREFIX = /^\d{4}-\d{2}-\d{2}T/;
const TRASH_SORTS = new Set(["deleted_desc", "deleted_asc", "title_asc", "title_desc", "kb_asc", "kb_desc"]);

/** kbRoot → 上次自动清理时间（毫秒）。仅进程内节流；重启后会再扫一次。 */
const trashSweepAt = new Map();

/** 测试用：清空自动清理节流状态，避免用例之间互相影响。 */
export function resetTrashSweepForTests() {
  trashSweepAt.clear();
}

/** 删除时间戳（毫秒）；缺失/非法返回 null，排序时统一排到最后。 */
function deletedAtStamp(value) {
  const stamp = Date.parse(String(value ?? ""));
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * 自动清理专用时间戳：先要求 ISO 日期时间前缀，再交给 Date.parse。
 * 日期-only（"2026-08-01"）、数字时间戳、locale 字符串等即使能被 Date.parse
 * 宽松解析也不接受——无法可靠判断年龄的资料必须跳过，不能冒险删除。
 */
function sweepDeletedAtStamp(value) {
  if (typeof value !== "string" || !SWEEP_DELETED_AT_PREFIX.test(value)) return null;
  return deletedAtStamp(value);
}

/**
 * 源库墓碑指向的目标副本状态（只读）：
 *  - "live"：目标库仍可用（未归档/合并），清单里有该副本且 status === "ready"；
 *  - "deleted"：目标库仍可用，副本已被软删除；
 *  - "missing"：目标库归档/合并/不存在、清单不可读，或副本已不存在/不是 ready。
 * 任何异常都收敛为 "missing"，回收站列举不会因为坏目标库整体失败。
 */
export async function movedTargetState(kbRoot, doc) {
  const movedTo = doc?.movedTo;
  const targetKb = typeof movedTo?.kb === "string" ? movedTo.kb.trim() : "";
  if (targetKb === "") return "missing";
  let dir;
  try {
    dir = kbDirPath(kbRoot, targetKb);
  } catch {
    return "missing";
  }
  // 只读探测：不用有「缺失时创建空清单」副作用的 readManifest，坏清单也收敛为 missing。
  const manifest = await tryReadManifest(dir);
  if (!manifest) return "missing";
  if (manifest.mergedInto != null) return "missing";
  const targetId = typeof movedTo.docId === "string" && movedTo.docId !== ""
    ? movedTo.docId
    : String(doc?.id ?? "");
  if (targetId === "") return "missing";
  const targetDoc = (manifest.docs ?? []).find((item) => item?.id === targetId);
  if (!targetDoc) return "missing";
  if (isDeleted(targetDoc)) return "deleted";
  return targetDoc.status === "ready" ? "live" : "missing";
}

/** 稳定的行标识：同一时刻/同名时按 库名+id 排序，保证分页与测试可复现。 */
function trashRowKey(item) {
  return `${item.kb}\u0000${item.id}`;
}

/** deletedAt 倒序；非法/缺失日期排最后；同一时刻按 库名+id 保证顺序稳定。 */
function compareTrashDocs(a, b) {
  const left = deletedAtStamp(a.deletedAt);
  const right = deletedAtStamp(b.deletedAt);
  if (left !== null && right !== null) {
    if (left !== right) return right - left;
  } else if (left !== null) {
    return -1;
  } else if (right !== null) {
    return 1;
  }
  return trashRowKey(a).localeCompare(trashRowKey(b));
}

/** deletedAt 升序；非法/缺失日期同样排最后（无法比较的行不插到最前面）。 */
function compareTrashDocsAsc(a, b) {
  const left = deletedAtStamp(a.deletedAt);
  const right = deletedAtStamp(b.deletedAt);
  if (left !== null && right !== null) {
    if (left !== right) return left - right;
  } else if (left !== null) {
    return -1;
  } else if (right !== null) {
    return 1;
  }
  return trashRowKey(a).localeCompare(trashRowKey(b));
}

/** 文本列排序：方向只作用于主列，同值时始终用 库名+id 升序做稳定兜底。 */
function compareTrashText(a, b, field, direction) {
  const left = String(a[field] ?? "");
  const right = String(b[field] ?? "");
  const order = left.localeCompare(right, "zh-Hans-CN");
  if (order !== 0) return order * direction;
  return trashRowKey(a).localeCompare(trashRowKey(b));
}

const TRASH_COMPARATORS = {
  deleted_desc: compareTrashDocs,
  deleted_asc: compareTrashDocsAsc,
  title_asc: (a, b) => compareTrashText(a, b, "title", 1),
  title_desc: (a, b) => compareTrashText(a, b, "title", -1),
  kb_asc: (a, b) => compareTrashText(a, b, "kb", 1),
  kb_desc: (a, b) => compareTrashText(a, b, "kb", -1),
};

/** 未知/缺省 sort 一律按 deleted_desc；返回值也用于响应里的 sort 字段。 */
function normalizeTrashSort(value) {
  const sort = String(value ?? "").trim().toLowerCase();
  return TRASH_SORTS.has(sort) ? sort : "deleted_desc";
}

/** 回收站搜索：对 kb/title/type/sourceFile 做大小写不敏感的子串匹配。 */
function matchesTrashQuery(item, needle) {
  if (needle === "") return true;
  return [item.kb, item.title, item.type, item.sourceFile]
    .some((value) => String(value ?? "").toLowerCase().includes(needle));
}

/**
 * 全局回收站：扫描在用（非归档、非合并）知识库里所有软删除资料。
 * 归档库位于 .trash/ 下（listKbs 只列一级非隐藏目录，天然排除），
 * 合并库的清单已并入目标库，不再重复列出。只读清单，不改任何文件。
 *
 * 过滤/排序在截断前对全量已删除资料执行（total 是过滤后的命中数），
 * 只有进入返回窗口的行才去探测跨库移动目标状态，避免为被截断的行做无谓 I/O。
 */
export async function listDeletedDocs(kbRoot, { query = "", sort = "deleted_desc" } = {}) {
  const root = expandRoot(kbRoot);
  const needle = String(query ?? "").trim();
  const lowered = needle.toLowerCase();
  const mode = normalizeTrashSort(sort);
  const items = [];
  for (const kb of await listKbs(kbRoot)) {
    if (kb.mergedInto != null) continue;
    let manifest;
    try {
      manifest = await readManifest(join(root, kb.dir ?? kb.name));
    } catch {
      continue; // 清单损坏只影响该库：其余库的回收站照常返回
    }
    for (const doc of manifest.docs ?? []) {
      if (!isDeleted(doc)) continue;
      // 跨库移动记录：源库回收站据此选择「撤销移动」或「恢复」；未知结构按 null 处理。
      const movedTo = doc.movedTo && typeof doc.movedTo === "object" ? doc.movedTo : null;
      items.push({
        kb: kb.name,
        id: String(doc.id ?? ""),
        title: String(doc.title ?? ""),
        type: String(doc.type ?? ""),
        deleted: true,
        deletedAt: String(doc.deletedAt ?? ""),
        deletedFromStatus: String(doc.deletedFromStatus ?? ""),
        movedTo,
        sourceFile: String(doc.sourceFile ?? ""),
        error: String(doc.error ?? ""),
      });
    }
  }
  const filtered = items.filter((item) => matchesTrashQuery(item, lowered));
  filtered.sort(TRASH_COMPARATORS[mode]);
  const total = filtered.length;
  const visible = filtered.slice(0, TRASH_DOCS_CAP);
  for (const item of visible) {
    const movedTo = item.movedTo;
    if (movedTo == null || typeof movedTo.kb !== "string" || movedTo.kb === "") continue;
    const state = await movedTargetState(root, item);
    // live 仍只能撤销移动；deleted/missing 允许直接恢复源文档（清 movedTo）。
    item.movedToState = state;
    item.canRestoreSource = state !== "live";
  }
  return {
    items: visible,
    total,
    truncated: total > TRASH_DOCS_CAP,
    query: needle,
    sort: mode,
  };
}

/** 回收站保留天数：非法值按 0（关闭）处理，并夹到配置允许的 0–3650。 */
function retentionDaysOf(value) {
  const days = Math.round(Number(value));
  if (!Number.isFinite(days)) return 0;
  return Math.min(3650, Math.max(0, days));
}

/** now 允许是数字或函数（测试注入时钟）；非法值回落到当前时间。 */
function nowStamp(value) {
  const raw = typeof value === "function" ? value() : value;
  const stamp = Number(raw);
  return Number.isFinite(stamp) ? stamp : Date.now();
}

/**
 * 回收站自动清理：超过保留期的普通软删除资料直接彻底删除。
 *  - 只扫描在用（非归档、非合并）知识库；
 *  - 显式跳过导入中（防御旧清单残留 deletedAt）与 movedTo 墓碑；
 *  - deletedAt 缺失/非 ISO 日期时间/非法 → 跳过并计入 skipped（无法判断年龄，不能冒险删）；
 *  - 单篇失败（含锁内复验发现已被恢复）继续处理其余条目，计入 skipped；
 *  - 单轮最多删除 MAX_SWEEP_PER_RUN 篇，命中后干净停止并回 capped=true；
 *  - 每库清理后刷新一次 index.md，返回 { purged, skipped, capped, byKb }。
 * 测试可传 removeDocImpl 注入替身；返回值不含任何绝对路径。
 */
export async function sweepTrash(kbRoot, { days = 0, now = Date.now, removeDocImpl } = {}) {
  const retention = Number(days);
  if (!Number.isFinite(retention) || retention <= 0) {
    return { purged: 0, skipped: 0, capped: false, byKb: {} };
  }
  const current = nowStamp(now);
  const cutoff = current - retention * TRASH_SWEEP_DAY_MS;
  const root = expandRoot(kbRoot);
  const remove = typeof removeDocImpl === "function" ? removeDocImpl : removeDoc;
  let purged = 0;
  let skipped = 0;
  let capped = false;
  const byKb = {};
  for (const kb of await listKbs(kbRoot)) {
    if (kb.mergedInto != null) continue;
    const dir = join(root, kb.dir ?? kb.name);
    // 只读探测：清理不应给缺失或损坏的库补写空清单。
    const manifest = await tryReadManifest(dir);
    if (!manifest) continue; // 清单损坏只影响该库：其余库照常清理
    let changed = false;
    for (const doc of manifest.docs ?? []) {
      if (!isDeleted(doc) || doc.status === "importing") continue;
      // 跨库移动的源库墓碑用于撤销移动：即使过了保留期也必须保留。
      if (doc.movedTo != null) continue;
      const stamp = sweepDeletedAtStamp(doc.deletedAt);
      if (stamp === null) {
        skipped += 1;
        continue;
      }
      if (stamp >= cutoff) continue; // 仍在保留期内（恰好等于截止时间也保留）
      try {
        // 锁内复验：预检后若被恢复（或重新进入导入），removeDoc 会拒绝删除。
        await remove(dir, doc.id, { requireDeleted: true });
      } catch {
        skipped += 1; // errno/路径留在服务端，响应只含计数
        continue;
      }
      purged += 1;
      byKb[kb.name] = (byKb[kb.name] ?? 0) + 1;
      changed = true;
      // 日志/索引是附属产物：删除已落盘后，附属写入失败不能中断整轮清理。
      await appendLog(dir, {
        action: "remove",
        title: doc.title,
        docId: doc.id,
        detail: `自动清理（超过 ${retention} 天）`,
      }).catch(() => {});
      if (purged >= MAX_SWEEP_PER_RUN) {
        capped = true;
        break;
      }
    }
    if (changed) await refreshKbIndex(dir).catch(() => {});
    if (capped) break; // 达到单轮上限：先完成本库索引刷新，再干净停止
  }
  return { purged, skipped, capped, byKb };
}

/**
 * 带节流的自动清理：同一 kbRoot 每小时最多扫描一次（模块级进程内状态）。
 * 启动与 GET /trash/docs 共用；返回 null 表示本轮被节流或清理失败。
 */
export async function sweepTrashIfDue(opts) {
  const days = retentionDaysOf(opts?.trashRetentionDays);
  if (days <= 0) return null;
  const root = expandRoot(String(opts?.kbRoot ?? ""));
  const current = nowStamp(opts?.now);
  const last = trashSweepAt.get(root);
  if (last !== undefined && current - last < TRASH_SWEEP_INTERVAL_MS) return null;
  trashSweepAt.set(root, current);
  try {
    return await sweepTrash(opts.kbRoot, {
      days,
      now: current,
      ...(typeof opts?.removeDocImpl === "function" ? { removeDocImpl: opts.removeDocImpl } : {}),
    });
  } catch {
    return null; // 启动/列举都不能因为清理失败整体失败
  }
}

/** 永久删除失败原因：固定文案，避免把 fs 错误的绝对路径回显给前端。 */
const PURGE_FAILED_MESSAGE = "彻底删除失败";
/** 锁内复验发现文档已被恢复/重新导入：固定文案，仍不带任何路径。 */
const PURGE_REVALIDATION_FAILED_MESSAGE = "彻底删除失败：文档已不在回收站";

/** 失败响应只区分“不再在回收站”和一般失败，两者都是固定文案。 */
function purgeFailureMessage(error) {
  return error instanceof Error && error.message === TRASH_REVALIDATION_MESSAGE
    ? PURGE_REVALIDATION_FAILED_MESSAGE
    : PURGE_FAILED_MESSAGE;
}

/**
 * 批量彻底删除本库回收站里的资料：
 *  - 必须逐字输入库名确认；
 *  - 只允许已软删除的条目（all=true 也只选回收站），绝不触碰在用资料；
 *  - 显式跳过导入中的条目（防御旧清单残留 deletedAt）；
 *  - 删除调用传 requireDeleted=true，锁内复验以免预检后被恢复仍被删；
 *  - 单篇失败继续处理其余条目，最后统一刷新 index.md。
 * 测试可传 removeDocImpl 注入替身（签名同 store.removeDoc）。
 */
async function purgeDeletedDocs({ name, dir, body, removeDocImpl }) {
  const confirm = String(body?.confirm ?? "").trim();
  if (confirm !== name) {
    throw new KbError("CONFIRM_REQUIRED", 400, `彻底删除需要输入库名：${name}`);
  }
  const all = body?.all === true;
  const ids = [];
  for (const raw of Array.isArray(body?.ids) ? body.ids : []) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (id !== "" && !ids.includes(id)) ids.push(id);
  }
  const hasIds = ids.length > 0;
  // 恰好二选一：all 与 ids 同时给出（或都没给）都算参数非法。
  if (all === hasIds) {
    throw new KbError("INVALID_ARGS", 400, "参数无效：all 与 ids 必须二选一");
  }

  const manifest = await readManifest(dir);
  const docs = manifest.docs ?? [];
  let targets;
  if (all) {
    targets = docs.filter((doc) => isDeleted(doc) && doc.status !== "importing");
    if (targets.length === 0) throw new KbError("NO_DELETED_DOCS", 409, "没有已删除的资料");
  } else {
    targets = ids.map((id) => {
      const doc = docs.find((item) => item.id === id);
      if (!doc || !isDeleted(doc) || doc.status === "importing") {
        const title = String(doc?.title ?? "").trim() || id;
        throw new KbError("DOC_NOT_DELETED", 409, `文档未处于删除状态：${title}（${id}）`, { id, title });
      }
      return doc;
    });
  }

  const remove = typeof removeDocImpl === "function" ? removeDocImpl : removeDoc;
  const failed = [];
  let purged = 0;
  for (const doc of targets) {
    const title = String(doc.title ?? "");
    try {
      await remove(dir, doc.id, { requireDeleted: true });
    } catch (error) {
      // 失败条目只回标题与固定文案：errno/路径留在服务端，不跨 API 边界。
      failed.push({ id: String(doc.id ?? ""), title, error: purgeFailureMessage(error) });
      continue;
    }
    purged += 1;
    // 日志与索引是附属产物：永久删除已落盘后，附属写入失败不能让请求以 500 收场。
    await appendLog(dir, { action: "remove", title: doc.title, docId: doc.id, detail: "彻底删除" })
      .catch(() => {});
  }
  await refreshKbIndex(dir).catch(() => {});
  return { kb: name, purged, failed };
}

/**
 * 跨库批量彻底删除：一次请求处理多个知识库的回收站条目。
 *  - 先对全部条目做只读预检（库存在 + 条目已软删除），任一不合法整批不删；
 *  - confirm 必须逐字输入「彻底删除 N 篇」；
 *  - 单篇失败继续处理其余条目，失败项只回固定文案；
 *  - 成功后每库追加一条日志，并在循环结束后每库刷新一次 index.md。
 * 测试可传 removeDocImpl 注入替身（签名同 store.removeDoc）。
 */
async function purgeDeletedDocsAcrossKbs({ kbRoot, body, removeDocImpl }) {
  const rawItems = body?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new KbError("INVALID_ARGS", 400, "参数无效：items 不能为空");
  }
  if (rawItems.length > TRASH_PURGE_MAX) {
    throw new KbError("INVALID_ARGS", 400, `参数无效：一次最多彻底删除 ${TRASH_PURGE_MAX} 篇`);
  }

  // 按 kb+id 去重（同一篇被勾选两次只删一次）；空白条目直接判非法。
  const items = [];
  const seen = new Set();
  for (const raw of rawItems) {
    const kb = typeof raw?.kb === "string" ? raw.kb.trim() : "";
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    if (kb === "" || id === "") {
      throw new KbError("INVALID_ARGS", 400, "参数无效：items 需要 kb 与 id");
    }
    const key = `${kb}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kb, id, title: typeof raw?.title === "string" ? raw.title : "" });
  }
  if (items.length === 0) throw new KbError("INVALID_ARGS", 400, "参数无效：items 不能为空");

  // 确认短语按去重后的篇数生成；含重复条目时也接受原始条目数，兼容用户按勾选数输入。
  const confirm = String(body?.confirm ?? "").trim();
  const acceptedCounts = new Set([items.length]);
  if (rawItems.length !== items.length) acceptedCounts.add(rawItems.length);
  const confirmed = [...acceptedCounts].some((count) => confirm === `彻底删除 ${count} 篇`);
  if (!confirmed) {
    throw new KbError("CONFIRM_REQUIRED", 400, `请输入「彻底删除 ${items.length} 篇」以确认`);
  }

  // 先全量预检：任何一条不合法都在删除前抛 409，返回首个问题条目。
  const manifests = new Map();
  const resolved = [];
  const seenResolved = new Set();
  for (const item of items) {
    let kb;
    try {
      kb = ensureKb({ kbRoot }, item.kb);
    } catch {
      throw new KbError("KB_NOT_FOUND", 409, `知识库不存在: ${item.kb}`, {
        kb: item.kb,
        id: item.id,
        title: item.title,
      });
    }
    let manifest = manifests.get(kb.dir);
    if (!manifest) {
      // 只读预检：坏清单/缺清单都按库不可用处理，不补写文件。
      manifest = await tryReadManifest(kb.dir);
      if (!manifest) {
        throw new KbError("KB_NOT_FOUND", 409, `知识库不存在: ${item.kb}`, {
          kb: item.kb,
          id: item.id,
          title: item.title,
        });
      }
      manifests.set(kb.dir, manifest);
    }
    const doc = (manifest.docs ?? []).find((entry) => entry.id === item.id);
    if (!doc || !isDeleted(doc) || doc.status === "importing") {
      const title = String(doc?.title ?? item.title ?? "").trim() || item.id;
      throw new KbError("DOC_NOT_DELETED", 409, `文档未处于删除状态：${title}（${item.id}）`, {
        kb: item.kb,
        id: item.id,
        title,
      });
    }
    // 不同写法可能 sanitize 到同一个库：解析后再去重一次，避免重复删除报失败。
    const resolvedKey = `${kb.dir}\u0000${doc.id}`;
    if (seenResolved.has(resolvedKey)) continue;
    seenResolved.add(resolvedKey);
    resolved.push({ kb: kb.name, dir: kb.dir, doc });
  }

  const remove = typeof removeDocImpl === "function" ? removeDocImpl : removeDoc;
  const failed = [];
  const byKb = {};
  const affected = new Set();
  let purged = 0;
  for (const target of resolved) {
    const title = String(target.doc.title ?? "");
    try {
      await remove(target.dir, target.doc.id, { requireDeleted: true });
    } catch (error) {
      // 失败条目只回库/标题/固定文案：errno 与绝对路径留在服务端。
      failed.push({
        kb: target.kb,
        id: String(target.doc.id ?? ""),
        title,
        error: purgeFailureMessage(error),
      });
      continue;
    }
    purged += 1;
    byKb[target.kb] = (byKb[target.kb] ?? 0) + 1;
    affected.add(target.dir);
    await appendLog(target.dir, {
      action: "remove",
      title: target.doc.title,
      docId: target.doc.id,
      detail: "彻底删除（跨库批量）",
    }).catch(() => {});
  }
  // 日志与索引是附属产物：删除已落盘后，附属写入失败不能让请求以 500 收场。
  for (const dir of affected) await refreshKbIndex(dir).catch(() => {});
  return { purged, failed, byKb };
}

/**
 * 默认的重试实现：用 sources/ 里保存的原件重新跑导入管线，成功后刷新索引。
 * 失败时只回报文档标题（不带任何绝对路径），具体错误留在服务端日志。
 * 测试可传 opts.reparseImpl 注入替身（返回导入报告即可）。
 */
async function defaultReparseImpl({ dir, doc, sourcePath, config }) {
  const title = String(doc?.title ?? "").trim() || String(doc?.id ?? "文档");
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
  } catch {
    throw new Error(`重试失败：${title}`);
  } finally {
    // 成功/再次失败都会更新清单（ready 或 failed），索引都应按最新清单刷新。
    // 刷新失败不能反过来把一次成功的重试判为失败。
    await refreshKbIndex(dir).catch(() => {});
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
      // 语义状态只读清单/索引文件，不加载模型；注入的 semanticStatus 失败也不影响主状态。
      let semantic = { enabled: false, indexReady: false, model: "", dim: 0, docs: 0, reason: "disabled" };
      if (typeof opts.semanticStatus === "function") {
        try {
          semantic = await opts.semanticStatus();
        } catch {
          semantic = { ...semantic, reason: "status_failed" };
        }
      }
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        kbRoot: opts.kbRoot,
        kbRootOk: !opts.kbRootError,
        kbRootError: String(opts.kbRootError ?? ""),
        semantic,
        features: { ui: true, merge: false, std: true, upload: true, jobs: true, scope: true },
        limits,
      });
    }
    // Office 转换引擎（LibreOfficeKit）可选安装：状态只读，安装必须显式同意并走后台任务。
    if (segments.length === 2 && segments[0] === "office" && segments[1] === "status" && method === "GET") {
      const status = typeof opts.officeStatus === "function"
        ? await opts.officeStatus()
        : await officeEngineStatus({ cliPath: opts.officeKitCli });
      return sendJson(res, 200, status);
    }

    if (segments.length === 2 && segments[0] === "office" && segments[1] === "install" && method === "POST") {
      const body = await readJsonBody(req);
      if (body?.confirm !== true) {
        throw new KbError("CONSENT_REQUIRED", 400, "安装需要用户确认");
      }
      const readStatus = typeof opts.officeStatus === "function"
        ? opts.officeStatus
        : () => officeEngineStatus({ cliPath: opts.officeKitCli });
      const status = await readStatus();
      if (status?.available === true) {
        return sendJson(res, 200, { alreadyInstalled: true, status });
      }
      if (status?.running === true) {
        throw new KbError("OFFICE_INSTALL_RUNNING", 409, "Office 转换引擎正在安装，请稍候");
      }
      if (status?.canInstall !== true) {
        throw new KbError("OFFICE_TOOLCHAIN_MISSING", 409, "缺少 Node/npm，无法自动安装，请按 README 手动安装");
      }
      const installer = typeof opts.officeInstaller === "function" ? opts.officeInstaller : installOfficeKit;
      const jobId = opts.jobs.start({
        kind: "office-install",
        label: "安装 Office 转换引擎",
        run: async (ctx) => {
          ctx.setProgress({ phase: "download", text: "正在下载并安装…" });
          const result = await installer({ onProgress: (progress) => ctx.setProgress(progress) });
          return { status: "succeeded", detail: "已安装 Office 转换引擎", result };
        },
      });
      return sendJson(res, 202, { jobId });
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
    // 检索工作台：GET /kb/api/search（只读；纯文本优先 FTS5，标准号/正则走 ripgrep）。
    if (segments.length === 1 && segments[0] === "search" && method === "GET") {
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const started = performance.now();
      let q;
      let filters;
      try {
        q = validateQuery(url.searchParams.get("q") ?? "");
        filters = normalizeSearchFilters({
          tag: url.searchParams.get("tag") ?? "",
          type: url.searchParams.get("type") ?? "",
          trust: url.searchParams.get("trust") ?? "",
          limit: url.searchParams.get("limit") ?? undefined,
          offset: url.searchParams.get("offset") ?? undefined,
        });
      } catch (error) {
        if (error instanceof SearchError) throw new KbError(error.code, error.status, error.message);
        throw error;
      }
      const kbParam = String(url.searchParams.get("kb") ?? "").trim();
      const everyKb = kbParam === "" || kbParam === "*" || kbParam.toLowerCase() === "all";
      const targets = [];
      if (everyKb) {
        // 归档库已在 .trash 下、合并库由 mergedInto 标记，二者都不参与检索。
        for (const entry of await listKbs(opts.kbRoot)) {
          if (entry.mergedInto) continue;
          const dir = kbDirPath(opts.kbRoot, entry.dir ?? entry.name);
          const manifest = await tryReadManifest(dir);
          if (!manifest) continue;
          const docs = manifest.docs ?? [];
          if (docs.length === 0) continue;
          targets.push({ kb: manifest.name || entry.name, dir, docs });
        }
      } else {
        const { name, dir } = ensureKb(opts, kbParam);
        const manifest = await readManifest(dir);
        targets.push({ kb: name, dir, docs: manifest.docs ?? [] });
      }
      const spawn = typeof opts.spawn === "function" ? opts.spawn : null;
      // 标准号/含正则的查询只能走 ripgrep；没有子进程通道时不能静默返回空结果。
      if (!spawn && !shouldUseFts(q)) {
        throw new KbError("SEARCH_UNAVAILABLE", 503, "检索进程不可用");
      }
      const controller = new AbortController();
      const onClose = () => controller.abort();
      if (typeof req.on === "function") req.on("close", onClose);
      let spawnFailures = 0;
      const ctxShim = {
        subprocess: {
          spawn: (...args) => {
            if (!spawn) {
              spawnFailures += 1;
              throw new Error("检索进程不可用");
            }
            return spawn(...args);
          },
        },
      };
      try {
        const filterCount = (filters.tag ? 1 : 0) + (filters.type ? 1 : 0) + (filters.trust ? 1 : 0);
        // 过滤在归并后执行：带过滤时多取一些候选，避免被过滤吃空。
        const maxMatches = Math.min(500, Math.max(200, filters.limit * 8 * (filterCount > 0 ? 3 : 1)));
        // 语义层默认关闭：只有配置开 + 运行时存在时才装配；关闭时不加载模型、不读向量。
        const semantic = opts.semanticSearch === "on" && opts.semanticRuntime
          ? createSemanticChannel({ runtime: opts.semanticRuntime, targets })
          : null;
        const outcome = await searchAll({
          targets,
          query: q,
          filters,
          semantic,
          searcher: (target) => searchKb(
            ctxShim,
            { signal: controller.signal },
            target.dir,
            { docs: target.docs },
            { pattern: q, ftsPattern: q, maxMatches, backgroundIndex: true },
          ),
        });
        if (!spawn && spawnFailures > 0 && outcome.results.length === 0) {
          throw new KbError("SEARCH_UNAVAILABLE", 503, "检索进程不可用");
        }
        if (controller.signal.aborted) return undefined;
        return sendJson(res, 200, buildSearchResponse({
          q,
          kb: everyKb ? "" : targets[0]?.kb ?? "",
          kbs: targets.map((target) => target.kb),
          ...outcome,
          filters,
          tookMs: performance.now() - started,
        }));
      } finally {
        if (typeof req.off === "function") req.off("close", onClose);
      }
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
        tag: url.searchParams.get("tag") ?? undefined,
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

    // 资料编目：人工摘要/标签；summarySource=manual，不动正文版本号。
    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "metadata" && method === "PATCH") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const body = await readJsonBody(req);
      if (body === null || typeof body !== "object") {
        throw new KbError("INVALID_ARGS", 400, "请求体必须是 JSON 对象");
      }
      if (body.summary === undefined && body.tags === undefined && body.title === undefined) {
        throw new KbError("INVALID_ARGS", 400, "请提供 title、summary 或 tags");
      }
      if (body.summary !== undefined && body.summary !== null && typeof body.summary !== "string") {
        throw new KbError("INVALID_ARGS", 400, "summary 必须是字符串或 null");
      }
      if (body.tags !== undefined && typeof body.tags !== "string" && !Array.isArray(body.tags)) {
        throw new KbError("INVALID_ARGS", 400, "tags 必须是字符串数组或逗号分隔字符串");
      }
      if (body.title !== undefined && typeof body.title !== "string") {
        throw new KbError("INVALID_ARGS", 400, "title 必须是字符串");
      }
      const patch = {};
      if (body.title !== undefined) {
        const title = body.title.replace(/\s+/g, " ").trim().slice(0, 200);
        if (!title) throw new KbError("INVALID_ARGS", 400, "title 不能为空");
        patch.title = title;
        patch.titleSource = "manual";
      }
      if (body.summary !== undefined) {
        const summary = normalizeDocSummary(body.summary);
        patch.summary = summary;
        patch.summarySource = summary ? "manual" : "";
      }
      if (body.tags !== undefined) patch.tags = normalizeTags(body.tags);
      let title = "";
      await withManifestLock(dir, async () => {
        const manifest = await readManifest(dir);
        const doc = (manifest.docs ?? []).find((item) => item.id === segments[3]);
        if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
        if (doc.status === "importing") throw new KbError("DOC_IMPORTING", 409, "文档正在导入，暂不能编目");
        if (isDeleted(doc)) throw new KbError("DOC_DELETED", 409, "文档已删除");
        title = patch.title ?? doc.title;
        await updateDocMetaLocked(dir, manifest, doc.id, patch);
      });
      await appendLog(dir, { action: "describe", title, docId: segments[3], detail: "人工编目" });
      await refreshKbIndex(dir);
      return sendJson(res, 200, { doc: await readDoc(opts.kbRoot, name, segments[3]) });
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
      const permanent = body?.permanent === true;
      // 导入中的文档正文可能还在写：软删一律拒绝；永久删只在导入长时间无进展
      // （updatedAt 超过 30 分钟或缺失）时放行，作为卡死任务的人工逃生口。
      if (doc.status === "importing" && (!permanent || !isStaleImportingDoc(doc))) {
        throw new KbError("DOC_IMPORTING", 409, "文档正在导入，暂不能删除");
      }
      if (!permanent) {
        const result = await softDeleteDoc(dir, doc.id);
        await appendLog(dir, { action: "remove", title: doc.title, docId: doc.id, detail: "软删除" });
        await refreshKbIndex(dir);
        return sendJson(res, 200, { docId: doc.id, deletedAt: result.deletedAt, soft: true });
      }
      // 永久删除只从回收站发起；卡死的 importing 文档是唯一例外（上面已放行）。
      if (!isDeleted(doc) && doc.status !== "importing") {
        throw new KbError("DOC_NOT_DELETED", 409, "彻底删除只能从回收站发起");
      }
      // 永久删除不可恢复：必须逐字确认标题（去首尾空白），避免列表误点。
      if (String(body?.confirm ?? "").trim() !== String(doc.title ?? "").trim()) {
        throw new KbError("CONFIRM_REQUIRED", 400, `彻底删除需要确认标题：${doc.title}`);
      }
      // 回收站来源的删除在锁内复验已删除状态；卡死 importing 是唯一允许
      // 永久删除的非回收站条目，它本来就不在回收站，不能套 requireDeleted。
      const staleImporting = doc.status === "importing" && isStaleImportingDoc(doc);
      try {
        await removeDoc(dir, doc.id, { requireDeleted: !staleImporting });
      } catch (error) {
        if (error instanceof Error && error.message === TRASH_REVALIDATION_MESSAGE) {
          throw new KbError("DOC_NOT_DELETED", 409, "文档已不在回收站，拒绝彻底删除");
        }
        throw error;
      }
      // 不可恢复的删除已经完成：日志/索引刷新失败只影响附属产物，不再回 500。
      await appendLog(dir, { action: "remove", title: doc.title, docId: doc.id, detail: "永久删除" })
        .catch(() => {});
      await refreshKbIndex(dir).catch(() => {});
      return sendJson(res, 200, { docId: doc.id, removed: true });
    }

    // 回收站批量彻底删除：all=true 或 ids 二选一，confirm 必须是库名。
    if (segments[0] === "kbs" && segments.length === 4 && segments[2] === "docs" && segments[3] === "purge" && method === "POST") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const body = await readJsonBody(req);
      const result = await purgeDeletedDocs({ name, dir, body, removeDocImpl: opts.removeDocImpl });
      return sendJson(res, 200, result);
    }

    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "restore" && method === "POST") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const doc = await readDoc(opts.kbRoot, name, segments[3]);
      if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
      // 跨库移动的源文档：目标副本仍可用时只能撤销移动；目标副本已软删除/缺失
      // （含目标库归档）时允许普通恢复，同时清掉 movedTo，避免源文档永久卡在回收站。
      const moved = doc.movedTo && typeof doc.movedTo === "object"
        && typeof doc.movedTo.kb === "string" && doc.movedTo.kb !== "";
      if (moved) {
        const state = await movedTargetState(opts.kbRoot, doc);
        if (state === "live") {
          throw new KbError(
            "DOC_MOVED",
            409,
            "文档已跨库移动，请使用撤销移动",
            { targetKb: doc.movedTo.kb }
          );
        }
        await restoreDoc(dir, doc.id, { clearMovedTo: true });
        await appendLog(dir, {
          action: "restore",
          title: doc.title,
          docId: doc.id,
          detail: "恢复软删除（目标库副本已不可用，解除移动记录）",
        });
        await refreshKbIndex(dir);
        return sendJson(res, 200, {
          doc: await readDoc(opts.kbRoot, name, doc.id),
          restoredMovedSource: true,
        });
      }
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
    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "viewer.html" && method === "GET") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const doc = await readDoc(opts.kbRoot, name, segments[3]);
      if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
      const found = await findSource(opts.kbRoot, name, doc.id);
      if (!found) throw new KbError("SOURCE_NOT_FOUND", 404, "原件不存在");
      if (!isOffice(found.name) && extname(found.name).toLowerCase() !== ".pdf") {
        throw new KbError("PREVIEW_UNSUPPORTED", 415, "该格式不支持逐页预览");
      }
      let pdfPath = found.path;
      if (extname(found.name).toLowerCase() !== ".pdf") {
        const engine = opts.previewEngine && typeof opts.previewEngine === "object" ? opts.previewEngine : null;
        const cliPath = engine?.cliPath !== undefined ? engine.cliPath : resolveOfficeCli(opts.officeKitCli);
        if (!cliPath) throw new KbError("PREVIEW_ENGINE_MISSING", 501, "未安装 Office 转换引擎（LibreOfficeKit），请安装后重试");
        const convert = typeof engine?.convert === "function" ? engine.convert : convertOfficeToPdf;
        try {
          pdfPath = await getOrCreateOfficePreview({ kbDir: dir, docId: doc.id, sourcePath: found.path, cliPath, convert });
        } catch {
          throw new KbError("PREVIEW_FAILED", 500, "原件预览转换失败");
        }
      }
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const terms = normalizeViewerTerms(url.searchParams.get("q") ?? "");
      // page 缺省/非法 → null，让 viewer 自动落到命中最多的页；显式页码优先。
      const page = parseViewerPage(url.searchParams.get("page"));
      const rotate = normalizeRotate(url.searchParams.get("rotate"));
      const rendered = await renderPdfViewerHtml({ pdfPath, title: doc.title ?? doc.id, page, terms, rotate });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(rendered.html),
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        "x-content-type-options": "nosniff",
      });
      res.end(rendered.html);
      return;
    }
    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "page.png" && method === "GET") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const doc = await readDoc(opts.kbRoot, name, segments[3]);
      if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
      const found = await findSource(opts.kbRoot, name, doc.id);
      if (!found) throw new KbError("SOURCE_NOT_FOUND", 404, "原件不存在");
      let pdfPath = found.path;
      if (extname(found.name).toLowerCase() !== ".pdf") {
        if (!isOffice(found.name)) throw new KbError("PREVIEW_UNSUPPORTED", 415, "该格式不支持逐页预览");
        const engine = opts.previewEngine && typeof opts.previewEngine === "object" ? opts.previewEngine : null;
        const cliPath = engine?.cliPath !== undefined ? engine.cliPath : resolveOfficeCli(opts.officeKitCli);
        if (!cliPath) throw new KbError("PREVIEW_ENGINE_MISSING", 501, "未安装 Office 转换引擎（LibreOfficeKit），请安装后重试");
        const convert = typeof engine?.convert === "function" ? engine.convert : convertOfficeToPdf;
        try {
          pdfPath = await getOrCreateOfficePreview({ kbDir: dir, docId: doc.id, sourcePath: found.path, cliPath, convert });
        } catch {
          throw new KbError("PREVIEW_FAILED", 500, "原件预览转换失败");
        }
      }
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const requested = parseViewerPage(url.searchParams.get("page")) ?? 1;
      const dpi = Math.min(200, Math.max(72, Math.round(Number(url.searchParams.get("dpi")) || 144)));
      const rotate = normalizeRotate(url.searchParams.get("rotate"));
      // 页码以清单页数为准夹取（Office 转换件的实际页数可能不同，viewer 自己再以 PDF 为准）。
      const manifestPages = Math.max(0, Math.round(Number(doc.pages) || 0));
      const pageNo = manifestPages > 0 ? clampViewerPage(requested, manifestPages) : requested;
      const rendered = await renderPdfPage({ pdfPath, page: pageNo, dpi, rotate });
      const totalPages = manifestPages > 0 ? manifestPages : rendered.total ?? pageNo;
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": rendered.png.length,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-cache": rendered.cached === "miss" ? "miss" : "hit",
        "x-total-pages": String(totalPages),
      });
      res.end(rendered.png);
      return;
    }
    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "preview.pdf" && method === "GET") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const doc = await readDoc(opts.kbRoot, name, segments[3]);
      if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
      const found = await findSource(opts.kbRoot, name, doc.id);
      if (!found) throw new KbError("SOURCE_NOT_FOUND", 404, "原件不存在");
      // WebKit 对没有 .pdf 路径的 inline PDF 常按下载处理；preview.pdf 统一给 PDF/Office
      // 一个以 .pdf 结尾的 URL，浏览器才会进入 PDF viewer 并识别 #page=N。
      if (extname(found.name).toLowerCase() === ".pdf") {
        const ok = await serveFile(res, found.path, {
          cache: "private, no-store",
          headers: {
            "content-type": "application/pdf",
            "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${doc.id}.pdf`)}`,
            "x-content-type-options": "nosniff",
            "cache-control": "private, no-store",
          },
        });
        if (!ok) throw new KbError("PREVIEW_FAILED", 500, "原件预览失败");
        return;
      }
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
    if (segments[0] === "kbs" && segments.length === 5 && segments[2] === "docs" && segments[4] === "page" && method === "GET") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const doc = await readDoc(opts.kbRoot, name, segments[3]);
      if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const clause = String(url.searchParams.get("clause") ?? "").trim();
      let page = null;
      if (clause !== "") {
        try {
          const text = await readFile(join(dir, "markdown", doc.id, `${doc.id}.md`), "utf8");
          page = pageOfClause(text, clause);
        } catch {
          page = null;
        }
      }
      return sendJson(res, 200, { page });
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

    // 全局回收站：所有在用库里的软删除资料。归档/合并库不在扫描范围。
    // 配置了保留期（trashRetentionDays > 0）时，列举前最多每小时自动清理一次；
    // 默认 0 表示关闭，此时仍是纯只读接口。
    if (segments.length === 2 && segments[0] === "trash" && segments[1] === "docs" && method === "GET") {
      await sweepTrashIfDue(opts);
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const result = await listDeletedDocs(opts.kbRoot, {
        query: url.searchParams.get("query") ?? "",
        sort: url.searchParams.get("sort") ?? "",
      });
      return sendJson(res, 200, result);
    }

    // 跨库批量彻底删除：先全量预检，confirm 必须逐字输入「彻底删除 N 篇」。
    if (segments.length === 3 && segments[0] === "trash" && segments[1] === "docs" && segments[2] === "purge" && method === "POST") {
      const body = await readJsonBody(req);
      const result = await purgeDeletedDocsAcrossKbs({
        kbRoot: opts.kbRoot,
        body,
        removeDocImpl: opts.removeDocImpl,
      });
      return sendJson(res, 200, result);
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
