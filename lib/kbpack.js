/**
 * kbpack 知识库包：校验 / 冲突规划 / 导入落盘。
 *
 * 包结构（kb_export format=zip 产出）：
 *   manifest.json   kbpack/v1 清单（导入端权威）
 *   kb.json         完整旧清单（提供摘要/标签/OCR 等富元数据，可选）
 *   markdown/<id>/  派生正文（导入快路径）
 *   sources/<id>.*  原始文件（可选）
 *
 * 安全边界：
 *  - 拒绝路径穿越（.. / 绝对路径 / 反斜杠 / NUL）、符号链接、超大包；
 *  - 包里不得含凭据/站点缓存/预览/历史（导出端保证，导入端也拒绝解压未知目录）；
 *  - 同 id 不同内容默认另存新 id，不静默覆盖；
 *  - 同标准号不同 id 走现有 dedup（默认跳过并报告）。
 */
import { createHash, randomBytes } from "node:crypto";
import { openZipReader } from "./zip-reader.js";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { scanDuplicates } from "./dedup.js";
import { buildFtsIndex, startBackgroundFtsBuild } from "./fts-index.js";
import { refreshKbIndex } from "./import-job.js";
import { importFileInto } from "./pipeline.js";
import {
  SCHEMA_VERSION,
  KBPACK_FORMAT,
  KBPACK_MAX_DOCS,
  commitDocs,
  docIdFor,
  isDeleted,
  kbDirPath,
  readManifest,
  sanitizeKbName,
  tryReadManifest,
  withManifestLock,
  writeManifestAtomic,
} from "./store.js";
import { VERSION } from "./version.js";
import { appendLog, ensureSchema } from "./wiki.js";

export const KBPACK_MODES = ["merge", "rename", "replace"];
/** 解压前拒绝的包体/内容上限（防 zip 炸弹）。 */
export const KBPACK_MAX_ZIP_BYTES = 8 * 1024 ** 3;
/** 超过该体积改走流式 ZipReader，避免整包进内存。 */
export const KBPACK_JSZIP_MAX_BYTES = 256 * 1024 ** 2;
export const KBPACK_MAX_CONTENT_BYTES = 16 * 1024 ** 3;
export const KBPACK_MAX_ENTRIES = 50000;
/** 900+ 篇的包导入超过这个量就转后台建 FTS，避免工具调用超时。 */
const FTS_BACKGROUND_DOCS = 200;

export class KbpackError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "KbpackError";
    this.code = code;
    this.details = details;
  }
}

/** 包内条目名安全校验：拒绝一切可能逃出目标目录的写法。 */
export function assertSafeEntryName(name) {
  const raw = String(name ?? "");
  if (raw === "" || raw.length > 500) {
    throw new KbpackError("KBPACK_UNSAFE_PATH", `包内条目名非法: ${raw.slice(0, 80)}`);
  }
  if (raw.includes("\u0000") || raw.includes("\\")) {
    throw new KbpackError("KBPACK_UNSAFE_PATH", `包内条目名含非法字符: ${raw.slice(0, 80)}`);
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new KbpackError("KBPACK_UNSAFE_PATH", `包内条目是绝对路径: ${raw.slice(0, 80)}`);
  }
  // zip 的目录条目以 "/" 结尾（markdown/<id>/ 是合法目录），去掉尾部斜杠再查 ..
  const value = raw.endsWith("/") ? raw.replace(/\/+$/, "") : raw;
  if (value === "") {
    throw new KbpackError("KBPACK_UNSAFE_PATH", `包内条目名非法: ${raw.slice(0, 80)}`);
  }
  for (const part of value.split("/")) {
    if (part === "" || part === "." || part === "..") {
      throw new KbpackError("KBPACK_UNSAFE_PATH", `包内条目含路径穿越: ${raw.slice(0, 80)}`);
    }
  }
  return value;
}

function isSymlinkEntry(entry) {
  const mode = Number(entry?.unixPermissions);
  return Number.isFinite(mode) && mode > 0 && (mode & 0o170000) === 0o120000;
}

function asIso(value) {
  return typeof value === "string" && value !== "" ? value : "";
}

function packageDocId(raw) {
  const id = String(raw ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{3,63}$/.test(id)) {
    throw new KbpackError("KBPACK_INVALID", `包内文档 id 非法: ${id.slice(0, 80)}`);
  }
  return id;
}

/**
 * 校验并归一化 manifest.json。
 * 版本过高（schemaVersion 大于本插件）直接拒绝：旧插件不认识新字段时
 * 静默降级会丢数据，宁可让用户先升级。
 */
