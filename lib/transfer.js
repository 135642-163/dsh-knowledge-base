/**
 * 跨库安全移动文档：预检 → 复制暂存并校验 → 目标库提交 → 源库软删除 → 撤销/崩溃恢复。
 *
 * 设计要点：
 * - 任何清单写入前，原文件与 markdown 已复制到目标库的 `.transfer/<transferId>/` 并
 *   逐字节比对大小；目标库清单只在文件落位后原子写入，避免“清单有文档、文件没有”。
 * - 每篇文档一份 journal（`<kbRoot>/.transfers/<transferId>.json`，记录阶段与涉及路径）。
 *   进程崩溃后，下一次 preflight/move 的 sweepTransfers 会按 journal 补齐或清理。
 * - 源库软删除保留 sources/markdown，可用 undoMove 恢复；目标库副本软删除后同样保留文件。
 * - 同一 kbRoot 的 move/undo 用进程内串行锁排队，避免两篇文档互相覆盖清单。
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
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
import { extname, isAbsolute, join, relative } from "node:path";
import {
  expandRoot,
  isDeleted,
  kbDirPath,
  readManifest,
  sanitizeKbName,
  tryReadManifest,
  withManifestLock,
  writeManifestAtomic,
} from "./store.js";
import { findSource } from "./web/data.js";
import { appendLog, refreshIndexIfStale } from "./wiki.js";

/** 单批最多移动的文档数。 */
export const MAX_MOVE_DOCS = 50;
/** 单批最多移动的原始文件总字节数。 */
export const MAX_MOVE_BYTES = 500 * 1024 * 1024;
/** kbRoot 下的跨库移动记录目录。 */
export const TRANSFER_DIR = ".transfers";
/** 目标知识库内的暂存目录（与 sources/markdown 同级）。 */
export const STAGING_DIR = ".transfer";

/**
 * 跨库移动的业务错误：code 供 HTTP 层映射状态码。
 * message 只描述文档标题/知识库名，绝不能带绝对路径。
 */
export class TransferError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "TransferError";
    this.code = code;
    if (details) this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function resolveRoot(kbRoot) {
  const raw = String(kbRoot ?? "").trim();
  if (raw === "") throw new TransferError("TRANSFER_INVALID_REQUEST", "缺少知识库根目录");
  return expandRoot(raw);
}

function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function safeRelative(rel) {
  if (typeof rel !== "string" || rel === "") return false;
  if (isAbsolute(rel)) return false;
  return !rel.split(/[\\/]+/).includes("..");
}

function relFrom(base, abs) {
  return relative(base, abs);
}

/**
 * journal 里的目标相对路径只允许落在 sources/ 或 markdown/ 之下。
 * 返回可安全删除的绝对路径；路径越界/为空/不在指定目录时返回 null（宁可不删）。
 */
function targetPathUnder(targetDir, rel, rootName) {
  if (!safeRelative(rel)) return null;
  const normalized = String(rel).replace(/\\/g, "/");
  const prefix = `${rootName}/`;
  if (!normalized.startsWith(prefix)) return null;
  if (normalized.slice(prefix.length).trim() === "") return null;
  return join(targetDir, rel);
}

/** 目标清单里是否已有文档占用该 id（用于删除前复核，避免误删既有文档）。 */
function targetIdTaken(manifest, newId) {
  if (newId === undefined || newId === null || newId === "") return true;
  return (manifest?.docs ?? []).some((doc) => doc?.id === newId);
}

/** 同一 kbRoot 内串行化 move/undo；不同根互不影响。 */
const rootLocks = new Map();

function withRootLock(root, fn) {
  const key = expandRoot(root);
  const prev = rootLocks.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const stored = run.then(
    () => undefined,
    () => undefined
  );
  rootLocks.set(key, stored);
  return run.finally(() => {
    if (rootLocks.get(key) === stored) rootLocks.delete(key);
  });
}

function nowIso(now) {
  let value;
  try {
    value = typeof now === "function" ? Number(now()) : Number(now);
  } catch {
    value = NaN;
  }
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
}

async function loadKb(root, name, label) {
  let clean;
  try {
    clean = sanitizeKbName(name);
  } catch {
    throw new TransferError("TRANSFER_INVALID_REQUEST", `${label}知识库名称无效`);
  }
  const dir = kbDirPath(root, clean);
  if (!existsSync(join(dir, "kb.json"))) {
    throw new TransferError("TRANSFER_KB_NOT_FOUND", `${label}知识库不存在: ${clean}`);
  }
  const manifest = await tryReadManifest(dir);
  if (!manifest) {
    throw new TransferError("TRANSFER_KB_UNREADABLE", `${label}知识库清单无法读取: ${clean}`);
  }
  return { name: clean, dir, manifest };
}

async function resolveKbs(root, sourceKb, targetKb) {
  const source = await loadKb(root, sourceKb, "源");
  const target = await loadKb(root, targetKb, "目标");
  if (source.dir === target.dir) {
    throw new TransferError("TRANSFER_SAME_KB", "源知识库与目标知识库相同，无需移动");
  }
  if (target.manifest.mergedInto != null) {
    throw new TransferError(
      "TRANSFER_TARGET_MERGED",
      `目标知识库已合并到「${target.manifest.mergedInto}」，不能再接收文档`
    );
  }
  return { source, target };
}

