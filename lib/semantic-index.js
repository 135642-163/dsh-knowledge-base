/**
 * 0.31 语义索引（Task 2）：<kb>/.index/doc-vectors.f32 + doc-vectors.meta.json。
 *
 *  - 行序 = meta.docs 顺序 = 当前 manifest 的 ready 文档顺序；
 *  - 增量：manifestStamp 变化时按 id/version/updatedAt 复用未变文档的向量，只重算变动/新增；
 *    删除文档时按新顺序重写整个文件（1.9MB/911 篇，成本可忽略）；
 *  - 损坏（截断/维度不符/meta 坏/hash 不符）→ 视为不可用并全量重建，不抛异常；
 *  - 索引只写 <kb>/.index/：原子写（临时文件 + rename）、文件权限 0600，
 *    不碰 sources/ 与 markdown/。
 *
 * 这里不做模型加载：embedder 由调用方注入（真实实现见 lib/semantic-runtime.js，
 * 测试用假 embedder），所以单测不需要模型。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitClauses } from "./clauses.js";
import { splitMarkdownWindows } from "./semantic-windows.js";
import { manifestStamp } from "./fts-index.js";
import { normalizeVector } from "./semantic.js";

export const DOC_VECTORS_FILE = "doc-vectors.f32";
export const DOC_VECTORS_META_FILE = "doc-vectors.meta.json";
/** 与 0.30 评测同一套权重；只改模型时索引整体失效（status.reason=model 可诊断）。 */
export const SEMANTIC_MODEL = "BAAI/bge-small-zh-v1.5";
export const DOC_VECTOR_SCHEMA = "1";
/** 语义画像：summary=当前 600 字；window=全文 8 窗口质心（仍是一条向量/文档）。 */
export const DOC_PROFILE_SUMMARY = "summary-v1";
export const DOC_PROFILE_WINDOW = "window-centroid-v1";
export const DOC_PROFILES = [DOC_PROFILE_SUMMARY, DOC_PROFILE_WINDOW];
export const DEFAULT_DOC_PROFILE = DOC_PROFILE_SUMMARY;
export const DOC_WINDOW_COUNT = 8;
export const DOC_WINDOW_CHARS = 420;
/** 文档嵌入文本：与 0.30 评测一致（总长 ≤600 字，首条款正文 ≤300 字）。 */
export const DOC_TEXT_MAX_CHARS = 600;
export const DOC_FIRST_CLAUSE_CHARS = 300;

function indexPath(dir, name) {
  return join(dir, ".index", name);
}

function currentDocs(manifest) {
  return (manifest?.docs ?? []).filter((doc) => doc && doc.status === "ready" && !doc.deletedAt);
}

