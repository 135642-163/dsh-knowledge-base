/**
 * 0.30 评测：导出「文档级」嵌入语料（911 篇，比条款级便宜两个数量级）。
 *
 * 只读：sqlite 用 readOnly 打开，不写知识库。
 * 产物（默认 /tmp/kb-eval-030）：
 *   clauses.jsonl  每行 { id（从 0 递增）, text }——复用 embed_corpus.py 的输入契约
 *   docs.jsonl     每行 { id, docId, title, standardNo }，用于把向量行号映射回文档
 *   queries.json   合并后的问题（默认 60 条 0.27 题 + 20 条 0.30 独立同义题）
 *   stats.json
 *
 * 用法：node scripts/eval/build-doc-corpus.mjs [--dir <标准库>] [--out <目录>]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DIR = "/Users/littlesun/workspace/knowledge/标准";
const DEFAULT_OUT = "/tmp/kb-eval-030";
const BASE_QUESTIONS = new URL("./questions-2026-10-27.jsonl", import.meta.url);
const EXTRA_QUESTIONS = new URL("./questions-2026-10-30-paraphrase.jsonl", import.meta.url);

function parseArgs(argv) {
  const options = { dir: DEFAULT_DIR, out: DEFAULT_OUT, extra: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dir") options.dir = argv[++i];
    else if (argv[i] === "--out") options.out = argv[++i];
    else if (argv[i] === "--no-extra") options.extra = false;
  }
  return options;
}

function collapse(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function loadQuestions(url) {
  const text = await readFile(url, "utf8");
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(join(options.dir, "kb.json"), "utf8"));
  const db = new DatabaseSync(join(options.dir, ".index", "fts.sqlite"), { readOnly: true });
  const firstClause = db.prepare("SELECT text FROM clauses WHERE doc_id = ? ORDER BY id LIMIT 1");
  const docs = (manifest.docs ?? []).filter((doc) => doc.status === "ready" && !doc.deletedAt);
  const clauses = [];
  const rows = [];
  docs.forEach((doc, index) => {
    const first = firstClause.get(doc.id);
    const head = [
      doc.standardNo,
      doc.title,
      Array.isArray(doc.tags) && doc.tags.length > 0 ? doc.tags.join(" ") : "",
      doc.summary,
      first?.text ? collapse(first.text).slice(0, 300) : "",
    ].filter((part) => String(part ?? "").trim() !== "").join(" ");
    clauses.push({ id: index, text: head.slice(0, 600) });
    rows.push({ id: index, docId: doc.id, title: doc.title, standardNo: doc.standardNo ?? "" });
  });
  db.close();

  const questions = [...(await loadQuestions(BASE_QUESTIONS))];
  if (options.extra) {
    const extra = await loadQuestions(EXTRA_QUESTIONS);
    if (extra.some((item) => questions.some((base) => base.id === item.id))) {
      throw new Error("额外问题 id 与 60 题数据集冲突");
    }
    questions.push(...extra);
  }

  await mkdir(options.out, { recursive: true });
  await writeFile(join(options.out, "clauses.jsonl"), `${clauses.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  await writeFile(join(options.out, "docs.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  await writeFile(join(options.out, "queries.json"), `${JSON.stringify(questions.map((item) => ({ id: item.id, q: item.q })), null, 2)}\n`, "utf8");
  const stats = {
    dir: options.dir,
    docs: rows.length,
    queries: questions.length,
    extra: options.extra,
    avgChars: Number((clauses.reduce((sum, row) => sum + row.text.length, 0) / Math.max(1, clauses.length)).toFixed(1)),
    generatedAt: new Date().toISOString(),
    out: options.out,
  };
  await writeFile(join(options.out, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
}

await main();
