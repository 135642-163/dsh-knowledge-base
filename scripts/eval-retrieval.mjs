/**
 * FTS5 检索快速评测：从真实库抽取 60 条可定位条款，作为“条款定位”合成题，
 * 统计 Doc Recall@10 / Page Recall@10 / MRR@10 / p95。
 * 注意：这是机制回归，不是人工语义评测；语义题需另行人工标注。
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { searchFtsIndex } from "../lib/fts-index.js";

const dir = process.argv[2] ?? "/Users/littlesun/workspace/knowledge/标准";
const out = process.argv[3] ?? "docs/specs/2026-10-25-retrieval-eval.md";
const db = new DatabaseSync(join(dir, ".index", "fts.sqlite"));
const rows = db.prepare(`
  SELECT c.id, c.doc_id AS docId, c.page_start AS page, c.clause, c.heading, c.text,
         d.title, d.standard_no AS standardNo
  FROM clauses c JOIN docs d ON d.id = c.doc_id
  WHERE length(c.text) >= 40 AND c.page_start IS NOT NULL
    AND c.text NOT LIKE '%..%' AND c.text NOT LIKE '%……%'
  ORDER BY c.id
`).all();
db.close();
const picked = [];
const seen = new Set();
for (const row of rows) {
  if (seen.has(row.docId)) continue;
  const raw = String(row.heading || row.text || "").replace(/\s+/g, " ").trim();
  const query = raw.slice(0, 28);
  // 机制回归题只取包含足够中文的条款，避开 O R R I G E N D U M/版权页等噪声。
  if (query.length < 6 || (query.match(/[\u4e00-\u9fa5]/g) ?? []).length < 5) continue;
  if (/corrigendum|amend|copyright|international electrotechnical|all rights reserved/i.test(query)) continue;
  picked.push({ ...row, query });
  seen.add(row.docId);
  if (picked.length >= 60) break;
}
const results = [];
for (const q of picked) {
  const started = performance.now();
  const r = await searchFtsIndex(dir, q.query, { limit: 10 });
  const ms = performance.now() - started;
  const matches = r.matches ?? [];
  const docRank = matches.findIndex((m) => m.docId === q.docId) + 1;
  const pageRank = matches.findIndex((m) => m.docId === q.docId && (m.pageStart === q.page || m.pageEnd === q.page)) + 1;
  results.push({ q, docRank, pageRank, ms, top: matches.slice(0, 3).map((m) => `${m.title} p${m.pageStart}`) });
}
const n = results.length;
const docHits = results.filter((r) => r.docRank > 0).length;
const pageHits = results.filter((r) => r.pageRank > 0).length;
const mrr = results.reduce((sum, r) => sum + (r.docRank > 0 ? 1 / r.docRank : 0), 0) / n;
const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
const lines = [
  "# FTS5 检索评测（60 条条款定位）",
  "",
  `- 库：\`${dir}\``,
  `- 题数：${n}（从真实条款按文档去重后均匀抽取；查询为条款开头 28 字）`,
  `- Doc Recall@10：${(docHits / n * 100).toFixed(1)}%（${docHits}/${n}）`,
  `- Page Recall@10：${(pageHits / n * 100).toFixed(1)}%（${pageHits}/${n}）`,
  `- MRR@10：${mrr.toFixed(3)}`,
  `- p95：${p95.toFixed(1)}ms`,
  "",
  "> 这是**机制回归题**（查询直接取条款原文开头），用于验证索引、页码和排序链路；不代表人工语义检索效果。下一步应补 20–60 条人工问题（条款定位/跨文档/数值/同义改写）。",
  "",
  "## 逐题结果",
  "",
  "| # | 查询 | 期望文档 | 期望页 | Doc rank | Page rank | ms |",
  "|---|---|---|---|---|---|---|",
];
results.forEach((r, i) => {
  lines.push(`| ${i + 1} | ${r.q.query.replace(/\|/g, "\\|")} | ${r.q.standardNo} ${r.q.title} | ${r.q.page} | ${r.docRank || "—"} | ${r.pageRank || "—"} | ${r.ms.toFixed(1)} |`);
});
await writeFile(out, lines.join("\n"), "utf8");
console.log(JSON.stringify({ n, docHits, pageHits, mrr, p95, out }, null, 2));
