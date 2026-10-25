/**
 * 条款级 SQLite FTS5 索引（Node 内置 node:sqlite；不可用时调用方回退 ripgrep）。
 * 不改变 markdown/parts；索引放 <kb>/.index/fts.sqlite。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { splitClauses } from "./clauses.js";

let sqlitePromise = null;
async function loadSqlite() {
  if (!sqlitePromise) sqlitePromise = import("node:sqlite").catch(() => null);
  return sqlitePromise;
}

/** 中文预分词：Segmenter 词 + CJK 二元组 + 数字/标准号；FTS5 unicode61 不切中文。 */
export function manifestStamp(manifest) {
  const hash = createHash("sha256");
  for (const doc of manifest?.docs ?? []) {
    hash.update(`${doc.id}\u0000${doc.version ?? 0}\u0000${doc.updatedAt ?? ""}\u0000${doc.status ?? ""}\n`);
  }
  return hash.digest("hex");
}

export function tokenizeForFts(value) {
  const text = String(value ?? "").normalize("NFKC").toLowerCase();
  const out = new Set();
  let segmenter = null;
  try {
    segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  } catch {
    segmenter = null;
  }
  if (segmenter) {
    for (const item of segmenter.segment(text)) {
      const word = String(item.segment ?? "").trim();
      if (word.length >= 2 && /[\p{L}\p{N}]/u.test(word)) out.add(word);
    }
  }
  const cjkRuns = text.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  for (const word of text.match(/[a-z][a-z0-9/._-]{1,30}|\d+(?:\.\d+){1,6}/g) ?? []) {
    out.add(word);
    const compact = word.replace(/[^a-z0-9]/g, "");
    if (compact.length >= 2) out.add(compact);
  }
  return [...out].join(" ");
}

function ftsQuery(tokens) {
  const words = String(tokens ?? "").split(/\s+/).filter(Boolean);
  return words.map((word) => `"${word.replace(/"/g, '""')}"`).join(" OR ");
}

