/**
 * dsh-knowledge-base 存储核心：知识库目录布局、清单(manifest)读写与锁、
 * 文档提交/删除/重命名、合并版重建、导出。
 *
 * 目录布局（kbRoot/<kbName>/）：
 *   kb.json                     清单：名称、文档列表（id/标题/类型/页数/字符数/部分数/大纲/状态）
 *   sources/<docId><ext>        原始文件（逐字节保留）
 *   markdown/<docId>/<docId>.md 合并版（LLM 直接通读）
 *   markdown/<docId>/parts/NNNN.md  分块版（按大纲/页/字数切分，kb_read 精读用）
 *   exports/                    导出产物
 *   import-tmp/                 导入暂存（提交时原子 rename）
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { splitTextChunks } from "./chunks.js";
import { PARSER_VERSION } from "./version.js";
import { frontmatterFor, renderIndex } from "./wiki.js";
import { basename, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// 路径与命名
// ---------------------------------------------------------------------------

/**
 * 展开知识库根目录里的常见写法：
 *  - `~` / `~/x` / `~\x` → 用户目录（Windows 用户常写反斜杠）
 *  - `$HOME` / `${HOME}` / `%USERPROFILE%`（Windows 环境变量习惯）
 * 其余原样返回；相对路径由调用方（apply）用 path.resolve 落成绝对路径。
 */
export function expandRoot(root) {
  let value = String(root ?? "").trim();
  if (value === "") return value;
  const home = homedir();
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  const env = /^(?:\$\{HOME\}|\$HOME|%USERPROFILE%)(?:[\\/]+(.*))?$/i.exec(value);
  if (env) return env[1] ? join(home, env[1]) : home;
  return value;
}

export function sanitizeKbName(name) {
  let n = String(name ?? "").trim();
  if (n.length === 0) throw new Error("知识库名称不能为空");
  n = n.replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  n = n.slice(0, 64).replace(/[. ]+$/, "");
  if (n.length === 0) throw new Error("知识库名称只包含非法字符");
  return n;
}

export function kbDirPath(root, name) {
  return join(expandRoot(root), sanitizeKbName(name));
}

/** 文档 id：源文件相对路径的短哈希（同名文件重复导入 = 原位更新，版本号 +1）。 */
export function docIdFor(relKey) {
  return createHash("sha1")
    .update(String(relKey).replace(/\\/g, "/").normalize("NFC").toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// 清单与锁
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 20_000;
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_OWNER_FILE = "owner.json";
// 进程号可能被复用：只有 owner 记录超过这个时间且 PID 已不存在时才抢锁。
const LOCK_OWNER_STALE_MS = 60_000;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但当前用户无权发信号；ESRCH = 进程不存在
    return error?.code === "EPERM";
  }
}

async function readLockOwner(lockDir) {
  try {
    const raw = JSON.parse(await readFile(join(lockDir, LOCK_OWNER_FILE), "utf8"));
    if (Number.isInteger(raw?.pid) && typeof raw?.startedAt === "string") return raw;
  } catch {
    /* 旧版本锁没有 owner.json */
  }
  return null;
}

/**
 * 串行化对同一知识库清单的修改（锁 = kb 目录下 .lock 子目录，原子 mkdir）。
 * 锁内写 owner.json（PID + 开始时间）：进程崩溃后，下一个操作不用等满
 * 30 分钟 mtime 陈旧期，只要 PID 已消失且锁已存在 60 秒即可回收。
 * @param options { timeoutMs? } 仅用于测试缩短等待；正常调用保持默认 20s。
 */
export async function withManifestLock(dir, fn, options = {}) {
  await mkdir(dir, { recursive: true });
  const lockDir = join(dir, ".lock");
  const started = Date.now();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Math.round(Number(options.timeoutMs)) : LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(
          join(lockDir, LOCK_OWNER_FILE),
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
          "utf8"
        );
      } catch {
        /* owner 写失败时退回 mtime 陈旧判定 */
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readLockOwner(lockDir);
      if (owner !== null) {
        const age = Date.now() - Date.parse(owner.startedAt);
        if (Number.isFinite(age) && age > LOCK_OWNER_STALE_MS && !isPidAlive(owner.pid)) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } else {
        try {
          const s = await stat(lockDir);
          if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
            await rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error("该知识库正被另一个导入任务修改，请稍后重试");
      }
      await sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const SCHEMA_VERSION = 6;
const MIGRATED_FROM = Symbol("migratedFrom");

function normalizeOutline(outline) {
  if (!Array.isArray(outline)) return [];
  return outline.map((item) =>
    typeof item === "string"
      ? { title: item, level: 1, page: null, part: null }
      : {
          ...item,
          title: String(item?.title ?? ""),
          level: Number(item?.level) || 1,
          page: item?.page ?? null,
          part: item?.part ?? null,
        }
  );
}

function inferContentSource(type) {
  switch (type) {
    case "pdf-text":
      return "text-layer";
    case "pdf-scanned":
      return "ocr";
    case "pdf-mixed":
      return "mixed";
    case "docx":
    case "pptx":
    case "epub":
    case "mobi":
      return "converted";
    case "markdown":
    case "text":
      return "text";
    case "note":
      return "note";
    default:
      return "unknown";
  }
}

/** v1 → v2 惰性迁移：只改内存对象，下一次写入时落盘并备份 v1 清单。 */
export function migrateManifest(raw) {
  const from = Number(raw.schemaVersion) || 1;
  // v5：库级简介/标签与合并来源（合并字段 Slice 3 才写入，这里只做归一化）
  raw.description = typeof raw.description === "string" ? raw.description.slice(0, 500) : "";
  raw.tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags
        .map((tag) => String(tag ?? "").trim())
        .filter((tag) => tag.length > 0)
        .map((tag) => tag.slice(0, 32)))]
        .slice(0, 20)
    : [];
  raw.mergedInto = typeof raw.mergedInto === "string" && raw.mergedInto.trim() !== ""
    ? raw.mergedInto.trim()
    : null;
  raw.mergedAt = typeof raw.mergedAt === "string" && raw.mergedAt !== "" ? raw.mergedAt : null;
  raw.docs = (raw.docs ?? []).map((doc) => {
    const next = {
      ...doc,
      outline: normalizeOutline(doc.outline),
      contentSource: doc.contentSource ?? inferContentSource(doc.type),
      edited: doc.edited === true,
      parserVersion: doc.parserVersion ?? "",
      sourceHash: doc.sourceHash ?? "",
      rawTitle: typeof doc.rawTitle === "string" ? doc.rawTitle : (typeof doc.title === "string" ? doc.title : ""),
      canonicalTitle: typeof doc.canonicalTitle === "string" ? doc.canonicalTitle : (typeof doc.title === "string" ? doc.title : ""),
      standardNo: typeof doc.standardNo === "string" ? doc.standardNo : "",
      standardPrefix: typeof doc.standardPrefix === "string" ? doc.standardPrefix : "",
      standardNumber: typeof doc.standardNumber === "string" ? doc.standardNumber : "",
      standardBase: typeof doc.standardBase === "string" ? doc.standardBase : "",
      standardYear: Number.isFinite(doc.standardYear) ? doc.standardYear : null,
      standardPart: doc.standardPart == null || doc.standardPart === "" ? null : String(doc.standardPart),
      standardSource: ["content", "filename", "none"].includes(doc.standardSource) ? doc.standardSource : "none",
      filenameStandardNo: typeof doc.filenameStandardNo === "string" ? doc.filenameStandardNo : "",
      contentTitle: typeof doc.contentTitle === "string" ? doc.contentTitle : "",
      contentIntegrity: ["full", "partial", "cover-only", "unknown"].includes(doc.contentIntegrity)
        ? doc.contentIntegrity
        : "unknown",
      bodyChars: Number.isFinite(doc.bodyChars) ? doc.bodyChars : 0,
      clauseCount: Number.isFinite(doc.clauseCount) ? doc.clauseCount : 0,
      textHash: typeof doc.textHash === "string" ? doc.textHash : "",
      textHashAlgo: typeof doc.textHashAlgo === "string" ? doc.textHashAlgo : "",
      stage: typeof doc.stage === "string" && doc.stage ? doc.stage : "unknown",
      stageLabel: typeof doc.stageLabel === "string" ? doc.stageLabel : "",
      ocrPages: doc.ocrPages ?? 0,
      ocrEngine: doc.ocrEngine ?? "",
      ocrDpi: doc.ocrDpi ?? 0,
      ocrLang: doc.ocrLang ?? "",
      ocrModel: doc.ocrModel ?? "best",
      ocrConfidence: doc.ocrConfidence ?? null,
      lowConfidencePages: Array.isArray(doc.lowConfidencePages) ? doc.lowConfidencePages : [],
      corruptedPages: Array.isArray(doc.corruptedPages) ? doc.corruptedPages : [],
      // v3：编译层元数据（摘要/标签 + 笔记的 kind/sources/反链）
      summary: typeof doc.summary === "string" ? doc.summary : "",
      summarySource: ["model", "auto", "manual"].includes(doc.summarySource)
        ? doc.summarySource
        : "",
      tags: Array.isArray(doc.tags) ? doc.tags.filter((t) => typeof t === "string") : [],
      // v4：来源可信度（high/medium/low/unknown）+ 理由
      trust: ["high", "medium", "low", "unknown"].includes(doc.trust) ? doc.trust : "unknown",
      trustReason: typeof doc.trustReason === "string" ? doc.trustReason : "",
      trustUpdatedAt: typeof doc.trustUpdatedAt === "string" ? doc.trustUpdatedAt : "",
      trustSource: ["manual", "heuristic", "unknown"].includes(doc.trustSource)
        ? doc.trustSource
        : (doc.trust && doc.trust !== "unknown" ? "manual" : "unknown"),
      metadataUpdatedAt: typeof doc.metadataUpdatedAt === "string" ? doc.metadataUpdatedAt : "",
      metaUpdatedAt: typeof doc.metaUpdatedAt === "string" ? doc.metaUpdatedAt : "",
      dedupKeep: doc.dedupKeep === true,
      dedupNote: typeof doc.dedupNote === "string" ? doc.dedupNote : "",
      dedupReviewedAt: typeof doc.dedupReviewedAt === "string" ? doc.dedupReviewedAt : "",
      ...(doc.type === "note"
        ? {
            kind: typeof doc.kind === "string" && doc.kind ? doc.kind : "note",
            sources: Array.isArray(doc.sources) ? doc.sources.filter((s) => typeof s === "string") : [],
            linksOut: Array.isArray(doc.linksOut) ? doc.linksOut.filter((s) => typeof s === "string") : [],
          }
        : {}),
    };
    return next;
  });
  if (from < SCHEMA_VERSION) {
    raw.schemaVersion = SCHEMA_VERSION;
    raw[MIGRATED_FROM] = from;
  } else {
    raw.schemaVersion = SCHEMA_VERSION;
  }
  return raw;
}

