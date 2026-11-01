#!/usr/bin/env node
/**
 * 80 题检索回归（生产 searchAll + FTS 排序，确定性、无需语义模型）。
 *
 * 默认题集：scripts/eval/questions-2026-10-27.jsonl（60 主集）
 *          + scripts/eval/questions-2026-10-30-paraphrase.jsonl（20 独立同义题）
 *
 * 指标：Doc/Page Recall@10、Doc/Page MRR@10、p95。
 * 任一阈值不达标 → exit 1，便于 CI/定时任务发现检索回归。
 *
 * 用法：
 *   node scripts/eval-retrieval-80.mjs
 *   node scripts/eval-retrieval-80.mjs --dir ~/workspace/knowledge/标准 --out /tmp/eval.json
 *   node scripts/eval-retrieval-80.mjs --min-doc-recall 0.85 --max-p95 250
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchFtsIndex } from "../lib/fts-index.js";
import { searchAll } from "../lib/search.js";
import { expandRoot, kbDirPath, readManifest } from "../lib/store.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_QUESTIONS = [
  join(root, "scripts", "eval", "questions-2026-10-27.jsonl"),
  join(root, "scripts", "eval", "questions-2026-10-30-paraphrase.jsonl"),
];

function parseArgs(argv) {
  const args = {
    dir: kbDirPath(expandRoot("~/workspace/knowledge"), "标准"),
    questions: [...DEFAULT_QUESTIONS],
    limit: 10,
    minDocRecall: 0.85,
    minPageRecall: 0.62,
    minDocMrr: 0.52,
    minPageMrr: 0.40,
    maxP95: 250,
    out: "",
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") args.dir = expandRoot(argv[++i] ?? args.dir);
    else if (arg === "--questions") {
      args.questions = args.questions === DEFAULT_QUESTIONS ? [] : args.questions;
      args.questions.push(argv[++i] ?? "");
    } else if (arg === "--limit") args.limit = Math.max(1, Math.min(100, Number(argv[++i]) || 10));
    else if (arg === "--min-doc-recall") args.minDocRecall = Number(argv[++i]);
    else if (arg === "--min-page-recall") args.minPageRecall = Number(argv[++i]);
    else if (arg === "--min-doc-mrr") args.minDocMrr = Number(argv[++i]);
    else if (arg === "--min-page-mrr") args.minPageMrr = Number(argv[++i]);
    else if (arg === "--max-p95") args.maxP95 = Number(argv[++i]);
    else if (arg === "--out") args.out = argv[++i] ?? "";
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`用法: node scripts/eval-retrieval-80.mjs [选项]
  --dir <库目录>             默认 ~/workspace/knowledge/标准
  --questions <jsonl>        可重复；默认 60 主集 + 20 同义题
  --limit <n>                @10 的 k（默认 10）
  --min-doc-recall <0-1>     默认 0.85
  --min-page-recall <0-1>    默认 0.62
  --min-doc-mrr <0-1>        默认 0.52
  --min-page-mrr <0-1>       默认 0.40
  --max-p95 <ms>             默认 250
  --out <json>               可选，写机器可读结果
  --quiet                    只输出汇总/失败项`);
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  return args;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function rankExpectation(results, expected, limit) {
  const byId = new Map();
  for (const item of expected ?? []) {
    if (!item?.docId) continue;
    const list = byId.get(item.docId) ?? [];
    list.push(item);
    byId.set(item.docId, list);
  }
  let docRank = null;
  let pageRank = null;
  const stop = Math.min(results.length, Math.max(1, limit));
  for (let index = 0; index < stop; index += 1) {
    const row = results[index];
    const items = byId.get(row.docId);
    if (!items) continue;
    if (docRank === null) docRank = index + 1;
    if (pageRank === null) {
      const hit = items.find((item) => {
        if (item.page == null || row.page == null) return false;
        return item.page >= row.page && item.page <= (row.pageEnd ?? row.page);
      });
      if (hit) pageRank = index + 1;
    }
    if (docRank !== null && pageRank !== null) break;
  }
  return { docRank, pageRank };
}

function summarize(rows) {
  const n = rows.length;
  const docHits = rows.filter((r) => r.docRank > 0).length;
  const pageRows = rows.filter((r) => r.pageApplicable);
  const pageHits = pageRows.filter((r) => r.pageRank > 0).length;
  const docMrr = rows.reduce((sum, r) => sum + (r.docRank > 0 ? 1 / r.docRank : 0), 0) / Math.max(1, n);
  const pageMrr = pageRows.reduce((sum, r) => sum + (r.pageRank > 0 ? 1 / r.pageRank : 0), 0) / Math.max(1, pageRows.length);
  const latencies = rows.map((r) => r.ms).sort((a, b) => a - b);
  return {
    n,
    docRecall: n > 0 ? docHits / n : 0,
    pageRecall: pageRows.length > 0 ? pageHits / pageRows.length : 0,
    docMrr,
    pageMrr,
    p95: latencies[Math.min(latencies.length - 1, Math.ceil(n * 0.95) - 1)] ?? 0,
    meanMs: latencies.reduce((sum, ms) => sum + ms, 0) / Math.max(1, n),
    pageApplicable: pageRows.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readManifest(args.dir);
  const docs = (manifest.docs ?? []).filter((doc) => doc.status === "ready" && !doc.deletedAt);
  if (docs.length === 0) throw new Error(`库内没有 ready 文档: ${args.dir}`);

  const questions = [];
  for (const file of args.questions.filter(Boolean)) {
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim()) questions.push(JSON.parse(line));
    }
  }
  if (questions.length === 0) throw new Error("没有题目");

  const rows = [];
  const byGroup = new Map();
  for (const question of questions) {
    const started = performance.now();
    const outcome = await searchAll({
      targets: [{ kb: "标准", dir: args.dir, docs }],
      query: question.q,
      searcher: async (target) => {
        const found = await searchFtsIndex(target.dir, question.q, { limit: 200 });
        return { matches: found.ok ? found.matches : [], engine: "fts" };
      },
    });
    const ms = performance.now() - started;
    const expected = question.expected ?? [];
    const { docRank, pageRank } = rankExpectation(outcome.results ?? [], expected, args.limit);
    const row = {
      id: question.id,
      group: question.group ?? "other",
      query: question.q,
      expected,
      docRank,
      pageRank,
      pageApplicable: expected.some((item) => item.page != null),
      ms,
      top: (outcome.results ?? []).slice(0, 3).map((item) => ({
        docId: item.docId,
        title: item.title,
        page: item.page,
        pageEnd: item.pageEnd,
      })),
    };
    rows.push(row);
    const list = byGroup.get(row.group) ?? [];
    list.push(row);
    byGroup.set(row.group, list);
  }

  const summary = summarize(rows);
  const groups = Object.fromEntries([...byGroup.entries()].map(([group, list]) => [group, summarize(list)]));
  const thresholds = {
    docRecall: args.minDocRecall,
    pageRecall: args.minPageRecall,
    docMrr: args.minDocMrr,
    pageMrr: args.minPageMrr,
    p95: args.maxP95,
  };
  const failures = [];
  if (summary.docRecall < thresholds.docRecall) failures.push(`Doc Recall ${pct(summary.docRecall)} < ${pct(thresholds.docRecall)}`);
  if (summary.pageRecall < thresholds.pageRecall) failures.push(`Page Recall ${pct(summary.pageRecall)} < ${pct(thresholds.pageRecall)}`);
  if (summary.docMrr < thresholds.docMrr) failures.push(`Doc MRR ${summary.docMrr.toFixed(3)} < ${thresholds.docMrr.toFixed(3)}`);
  if (summary.pageMrr < thresholds.pageMrr) failures.push(`Page MRR ${summary.pageMrr.toFixed(3)} < ${thresholds.pageMrr.toFixed(3)}`);
  if (summary.p95 > thresholds.p95) failures.push(`p95 ${summary.p95.toFixed(1)}ms > ${thresholds.p95}ms`);

  const result = {
    ok: failures.length === 0,
    dir: args.dir,
    questions: questions.length,
    k: args.limit,
    metrics: summary,
    groups,
    thresholds,
    failures,
    generatedAt: new Date().toISOString(),
    misses: rows.filter((r) => r.docRank === 0 || (r.pageApplicable && r.pageRank === 0)).map((r) => ({
      id: r.id,
      group: r.group,
      query: r.query,
      expected: r.expected.map((e) => ({ docId: e.docId, title: e.title, page: e.page })),
      docRank: r.docRank,
      pageRank: r.pageRank,
      top: r.top,
    })),
  };
  if (args.out) await writeFile(args.out, JSON.stringify(result, null, 2), "utf8");

  if (!args.quiet) {
    console.log(`80 题检索回归（${args.dir}）`);
    console.log(`题数 ${summary.n}  k=${args.limit}  文档 ${docs.length} 篇`);
    console.log(`Doc Recall@${args.limit}  ${pct(summary.docRecall)}`);
    console.log(`Page Recall@${args.limit} ${pct(summary.pageRecall)}  (${summary.pageApplicable}/${summary.n} 题有页码)`);
    console.log(`Doc MRR@${args.limit}    ${summary.docMrr.toFixed(3)}`);
    console.log(`Page MRR@${args.limit}   ${summary.pageMrr.toFixed(3)}`);
    console.log(`p95 ${summary.p95.toFixed(1)}ms  mean ${summary.meanMs.toFixed(1)}ms`);
    for (const [group, value] of Object.entries(groups)) {
      console.log(`  ${group.padEnd(12)} n=${value.n}  Doc ${pct(value.docRecall)}  Page ${pct(value.pageRecall)}  MRR ${value.pageMrr.toFixed(3)}`);
    }
    if (args.out) console.log(`结果已写入 ${args.out}`);
    if (!result.ok) {
      console.log("\n阈值未通过：");
      for (const failure of failures) console.log(`  ✗ ${failure}`);
      console.log(`\n未命中 ${result.misses.length} 题（前 10）：`);
      for (const miss of result.misses.slice(0, 10)) {
        console.log(`  ${miss.id} [${miss.group}] ${miss.query.slice(0, 60)} → expected ${miss.expected[0]?.docId ?? "?"} p${miss.expected[0]?.page ?? "?"}；top ${miss.top[0]?.docId ?? "—"} p${miss.top[0]?.page ?? "—"}`);
      }
    }
  }
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
