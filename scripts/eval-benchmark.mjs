/**
 * 0.27 检索基准：60 条人工问题的 A/B/C 三变体对比。
 *
 *   A 当前 FTS：条款级 FTS5/BM25 原始顺序（按文档去重，取首次出现）
 *   B FTS + boost：同一批 FTS 命中，走 lib/search.js 的标题/标准号/标签/trust/新近度打分
 *   C ripgrep 基线：0.25 的 ripgrep + rankMatches（标准号走 expandStdQuery 精确正则）
 *
 * 全程只读：sqlite 用 readOnly 打开，ripgrep 只读 markdown/，不写清单与索引。
 *
 * 用法：
 *   node scripts/eval-benchmark.mjs --validate                 # 只校验数据集与真实库一致性
 *   node scripts/eval-benchmark.mjs --out docs/specs/...md     # 跑评测并写报告
 *   node scripts/eval-benchmark.mjs --dir <库目录> --questions <jsonl> --out <md>
 */
import { spawn as spawnChild } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { annotateMatches, buildRgArgs, expandStdQuery, parseRgOutput, rankMatches } from "../lib/query.js";
import { tokenizeForFts } from "../lib/fts-index.js";
import { groupHitsByDoc, rankResults } from "../lib/search.js";
import { keywordsOfQuery } from "../lib/sources.js";
import { rrfFuse, rowsToDocOrder } from "./eval/fusion.mjs";

const DEFAULT_DIR = "/Users/littlesun/workspace/knowledge/标准";
const DEFAULT_QUESTIONS = new URL("./eval/questions-2026-10-27.jsonl", import.meta.url).pathname;
const DEFAULT_OUT = "docs/specs/2026-10-27-retrieval-benchmark.md";
const DEFAULT_HYBRID_OUT = "docs/specs/2026-10-29-hybrid-embedding-benchmark.md";
const TOP_K = 10;

const GROUP_LABEL = {
  clause: "条款定位",
  "multi-doc": "跨文档",
  numeric: "数值/限值",
  paraphrase: "同义改写",
};

function parseArgs(argv) {
  const options = { dir: DEFAULT_DIR, questions: DEFAULT_QUESTIONS, out: "", vectors: "", validate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--validate") options.validate = true;
    else if (arg === "--dir") options.dir = argv[++i];
    else if (arg === "--questions") options.questions = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--vectors") options.vectors = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
  }
  return options;
}

async function loadQuestions(path) {
  const text = await readFile(path, "utf8");
  const items = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    items.push(JSON.parse(line));
  }
  return items;
}

/** 只读打开真实索引；查询语句与 lib/fts-index.js searchFtsIndex 保持一致。 */
function openIndex(dir) {
  return new DatabaseSync(join(dir, ".index", "fts.sqlite"), { readOnly: true });
}

