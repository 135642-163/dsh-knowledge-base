#!/usr/bin/env node
/**
 * 语义完整性审计：当前「600 字文档画像」vs「多窗口文档画像」的纯 dense 召回。
 * 只读真实知识库；不写索引、不改清单。真实模型（bge-small-zh-v1.5）可用时运行。
 *
 * 用法：
 *   node scripts/eval/semantic-window-audit.mjs --dir ~/workspace/knowledge/标准 \
 *     --questions scripts/eval/questions-2026-10-27.jsonl --windows 8 --out /tmp/audit.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandRoot, kbDirPath, readManifest } from "../../lib/store.js";
import { docEmbedText } from "../../lib/semantic-index.js";
import { splitMarkdownWindows } from "../../lib/semantic-windows.js";
import { createSemanticRuntime } from "../../lib/semantic-runtime.js";
import { searchFtsIndex } from "../../lib/fts-index.js";
import { fuseDocRrf } from "../../lib/semantic.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function parseArgs(argv) {
  const args = {
    dir: "",
    kb: "标准",
    questions: join(root, "scripts", "eval", "questions-2026-10-27.jsonl"),
    windows: 8,
    windowChars: 420,
    out: "",
    current: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") args.dir = argv[++i] ?? "";
    else if (arg === "--kb") args.kb = argv[++i] ?? "标准";
    else if (arg === "--questions") args.questions = argv[++i] ?? args.questions;
    else if (arg === "--windows") args.windows = Math.max(1, Number(argv[++i]) || 8);
    else if (arg === "--window-chars") args.windowChars = Math.max(120, Number(argv[++i]) || 420);
    else if (arg === "--out") args.out = argv[++i] ?? "";
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: node scripts/eval/semantic-window-audit.mjs --dir <kbDir> [--windows 8] [--out /tmp/a.json]");
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (!args.dir) args.dir = kbDirPath(expandRoot("~/workspace/knowledge"), args.kb);
  return args;
}

function cosine(a, b) {
  let score = 0;
  for (let i = 0; i < a.length; i += 1) score += a[i] * b[i];
  return score;
}

function rankDocs(query, vectors) {
  const scored = [];
  for (let i = 0; i < vectors.length; i += 1) scored.push({ index: i, score: cosine(query, vectors[i]) });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored;
}

function metrics(questions, ranked, idToIndex) {
  let recall = 0;
  let rr = 0;
  let counted = 0;
  const rows = [];
  for (const question of questions) {
    const expected = (question.expected ?? []).map((item) => idToIndex.get(item.docId)).filter((index) => Number.isInteger(index));
    if (expected.length === 0) continue;
    counted += 1;
    const top = ranked.get(question.id)?.slice(0, 10) ?? [];
    const topIndexes = top.map((item) => item.index);
    const hits = expected.filter((index) => topIndexes.includes(index)).length;
    recall += hits / expected.length;
    const firstRank = expected
      .map((index) => topIndexes.indexOf(index))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    rr += firstRank === undefined ? 0 : 1 / (firstRank + 1);
    rows.push({ id: question.id, group: question.group, hits, total: expected.length, firstRank: firstRank ?? null });
  }
  return {
    questions: counted,
    recall: counted > 0 ? recall / counted : 0,
    mrr: counted > 0 ? rr / counted : 0,
    rows,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readManifest(args.dir);
  const docs = (manifest.docs ?? []).filter((doc) => doc.status === "ready" && !doc.deletedAt);
  const questions = (await readFile(args.questions, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const runtime = createSemanticRuntime();
  const status = await runtime.status();
  if (!status.available) throw new Error(`语义模型不可用: ${status.reason} ${status.detail ?? ""}`);
  console.log(`docs=${docs.length} questions=${questions.length} model=${status.model}`);
  const idToIndex = new Map(docs.map((doc, index) => [doc.id, index]));

  const currentTexts = [];
  const windowTexts = [];
  const windowDoc = [];
  for (const doc of docs) {
    let markdown = "";
    try { markdown = await readFile(join(args.dir, "markdown", doc.id, `${doc.id}.md`), "utf8"); } catch { /* ignore */ }
    currentTexts.push(await docEmbedText({ dir: args.dir, doc }));
    const windows = splitMarkdownWindows(markdown, {
      maxWindows: args.windows,
      windowChars: args.windowChars,
      prefix: [doc.standardNo, doc.title].filter(Boolean).join(" "),
    });
    for (const window of windows) {
      windowTexts.push(window.text);
      windowDoc.push(docs.indexOf(doc));
    }
  }

  async function embedAll(texts, label) {
    const vectors = [];
    const batch = 16;
    for (let start = 0; start < texts.length; start += batch) {
      const slice = texts.slice(start, start + batch);
      const result = await runtime.embedDocuments(slice);
      if (!result.ok) throw new Error(`${label} 嵌入失败: ${result.reason}`);
      vectors.push(...result.vectors);
      if (start === 0 || (start / batch) % 10 === 0) console.log(`${label} ${Math.min(start + batch, texts.length)}/${texts.length}`);
    }
    return vectors;
  }

  const started = Date.now();
  const currentVectors = await embedAll(currentTexts, "current");
  const windowVectors = await embedAll(windowTexts, "windows");
  // 低成本候选：每个文档的窗口向量取平均（再 L2 归一化），仍是一条向量/文档。
  const averageVectors = docs.map(() => null);
  for (let index = 0; index < windowVectors.length; index += 1) {
    const docIndex = windowDoc[index];
    if (!averageVectors[docIndex]) averageVectors[docIndex] = new Float32Array(windowVectors[index].length);
    const target = averageVectors[docIndex];
    const source = windowVectors[index];
    for (let dim = 0; dim < source.length; dim += 1) target[dim] += source[dim];
  }
  for (const vector of averageVectors) {
    if (!vector) continue;
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let dim = 0; dim < vector.length; dim += 1) vector[dim] /= norm;
  }
  const queryVectors = [];
  for (const question of questions) {
    const result = await runtime.embedQuery(question.q);
    if (!result.ok) throw new Error(`查询嵌入失败: ${result.reason}`);
    queryVectors.push(result.vector);
  }

  const currentRanked = new Map();
  const averageRanked = new Map();
  const bestWindowByDoc = new Map();
  for (let qi = 0; qi < questions.length; qi += 1) {
    const query = queryVectors[qi];
    currentRanked.set(questions[qi].id, rankDocs(query, currentVectors));
    averageRanked.set(questions[qi].id, rankDocs(query, averageVectors));
    const best = new Array(docs.length).fill(-Infinity);
    for (let wi = 0; wi < windowVectors.length; wi += 1) {
      const score = cosine(query, windowVectors[wi]);
      const docIndex = windowDoc[wi];
      if (score > best[docIndex]) best[docIndex] = score;
    }
    bestWindowByDoc.set(questions[qi].id, best
      .map((score, index) => ({ index, score }))
      .sort((left, right) => right.score - left.score || left.index - right.index));
  }

  // 词法候选：直接取 FTS 条款序里的文档顺序（近似 A；不比 boost 的 B 更强，但足够做同口径对比）。
  async function lexicalDocs(question) {
    try {
      const found = await searchFtsIndex(args.dir, question.q, { limit: 200 });
      if (!found.ok) return [];
      return [...new Set(found.matches.map((row) => row.docId).filter(Boolean))];
    } catch {
      return [];
    }
  }
  const hybridRanked = { current: new Map(), average: new Map(), windows: new Map() };
  for (let qi = 0; qi < questions.length; qi += 1) {
    const question = questions[qi];
    const lexical = (await lexicalDocs(question)).map((id) => idToIndex.get(id)).filter((index) => Number.isInteger(index));
    const variants = {
      current: currentRanked.get(question.id)?.slice(0, 50).map((item) => item.index) ?? [],
      average: averageRanked.get(question.id)?.slice(0, 50).map((item) => item.index) ?? [],
      windows: bestWindowByDoc.get(question.id)?.slice(0, 50).map((item) => item.index) ?? [],
    };
    for (const [name, dense] of Object.entries(variants)) {
      const fused = fuseDocRrf({ lexical, dense });
      hybridRanked[name].set(question.id, fused.map((item) => ({ index: item.id, score: item.score })));
    }
  }

  const current = metrics(questions, currentRanked, idToIndex);
  const average = metrics(questions, averageRanked, idToIndex);
  const windows = metrics(questions, bestWindowByDoc, idToIndex);
  const hybrid = {
    current: metrics(questions, hybridRanked.current, idToIndex),
    average: metrics(questions, hybridRanked.average, idToIndex),
    windows: metrics(questions, hybridRanked.windows, idToIndex),
  };
  const byGroup = (list) => Object.fromEntries([...new Set(list.map((row) => row.group))].map((group) => [
    group,
    list.filter((row) => row.group === group).length,
  ]));
  const summary = {
    dir: args.dir,
    docs: docs.length,
    questions: questions.length,
    windows: args.windows,
    windowChars: args.windowChars,
    elapsedMs: Date.now() - started,
    current: { recall: current.recall, mrr: current.mrr, groups: byGroup(current.rows) },
    averageProfile: { recall: average.recall, mrr: average.mrr, groups: byGroup(average.rows) },
    windowsProfile: { recall: windows.recall, mrr: windows.mrr, groups: byGroup(windows.rows) },
    hybrid: {
      current: { recall: hybrid.current.recall, mrr: hybrid.current.mrr },
      average: { recall: hybrid.average.recall, mrr: hybrid.average.mrr },
      windows: { recall: hybrid.windows.recall, mrr: hybrid.windows.mrr },
    },
    delta: {
      average: { recall: average.recall - current.recall, mrr: average.mrr - current.mrr },
      windows: { recall: windows.recall - current.recall, mrr: windows.mrr - current.mrr },
    },
    rows: { current: current.rows, average: average.rows, windows: windows.rows },
  };
  console.log(JSON.stringify({ current: summary.current, average: summary.averageProfile, windows: summary.windowsProfile, hybrid: summary.hybrid, delta: summary.delta, elapsedMs: summary.elapsedMs }, null, 2));
  if (args.out) await writeFile(args.out, JSON.stringify(summary, null, 2), "utf8");
}

main().catch((error) => {
  console.error(`审计失败: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});
