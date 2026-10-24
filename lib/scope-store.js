/**
 * .scopes.json 的文件层：原子读写、串行队列、同步只读视图、库名同步。
 * 只做“文件 ↔ 纯数据”；范围语义（校验/继承/工具矩阵）在 lib/scope.js。
 * 损坏或超限的文件只标记不删除：mutateScopes 拒绝覆盖，避免静默丢数据。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expandRoot } from "./store.js";

export const SCOPE_FILE = ".scopes.json";
const MAX_BYTES = 1024 * 1024;

const queues = new Map();
let syncCache = { path: "", mtimeMs: -1, size: -1, data: null };

function empty() {
  return { version: 1, scopes: {} };
}

export function scopeFilePath(root) {
  return join(expandRoot(root), SCOPE_FILE);
}

function normalizeData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty();
  const scopes = raw.scopes && typeof raw.scopes === "object" && !Array.isArray(raw.scopes) ? raw.scopes : {};
  const clean = {};
  for (const [sessionId, entry] of Object.entries(scopes)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    clean[sessionId] = entry;
  }
  return { version: 1, scopes: clean };
}

/**
 * 读文件并区分“没有”与“不可用”（损坏或超限）。
 * 不可用只返回标记、不删除文件；其它 IO 错误（EACCES 等）向上抛给调用方。
 */
async function readScopesState(root) {
  const path = scopeFilePath(root);
  let buffer;
  try {
    buffer = await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { data: empty(), unusable: false };
    throw error;
  }
  if (buffer.length > MAX_BYTES) return { data: empty(), unusable: true };
  try {
    return { data: normalizeData(JSON.parse(buffer.toString("utf8"))), unusable: false };
  } catch {
    return { data: empty(), unusable: true };
  }
}

export async function readScopes(root) {
  return (await readScopesState(root)).data;
}

export async function writeScopes(root, data) {
  const path = scopeFilePath(root);
  await mkdir(expandRoot(root), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(
      tmp,
      `${JSON.stringify({ version: 1, scopes: data.scopes ?? {} }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  syncCache = { path: "", mtimeMs: -1, size: -1, data: null };
}

function enqueue(root, task) {
  const key = scopeFilePath(root);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  queues.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * 串行 read-modify-write；mutator 返回 truthy 才写盘。
 * 注意：不要在同一 root 的 mutator 里再次调用 mutateScopes —— 会等待自己而永久死锁（无运行时防护）。
 */
export async function mutateScopes(root, mutator) {
  return enqueue(root, async () => {
    const { data, unusable } = await readScopesState(root);
    if (unusable) {
      const error = new Error(
        "scopes file is unusable (corrupt or oversized); refusing to overwrite: " + scopeFilePath(root)
      );
      error.code = "SCOPE_UNUSABLE";
      throw error;
    }
    const changed = await mutator(data);
    if (changed) await writeScopes(root, data);
    return data;
  });
}

/** 冻结同步视图：顶层 + 每个条目 + kbs 数组，防止调用方改坏缓存。 */
function freezeView(data) {
  for (const entry of Object.values(data.scopes)) {
    if (Array.isArray(entry.kbs)) Object.freeze(entry.kbs);
    Object.freeze(entry);
  }
  return Object.freeze(data);
}

/** 同步只读视图（系统提示用）：mtime+size 缓存；损坏/超限/不可读返回空。 */
export function readScopesSync(root) {
  try {
    const path = scopeFilePath(root);
    const info = statSync(path);
    if (info.size > MAX_BYTES) return freezeView(empty());
    if (syncCache.path === path && syncCache.mtimeMs === info.mtimeMs && syncCache.size === info.size) {
      return syncCache.data;
    }
    const data = freezeView(normalizeData(JSON.parse(readFileSync(path, "utf8"))));
    syncCache = { path, mtimeMs: info.mtimeMs, size: info.size, data };
    return data;
  } catch {
    return freezeView(empty());
  }
}

/** 从所有条目里摘掉一个库名（归档/彻底删除时用）。 */
export async function removeScopeKb(root, name) {
  return mutateScopes(root, (data) => {
    let changed = false;
    for (const entry of Object.values(data.scopes)) {
      if (!Array.isArray(entry.kbs)) continue;
      const next = entry.kbs.filter((kb) => kb !== name);
      if (next.length !== entry.kbs.length) {
        entry.kbs = next;
        changed = true;
      }
    }
    return changed;
  });
}

/** 重命名时替换所有条目里的库名并去重。 */
export async function renameScopeKb(root, oldName, newName) {
  if (oldName === newName) return readScopes(root);
  return mutateScopes(root, (data) => {
    let changed = false;
    for (const entry of Object.values(data.scopes)) {
      if (!Array.isArray(entry.kbs)) continue;
      const next = [...new Set(entry.kbs.map((kb) => (kb === oldName ? newName : kb)))];
      if (next.length !== entry.kbs.length || next.some((kb, index) => kb !== entry.kbs[index])) {
        entry.kbs = next;
        changed = true;
      }
    }
    return changed;
  });
}
