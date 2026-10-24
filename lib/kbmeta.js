/**
 * 库级元数据：新建、更新、归档、重命名辅助。
 * 不依赖 lib/index.js，避免循环；manifest 的落盘复用 store.js。
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
  SCHEMA_VERSION,
  expandRoot,
  isDeleted,
  kbDirPath,
  sanitizeKbName,
  readManifest,
  withManifestLock,
  writeManifestAtomic,
} from "./store.js";
import { ensureLog, ensureSchema, refreshIndexIfStale, appendLog } from "./wiki.js";
import { removeScopeKb } from "./scope-store.js";

export function normalizeTags(tags) {
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw ?? "").trim().slice(0, 32);
    if (tag !== "" && !out.includes(tag)) out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

export function normalizeDescription(value) {
  return String(value ?? "").trim().slice(0, 500);
}

export async function createKb(root, { name, description = "", tags = [] } = {}) {
  const clean = sanitizeKbName(name);
  if (clean.startsWith(".") || clean === ".trash") {
    throw new Error("知识库名称不能以 . 开头");
  }
  const base = expandRoot(root);
  await mkdir(base, { recursive: true });
  const entries = await readdir(base, { withFileTypes: true });
  const lower = clean.toLowerCase();
  if (entries.some((entry) => entry.isDirectory() && entry.name.toLowerCase() === lower)) {
    throw new Error(`知识库已存在: ${clean}`);
  }
  const dir = join(base, clean);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    name: clean,
    description: normalizeDescription(description),
    tags: normalizeTags(tags),
    mergedInto: null,
    mergedAt: null,
    createdAt: now,
    updatedAt: now,
    docs: [],
  };
  await writeManifestAtomic(dir, manifest);
  await ensureSchema(dir, clean);
  await ensureLog(dir);
  await refreshIndexIfStale(dir, manifest);
  await appendLog(dir, `create: 新建知识库「${clean}」`);
  return { dir, manifest };
}

export async function updateKbMeta(root, name, patch = {}) {
  const dir = kbDirPath(root, name);
  const manifest = await withManifestLock(dir, async () => {
    const current = await readManifest(dir);
    if (patch.description !== undefined) current.description = normalizeDescription(patch.description);
    if (patch.tags !== undefined) current.tags = normalizeTags(patch.tags);
    current.updatedAt = new Date().toISOString();
    await writeManifestAtomic(dir, current);
    return current;
  });
  await refreshIndexIfStale(dir, manifest).catch(() => {});
  return { dir, manifest };
}

export async function archiveKb(root, name) {
  const dir = kbDirPath(root, name);
  if (!existsSync(join(dir, "kb.json"))) throw new Error(`知识库不存在: ${name}`);
  const trash = join(expandRoot(root), ".trash");
  await mkdir(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const base = `${basename(dir)}-${stamp}`;
  let target = join(trash, base);
  for (let i = 2; existsSync(target); i += 1) target = join(trash, `${base}-${i}`);
  await rename(dir, target);
  await removeScopeKb(root, name).catch(() => {});
  return target;
}

/** best-effort 同步 schema.md 的 H1（重命名/恢复改名时用）。 */
export async function syncSchemaTitle(dir, oldName, newName) {
  try {
    const path = join(dir, "schema.md");
    const text = await readFile(path, "utf8");
    const next = text.replaceAll(`知识库「${oldName}」`, `知识库「${newName}」`);
    if (next !== text) await writeFile(path, next, "utf8");
  } catch {
    /* schema 是附属产物，失败不影响改名 */
  }
}

