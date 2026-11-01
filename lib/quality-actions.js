/**
 * 质量动作（0.36 P2）：工作台批量写操作的唯一入口。
 *
 * 原则：
 *  - 白名单：只认识 QUALITY_ACTIONS 里的 6 个动作，其余一律 400；
 *  - dryRun 缺省 true：只有显式 `dryRun: false` 才会写库，防止漏传参数造成真实写入；
 *  - 只做机械动作：不自动生成摘要、不自动改标题/标准号/可信度；
 *  - 默认软删除；本模块不提供永久删除入口；
 *  - 逐项结果，不整批回滚（describe/trust/keep 是单次清单写入，天然成组）；
 *  - 快照不自动做：params.snapshot=true 时在执行前留一份库级快照，
 *    否则由调用方（UI/Runbook）负责先快照。
 *
 * 本模块不读 HTTP、不关心路由；api.js 负责组装 reparse/snapshot 的实现。
 */
import { access, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { normalizeDocSummary } from "./doc-meta.js";
import { TRUST_LEVELS } from "./labels.js";
import { refreshKbIndex } from "./import-job.js";
import { readManifest, softDeleteDoc, updateDocsMetaLocked, withManifestLock } from "./store.js";
import { appendLog, normalizeTags } from "./wiki.js";

/** 单批最多处理多少篇；超限返回 413，避免一次请求放大成无界写操作。 */
export const QUALITY_ACTION_MAX_BATCH = 50;

/**
 * 动作白名单。
 * - background：需要跑解析，走工作台 job（202 + jobId）；
 * - mutates：content（重解析，版本号+1）/ meta（只改元数据）/ delete（软删除）。
 */
export const QUALITY_ACTIONS = Object.freeze({
  "retry-import": { label: "重试导入失败", background: true, mutates: "content" },
  "reparse-pages": { label: "按页/整篇重解析", background: true, mutates: "content" },
  describe: { label: "补摘要/标签", background: false, mutates: "meta" },
  trust: { label: "标可信度", background: false, mutates: "meta" },
  keep: { label: "标记已核对保留", background: false, mutates: "meta" },
  remove: { label: "软删除", background: false, mutates: "delete" },
});

/** 每个动作给 UI 的固定提示（不是判定，只是操作注意事项）。 */
export const QUALITY_ACTION_HINTS = Object.freeze({
  "retry-import": "只处理导入失败的资料；原件必须仍在 sources/ 里。",
  "reparse-pages": "表格/图形页 OCR 后坏页标记可能仍保留，能读即可，不要反复 OCR；只对真空白/乱码页重识别。",
  describe: "摘要必须人工撰写：先看前 1–2 页的范围句；正文抽不到时用封面标题，不编造。",
  trust: "按现行性/正式程度判断：现行发布稿 high，企业/培训/报批 medium，草案与已废止 low。",
  keep: "仅用于同号同期同阶段经人工核对后决定都保留的组（中英译本/不同分册/不同修订版）。",
  remove: "默认软删除，可在回收站恢复；永久删除不在质量动作里提供。",
});

export class QualityActionError extends Error {
  constructor(code, status, message, details) {
    super(message);
    this.name = "QualityActionError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, status, message, details) {
  throw new QualityActionError(code, status, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pageList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((page) => Number.isInteger(page) && page > 0);
}

/** 文档的坏页 / 低置信页合并（去重、升序）。 */
export function defaultReparsePages(doc) {
  const pages = new Set();
  for (const page of pageList(doc?.corruptedPages)) pages.add(page);
  for (const page of pageList(doc?.lowConfidencePages)) pages.add(page);
  return [...pages].sort((a, b) => a - b);
}

/** 解析页码参数：数组或 "1,2,3" 字符串；未提供返回 null（由调用方取默认坏页）。 */
function parsePageSelection(value) {
  if (value === undefined || value === null) return null;
  const raw = Array.isArray(value) ? value : String(value).split(/[,\s，、]+/).filter(Boolean);
  if (Array.isArray(value) && value.length === 0) return [];
  const pages = [];
  for (const part of raw) {
    const page = Number(part);
    if (!Number.isInteger(page) || page <= 0) {
      fail("QUALITY_ACTION_INVALID", 400, `页码无效：${String(part)}（应为正整数）`);
    }
    pages.push(page);
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}

function normalizeOcrModel(value) {
  if (value === undefined) return "";
  if (!["best", "fast"].includes(String(value))) {
    fail("QUALITY_ACTION_INVALID", 400, "ocrModel 只能是 best / fast");
  }
  return String(value);
}

function normalizeWatermark(value) {
  if (value === undefined) return "";
  if (!["auto", "off", "strong"].includes(String(value))) {
    fail("QUALITY_ACTION_INVALID", 400, "watermark 只能是 auto / off / strong");
  }
  return String(value);
}

/** 每个动作的参数校验；不合法直接 400（请求级，不是逐项）。 */
function normalizeParams(action, raw) {
  const params = isPlainObject(raw) ? raw : {};
  if (action === "describe") {
    if (params.title !== undefined || params.standardNo !== undefined) {
      fail(
        "QUALITY_ACTION_INVALID",
        400,
        "质量动作不自动改标题/标准号：标题与标准号必须人工给出封面证据，请走资料编目或 Runbook 人工步骤"
      );
    }
    const hasSummary = params.summary !== undefined;
    const hasTags = params.tags !== undefined;
    if (!hasSummary && !hasTags) {
      fail("QUALITY_ACTION_INVALID", 400, "describe 需要 params.summary 或 params.tags（不自动生成摘要）");
    }
    if (hasSummary && params.summary !== null && typeof params.summary !== "string") {
      fail("QUALITY_ACTION_INVALID", 400, "summary 必须是字符串或 null");
    }
    if (hasTags && typeof params.tags !== "string" && !Array.isArray(params.tags)) {
      fail("QUALITY_ACTION_INVALID", 400, "tags 必须是字符串数组或逗号分隔字符串");
    }
    const summary = hasSummary ? normalizeDocSummary(params.summary) : undefined;
    return {
      ...(hasSummary ? { summary, summarySource: summary ? "manual" : "" } : {}),
      ...(hasTags ? { tags: normalizeTags(params.tags) } : {}),
    };
  }
  if (action === "trust") {
    const level = String(params.level ?? "").trim().toLowerCase();
    if (!TRUST_LEVELS.includes(level)) {
      fail("QUALITY_ACTION_INVALID", 400, `trust 需要 params.level（${TRUST_LEVELS.join(" / ")}）`);
    }
    const reason = params.reason === undefined
      ? ""
      : String(params.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    return { level, reason };
  }
  if (action === "keep") {
    const note = params.note === undefined
      ? ""
      : String(params.note ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    return { note, clear: params.clear === true };
  }
  if (action === "remove") {
    if (params.soft === false || params.permanent === true || params.hard === true) {
      fail("QUALITY_ACTION_INVALID", 400, "质量工作台只做软删除（可恢复）；永久删除请走回收站并逐字确认标题");
    }
    return { soft: true };
  }
  if (action === "reparse-pages") {
    return {
      pages: parsePageSelection(params.pages),
      forceOcr: params.forceOcr === true,
      ocrModel: normalizeOcrModel(params.ocrModel),
      watermark: normalizeWatermark(params.watermark),
    };
  }
  // retry-import
  return {
    ocrModel: normalizeOcrModel(params.ocrModel),
    watermark: normalizeWatermark(params.watermark),
  };
}

/**
 * 请求级校验：动作白名单、ids 数量、dryRun 缺省值、快照开关。
 * 逐篇合法性在 planQualityAction 里按清单判断。
 */
export function normalizeQualityActionRequest(body) {
  if (!isPlainObject(body)) fail("QUALITY_ACTION_INVALID", 400, "请求体必须是 JSON 对象");
  const action = String(body.action ?? "").trim();
  if (!QUALITY_ACTIONS[action]) {
    fail("QUALITY_ACTION_INVALID", 400, `不支持的质量动作：${action || "(空)"}`, {
      allowed: Object.keys(QUALITY_ACTIONS),
    });
  }
  if (!Array.isArray(body.ids)) fail("QUALITY_ACTION_INVALID", 400, "ids 必须是文档 id 数组");
  const ids = [...new Set(body.ids.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) fail("QUALITY_ACTION_INVALID", 400, "请至少选择 1 篇资料");
  if (ids.length > QUALITY_ACTION_MAX_BATCH) {
    fail(
      "QUALITY_TOO_MANY",
      413,
      `单批最多 ${QUALITY_ACTION_MAX_BATCH} 篇（本次 ${ids.length} 篇），请分批执行`,
      { max: QUALITY_ACTION_MAX_BATCH, count: ids.length }
    );
  }
  // 只有显式 false 才写库；缺省/字符串/其它值一律按 dryRun 处理。
  const dryRun = body.dryRun === false ? false : true;
  const params = normalizeParams(action, body.params);
  const snapshot = body.params?.snapshot === true || body.snapshot === true;
  return { action, ids, params, dryRun, snapshot };
}

function hasSummary(doc) {
  return String(doc?.summary ?? "").trim() !== "";
}

function isPdfDoc(doc) {
  return String(doc?.type ?? "").startsWith("pdf");
}

/**
 * 逐篇合法性：返回空字符串表示可以执行，否则是该项的错误原因。
 * 这些检查只判断机械前置条件（状态/类型/页码），不做语义判断。
 */
function documentIssue(action, doc, params) {
  if (!doc) return "文档不存在";
  if (doc.status === "deleted" || typeof doc.deletedAt === "string") return "文档已删除（可在回收站恢复）";
  if (doc.status === "importing") return "文档正在导入，暂不能操作";
  if (action === "retry-import") {
    if (doc.status !== "failed") return `状态为 ${doc.status ?? "unknown"}，不是导入失败`;
    if (doc.type === "note") return "笔记没有原始文件，无需重试";
    return "";
  }
  if (action === "reparse-pages") {
    if (doc.status !== "ready") return `状态为 ${doc.status ?? "unknown"}，只有就绪资料能重解析`;
    if (doc.type === "note") return "笔记没有原始文件，无需重解析";
    if (!isPdfDoc(doc)) return "按页 OCR 仅支持 PDF；其它格式请重新导入完整版";
    if (params.forceOcr === true) return "";
    const pages = params.pages ?? defaultReparsePages(doc);
    if (pages.length === 0) return "没有坏页/低置信页；如确认要整篇 OCR，请传 params.forceOcr=true";
    const total = Number(doc.pages) || 0;
    if (total > 0 && pages.some((page) => page > total)) return `页码超出范围（共 ${total} 页）`;
    return "";
  }
  if (action === "describe") {
    if (doc.status !== "ready") return `状态为 ${doc.status ?? "unknown"}，只有就绪资料能编目`;
    return "";
  }
  if (action === "trust") {
    if (doc.status !== "ready") return `状态为 ${doc.status ?? "unknown"}，只有就绪资料能标可信度`;
    return "";
  }
  if (action === "keep") {
    if (doc.status !== "ready") return `状态为 ${doc.status ?? "unknown"}，只有就绪资料能标记保留`;
    if (doc.type === "note") return "笔记不参与重复核对";
    return "";
  }
  if (action === "remove") {
    if (doc.status !== "ready" && doc.status !== "failed") {
      return `状态为 ${doc.status ?? "unknown"}，暂不能软删除`;
    }
    return "";
  }
  return "";
}

/** 预览一项：目标文档 + 将要写入的内容（dryRun 也返回同一份，便于人工核对）。 */
function describeTarget(action, doc, params) {
  const target = {
    id: doc.id,
    title: doc.title,
    status: doc.status,
    type: doc.type,
    pages: Number(doc.pages) || 0,
    badPages: defaultReparsePages(doc),
    summaryMissing: !hasSummary(doc),
    trust: doc.trust ?? "unknown",
  };
  if (action === "retry-import") {
    target.preview = {
      forceReparse: true,
      ...(params.ocrModel ? { ocrModel: params.ocrModel } : {}),
      ...(params.watermark ? { watermark: params.watermark } : {}),
    };
  } else if (action === "reparse-pages") {
    target.preview = {
      forceOcr: params.forceOcr === true,
      pages: params.forceOcr === true ? [] : (params.pages ?? defaultReparsePages(doc)),
      forceReparse: true,
      ...(params.ocrModel ? { ocrModel: params.ocrModel } : {}),
      ...(params.watermark ? { watermark: params.watermark } : {}),
    };
  } else if (action === "describe") {
    target.preview = {
      ...(params.summarySource !== undefined ? { summary: params.summary, summarySource: params.summarySource } : {}),
      ...(params.tags !== undefined ? { tags: params.tags } : {}),
    };
  } else if (action === "trust") {
    target.preview = {
      trust: params.level,
      trustSource: params.level === "unknown" ? "unknown" : "manual",
      trustReason: params.reason,
    };
  } else if (action === "keep") {
    target.preview = { dedupKeep: params.clear !== true, dedupNote: params.clear === true ? "" : params.note };
  } else if (action === "remove") {
    target.preview = { soft: true };
  }
  return target;
}

/**
 * 计划一次质量动作：请求级校验 + 逐篇前置检查 + 预览。
 * 只读：不写清单、不写日志；dryRun 与真实执行共用这份计划。
 */
export async function planQualityAction({ dir, name, body }) {
  const request = normalizeQualityActionRequest(body);
  const manifest = await readManifest(dir);
  if (manifest.readOnly === true) {
    fail("KB_READONLY", 409, `知识库「${name}」已设为只读，不能执行质量动作`);
  }
  const byId = new Map((manifest.docs ?? []).map((doc) => [doc.id, doc]));
  const items = [];
  const errors = [];
  for (const id of request.ids) {
    const doc = byId.get(id);
    const issue = documentIssue(request.action, doc, request.params);
    if (issue !== "") {
      errors.push({ id, title: doc?.title ?? "", ok: false, error: issue });
      continue;
    }
    items.push(describeTarget(request.action, doc, request.params));
  }
  return {
    kb: name,
    action: request.action,
    params: request.params,
    dryRun: request.dryRun,
    snapshot: request.snapshot,
    items,
    errors,
  };
}

/** 预览响应（dryRun=true）：零写入。 */
export function renderQualityActionPreview(plan) {
  const meta = QUALITY_ACTIONS[plan.action] ?? {};
  return {
    kb: plan.kb,
    action: plan.action,
    dryRun: true,
    total: plan.items.length + plan.errors.length,
    valid: plan.items.length,
    invalid: plan.errors.length,
    items: plan.items,
    errors: plan.errors,
    // 快照是真实库写入，默认不在预览里做；由 UI/Runbook 决定是否随执行一起留。
    snapshotSuggested: true,
    hint: QUALITY_ACTION_HINTS[plan.action] ?? "",
    mutates: meta.mutates ?? "meta",
  };
}

/** sources/ 里的原件路径：先按 id+扩展名找，再按 id. 前缀唯一匹配（与 findSource 同口径）。 */
async function resolveSourcePath(dir, doc) {
  const sourcesDir = join(dir, "sources");
  const ext = extname(String(doc.sourceFile ?? ""));
  try {
    const candidate = join(sourcesDir, `${doc.id}${ext}`);
    await access(candidate);
    return candidate;
  } catch {
    /* 继续按前缀匹配 */
  }
  let entries = [];
  try {
    entries = await readdir(sourcesDir);
  } catch {
    return null;
  }
  const matches = entries.filter((file) => file === doc.id || file.startsWith(`${doc.id}.`));
  return matches.length === 1 ? join(sourcesDir, matches[0]) : null;
}

function reparseConfig(action, params, doc) {
  const config = { forceReparse: true };
  if (action === "reparse-pages" && params.forceOcr !== true) {
    // 未指定页码时按文档自己的坏页/低置信页走，与预览里展示的一致。
    config.forceOcrPages = params.pages ?? defaultReparsePages(doc);
  }
  if (action === "reparse-pages" && params.forceOcr === true) config.forceOcr = true;
  if (params.ocrModel) config.ocrModel = params.ocrModel;
  if (params.watermark) config.watermark = params.watermark;
  return config;
}

/** 元数据 patch：只写本动作该写的字段（不碰正文、不递增内容版本号）。 */
function metaPatch(action, params, now) {
  if (action === "describe") {
    const patch = {};
    if (params.summarySource !== undefined) {
      patch.summary = params.summary;
      patch.summarySource = params.summarySource;
    }
    if (params.tags !== undefined) patch.tags = params.tags;
    return patch;
  }
  if (action === "trust") {
    return {
      trust: params.level,
      trustSource: params.level === "unknown" ? "unknown" : "manual",
      trustUpdatedAt: now,
      ...(params.reason ? { trustReason: params.reason } : {}),
    };
  }
  // keep
  return {
    dedupKeep: params.clear !== true,
    dedupNote: params.clear === true ? "" : params.note,
    dedupReviewedAt: now,
  };
}

function safeMessage(error) {
  const text = String(error?.message ?? error);
  // 错误文本给 UI 看：去掉绝对路径前缀，只留文件名，避免泄露本机目录结构。
  return text.replace(/(?:\/[\w.\-\u4e00-\u9fa5]+){2,}/g, (match) => match.split("/").pop() || match);
}

function summarize(action, name, results, snapshot) {
  const ok = results.filter((item) => item.ok).length;
  const failed = results.length - ok;
  return {
    kb: name,
    action,
    dryRun: false,
    total: results.length,
    ok,
    failed,
    results,
    snapshot: snapshot
      ? { name: snapshot.name, bytes: snapshot.bytes ?? 0, docs: snapshot.docs ?? 0 }
      : null,
    hint: QUALITY_ACTION_HINTS[action] ?? "",
  };
}

/**
 * 执行质量动作。
 *
 * @param args {dir, name, plan, reparse, snapshotImpl, onProgress}
 *  - reparse({dir, doc, sourcePath, config})：后台动作的重解析实现（api.js 注入，
 *    默认用工作台同一套 importFileInto，保证与 kb_reparse 一致）；
 *  - snapshotImpl(dir, manifest, {label, includeSources})：显式快照时使用；
 *  - onProgress({done,total,current})：后台 job 进度。
 * @returns {kb, action, dryRun:false, total, ok, failed, results, snapshot, hint}
 */
export async function runQualityAction({ dir, name, plan, reparse, snapshotImpl, onProgress }) {
  const { action, params } = plan;
  const meta = QUALITY_ACTIONS[action] ?? {};
  let snapshot = null;
  if (plan.snapshot === true && typeof snapshotImpl === "function") {
    const manifest = await readManifest(dir);
    snapshot = await snapshotImpl(dir, manifest, {
      label: `pre-quality-${action}`,
      includeSources: false,
    });
    await appendLog(dir, {
      action: "snapshot",
      title: snapshot?.name ?? "",
      detail: `${Math.round((snapshot?.bytes ?? 0) / 1024)} KB（质量动作前）`,
    });
  }

  const results = [];

  // 删除：逐篇 softDeleteDoc（内部自己加清单锁，不能包在外层锁里）。
  if (action === "remove") {
    for (const item of plan.items) {
      try {
        const deleted = await softDeleteDoc(dir, item.id);
        results.push({ id: item.id, ok: true, title: item.title, deletedAt: deleted.deletedAt });
      } catch (error) {
        results.push({ id: item.id, ok: false, title: item.title, error: safeMessage(error) });
      }
    }
    await appendLog(dir, {
      action: "remove",
      title: `${results.filter((item) => item.ok).length}/${results.length} 篇（质量工作台）`,
      detail: "软删除，可在回收站恢复",
    });
    await refreshKbIndex(dir);
    return summarize(action, name, results, snapshot);
  }

  // 元数据：一次清单锁 + 一次原子写，逐项返回。
  if (!meta.background) {
    const now = new Date().toISOString();
    const outcome = new Map();
    await withManifestLock(dir, async () => {
      const fresh = await readManifest(dir);
      const patches = [];
      for (const item of plan.items) {
        const doc = (fresh.docs ?? []).find((entry) => entry.id === item.id);
        if (!doc || doc.status !== "ready" || typeof doc.deletedAt === "string") {
          outcome.set(item.id, { id: item.id, ok: false, title: item.title, error: "文档状态已变化，跳过" });
          continue;
        }
        patches.push({ docId: item.id, patch: metaPatch(action, params, now) });
        outcome.set(item.id, { id: item.id, ok: true, title: doc.title });
      }
      if (patches.length > 0) await updateDocsMetaLocked(dir, fresh, patches);
    });
    for (const item of plan.items) results.push(outcome.get(item.id) ?? { id: item.id, ok: false, title: item.title, error: "未执行" });
    await appendLog(dir, {
      action,
      title: `${results.filter((item) => item.ok).length}/${results.length} 篇（质量工作台）`,
      detail: action === "keep" ? (params.clear ? "取消已核对保留" : (params.note || "标记已核对保留")) : "",
    });
    await refreshKbIndex(dir);
    return summarize(action, name, results, snapshot);
  }

  // 重解析：逐篇顺序执行，单篇失败不影响后续。
  let done = 0;
  for (const item of plan.items) {
    try {
      const fresh = await readManifest(dir);
      const doc = (fresh.docs ?? []).find((entry) => entry.id === item.id);
      if (!doc) throw new Error("文档不存在");
      if (action === "retry-import" && doc.status !== "failed") throw new Error(`状态已变为 ${doc.status}，跳过`);
      if (action === "reparse-pages" && doc.status !== "ready") throw new Error(`状态已变为 ${doc.status}，跳过`);
      const sourcePath = await resolveSourcePath(dir, doc);
      if (!sourcePath) throw new Error("sources/ 中没有原始文件，无法重解析");
      const config = reparseConfig(action, params, doc);
      await reparse({ dir, doc, sourcePath, config });
      results.push({ id: item.id, ok: true, title: doc.title, pages: config.forceOcr ? "全部" : (config.forceOcrPages ?? []) });
    } catch (error) {
      results.push({ id: item.id, ok: false, title: item.title, error: safeMessage(error) });
    } finally {
      done += 1;
      onProgress?.({ done, total: plan.items.length, current: item.title });
    }
  }
  await appendLog(dir, {
    action: "reparse",
    title: `${results.filter((item) => item.ok).length}/${results.length} 篇（质量工作台）`,
    detail: action === "reparse-pages"
      ? (params.forceOcr ? "整篇 OCR 重解析" : `按页重解析 ${(params.pages ?? []).join(",") || "坏页"}`)
      : "重试导入失败",
  });
  await refreshKbIndex(dir);
  return summarize(action, name, results, snapshot);
}
