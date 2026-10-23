/**
 * 上传批次：目录布局 <kb>/import-tmp/ui-batches/<batchId>/，
 * batch.json 原子写 + 批次内串行队列；PUT 走流式落盘与逐段路径校验。
 * 流式写盘在锁外进行，只有提交（rename + 更新 batch.json）才进锁，
 * 因此并发上传可以并行收流、串行提交。导入（importBatch）在 Task 5 追加。
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { SUPPORTED_EXTS } from "../parsers.js";
import { WebError, readRawToFile } from "./http.js";

export const BATCH_SUBDIR = "ui-batches";
const BATCH_ID_RE = /^b-[0-9a-f]{12}$/;
const MAX_REL_PATH = 400;
const MAX_COMPONENT_BYTES = 255;
const OLD_BATCH_MS = 24 * 3600 * 1000;
const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
const DEFAULT_MAX_BATCH_FILES = 1000;

const batchQueues = new Map();

/** 同批次写入串行化：并发 2 的上传不会丢 batch.json 里的文件条目。 */
export function withBatchLock(key, task) {
  const prev = batchQueues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  const guarded = next.catch(() => {});
  batchQueues.set(key, guarded);
  guarded.finally(() => {
    if (batchQueues.get(key) === guarded) batchQueues.delete(key);
  });
  return next;
}

export function uiBatchesRoot(kbDir) {
  return join(kbDir, "import-tmp", BATCH_SUBDIR);
}

export function batchDirFor(kbDir, batchId) {
  return join(uiBatchesRoot(kbDir), batchId);
}

function assertBatchId(batchId) {
  if (!BATCH_ID_RE.test(String(batchId ?? ""))) {
    throw new WebError("BATCH_INVALID", 400, "上传批次 id 非法");
  }
}