export function validateKbpackManifest(raw, { currentSchema = SCHEMA_VERSION } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new KbpackError("KBPACK_INVALID", "manifest.json 不是对象");
  }
  if (raw.format !== KBPACK_FORMAT) {
    throw new KbpackError(
      "KBPACK_INVALID",
      `不是 kbpack/v1 知识库包（format=${String(raw.format ?? "缺失")}）`
    );
  }
  const schemaVersion = Number(raw.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    throw new KbpackError("KBPACK_INVALID", "manifest.json 缺少合法的 schemaVersion");
  }
  if (schemaVersion > currentSchema) {
    throw new KbpackError(
      "KBPACK_VERSION_TOO_NEW",
      `包格式版本过高（schemaVersion=${schemaVersion}，本插件支持到 ${currentSchema}）；请先升级插件再导入`,
      { schemaVersion, supported: currentSchema }
    );
  }
  const kbName = String(raw.kbName ?? "").trim();
  if (kbName === "") throw new KbpackError("KBPACK_INVALID", "manifest.json 缺少 kbName");
  let safeName = "";
  try {
    safeName = sanitizeKbName(kbName);
  } catch (error) {
    throw new KbpackError("KBPACK_INVALID", `包内知识库名非法: ${String(error?.message ?? error)}`);
  }
  const docs = raw.docs;
  if (!Array.isArray(docs)) throw new KbpackError("KBPACK_INVALID", "manifest.json 缺少 docs 数组");
  if (docs.length > KBPACK_MAX_DOCS) {
    throw new KbpackError("KBPACK_INVALID", `包内文档数超过上限 ${KBPACK_MAX_DOCS}`);
  }
  const seen = new Set();
  const normalized = [];
  for (const item of docs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new KbpackError("KBPACK_INVALID", "manifest.json docs 含非对象条目");
    }
    const id = packageDocId(item.id);
    if (seen.has(id)) throw new KbpackError("KBPACK_INVALID", `manifest.json 文档 id 重复: ${id}`);
    seen.add(id);
    const title = String(item.title ?? "");
    if (title.trim() === "") throw new KbpackError("KBPACK_INVALID", `文档 ${id} 缺少标题`);
    normalized.push({
      id,
      // 不 trim：标题里可能导致信息丢失的尾随空格也要原样还原（导出→导入应逐字一致）。
      title: title.slice(0, 200),
      standardNo: String(item.standardNo ?? "").slice(0, 80),
      type: String(item.type ?? "").slice(0, 40),
      kind: String(item.kind ?? "").slice(0, 40),
      stage: String(item.stage ?? "unknown").slice(0, 40),
      sourceHash: String(item.sourceHash ?? "").slice(0, 200),
      textHash: String(item.textHash ?? "").slice(0, 200),
      contentHash: String(item.contentHash ?? "").slice(0, 200),
      hashAlgo: String(item.hashAlgo ?? "").slice(0, 40),
      chars: Number(item.chars) || 0,
      pages: Number(item.pages) || 0,
      parts: Number(item.parts) || 1,
      trust: String(item.trust ?? "unknown").slice(0, 20),
      sourceFile: String(item.sourceFile ?? "").slice(0, 300),
      hasSource: item.hasSource === true,
      hasMarkdown: item.hasMarkdown === true,
      version: Number(item.version) || 0,
      updatedAt: asIso(item.updatedAt),
    });
  }
  return {
    format: KBPACK_FORMAT,
    schemaVersion,
    parserVersion: String(raw.parserVersion ?? ""),
    kbName: safeName,
    exportedAt: asIso(raw.exportedAt),
    exporter: raw.exporter && typeof raw.exporter === "object" ? raw.exporter : {},
    withSources: raw.withSources === true,
    counts: raw.counts && typeof raw.counts === "object" ? raw.counts : {},
    docs: normalized,
  };
}

/**
 * 读取并校验一个 .zip 包（不落盘）。
 * 小包用 JSZip（快）；大包用流式 ZipReader（不把 4.7GB 全读进内存）。
 * @returns {zip|null, reader|null, manifest, kbJsonDocs, markdownEntries, sourceEntries, totalBytes, filename}
 */
