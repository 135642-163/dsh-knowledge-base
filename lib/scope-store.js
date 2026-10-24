/**
 * .scopes.json 的文件层：原子读写、串行队列、同步只读视图、库名同步。
 * 只做“文件 ↔ 纯数据”；范围语义（校验/继承/工具矩阵）在 lib/scope.js。
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

export async function readScopes(root) {
  try {
    const text = await readFile(scopeFilePath(root), "utf8");
    return normalizeData(JSON.parse(text));
  } catch {
    return empty();
  }
}

export async function writeScopes(root, data) {
  const path = scopeFilePath(root);
  await mkdir(expandRoot(root), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
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

/** 串行 read-modify-write；mutator 返回 truthy 才写盘。 */
export async function mutateScopes(root, mutator) {
  return enqueue(root, async () => {
    const data = await readScopes(root);
    const changed = await mutator(data);
    if (changed) await writeScopes(root, data);
    return data;
  });
}

/** 同步只读视图（系统提示用）：mtime+size 缓存；损坏/超限返回空。 */
export function readScopesSync(root) {
  try {
    const path = scopeFilePath(root);
    const info = statSync(path);
    if (info.size > MAX_BYTES) return empty();
    if (syncCache.path === path && syncCache.mtimeMs === info.mtimeMs && syncCache.size === info.size) {
      return syncCache.data;
    }
    const data = normalizeData(JSON.parse(readFileSync(path, "utf8")));
    syncCache = { path, mtimeMs: info.mtimeMs, size: info.size, data };
    return data;
  } catch {
    return empty();
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
  if (oldName === newName) return;
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

export async function scopesFileInfo(root) {
  try {
    return await stat(scopeFilePath(root));
  } catch {
    return null;
  }
}
