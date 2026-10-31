#!/usr/bin/env node
/**
 * 生产口径语义审计（只读）：
 *   B = searchAll 的真实 boost + FTS 页码；
 *   H = 同一 B + window 质心 dense 的 RRF，并用 locateInDoc 补 dense 独有文档页码。
 * 向量只在内存中构建，不写真实库 .index；模型使用本机 bge-small-zh-v1.5。
 *
 * 用法：node scripts/eval/semantic-production-audit.mjs --dir ~/workspace/knowledge/标准 \
 *   --questions scripts/eval/questions-2026-10-27.jsonl --out /tmp/prod.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandRoot, kbDirPath, readManifest } from "../../lib/store.js";
import { docEmbedText, docProfileTexts, DOC_PROFILE_WINDOW } from "../../lib/semantic-index.js";
import { searchFtsIndex } from "../../lib/fts-index.js";
import { searchAll } from "../../lib/search.js";
import { createSemanticRuntime } from "../../lib/semantic-runtime.js";
import { normalizeVector } from "../../lib/semantic.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function parseArgs(argv) {
  const args = {
    dir: kbDirPath(expandRoot("~/workspace/knowledge"), "标准"),
    questions: join(root, "scripts", "eval", "questions-2026-10-27.jsonl"),
    out: "",
    limit: 10,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dir") args.dir = argv[++i] ?? args.dir;
    else if (argv[i] === "--questions") args.questions = argv[++i] ?? args.questions;
    else if (argv[i] === "--out") args.out = argv[++i] ?? "";
    else if (argv[i] === "--limit") args.limit = Math.max(1, Number(argv[++i]) || 10);
    else throw new Error(`未知参数: ${argv[i]}`);
  }
  return args;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function rankOfExpected(results, expected, limit = 10) {
  const want = new Set((expected ?? []).map((item) => item.docId));
  const pages = new Map((expected ?? []).map((item) => [item.docId, item.page]));
  let docRank = null;
  let pageRank = null;
  const stop = Math.min(results.length, Math.max(1, Number(limit) || 10));
  for (let index = 0; index < stop; index += 1) {
    const row = results[index];
    if (docRank === null && want.has(row.docId)) docRank = index;
    const page = pages.get(row.docId);
    if (pageRank === null && page && row.page && page >= row.page && page <= (row.pageEnd ?? row.page)) pageRank = index;
    if (docRank !== null && pageRank !== null) break;
  }
  return { docRank, pageRank };
}

async function embedAll(runtime, texts, label) {
  const vectors = [];
  for (let start = 0; start < texts.length; start += 16) {
    const out = await runtime.embedDocuments(texts.slice(start, start + 16));
    if (!out.ok) throw new Error(`${label}: ${out.reason}`);
    vectors.push(...out.vectors);
    if (start === 0) console.log(`${label} ${Math.min(start + 16, texts.length)}/${texts.length}`);
  }
  return vectors;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readManifest(args.dir);
  const docs = (manifest.docs ?? []).filter((doc) => doc.status === "ready" && !doc.deletedAt);
  const questions = (await readFile(args.questions, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const runtime = createSemanticRuntime();
  const status = await runtime.status();
  if (!status.available) throw new Error(`语义模型不可用: ${status.reason}`);
  console.log(`docs=${docs.length} questions=${questions.length}`);

  const summaryTexts = [];
  for (const doc of docs) summaryTexts.push(await docEmbedText({ dir: args.dir, doc }));
  const summaryVectors = await embedAll(runtime, summaryTexts, "summary");

  const texts = [];
  const ranges = [];
  for (const doc of docs) {
    const windows = await docProfileTexts({ dir: args.dir, doc, profile: DOC_PROFILE_WINDOW });
    ranges.push({ start: texts.length, count: windows.length });
    texts.push(...windows);
  }
  const vectors = await embedAll(runtime, texts, "windows");
  const centroids = ranges.map(({ start, count }) => {
    const sum = new Float32Array(vectors[0].length);
    for (let i = start; i < start + count; i += 1) {
      for (let d = 0; d < sum.length; d += 1) sum[d] += vectors[i][d];
    }
    return normalizeVector(sum) ?? vectors[start];
  });
  const queryVectors = new Map();
  for (const question of questions) {
    const embedded = await runtime.embedQuery(question.q);
    if (!embedded.ok) throw new Error(`query: ${embedded.reason}`);
    queryVectors.set(question.q, embedded.vector);
  }

  const targets = [{ kb: "标准", dir: args.dir, docs }];
  function makeSemantic(vectors) {
    return {
      enabled: true,
      async loadIndex() {
        return { ok: true, ids: docs.map((doc) => doc.id), vectors, dim: vectors[0]?.length ?? 0 };
      },
      async embedQuery(query) {
        const vector = queryVectors.get(query);
        return vector ? { ok: true, vector } : { ok: false, reason: "query_missing" };
      },
      async locateInDoc(target, docId, query) {
        const found = await searchFtsIndex(target.dir, query, { docId, limit: 20 }).catch(() => null);
        return found?.ok ? found.matches : [];
      },
      note: "",
    };
  }
  const semanticSummary = makeSemantic(summaryVectors);
  const semantic = makeSemantic(centroids);

  const metrics = { B: [], S: [], H: [] };
  const timings = { B: [], S: [], H: [] };
  for (const question of questions) {
    const baseStart = performance.now();
    const base = await searchAll({
      targets,
      query: question.q,
      searcher: async (target) => {
        const found = await searchFtsIndex(target.dir, question.q, { limit: 200 });
        return { matches: found.ok ? found.matches : [], engine: "fts" };
      },
    });
    timings.B.push(performance.now() - baseStart);
    const baseRank = rankOfExpected(base.results, question.expected, args.limit);
    metrics.B.push({ id: question.id, group: question.group, ...baseRank });

    const summaryStart = performance.now();
    const summary = await searchAll({
      targets,
      query: question.q,
      searcher: async (target) => {
        const found = await searchFtsIndex(target.dir, question.q, { limit: 200 });
        return { matches: found.ok ? found.matches : [], engine: "fts" };
      },
      semantic: semanticSummary,
    });
    timings.S.push(performance.now() - summaryStart);
    const summaryRank = rankOfExpected(summary.results, question.expected, args.limit);
    metrics.S.push({ id: question.id, group: question.group, ...summaryRank, applied: summary.semantic?.applied, reason: summary.semantic?.reason });

    const hybridStart = performance.now();
    const hybrid = await searchAll({
      targets,
      query: question.q,
      searcher: async (target) => {
        const found = await searchFtsIndex(target.dir, question.q, { limit: 200 });
        return { matches: found.ok ? found.matches : [], engine: "fts" };
      },
      semantic,
    });
    timings.H.push(performance.now() - hybridStart);
    const hybridRank = rankOfExpected(hybrid.results, question.expected, args.limit);
    metrics.H.push({ id: question.id, group: question.group, ...hybridRank, applied: hybrid.semantic?.applied, reason: hybrid.semantic?.reason });
  }

  const summarize = (rows) => {
    const n = rows.length;
    const docs = rows.map((row) => row.docRank).filter((rank) => rank !== null);
    const pages = rows.map((row) => row.pageRank).filter((rank) => rank !== null);
    const rr = rows.reduce((sum, row) => sum + (row.docRank === null ? 0 : 1 / (row.docRank + 1)), 0) / n;
    const pageRr = rows.reduce((sum, row) => sum + (row.pageRank === null ? 0 : 1 / (row.pageRank + 1)), 0) / n;
    return {
      questions: n,
      docRecall: docs.length / n,
      docMrr: rr,
      pageRecall: pages.length / n,
      pageMrr: pageRr,
      groups: Object.fromEntries([...new Set(rows.map((row) => row.group))].map((group) => {
        const list = rows.filter((row) => row.group === group);
        return [group, {
          n: list.length,
          docRecall: list.filter((row) => row.docRank !== null).length / list.length,
          pageRecall: list.filter((row) => row.pageRank !== null).length / list.length,
        }];
      })),
    };
  };
  const p95 = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  };
  const result = {
    dir: args.dir,
    docs: docs.length,
    questions: questions.length,
    limit: args.limit,
    B: summarize(metrics.B),
    S: summarize(metrics.S),
    H: summarize(metrics.H),
    latencyMs: {
      B: { mean: timings.B.reduce((a, b) => a + b, 0) / timings.B.length, p95: p95(timings.B) },
      S: { mean: timings.S.reduce((a, b) => a + b, 0) / timings.S.length, p95: p95(timings.S) },
      H: { mean: timings.H.reduce((a, b) => a + b, 0) / timings.H.length, p95: p95(timings.H) },
    },
    rows: metrics,
  };
  console.log(JSON.stringify(result, null, 2));
  if (args.out) await writeFile(args.out, JSON.stringify(result, null, 2), "utf8");
  await runtime.dispose();
}

main().catch((error) => {
  console.error(`审计失败: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});