export async function inspectKbpack(path, { forceStream = false } = {}) {
  const file = String(path ?? "");
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new KbpackError("KBPACK_NOT_FOUND", `包不存在: ${file}`);
  }
  if (!info.isFile()) throw new KbpackError("KBPACK_INVALID", `不是文件: ${file}`);
  if (info.size > KBPACK_MAX_ZIP_BYTES) {
    throw new KbpackError(
      "KBPACK_TOO_LARGE",
      `包体过大（${(info.size / 1024 ** 3).toFixed(2)} GB），超过上限 ${KBPACK_MAX_ZIP_BYTES / 1024 ** 3} GB；建议按库分批迁移。`
    );
  }
  let zip = null;
  let reader = null;
  try {
    let list = [];
    if (forceStream || info.size > KBPACK_JSZIP_MAX_BYTES) {
      reader = await openZipReader(file);
      list = reader.list();
    } else {
      const { default: JSZip } = await import("jszip");
      try {
        zip = await JSZip.loadAsync(await readFile(file));
      } catch (error) {
        throw new KbpackError("KBPACK_INVALID", `无法解压（不是合法 zip）: ${String(error?.message ?? error)}`);
      }
      list = Object.keys(zip.files ?? {}).map((name) => {
        const entry = zip.files[name];
        return {
          name,
          isDirectory: entry.dir === true,
          isSymlink: isSymlinkEntry(entry),
          uncompressedSize: Number(entry?._data?.uncompressedSize) || 0,
        };
      });
    }
    if (list.length > KBPACK_MAX_ENTRIES) {
      throw new KbpackError("KBPACK_TOO_LARGE", `包内条目过多（${list.length}），上限 ${KBPACK_MAX_ENTRIES}`);
    }
    let totalBytes = 0;
    const names = new Set();
    for (const entry of list) {
      assertSafeEntryName(entry.name);
      if (entry.isSymlink) {
        throw new KbpackError("KBPACK_SYMLINK", `包内含符号链接，拒绝导入: ${entry.name}`);
      }
      if (Number.isFinite(entry.uncompressedSize) && entry.uncompressedSize > 0) {
        totalBytes += entry.uncompressedSize;
      }
      names.add(entry.name);
    }
    if (totalBytes > KBPACK_MAX_CONTENT_BYTES) {
      throw new KbpackError(
        "KBPACK_TOO_LARGE",
        `解压后体积过大（${(totalBytes / 1024 ** 3).toFixed(2)} GB），超过上限 ${KBPACK_MAX_CONTENT_BYTES / 1024 ** 3} GB`
      );
    }
    const readText = async (name) => {
      if (reader) return await reader.readText(name);
      const entry = zip.file(name);
      if (!entry || entry.dir) return null;
      return await entry.async("string");
    };
    if (!names.has("manifest.json")) {
      throw new KbpackError("KBPACK_INVALID", "包内缺少 manifest.json（不是 kbpack 包）");
    }
    let rawManifest;
    try {
      rawManifest = JSON.parse(await readText("manifest.json"));
    } catch (error) {
      throw new KbpackError("KBPACK_INVALID", `manifest.json 不是合法 JSON: ${String(error?.message ?? error)}`);
    }
    const manifest = validateKbpackManifest(rawManifest);

    // kb.json 提供富元数据（摘要/标签/OCR/标准号拆分）；缺失时退化为 manifest 字段。
    let kbJsonDocs = new Map();
    if (names.has("kb.json")) {
      try {
        const parsed = JSON.parse(await readText("kb.json"));
        if (parsed && Array.isArray(parsed.docs)) {
          for (const doc of parsed.docs) {
            if (doc && typeof doc.id === "string") kbJsonDocs.set(doc.id, doc);
          }
        }
      } catch {
        /* kb.json 损坏不阻塞：manifest 已经足够导入 */
      }
    }

    const markdownEntries = new Map();
    const sourceEntries = new Map();
    for (const entry of list) {
      const name = entry.name;
      if (entry.isDirectory) continue;
      if (name === "manifest.json" || name === "kb.json" || name === "README.md") continue;
      if (name.startsWith("markdown/")) {
        const rest = name.slice("markdown/".length);
        const slash = rest.indexOf("/");
        if (slash <= 0) continue;
        const id = rest.slice(0, slash);
        if (!markdownEntries.has(id)) markdownEntries.set(id, []);
        markdownEntries.get(id).push(name);
        continue;
      }
      if (name.startsWith("sources/")) {
        const source = name.slice("sources/".length);
        if (source.includes("/")) continue;
        const dot = source.indexOf(".");
        if (dot <= 0) continue;
        const id = source.slice(0, dot);
        sourceEntries.set(id, name);
      }
    }

    // 校验 manifest 与实际条目一致：manifest 说有的必须有；都没法导入的标记出来。
    const importable = [];
    const unimportable = [];
    for (const doc of manifest.docs) {
      const files = markdownEntries.get(doc.id) ?? [];
      const mergedName = `markdown/${doc.id}/${doc.id}.md`;
      const hasMarkdown = files.includes(mergedName);
      const sourceName = sourceEntries.get(doc.id) ?? "";
      const hasSource = sourceName !== "";
      if (doc.hasMarkdown && !hasMarkdown) {
        throw new KbpackError("KBPACK_MISSING_MARKDOWN", `文档 ${doc.id} 声明有正文，但包里找不到 ${mergedName}`);
      }
      if (doc.hasSource && !hasSource) {
        throw new KbpackError("KBPACK_MISSING_SOURCE", `文档 ${doc.id} 声明有原件，但包里找不到 sources/${doc.id}.*`);
      }
      if (!hasMarkdown && !hasSource) {
        unimportable.push({ id: doc.id, title: doc.title, reason: "包内既无正文也无原件" });
        continue;
      }
      importable.push({ ...doc, hasMarkdown, hasSource, sourceName });
    }
    return {
      zip,
      reader,
      filename: basename(file),
      zipBytes: info.size,
      manifest,
      kbJsonDocs,
      markdownEntries,
      sourceEntries,
      importable,
      unimportable,
      totalBytes,
      entries: [...names],
    };
  } catch (error) {
    if (reader) await reader.close().catch(() => {});
    throw error;
  }
}

