#!/usr/bin/env node
/**
 * 只读摘要候选报告：找出封面/OCR 噪声摘要，尝试从正文提取“本标准规定了…”范围句。
 * 不写知识库、不修改摘要；输出 markdown 供人工复核后用 kb_describe 应用。
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandRoot, kbDirPath, readManifest } from "../lib/store.js";
import { extractScopeSummary, looksNoisySummary } from "../lib/summary-candidates.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}
const dir = arg("--dir", kbDirPath(expandRoot("~/workspace/knowledge"), "标准"));
const out = arg("--out", join(root, "docs", "reports", "2026-10-31-standard-summary-candidates.md"));
const manifest = await readManifest(dir);
const docs = (manifest.docs ?? []).filter((doc) => doc.status === "ready" && !doc.deletedAt);
const rows = [];
for (const doc of docs) {
  if (!looksNoisySummary(doc.summary)) continue;
  let markdown = "";
  try {
    markdown = await readFile(join(dir, "markdown", doc.id, `${doc.id}.md`), "utf8");
  } catch {
    /* 派生正文缺失 */
  }
  const proposed = extractScopeSummary(markdown);
  rows.push({
    id: doc.id,
    title: String(doc.title ?? ""),
    current: String(doc.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
    proposed,
  });
}
const withProposal = rows.filter((row) => row.proposed !== "");
const lines = [
  "# 标准库摘要候选（只读）",
  "",
  `- 知识库：\`${manifest.name ?? dir}\``,
  `- ready 文档：${docs.length}`,
  `- 疑似噪声摘要：${rows.length}`,
  `- 可自动提取范围句：${withProposal.length}`,
  `- 需要人工查看：${rows.length - withProposal.length}`,
  "",
  "> 本报告不修改知识库。确认某条后，用 `kb_describe(doc=<id>, summary=<proposed>)` 应用。",
  "",
  "## 可提取范围句",
  "",
  "| id | 标题 | 当前摘要（截断） | 建议摘要 |",
  "|---|---|---|---|",
  ...withProposal.map((row) => `| ${row.id} | ${row.title.replace(/\|/g, "\\|")} | ${row.current.replace(/\|/g, "\\|")} | ${row.proposed.replace(/\|/g, "\\|")} |`),
  "",
  "## 需要人工查看",
  "",
  "| id | 标题 | 当前摘要（截断） |",
  "|---|---|---|",
  ...rows.filter((row) => !row.proposed).map((row) => `| ${row.id} | ${row.title.replace(/\|/g, "\\|")} | ${row.current.replace(/\|/g, "\\|")} |`),
  "",
];
await writeFile(out, `${lines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ docs: docs.length, noisy: rows.length, withProposal: withProposal.length, out }, null, 2));
