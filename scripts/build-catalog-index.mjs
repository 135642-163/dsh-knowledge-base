#!/usr/bin/env node
/**
 * 生成 / 更新知识库的「书目索引（自动生成）」（0.32 质量治理）。
 *
 * 为什么需要：这三篇索引是外部脚本一次性生成的，旧版把 PDF 书签里损坏的字符
 * （U+FFFD / 私用区）原样写进表格，且计数会过期。这里从**当前清单**重建：
 *  - 行 = 所有 ready 文档（含笔记），排除索引自身；
 *  - 类型/页数/字数/大纲取自清单；大纲只保留前 3 条并清掉不可读字符；
 *  - 按标题拼音排序，表格用标准 Markdown。
 *
 * 默认 dry-run；--apply 才写库（原位更新同一个 docId，版本号 +1）。
 * 更新后会把 title/trust/stage 等身份元数据按旧值恢复（导入管线不负责这些字段）。
 *
 * 用法：
 *   node scripts/build-catalog-index.mjs --root ~/workspace/knowledge --kb 历史 --kb 变电试验
 *   node scripts/build-catalog-index.mjs --root ~/workspace/knowledge --kb 历史 --apply
 */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFileInto } from "../lib/pipeline.js";
import { refreshKbIndex } from "../lib/import-job.js";
import {
  expandRoot,
  kbDirPath,
  readManifest,
  updateDocsMetaLocked,
  withManifestLock,
} from "../lib/store.js";

/** 索引自己的源文件名（docId 由它决定，改名会变成新文档）。 */
export const CATALOG_SOURCE_NAME = "_书目索引.md";

const TYPE_LABELS = {
  "pdf-scanned": "PDF扫描",
  "pdf-text": "PDF文字",
  "pdf-mixed": "PDF混合",
  docx: "Word",
  doc: "Word",
  pptx: "PPT",
  ppt: "PPT",
  xlsx: "Excel",
  xlsm: "Excel",
  text: "文本",
  markdown: "Markdown",
  epub: "EPUB",
  mobi: "MOBI",
  note: "笔记",
};