async function openDb(path) {
  const mod = await loadSqlite();
  if (!mod?.DatabaseSync) return null;
  const db = new mod.DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY, title TEXT, standard_no TEXT, year INTEGER, part TEXT, stage TEXT, trust TEXT, updated_at TEXT, version INTEGER);
    CREATE TABLE IF NOT EXISTS clauses(id INTEGER PRIMARY KEY, doc_id TEXT, part INTEGER, clause TEXT, heading TEXT, page_start INTEGER, page_end INTEGER, line_start INTEGER, line_end INTEGER, text TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS clauses_fts USING fts5(tokens, clause, heading, content='');
  `);
  return db;
}

function insertDoc(db, doc) {
  db.prepare("INSERT OR REPLACE INTO docs(id,title,standard_no,year,part,stage,trust,updated_at,version) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(doc.id, doc.title ?? "", doc.standardNo ?? "", doc.standardYear ?? null, doc.standardPart ?? null, doc.stage ?? "", doc.trust ?? "", doc.updatedAt ?? "", doc.version ?? 0);
}

function insertClause(db, clause) {
  const tokens = tokenizeForFts(`${clause.heading} ${clause.text} ${clause.clause}`);
  const result = db.prepare("INSERT INTO clauses(doc_id,part,clause,heading,page_start,page_end,line_start,line_end,text) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(clause.docId, clause.part ?? 1, clause.clause ?? "", clause.heading ?? "", clause.pageStart ?? null, clause.pageEnd ?? null, clause.lineStart ?? 0, clause.lineEnd ?? 0, clause.text ?? "");
  const rowid = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO clauses_fts(rowid,tokens,clause,heading) VALUES (?,?,?,?)")
    .run(rowid, tokens, clause.clause ?? "", clause.heading ?? "");
}

const SCHEMA_VERSION = "2";

async function readDocMarkdown(dir, doc) {
  try {
    return await readFile(join(dir, "markdown", doc.id, `${doc.id}.md`), "utf8");
  } catch {
    return null;
  }
}

function resetIndex(db) {
  db.exec("DROP TABLE IF EXISTS clauses_fts; CREATE VIRTUAL TABLE clauses_fts USING fts5(tokens, clause, heading, content='', contentless_delete=1);");
  db.exec("DELETE FROM clauses; DELETE FROM docs;");
}

function deleteIndexedDoc(db, docId) {
  const rows = db.prepare("SELECT id FROM clauses WHERE doc_id = ?").all(docId);
  if (rows.length > 0) {
    const placeholders = rows.map(() => "?").join(",");
    db.prepare(`DELETE FROM clauses_fts WHERE rowid IN (${placeholders})`).run(...rows.map((row) => row.id));
  }
  db.prepare("DELETE FROM clauses WHERE doc_id = ?").run(docId);
  db.prepare("DELETE FROM docs WHERE id = ?").run(docId);
}

function indexDoc(db, doc, markdown) {
  insertDoc(db, doc);
  const merged = markdown.replace(/^#\s+.*\r?\n/, "");
  const list = splitClauses(merged, { docId: doc.id });
  if (list.length === 0) {
    const text = merged.replace(/^#\s+.*\r?\n/, "").replace(/\s+/g, " ").trim().slice(0, 800);
    list.push({ docId: doc.id, clause: "", heading: doc.title ?? "", text, pageStart: null, pageEnd: null, lineStart: 1, lineEnd: 1 });
  }
  for (const clause of list) insertClause(db, clause);
  return list.length;
}

function currentDocs(manifest) {
  const map = new Map();
  for (const doc of manifest?.docs ?? []) {
    if (doc.status !== "ready" || doc.deletedAt) continue;
    map.set(doc.id, doc);
  }
  return map;
}

function indexCounts(db) {
  const docs = db.prepare("SELECT COUNT(*) AS n FROM docs").get()?.n ?? 0;
  const clauses = db.prepare("SELECT COUNT(*) AS n FROM clauses").get()?.n ?? 0;
  return { docs: Number(docs), clauses: Number(clauses) };
}

async function buildFull(db, dir, manifest, stamp) {
  resetIndex(db);
  let docs = 0;
  let clauses = 0;
  for (const doc of currentDocs(manifest).values()) {
    const markdown = await readDocMarkdown(dir, doc);
    if (markdown === null) continue;
    clauses += indexDoc(db, doc, markdown);
    docs += 1;
  }
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('schemaVersion',?),('builtAt',?),('manifestStamp',?)")
    .run(SCHEMA_VERSION, new Date().toISOString(), String(stamp ?? ""));
  return { docs, clauses };
}

async function buildIncremental(db, dir, manifest, stamp) {
  const previous = new Map(db.prepare("SELECT id,version,updated_at FROM docs").all().map((row) => [row.id, row]));
  const current = currentDocs(manifest);
  let removed = 0;
  let changed = 0;
  let added = 0;
  for (const id of previous.keys()) {
    if (!current.has(id)) {
      deleteIndexedDoc(db, id);
      removed += 1;
    }
  }
  for (const [id, doc] of current) {
    const prev = previous.get(id);
    if (prev && Number(prev.version ?? 0) === Number(doc.version ?? 0) && String(prev.updated_at ?? "") === String(doc.updatedAt ?? "")) continue;
    const markdown = await readDocMarkdown(dir, doc);
    if (markdown === null) {
      if (prev) {
        deleteIndexedDoc(db, id);
        removed += 1;
      }
      continue;
    }
    if (prev) deleteIndexedDoc(db, id);
    indexDoc(db, doc, markdown);
    if (prev) changed += 1;
    else added += 1;
  }
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('schemaVersion',?),('builtAt',?),('manifestStamp',?)")
    .run(SCHEMA_VERSION, new Date().toISOString(), String(stamp ?? ""));
  return { ...indexCounts(db), removed, changed, added };
}

/** 只检查，不建索引；供 kb_query 判断是否回退 ripgrep 并后台构建。 */
export async function ftsIndexStatus(dir, manifest) {
  await mkdir(join(dir, ".index"), { recursive: true });
  const db = await openDb(join(dir, ".index", "fts.sqlite"));
  if (!db) return { ok: false, fresh: false, reason: "node:sqlite 不可用" };
  try {
    const schema = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value;
    const built = db.prepare("SELECT value FROM meta WHERE key='manifestStamp'").get()?.value;
    return { ok: true, fresh: schema === SCHEMA_VERSION && built === manifestStamp(manifest), schema, built };
  } catch (error) {
    return { ok: false, fresh: false, reason: String(error?.message ?? error) };
  } finally {
    db.close();
  }
}

/** 启动独立构建进程；失败/已有构建时返回原因，不阻塞当前检索。 */
export async function startBackgroundFtsBuild(dir) {
  const indexDir = join(dir, ".index");
  await mkdir(indexDir, { recursive: true });
  const lock = join(indexDir, "build.lock");
  try {
    await writeFile(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
  } catch {
    try {
      const info = await stat(lock);
      if (Date.now() - info.mtimeMs < 10 * 60 * 1000) return { started: false, reason: "already-building" };
      await unlink(lock);
      await writeFile(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
    } catch {
      return { started: false, reason: "lock" };
    }
  }
  try {
    const worker = fileURLToPath(new URL("./fts-worker.mjs", import.meta.url));
    const child = spawn(process.execPath, [worker, dir, lock], { detached: true, stdio: "ignore" });
    child.unref();
    return { started: true };
  } catch (error) {
    await unlink(lock).catch(() => {});
    return { started: false, reason: String(error?.message ?? error) };
  }
}

/** 全量/增量构建：manifest 版本/更新时间变化时只重建变动文档。 */
export async function buildFtsIndex(dir, manifest, { force = false, stamp = "", incremental = true } = {}) {
  const indexDir = join(dir, ".index");
  await mkdir(indexDir, { recursive: true });
  const path = join(indexDir, "fts.sqlite");
  const db = await openDb(path);
  if (!db) return { ok: false, reason: "node:sqlite 不可用", path };
  try {
    const schema = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()?.value;
    const built = db.prepare("SELECT value FROM meta WHERE key='manifestStamp'").get()?.value;
    if (!force && schema === SCHEMA_VERSION && stamp && built === stamp) {
      return { ok: true, skipped: true, path };
    }
    let result;
    let mode = "full";
    if (!force && incremental && schema === SCHEMA_VERSION) {
      try {
        result = await buildIncremental(db, dir, manifest, stamp);
        mode = "incremental";
      } catch {
        // 老库/半写坏库不支持 contentless_delete 时退回全量，保证查询可用。
        result = null;
      }
    }
    if (!result) {
      result = await buildFull(db, dir, manifest, stamp);
      mode = "full";
    }
    return { ok: true, path, mode, ...result, builtAt: new Date().toISOString() };
  } finally {
    db.close();
  }
}

/** BM25 查询；返回 clause 级命中。 */
export async function searchFtsIndex(dir, query, { limit = 40, docId = "" } = {}) {
  const db = await openDb(join(dir, ".index", "fts.sqlite"));
  if (!db) return { ok: false, reason: "node:sqlite 不可用", matches: [] };
  try {
    const tokens = tokenizeForFts(query);
    if (!tokens) return { ok: true, matches: [] };
    const rows = db.prepare(`
      SELECT c.doc_id AS docId, c.part, c.clause, c.heading, c.text, c.page_start AS pageStart,
             c.page_end AS pageEnd, c.line_start AS lineStart, c.line_end AS lineEnd,
             d.title, d.standard_no AS standardNo, d.trust,
             bm25(clauses_fts, 1.0, 2.0, 2.5) AS rank
      FROM clauses_fts
      JOIN clauses c ON c.id = clauses_fts.rowid
      JOIN docs d ON d.id = c.doc_id
      WHERE clauses_fts MATCH ?
        ${docId ? "AND c.doc_id = ?" : ""}
      ORDER BY rank
      LIMIT ?
    `).all(...[
      ftsQuery(tokens),
      ...(docId ? [docId] : []),
      Math.max(1, Math.min(500, Number(limit) || 40)),
    ]);
    return { ok: true, matches: rows, tokens };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error), matches: [] };
  } finally {
    db.close();
  }
}