/** 缺省/缺失字段回落到工作台默认限额（2 GiB、1000 个文件、支持的全部扩展名）。 */
export function normalizeLimits(limits) {
  return {
    maxUploadBytes: Math.max(1, Math.round(Number(limits?.maxUploadBytes) || DEFAULT_MAX_UPLOAD_BYTES)),
    maxBatchFiles: Math.max(1, Math.round(Number(limits?.maxBatchFiles) || DEFAULT_MAX_BATCH_FILES)),
    extensions: Array.isArray(limits?.extensions) && limits.extensions.length > 0 ? limits.extensions : SUPPORTED_EXTS,
  };
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    try {
      await rename(tmp, path);
    } catch (error) {
      // Windows 上 rename 覆盖已存在文件会 EPERM/EBUSY：删掉旧文件后重试一次。
      if (error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
      await rm(path, { force: true }).catch(() => {});
      await rename(tmp, path);
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export function validateRelPath(raw) {
  const value = String(raw ?? "").normalize("NFC");
  if (value === "" || value.length > MAX_REL_PATH) {
    throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径为空或过长");
  }
  if (value.includes("\\") || isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径不能是绝对路径或包含反斜杠");
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径包含控制字符");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径包含非法片段");
  }
  for (const part of parts) {
    if (Buffer.byteLength(part) > MAX_COMPONENT_BYTES) {
      throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径片段超过 255 字节");
    }
    // Windows 会静默去掉结尾的点和空格，导致落盘名与记录不一致。
    if (part.endsWith(".") || part.endsWith(" ")) {
      throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径片段不能以点或空格结尾");
    }
  }
  return parts.join("/");
}

export function assertSupportedType(relPath) {
  const ext = extname(relPath).toLowerCase();
  if (!SUPPORTED_EXTS.includes(ext)) {
    throw new WebError("UNSUPPORTED_TYPE", 415, `不支持的文件类型 "${ext || "无扩展名"}"`, { extensions: SUPPORTED_EXTS });
  }
  return ext;
}

function resolveBatchPath(batchDir, relPath) {
  const base = resolve(batchDir);
  const abs = resolve(base, relPath);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径越界");
  }
  return abs;
}

/** 大小写变体在大小写不敏感文件系统上会落到同一 docId；只允许原样路径覆盖同名文件。 */
function assertNoCaseDuplicate(files, rel) {
  const lower = rel.toLowerCase();
  const clash = files.some((file) => file.path !== rel && file.path.toLowerCase() === lower);
  if (clash) throw new WebError("UPLOAD_PATH_INVALID", 400, "同一文件大小写重复");
}

function assertFileCount(files, rel, maxBatchFiles) {
  const exists = files.some((file) => file.path === rel);
  if (!exists && files.length + 1 > maxBatchFiles) {
    throw new WebError("BATCH_TOO_MANY_FILES", 413, `单批最多 ${maxBatchFiles} 个文件`, { maxFiles: maxBatchFiles });
  }
}

export async function createUploadBatch({ kbDir, kb, now = Date.now() }) {
  await mkdir(uiBatchesRoot(kbDir), { recursive: true });
  let batchId = "";
  let dir = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `b-${randomBytes(6).toString("hex")}`;
    const candidateDir = batchDirFor(kbDir, candidate);
    try {
      await mkdir(candidateDir);
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    batchId = candidate;
    dir = candidateDir;
    break;
  }
  if (dir === "") throw new WebError("UPLOAD_FAILED", 500, "无法分配上传批次目录");
  const stamp = new Date(now).toISOString();
  const batch = { version: 1, batchId, kb, createdAt: stamp, updatedAt: stamp, status: "open", files: [] };
  try {
    await writeJsonAtomic(join(dir, "batch.json"), batch);
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { batch, dir };
}

export async function readBatch(kbDir, batchId) {
  assertBatchId(batchId);
  const path = join(batchDirFor(kbDir, batchId), "batch.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new WebError("BATCH_NOT_FOUND", 404, "上传批次不存在");
    throw new WebError("BATCH_INVALID", 400, "批次元数据损坏");
  }
}

async function writeBatch(kbDir, batchId, batch) {
  const path = join(batchDirFor(kbDir, batchId), "batch.json");
  await writeJsonAtomic(path, batch);
  return batch;
}

/** 按 id 找到批次所属的知识库目录（URL 不带 kb）。 */
export async function findBatchKbDir(kbRoot, batchId) {
  assertBatchId(batchId);
  const entries = await readdir(kbRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const kbDir = join(kbRoot, entry.name);
    if (existsSync(join(batchDirFor(kbDir, batchId), "batch.json"))) return kbDir;
  }
  throw new WebError("BATCH_NOT_FOUND", 404, "上传批次不存在");
}

export async function addBatchFile({ kbDir, batchId, relPath, source, limits }) {
  const caps = normalizeLimits(limits);
  const rel = validateRelPath(relPath);
  assertSupportedType(rel);

  // 锁外快速失败：状态、大小写冲突、文件数都先按当前快照检查一次。
  const initial = await readBatch(kbDir, batchId);
  if (initial.status !== "open") throw new WebError("BATCH_LOCKED", 409, "批次已锁定，不能继续上传");
  assertNoCaseDuplicate(initial.files, rel);
  assertFileCount(initial.files, rel, caps.maxBatchFiles);

  const dir = batchDirFor(kbDir, batchId);
  const target = resolveBatchPath(dir, rel);
  const tmp = join(dir, `.upload-${randomBytes(6).toString("hex")}.part`);
  try {
    // 收流不进锁：多个 PUT 可以并行写各自的临时文件。
    const { size } = await readRawToFile(source, tmp, { maxBytes: caps.maxUploadBytes });
    return await withBatchLock(batchId, async () => {
      // 提交前重读，锁内重新校验（状态可能被导入锁定、文件可能被并发 PUT 改动）。
      const batch = await readBatch(kbDir, batchId);
      if (batch.status !== "open") throw new WebError("BATCH_LOCKED", 409, "批次已锁定，不能继续上传");
      assertNoCaseDuplicate(batch.files, rel);
      assertFileCount(batch.files, rel, caps.maxBatchFiles);
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { force: true }).catch(() => {});
      await rename(tmp, target);
      if (batch.files.some((file) => file.path === rel)) {
        batch.files = batch.files.map((file) => (file.path === rel ? { path: rel, size } : file));
      } else {
        batch.files.push({ path: rel, size });
      }
      batch.updatedAt = new Date().toISOString();
      await writeBatch(kbDir, batchId, batch);
      return { path: rel, size };
    });
  } finally {
    // rename 成功后 tmp 已不存在；任何失败路径都由这里清掉临时文件。
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export async function removeUploadBatch(kbDir, batchId) {
  assertBatchId(batchId);
  await rm(batchDirFor(kbDir, batchId), { recursive: true, force: true });
}

export async function discardOpenBatch(kbDir, batchId) {
  return withBatchLock(batchId, async () => {
    const batch = await readBatch(kbDir, batchId);
    if (batch.status !== "open") throw new WebError("BATCH_LOCKED", 409, "批次已开始导入，不能丢弃");
    await removeUploadBatch(kbDir, batchId);
    return { ok: true };
  });
}

/**
 * 把 open 批次原子地切到 importing（Task 5 的导入入口调用）。
 * expectedFiles 是导入端点扫描到的文件快照：若扫描后又有上传落地，
 * 快照不一致会以 BATCH_CHANGED 拒绝，避免导入漏文件或读到写了一半的批次。
 */
export async function markBatchImporting(kbDir, batchId, { expectedFiles } = {}) {
  return withBatchLock(batchId, async () => {
    const batch = await readBatch(kbDir, batchId);
    if (batch.status !== "open") throw new WebError("BATCH_LOCKED", 409, "批次已开始导入");
    if (batch.files.length === 0) throw new WebError("BATCH_EMPTY", 400, "批次里没有文件");
    if (expectedFiles !== undefined) {
      const snapshot = (files) =>
        JSON.stringify(files.map((f) => ({ path: f.path, size: f.size })).sort((a, b) => a.path.localeCompare(b.path)));
      if (snapshot(batch.files) !== snapshot(expectedFiles)) {
        throw new WebError("BATCH_CHANGED", 409, "批次内容已变化，请重新发起导入");
      }
    }
    batch.status = "importing";
    batch.updatedAt = new Date().toISOString();
    await writeBatch(kbDir, batchId, batch);
    return batch;
  });
}

export function publicBatch(batch, limits = {}) {
  const caps = normalizeLimits(limits);
  return {
    id: batch.batchId,
    kb: batch.kb,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    files: batch.files,
    limits: { maxBytes: caps.maxUploadBytes, maxFiles: caps.maxBatchFiles, extensions: caps.extensions },
  };
}

async function mtimeOf(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 清扫过期批次：按状态判断“最后活动时间”，并在批次锁内重读元数据后删除。
 * - open：createdAt / updatedAt / batch.json mtime 的最新值；
 * - failed：updatedAt / batch.json mtime；
 * - importing：batch.json 与 progress.json（若存在）都过期才算崩溃残留；
 * - 元数据未知/损坏：目录 mtime 兜底。
 */
export async function sweepOldBatches({ kbDir, maxAgeMs = OLD_BATCH_MS, now = Date.now() }) {
  const root = uiBatchesRoot(kbDir);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !BATCH_ID_RE.test(entry.name)) continue;
    const dir = join(root, entry.name);
    const didRemove = await withBatchLock(entry.name, async () => {
      const dirMtime = await mtimeOf(dir);
      if (dirMtime === 0) return false;
      let batch = null;
      try {
        batch = JSON.parse(await readFile(join(dir, "batch.json"), "utf8"));
      } catch {
        batch = null;
      }
      const batchMtime = await mtimeOf(join(dir, "batch.json"));
      let stale;
      if (!batch || typeof batch !== "object") {
        stale = now - dirMtime > maxAgeMs;
      } else if (batch.status === "open") {
        const created = Date.parse(batch.createdAt) || dirMtime;
        const updated = Date.parse(batch.updatedAt) || dirMtime;
        stale = now - Math.max(created, updated, batchMtime) > maxAgeMs;
      } else if (batch.status === "failed") {
        const updated = Date.parse(batch.updatedAt) || dirMtime;
        stale = now - Math.max(updated, batchMtime) > maxAgeMs;
      } else if (batch.status === "importing") {
        const progressMtime = await mtimeOf(join(dir, "progress.json"));
        // 崩溃残留：元数据与进度都超过 maxAgeMs；有新鲜进度说明导入还活着。
        stale = now - batchMtime > maxAgeMs && (progressMtime === 0 || now - progressMtime > maxAgeMs);
      } else {
        stale = now - dirMtime > maxAgeMs;
      }
      if (!stale) return false;
      await rm(dir, { recursive: true, force: true });
      return true;
    }).catch(() => false);
    if (didRemove) removed += 1;
  }
  return removed;
}
