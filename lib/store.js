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
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { PARSER_VERSION } from "./version.js";
import { basename, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// 路径与命名
// ---------------------------------------------------------------------------

export function expandRoot(root) {
  if (root === "~") return homedir();
  if (root.startsWith("~/")) return join(homedir(), root.slice(2));
  return root;
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

export const SCHEMA_VERSION = 2;
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
  raw.docs = (raw.docs ?? []).map((doc) => {
    const next = {
      ...doc,
      outline: normalizeOutline(doc.outline),
      contentSource: doc.contentSource ?? inferContentSource(doc.type),
      edited: doc.edited === true,
      parserVersion: doc.parserVersion ?? "",
      sourceHash: doc.sourceHash ?? "",
      ocrPages: doc.ocrPages ?? 0,
      ocrEngine: doc.ocrEngine ?? "",
      ocrDpi: doc.ocrDpi ?? 0,
      ocrLang: doc.ocrLang ?? "",
      ocrModel: doc.ocrModel ?? "best",
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

async function writeManifestAtomic(dir, manifest) {
  const from = manifest[MIGRATED_FROM];
  if (Number.isFinite(from) && from < SCHEMA_VERSION) {
    const backup = join(dir, "kb.json.v1.bak");
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
      ...entry,
      status: "importing",
      version: prev?.version ?? 0,
      importedAt: prev?.importedAt ?? new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
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
      ...entry,
      status: "failed",
      error: entry.error ? String(entry.error).slice(0, 500) : "导入失败",
      // 导入失败不是内容修订，不递增版本号（成功重试时再 +1）
      version: prev?.version ?? 0,
      importedAt: prev?.importedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (prev) manifest.docs[manifest.docs.indexOf(prev)] = row;
    else manifest.docs.push(row);
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
    type,
    pages,
    chars,
    parts,
    outline,
    warnings,
    sourceFile,
    sourceHash,
    parserVersion,
    contentSource,
    ocrPages,
    ocrEngine,
    ocrDpi,
    ocrLang,
    ocrModel,
    edited,
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
      if (stagedSource) {
        await mkdir(join(dir, "sources"), { recursive: true });
        // Windows 上 rename 覆盖已存在目标的兼容性不如 POSIX，先删旧文件
        await rm(join(dir, "sources", sourceName), { force: true });
        await rename(stagedSource, join(dir, "sources", sourceName));
      }
      await rm(join(dir, "markdown", docId), { recursive: true, force: true });
      await rename(stagedDir, join(dir, "markdown", docId));
      const prev = manifest.docs.find((d) => d.id === docId);
      const entry = {
        id: docId,
        title: String(title ?? "").slice(0, 200),
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
        edited: edited === true,
        type,
        pages: pages ?? 0,
        chars: chars ?? 0,
        parts: parts ?? 1,
        outline: Array.isArray(outline) ? outline.slice(0, 200) : [],
        warnings: Array.isArray(warnings) ? warnings.slice(0, 20) : [],
        status: "ready",
        version: (prev?.version ?? 0) + 1,
        importedAt: prev?.importedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
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
export async function removeDoc(dir, docId) {
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    const idx = manifest.docs.findIndex((d) => d.id === docId);
    if (idx < 0) throw new Error(`文档不存在: ${docId}`);
    manifest.docs.splice(idx, 1);
    await writeManifestAtomic(dir, manifest);
  });
  await rm(join(dir, "markdown", docId), { recursive: true, force: true });
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

/** 重命名知识库（目录名 + 清单 name）。 */
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

export function resolveDoc(manifest, ref) {
  if (ref === undefined || ref === null) throw new Error("请提供文档名称或 id");
  const s = String(ref).trim();
  if (s.length === 0) throw new Error("请提供文档名称或 id");
  const docs = manifest.docs ?? [];
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
    out.push({
      name: manifest.name || e.name,
      dir: e.name,
      docs: docs.length,
      ready: docs.filter((d) => d.status === "ready").length,
      importing: docs.filter((d) => d.status === "importing").length,
      failed: docs.filter((d) => d.status === "failed").length,
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
    contentSource: doc.contentSource ?? "",
    stale:
      doc.status === "ready" &&
      doc.type !== "note" &&
      (doc.parserVersion ?? "") !== PARSER_VERSION,
    edited: doc.edited === true,
    hash: doc.sourceHash ? String(doc.sourceHash).slice(0, 12) : "",
    ocrModel: doc.ocrModel ?? "best",
    ...(doc.error ? { error: doc.error } : {}),
    outline: (doc.outline ?? []).slice(0, 12),
  };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

const EXPORT_README = `# 知识库导出包说明

本目录是一个 dsh-knowledge-base 知识库的完整快照，可直接供其他大模型应用阅读：

- kb.json          —— 清单：文档列表、类型、页数、大纲、版本
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
      .map((d, i) => `${i + 1}. ${d.title}（${d.type}，${d.pages ? d.pages + " 页，" : ""}${d.chars} 字）`)
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
    write(`\n<!-- 文档: ${d.id} 类型: ${d.type} 来源: ${d.sourceFile || "-"} 版本: v${d.version} 导入: ${d.updatedAt} -->\n\n`);
    write(body.trimEnd() + "\n\n---\n\n");
  }
  stream.end();
  await done;
  return { bytes, docs: docs.length };
}

export async function exportJsonl(dir, manifest, outPath) {
  const { createWriteStream } = await import("node:fs");
  const { finished } = await import("node:stream/promises");
  const docs = (manifest.docs ?? []).filter((d) => d.status === "ready");
  const stream = createWriteStream(outPath, "utf8");
  let bytes = 0;
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
      writeLine({
        kb: manifest.name,
        docId: d.id,
        title: d.title,
        type: d.type,
        part: 1,
        parts: 1,
        text: "",
      });
      continue;
    }
    for (let i = 0; i < files.length; i++) {
      const text = (await readFile(join(partsDir, files[i]), "utf8")).trim();
      writeLine({
        kb: manifest.name,
        docId: d.id,
        title: d.title,
        type: d.type,
        part: i + 1,
        parts: files.length,
        text,
      });
    }
  }
  stream.end();
  await done;
  return { bytes, docs: docs.length };
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

  const addDir = async (zipDir, absDir) => {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(absDir, e.name);
      if (e.isDirectory()) {
        await addDir(zipDir.folder(e.name), full);
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
  await addDir(zip.folder("markdown"), join(dir, "markdown"));
  if (includeSources) await addDir(zip.folder("sources"), join(dir, "sources"));

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
