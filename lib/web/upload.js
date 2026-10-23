/**
 * 上传批次：目录布局 <kb>/import-tmp/ui-batches/<batchId>/，
 * batch.json 原子写 + 批次内串行队列；PUT 走流式落盘与逐段路径校验。
 * 导入（importBatch）在 Task 5 追加。
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
const OLD_BATCH_MS = 24 * 3600 * 1000;

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

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rm(path, { force: true }).catch(() => {});
  await rename(tmp, path);
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
  const abs = resolve(batchDir, relPath);
  if (abs !== batchDir && !abs.startsWith(batchDir + sep)) {
    throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径越界");
  }
  return abs;
}

export async function createUploadBatch({ kbDir, kb, now = Date.now() }) {
  const batchId = `b-${randomBytes(6).toString("hex")}`;
  const dir = batchDirFor(kbDir, batchId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date(now).toISOString();
  const batch = { version: 1, batchId, kb, createdAt: stamp, updatedAt: stamp, status: "open", files: [] };
  await writeJsonAtomic(join(dir, "batch.json"), batch);
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

export async function addBatchFile({ kbDir, batchId, relPath, source, limits = {} }) {
  return withBatchLock(batchId, async () => {
    const batch = await readBatch(kbDir, batchId);
    if (batch.status !== "open") throw new WebError("BATCH_LOCKED", 409, "批次已锁定，不能继续上传");
    const rel = validateRelPath(relPath);
    assertSupportedType(rel);
    const exists = batch.files.some((file) => file.path === rel);
    if (!exists && batch.files.length + 1 > limits.maxBatchFiles) {
      throw new WebError("BATCH_TOO_MANY_FILES", 413, `单批最多 ${limits.maxBatchFiles} 个文件`, {
        maxFiles: limits.maxBatchFiles,
      });
    }
    const dir = batchDirFor(kbDir, batchId);
    const target = resolveBatchPath(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(dir, `.upload-${randomBytes(6).toString("hex")}.part`);
    const { size } = await readRawToFile(source, tmp, { maxBytes: limits.maxUploadBytes });
    await rm(target, { force: true }).catch(() => {});
    await rename(tmp, target);
    if (exists) {
      batch.files = batch.files.map((file) => (file.path === rel ? { path: rel, size } : file));
    } else {
      batch.files.push({ path: rel, size });
    }
    batch.updatedAt = new Date().toISOString();
    await writeBatch(kbDir, batchId, batch);
    return { path: rel, size };
  });
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

export function publicBatch(batch, limits = {}) {
  return {
    id: batch.batchId,
    kb: batch.kb,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    files: batch.files,
    limits: { maxBytes: limits.maxUploadBytes, maxFiles: limits.maxBatchFiles, extensions: limits.extensions },
  };
}

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
    let createdAt = 0;
    try {
      const batch = JSON.parse(await readFile(join(dir, "batch.json"), "utf8"));
      createdAt = Date.parse(batch.createdAt) || 0;
    } catch {
      /* 元数据损坏时用目录 mtime 兜底 */
    }
    if (createdAt === 0) {
      createdAt = (await stat(dir).catch(() => ({ mtimeMs: now }))).mtimeMs;
    }
    if (now - createdAt > maxAgeMs) {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
