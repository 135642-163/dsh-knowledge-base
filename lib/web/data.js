/**
 * 工作台数据投影：只读 manifest 与少量文件，不读 markdown 正文。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isDeleted, kbDirPath, listKbs, readManifest } from "../store.js";

export function liveDocs(manifest) {
  return (manifest.docs ?? []).filter((doc) => !isDeleted(doc));
}

export function formatStats(docs) {
  let ready = 0;
  let importing = 0;
  let failed = 0;
  let notes = 0;
  let pages = 0;
  let chars = 0;
  const types = {};
  const trust = {};
  for (const doc of docs) {
    if (doc.status === "ready") ready += 1;
    else if (doc.status === "importing") importing += 1;
    else if (doc.status === "failed") failed += 1;
    if (doc.type === "note" && doc.status === "ready") notes += 1;
    pages += Number(doc.pages) || 0;
    chars += Number(doc.chars) || 0;
    types[doc.type ?? "unknown"] = (types[doc.type ?? "unknown"] ?? 0) + 1;
    trust[doc.trust ?? "unknown"] = (trust[doc.trust ?? "unknown"] ?? 0) + 1;
  }
  return { ready, importing, failed, notes, pages, chars, types, trust };
}

export async function summarizeKb(root, entry) {
  const dir = kbDirPath(root, entry.dir ?? entry.name);
  const manifest = await readManifest(dir);
  const docs = liveDocs(manifest);
  const stats = formatStats(docs);
  const deleted = (manifest.docs ?? []).filter((doc) => isDeleted(doc)).length;
  const total = (manifest.docs ?? []).length;
  const status = docs.length === 0 ? "empty" : stats.failed > 0 || stats.importing > 0 ? "warn" : "ok";
  return {
    name: manifest.name || entry.name,
    dir: entry.dir ?? entry.name,
    description: manifest.description ?? "",
    tags: Array.isArray(manifest.tags) ? manifest.tags : [],
    createdAt: manifest.createdAt ?? null,
    updatedAt: manifest.updatedAt ?? null,
    mergedInto: manifest.mergedInto ?? null,
    mergedAt: manifest.mergedAt ?? null,
    docs: { total, ready: stats.ready, importing: stats.importing, failed: stats.failed, deleted, notes: stats.notes },
    pages: stats.pages,
    chars: stats.chars,
    types: stats.types,
    trust: stats.trust,
    status,
  };
}

export async function readKbDetail(root, name) {
  const dir = kbDirPath(root, name);
  const manifest = await readManifest(dir);
  const summary = await summarizeKb(root, { name, dir: name });
  const docs = liveDocs(manifest);
  const recentDocs = [...docs]
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, 5)
    .map((doc) => ({ id: doc.id, title: doc.title, type: doc.type, updatedAt: doc.updatedAt }));
  const schema = await readTextMeta(join(dir, "schema.md"));
  const index = await readTextMeta(join(dir, "index.md"));
  const logTail = await readTail(join(dir, "log.md"), 64 * 1024, 200);
  return {
    kb: summary,
    schema,
    index,
    logTail,
    recentDocs,
    health: {
      failed: summary.docs.failed,
      importing: summary.docs.importing,
      deleted: summary.docs.deleted,
      lowConfidenceDocs: docs.filter((doc) => Array.isArray(doc.lowConfidencePages) && doc.lowConfidencePages.length > 0).length,
      corruptedDocs: docs.filter((doc) => Array.isArray(doc.corruptedPages) && doc.corruptedPages.length > 0).length,
      hasSchema: schema.exists,
    },
  };
}

async function readTextMeta(path) {
  try {
    const text = await readFile(path, "utf8");
    return { exists: true, chars: text.length };
  } catch {
    return { exists: false, chars: 0 };
  }
}

async function readTail(path, maxBytes, maxLines) {
  try {
    const text = await readFile(path, "utf8");
    const clipped = text.length > maxBytes ? text.slice(-maxBytes) : text;
    const lines = clipped.split(/\r?\n/);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

export async function listDocs(root, name, query = {}) {
  const dir = kbDirPath(root, name);
  const manifest = await readManifest(dir);
  let docs = (manifest.docs ?? []).map((doc) => ({
    id: doc.id,
    title: doc.title,
    type: doc.type,
    pages: doc.pages ?? 0,
    chars: doc.chars ?? 0,
    status: doc.status,
    trust: doc.trust ?? "unknown",
    summary: doc.summary ?? "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    updatedAt: doc.updatedAt ?? "",
    deleted: isDeleted(doc),
    ocrConfidence: doc.ocrConfidence ?? null,
  }));
  const status = String(query.status ?? "").trim();
  docs = status === "deleted" ? docs.filter((doc) => doc.deleted) : docs.filter((doc) => !doc.deleted);
  if (status !== "" && status !== "deleted") docs = docs.filter((doc) => doc.status === status);
  const search = String(query.query ?? "").trim().toLowerCase();
  if (search !== "") {
    docs = docs.filter((doc) => {
      const tags = Array.isArray(doc.tags) ? doc.tags : [];
      const haystack = [doc.title, doc.summary, ...tags].map((field) => String(field ?? "")).join(" ");
      return haystack.toLowerCase().includes(search);
    });
  }
  const trust = String(query.trust ?? "").trim();
  if (trust !== "") docs = docs.filter((doc) => doc.trust === trust);
  const type = String(query.type ?? "").trim();
  if (type !== "") docs = docs.filter((doc) => doc.type === type);
  docs.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"));
  const total = docs.length;
  const offset = Math.max(0, Math.round(Number(query.offset) || 0));
  const limit = Math.max(1, Math.min(200, Math.round(Number(query.limit) || 50)));
  return { docs: docs.slice(offset, offset + limit), total, offset, limit };
}

export async function readDoc(root, name, id) {
  const dir = kbDirPath(root, name);
  const manifest = await readManifest(dir);
  const doc = (manifest.docs ?? []).find((item) => item.id === id);
  if (!doc) return null;
  return {
    id: doc.id,
    title: doc.title,
    type: doc.type,
    pages: doc.pages ?? 0,
    chars: doc.chars ?? 0,
    parts: doc.parts ?? 0,
    status: doc.status,
    version: doc.version ?? 0,
    importedAt: doc.importedAt ?? "",
    updatedAt: doc.updatedAt ?? "",
    sourceFile: doc.sourceFile ?? "",
    summary: doc.summary ?? "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    trust: doc.trust ?? "unknown",
    trustReason: doc.trustReason ?? "",
    ocrPages: doc.ocrPages ?? 0,
    ocrConfidence: doc.ocrConfidence ?? null,
    lowConfidencePages: doc.lowConfidencePages ?? [],
    corruptedPages: doc.corruptedPages ?? [],
    warnings: doc.warnings ?? [],
    deleted: isDeleted(doc),
  };
}

export async function findSource(root, name, id) {
  const dir = kbDirPath(root, name);
  const sources = join(dir, "sources");
  let entries = [];
  try {
    entries = await readdir(sources);
  } catch {
    return null;
  }
  const matches = entries.filter((file) => file === id || file.startsWith(`${id}.`));
  if (matches.length !== 1) return null;
  const path = join(sources, matches[0]);
  const info = await stat(path);
  return { path, name: matches[0], size: info.size };
}

export async function listKbEntries(root) {
  return listKbs(root);
}