export async function writeManifestAtomic(dir, manifest) {
  const from = manifest[MIGRATED_FROM];
  if (Number.isFinite(from) && from < SCHEMA_VERSION) {
    // v1→v2 沿用 kb.json.v1.bak；v2→v3 起按来源版本命名，避免多代迁移互相覆盖
    const backup = join(dir, `kb.json.v${from}.bak`);
    if (!existsSync(backup)) {
      try {
        await copyFile(join(dir, "kb.json"), backup);
      } catch {
        /* 首次写入时原文件可能不存在或是损坏的；备份失败不阻塞升级 */
      }
    }
  }
  manifest.schemaVersion = SCHEMA_VERSION;
  manifest.updatedAt = new Date().toISOString();
  const tmp = join(dir, `.kb.json.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
  await rename(tmp, join(dir, "kb.json"));
}

/** 读取清单；不存在时创建空清单（顺带建目录）。 */
export async function readManifest(dir) {
  const file = join(dir, "kb.json");
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(raw.docs)) raw.docs = [];
    return migrateManifest(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      await mkdir(dir, { recursive: true });
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        name: basename(dir),
        description: "",
        tags: [],
        mergedInto: null,
        mergedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        docs: [],
      };
      await writeManifestAtomic(dir, manifest);
      return manifest;
    }
    throw new Error(`读取知识库清单失败: ${error.message}`);
  }
}

/** 读取清单；目录不存在或清单损坏时返回 null。 */
export async function tryReadManifest(dir) {
  try {
    const raw = JSON.parse(await readFile(join(dir, "kb.json"), "utf8"));
    if (!Array.isArray(raw.docs)) raw.docs = [];
    return migrateManifest(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 文档提交 / 删除
// ---------------------------------------------------------------------------

const IMPORT_ACTIVE_MS = 30 * 60 * 1000;

/**
 * 导入开始：登记 status=importing 的清单条目（版本号在提交时递增）。
 * 若该文档已有 maxAgeMs（默认 30 分钟）内的活跃导入，则不登记并返回 false，
 * 调用方据此跳过，避免重复发起同一文档的导入互相覆盖。
 */
export async function markImporting(dir, entry, maxAgeMs = IMPORT_ACTIVE_MS) {
  let claimed = false;
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    const prev = manifest.docs.find((d) => d.id === entry.id);
    if (prev?.status === "importing") {
      // 心跳独立于 updatedAt：长 OCR 不应该把文档展示时间刷成“刚更新”
      const last = prev.heartbeatAt ?? prev.updatedAt;
      const age = Date.now() - Date.parse(last ?? 0);
      if (Number.isFinite(age) && age < maxAgeMs) return;
    }
    const row = {
      ...(prev ?? {}),
      ...entry,
      importingFrom: prev
        ? {
            status: prev.status ?? null,
            deletedAt: prev.deletedAt ?? null,
            deletedFromStatus: prev.deletedFromStatus ?? null,
            error: prev.error ?? null,
            new: false,
          }
        : { new: true },
      // 导入占位条目保留上一版的内容元数据：历史快照/列表在导入期间
      // 仍能看到旧的字数/部分数/大纲，而不是被 baseEntry 的 0 覆盖。
      title: entry.title ?? prev?.title ?? "",
      type: prev?.type ?? entry.type,
      pages: prev?.pages ?? entry.pages ?? 0,
      chars: prev?.chars ?? entry.chars ?? 0,
      parts: prev?.parts ?? entry.parts ?? 1,
      outline: prev?.outline ?? entry.outline ?? [],
      contentSource: prev?.contentSource ?? entry.contentSource,
      ocrPages: prev?.ocrPages ?? entry.ocrPages ?? 0,
      ocrEngine: prev?.ocrEngine ?? entry.ocrEngine ?? "",
      ocrDpi: prev?.ocrDpi ?? entry.ocrDpi ?? 0,
      ocrLang: prev?.ocrLang ?? entry.ocrLang ?? "",
      ocrModel: prev?.ocrModel ?? entry.ocrModel ?? "best",
      ocrConfidence: prev?.ocrConfidence ?? null,
      lowConfidencePages: prev?.lowConfidencePages ?? [],
      corruptedPages: prev?.corruptedPages ?? [],
      history: prev?.history ?? [],
      status: "importing",
      version: prev?.version ?? 0,
      importedAt: prev?.importedAt ?? new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    delete row.error;
    // 重新导入一篇已软删除的资料时，清单条目回到 importing；必须清掉回收站
    // 标记，否则 isDeleted(row) 仍可能为 true（旧清单只写了 deletedAt），
    // 回收站/自动清理/列表会把正在导入的条目当成已删除。
    delete row.deletedAt;
    delete row.deletedFromStatus;
    if (prev) manifest.docs[manifest.docs.indexOf(prev)] = row;
    else manifest.docs.push(row);
    await writeManifestAtomic(dir, manifest);
    claimed = true;
  });
  return claimed;
}

/** 长任务心跳：只刷新 heartbeatAt，不改变文档的 updatedAt/version。 */
export async function touchImportHeartbeat(dir, docId) {
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    const doc = manifest.docs.find((d) => d.id === docId);
    if (!doc || doc.status !== "importing") return;
    doc.heartbeatAt = new Date().toISOString();
    await writeManifestAtomic(dir, manifest);
  }).catch(() => {});
}

/** 记录失败（解析/OCR 异常）。 */
export async function markFailed(dir, entry) {
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    const prev = manifest.docs.find((d) => d.id === entry.id);
    const row = {
      ...(prev ?? {}),
      ...entry,
      // 失败的是新解析，不应丢掉上一版可读内容的元数据/历史
      title: entry.title ?? prev?.title ?? "",
      type: prev?.type ?? entry.type,
      pages: prev?.pages ?? entry.pages ?? 0,
      chars: prev?.chars ?? entry.chars ?? 0,
      parts: prev?.parts ?? entry.parts ?? 1,
      outline: prev?.outline ?? entry.outline ?? [],
      contentSource: prev?.contentSource ?? entry.contentSource,
      ocrPages: prev?.ocrPages ?? entry.ocrPages ?? 0,
      ocrEngine: prev?.ocrEngine ?? entry.ocrEngine ?? "",
      ocrDpi: prev?.ocrDpi ?? entry.ocrDpi ?? 0,
      ocrLang: prev?.ocrLang ?? entry.ocrLang ?? "",
      ocrModel: prev?.ocrModel ?? entry.ocrModel ?? "best",
      ocrConfidence: prev?.ocrConfidence ?? null,
      lowConfidencePages: prev?.lowConfidencePages ?? [],
      corruptedPages: prev?.corruptedPages ?? [],
      history: prev?.history ?? [],
      status: "failed",
      error: entry.error ? String(entry.error).slice(0, 500) : "导入失败",
      // 导入失败不是内容修订，不递增版本号（成功重试时再 +1）
      version: prev?.version ?? 0,
      importedAt: prev?.importedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    delete row.importingFrom;
    if (prev) manifest.docs[manifest.docs.indexOf(prev)] = row;
    else manifest.docs.push(row);
    await writeManifestAtomic(dir, manifest);
  });
}

/** 导入因重复被跳过：恢复 markImporting 前的条目；新文档占位直接移除。 */
export async function markSkipped(dir, docId) {
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    const idx = manifest.docs.findIndex((d) => d.id === docId);
    if (idx < 0) return;
    const doc = manifest.docs[idx];
    const prev = doc.importingFrom;
    if (!prev || prev.new === true) {
      // 新文档没有历史内容：直接移除占位；已有版本但缺快照时只清标记。
      if ((doc.version ?? 0) === 0) manifest.docs.splice(idx, 1);
      else delete doc.importingFrom;
    } else {
      if (prev.status) doc.status = prev.status;
      else delete doc.status;
      if (prev.deletedAt) doc.deletedAt = prev.deletedAt;
      else delete doc.deletedAt;
      if (prev.deletedFromStatus) doc.deletedFromStatus = prev.deletedFromStatus;
      else delete doc.deletedFromStatus;
      if (prev.error) doc.error = prev.error;
      else delete doc.error;
      delete doc.importingFrom;
    }
    await writeManifestAtomic(dir, manifest);
  });
}

/**
 * 提交一次导入：拷贝原始文件到 sources/，把暂存目录原子改名到 markdown/<docId>/，
 * 然后更新清单条目为 ready。
 */
export async function commitDoc(dir, payload) {
  const {
    docId,
    sourcePath,
    storedSourcePath,
    sourceExt,
    stagedDir,
    title,
    titleSource,
    type,
    pages,
    chars,
    parts,
    outline,
    warnings,
    sourceFile,
    sourceHash,
    rawTitle,
    canonicalTitle,
    standardNo,
    standardPrefix,
    standardNumber,
    standardBase,
    standardYear,
    standardPart,
    standardSource,
    filenameStandardNo,
    contentTitle,
    contentIntegrity,
    bodyChars,
    clauseCount,
    textHash,
    textHashAlgo,
    stage,
    stageLabel,
    trust: incomingTrust,
    trustReason: incomingTrustReason,
    trustSource: incomingTrustSource,
    parserVersion,
    contentSource,
    ocrPages,
    ocrEngine,
    ocrDpi,
    ocrLang,
    ocrModel,
    ocrConfidence,
    lowConfidencePages,
    corruptedPages,
    edited,
    summary,
    summarySource,
    tags,
    kind,
    sources,
    linksOut,
    snapshotReason,
  } = payload;
  const sourceName = docId + (sourceExt || ".bin");
  // 大文件拷贝放在锁外：200MB 扫描件在慢盘上可能超过 20s 锁超时。
  // 先拷到同文件系统的 import-tmp，锁内只做 rename 与清单更新。
  let stagedSource = null;
  try {
    if (sourcePath) {
      await mkdir(join(dir, "sources"), { recursive: true });
      await mkdir(join(dir, "import-tmp"), { recursive: true });
      stagedSource = join(
        dir,
        "import-tmp",
        `source-${docId}-${randomBytes(4).toString("hex")}${sourceExt || ".bin"}`
      );
      await copyFile(sourcePath, stagedSource);
    }
    await withManifestLock(dir, async () => {
      const manifest = await readManifest(dir);
      await mkdir(join(dir, "markdown"), { recursive: true });
      const prev = manifest.docs.find((d) => d.id === docId);
      let history = Array.isArray(prev?.history) ? [...prev.history] : [];
      // 导入开始时 markImporting 已把 prev.status 改成 importing；
      // 只要它已有版本号且不是软删除/首次导入，就说明 markdown 是上一版内容。
      if (prev && Number(prev.version) > 0 && !isDeleted(prev)) {
        try {
          const snap = await snapshotDocVersion(dir, prev, snapshotReason ?? "import");
          if (snap) history.push(snap);
        } catch {
          /* 历史快照失败不阻塞导入 */
        }
      }
      history = await pruneHistory(dir, docId, history);
      if (stagedSource) {
        await mkdir(join(dir, "sources"), { recursive: true });
        // Windows 上 rename 覆盖已存在目标的兼容性不如 POSIX，先删旧文件
        await rm(join(dir, "sources", sourceName), { force: true });
        await rename(stagedSource, join(dir, "sources", sourceName));
      }
      await rm(join(dir, "markdown", docId), { recursive: true, force: true });
      await rename(stagedDir, join(dir, "markdown", docId));
      const keepManualTitle = prev?.titleSource === "manual" && String(prev?.title ?? "").trim() !== "";
      const entry = {
        id: docId,
        title: keepManualTitle ? String(prev.title).slice(0, 200) : String(title ?? "").slice(0, 200),
        titleSource: keepManualTitle ? "manual" : (titleSource ?? prev?.titleSource ?? "auto"),
        sourceFile: sourceFile ?? (sourcePath ? basename(sourcePath) : ""),
        sourcePath: storedSourcePath ?? sourcePath ?? "",
        sourceHash: sourceHash ?? "",
        parserVersion: parserVersion ?? PARSER_VERSION,
        contentSource: contentSource ?? "unknown",
        ocrPages: ocrPages ?? 0,
        ocrEngine: ocrEngine ?? "",
        ocrDpi: ocrDpi ?? 0,
        ocrLang: ocrLang ?? "",
        ocrModel: ocrModel ?? "best",
        ocrConfidence: Number.isFinite(ocrConfidence) ? ocrConfidence : null,
        lowConfidencePages: Array.isArray(lowConfidencePages) ? lowConfidencePages.slice(0, 500) : [],
        corruptedPages: Array.isArray(corruptedPages) ? corruptedPages.slice(0, 500) : [],
        edited: edited === true,
        // 编译层元数据：人工 > 模型 > 自动；重新导入/重解析不降级已有编目。
        ...(() => {
          const rank = { manual: 3, model: 2, auto: 1, "": 0 };
          const prevSource = prev?.summarySource ?? "";
          const nextSource = summarySource ?? "";
          const keepPrev = (rank[prevSource] ?? 0) > (rank[nextSource] ?? 0);
          return {
            summary: keepPrev ? (prev.summary ?? "") : (summary ?? prev?.summary ?? ""),
            summarySource: keepPrev ? prevSource : (nextSource || prevSource),
          };
        })(),
        tags: Array.isArray(tags) && tags.length > 0
          ? tags
          : (Array.isArray(prev?.tags) ? prev.tags : []),
        trust: prev?.trustSource === "manual" ? (prev?.trust ?? "unknown") : (incomingTrust ?? prev?.trust ?? "unknown"),
        trustReason: prev?.trustSource === "manual"
          ? (prev?.trustReason ?? "")
          : (incomingTrustReason ?? prev?.trustReason ?? ""),
        trustUpdatedAt: prev?.trustUpdatedAt ?? "",
        trustSource: prev?.trustSource === "manual"
          ? "manual"
          : (incomingTrustSource ?? prev?.trustSource ?? "unknown"),
        rawTitle: rawTitle ?? prev?.rawTitle ?? title ?? "",
        canonicalTitle: canonicalTitle ?? prev?.canonicalTitle ?? title ?? "",
        standardNo: standardNo ?? prev?.standardNo ?? "",
        standardPrefix: standardPrefix ?? prev?.standardPrefix ?? "",
        standardNumber: standardNumber ?? prev?.standardNumber ?? "",
        standardBase: standardBase ?? prev?.standardBase ?? "",
        standardYear: standardYear ?? prev?.standardYear ?? null,
        standardPart: standardPart ?? prev?.standardPart ?? null,
        standardSource: standardSource ?? prev?.standardSource ?? "none",
        filenameStandardNo: filenameStandardNo ?? prev?.filenameStandardNo ?? "",
        contentTitle: contentTitle ?? prev?.contentTitle ?? "",
        contentIntegrity: contentIntegrity ?? prev?.contentIntegrity ?? "unknown",
        bodyChars: Number.isFinite(bodyChars) ? bodyChars : (prev?.bodyChars ?? 0),
        clauseCount: Number.isFinite(clauseCount) ? clauseCount : (prev?.clauseCount ?? 0),
        textHash: textHash ?? prev?.textHash ?? "",
        textHashAlgo: textHashAlgo ?? prev?.textHashAlgo ?? "",
        stage: stage ?? prev?.stage ?? "unknown",
        stageLabel: stageLabel ?? prev?.stageLabel ?? "",
        metadataUpdatedAt: new Date().toISOString(),
        dedupKeep: prev?.dedupKeep === true,
        dedupNote: prev?.dedupNote ?? "",
        dedupReviewedAt: prev?.dedupReviewedAt ?? "",
        ...(type === "note"
          ? {
              kind: kind ?? prev?.kind ?? "note",
              sources: Array.isArray(sources) ? sources : (Array.isArray(prev?.sources) ? prev.sources : []),
              linksOut: Array.isArray(linksOut) ? linksOut : (Array.isArray(prev?.linksOut) ? prev.linksOut : []),
            }
          : {}),
        type,
        pages: pages ?? 0,
        chars: chars ?? 0,
        parts: parts ?? 1,
        outline: Array.isArray(outline) ? outline.slice(0, 200) : [],
        warnings: Array.isArray(warnings) ? warnings.slice(0, 20) : [],
        status: "ready",
        history,
        version: (prev?.version ?? 0) + 1,
        importedAt: prev?.importedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      delete entry.importingFrom;
      if (prev) manifest.docs[manifest.docs.indexOf(prev)] = entry;
      else manifest.docs.push(entry);
      await writeManifestAtomic(dir, manifest);
    });
  } catch (error) {
    if (stagedSource) await rm(stagedSource, { force: true }).catch(() => {});
    throw error;
  }
}

/** 删除一个文档（markdown 目录 + sources 下对应原文件 + 清单条目）。 */
/** 是否处于软删除状态（兼容只写了 deletedAt 的旧清单）。 */
export function isDeleted(doc) {
  return doc?.status === "deleted" || typeof doc?.deletedAt === "string";
}

/**
 * 软删除：保留 markdown/sources，只改清单状态；可用 restoreDoc 恢复。
 * 允许 ready 与 failed（失败文档也应能在工作台里删掉），导入中/已删除拒绝。
 * 原状态记入 deletedFromStatus，失败原因（error）原样保留，恢复后仍可见。
 */
export async function softDeleteDoc(dir, docId) {
  let deletedAt = null;
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    const idx = manifest.docs.findIndex((d) => d.id === docId);
    if (idx < 0) throw new Error(`文档不存在: ${docId}`);
    const doc = manifest.docs[idx];
    if (isDeleted(doc)) throw new Error(`文档已删除: ${doc.id}`);
    if (doc.status === "importing") throw new Error("文档正在导入，暂不能删除");
    if (doc.status !== "ready" && doc.status !== "failed") {
      throw new Error(`文档状态为 ${doc.status}，暂不能软删除；如确认不要，请用 soft=false 永久删除`);
    }
    deletedAt = new Date().toISOString();
    manifest.docs[idx] = {
      ...doc,
      status: "deleted",
      deletedFromStatus: doc.status,
      deletedAt,
      updatedAt: deletedAt,
    };
    await writeManifestAtomic(dir, manifest);
  });
  return { docId, deletedAt };
}

/**
 * 恢复软删除文档；要求 markdown 内容仍在，恢复后回到删除前的 ready/failed 状态。
 * 跨库移动留下的源库墓碑默认拒绝（目标副本仍可用时恢复会造出两份可用资料）；
 * 调用方确认目标副本已删除/缺失后，可传 clearMovedTo 恢复并清除移动记录。
 */
export async function restoreDoc(dir, docId, { clearMovedTo = false } = {}) {
  try {
    await access(join(dir, "markdown", docId));
  } catch {
    throw new Error(`文档「${docId}」的 markdown 内容已不存在，无法恢复`);
  }
  let restored = null;
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    const idx = manifest.docs.findIndex((d) => d.id === docId);
    if (idx < 0) throw new Error(`文档不存在: ${docId}`);
    const doc = manifest.docs[idx];
    const moved = doc.movedTo && typeof doc.movedTo === "object"
      && typeof doc.movedTo.kb === "string" && doc.movedTo.kb !== "";
    // 目标库副本可用时只能撤销移动；目标副本已删除/缺失时由调用方显式传入
    // clearMovedTo，恢复源文档并解除移动记录，避免永久卡死在回收站。
    if (moved && !clearMovedTo) {
      throw new Error("文档已跨库移动，请使用撤销移动");
    }
    if (!isDeleted(doc)) throw new Error("文档未处于删除状态，无需恢复");
    // 旧清单没有 deletedFromStatus：按 ready 处理（兼容 0.9.0 以来的软删除）。
    const status = doc.deletedFromStatus === "failed" ? "failed" : "ready";
    const next = { ...doc, status, updatedAt: new Date().toISOString() };
    if (clearMovedTo) delete next.movedTo;
    delete next.deletedAt;
    delete next.deletedFromStatus;
    manifest.docs[idx] = next;
    restored = next;
    await writeManifestAtomic(dir, manifest);
  });
  return restored;
}

const HISTORY_LIMIT = 10;

/**
 * 把当前 markdown/<docId> 快照到 history/<docId>/v<version>/，
 * 并在 history/<docId>/v<version>.json 写元数据。
 * 返回清单 history 条目；无内容/已快照过则返回 null。
 */
export async function snapshotDocVersion(dir, doc, reason = "update") {
  const version = Number(doc?.version) || 0;
  if (version <= 0) return null;
  const src = join(dir, "markdown", doc.id);
  const base = join(dir, "history", doc.id);
  const dest = join(base, `v${version}`);
  try {
    await access(src);
  } catch {
    return null;
  }
  try {
    await access(dest);
    return null;
  } catch {
    /* not snapshotted yet */
  }
  await mkdir(base, { recursive: true });
  await cp(src, dest, { recursive: true });
  const savedAt = new Date().toISOString();
  const meta = {
    version,
    savedAt,
    reason,
    title: doc.title ?? "",
    type: doc.type ?? "",
    pages: doc.pages ?? 0,
    chars: doc.chars ?? 0,
    parts: doc.parts ?? 1,
    outline: Array.isArray(doc.outline) ? doc.outline.slice(0, 200) : [],
    contentSource: doc.contentSource ?? "",
  };
  await writeFile(join(base, `v${version}.json`), JSON.stringify(meta, null, 2), "utf8");
  return { version, savedAt, reason, chars: meta.chars, parts: meta.parts };
}

/** 只保留最近 HISTORY_LIMIT 个历史版本，清理旧目录与元数据。 */
export async function pruneHistory(dir, docId, entries) {
  const keep = [...(entries ?? [])]
    .sort((a, b) => Number(a.version) - Number(b.version))
    .slice(-HISTORY_LIMIT);
  const keepVersions = new Set(keep.map((e) => String(e.version)));
  const base = join(dir, "history", docId);
  let names = [];
  try {
    names = await readdir(base);
  } catch {
    return keep;
  }
  for (const name of names) {
    const match = /^v(\d+)(?:\.json)?$/.exec(name);
    if (match && !keepVersions.has(match[1])) {
      await rm(join(base, name), { recursive: true, force: true });
    }
  }
  return keep;
}

/** 恢复某个历史版本；恢复前会把当前版本再快照一次（可反悔）。 */
export async function restoreDocVersion(dir, docId, version, { clearMovedTo = false } = {}) {
  const base = join(dir, "history", docId);
  const snapshot = join(base, `v${version}`);
  const metaPath = join(base, `v${version}.json`);
  try {
    await access(snapshot);
  } catch {
    throw new Error(`历史版本不存在: v${version}`);
  }
  let meta = {};
  try {
    meta = JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    meta = {};
  }
  await mkdir(join(dir, "import-tmp"), { recursive: true });
  let restored = null;
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    const idx = manifest.docs.findIndex((d) => d.id === docId);
    if (idx < 0) throw new Error(`文档不存在: ${docId}`);
    const doc = manifest.docs[idx];
    const moved = doc.movedTo && typeof doc.movedTo === "object"
      && typeof doc.movedTo.kb === "string" && doc.movedTo.kb !== "";
    // 与 restoreDoc 同一条不变量：移动墓碑只有调用方确认目标副本不可用并显式
    // clearMovedTo 时才允许恢复，否则历史版本恢复同样会复活源库副本。
    if (moved && !clearMovedTo) {
      throw new Error("文档已跨库移动，请使用撤销移动");
    }
    let history = Array.isArray(doc.history) ? [...doc.history] : [];
    const before = await snapshotDocVersion(dir, doc, "pre-restore");
    if (before) history.push(before);
    const staging = join(
      dir,
      "import-tmp",
      `restore-${docId}-${randomBytes(4).toString("hex")}`
    );
    await cp(snapshot, staging, { recursive: true });
    await rm(join(dir, "markdown", docId), { recursive: true, force: true });
    await rename(staging, join(dir, "markdown", docId));
    const now = new Date().toISOString();
    const next = {
      ...doc,
      status: "ready",
      title: meta.title ?? doc.title,
      type: meta.type ?? doc.type,
      pages: meta.pages ?? doc.pages,
      chars: meta.chars ?? doc.chars,
      parts: meta.parts ?? doc.parts,
      outline: Array.isArray(meta.outline) ? meta.outline : doc.outline,
      contentSource: meta.contentSource ?? doc.contentSource,
      edited: true,
      restoredFrom: Number(version),
      updatedAt: now,
      version: (doc.version ?? 0) + 1,
      history: await pruneHistory(dir, docId, history),
    };
    if (clearMovedTo) delete next.movedTo;
    delete next.deletedAt;
    manifest.docs[idx] = next;
    restored = next;
    await writeManifestAtomic(dir, manifest);
  });
  return restored;
}

/** 彻底删除前复验失败：文档已不在回收站（或在导入中）。响应层只回固定文案。 */
export const TRASH_REVALIDATION_MESSAGE = "文档不在回收站，拒绝彻底删除";

/**
 * 从清单与磁盘彻底删除一个文档。
 * `requireDeleted: true` 用于回收站清理/批量彻底删除：在清单锁内重新读取条目，
 * 若已被恢复（或重新进入导入中）则拒绝删除，避免预检后到删除前被恢复的资料
 * 仍被永久删除。kb_remove(soft=false) 仍用默认值，允许直接删在用资料。
 */
export async function removeDoc(dir, docId, { requireDeleted = false } = {}) {
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    const idx = manifest.docs.findIndex((d) => d.id === docId);
    if (idx < 0) throw new Error(`文档不存在: ${docId}`);
    const doc = manifest.docs[idx];
    if (requireDeleted && (!isDeleted(doc) || doc.status === "importing")) {
      throw new Error(TRASH_REVALIDATION_MESSAGE);
    }
    manifest.docs.splice(idx, 1);
    await writeManifestAtomic(dir, manifest);
  });
  await rm(join(dir, "markdown", docId), { recursive: true, force: true });
  await rm(join(dir, "history", docId), { recursive: true, force: true });
  try {
    for (const f of await readdir(join(dir, "sources"))) {
      if (f.startsWith(docId)) await rm(join(dir, "sources", f), { force: true });
    }
  } catch {
    /* sources 目录可能不存在 */
  }
}

/** 删除整个知识库。 */
export async function removeKbDir(root, name) {
  const dir = kbDirPath(root, name);
  if (!existsSync(join(dir, "kb.json"))) {
    throw new Error(`知识库不存在: ${name}`);
  }
  await rm(dir, { recursive: true, force: true });
}

/** 更新文档元数据（chars/parts 等）并递增版本号（kb_edit 用）。 */
export async function touchDoc(dir, docId, patch) {
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    await touchDocLocked(dir, manifest, docId, patch);
  });
}

/**
 * 在已持有清单锁时更新文档元数据（kb_edit 的原子修订在锁内完成，
 * 使用本函数避免 withManifestLock 嵌套加锁导致的死锁）。
 */
export async function touchDocLocked(dir, manifest, docId, patch) {
  const doc = manifest.docs.find((d) => d.id === docId);
  if (!doc) throw new Error(`文档不存在: ${docId}`);
  Object.assign(doc, patch, {
    updatedAt: new Date().toISOString(),
    version: (doc.version ?? 0) + 1,
  });
  await writeManifestAtomic(dir, manifest);
}

/**
 * 在已持锁时一次提交多个文档的元数据（批量事务编辑用）：
 * 所有正文写成功后才更新清单，避免中途失败留下“版本号已涨、内容没改”的中间态。
 * @param patches [{ docId, patch }]
 */
export async function touchDocsLocked(dir, manifest, patches) {
  const now = new Date().toISOString();
  const versions = new Map();
  for (const { docId, patch } of patches ?? []) {
    const doc = manifest.docs.find((d) => d.id === docId);
    if (!doc) throw new Error(`文档不存在: ${docId}`);
    Object.assign(doc, patch, { updatedAt: now, version: (doc.version ?? 0) + 1 });
    versions.set(docId, doc.version);
  }
  await writeManifestAtomic(dir, manifest);
  return versions;
}

/**
 * 只更新元数据（摘要/标签/来源），不动正文、不递增内容版本号。
 * 用于 kb_describe：编目不应该让文档在“最近更新”排序里跳到最前。
 */
export async function updateDocMetaLocked(dir, manifest, docId, patch) {
  const doc = manifest.docs.find((d) => d.id === docId);
  if (!doc) throw new Error(`文档不存在: ${docId}`);
  Object.assign(doc, patch, { metaUpdatedAt: new Date().toISOString() });
  await writeManifestAtomic(dir, manifest);
}

/**
 * 批量更新元数据（不递增内容版本号）：存量摘要回填用。
 * 一次写清单，避免 1000+ 篇文档逐篇重写 kb.json。
 * @param patches [{ docId, patch }]
 */
export async function updateDocsMetaLocked(dir, manifest, patches) {
  const now = new Date().toISOString();
  let updated = 0;
  for (const { docId, patch } of patches ?? []) {
    const doc = manifest.docs.find((d) => d.id === docId);
    if (!doc) continue;
    Object.assign(doc, patch, { metaUpdatedAt: now });
    updated += 1;
  }
  await writeManifestAtomic(dir, manifest);
  return updated;
}

/**
 * 重命名知识库（目录名 + 清单 name）。
 * 注意：.scopes.json 的库名同步由调用方负责（工具与 HTTP 两个入口都会调用 renameScopeKb）。
 */
export async function renameKb(root, name, newName) {
  const clean = sanitizeKbName(newName);
  const dir = kbDirPath(root, name);
  const target = kbDirPath(root, clean);
  if (!existsSync(join(dir, "kb.json"))) {
    throw new Error(`知识库不存在: ${name}`);
  }
  if (existsSync(target)) throw new Error(`目标名称已存在: ${clean}`);
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    manifest.name = clean;
    await writeManifestAtomic(dir, manifest);
  });
  await rename(dir, target);
  return target;
}

// ---------------------------------------------------------------------------
// 文档寻址 / 分块 / 合并版
// ---------------------------------------------------------------------------

export function resolveDoc(manifest, ref, { includeDeleted = false } = {}) {
  if (ref === undefined || ref === null) throw new Error("请提供文档名称或 id");
  const s = String(ref).trim();
  if (s.length === 0) throw new Error("请提供文档名称或 id");
  const allDocs = manifest.docs ?? [];
  const docs = includeDeleted ? allDocs : allDocs.filter((d) => !isDeleted(d));
  const byId = docs.filter((d) => d.id === s);
  if (byId.length === 1) return byId[0];
  const byPrefix = docs.filter((d) => d.id.startsWith(s));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) {
    throw new Error(
      `id 前缀 "${s}" 匹配多个文档: ${byPrefix.slice(0, 6).map((d) => `${d.id}(${d.title})`).join(", ")}`
    );
  }
  const lower = s.toLowerCase();
  const byExactTitle = docs.filter((d) => String(d.title ?? "").toLowerCase() === lower);
  if (byExactTitle.length === 1) return byExactTitle[0];
  const byTitle = docs.filter((d) => String(d.title ?? "").toLowerCase().includes(lower));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    throw new Error(
      `"${s}" 匹配多个文档，请用更精确的名称或 id: ${byTitle.slice(0, 6).map((d) => `${d.id}(${d.title})`).join(", ")}`
    );
  }
  const deleted = allDocs.filter(
    (d) =>
      isDeleted(d) &&
      (d.id === s ||
        d.id.startsWith(s) ||
        String(d.title ?? "").toLowerCase().includes(lower))
  );
  if (!includeDeleted && deleted.length > 0) {
    throw new Error(
      `"${s}" 已软删除（${deleted.slice(0, 3).map((d) => `${d.id}(${d.title})`).join(", ")}）；可用 kb_restore 恢复`
    );
  }
  throw new Error(`知识库中没有找到 "${s}"（用 kb_list 查看文档列表）`);
}

const PART_FILE = /^(\d{4})\.md$/;

export function partFileName(index) {
  return String(index + 1).padStart(4, "0") + ".md";
}

/** 把段落列表组装成分块文件，写入 staged 目录，返回分块数与总字符数。 */
export async function writeParts(stagedDir, sections, options) {
  const { partMaxChars, docTitle, pageOf } = options ?? {};
  const cap = Number.isFinite(partMaxChars) && partMaxChars > 0 ? partMaxChars : 8000;
  await mkdir(join(stagedDir, "parts"), { recursive: true });
  const parts = []; // [{lines: [], chars, minPage, maxPage}]
  const outline = [];
  let cur = { lines: [], chars: 0, minPage: Infinity, maxPage: -Infinity };
  const flush = () => {
    if (cur.lines.length > 0) parts.push(cur);
    cur = { lines: [], chars: 0, minPage: Infinity, maxPage: -Infinity };
  };
  for (const section of sections) {
    const block = renderSection(section);
    const blockChars = block.length;
    const page = section.page ?? 0;
    const startsNew = block.startsWith("## ") || block.startsWith("### ") || block.startsWith("#### ");
    if (cur.chars > 0 && cur.chars + blockChars > cap && startsNew) flush();
    if (section.heading) {
      outline.push({
        title: section.heading,
        level: Number(section.level) || 1,
        page: page > 0 ? page : null,
        part: parts.length + 1,
      });
    }
    if (cur.lines.length === 0) {
      cur.minPage = page > 0 ? page : cur.minPage;
    }
    cur.lines.push(block);
    cur.chars += blockChars;
    if (page > 0) {
      cur.minPage = Math.min(cur.minPage, page);
      cur.maxPage = Math.max(cur.maxPage, page);
    }
  }
  flush();
  if (parts.length === 0) parts.push(cur);
  let totalChars = 0;
  const partIndex = [];
  // 合并版以 "# 标题\n\n" 开头：分块 1 的注释行在第 3 行。
  let mergedLine = 3;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    totalChars += p.chars;
    const pageRange =
      p.minPage !== Infinity && p.maxPage >= p.minPage
        ? p.minPage === p.maxPage
          ? `第 ${p.minPage} 页`
          : `第 ${p.minPage}–${p.maxPage} 页`
        : "";
    const header = [
      `<!-- doc: ${docTitle ?? ""} | 部分 ${i + 1}/${parts.length}${pageRange ? ` | ${pageRange}` : ""} -->`,
      "",
    ].join("\n");
    const text = header + p.lines.join("\n\n");
    await writeFile(join(stagedDir, "parts", partFileName(i)), text + "\n", "utf8");
    const lineCount = text.trimEnd().split("\n").length;
    const pageStart = p.minPage !== Infinity ? p.minPage : null;
    const pageEnd = p.minPage !== Infinity && p.maxPage >= p.minPage ? p.maxPage : null;
    partIndex.push({
      part: i + 1,
      startLine: mergedLine,
      endLine: mergedLine + lineCount - 1,
      pageStart,
      pageEnd,
    });
    mergedLine = mergedLine + lineCount + 1;
  }
  await writeFile(join(stagedDir, "parts", "index.json"), JSON.stringify(partIndex, null, 2), "utf8");
  return { parts: parts.length, chars: totalChars, outline, partIndex };
}

function renderSection(section) {
  const { heading, level, text } = section;
  const body = String(text ?? "").trim();
  if (!heading) return body;
  const h = String(heading).replace(/[#\n]/g, " ").trim();
  const depth = Math.min(Math.max((level ?? 1) + 1, 2), 4);
  return `${"#".repeat(depth)} ${h}\n\n${body}`;
}

/** 由分块重建合并版 markdown/<docId>/<docId>.md。 */
export async function rebuildMerged(dir, doc) {
  const docDir = join(dir, "markdown", doc.id);
  const partsDir = join(docDir, "parts");
  const files = (await readdir(partsDir)).filter((f) => PART_FILE.test(f)).sort();
  let oldIndex = [];
  try {
    oldIndex = JSON.parse(await readFile(join(partsDir, "index.json"), "utf8"));
  } catch {
    /* 0.4.0 之前的文档没有 index.json */
  }
  const pagesByPart = new Map(
    (Array.isArray(oldIndex) ? oldIndex : []).map((entry) => [entry.part, entry])
  );
  let merged = `# ${doc.title}\n\n`;
  let mergedLine = 3;
  const nextIndex = [];
  for (let i = 0; i < files.length; i++) {
    const text = (await readFile(join(partsDir, files[i]), "utf8")).trimEnd();
    const lineCount = text.split("\n").length;
    const old = pagesByPart.get(i + 1);
    nextIndex.push({
      part: i + 1,
      startLine: mergedLine,
      endLine: mergedLine + lineCount - 1,
      pageStart: old?.pageStart ?? null,
      pageEnd: old?.pageEnd ?? null,
    });
    merged += text + "\n\n";
    mergedLine = mergedLine + lineCount + 1;
  }
  await writeFile(join(partsDir, "index.json"), JSON.stringify(nextIndex, null, 2), "utf8");
  const out = merged.trimEnd() + "\n";
  await writeFile(join(docDir, `${doc.id}.md`), out, "utf8");
  return out;
}

/** 读取逐页质量 sidecar（0.5.0 之前的文档返回空数组）。 */
export async function readPageQuality(dir, doc) {
  try {
    const raw = JSON.parse(await readFile(join(dir, "markdown", doc.id, "pages.json"), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** 读取分块索引（0.4.0 之前的文档返回空数组）。 */
export async function readPartIndex(dir, doc) {
  try {
    const raw = JSON.parse(await readFile(join(dir, "markdown", doc.id, "parts", "index.json"), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** 读取一个分块（0-based index）。 */
export async function readPart(dir, doc, index) {
  const file = join(dir, "markdown", doc.id, "parts", partFileName(index));
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`分块不存在: 部分 ${index + 1}/${doc.parts}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

export async function listKbs(root) {
  const r = expandRoot(root);
  await mkdir(r, { recursive: true }).catch(() => {});
  const entries = await readdir(r, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const manifest = await tryReadManifest(join(r, e.name));
    if (!manifest) continue;
    const docs = manifest.docs ?? [];
    let hasSchema = false;
    try {
      await access(join(r, e.name, "schema.md"));
      hasSchema = true;
    } catch {
      /* 旧库可能还没有 schema.md */
    }
    out.push({
      name: manifest.name || e.name,
      dir: e.name,
      description: manifest.description ?? "",
      tags: Array.isArray(manifest.tags) ? manifest.tags : [],
      mergedInto: manifest.mergedInto ?? null,
      mergedAt: manifest.mergedAt ?? null,
      createdAt: manifest.createdAt ?? null,
      updatedAt: manifest.updatedAt ?? null,
      docs: docs.length,
      ready: docs.filter((d) => d.status === "ready").length,
      importing: docs.filter((d) => d.status === "importing").length,
      failed: docs.filter((d) => d.status === "failed").length,
      deleted: docs.filter((d) => isDeleted(d)).length,
      notes: docs.filter((d) => d.type === "note" && d.status === "ready").length,
      hasSchema,
      chars: docs.reduce((sum, d) => sum + (d.chars ?? 0), 0),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return out;
}

export function docSize(dir, doc) {
  return {
    id: doc.id,
    title: doc.title,
    type: doc.type,
    status: doc.status,
    pages: doc.pages,
    chars: doc.chars,
    parts: doc.parts,
    version: doc.version,
    updatedAt: doc.updatedAt,
    deleted: isDeleted(doc),
    deletedAt: doc.deletedAt ?? null,
    historyCount: Array.isArray(doc.history) ? doc.history.length : 0,
    history: Array.isArray(doc.history) ? doc.history.slice(-5) : [],
    contentSource: doc.contentSource ?? "",
    stale:
      doc.status === "ready" &&
      doc.type !== "note" &&
      (doc.parserVersion ?? "") !== PARSER_VERSION,
    edited: doc.edited === true,
    hash: doc.sourceHash ? String(doc.sourceHash).slice(0, 12) : "",
    summary: doc.summary ?? "",
    summarySource: doc.summarySource ?? "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    trust: doc.trust ?? "unknown",
    trustReason: doc.trustReason ?? "",
    trustUpdatedAt: doc.trustUpdatedAt ?? "",
    trustSource: doc.trustSource ?? "unknown",
    standardNo: doc.standardNo ?? "",
    standardYear: Number.isFinite(doc.standardYear) ? doc.standardYear : null,
    standardPart: doc.standardPart ?? null,
    standardSource: doc.standardSource ?? "none",
    stage: doc.stage ?? "unknown",
    contentIntegrity: doc.contentIntegrity ?? "unknown",
    dedupKeep: doc.dedupKeep === true,
    dedupNote: doc.dedupNote ?? "",
    dedupReviewedAt: doc.dedupReviewedAt ?? "",
    kind: doc.kind ?? (doc.type === "note" ? "note" : ""),
    sources: Array.isArray(doc.sources) ? doc.sources.slice(0, 50) : [],
    linksOut: Array.isArray(doc.linksOut) ? doc.linksOut.slice(0, 50) : [],
    hasSummary: Boolean(String(doc.summary ?? "").trim()),
    ocrModel: doc.ocrModel ?? "best",
    ocrConfidence: doc.ocrConfidence ?? null,
    lowConfidencePages: Array.isArray(doc.lowConfidencePages) ? doc.lowConfidencePages.slice(0, 20) : [],
    lowConfidenceCount: Array.isArray(doc.lowConfidencePages) ? doc.lowConfidencePages.length : 0,
    corruptedPages: Array.isArray(doc.corruptedPages) ? doc.corruptedPages.slice(0, 20) : [],
    corruptedCount: Array.isArray(doc.corruptedPages) ? doc.corruptedPages.length : 0,
    ...(doc.error ? { error: doc.error } : {}),
    outline: (doc.outline ?? []).slice(0, 12),
  };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

const EXPORT_README = `# 知识库导出包说明

本目录是一个 dsh-knowledge-base 知识库的完整快照，可直接供其他大模型应用阅读：

- kb.json          —— 清单：文档列表、类型、页数、大纲、版本、摘要/标签
- index.md         —— 内容索引：编译页（笔记）在前，原始资料在后，每条一行摘要
- schema.md        —— 该知识库的维护规范（ingest/query/lint 流程，可修改）
- log.md           —— 操作流水（只追加）
- markdown/        —— 每个文档一个目录：
    <docId>/<docId>.md     合并版（整篇通读用）
    <docId>/parts/NNNN.md  分块版（按大纲/页码/字数切分，检索与 RAG 用）
- sources/         —— 原始文件（Word/PPT/PDF/文本，逐字节保留；导出时可省略）

把分块文件喂给其他大模型/RAG 管道即可；也可以直接上传合并版 markdown 给对话型产品。
`;

export async function exportMarkdown(dir, manifest, outPath) {
  const { createWriteStream } = await import("node:fs");
  const { finished } = await import("node:stream/promises");
  const docs = (manifest.docs ?? []).filter((d) => d.status === "ready");
  // 流式写入：大知识库不再在内存里拼整份文件
  const stream = createWriteStream(outPath, "utf8");
  let bytes = 0;
  const write = (chunk) => {
    bytes += Buffer.byteLength(chunk, "utf8");
    stream.write(chunk);
  };
  const done = finished(stream);
  write(`# 知识库「${manifest.name}」导出\n\n`);
  write(`> 导出时间: ${new Date().toISOString()}　文档数: ${docs.length}\n\n`);
  write(`## 目录\n\n`);
  write(
    docs
      .map((d, i) => {
        const summary = String(d.summary ?? "").replace(/\s+/g, " ").trim();
        const short = summary.length > 100 ? summary.slice(0, 99) + "…" : summary;
        return `${i + 1}. ${d.title}（${d.type}，${d.pages ? d.pages + " 页，" : ""}${d.chars} 字）${short ? ` — ${short}` : ""}`;
      })
      .join("\n")
  );
  write(`\n\n---\n\n`);
  for (const d of docs) {
    const merged = join(dir, "markdown", d.id, `${d.id}.md`);
    let body;
    try {
      body = await readFile(merged, "utf8");
    } catch {
      body = `# ${d.title}\n\n（该文档内容缺失）`;
    }
    // 笔记导出时补 YAML frontmatter（Obsidian/Dataview 可直接识别）；正文保持纯净
    const frontmatter = frontmatterFor(d);
    write(`\n<!-- 文档: ${d.id} 类型: ${d.type} 来源: ${d.sourceFile || "-"} 版本: v${d.version} 导入: ${d.updatedAt} -->\n\n`);
    if (frontmatter) write(frontmatter);
    write(body.trimEnd() + "\n\n---\n\n");
  }
  stream.end();
  await done;
  return { bytes, docs: docs.length };
}

export async function exportJsonl(dir, manifest, outPath, options = {}) {
  const { createWriteStream } = await import("node:fs");
  const { finished } = await import("node:stream/promises");
  const docs = (manifest.docs ?? []).filter((d) => d.status === "ready");
  const chunkSize = Math.max(0, Math.floor(Number(options.chunkSize) || 0));
  const chunkOverlap = Math.max(0, Math.floor(Number(options.chunkOverlap) || 0));
  const stream = createWriteStream(outPath, "utf8");
  let bytes = 0;
  let chunks = 0;
  const writeLine = (obj) => {
    const line = JSON.stringify(obj) + "\n";
    bytes += Buffer.byteLength(line, "utf8");
    stream.write(line);
  };
  const done = finished(stream);
  for (const d of docs) {
    const partsDir = join(dir, "markdown", d.id, "parts");
    let files = [];
    try {
      files = (await readdir(partsDir)).filter((f) => PART_FILE.test(f)).sort();
    } catch {
      /* no parts */
    }
    if (files.length === 0) {
      if (chunkSize > 0) {
        writeLine({
          kb: manifest.name,
          docId: d.id,
          title: d.title,
          type: d.type,
          part: 1,
          parts: 1,
          chunk: 1,
          chunks: 1,
          chars: 0,
          text: "",
        });
        chunks += 1;
      } else {
        writeLine({
          kb: manifest.name,
          docId: d.id,
          title: d.title,
          type: d.type,
          part: 1,
          parts: 1,
          text: "",
        });
      }
      continue;
    }
    const partIndex = chunkSize > 0 ? await readPartIndex(dir, d) : [];
    for (let i = 0; i < files.length; i++) {
      const text = (await readFile(join(partsDir, files[i]), "utf8")).trim();
      if (chunkSize > 0) {
        const clean = text.replace(/^<!--\s*doc:[^\n]*-->\s*\n?/, "").trim();
        const list = splitTextChunks(clean, { maxChars: chunkSize, overlap: chunkOverlap });
        const pieces = list.length > 0 ? list : [""];
        const entry = partIndex.find((item) => item.part === i + 1);
        for (let c = 0; c < pieces.length; c++) {
          const line = {
            kb: manifest.name,
            docId: d.id,
            title: d.title,
            type: d.type,
            part: i + 1,
            parts: files.length,
            chunk: c + 1,
            chunks: pieces.length,
            chars: pieces[c].length,
            text: pieces[c],
          };
          if (Number.isInteger(entry?.pageStart)) line.pageStart = entry.pageStart;
          if (Number.isInteger(entry?.pageEnd)) line.pageEnd = entry.pageEnd;
          if (d.contentSource) line.contentSource = d.contentSource;
          if (d.summary) line.summary = d.summary;
          if (Array.isArray(d.tags) && d.tags.length > 0) line.tags = d.tags;
          if (d.kind) line.kind = d.kind;
          if (d.trust && d.trust !== "unknown") line.trust = d.trust;
          writeLine(line);
          chunks += 1;
        }
        continue;
      }
      writeLine({
        kb: manifest.name,
        docId: d.id,
        title: d.title,
        type: d.type,
        part: i + 1,
        parts: files.length,
        text,
        ...(d.summary ? { summary: d.summary } : {}),
        ...(Array.isArray(d.tags) && d.tags.length > 0 ? { tags: d.tags } : {}),
        ...(d.kind ? { kind: d.kind } : {}),
        ...(d.trust && d.trust !== "unknown" ? { trust: d.trust } : {}),
      });
    }
  }
  stream.end();
  await done;
  return { bytes, docs: docs.length, chunks };
}

/**
 * 打包为 zip（成员: kb.json / README.md / markdown/ 必含，sources/ 可选）。
 * 用内置 JSZip 纯 JS 打包：不依赖系统 zip/tar（Windows 无 zip 命令）。
 * 已压缩的二进制（pdf/png/jpg 等）以 STORE 原样入包，文本用 DEFLATE。
 */
export async function exportZip(dir, manifest, outPath, includeSources) {
  const { default: JSZip } = await import("jszip");
  const { createReadStream } = await import("node:fs");
  const zip = new JSZip();
  const STORE = /\.(pdf|png|jpe?g|gif|webp|zip|gz|7z|docx?|pptx?|xlsx?)$/i;
  const deletedIds = new Set(
    (manifest.docs ?? []).filter((d) => isDeleted(d)).map((d) => d.id)
  );

  const addDir = async (zipDir, absDir, depth = 0) => {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const e of entries) {
      // markdown/<docId> 与 sources/<docId>.* 里软删除文档不进入导出包
      if (depth === 1) {
        if (e.isDirectory() && deletedIds.has(e.name)) continue;
        if (!e.isDirectory() && [...deletedIds].some((id) => e.name.startsWith(id))) continue;
      }
      const full = join(absDir, e.name);
      if (e.isDirectory()) {
        await addDir(zipDir.folder(e.name), full, depth + 1);
      } else {
        // Node 流直接喂给 JSZip（streamFiles 生成时惰性读取），避免整文件载入内存
        zipDir.file(e.name, createReadStream(full), {
          compression: STORE.test(e.name) ? "STORE" : "DEFLATE",
        });
      }
    }
  };

  // README 只作为 zip 成员，不写入用户知识库目录。
  // kb.json 里的 sourcePath 是本机绝对路径，导出给其他模型/用户前必须剥离。
  const exportedManifest = {
    ...manifest,
    // 只导出 ready 文档：失败条目的 error 可能带本机路径，且没有可读内容。
    docs: (manifest.docs ?? [])
      .filter((doc) => doc.status === "ready")
      .map((doc) => {
        const { sourcePath, ...rest } = doc;
        return rest;
      }),
  };
  zip.file("kb.json", JSON.stringify(exportedManifest, null, 2), { compression: "DEFLATE" });
  zip.file("README.md", EXPORT_README, { compression: "DEFLATE" });
  // 编译层视图：索引（由清单渲染，保证与导出内容一致）+ 维护规范 + 操作日志
  zip.file("index.md", renderIndex(exportedManifest), { compression: "DEFLATE" });
  for (const name of ["schema.md", "log.md"]) {
    try {
      zip.file(name, await readFile(join(dir, name), "utf8"), { compression: "DEFLATE" });
    } catch {
      /* 旧库可能还没有这两个文件 */
    }
  }
  await addDir(zip.folder("markdown"), join(dir, "markdown"), 1);
  if (includeSources) await addDir(zip.folder("sources"), join(dir, "sources"), 1);

  // 流式写盘：generateNodeStream 边压缩边写，避免把整个包（含 sources）读进内存。
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  try {
    await pipeline(
      zip.generateNodeStream({ streamFiles: true, compression: "DEFLATE" }),
      createWriteStream(outPath)
    );
  } catch (error) {
    await rm(outPath, { force: true }).catch(() => {});
    throw error;
  }
  const { size } = await stat(outPath);
  return { bytes: size, docs: exportedManifest.docs.length, format: "zip" };
}

// ---------------------------------------------------------------------------
// 导入暂存目录清理
// ---------------------------------------------------------------------------

/** 清理 kb 目录下遗留的 import-tmp（崩溃残留）。 */
export async function sweepStaging(dir) {
  const tmp = join(dir, "import-tmp");
  try {
    const entries = await readdir(tmp, { withFileTypes: true });
    for (const e of entries) {
      // ui-batches 的批次生命周期（含失败待重试批次）由 lib/web/upload.js 的
      // sweepOldBatches 按 batch.json 状态判定，这里按目录 mtime 一刀切会误删。
      if (e.name === "ui-batches") {
        // 批次目录本身由 sweepOldBatches 管；这里只清上传中断留下的孤儿 .part。
        const batchesRoot = join(tmp, e.name);
        try {
          for (const batch of await readdir(batchesRoot, { withFileTypes: true })) {
            if (!batch.isDirectory()) continue;
            const batchDir = join(batchesRoot, batch.name);
            for (const name of await readdir(batchDir)) {
              if (!/^\.upload-[0-9a-f]+\.part$/.test(name)) continue;
              const file = join(batchDir, name);
              const info = await stat(file);
              if (Date.now() - info.mtimeMs > 24 * 3600 * 1000) await rm(file, { force: true });
            }
          }
        } catch {
          /* 批次目录读不到就算了 */
        }
        continue;
      }
      const full = join(tmp, e.name);
      try {
        const s = await stat(full);
        if (Date.now() - s.mtimeMs <= 24 * 3600 * 1000) continue;
        if (e.isDirectory()) await rm(full, { recursive: true, force: true });
        else if (e.isFile()) await rm(full, { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* no tmp dir */
  }
}

/** kb_query 结果展示用：绝对路径 → kb 内相对路径。 */
export function displayPath(kbDir, abs) {
  const rel = relative(kbDir, abs);
  return rel || basename(abs);
}

// ---------------------------------------------------------------------------
// 库级快照：把清单 + schema/index/log + 派生 markdown（可选 sources）打成 zip
// ---------------------------------------------------------------------------

function snapshotLabel(input) {
  return String(input ?? "")
    .normalize("NFC")
    .replace(/[^\w\u4e00-\u9fa5.\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * 创建库级快照（不包含历史快照目录，避免体积翻倍；sources 默认不包含）。
 * @returns { name, path, bytes, docs, includeSources }
 */
export async function snapshotKb(dir, manifest, options = {}) {
  const { default: JSZip } = await import("jszip");
  const { createReadStream } = await import("node:fs");
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const snapshotsDir = join(dir, "snapshots");
  await mkdir(snapshotsDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const ts = createdAt.replace(/[:T]/g, "-").slice(0, 19);
  const label = snapshotLabel(options.label);
  const name = `${ts}${label ? `-${label}` : ""}.zip`;
  const outPath = join(snapshotsDir, name);
  const includeSources = options.includeSources === true;
  const docs = (manifest.docs ?? []).filter((d) => d.status === "ready" && !d.deletedAt);
  const meta = {
    createdAt,
    label,
    kb: manifest.name,
    schemaVersion: manifest.schemaVersion,
    docs: docs.length,
    notes: docs.filter((d) => d.type === "note").length,
    includeSources,
    note: "恢复方式：解压后把 kb.json 与 markdown/ 覆盖回知识库目录（sources 不在默认快照内）",
  };
  const zip = new JSZip();
  zip.file("meta.json", JSON.stringify(meta, null, 2), { compression: "DEFLATE" });
  zip.file("kb.json", JSON.stringify(manifest, null, 2), { compression: "DEFLATE" });
  for (const f of ["schema.md", "index.md", "log.md"]) {
    try {
      zip.file(f, await readFile(join(dir, f), "utf8"), { compression: "DEFLATE" });
    } catch {
      /* 旧库可能没有 */
    }
  }
  const addDir = async (zipDir, absDir) => {
    let entries = [];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(absDir, e.name);
      if (e.isDirectory()) {
        await addDir(zipDir.folder(e.name), full);
      } else {
        zipDir.file(e.name, createReadStream(full), { compression: "DEFLATE" });
      }
    }
  };
  await addDir(zip.folder("markdown"), join(dir, "markdown"));
  if (includeSources) await addDir(zip.folder("sources"), join(dir, "sources"));
  try {
    await pipeline(
      zip.generateNodeStream({ streamFiles: true, compression: "DEFLATE" }),
      createWriteStream(outPath)
    );
  } catch (error) {
    await rm(outPath, { force: true }).catch(() => {});
    throw error;
  }
  const { size } = await stat(outPath);
  await writeFile(
    `${outPath}.json`,
    JSON.stringify({ ...meta, bytes: size, name }, null, 2),
    "utf8"
  );
  return { name, path: outPath, bytes: size, docs: docs.length, includeSources };
}

/** 列出库级快照（按时间倒序）。 */
export async function listKbSnapshots(dir) {
  const snapshotsDir = join(dir, "snapshots");
  let names = [];
  try {
    names = await readdir(snapshotsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".zip"))) {
    let meta = {};
    try {
      meta = JSON.parse(await readFile(join(snapshotsDir, `${name}.json`), "utf8"));
    } catch {
      meta = {};
    }
    let size = meta.bytes ?? 0;
    if (!size) {
      try {
        size = (await stat(join(snapshotsDir, name))).size;
      } catch {
        size = 0;
      }
    }
    out.push({
      name,
      label: meta.label ?? "",
      createdAt: meta.createdAt ?? "",
      bytes: size,
      docs: meta.docs ?? 0,
      includeSources: meta.includeSources === true,
    });
  }
  out.sort((a, b) => String(b.name).localeCompare(String(a.name)));
  return out;
}