/** 目标库是否已经存在（有目录或已有清单）。 */
async function targetExists(kbRoot, name) {
  const dir = kbDirPath(kbRoot, name);
  const manifest = await tryReadManifest(dir);
  if (manifest) return true;
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function uniqueKbName(base, used) {
  const root = String(base);
  let candidate = root;
  let n = 1;
  while (used.has(candidate)) {
    n += 1;
    candidate = sanitizeKbName(`${root.slice(0, 50)} (导入${n === 2 ? "" : ` ${n}`})`);
  }
  return candidate;
}

function sameContent(target, doc) {
  const a = String(doc.contentHash || doc.sourceHash || doc.textHash || "");
  const b = String(target?.sourceHash || target?.textHash || target?._contentHash || "");
  if (a !== "" && b !== "") return a === b;
  return false;
}

/**
 * 目标库里没有 sourceHash/textHash 的文档（笔记、旧版导入）补一个 markdown 内容哈希，
 * 否则重复导入同一个包时会被当成“id 冲突”再复制一份，破坏幂等。
 * 只补包里出现过的 id，避免整库读盘。
 */
async function enrichTargetHashes(dir, targetManifest, packageDocs) {
  const wanted = new Set((packageDocs ?? []).map((doc) => doc.id));
  for (const doc of targetManifest?.docs ?? []) {
    if (!wanted.has(doc.id)) continue;
    if (String(doc.sourceHash || doc.textHash || "") !== "") continue;
    try {
      const merged = await readFile(join(dir, "markdown", doc.id, `${doc.id}.md`));
      doc._contentHash = createHash("sha1").update(merged).digest("hex");
    } catch {
      /* 没有正文就无法判同，按冲突处理 */
    }
  }
}

function remapId(baseId, taken) {
  let n = 1;
  let candidate = docIdFor(`${baseId}~imported`);
  while (taken.has(candidate)) {
    n += 1;
    candidate = docIdFor(`${baseId}~imported-${n}`);
  }
  return candidate;
}

/**
 * 纯规划：只决定每篇怎么处理（create / replace / remap / skip），不碰文件。
 * 同标准号查重由调用方在规划后跑 scanDuplicates（需要扫全库）。
 */
export function planPackageImport({ packageDocs = [], targetManifest, mode = "merge" } = {}) {
  const targetDocs = (targetManifest?.docs ?? []).filter((doc) => doc.status === "ready" || isDeleted(doc));
  const byId = new Map(targetDocs.map((doc) => [doc.id, doc]));
  const taken = new Set(targetDocs.map((doc) => doc.id));
  const actions = [];
  for (const doc of packageDocs) {
    const target = byId.get(doc.id);
    if (!target) {
      actions.push({ kind: "create", docId: doc.id, oldId: doc.id, doc, reason: "new" });
      continue;
    }
    if (sameContent(target, doc)) {
      actions.push({
        kind: "skip",
        docId: doc.id,
        oldId: doc.id,
        doc,
        reason: "identical",
        targetTitle: target.title,
      });
      continue;
    }
    if (mode === "replace") {
      actions.push({ kind: "replace", docId: doc.id, oldId: doc.id, doc, reason: "replace" });
      continue;
    }
    const newId = remapId(doc.id, taken);
    taken.add(newId);
    actions.push({
      kind: "remap",
      docId: newId,
      oldId: doc.id,
      doc,
      reason: "id-conflict",
      targetTitle: target.title,
    });
  }
  return { actions };
}

function fullDocFor(inspected, doc) {
  const full = inspected.kbJsonDocs.get(doc.id) ?? {};
  const merged = { ...full, ...doc };
  // 包内 kb.json 的路径/历史/运行态字段绝不带进目标库。
  for (const key of [
    "sourcePath", "history", "error", "errorAt", "status", "importingFrom", "heartbeatAt",
    "deletedAt", "deletedFromStatus", "movedTo", "movedAt", "mergedInto", "mergedAt",
    "id", "version", "importedAt", "updatedAt",
  ]) {
    delete merged[key];
  }
  merged.type = String(full.type ?? doc.type ?? "text");
  merged.kind = String(full.kind ?? doc.kind ?? (merged.type === "note" ? "note" : ""));
  return merged;
}

async function extractEntryFrom(inspected, name, dest) {
  if (inspected.reader) {
    await inspected.reader.extractEntry(name, dest);
    return;
  }
  const entry = inspected.zip?.files?.[name];
  if (!entry || entry.dir) return;
  await mkdir(dirname(dest), { recursive: true });
  const data = await entry.async("nodebuffer");
  await writeFile(dest, data);
}

async function extractMarkdown(inspected, oldId, stagedDir) {
  const names = inspected.markdownEntries.get(oldId) ?? [];
  for (const name of names) {
    const rel = name.slice(`markdown/${oldId}/`.length);
    assertSafeEntryName(rel);
    await extractEntryFrom(inspected, name, join(stagedDir, rel));
  }
}

function safeSourceExt(sourceName, sourceFile) {
  const fromName = extname(String(sourceName ?? ""));
  if (/^\.[a-z0-9]{1,10}$/i.test(fromName)) return fromName.toLowerCase();
  const fromFile = extname(String(sourceFile ?? ""));
  if (/^\.[a-z0-9]{1,10}$/i.test(fromFile)) return fromFile.toLowerCase();
  return ".bin";
}

function packageMeta(inspected, doc) {
  const full = fullDocFor(inspected, doc);
  return {
    title: doc.title,
    titleSource: full.titleSource,
    sourceFile: doc.sourceFile || full.sourceFile || "",
    sourceHash: doc.sourceHash || full.sourceHash || "",
    textHash: doc.textHash || full.textHash || "",
    textHashAlgo: full.textHashAlgo,
    parserVersion: full.parserVersion,
    contentSource: full.contentSource,
    ocrPages: full.ocrPages,
    ocrEngine: full.ocrEngine,
    ocrDpi: full.ocrDpi,
    ocrLang: full.ocrLang,
    ocrModel: full.ocrModel,
    ocrConfidence: full.ocrConfidence,
    lowConfidencePages: full.lowConfidencePages,
    corruptedPages: full.corruptedPages,
    edited: full.edited,
    summary: full.summary,
    summarySource: full.summarySource,
    tags: full.tags,
    trust: doc.trust || full.trust || "unknown",
    trustReason: full.trustReason,
    trustUpdatedAt: full.trustUpdatedAt,
    trustSource: full.trustSource,
    rawTitle: full.rawTitle,
    canonicalTitle: full.canonicalTitle,
    standardNo: doc.standardNo || full.standardNo || "",
    standardPrefix: full.standardPrefix,
    standardNumber: full.standardNumber,
    standardBase: full.standardBase,
    standardYear: full.standardYear,
    standardPart: full.standardPart,
    standardSource: full.standardSource,
    filenameStandardNo: full.filenameStandardNo,
    contentTitle: full.contentTitle,
    contentIntegrity: full.contentIntegrity,
    bodyChars: full.bodyChars,
    clauseCount: full.clauseCount,
    stage: doc.stage && doc.stage !== "unknown" ? doc.stage : full.stage,
    stageLabel: full.stageLabel,
    dedupKeep: full.dedupKeep,
    dedupNote: full.dedupNote,
    dedupReviewedAt: full.dedupReviewedAt,
    type: doc.type || full.type || "text",
    kind: doc.kind || full.kind,
    sources: full.sources,
    linksOut: full.linksOut,
    pages: Number(doc.pages) || Number(full.pages) || 0,
    chars: Number(doc.chars) || Number(full.chars) || 0,
    parts: Number(doc.parts) || Number(full.parts) || 1,
    outline: full.outline,
    warnings: full.warnings,
  };
}

async function acquirePackageLock(dir) {
  const lockDir = join(dir, "import-tmp", ".package-import");
  await mkdir(join(dir, "import-tmp"), { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const info = await stat(lockDir);
      if (Date.now() - info.mtimeMs > 2 * 3600 * 1000) {
        await rm(lockDir, { recursive: true, force: true });
        await mkdir(lockDir);
      } else {
        throw new KbpackError("KBPACK_BUSY", "该知识库已有包导入任务在运行，请稍后重试");
      }
    } catch (inner) {
      if (inner instanceof KbpackError) throw inner;
      throw new KbpackError("KBPACK_BUSY", "该知识库已有包导入任务在运行，请稍后重试");
    }
  }
  try {
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      "utf8"
    );
  } catch {
    /* owner 写失败不影响互斥 */
  }
  return lockDir;
}