/** 清掉文字层/书签里不可读的字符：U+FFFD 与私用区。 */
export function sanitizeCatalogText(value) {
  return String(value ?? "")
    .replace(/[\uFFFD\uE000-\uF8FF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatChars(chars) {
  const n = Number(chars) || 0;
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
}

function typeLabel(type) {
  return TYPE_LABELS[String(type ?? "")] ?? String(type ?? "");
}

function outlineOf(doc, { limit = 3, itemChars = 30 } = {}) {
  const items = (doc.outline ?? [])
    .map((item) => sanitizeCatalogText(typeof item === "string" ? item : item?.title ?? ""))
    .filter((title) => title !== "")
    .slice(0, limit)
    .map((title) => (title.length > itemChars ? title.slice(0, itemChars) : title));
  return items.join("；");
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 生成索引 markdown（纯函数）。
 * @param manifest 知识库清单
 * @param options { kbName, now }
 */
export function buildCatalogMarkdown(manifest, options = {}) {
  const kbName = String(options.kbName ?? manifest?.name ?? "");
  const now = options.now instanceof Date ? options.now : new Date();
  const rows = (manifest?.docs ?? [])
    .filter((doc) => doc.status === "ready" && !doc.deletedAt)
    .filter((doc) => doc.sourceFile !== CATALOG_SOURCE_NAME)
    .sort((a, b) => String(a.title ?? "").localeCompare(String(b.title ?? ""), "zh-Hans-CN"));

  const lines = [
    `# ${kbName} 书目索引（自动生成）`,
    "",
    `> 生成时间：${stamp(now)}｜共 ${rows.length} 部（不含本索引）`,
    ">",
    "> 用法：先看本索引确定候选，再 kb_query/kb_read 精读正文；大纲列是章节目录前几条。",
    "",
    "| # | 书名 | 类型 | 页数 | 字数 | 大纲（前几条） |",
    "|---|---|---|---|---|---|",
  ];
  rows.forEach((doc, index) => {
    const title = sanitizeCatalogText(doc.title).replace(/\|/g, "｜");
    const outline = outlineOf(doc).replace(/\|/g, "｜");
    lines.push(
      `| ${index + 1} | ${title} | ${typeLabel(doc.type)} | ${Number(doc.pages) || 0} | ` +
        `${formatChars(doc.chars)} | ${outline} |`
    );
  });
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { root: "", kbs: [], apply: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i] ?? "";
    else if (arg === "--kb") args.kbs.push(argv[++i] ?? "");
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return args;
}

/** 只读生成预览（不写库）。 */
export async function planCatalog(root, kbNames) {
  const plan = [];
  for (const kb of kbNames) {
    const dir = kbDirPath(root, kb);
    const manifest = await readManifest(dir);
    const doc = (manifest.docs ?? []).find(
      (item) => item.status === "ready" && !item.deletedAt && (
        item.sourceFile === CATALOG_SOURCE_NAME || /书目索引（自动生成）$/.test(String(item.title ?? ""))
      )
    );
    if (!doc) {
      plan.push({ kb, error: "没有找到「书目索引（自动生成）」文档" });
      continue;
    }
    const markdown = buildCatalogMarkdown(manifest, { kbName: manifest.name || kb });
    const old = await readFile(join(dir, "sources", `${doc.id}${extOf(doc.sourceFile || ".md")}`), "utf8")
      .catch(() => "");
    plan.push({
      kb,
      docId: doc.id,
      title: doc.title,
      rows: (markdown.match(/^\| \d+ \|/gm) ?? []).length,
      charsBefore: old.length,
      charsAfter: markdown.length,
      fffdBefore: (old.match(/[\uFFFD\uE000-\uF8FF]/g) ?? []).length,
      fffdAfter: (markdown.match(/[\uFFFD\uE000-\uF8FF]/g) ?? []).length,
      markdown,
      doc: {
        title: doc.title,
        titleSource: doc.titleSource,
        trust: doc.trust,
        trustReason: doc.trustReason,
        trustSource: doc.trustSource,
        stage: doc.stage,
        stageLabel: doc.stageLabel,
      },
    });
  }
  return plan;
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? ""));
  return m ? `.${m[1].toLowerCase()}` : ".md";
}

/** 写库：生成临时 .md → 原位导入同一 docId → 恢复身份/可信度元数据 → 刷新索引。 */
export async function applyCatalog(root, item) {
  if (item.error) throw new Error(item.error);
  const dir = kbDirPath(root, item.kb);
  const work = await mkdtemp(join(tmpdir(), "kb-catalog-"));
  try {
    const sourcePath = join(work, CATALOG_SOURCE_NAME);
    await writeFile(sourcePath, item.markdown, "utf8");
    const result = await importFileInto(dir, {
      sourcePath,
      relKey: CATALOG_SOURCE_NAME,
      title: item.doc.title,
      docId: item.docId,
      sourceFile: CATALOG_SOURCE_NAME,
      forceReparse: true,
      config: { partMaxChars: 8000 },
    });
    // 导入管线会把 trust/stage 按正文重算；索引的身份字段沿用旧值。
    const patch = {};
    for (const key of ["title", "titleSource", "trust", "trustReason", "trustSource", "stage", "stageLabel"]) {
      if (item.doc[key] !== undefined && item.doc[key] !== null) patch[key] = item.doc[key];
    }
    if (Object.keys(patch).length > 0) {
      await withManifestLock(dir, async () => {
        const manifest = await readManifest(dir);
        await updateDocsMetaLocked(dir, manifest, [{ docId: item.docId, patch }]);
      });
    }
    await refreshKbIndex(dir);
    return { version: result.version, chars: result.chars, parts: result.parts };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.root || args.kbs.length === 0) {
    console.log(`用法: node scripts/build-catalog-index.mjs --root <kbRoot> --kb <库> [--kb <库>] [--apply] [--json]`);
    return;
  }
  const root = expandRoot(args.root);
  const plan = await planCatalog(root, args.kbs);
  for (const item of plan) {
    if (item.error) {
      console.log(`[catalog] ${item.kb}: ${item.error}`);
      continue;
    }
    console.log(
      `[catalog] ${item.kb} ${item.docId} 行 ${item.rows}｜字符 ${item.charsBefore}→${item.charsAfter}｜` +
        `乱码 ${item.fffdBefore}→${item.fffdAfter}`
    );
    if (args.apply) {
      const result = await applyCatalog(root, item);
      console.log(`[catalog] ${item.kb} 已更新 v${result.version ?? "?"}（${result.chars ?? "?"} 字 / ${result.parts ?? "?"} 部分）`);
    }
  }
  if (!args.apply) console.log("[catalog] dry-run：加 --apply 才会写库");
  if (args.json) {
    console.log(JSON.stringify(plan.map(({ markdown, ...rest }) => rest), null, 2));
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith("build-catalog-index.mjs");
if (isMain) {
  main().catch((error) => {
    console.error(`[catalog] 失败: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
