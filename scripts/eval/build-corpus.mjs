/**
 * 0.29 混合检索评测的第一步：从真实库的只读 FTS 索引里导出「可嵌入的条款文本」。
 *
 * 只读：sqlite 用 readOnly 打开，不写知识库、不改清单。
 *
 * 产物（默认 /tmp/kb-eval-029）：
 *   clauses.jsonl   每行 { id, text }，id = clauses.id（供评测脚本回查 doc/page/clause）
 *   queries.json    60 条人工问题的 { id, q }（与 0.27 数据集同源）
 *   stats.json      语料统计（条数、字符分布、来源库、索引体积）
 *
 * 用法：
 *   node scripts/eval/build-corpus.mjs [--dir <标准库目录>] [--out <产物目录>] [--max-chars 480]
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clauseText } from "./fusion.mjs";

const DEFAULT_DIR = "/Users/littlesun/workspace/knowledge/标准";
const DEFAULT_OUT = "/tmp/kb-eval-029";
const DEFAULT_MAX_CHARS = 480;
const QUESTIONS = new URL("./questions-2026-10-27.jsonl", import.meta.url);

function parseArgs(argv) {
  const options = { dir: DEFAULT_DIR, out: DEFAULT_OUT, maxChars: DEFAULT_MAX_CHARS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") options.dir = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--max-chars") options.maxChars = Number(argv[++i]) || DEFAULT_MAX_CHARS;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = new DatabaseSync(join(options.dir, ".index", "fts.sqlite"), { readOnly: true });
  let rows;
  try {
    rows = db.prepare(`
      SELECT c.id AS id, c.doc_id AS docId, c.page_start AS page, c.clause, c.heading, c.text,
             d.title, d.standard_no AS standardNo
      FROM clauses c
      JOIN docs d ON d.id = c.doc_id
      ORDER BY c.id
    `).all();
  } finally {
    db.close();
  }
  await mkdir(options.out, { recursive: true });
  const lines = [];
  let totalChars = 0;
  let empty = 0;
  for (const row of rows) {
    const text = clauseText(row, options.maxChars);
    if (text.length < 8) {
      empty += 1;
      continue;
    }
    totalChars += text.length;
    lines.push(JSON.stringify({ id: row.id, text }));
  }
  await writeFile(join(options.out, "clauses.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const questions = (await readFile(QUESTIONS, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .map((item) => ({ id: item.id, q: item.q }));
  await writeFile(join(options.out, "queries.json"), `${JSON.stringify(questions, null, 2)}\n`, "utf8");

  const indexStat = await stat(join(options.dir, ".index", "fts.sqlite")).catch(() => null);
  const stats = {
    dir: options.dir,
    generatedAt: new Date().toISOString(),
    clauses: lines.length,
    skipped: empty,
    docs: new Set(rows.map((row) => row.docId)).size,
    maxChars: options.maxChars,
    avgChars: lines.length === 0 ? 0 : Number((totalChars / lines.length).toFixed(1)),
    indexBytes: indexStat?.size ?? null,
    queries: questions.length,
    out: options.out,
  };
  await writeFile(join(options.out, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
}

await main();