async function rewriteNoteRefs(dir, remap, importedIds) {
  if (remap.size === 0) return 0;
  let changed = 0;
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    for (const doc of manifest.docs) {
      if (doc.type !== "note" || !importedIds.has(doc.id)) continue;
      let touched = false;
      if (Array.isArray(doc.sources)) {
        const next = doc.sources.map((ref) => {
          const text = String(ref);
          for (const [oldId, newId] of remap) {
            if (text === oldId || text.startsWith(`${oldId}#`)) {
              touched = true;
              return `${newId}${text.slice(oldId.length)}`;
            }
          }
          return text;
        });
        if (touched) doc.sources = next;
      }
      if (Array.isArray(doc.linksOut)) {
        const next = doc.linksOut.map((id) => {
          if (remap.has(id)) {
            touched = true;
            return remap.get(id);
          }
          return id;
        });
        if (touched) doc.linksOut = [...new Set(next)];
      }
      if (touched) changed += 1;
    }
    if (changed > 0) await writeManifestAtomic(dir, manifest);
  });
  return changed;
}

/**
 * 导入一个 kbpack 包。
 *
 * mode 缺省时：目标库不存在 → 直接新建导入；目标库已存在 → 不写入，返回
 * needsChoice（merge / rename / replace），由调用方（agent 或工作台）让用户选。
 * replace 必须 confirm === "replace"。
 */
