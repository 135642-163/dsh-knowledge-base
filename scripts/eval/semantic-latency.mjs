/**
 * 0.31.1：真实嵌入延迟复测（只读）。
 *
 * 与 `eval-benchmark.mjs --semantic-sim` 的区别：查询嵌入走**真实 D1a 运行时**
 * （onnxruntime-node + tokenizer + bge-small-zh-v1.5），B 检索与两阶段页码走真实
 * 生产函数（`lib/search.js`、`lib/fts-index.js`），向量来自 0.30 预计算矩阵
 * （避免每次重跑 911 篇建索引）。
 *
 * 为了不改真实库索引：fts.sqlite 复制到临时目录后补 `clauses(doc_id)` 索引。
 *
 * 用法：
 *   node scripts/eval/semantic-latency.mjs \
 *     --doc-vectors /tmp/kb-eval-030/vec-docs \
 *     --doc-matrix /tmp/kb-eval-030-docs/clauses.f32 \
 *     --questions scripts/eval/questions-2026-10-27.jsonl,scripts/eval/questions-2026-10-30-paraphrase.jsonl
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tokenizeForFts } from "../../lib/fts-index.js";
import { searchFtsIndexInDocs } from "../../lib/fts-index.js";
import { applySemanticToResults, groupHitsByDoc, rankResults } from "../../lib/search.js";
import { keywordsOfQuery } from "../../lib/sources.js";
import { createSemanticRuntime } from "../../lib/semantic-runtime.js";

const DEFAULT_DIR = "/Users/littlesun/workspace/knowledge/标准";
const DEFAULTS = {
  dir: DEFAULT_DIR,
  docVectors: "/tmp/kb-eval-030/vec-docs",
  docMatrix: "/tmp/kb-eval-030-docs/clauses.f32",
  questions: "scripts/eval/questions-2026-10-27.jsonl,scripts/eval/questions-2026-10-30-paraphrase.jsonl",
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, out: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") options.dir = argv[++i];
    else if (arg === "--doc-vectors") options.docVectors = argv[++i];
    else if (arg === "--doc-matrix") options.docMatrix = argv[++i];
    else if (arg === "--questions") options.questions = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
  }
  return options;
}

async function loadQuestions(paths) {
  const items = [];
  for (const path of String(paths ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (line.trim() !== "") items.push(JSON.parse(line));
    }
  }
  return items;
}

function ftsQueryOf(query) {
  const tokens = tokenizeForFts(query);
  if (!tokens) return "";
  return tokens.split(/\s+/).filter(Boolean).map((word) => `"${word.replace(/"/g, '""')}"`).join(" OR ");
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: Number((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(2)),
    p50: Number(percentile(sorted, 0.5).toFixed(2)),
    p95: Number(percentile(sorted, 0.95).toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

const options = parseArgs(process.argv.slice(2));
const questions = await loadQuestions(options.questions);
const manifest = JSON.parse(await readFile(join(options.dir, "kb.json"), "utf8"));
const docs = manifest.docs ?? [];

// 向量矩阵（0.30 文档级向量）
const meta = JSON.parse(await readFile(join(options.docVectors, "meta.json"), "utf8"));
const dim = Number(meta.dim) || 512;
const rows = (await readFile(join(options.docVectors, "docs.jsonl"), "utf8"))
  .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
const matrixBuffer = await readFile(options.docMatrix);
if (matrixBuffer.byteLength < rows.length * dim * 4) throw new Error("文档向量矩阵大小不符");
const matrix = new Float32Array(matrixBuffer.buffer, matrixBuffer.byteOffset, rows.length * dim);
const ids = rows.map((row) => row.docId);
const vectors = ids.map((_id, index) => matrix.subarray(index * dim, (index + 1) * dim));

// 临时索引（不改真实库）
const tempRoot = await mkdtemp(join(tmpdir(), "kb-semantic-latency-"));
const tempIndex = join(tempRoot, ".index");
await mkdir(tempIndex, { recursive: true });
await copyFile(join(options.dir, ".index", "fts.sqlite"), join(tempIndex, "fts.sqlite"));
const writable = new DatabaseSync(join(tempIndex, "fts.sqlite"));
writable.exec("CREATE INDEX IF NOT EXISTS clauses_doc_id_idx ON clauses(doc_id)");
writable.close();
const db = new DatabaseSync(join(tempIndex, "fts.sqlite"), { readOnly: true });

function ftsRows(query, limit = 60) {
  const where = ftsQueryOf(query);
  if (!where) return [];
  return db.prepare(`
    SELECT c.doc_id AS docId, c.part, c.clause, c.heading, c.text,
           c.page_start AS pageStart, c.page_end AS pageEnd, c.line_start AS lineStart,
           d.title, d.standard_no AS standardNo, d.trust,
           bm25(clauses_fts, 1.0, 2.0, 2.5) AS rank
    FROM clauses_fts
    JOIN clauses c ON c.id = clauses_fts.rowid
    JOIN docs d ON d.id = c.doc_id
    WHERE clauses_fts MATCH ? ORDER BY rank LIMIT ?
  `).all(where, limit);
}

const runtime = createSemanticRuntime();
const loadStarted = performance.now();
const runtimeStatus = await runtime.status();
const loadMs = performance.now() - loadStarted;
if (!runtimeStatus.available) {
  process.stderr.write(`语义运行时不可用：${runtimeStatus.reason} ${runtimeStatus.detail ?? ""}\n`);
  process.exitCode = 2;
} else {
  const target = { kb: "标准", dir: tempRoot, docs };
  const queryVectors = new Map();

  async function bResults(question) {
    const started = performance.now();
    const rows = ftsRows(question.q);
    const hits = rows.map((row) => ({
      docId: row.docId,
      pageStart: row.pageStart,
      pageEnd: row.pageEnd,
      clause: row.clause,
      lineNumber: row.lineStart,
      line: `${row.clause ? `[${row.clause}] ` : ""}${row.heading ? `${row.heading} — ` : ""}${String(row.text ?? "").replace(/\s+/g, " ")}`,
      trust: row.trust,
    }));
    const ranked = rankResults(
      groupHitsByDoc(hits, { docs, kb: "标准" }),
      { terms: keywordsOfQuery(question.q), query: question.q, boost: true },
    );
    return { ranked, elapsed: performance.now() - started };
  }

  // 预热：模型、JIT、索引页
  for (const question of questions.slice(0, 3)) {
    const { ranked } = await bResults(question);
    const embedded = await runtime.embedQuery(question.q);
    queryVectors.set(question.id, embedded.vector);
    await applySemanticToResults({
      results: ranked,
      targets: [target],
      query: question.q,
      terms: keywordsOfQuery(question.q),
      semantic: {
        enabled: true,
        note: "",
        async loadIndex() { return { ok: true, fresh: true, dim, ids, vectors }; },
        async embedQuery() { return { ok: true, vector: embedded.vector, dim }; },
        async locateMany(_target, docIds, query) {
          const found = await searchFtsIndexInDocs(tempRoot, query, docIds, { limit: 20 });
          return found.rowsByDoc;
        },
      },
    });
    void embedded;
  }

  const totals = [];
  const bTimes = [];
  const embedTimes = [];
  const applyTimes = [];
  let applied = 0;
  for (const question of questions) {
    const b = await bResults(question);
    const embedStarted = performance.now();
    const embedded = await runtime.embedQuery(question.q);
    embedTimes.push(performance.now() - embedStarted);
    if (!embedded.ok) throw new Error(`查询嵌入失败：${embedded.reason}`);
    const applyStarted = performance.now();
    const outcome = await applySemanticToResults({
      results: b.ranked,
      targets: [target],
      query: question.q,
      terms: keywordsOfQuery(question.q),
      semantic: {
        enabled: true,
        note: "",
        async loadIndex() { return { ok: true, fresh: true, dim, ids, vectors }; },
        async embedQuery() { return { ok: true, vector: embedded.vector, dim }; },
        async locateMany(_target, docIds, query) {
          const found = await searchFtsIndexInDocs(tempRoot, query, docIds, { limit: 20 });
          return found.rowsByDoc;
        },
      },
    });
    applyTimes.push(performance.now() - applyStarted);
    if (outcome.applied) applied += 1;
    bTimes.push(b.elapsed);
    totals.push(b.elapsed + embedTimes[embedTimes.length - 1] + applyTimes[applyTimes.length - 1]);
  }

  const out = {
    queries: questions.length,
    applied,
    loadMs: Number(loadMs.toFixed(1)),
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    total: stats(totals),
    b: stats(bTimes),
    embed: stats(embedTimes),
    apply: stats(applyTimes),
    config: { dim, docs: ids.length, dir: options.dir },
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (options.out) await writeFile(options.out, `${JSON.stringify(out, null, 2)}\n`, "utf8");
}

db.close();
await rm(tempRoot, { recursive: true, force: true });