/** 列出 .trash/ 下的归档库；只读 manifest，不移动任何文件。 */
export async function listTrash(root) {
  const trash = join(expandRoot(root), ".trash");
  let entries;
  try {
    entries = await readdir(trash, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(trash, entry.name);
    let manifest = null;
    let reason = null;
    try {
      manifest = JSON.parse(await readFile(join(dir, "kb.json"), "utf8"));
    } catch {
      reason = "缺少或损坏 kb.json";
    }
    if (manifest !== null && (typeof manifest.name !== "string" || manifest.name.trim() === "")) {
      manifest = null;
      reason = "manifest 缺少知识库名称";
    }
    const docs = Array.isArray(manifest?.docs) ? manifest.docs.filter((doc) => !isDeleted(doc)) : [];
    let archivedAt = "";
    try {
      archivedAt = (await stat(dir)).mtime.toISOString();
    } catch {
      archivedAt = "";
    }
    out.push({
      dir: entry.name,
      name: manifest?.name ?? entry.name,
      docs: docs.length,
      notes: docs.filter((doc) => doc.type === "note" && doc.status === "ready").length,
      archivedAt,
      restorable: manifest !== null,
      reason,
    });
  }
  out.sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
  return out;
}

/** 把 .trash/<dir> 移回 kbRoot/<name>；name 省略时用 manifest 原名。 */
export async function restoreKb(root, dirName, { name } = {}) {
  if (typeof dirName !== "string" || dirName === "" || basename(dirName) !== dirName || dirName === "." || dirName === "..") {
    throw new Error("归档目录名无效");
  }
  const base = expandRoot(root);
  const trash = join(base, ".trash");
  const source = join(trash, dirName);
  if (!existsSync(join(source, "kb.json"))) throw new Error(`归档记录不存在: ${dirName}`);

  let raw;
  try {
    raw = JSON.parse(await readFile(join(source, "kb.json"), "utf8"));
  } catch {
    throw new Error("归档目录的 kb.json 损坏，无法恢复");
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new Error("归档目录缺少知识库名称，无法恢复");
  }
  const original = sanitizeKbName(raw.name);
  const targetName = sanitizeKbName(name ?? original);
  if (targetName.startsWith(".") || targetName === ".trash") {
    throw new Error("知识库名称不能以 . 开头");
  }
  const target = join(base, targetName);
  if (existsSync(target)) throw new Error(`目标名称已存在: ${targetName}`);

  let moved = false;
  try {
    await rename(source, target);
    moved = true;
    let manifest = raw;
    if (targetName !== original || raw.name !== targetName) {
      manifest = await withManifestLock(target, async () => {
        const current = await readManifest(target);
        current.name = targetName;
        current.updatedAt = new Date().toISOString();
        await writeManifestAtomic(target, current);
        return current;
      });
      await syncSchemaTitle(target, original, targetName);
    }
    await refreshIndexIfStale(target, manifest).catch(() => {});
    await appendLog(target, `restore: 从回收站恢复为「${targetName}」`).catch(() => {});
    return { dir: target, manifest };
  } catch (error) {
    if (moved && existsSync(target) && !existsSync(source)) {
      await rename(target, source).catch(() => {});
    }
    throw error;
  }
}

function assertSafeTrashDirName(dirName) {
  if (
    typeof dirName !== "string"
    || dirName === ""
    || dirName === "."
    || dirName === ".."
    || dirName.includes("/")
    || dirName.includes("\\")
    || /[\u0000-\u001f]/.test(dirName)
    || basename(dirName) !== dirName
  ) {
    throw new Error("归档目录名无效");
  }
}

/**
 * 彻底删除 .trash/<dirName>。只接受 .trash 下的一级真实目录：
 * 拒绝路径分隔符、. / ..、控制字符与越过 .trash 的软链目标。
 */
export async function purgeKb(root, dirName) {
  assertSafeTrashDirName(dirName);
  const base = expandRoot(root);
  const trash = join(base, ".trash");
  const target = join(trash, dirName);

  let info;
  try {
    info = await lstat(target);
  } catch {
    throw new Error(`归档记录不存在: ${dirName}`);
  }
  if (!info.isDirectory()) throw new Error(`归档记录不存在: ${dirName}`);

  let trashReal;
  let targetReal;
  try {
    [trashReal, targetReal] = await Promise.all([realpath(trash), realpath(target)]);
  } catch {
    throw new Error(`归档记录不存在: ${dirName}`);
  }
  const rel = relative(trashReal, targetReal);
  const parts = rel.split(sep);
  if (rel === "" || isAbsolute(rel) || rel === "." || rel === ".." || parts.length !== 1 || parts[0] === "..") {
    throw new Error("归档目录名无效");
  }

  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(join(targetReal, "kb.json"), "utf8"));
  } catch {
    /* 损坏的归档仍允许彻底删除；名称回退到目录名。 */
  }
  const name = typeof manifest?.name === "string" && manifest.name.trim() !== "" ? manifest.name : dirName;
  const docs = Array.isArray(manifest?.docs) ? manifest.docs.filter((doc) => !isDeleted(doc)) : [];
  const notes = docs.filter((doc) => doc.type === "note" && doc.status === "ready").length;

  try {
    await rm(targetReal, { recursive: true, force: false });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`归档记录不存在: ${dirName}`);
    throw error;
  }
  await removeScopeKb(base, name).catch(() => {});
  return { name, dir: dirName, docs: docs.length, notes, purgedAt: new Date().toISOString() };
}

/** 用资料的标签/类型/标题拼一句建议简介，不调用模型。 */
export function suggestDescription(manifest) {
  const docs = (manifest?.docs ?? []).filter((doc) => doc.status === "ready" && !doc.deletedAt);
  const tagCount = new Map();
  for (const doc of docs) {
    for (const tag of Array.isArray(doc.tags) ? doc.tags : []) {
      tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
    }
  }
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag]) => tag);
  const typeCount = new Map();
  for (const doc of docs) typeCount.set(doc.type ?? "unknown", (typeCount.get(doc.type ?? "unknown") ?? 0) + 1);
  const topType = [...typeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "资料";
  const sample = docs.slice(0, 3).map((doc) => `《${doc.title}》`).join("、");
  const focus = topTags.length > 0 ? `重点：${topTags.join("、")}。` : "";
  return `${sample ? `收录${sample}等` : "收录"}${topType}资料，共 ${docs.length} 篇。${focus}`.slice(0, 500);
}