export async function importKbpack({
  kbRoot,
  path,
  kb = "",
  mode = "",
  confirm = "",
  allowCrossDuplicates = false,
  dryRun = false,
  onProgress = null,
  onTarget = null,
  parserConfig = {},
  forceStream = false,
} = {}) {
  const started = Date.now();
  const emit = typeof onProgress === "function" ? onProgress : () => {};
  const requestedMode = String(mode ?? "").trim().toLowerCase();
  if (requestedMode !== "" && !KBPACK_MODES.includes(requestedMode)) {
    throw new KbpackError(
      "KBPACK_MODE_INVALID",
      `mode 取值无效: ${mode}（应为 ${KBPACK_MODES.join(" / ")}）`
    );
  }
  const inspected = await inspectKbpack(path, { forceStream });
  const pkgName = inspected.manifest.kbName;
  const requestedKb = String(kb ?? "").trim();
  const initialTarget = requestedKb ? sanitizeKbName(requestedKb) : pkgName;
  const exists = await targetExists(kbRoot, initialTarget);
  let resolvedMode = requestedMode;
  if (resolvedMode === "") {
    if (!exists) resolvedMode = "merge";
    else {
      if (typeof onTarget === "function") await onTarget(initialTarget);
      return {
        ok: false,
        needsChoice: true,
        kb: initialTarget,
        package: {
          filename: inspected.filename,
          kbName: pkgName,
          docs: inspected.manifest.docs.length,
          withSources: inspected.manifest.withSources,
          exportedAt: inspected.manifest.exportedAt,
          exporter: inspected.manifest.exporter,
        },
        choices: [
          {
            mode: "merge",
            label: "合并到同名知识库",
            description: "同 id 相同内容跳过；同 id 不同内容另存新 id；同标准号不同 id 默认跳过并报告",
          },
          {
            mode: "rename",
            label: "另存为新知识库",
            description: "不碰现有库，自动加「(导入)」后缀；跨库同号不拦截",
          },
          {
            mode: "replace",
            label: "覆盖同 id 文档",
            description: "同 id 文档用包内版本覆盖（旧版进 history，需 confirm:\"replace\"）；包外文档保留",
          },
        ],
        hint: `本机已存在知识库「${initialTarget}」。请让用户选择后再调用（传 mode=merge / rename / replace）。`,
      };
    }
  }
  if (resolvedMode === "replace" && String(confirm) !== "replace") {
    throw new KbpackError(
      "KBPACK_CONFIRM_REQUIRED",
      'replace 模式会覆盖同 id 文档，必须显式传 confirm: "replace"'
    );
  }

  // 目标库名：rename 冲突自动加后缀；merge/replace 用同名。
  let targetName = initialTarget;
  if (resolvedMode === "rename" && (await targetExists(kbRoot, targetName))) {
    const used = new Set();
    try {
      const { listKbs } = await import("./store.js");
      for (const item of await listKbs(kbRoot)) used.add(item.dir ?? item.name);
    } catch {
      /* 列库失败时只按目标名判断 */
    }
    used.add(targetName);
    targetName = uniqueKbName(initialTarget, used);
  }
  // 范围门：目标库名定下来后、任何写入之前回调；越界时调用方直接抛错。
  if (typeof onTarget === "function") await onTarget(targetName);
  const dir = kbDirPath(kbRoot, targetName);
  const targetPresent = await targetExists(kbRoot, targetName);
  let targetManifest;
  if (targetPresent) {
    await mkdir(dir, { recursive: true });
    targetManifest = await readManifest(dir);
  } else {
    // dryRun 不能为了“读清单”就把目标库建出来。
    targetManifest = { schemaVersion: SCHEMA_VERSION, name: targetName, docs: [] };
  }
  if (resolvedMode !== "rename" && targetPresent) {
    await enrichTargetHashes(dir, targetManifest, inspected.manifest.docs);
  }
  if (!dryRun) await mkdir(dir, { recursive: true });
  const plan = planPackageImport({
    packageDocs: inspected.importable,
    targetManifest,
    mode: resolvedMode === "rename" ? "merge" : resolvedMode,
  });

  // 同标准号/标题查重：复用 kb_import 的规则（同库必跳过；跨库默认跳过）。
  const candidates = plan.actions
    .filter((action) => action.kind === "create" || action.kind === "remap")
    .map((action) => ({ title: action.doc.title, docId: action.oldId, __action: action }));
  let duplicateReports = [];
  let similarReports = [];
  if (candidates.length > 0) {
    const dedup = await scanDuplicates({
      root: kbRoot,
      targetKb: targetName,
      files: candidates,
      allowCrossKb: resolvedMode === "rename" ? true : allowCrossDuplicates === true,
    });
    const kept = new Set(dedup.kept.map((item) => item.__action));
    for (const candidate of candidates) {
      if (!kept.has(candidate.__action)) candidate.__action.__duplicate = true;
    }
    duplicateReports = dedup.duplicates;
    similarReports = dedup.similar;
  }

  const actions = plan.actions;
  const counts = {
    total: inspected.manifest.docs.length,
    create: 0,
    replace: 0,
    remap: 0,
    skipIdentical: 0,
    skipDuplicate: 0,
    reparse: 0,
    unimportable: inspected.unimportable.length,
  };
  for (const action of actions) {
    if (action.kind === "create") {
      if (action.__duplicate) counts.skipDuplicate += 1;
      else counts.create += 1;
    } else if (action.kind === "remap") {
      if (action.__duplicate) counts.skipDuplicate += 1;
      else counts.remap += 1;
    } else if (action.kind === "replace") counts.replace += 1;
    else if (action.kind === "skip") counts.skipIdentical += 1;
  }

  const warnings = [];
  for (const item of inspected.unimportable) {
    warnings.push(`跳过「${item.title}」（${item.id}）：${item.reason}`);
  }
  for (const action of actions) {
    if (action.kind === "remap") {
      warnings.push(
        `id 冲突：包内 ${action.oldId}「${action.doc.title}」与库内「${action.targetTitle}」不同，已另存为 ${action.docId}`
      );
    }
    if (action.__duplicate) {
      warnings.push(`同号/同名重合：跳过「${action.doc.title}」（${action.oldId}）`);
    }
  }
  for (const doc of inspected.importable) {
    if (!doc.hasMarkdown && doc.hasSource) {
      warnings.push(`「${doc.title}」包内无派生正文，将从原件重新解析（可能触发 OCR）`);
    }
  }

  if (dryRun) {
    return {
      ok: true,
      needsChoice: false,
      dryRun: true,
      kb: targetName,
      mode: resolvedMode,
      package: {
        filename: inspected.filename,
        kbName: pkgName,
        docs: inspected.manifest.docs.length,
        withSources: inspected.manifest.withSources,
        bytes: inspected.zipBytes,
      },
      // dry-run 与正式导入共用同一组字段名（宿主 output schema 只声明一份）。
      total: counts.total,
      created: counts.create,
      replaced: counts.replace,
      remapped: counts.remap,
      skipped: counts.skipIdentical + counts.skipDuplicate,
      skipIdentical: counts.skipIdentical,
      skipDuplicate: counts.skipDuplicate,
      unimportable: counts.unimportable,
      reparsed: counts.reparse,
      duplicates: duplicateReports,
      similar: similarReports,
      warnings,
      elapsedMs: Date.now() - started,
    };
  }

  emit({ phase: "prepare", done: 0, total: actions.length, current: "" });
  const lockDir = await acquirePackageLock(dir);
  const stagingRoot = join(dir, "import-tmp", `package-${randomBytes(6).toString("hex")}`);
  const stagedMarkdown = new Map();
  const stagedSources = new Map();
  let committed = 0;
  let reparsed = 0;
  try {
    await mkdir(stagingRoot, { recursive: true });
    // 1) 解压在锁外（I/O 大头），锁内只做 rename + 一次清单写入。
    const work = actions.filter(
      (action) =>
        (action.kind === "create" || action.kind === "remap" || action.kind === "replace") &&
        !action.__duplicate
    );
    for (let i = 0; i < work.length; i += 1) {
      const action = work[i];
      const isMarkdownPath = action.doc.hasMarkdown;
      if (isMarkdownPath) {
        const stageDir = join(stagingRoot, "markdown", action.docId);
        await extractMarkdown(inspected, action.oldId, stageDir);
        stagedMarkdown.set(action.docId, stageDir);
      }
      if (action.doc.sourceName) {
        const ext = safeSourceExt(action.doc.sourceName, action.doc.sourceFile);
        const stageSource = join(stagingRoot, "sources", `${action.docId}${ext}`);
        await extractEntryFrom(inspected, action.doc.sourceName, stageSource);
        stagedSources.set(action.docId, { path: stageSource, ext });
      }
      emit({
        phase: "extract",
        done: i + 1,
        total: work.length,
        current: action.doc.title,
      });
    }

    // 2) 批量落盘：一次清单写；replace 的历史快照由 commitDocs 负责。
    const payloads = [];
    const remap = new Map();
    for (const action of work) {
      if (action.kind === "remap") remap.set(action.oldId, action.docId);
      // 无派生正文的文档不在这里落清单：交给下面的 importFileInto 解析，
      // 否则会先产生一个没有 markdown 的空条目。
      if (!stagedMarkdown.has(action.docId)) continue;
      const meta = packageMeta(inspected, action.doc);
      payloads.push({
        ...meta,
        docId: action.docId,
        title: action.doc.title,
        sourceFile: action.doc.sourceFile || meta.sourceFile,
        sourceHash: action.doc.sourceHash || meta.sourceHash,
        storedSourcePath: "",
        ...(stagedMarkdown.has(action.docId) ? { stagedDir: stagedMarkdown.get(action.docId) } : {}),
        ...(stagedSources.has(action.docId)
          ? {
              stagedSourcePath: stagedSources.get(action.docId).path,
              sourceExt: stagedSources.get(action.docId).ext,
            }
          : {}),
        snapshotReason: "import-package",
      });
    }
    if (payloads.length > 0) committed = await commitDocs(dir, payloads);
    emit({ phase: "commit", done: committed, total: payloads.length, current: "" });

    // 3) 包里没有派生正文但有原件的文档：走正常解析/OCR（慢路径）。
    const reparseDocs = [];
    for (const action of work) {
      if (action.doc.hasMarkdown || !action.doc.hasSource) continue;
      const src = stagedSources.get(action.docId);
      if (!src) continue;
      const meta = packageMeta(inspected, action.doc);
      try {
        const report = await importFileInto(dir, {
          sourcePath: src.path,
          relKey: `package/${action.oldId}/${basename(src.path)}`,
          title: action.doc.title,
          docId: action.docId,
          sourceFile: action.doc.sourceFile,
          storedSourcePath: "",
          forceReparse: true,
          config: { ...parserConfig, forceReparse: true },
        });
        if (report?.docId) {
          reparseDocs.push({ docId: report.docId, meta });
          reparsed += 1;
        }
      } catch (error) {
        warnings.push(`重新解析失败「${action.doc.title}」：${String(error?.message ?? error)}`);
      }
    }
    if (reparseDocs.length > 0) {
      await withManifestLock(dir, async () => {
        const manifest = await readManifest(dir);
        const patches = [];
        for (const item of reparseDocs) {
          const patch = {};
          for (const key of [
            "summary", "summarySource", "tags", "trust", "trustReason", "trustSource",
            "standardNo", "standardPrefix", "standardNumber", "standardBase", "standardYear",
            "standardPart", "standardSource", "stage", "stageLabel", "kind", "sources", "linksOut",
          ]) {
            if (item.meta[key] !== undefined && item.meta[key] !== "") patch[key] = item.meta[key];
          }
          if (Object.keys(patch).length > 0) patches.push({ docId: item.docId, patch });
        }
        if (patches.length > 0) {
          const { updateDocsMetaLocked } = await import("./store.js");
          await updateDocsMetaLocked(dir, manifest, patches);
        }
      });
    }

    // 4) 笔记里的 docId 引用随重映射改写（只改本次导入的笔记）。
    const importedIds = new Set(payloads.map((payload) => payload.docId));
    for (const item of reparseDocs) importedIds.add(item.docId);
    await rewriteNoteRefs(dir, remap, importedIds);

    // 5) 索引 / FTS / 日志。
    await ensureSchema(dir, targetName).catch(() => {});
    await refreshKbIndex(dir);
    let ftsRebuilt = "skipped";
    try {
      const manifest = await readManifest(dir);
      const live = (manifest.docs ?? []).filter((doc) => doc.status === "ready" && !isDeleted(doc));
      if (live.length > FTS_BACKGROUND_DOCS) {
        const started = await startBackgroundFtsBuild(dir);
        ftsRebuilt = started?.started ? "background" : "skipped";
      } else {
        const built = await buildFtsIndex(dir, manifest, { force: false, incremental: true });
        ftsRebuilt = built?.ok ? "sync" : "skipped";
      }
    } catch {
      ftsRebuilt = "skipped";
    }
    const summary = `导入 ${committed + reparsed} 篇（新建 ${counts.create}、重映射 ${counts.remap}、覆盖 ${counts.replace}、跳过 ${counts.skipIdentical + counts.skipDuplicate}${reparsed > 0 ? `、重解析 ${reparsed}` : ""}）`;
    await appendLog(dir, {
      action: "import-package",
      title: inspected.filename,
      detail: summary,
    });
    return {
      ok: true,
      needsChoice: false,
      dryRun: false,
      kb: targetName,
      mode: resolvedMode,
      package: {
        filename: inspected.filename,
        kbName: pkgName,
        docs: inspected.manifest.docs.length,
        withSources: inspected.manifest.withSources,
        bytes: inspected.zipBytes,
      },
      total: counts.total,
      created: counts.create,
      replaced: counts.replace,
      remapped: counts.remap,
      skipped: counts.skipIdentical + counts.skipDuplicate,
      skipIdentical: counts.skipIdentical,
      skipDuplicate: counts.skipDuplicate,
      unimportable: counts.unimportable,
      reparsed,
      duplicates: duplicateReports,
      similar: similarReports,
      warnings,
      ftsRebuilt,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 工具层渲染：needsChoice / dryRun / 正式导入三种形态。 */
export function renderPackageResult(value) {
  if (!value) return "";
  if (value.needsChoice) {
    const lines = [
      `知识库包「${value.package?.filename ?? ""}」内含「${value.package?.kbName ?? value.kb}」（${value.package?.docs ?? 0} 篇${value.package?.withSources ? "，含原件" : ""}）。`,
      `本机已存在同名知识库「${value.kb}」，未写入任何内容。请选择导入方式：`,
    ];
    for (const choice of value.choices ?? []) {
      lines.push(`- ${choice.mode}：${choice.label} —— ${choice.description}`);
    }
    lines.push(value.hint ?? "");
    return lines.join("\n");
  }
  const head = value.dryRun
    ? `预演：包「${value.package?.filename ?? ""}」→ 知识库「${value.kb}」(${value.mode})`
    : `已导入包「${value.package?.filename ?? ""}」到知识库「${value.kb}」(${value.mode})`;
  const counts = value.dryRun
    ? `将新建 ${value.created}、覆盖 ${value.replaced}、重映射 ${value.remapped}、跳过同内容 ${value.skipIdentical}、跳过同号 ${value.skipDuplicate}`
    : `新建 ${value.created}、覆盖 ${value.replaced}、重映射 ${value.remapped}、跳过 ${value.skipped}${value.reparsed ? `、重解析 ${value.reparsed}` : ""}`;
  const lines = [`${head}：${counts}（共 ${value.total} 篇，${Math.round((value.package?.bytes ?? 0) / 1024)} KB）。`];
  if (value.duplicates?.length) {
    lines.push(`同号/同名重合 ${value.duplicates.length} 个（已跳过，可加 allowCrossDuplicates 或人工核对）：`);
    for (const item of value.duplicates.slice(0, 10)) {
      const matched = (item.matched ?? []).map((m) => `「${m.kb}」${m.title}(${m.id})`).join("、");
      lines.push(`- ${item.title} ↔ ${matched}`);
    }
  }
  if (value.similar?.length) lines.push(`标题相似 ${value.similar.length} 个（已照常导入，请确认是否重复）。`);
  if (value.warnings?.length) {
    lines.push(`提示 ${value.warnings.length} 条：`);
    for (const warning of value.warnings.slice(0, 15)) lines.push(`- ${warning}`);
    if (value.warnings.length > 15) lines.push(`  …共 ${value.warnings.length} 条`);
  }
  if (value.ftsRebuilt === "background") lines.push("全文索引正在后台重建，稍后可用 kb_query 检索。");
  lines.push(`用时 ${Math.round((value.elapsedMs ?? 0) / 1000)} 秒。`);
  return lines.join("\n");
}