function collapse(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 文档嵌入文本：标准号 + 标题 + 标签 + 摘要 + 首条款正文。
 * 与 0.30 `build-doc-corpus.mjs` 逐字一致（首条款取 FTS/clauses 切分的第一条 text），
 * 保证 0.31 的索引与 0.30 评测向量可比。
 */
export async function docEmbedText({ dir, doc }) {
  let firstClause = "";
  try {
    const markdown = await readFile(join(dir, "markdown", doc.id, `${doc.id}.md`), "utf8");
    const merged = markdown.replace(/^#\s+.*\r?\n/, "");
    const first = splitClauses(merged, { docId: doc.id })[0];
    firstClause = first?.text ? collapse(first.text).slice(0, DOC_FIRST_CLAUSE_CHARS) : "";
  } catch {
    firstClause = "";
  }
  const tags = Array.isArray(doc?.tags) && doc.tags.length > 0 ? doc.tags.join(" ") : "";
  const head = [doc?.standardNo, doc?.title, tags, doc?.summary, firstClause]
    .filter((part) => String(part ?? "").trim() !== "")
    .join(" ");
  return head.slice(0, DOC_TEXT_MAX_CHARS);
}

export function normalizeDocProfile(value) {
  const profile = String(value ?? "").trim().toLowerCase();
  return profile === "window" || profile === DOC_PROFILE_WINDOW ? DOC_PROFILE_WINDOW : DOC_PROFILE_SUMMARY;
}

/**
 * 单篇文档的嵌入文本：
 * - summary：当前生产画像（标准号+标题+标签+摘要+首条款，≤600 字）；
 * - window：全文均匀 8 个窗口，每窗 ≤420 字（调用方会再取质心）。
 */
export async function docProfileTexts({ dir, doc, profile = DEFAULT_DOC_PROFILE } = {}) {
  const normalized = normalizeDocProfile(profile);
  if (normalized === DOC_PROFILE_SUMMARY) {
    return [await docEmbedText({ dir, doc })];
  }
  let markdown = "";
  try {
    markdown = await readFile(join(dir, "markdown", doc.id, `${doc.id}.md`), "utf8");
  } catch {
    markdown = "";
  }
  const prefix = [doc?.standardNo, doc?.title].filter((part) => String(part ?? "").trim() !== "").join(" ");
  const windows = splitMarkdownWindows(markdown, {
    maxWindows: DOC_WINDOW_COUNT,
    windowChars: DOC_WINDOW_CHARS,
    prefix,
  });
  if (windows.length === 0) return [await docEmbedText({ dir, doc })];
  return windows.map((window) => window.text);
}

function centroid(vectors) {
  const list = Array.isArray(vectors) ? vectors.filter((vector) => vector && vector.length > 0) : [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const dim = list[0].length;
  if (!list.every((vector) => vector.length === dim)) return null;
  const sum = new Float32Array(dim);
  for (const vector of list) {
    for (let index = 0; index < dim; index += 1) sum[index] += vector[index];
  }
  return normalizeVector(sum);
}

function hashBytes(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 读取并校验 meta + 向量文件大小。不验证内容 hash（status 要快）；
 * readDocVectors 会再验一次，防止「f32 已换、meta 没换」的半写状态被当成有效索引。
 * @returns {{ready:boolean, fresh:boolean, reason:string, dim:number, docs:number,
 *   model:string, builtAt:string, meta:object|null}}
 */
async function inspect(dir, expectedStamp, expectedProfile = DEFAULT_DOC_PROFILE) {
  const base = {
    ready: false,
    fresh: false,
    reason: "",
    dim: 0,
    docs: 0,
    model: "",
    builtAt: "",
    profile: "",
    meta: null,
  };
  let meta;
  try {
    meta = JSON.parse(await readFile(indexPath(dir, DOC_VECTORS_META_FILE), "utf8"));
  } catch (error) {
    return { ...base, reason: error?.code === "ENOENT" ? "missing" : "meta_corrupt" };
  }
  if (!meta || typeof meta !== "object") return { ...base, reason: "meta_corrupt" };
  if (String(meta.schemaVersion ?? "") !== DOC_VECTOR_SCHEMA) return { ...base, reason: "schema" };
  const profile = String(meta.profile ?? DOC_PROFILE_SUMMARY);
  if (profile !== expectedProfile) return { ...base, reason: "profile", profile };
  const dim = Number(meta.dim);
  if (!Number.isInteger(dim) || dim <= 0) return { ...base, reason: "dim" };
  const docs = Array.isArray(meta.docs) ? meta.docs : [];
  if (!docs.every((entry) => entry && typeof entry.id === "string" && entry.id !== "")) {
    return { ...base, reason: "docs" };
  }
  let size;
  try {
    size = (await stat(indexPath(dir, DOC_VECTORS_FILE))).size;
  } catch {
    return { ...base, reason: "missing-vectors" };
  }
  if (size !== docs.length * dim * 4) return { ...base, reason: "size" };
  return {
    ready: true,
    fresh: String(meta.manifestStamp ?? "") === String(expectedStamp ?? ""),
    reason: "",
    dim,
    docs: docs.length,
    model: String(meta.model ?? ""),
    builtAt: String(meta.builtAt ?? ""),
    profile,
    meta,
  };
}

function stampOf(manifest, stamp) {
  return String(stamp || manifestStamp(manifest));
}

/**
 * 索引状态（供 /kb/api/status 与检索判断）：只读 meta + 文件大小，不读向量内容、不加载模型。
 * `ready` = 文件与 meta 自洽；`fresh` = 还匹配当前 manifest。二者都满足才可用于检索。
 */
export async function docVectorsStatus({ dir, manifest, stamp = "", profile = DEFAULT_DOC_PROFILE } = {}) {
  const expectedProfile = normalizeDocProfile(profile);
  const inspected = await inspect(dir, stampOf(manifest, stamp), expectedProfile);
  return {
    ready: inspected.ready,
    fresh: inspected.fresh,
    reason: inspected.reason,
    dim: inspected.dim,
    docs: inspected.docs,
    model: inspected.model,
    builtAt: inspected.builtAt,
    profile: expectedProfile,
  };
}

/**
 * 读取向量（行视图：多维数组共享同一块 Float32Array，不复制）。
 * 校验 meta 自洽 + 内容 hash；失败返回 ok=false，调用方回退 B。
 * @returns {{ok:boolean, fresh:boolean, reason:string, dim:number, ids:string[],
 *   vectors:Float32Array[], meta:object|null}}
 */
export async function readDocVectors({ dir, manifest, stamp = "", profile = DEFAULT_DOC_PROFILE } = {}) {
  const expectedStamp = stampOf(manifest, stamp);
  const expectedProfile = normalizeDocProfile(profile);
  const inspected = await inspect(dir, expectedStamp, expectedProfile);
  const failed = {
    ok: false,
    fresh: false,
    reason: inspected.reason,
    dim: 0,
    ids: [],
    vectors: [],
    meta: null,
  };
  if (!inspected.ready) return failed;
  let buffer;
  try {
    buffer = await readFile(indexPath(dir, DOC_VECTORS_FILE));
  } catch {
    return { ...failed, reason: "missing-vectors" };
  }
  if (buffer.byteLength !== inspected.docs * inspected.dim * 4) {
    return { ...failed, reason: "size" };
  }
  if (inspected.meta.dataHash && hashBytes(buffer) !== String(inspected.meta.dataHash)) {
    return { ...failed, reason: "data_corrupt" };
  }
  const data = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const vectors = inspected.meta.docs.map((_entry, index) => data.subarray(
    index * inspected.dim,
    (index + 1) * inspected.dim,
  ));
  return {
    ok: true,
    fresh: inspected.fresh,
    reason: "",
    dim: inspected.dim,
    ids: inspected.meta.docs.map((entry) => entry.id),
    vectors,
    meta: inspected.meta,
    profile: inspected.profile,
  };
}

async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * 确保索引与 manifest 一致（首次构建 / 增量 / 修复）。
 * 不抛异常：失败返回 { ok:false, reason }，旧索引保持可用（只可能 stale）。
 * @param {object} options
 * @param {string} options.dir 知识库目录
 * @param {object} options.manifest 清单
 * @param {(texts: string[]) => Promise<Float32Array[]>} options.embedder 文档嵌入（不加查询指令）
 * @param {string} [options.stamp] 覆盖 manifestStamp（测试/调用方已算好时）
 * @returns {{ok:boolean, built:"none"|"full"|"incremental", embedded:number, docs:number,
 *   dim:number, reason?:string}}
 */
export async function ensureDocVectors({ dir, manifest, embedder, stamp = "", profile = DEFAULT_DOC_PROFILE } = {}) {
  if (typeof embedder !== "function") throw new TypeError("ensureDocVectors 需要 embedder(texts)");
  const expectedStamp = stampOf(manifest, stamp);
  const expectedProfile = normalizeDocProfile(profile);
  const docs = currentDocs(manifest);
  const inspected = await inspect(dir, expectedStamp, expectedProfile);
  if (inspected.ready && inspected.fresh) {
    return { ok: true, built: "none", embedded: 0, docs: inspected.docs, dim: inspected.dim };
  }
  if (docs.length === 0) {
    return { ok: true, built: "none", embedded: 0, docs: 0, dim: inspected.ready ? inspected.dim : 0 };
  }

  const previous = inspected.ready
    ? await readDocVectors({ dir, manifest, stamp: expectedStamp, profile: expectedProfile })
    : null;
  const oldById = new Map();
  if (previous?.ok) {
    previous.meta.docs.forEach((entry, index) => {
      oldById.set(entry.id, { entry, vector: previous.vectors[index] });
    });
  }

  const rows = new Array(docs.length).fill(null);
  const pending = [];
  docs.forEach((doc, index) => {
    const old = oldById.get(doc.id);
    const unchanged = old
      && Number(old.entry.version ?? 0) === Number(doc.version ?? 0)
      && String(old.entry.updatedAt ?? "") === String(doc.updatedAt ?? "");
    if (unchanged) rows[index] = old.vector;
    else pending.push({ doc, index });
  });

  let dim = previous?.ok ? previous.dim : 0;
  let embedded = 0;
  if (pending.length > 0) {
    const textsByDoc = await Promise.all(pending.map((entry) => docProfileTexts({ dir, doc: entry.doc, profile: expectedProfile })));
    const texts = textsByDoc.flat();
    let vectors;
    try {
      vectors = await embedder(texts);
    } catch (error) {
      return {
        ok: false,
        built: "none",
        embedded: 0,
        docs: docs.length,
        dim,
        reason: `embed_failed: ${String(error?.message ?? error)}`,
      };
    }
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      return { ok: false, built: "none", embedded: 0, docs: docs.length, dim, reason: "embed_mismatch" };
    }
    const inferred = Number(vectors[0]?.length ?? 0);
    if (!Number.isInteger(inferred) || inferred <= 0) {
      return { ok: false, built: "none", embedded: 0, docs: docs.length, dim, reason: "embed_empty" };
    }
    if (dim !== 0 && inferred !== dim) {
      return { ok: false, built: "none", embedded: 0, docs: docs.length, dim, reason: "dim_mismatch" };
    }
    dim = inferred;
    if (!vectors.every((vector) => vector && vector.length === dim)) {
      return { ok: false, built: "none", embedded: 0, docs: docs.length, dim, reason: "dim_mismatch" };
    }
    let cursor = 0;
    pending.forEach((entry, docOffset) => {
      const count = textsByDoc[docOffset].length;
      const group = vectors.slice(cursor, cursor + count);
      cursor += count;
      const vector = expectedProfile === DOC_PROFILE_WINDOW ? centroid(group) : group[0];
      rows[entry.index] = vector ?? group[0] ?? null;
    });
    embedded = pending.length;
  }
  if (!dim || rows.some((row) => !row || row.length !== dim)) {
    return { ok: false, built: "none", embedded: 0, docs: docs.length, dim, reason: "dim_mismatch" };
  }

  const flat = new Float32Array(docs.length * dim);
  rows.forEach((row, index) => flat.set(row, index * dim));
  const data = Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
  const meta = {
    schemaVersion: DOC_VECTOR_SCHEMA,
    model: SEMANTIC_MODEL,
    profile: expectedProfile,
    dim,
    docs: docs.map((doc) => ({
      id: doc.id,
      version: Number(doc.version ?? 0),
      updatedAt: String(doc.updatedAt ?? ""),
    })),
    manifestStamp: expectedStamp,
    builtAt: new Date().toISOString(),
    dataHash: hashBytes(data),
  };

  try {
    await mkdir(join(dir, ".index"), { recursive: true });
    // 先写向量、再写 meta：中途失败时 meta 的 stamp/hash 与数据不符，
    // 读侧会判损坏并全量重建，不会把错行当成有效索引。
    await writeAtomic(indexPath(dir, DOC_VECTORS_FILE), data);
    await writeAtomic(indexPath(dir, DOC_VECTORS_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  } catch (error) {
    return {
      ok: false,
      built: "none",
      embedded: 0,
      docs: docs.length,
      dim,
      reason: `write_failed: ${String(error?.message ?? error)}`,
    };
  }
  return {
    ok: true,
    built: previous?.ok ? "incremental" : "full",
    embedded,
    docs: docs.length,
    dim,
    profile: expectedProfile,
  };
}

/**
 * 大库后台建索引：写锁文件（10 分钟内视为构建中）后拉起独立进程，
 * 当次检索立即回退 B。与 FTS 的后台构建同款模式（lock + detached child）。
 * @returns {Promise<{started:boolean, reason?:string}>}
 */
export async function startBackgroundVectorBuild(dir, { profile = DEFAULT_DOC_PROFILE } = {}) {
  const expectedProfile = normalizeDocProfile(profile);
  const indexDir = join(dir, ".index");
  await mkdir(indexDir, { recursive: true });
  const lock = join(indexDir, "doc-vectors.lock");
  const stamp = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try {
    await writeFile(lock, stamp, { flag: "wx" });
  } catch {
    try {
      const info = await stat(lock);
      if (Date.now() - info.mtimeMs < 10 * 60 * 1000) return { started: false, reason: "already-building" };
      await unlink(lock);
      await writeFile(lock, stamp, { flag: "wx" });
    } catch {
      return { started: false, reason: "lock" };
    }
  }
  try {
    const worker = fileURLToPath(new URL("./semantic-worker.mjs", import.meta.url));
    const child = spawn(process.execPath, [worker, dir, lock, expectedProfile], { detached: true, stdio: "ignore" });
    child.unref();
    return { started: true };
  } catch (error) {
    await unlink(lock).catch(() => {});
    return { started: false, reason: String(error?.message ?? error) };
  }
}