function normalizeDocIds(docIds) {
  if (!Array.isArray(docIds)) {
    throw new TransferError("TRANSFER_INVALID_REQUEST", "ids 必须是文档 id 数组");
  }
  const ids = [];
  const seen = new Set();
  for (const raw of docIds) {
    if (typeof raw !== "string") {
      throw new TransferError("TRANSFER_INVALID_REQUEST", "ids 只能包含字符串");
    }
    const id = raw.trim();
    if (id === "") {
      throw new TransferError("TRANSFER_INVALID_REQUEST", "ids 不能包含空字符串");
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) {
    throw new TransferError("TRANSFER_INVALID_REQUEST", "请选择要移动的文档");
  }
  if (ids.length > MAX_MOVE_DOCS) {
    throw new TransferError(
      "TRANSFER_TOO_MANY",
      `一次最多移动 ${MAX_MOVE_DOCS} 篇文档（本次 ${ids.length} 篇）`,
      { count: ids.length, max: MAX_MOVE_DOCS }
    );
  }
  return ids;
}

function assertByteCap(totalBytes) {
  if (totalBytes > MAX_MOVE_BYTES) {
    throw new TransferError(
      "TRANSFER_TOO_LARGE",
      `一次最多移动 ${formatBytes(MAX_MOVE_BYTES)}（本次 ${formatBytes(totalBytes)}）`,
      { bytes: totalBytes, maxBytes: MAX_MOVE_BYTES }
    );
  }
}

function freshId(manifest) {
  const used = new Set((manifest?.docs ?? []).map((doc) => doc?.id));
  for (;;) {
    const id = randomBytes(6).toString("hex");
    if (!used.has(id)) return id;
  }
}

function titleHit(docs, title) {
  const normalized = normalizeTitle(title);
  if (normalized === "") return null;
  return (docs ?? []).find((doc) => normalizeTitle(doc?.title) === normalized) ?? null;
}

/**
 * 目标库冲突判定：先 id（同名文件会覆盖），再 sourceHash（同内容重复），最后标题。
 * 返回 null 或 { kind, withTitle }，withTitle 是目标库里相撞文档的标题。
 */
function findConflict(manifest, doc, newId) {
  const docs = manifest?.docs ?? [];
  const idDoc = docs.find((item) => item?.id === newId);
  if (idDoc) return { kind: "id", withTitle: String(idDoc.title ?? "") };
  if (doc?.sourceHash) {
    const hashDoc = docs.find((item) => item?.sourceHash && item.sourceHash === doc.sourceHash);
    if (hashDoc) return { kind: "hash", withTitle: String(hashDoc.title ?? "") };
  }
  const titleDoc = titleHit(docs, doc?.title);
  if (titleDoc) return { kind: "title", withTitle: String(titleDoc.title ?? "") };
  return null;
}

/** 目标标题在 rename 模式下的唯一化：追加「（副本）」「（副本 2）」… */
function uniqueCopyTitle(base, docs) {
  const used = new Set((docs ?? []).map((doc) => normalizeTitle(doc?.title)));
  const root = String(base ?? "").trim() || "未命名文档";
  let candidate = `${root}（副本）`;
  for (let n = 2; used.has(normalizeTitle(candidate)); n += 1) {
    candidate = `${root}（副本 ${n}）`;
  }
  return candidate;
}

function skipResult(doc, conflict) {
  const reason = conflict?.kind === "id"
    ? "目标库已有相同 id 的文档"
    : conflict?.kind === "hash"
      ? "目标库已有相同内容的文档"
      : conflict?.kind === "title"
        ? "目标库已有相同标题的文档"
        : "目标库存在冲突";
  return {
    id: doc.id,
    title: String(doc.title ?? ""),
    status: "skipped",
    reason,
    conflict: conflict ?? null,
  };
}

function safeFailureMessage(error) {
  if (error instanceof TransferError) return error.message;
  const code = String(error?.code ?? error?.name ?? "UNKNOWN");
  return `移动失败（${code}）`;
}

// ---------------------------------------------------------------------------
// journal 与暂存
// ---------------------------------------------------------------------------

function journalPath(root, transferId) {
  return join(root, TRANSFER_DIR, `${transferId}.json`);
}

async function writeJournal(root, journal) {
  const dir = join(root, TRANSFER_DIR);
  await mkdir(dir, { recursive: true });
  const file = journalPath(root, journal.transferId);
  const tmp = join(dir, `.${journal.transferId}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, JSON.stringify(journal, null, 2), "utf8");
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}

async function updateJournal(root, journal, stage, patch = {}) {
  const next = { ...journal, ...patch, stage, updatedAt: new Date().toISOString() };
  await writeJournal(root, next);
  return next;
}

async function measureTree(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(child)).size;
      }
    }
  }
  return { files, bytes };
}

async function stageDoc({ sourceDir, targetDir, transferId, doc, found, newId, journal }) {
  const stageRoot = join(targetDir, STAGING_DIR, transferId);
  const stageSourceDir = join(stageRoot, "sources");
  const stageMarkdownRoot = join(stageRoot, "markdown");
  await mkdir(stageSourceDir, { recursive: true });
  await mkdir(stageMarkdownRoot, { recursive: true });

  const stagedSource = join(stageSourceDir, journal.newSourceName);
  await copyFile(found.path, stagedSource);
  const [sourceInfo, stagedInfo] = await Promise.all([stat(found.path), stat(stagedSource)]);
  if (sourceInfo.size !== stagedInfo.size) {
    throw new TransferError("TRANSFER_VERIFY_FAILED", `文档「${doc.title}」复制校验失败：文件大小不一致`);
  }

  const sourceMarkdown = join(sourceDir, "markdown", doc.id);
  const stagedMarkdown = join(stageMarkdownRoot, newId);
  let sourceMeasure;
  try {
    sourceMeasure = await measureTree(sourceMarkdown);
  } catch {
    throw new TransferError("TRANSFER_SOURCE_MISSING", `文档「${doc.title}」的正文文件不存在`);
  }
  await cp(sourceMarkdown, stagedMarkdown, { recursive: true });
  const stagedMeasure = await measureTree(stagedMarkdown);
  if (
    stagedMeasure.files !== sourceMeasure.files
    || stagedMeasure.bytes !== sourceMeasure.bytes
  ) {
    throw new TransferError("TRANSFER_VERIFY_FAILED", `文档「${doc.title}」复制校验失败：正文大小不一致`);
  }
}

/**
 * rename 模式在目标锁内发现 id 冲突时，把暂存文件改到新 id 名下并更新 journal。
 * 暂存文件都还在目标库目录内，rename 是原子的同盘移动。
 */
async function retargetStaged(root, targetDir, journal, newId) {
  const ext = journal.ext ?? extname(journal.sourceFile ?? "");
  const newSourceName = `${newId}${ext}`;
  const oldSource = join(targetDir, journal.files.stagedSource);
  const newSource = join(targetDir, STAGING_DIR, journal.transferId, "sources", newSourceName);
  const oldMarkdown = join(targetDir, journal.files.stagedMarkdown);
  const newMarkdown = join(targetDir, STAGING_DIR, journal.transferId, "markdown", newId);
  if (existsSync(oldSource)) await rename(oldSource, newSource);
  if (existsSync(oldMarkdown)) await rename(oldMarkdown, newMarkdown);
  const next = {
    ...journal,
    newId,
    newSourceName,
    files: {
      ...journal.files,
      stagedSource: relFrom(targetDir, newSource),
      stagedMarkdown: relFrom(targetDir, newMarkdown),
      targetSource: relFrom(targetDir, join(targetDir, "sources", newSourceName)),
      targetMarkdown: relFrom(targetDir, join(targetDir, "markdown", newId)),
    },
  };
  await writeJournal(root, next);
  return next;
}

/**
 * 暂存正文里的合并版文件名是 `<docId>.md`；换新 id 时必须同步改名，
 * 否则目标库的 kb_read/导出会找不到合并版。改标题时同步首行 H1。
 */
async function prepareStagedMarkdown({ stagedMarkdown, docId, newId, title }) {
  const mergedOld = join(stagedMarkdown, `${docId}.md`);
  const mergedNew = join(stagedMarkdown, `${newId}.md`);
  if (newId !== docId && existsSync(mergedOld)) {
    await rename(mergedOld, mergedNew);
  }
  const merged = existsSync(mergedNew) ? mergedNew : null;
  if (!merged) return;
  const text = await readFile(merged, "utf8");
  const newline = text.indexOf("\n");
  const firstLine = newline < 0 ? text : text.slice(0, newline);
  if (!firstLine.startsWith("# ")) return;
  const desired = `# ${title}`;
  if (firstLine === desired || String(title).includes("\n")) return;
  await writeFile(merged, desired + (newline < 0 ? "" : text.slice(newline)), "utf8");
}

/** 目标清单提交前把暂存文件移入正式位置（先文件，后清单）。 */
async function mountStaged(targetDir, journal) {
  const stagedSource = join(targetDir, journal.files.stagedSource);
  const stagedMarkdown = join(targetDir, journal.files.stagedMarkdown);
  const targetSource = join(targetDir, journal.files.targetSource);
  const targetMarkdown = join(targetDir, journal.files.targetMarkdown);
  await mkdir(join(targetDir, "sources"), { recursive: true });
  await mkdir(join(targetDir, "markdown"), { recursive: true });
  await rm(targetSource, { force: true });
  await rename(stagedSource, targetSource);
  await rm(targetMarkdown, { recursive: true, force: true });
  await rename(stagedMarkdown, targetMarkdown);
  await rm(join(targetDir, STAGING_DIR, journal.transferId), { recursive: true, force: true });
}

/**
 * 放弃本次尝试：清理暂存目录与 journal。
 * 目标库路径（sources/markdown）只有在 journal.mounted === true（文件确已由本次移动落位）
 * 且目标清单没有同 id 文档时才删除；commit 时才发现 id 冲突（skip）的情况下目标路径
 * 属于既有文档，绝不能一并删掉。导出供回归测试直接覆盖该清理路径。
 */
export async function discardAttempt(root, targetDir, journal) {
  const jobs = [
    rm(join(targetDir, STAGING_DIR, journal.transferId), { recursive: true, force: true }),
    rm(journalPath(root, journal.transferId), { force: true }),
  ];
  if (journal?.mounted === true) {
    const manifest = await tryReadManifest(targetDir);
    // 清单读不到时无法确认所有权，保守保留目标文件，只清暂存与 journal。
    if (manifest && !targetIdTaken(manifest, journal.newId)) {
      const targetSource = targetPathUnder(targetDir, journal.files?.targetSource, "sources");
      if (targetSource) jobs.push(rm(targetSource, { force: true }));
      const targetMarkdown = targetPathUnder(targetDir, journal.files?.targetMarkdown, "markdown");
      if (targetMarkdown) jobs.push(rm(targetMarkdown, { recursive: true, force: true }));
    }
  }
  await Promise.all(jobs.map((job) => job.catch(() => {})));
}

function targetEntry({ doc, journal, newId, title, sourceKb, at }) {
  // 目标条目从源文档当时的版本开始；撤销时用它判断目标副本是否被 kb_edit 改过。
  const movedVersion = Number.isFinite(Number(doc.version)) && Number(doc.version) > 0
    ? Number(doc.version)
    : 1;
  const entry = {
    ...doc,
    id: newId,
    title,
    version: movedVersion,
    sourceFile: journal.newSourceName,
    sourcePath: doc.sourcePath ?? "",
    // 保留原始外部路径，便于之后重解析时仍能定位来源（与 import 的 storedSourcePath 同义）。
    storedSourcePath: doc.sourcePath ?? "",
    transferId: journal.transferId,
    movedFrom: { kb: sourceKb, docId: doc.id, at, version: movedVersion },
    status: "ready",
    updatedAt: at,
  };
  delete entry.deletedAt;
  delete entry.deletedFromStatus;
  delete entry.movedTo;
  delete entry.movedFromUndo;
  // 历史版本目录没有随移动复制；保留元数据只会让 kb_history 指向不存在的快照。
  delete entry.history;
  return entry;
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

async function inspectMove({ kbRoot, sourceKb, targetKb, docIds }) {
  const root = resolveRoot(kbRoot);
  // 上一次崩溃留下的 journal 先补齐/清理，避免冲突判定看到半成品。
  await sweepTransfers(root);
  const { source, target } = await resolveKbs(root, sourceKb, targetKb);
  const ids = normalizeDocIds(docIds);
  const docs = [];
  let totalBytes = 0;
  for (const id of ids) {
    const doc = (source.manifest.docs ?? []).find((item) => item?.id === id);
    if (!doc) throw new TransferError("TRANSFER_DOC_NOT_FOUND", `文档不存在: ${id}`);
    if (isDeleted(doc)) {
      throw new TransferError("TRANSFER_DOC_DELETED", `文档已删除: ${doc.title ?? id}`);
    }
    if (doc.status !== "ready") {
      throw new TransferError(
        "TRANSFER_DOC_NOT_READY",
        `文档「${doc.title ?? id}」状态为 ${doc.status ?? "unknown"}，仅就绪文档可以移动`
      );
    }
    let found = null;
    try {
      found = await findSource(root, source.name, doc.id);
    } catch {
      found = null;
    }
    if (!found) {
      throw new TransferError("TRANSFER_SOURCE_MISSING", `文档「${doc.title ?? doc.id}」的原件不存在`);
    }
    const conflict = findConflict(target.manifest, doc, doc.id);
    docs.push({ doc, found, conflict });
    totalBytes += Number(found.size) || 0;
  }
  assertByteCap(totalBytes);
  return { root, source, target, docs, totalBytes };
}

/**
 * 移动前预检：校验两个知识库、文档可用性、批次上限，并给出目标库冲突。
 * 与 move/undo 共用同一把根锁，避免预检里的 sweep 清掉另一个进行中的暂存。
 * @returns {Promise<{docs: Array<{id,title,sourceFile,size,conflict}>, totalBytes: number}>}
 */
export async function preflightMove({ kbRoot, sourceKb, targetKb, docIds } = {}) {
  const root = resolveRoot(kbRoot);
  return withRootLock(root, async () => {
    const { docs, totalBytes } = await inspectMove({ kbRoot: root, sourceKb, targetKb, docIds });
    return {
      docs: docs.map(({ doc, found, conflict }) => ({
        id: doc.id,
        title: String(doc.title ?? ""),
        sourceFile: found.name,
        size: found.size,
        conflict,
      })),
      totalBytes,
    };
  });
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

async function commitTarget({ root, source, target, doc, journal, mode, at }) {
  let committed = false;
  let current = journal;
  let decision = null;
  try {
    await withManifestLock(target.dir, async () => {
      const manifest = await readManifest(target.dir);
      let next = journal;
      let finalId = journal.newId;

      let idDoc = (manifest.docs ?? []).find((item) => item?.id === finalId);
      if (idDoc) {
        if (mode === "skip") {
          decision = { status: "skipped", journal: current, conflict: { kind: "id", withTitle: String(idDoc.title ?? "") } };
          return;
        }
        finalId = freshId(manifest);
        next = await retargetStaged(root, target.dir, next, finalId);
        current = next;
      }

      if (doc.sourceHash) {
        const hashDoc = (manifest.docs ?? []).find(
          (item) => item?.sourceHash && item.sourceHash === doc.sourceHash
        );
        if (hashDoc) {
          // 同内容已存在：改名只会制造真重复，skip/rename 都跳过。
          decision = {
            status: "skipped",
            journal: current,
            conflict: { kind: "hash", withTitle: String(hashDoc.title ?? "") },
          };
          return;
        }
      }

      let finalTitle = String(doc.title ?? "");
      const titleDoc = titleHit(manifest.docs, finalTitle);
      if (titleDoc) {
        if (mode === "skip") {
          decision = {
            status: "skipped",
            journal: current,
            conflict: { kind: "title", withTitle: String(titleDoc.title ?? "") },
          };
          return;
        }
        finalTitle = uniqueCopyTitle(finalTitle, manifest.docs);
      }

      next = { ...next, newId: finalId, title: finalTitle };
      await prepareStagedMarkdown({
        stagedMarkdown: join(target.dir, next.files.stagedMarkdown),
        docId: doc.id,
        newId: finalId,
        title: finalTitle,
      });
      // 先持久化 mounted 标记再落位：journal 明确记录“目标路径归本次移动所有”，
      // 之后 discardAttempt 才允许删除目标路径；此前失败只清暂存，绝不碰既有文件。
      next = await updateJournal(root, next, next.stage ?? "staged", { mounted: true });
      current = next;
      await mountStaged(target.dir, next);
      const entry = targetEntry({ doc, journal: next, newId: finalId, title: finalTitle, sourceKb: source.name, at });
      manifest.docs.push(entry);
      // 只有文件全部落位后才写清单；写成功即视为目标侧已提交。
      await writeManifestAtomic(target.dir, manifest);
      committed = true;
      try {
        current = await updateJournal(root, next, "target-done");
      } catch {
        /* journal 更新失败由 sweep 兜底：目标清单里的 transferId 已足够识别 */
      }
      decision = { status: "moved", journal: next, manifest, entry };
    });
  } catch (error) {
    if (!committed) await discardAttempt(root, target.dir, current);
    throw error;
  }
  return { decision, committed };
}

async function finalizeSource({ source, target, journal, at }) {
  let result = { status: "not-ready" };
  await withManifestLock(source.dir, async () => {
    const manifest = await readManifest(source.dir);
    const index = (manifest.docs ?? []).findIndex((item) => item?.id === journal.docId);
    if (index < 0) {
      result = { status: "missing" };
      return;
    }
    const current = manifest.docs[index];
    const movedTo = {
      kb: target.name,
      docId: journal.newId,
      transferId: journal.transferId,
      at,
    };
    if (isDeleted(current)) {
      if (current.movedTo?.transferId !== journal.transferId) {
        // 并发软删除：保留目标副本，补齐 movedTo 让状态自解释。
        manifest.docs[index] = { ...current, movedTo, updatedAt: at };
        await writeManifestAtomic(source.dir, manifest);
      }
      result = { status: "done", manifest };
      return;
    }
    if (current.status !== "ready") {
      result = { status: "not-ready" };
      return;
    }
    manifest.docs[index] = {
      ...current,
      status: "deleted",
      deletedAt: at,
      deletedFromStatus: current.status,
      movedTo,
      updatedAt: at,
    };
    await writeManifestAtomic(source.dir, manifest);
    result = { status: "done", manifest };
  });
  return result;
}

async function rollbackCommittedTarget({ target, journal }) {
  try {
    await withManifestLock(target.dir, async () => {
      const manifest = await readManifest(target.dir);
      const index = (manifest.docs ?? []).findIndex(
        (item) => item?.id === journal.newId && item.transferId === journal.transferId
      );
      if (index < 0) return;
      manifest.docs.splice(index, 1);
      await writeManifestAtomic(target.dir, manifest);
    });
  } catch {
    /* 回滚清单失败时保留 journal，交给 sweep 清理；文件先不删。 */
    return false;
  }
  await rm(join(target.dir, journal.files.targetSource), { force: true }).catch(() => {});
  await rm(join(target.dir, journal.files.targetMarkdown), { recursive: true, force: true }).catch(() => {});
  return true;
}

async function moveOne({ root, source, target, docId, mode, at }) {
  const sourceManifest = await tryReadManifest(source.dir);
  if (!sourceManifest) {
    throw new TransferError("TRANSFER_KB_UNREADABLE", `源知识库清单无法读取: ${source.name}`);
  }
  const doc = (sourceManifest.docs ?? []).find((item) => item?.id === docId);
  if (!doc) throw new TransferError("TRANSFER_DOC_NOT_FOUND", `文档不存在: ${docId}`);
  if (isDeleted(doc)) throw new TransferError("TRANSFER_DOC_DELETED", `文档已删除: ${doc.title ?? docId}`);
  if (doc.status !== "ready") {
    throw new TransferError(
      "TRANSFER_DOC_NOT_READY",
      `文档「${doc.title ?? docId}」状态为 ${doc.status ?? "unknown"}，仅就绪文档可以移动`
    );
  }
  const found = await findSource(root, source.name, doc.id);
  if (!found) {
    throw new TransferError("TRANSFER_SOURCE_MISSING", `文档「${doc.title ?? doc.id}」的原件不存在`);
  }
  const targetManifest = await tryReadManifest(target.dir);
  if (!targetManifest) {
    throw new TransferError("TRANSFER_KB_UNREADABLE", `目标知识库清单无法读取: ${target.name}`);
  }

  const conflict = findConflict(targetManifest, doc, doc.id);
  if (mode === "skip" && conflict) return skipResult(doc, conflict);
  if (mode === "rename" && conflict?.kind === "hash") return skipResult(doc, conflict);
  if (mode === "rename" && conflict?.kind === "title") {
    // 标题冲突可以改名解决，保留原 docId（stage 时不需要目标清单）。
  }

  let initialId = doc.id;
  if (mode === "rename" && conflict?.kind === "id") initialId = freshId(targetManifest);

  const transferId = randomBytes(8).toString("hex");
  // 更稳妥地保留完整后缀（如 .tar.gz）：源文件一定以 docId 开头。
  const suffix = found.name.startsWith(doc.id)
    ? found.name.slice(doc.id.length)
    : extname(found.name);
  const ext = suffix || extname(String(doc.sourceFile ?? ""));
  const newSourceName = `${initialId}${ext}`;
  const stageRoot = join(target.dir, STAGING_DIR, transferId);
  let journal = {
    version: 1,
    transferId,
    sourceKb: source.name,
    targetKb: target.name,
    docId: doc.id,
    sourceTitle: String(doc.title ?? ""),
    newId: initialId,
    title: String(doc.title ?? ""),
    sourceFile: found.name,
    newSourceName,
    ext,
    stage: "staging",
    files: {
      stagedSource: relFrom(target.dir, join(stageRoot, "sources", newSourceName)),
      stagedMarkdown: relFrom(target.dir, join(stageRoot, "markdown", initialId)),
      targetSource: relFrom(target.dir, join(target.dir, "sources", newSourceName)),
      targetMarkdown: relFrom(target.dir, join(target.dir, "markdown", initialId)),
    },
    at,
    updatedAt: at,
  };

  try {
    await writeJournal(root, journal);
    await stageDoc({ sourceDir: source.dir, targetDir: target.dir, transferId, doc, found, newId: initialId, journal });
    journal = await updateJournal(root, journal, "staged");
  } catch (error) {
    await discardAttempt(root, target.dir, journal);
    throw error;
  }

  const { decision } = await commitTarget({ root, source, target, doc, journal, mode, at });
  if (decision.status === "skipped") {
    await discardAttempt(root, target.dir, decision.journal ?? journal);
    return skipResult(doc, decision.conflict);
  }
  journal = decision.journal;

  const finalized = await finalizeSource({ source, target, journal, at });
  if (finalized.status !== "done") {
    const rolledBack = await rollbackCommittedTarget({ target, journal });
    if (rolledBack) await discardAttempt(root, target.dir, journal);
    throw new TransferError(
      "TRANSFER_SOURCE_CHANGED",
      finalized.status === "missing"
        ? `文档「${doc.title ?? doc.id}」已不存在，移动已取消`
        : `文档「${doc.title ?? doc.id}」状态已变化，移动已取消`
    );
  }

  // 到这里两库清单都已更新；日志/索引/journal 清理都是附属动作，失败不影响结果。
  try {
    await updateJournal(root, journal, "source-done");
  } catch {
    /* sweep 会按目标清单里的 transferId 识别并清理 */
  }
  await appendLog(source.dir, {
    action: "move",
    title: String(doc.title ?? doc.id),
    docId: doc.id,
    detail: `跨库移动到「${target.name}」（新 id ${journal.newId}）`,
  });
  await appendLog(target.dir, {
    action: "move",
    title: journal.title,
    docId: journal.newId,
    detail: `从「${source.name}」移入`,
  });
  await Promise.all([
    refreshIndexIfStale(source.dir, finalized.manifest).catch(() => {}),
    refreshIndexIfStale(target.dir, decision.manifest).catch(() => {}),
  ]);
  await rm(journalPath(root, transferId), { force: true }).catch(() => {});

  return {
    id: doc.id,
    title: String(doc.title ?? ""),
    status: "moved",
    newId: journal.newId,
    newTitle: journal.title,
    transferId,
  };
}

/**
 * 批量移动文档（同步）。逐篇事务；单篇失败不影响后续，结果里逐条报告。
 * @param options.onConflict "skip"（默认）跳过冲突文档；"rename" 给标题/重名 id 让路
 * @returns {Promise<{transferId?: string, results: Array, moved: number, skipped: number, failed: number}>}
 */
export async function moveDocs({
  kbRoot,
  sourceKb,
  targetKb,
  docIds,
  onConflict = "skip",
  now = Date.now,
} = {}) {
  const root = resolveRoot(kbRoot);
  const mode = onConflict ?? "skip";
  if (mode !== "skip" && mode !== "rename") {
    throw new TransferError("TRANSFER_INVALID_REQUEST", "onConflict 只能是 skip 或 rename");
  }
  return withRootLock(root, async () => {
    // 预检在锁内重新执行：预检结果只用来确定要处理哪些 id。
    const plan = await inspectMove({ kbRoot: root, sourceKb, targetKb, docIds });
    const results = [];
    let lastTransferId = null;
    for (const item of plan.docs) {
      const at = nowIso(now);
      try {
        const result = await moveOne({
          root,
          source: plan.source,
          target: plan.target,
          docId: item.doc.id,
          mode,
          at,
        });
        if (result.transferId) lastTransferId = result.transferId;
        results.push(result);
      } catch (error) {
        results.push({
          id: item.doc.id,
          title: String(item.doc.title ?? ""),
          status: "failed",
          error: safeFailureMessage(error),
        });
      }
    }
    const moved = results.filter((item) => item.status === "moved").length;
    const skipped = results.filter((item) => item.status === "skipped").length;
    const failed = results.filter((item) => item.status === "failed").length;
    return {
      ...(moved === 1 && lastTransferId ? { transferId: lastTransferId } : {}),
      results,
      moved,
      skipped,
      failed,
    };
  });
}

// ---------------------------------------------------------------------------
// 崩溃恢复
// ---------------------------------------------------------------------------

async function sweepJournal(root, file, journal, summary) {
  // transferId 会参与路径拼接：只接受本模块生成的十六进制 id，避免被伪造 journal 带出目标目录。
  const transferId = typeof journal?.transferId === "string" && /^[0-9a-f]{8,64}$/i.test(journal.transferId)
    ? journal.transferId
    : "";
  if (
    transferId === ""
    || typeof journal?.sourceKb !== "string"
    || typeof journal?.targetKb !== "string"
  ) {
    return;
  }
  let targetDir;
  let sourceDir;
  try {
    targetDir = kbDirPath(root, journal.targetKb);
    sourceDir = kbDirPath(root, journal.sourceKb);
  } catch {
    return;
  }
  const targetManifest = await tryReadManifest(targetDir);
  const targetDoc = (targetManifest?.docs ?? []).find((doc) => doc?.transferId === transferId);

  if (targetDoc) {
    // 目标清单已提交：把源文档的删除状态补齐（幂等），再清理暂存。
    const sourceManifest = await tryReadManifest(sourceDir);
    const sourceDoc = (sourceManifest?.docs ?? []).find((doc) => doc?.id === journal.docId);
    if (sourceDoc && existsSync(join(sourceDir, "kb.json"))) {
      let repaired = false;
      await withManifestLock(sourceDir, async () => {
        const manifest = await readManifest(sourceDir);
        const index = (manifest.docs ?? []).findIndex((doc) => doc?.id === journal.docId);
        if (index < 0) return;
        const current = manifest.docs[index];
        if (isDeleted(current) && current.movedTo?.transferId === transferId) return;
        const at = new Date().toISOString();
        manifest.docs[index] = {
          ...current,
          status: "deleted",
          deletedAt: current.deletedAt ?? at,
          deletedFromStatus:
            current.deletedFromStatus ?? (current.status === "deleted" ? "ready" : current.status),
          movedTo: {
            kb: targetManifest.name || journal.targetKb,
            docId: targetDoc.id,
            transferId,
            at,
          },
          updatedAt: at,
        };
        await writeManifestAtomic(sourceDir, manifest);
        repaired = true;
      });
      if (repaired) {
        summary.repaired += 1;
        await appendLog(sourceDir, {
          action: "move",
          title: String(sourceDoc.title ?? journal.sourceTitle ?? journal.docId ?? ""),
          docId: journal.docId,
          detail: `崩溃恢复：补齐跨库移动到「${journal.targetKb}」`,
        });
        const refreshed = await tryReadManifest(sourceDir);
        if (refreshed) await refreshIndexIfStale(sourceDir, refreshed).catch(() => {});
      }
    }
    await rm(join(targetDir, STAGING_DIR, transferId), { recursive: true, force: true });
    await rm(file, { force: true });
    summary.cleaned += 1;
    summary.removed += 1;
    return;
  }

  // 目标清单没有该 transferId：清理暂存与碰巧写入的目标文件（只删 journal 记录的路径）。
  const collides = (targetManifest?.docs ?? []).some((doc) => doc?.id === journal.newId);
  if (!collides) {
    // 路径必须落在 sources/ / markdown/ 之下；伪造或损坏的 journal 不能借 sweep 删库内其它文件。
    const targetSource = targetPathUnder(targetDir, journal.files?.targetSource, "sources");
    if (targetSource) await rm(targetSource, { force: true });
    const targetMarkdown = targetPathUnder(targetDir, journal.files?.targetMarkdown, "markdown");
    if (targetMarkdown) await rm(targetMarkdown, { recursive: true, force: true });
  }
  await rm(join(targetDir, STAGING_DIR, transferId), { recursive: true, force: true });
  await rm(file, { force: true });
  summary.cleaned += 1;
  summary.removed += 1;
}

/**
 * 扫描 `<kbRoot>/.transfers/*.json`，收敛崩溃留下的半成品：
 * - 目标清单已有该 transferId：确保源文档已删除并带 movedTo；
 * - 目标清单没有：删除暂存目录与 journal 记录过的目标文件。
 * 只在真正修补了源库状态时写日志。
 */
export async function sweepTransfers(kbRoot) {
  const summary = { scanned: 0, repaired: 0, cleaned: 0, removed: 0 };
  let root;
  try {
    root = resolveRoot(kbRoot);
  } catch {
    return summary;
  }
  let names;
  try {
    names = (await readdir(join(root, TRANSFER_DIR))).filter((name) => name.endsWith(".json"));
  } catch {
    return summary;
  }
  for (const name of names) {
    summary.scanned += 1;
    const file = join(root, TRANSFER_DIR, name);
    let journal;
    try {
      journal = JSON.parse(await readFile(file, "utf8"));
    } catch {
      // 损坏的 journal 无法安全清理，留给人工排查。
      continue;
    }
    try {
      await sweepJournal(root, file, journal, summary);
    } catch {
      /* 单条失败不阻塞其余记录；下一次 sweep 再试 */
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 撤销
// ---------------------------------------------------------------------------

/**
 * 撤销一次跨库移动：源文档恢复为移动前状态，目标副本软删除（两边的文件都保留）。
 * 目标副本被改动/删除（状态变化、edited 标记或 version 与移动时不一致）时拒绝撤销，
 * 避免覆盖用户在目标库里的新内容。
 */
export async function undoMove({ kbRoot, sourceKb, targetKb, sourceDocId } = {}) {
  const root = resolveRoot(kbRoot);
  const docId = typeof sourceDocId === "string" ? sourceDocId.trim() : "";
  if (docId === "") {
    throw new TransferError("TRANSFER_INVALID_REQUEST", "缺少要撤销的源文档 id");
  }
  return withRootLock(root, async () => {
    await sweepTransfers(root);
    const { source, target } = await resolveKbs(root, sourceKb, targetKb);
    let outcome = null;

    await withManifestLock(source.dir, async () => {
      const sourceManifest = await readManifest(source.dir);
      const sourceIndex = (sourceManifest.docs ?? []).findIndex((doc) => doc?.id === docId);
      const sourceDoc = sourceIndex >= 0 ? sourceManifest.docs[sourceIndex] : null;
      if (!sourceDoc || !isDeleted(sourceDoc)) {
        throw new TransferError(
          "TRANSFER_UNDO_UNAVAILABLE",
          "源文档不存在或不是已移动状态，无法撤销"
        );
      }
      const movedTo = sourceDoc.movedTo;
      if (!movedTo || movedTo.kb !== target.name) {
        throw new TransferError(
          "TRANSFER_UNDO_UNAVAILABLE",
          `源文档没有指向「${target.name}」的移动记录，无法撤销`
        );
      }

      await withManifestLock(target.dir, async () => {
        const targetManifest = await readManifest(target.dir);
        const targetDocId = typeof movedTo.docId === "string" && movedTo.docId !== ""
          ? movedTo.docId
          : docId;
        const targetIndex = (targetManifest.docs ?? []).findIndex((doc) => doc?.id === targetDocId);
        const targetDoc = targetIndex >= 0 ? targetManifest.docs[targetIndex] : null;
        if (!targetDoc || isDeleted(targetDoc) || targetDoc.status !== "ready") {
          throw new TransferError(
            "TRANSFER_UNDO_UNAVAILABLE",
            "目标库副本已被修改或删除，无法撤销这次移动"
          );
        }
        if (!movedTo.transferId || targetDoc.transferId !== movedTo.transferId) {
          throw new TransferError(
            "TRANSFER_UNDO_UNAVAILABLE",
            "目标库副本与移动记录不匹配，无法撤销"
          );
        }
        // 目标副本在移动后动过（kb_edit 会设置 edited 并递增 version），撤销会覆盖用户新内容。
        // 以目标条目自己的 movedFrom.version 为准：它记录移动提交时源文档的版本（旧记录默认 1）。
        const movedVersion = Number.isFinite(Number(targetDoc.movedFrom?.version))
          && Number(targetDoc.movedFrom.version) > 0
          ? Number(targetDoc.movedFrom.version)
          : 1;
        const targetVersion = Number.isFinite(Number(targetDoc.version)) && Number(targetDoc.version) > 0
          ? Number(targetDoc.version)
          : 1;
        if (targetDoc.edited === true || targetVersion !== movedVersion) {
          throw new TransferError(
            "TRANSFER_UNDO_UNAVAILABLE",
            "目标副本已被修改，无法撤销移动"
          );
        }

        const at = new Date().toISOString();
        // 先软删除目标副本：中途崩溃时两份都处于“已删除”，不会出现两份可用副本。
        targetManifest.docs[targetIndex] = {
          ...targetDoc,
          status: "deleted",
          deletedAt: at,
          deletedFromStatus: targetDoc.status,
          movedFromUndo: true,
          updatedAt: at,
        };
        await writeManifestAtomic(target.dir, targetManifest);
        try {
          const restoredStatus = sourceDoc.deletedFromStatus === "failed" ? "failed" : "ready";
          const restored = { ...sourceDoc, status: restoredStatus, updatedAt: at };
          delete restored.deletedAt;
          delete restored.deletedFromStatus;
          delete restored.movedTo;
          sourceManifest.docs[sourceIndex] = restored;
          await writeManifestAtomic(source.dir, sourceManifest);
          outcome = {
            source: restored,
            target: targetManifest.docs[targetIndex],
            sourceManifest,
            targetManifest,
          };
        } catch (error) {
          // 源库恢复失败：把目标副本回滚为可用状态，避免两边都被删。
          targetManifest.docs[targetIndex] = targetDoc;
          await writeManifestAtomic(target.dir, targetManifest).catch(() => {});
          if (error instanceof TransferError) throw error;
          throw new TransferError("TRANSFER_IO_FAILED", "撤销移动失败：无法恢复源文档");
        }
      });
    });

    await appendLog(source.dir, {
      action: "restore",
      title: String(outcome.source.title ?? ""),
      docId: outcome.source.id,
      detail: `撤销跨库移动：从「${target.name}」移回`,
    });
    await appendLog(target.dir, {
      action: "remove",
      title: String(outcome.target.title ?? ""),
      docId: outcome.target.id,
      detail: "撤销跨库移动：保留文件并软删除副本",
    });
    await Promise.all([
      refreshIndexIfStale(source.dir, outcome.sourceManifest).catch(() => {}),
      refreshIndexIfStale(target.dir, outcome.targetManifest).catch(() => {}),
    ]);
    return { source: outcome.source, target: outcome.target };
  });
}