function ftsRows(db, query, limit = 60) {
  const tokens = tokenizeForFts(query);
  if (!tokens) return [];
  const ftsQuery = tokens.split(/\s+/).filter(Boolean).map((word) => `"${word.replace(/"/g, '""')}"`).join(" OR ");
  try {
    return db.prepare(`
      SELECT c.id AS clauseId, c.doc_id AS docId, c.part, c.clause, c.heading, c.text,
             c.page_start AS pageStart, c.page_end AS pageEnd, c.line_start AS lineStart,
             d.title, d.standard_no AS standardNo, d.trust,
             bm25(clauses_fts, 1.0, 2.0, 2.5) AS rank
      FROM clauses_fts
      JOIN clauses c ON c.id = clauses_fts.rowid
      JOIN docs d ON d.id = c.doc_id
      WHERE clauses_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, Math.max(1, Math.min(500, limit)));
  } catch {
    return [];
  }
}

function docOrderOfRows(rows) {
  const order = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.docId)) continue;
    seen.add(row.docId);
    order.push(row.docId);
    if (order.length >= TOP_K) break;
  }
  return order;
}

function pagesByDoc(rows) {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.docId) ?? [];
    list.push({ pageStart: row.pageStart, pageEnd: row.pageEnd ?? row.pageStart });
    map.set(row.docId, list);
  }
  return map;
}

function coversPage(entries, page) {
  return (entries ?? []).some((entry) => {
    if (!Number.isInteger(entry.pageStart) || !Number.isInteger(page)) return false;
    return page >= entry.pageStart && page <= (entry.pageEnd ?? entry.pageStart);
  });
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 关键词 OR 正则：让 ripgrep 基线拿到与 FTS 相同的输入信息（人工问题不是字面量）。 */
function keywordPattern(query) {
  const words = keywordsOfQuery(query)
    .map((word) => String(word).trim())
    .filter((word) => word.length >= 2)
    .map(escapeRegex);
  return words.length === 0 ? String(query ?? "") : words.join("|");
}

/** C 变体：0.25 的 ripgrep + rankMatches 路径（只读）。pattern 由调用方决定。 */
async function ripgrepRows(rgPath, markdownDir, kbDir, manifest, { pattern, query }, { perFile = 6 } = {}) {
  const argv = buildRgArgs(rgPath, pattern, markdownDir, { maxMatches: perFile * 20 });
  const stdout = await runProcess(argv, kbDir);
  const parsed = parseRgOutput(stdout, { manifest, kbDir, maxMatches: 20000 });
  await annotateMatches(parsed.matches, kbDir);
  // 用实际检索用的正则做标题命中的判定：0.25 里用户输入什么就按什么匹配标题。
  return rankMatches(parsed.matches, { pattern, maxMatches: 200, perDocMax: perFile });
}

function runProcess(argv, cwd) {
  return new Promise((resolve) => {
    const child = spawnChild(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => resolve(""));
    child.on("close", (code) => {
      if (code === 0 || code === 1) resolve(stdout);
      else resolve("");
      if (code !== 0 && code !== 1 && stderr) process.stderr.write(`rg: ${stderr.slice(0, 200)}\n`);
    });
  });
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

/**
 * 单题单变体的得分：文档是否进 top10、期望页是否被覆盖、首个命中文档的名次。
 */
function scoreQuestion(question, { docOrder, pages, elapsedMs }) {
  const expected = Array.isArray(question.expected) ? question.expected : [];
  let docHits = 0;
  let pageHits = 0;
  let firstDocRank = 0;
  let firstPageRank = 0;
  for (const item of expected) {
    const rank = docOrder.indexOf(item.docId) + 1;
    if (rank > 0) {
      docHits += 1;
      if (firstDocRank === 0) firstDocRank = rank;
      if (coversPage(pages.get(item.docId), item.page)) {
        pageHits += 1;
        if (firstPageRank === 0) firstPageRank = rank;
      }
    }
  }
  return {
    id: question.id,
    group: question.group,
    q: question.q,
    expected,
    expectedDocs: expected.length,
    docHits,
    pageHits,
    docRank: firstDocRank,
    pageRank: firstPageRank,
    docRecall: expected.length === 0 ? 0 : docHits / expected.length,
    pageRecall: expected.length === 0 ? 0 : pageHits / expected.length,
    mrr: firstDocRank > 0 ? 1 / firstDocRank : 0,
    pageMrr: firstPageRank > 0 ? 1 / firstPageRank : 0,
    elapsedMs,
    top: docOrder.slice(0, 3),
  };
}

function summarize(results) {
  const n = results.length;
  const mean = (pick) => results.reduce((sum, item) => sum + pick(item), 0) / Math.max(1, n);
  const sorted = results.map((item) => item.elapsedMs).sort((a, b) => a - b);
  return {
    n,
    docRecall: mean((item) => item.docRecall),
    pageRecall: mean((item) => item.pageRecall),
    mrr: mean((item) => item.mrr),
    pageMrr: mean((item) => item.pageMrr),
    p95: percentile(sorted, 0.95),
    mean: mean((item) => item.elapsedMs),
  };
}

async function resolveRgPath() {
  const module = await import("@vscode/ripgrep");
  return module.rgPath;
}

async function validateQuestions({ dir, manifest, docs, questions, db }) {
  const problems = [];
  const ids = new Set();
  const groups = { clause: 0, "multi-doc": 0, numeric: 0, paraphrase: 0 };
  const questionsSeen = new Set();
  for (const item of questions) {
    if (!item?.id || typeof item.id !== "string") problems.push("缺少 id");
    if (ids.has(item?.id)) problems.push(`id 重复：${item?.id}`);
    ids.add(item?.id);
    if (!(item?.group in groups)) problems.push(`${item?.id} group 非法：${item?.group}`);
    else groups[item.group] += 1;
    if (typeof item?.q !== "string" || item.q.trim().length < 4) problems.push(`${item?.id} 问题为空或过短`);
    if (questionsSeen.has(item?.q)) problems.push(`${item?.id} 问题重复：${item.q}`);
    questionsSeen.add(item?.q);
    const expected = Array.isArray(item?.expected) ? item.expected : [];
    if (expected.length === 0) problems.push(`${item?.id} 缺少 expected`);
    if (item?.group === "multi-doc" && expected.length < 2) problems.push(`${item?.id} 跨文档题应有 2 个以上期望`);
    for (const exp of expected) {
      const doc = docs.get(exp?.docId);
      if (!doc) {
        problems.push(`${item?.id} 期望文档不存在：${exp?.docId}`);
        continue;
      }
      if (!Number.isInteger(exp.page) || exp.page < 1 || exp.page > Number(doc.pages ?? 0)) {
        problems.push(`${item?.id} 期望页码越界：${exp?.docId} p${exp?.page}（共 ${doc.pages} 页）`);
      }
      const rows = db.prepare("SELECT COUNT(*) AS n FROM clauses WHERE doc_id=? AND clause=? AND page_start=?").get(exp.docId, exp.clause, exp.page);
      if ((rows?.n ?? 0) === 0) problems.push(`${item?.id} 期望条款不存在：${exp?.docId} ${exp.clause} p${exp.page}`);
      if (exp.kb !== "标准") problems.push(`${item?.id} expected.kb 应为「标准」`);
    }
  }
  const expectedCounts = { clause: 20, "multi-doc": 15, numeric: 15, paraphrase: 10 };
  for (const [group, count] of Object.entries(expectedCounts)) {
    if (groups[group] !== count) problems.push(`分组 ${group} 应为 ${count} 题，实际 ${groups[group]}`);
  }
  return { problems, groups, total: questions.length, docs: manifest.docs.length, dir };
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/** 读取 dense_search.py 的产物；缺失时返回 null（脚本降级为 0.27 的 A/B/C/C1）。 */
async function loadDense(dir, questions) {
  if (!dir) return null;
  let payload;
  try {
    payload = JSON.parse(await readFile(join(dir, "dense.json"), "utf8"));
  } catch {
    return null;
  }
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  const byId = new Map(payload.results.map((row) => [row.queryId, row]));
  const ordered = questions.map((question) => byId.get(question.id)).filter(Boolean);
  if (ordered.length !== questions.length) return null;
  return { meta: { ...meta, ...payload.meta }, results: ordered };
}

/** 批量取 clause id → {docId, page, pageEnd, clause}，避免把 15 万行全读进内存。 */
function clauseInfoFor(db, ids) {
  const map = new Map();
  const list = [...ids];
  for (let i = 0; i < list.length; i += 800) {
    const chunk = list.slice(i, i + 800).filter((id) => Number.isInteger(id));
    if (chunk.length === 0) continue;
    const rows = db.prepare(
      `SELECT id, doc_id AS docId, page_start AS page, page_end AS pageEnd, clause FROM clauses WHERE id IN (${chunk.map(() => "?").join(",")})`,
    ).all(...chunk);
    for (const row of rows) map.set(row.id, row);
  }
  return map;
}

function buildReport({ dir, questions, manifest, variants, orderedKeys, denseMeta, indexSizeMb, generatedAt }) {
  const hybrid = Boolean(denseMeta);
  const lines = [];
  lines.push(`# ${hybrid ? "0.29 混合检索基准" : "0.27 检索基准"}：60 条人工问题（${orderedKeys.join("/")}）`, "");
  lines.push("> 自动生成：`node scripts/eval-benchmark.mjs`。只读评测，不写清单、不改索引。", "");
  lines.push(`- 语料：\`${dir}\`（${manifest.docs.length} 篇，FTS 索引 ${indexSizeMb.toFixed(0)} MB）`);
  if (hybrid) {
    const mb = denseMeta.bytes / (1024 * 1024);
    const perThousand = mb / Math.max(1, manifest.docs.length) * 1000;
    lines.push(`- 语义索引：${denseMeta.model}（dim ${denseMeta.dim}，${denseMeta.clauses} 条条款向量，${mb.toFixed(0)} MB float32，查询带中文检索指令）`);
    lines.push(`- 索引体积：约 ${perThousand.toFixed(0)} MB/千篇（条款级 float32；0.27 设计门槛 200MB/千篇，int8 量化约 1/4）`);
  }
  lines.push(`- 题数：${questions.length}（条款定位 20 / 跨文档 15 / 数值限值 15 / 同义改写 10）`);
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push(`- 指标：Doc Recall@${TOP_K}（多文档题按命中比例平均）、Page Recall@${TOP_K}、MRR@${TOP_K}、Page-MRR@${TOP_K}、p95 延迟`);
  lines.push("");
  lines.push("变体：");
  lines.push("- **A 当前 FTS**：条款级 FTS5/BM25 原始顺序（文档去重后取前 10）。");
  lines.push("- **B FTS + boost**：同一批 FTS 命中经 `lib/search.js` 的标题/标准号/标签/trust/新近度打分（0.27 生产排序）。");
  lines.push("- **C ripgrep 基线（0.25 默认）**：整句问题直接当正则（标准号仍经 `expandStdQuery` 归一），走 `rankMatches`。");
  lines.push("- **C1 ripgrep + 关键词 OR**：只把输入换成 `keywordsOfQuery` 的关键词 OR 正则，排序仍是 `rankMatches`。");
  if (hybrid) {
    lines.push(`- **D dense 条款**：${denseMeta.model} 余弦相似度取 top-${denseMeta.topk ?? "K"} 条款，按最高分文档去重（纯语义，不看词面）。`);
    lines.push("- **E 条款级 RRF**：FTS 条款序（top-200）+ dense 条款序（top-K）做倒数排名融合（k=60），再按文档去重取前 10。");
    lines.push("- **F 文档级 RRF**：B 的 boost 文档序（top-50）+ dense 文档序（top-50）融合（k=20）——更保守的混合，看能否只补召回不伤精度。");
  }
  lines.push("");
  lines.push("## 总表", "");
  lines.push(`| 变体 | Doc Recall@${TOP_K} | Page Recall@${TOP_K} | MRR@${TOP_K} | Page-MRR@${TOP_K} | p95 | 平均 |`);
  lines.push("|---|---|---|---|---|---|---|");
  for (const key of orderedKeys) {
    const summary = variants[key].summary;
    lines.push(`| ${key} ${variants[key].label} | ${formatPercent(summary.docRecall)} | ${formatPercent(summary.pageRecall)} | ${summary.mrr.toFixed(3)} | ${summary.pageMrr.toFixed(3)} | ${summary.p95.toFixed(1)}ms | ${summary.mean.toFixed(1)}ms |`);
  }
  lines.push("");
  lines.push("## 分组", "");
  lines.push(`| 变体 | 分组 | 题数 | Doc Recall@${TOP_K} | Page Recall@${TOP_K} | MRR@${TOP_K} |`);
  lines.push("|---|---|---|---|---|---|");
  for (const key of orderedKeys) {
    for (const group of Object.keys(GROUP_LABEL)) {
      const subset = variants[key].results.filter((item) => item.group === group);
      if (subset.length === 0) continue;
      const summary = summarize(subset);
      lines.push(`| ${key} | ${GROUP_LABEL[group]} | ${subset.length} | ${formatPercent(summary.docRecall)} | ${formatPercent(summary.pageRecall)} | ${summary.mrr.toFixed(3)} |`);
    }
  }
  lines.push("");
  lines.push("## 逐题明细（各变体的首个期望文档名次；B/E 另列页码命中）", "");
  const rankKeys = orderedKeys;
  lines.push(`| # | 分组 | 查询 | 期望 | ${rankKeys.map((key) => `${key} doc`).join(" | ")} | B 页 |${hybrid ? " E 页 |" : ""} B ms |`);
  lines.push(`|---|---|---|---|${rankKeys.map(() => "---").join("|")}|---|---|${hybrid ? "---|" : ""}---|`);
  const byKey = new Map(rankKeys.map((key) => [key, new Map(variants[key].results.map((item) => [item.id, item]))]));
  for (const item of questions) {
    const expected = (item.expected ?? []).map((exp) => `${exp.standardNo} p${exp.page}`).join("<br>");
    const ranks = rankKeys.map((key) => {
      const row = byKey.get(key).get(item.id);
      return row?.docRank || "—";
    });
    const b = byKey.get("B").get(item.id);
    const e = hybrid ? byKey.get("E").get(item.id) : null;
    lines.push(`| ${item.id} | ${GROUP_LABEL[item.group] ?? item.group} | ${String(item.q).replace(/\|/g, "\\|")} | ${expected} | ${ranks.join(" | ")} | ${b?.pageHits ?? 0}/${b?.expectedDocs ?? 0} |${hybrid ? ` ${e?.pageHits ?? 0}/${e?.expectedDocs ?? 0} |` : ""} ${b ? b.elapsedMs.toFixed(1) : "—"} |`);
  }
  lines.push("");
  for (const key of hybrid ? ["B", "E"] : ["B"]) {
    lines.push(`## 坏例分析（${key} 变体）`, "");
    const misses = variants[key].results
      .filter((item) => item.docRank === 0 || item.docRank > 3)
      .sort((left, right) => left.docRank - right.docRank);
    if (misses.length === 0) {
      lines.push(`${key} 变体全部命中前 3 名。`, "");
      continue;
    }
    for (const item of misses) {
      const expected = item.expected.map((exp) => `${exp.standardNo} 第 ${exp.clause} 条 p${exp.page}`).join("；");
      const top = item.top.length > 0 ? item.top.join("、") : "（无命中）";
      lines.push(`- **${item.id}（${GROUP_LABEL[item.group] ?? item.group}）** ${item.q}`);
      lines.push(`  - 期望：${expected}`);
      lines.push(`  - ${key} 首命中名次：${item.docRank || "未进前 10"}；top3 docId：${top}`);
    }
    lines.push("");
  }
  lines.push("## 结论", "");
  const a = variants.A.summary;
  const b = variants.B.summary;
  const c = variants.C.summary;
  lines.push(`- B 相对 A：Doc Recall ${formatPercent(a.docRecall)} → ${formatPercent(b.docRecall)}（${((b.docRecall - a.docRecall) * 100).toFixed(1)}pp），MRR ${a.mrr.toFixed(3)} → ${b.mrr.toFixed(3)}，p95 ${a.p95.toFixed(0)}ms → ${b.p95.toFixed(0)}ms。`);
  lines.push(`- B 相对 C（0.25 整句字面）：Doc Recall ${formatPercent(c.docRecall)} → ${formatPercent(b.docRecall)}，p95 ${c.p95.toFixed(0)}ms → ${b.p95.toFixed(0)}ms。`);
  lines.push(`- B 相对 C1（关键词 OR + 旧排序）：Doc Recall ${formatPercent(variants.C1.summary.docRecall)} → ${formatPercent(b.docRecall)}。C/C1 的低分不是「rg 找不到字」，而是正则没有相关性排序；0.26 的机制回归（查询取条款原文开头）曾达到 95%，说明 rg 对「原样短语」有效、对人工问题无效。`);
  lines.push(`- 门槛（0.27 spec §8.3）：B 相对 A Doc Recall +5pp 或 MRR +0.05 且 p95 < 200ms → ${(b.docRecall - a.docRecall) >= 0.05 || (b.mrr - a.mrr) >= 0.05 ? "达标" : "未达标"}。`);
  if (hybrid) {
    const d = variants.D.summary;
    const e = variants.E.summary;
    const groupSummary = (key, group) => summarize(variants[key].results.filter((item) => item.group === group));
    const paraB = groupSummary("B", "paraphrase");
    const paraD = groupSummary("D", "paraphrase");
    const paraE = groupSummary("E", "paraphrase");
    const perThousand = (denseMeta.bytes / (1024 * 1024)) / Math.max(1, manifest.docs.length) * 1000;
    lines.push(`- D（纯 dense）相对 B：Doc Recall ${formatPercent(b.docRecall)} → ${formatPercent(d.docRecall)}，MRR ${b.mrr.toFixed(3)} → ${d.mrr.toFixed(3)}，p95 ${d.p95.toFixed(0)}ms（dense 检索在 Python 侧计时）。`);
    lines.push(`- E（RRF 混合）相对 B：Doc Recall ${formatPercent(b.docRecall)} → ${formatPercent(e.docRecall)}，Page Recall ${formatPercent(b.pageRecall)} → ${formatPercent(e.pageRecall)}，MRR ${b.mrr.toFixed(3)} → ${e.mrr.toFixed(3)}，p95 ${e.p95.toFixed(0)}ms。`);
    const f = variants.F.summary;
    const paraF = groupSummary("F", "paraphrase");
    lines.push(`- 同义改写组：B ${formatPercent(paraB.docRecall)} / D ${formatPercent(paraD.docRecall)} / E ${formatPercent(paraE.docRecall)} / F ${formatPercent(paraF.docRecall)}（Doc Recall@${TOP_K}）——这是 0.29 的核心判据。`);
    lines.push(`- F（文档级 RRF）相对 B：Doc Recall ${formatPercent(b.docRecall)} → ${formatPercent(f.docRecall)}，MRR ${b.mrr.toFixed(3)} → ${f.mrr.toFixed(3)}，p95 ${f.p95.toFixed(0)}ms。`);
    const pass = (e.docRecall - b.docRecall) >= 0.10 && e.p95 < 500 && perThousand < 200;
    lines.push(`- 门槛（0.27 spec §8.5：Doc Recall +10pp、p95 < 500ms、索引 < 200MB/千篇）→ ${pass ? "达标" : "未完全达标"}（体积约 ${perThousand.toFixed(0)} MB/千篇）。`);
    lines.push("- 本轮只做离线评测，不改生产检索；是否把 embedding/RRF 接入 `kb_query` 与工作台留待 0.30，并按本报告的瓶颈（体积/延迟/中文同义词覆盖）决定量化与索引策略。");
  } else {
    lines.push("- 未引入 embedding/向量/rerank；同义改写组的表现留给 0.29 作为引入依据。");
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("node scripts/eval-benchmark.mjs [--validate] [--dir <kb>] [--questions <jsonl>] [--vectors <dir>] [--out <md>]\n");
    return;
  }
  const vectorsDir = options.vectors;
  if (options.out === "") options.out = vectorsDir ? DEFAULT_HYBRID_OUT : DEFAULT_OUT;
  const manifest = JSON.parse(await readFile(join(options.dir, "kb.json"), "utf8"));
  const docs = new Map((manifest.docs ?? []).map((doc) => [doc.id, doc]));
  const questions = await loadQuestions(options.questions);
  const db = openIndex(options.dir);
  try {
    const validation = await validateQuestions({ dir: options.dir, manifest, docs, questions, db });
    if (options.validate) {
      process.stdout.write(`${JSON.stringify({ ok: validation.problems.length === 0, ...validation }, null, 2)}\n`);
      if (validation.problems.length > 0) process.exitCode = 1;
      return;
    }
    if (validation.problems.length > 0) {
      process.stderr.write(`数据集校验失败：\n- ${validation.problems.join("\n- ")}\n`);
      process.exitCode = 1;
      return;
    }

    const rgPath = await resolveRgPath();
    const markdownDir = join(options.dir, "markdown");
    const fbManifest = { docs: manifest.docs ?? [] };

    // 预热（不进指标）：把索引页与 rg 二进制都拉起来。
    ftsRows(db, "电压偏差", 10);
    await ripgrepRows(rgPath, markdownDir, options.dir, fbManifest, { pattern: "电压偏差", query: "电压偏差" });

    const dense = await loadDense(vectorsDir, questions);
    let clauseInfo = new Map();
    if (dense) {
      const ids = new Set();
      for (const row of dense.results) for (const hit of row.hits) ids.add(hit.id);
      clauseInfo = clauseInfoFor(db, ids);
    }

    const results = { A: [], B: [], C: [], C1: [] };
    if (dense) {
      results.D = [];
      results.E = [];
      results.F = [];
    }
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      // A：FTS 原始顺序
      let started = performance.now();
      const aRows = ftsRows(db, question.q, 60);
      const aElapsed = performance.now() - started;
      results.A.push(scoreQuestion(question, { docOrder: docOrderOfRows(aRows), pages: pagesByDoc(aRows), elapsedMs: aElapsed }));

      // B：同一批 FTS 命中 + 生产排序（lib/search.js）；延迟包含索引查询本身
      started = performance.now();
      const hits = aRows.map((row) => ({
        docId: row.docId,
        pageStart: row.pageStart,
        pageEnd: row.pageEnd,
        clause: row.clause,
        lineNumber: row.lineStart,
        line: `${row.clause ? `[${row.clause}] ` : ""}${String(row.text ?? "").replace(/\s+/g, " ")}`,
        trust: row.trust,
      }));
      const groups = groupHitsByDoc(hits, { docs: fbManifest.docs, kb: "标准" });
      const ranked = rankResults(groups, { terms: keywordsOfQuery(question.q), query: question.q, boost: true });
      const bElapsed = performance.now() - started + aElapsed;
      results.B.push(scoreQuestion(question, {
        docOrder: ranked.slice(0, TOP_K).map((row) => row.docId),
        pages: pagesByDoc(hits),
        elapsedMs: bElapsed,
      }));

      // C：0.25 的真实路径——整句问题当正则（标准号仍走 expandStdQuery 归一）
      const cPattern = expandStdQuery(question.q) ?? question.q;
      started = performance.now();
      const cMatches = await ripgrepRows(rgPath, markdownDir, options.dir, fbManifest, { pattern: cPattern, query: question.q });
      const cElapsed = performance.now() - started;
      results.C.push(scoreQuestion(question, {
        docOrder: docOrderOfRows(cMatches),
        pages: pagesByDoc(cMatches.map((match) => ({ docId: match.docId, pageStart: match.pageStart, pageEnd: match.pageEnd }))),
        elapsedMs: cElapsed,
      }));

      // C1：只换成关键词 OR 输入，排序仍是 0.25 的 rankMatches（说明差距不只来自输入形式）
      const c1Pattern = expandStdQuery(question.q) ?? keywordPattern(question.q);
      started = performance.now();
      const c1Matches = await ripgrepRows(rgPath, markdownDir, options.dir, fbManifest, { pattern: c1Pattern, query: question.q });
      const c1Elapsed = performance.now() - started;
      results.C1.push(scoreQuestion(question, {
        docOrder: docOrderOfRows(c1Matches),
        pages: pagesByDoc(c1Matches.map((match) => ({ docId: match.docId, pageStart: match.pageStart, pageEnd: match.pageEnd }))),
        elapsedMs: c1Elapsed,
      }));

      if (dense) {
        const denseRow = dense.results[index];
        // 生产 hybrid 还要付一次「查询嵌入」；用评测里 60 题的平均值计入延迟。
        const queryEmbedMs = (Number(dense.meta.querySeconds) || 0) * 1000
          / Math.max(1, Number(dense.meta.queries) || questions.length);
        // D：纯 dense（按条款最高分给文档去重）
        const denseRows = denseRow.hits.map((hit) => clauseInfo.get(hit.id)).filter(Boolean);
        const denseOrder = rowsToDocOrder(denseRows);
        results.D.push(scoreQuestion(question, {
          docOrder: denseOrder.docOrder,
          pages: denseOrder.pages,
          elapsedMs: denseRow.tookMs + queryEmbedMs,
        }));

        // E：RRF(FTS 条款序, dense 条款序)
        const lexStarted = performance.now();
        const lexRows = ftsRows(db, question.q, 200);
        const lexElapsed = performance.now() - lexStarted;
        const lexInfo = new Map(lexRows.map((row) => [row.clauseId, {
          docId: row.docId,
          page: row.pageStart,
          pageEnd: row.pageEnd,
        }]));
        const fusionStarted = performance.now();
        const fused = rrfFuse({
          lexical: lexRows.map((row) => row.clauseId).filter((id) => Number.isInteger(id)),
          dense: denseRow.hits.map((hit) => hit.id),
        });
        const fusedRows = fused.slice(0, 400)
          .map((entry) => lexInfo.get(entry.id) ?? clauseInfo.get(entry.id))
          .filter(Boolean);
        const fusedOrder = rowsToDocOrder(fusedRows);
        const fusionMs = performance.now() - fusionStarted;
        results.E.push(scoreQuestion(question, {
          docOrder: fusedOrder.docOrder,
          pages: fusedOrder.pages,
          elapsedMs: denseRow.tookMs + queryEmbedMs + lexElapsed + fusionMs,
        }));

        // F：文档级 RRF（B 的 boost 文档序 + dense 文档序），比条款级融合更保守
        const fStarted = performance.now();
        const denseDocs = rowsToDocOrder(denseRows, 50);
        const fusedDocs = rrfFuse({
          lexical: ranked.slice(0, 50).map((row) => row.docId),
          dense: denseDocs.docOrder,
          k: 20,
        });
        const fPages = new Map();
        for (const [docId, entries] of pagesByDoc(hits)) fPages.set(docId, [...entries]);
        for (const [docId, entries] of denseDocs.pages) {
          fPages.set(docId, [...(fPages.get(docId) ?? []), ...entries]);
        }
        const fFusionMs = performance.now() - fStarted;
        results.F.push(scoreQuestion(question, {
          docOrder: fusedDocs.slice(0, TOP_K).map((entry) => entry.id),
          pages: fPages,
          elapsedMs: aElapsed + denseRow.tookMs + queryEmbedMs + fFusionMs,
        }));
      }
    }

    const orderedKeys = dense ? ["A", "B", "C", "C1", "D", "E", "F"] : ["A", "B", "C", "C1"];
    const variants = {
      A: { label: "当前 FTS", results: results.A, summary: summarize(results.A) },
      B: { label: "FTS + boost", results: results.B, summary: summarize(results.B) },
      C: { label: "ripgrep（0.25 默认：整句字面）", results: results.C, summary: summarize(results.C) },
      C1: { label: "ripgrep + 关键词 OR", results: results.C1, summary: summarize(results.C1) },
    };
    if (dense) {
      variants.D = { label: `dense 条款（${dense.meta.model}）`, results: results.D, summary: summarize(results.D) };
      variants.E = { label: "RRF(FTS, dense; k=60)", results: results.E, summary: summarize(results.E) };
      variants.F = { label: "文档级 RRF(B 文档序, dense 文档序; k=20)", results: results.F, summary: summarize(results.F) };
    }
    const indexStat = await stat(join(options.dir, ".index", "fts.sqlite"));
    const report = buildReport({
      dir: options.dir,
      questions,
      manifest,
      variants,
      orderedKeys,
      denseMeta: dense ? { ...dense.meta, topk: dense.meta.topk } : null,
      indexSizeMb: indexStat.size / (1024 * 1024),
      generatedAt: new Date().toISOString(),
    });
    await writeFile(options.out, report, "utf8");
    const summary = Object.fromEntries(Object.entries(variants).map(([key, value]) => [key, {
      docRecall: Number(value.summary.docRecall.toFixed(4)),
      pageRecall: Number(value.summary.pageRecall.toFixed(4)),
      mrr: Number(value.summary.mrr.toFixed(4)),
      pageMrr: Number(value.summary.pageMrr.toFixed(4)),
      p95: Number(value.summary.p95.toFixed(1)),
      meanMs: Number(value.summary.mean.toFixed(1)),
    }]));
    process.stdout.write(`${JSON.stringify({ questions: questions.length, out: options.out, summary }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

await main();
