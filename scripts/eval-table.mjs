#!/usr/bin/env node
/**
 * 本地 OCR 表格重建评估（真实扫描件）。
 *
 * 对每一页输出：检测到的表格块、行列数、非空单元格占比、覆盖的 OCR 行数，
 * 以及重建出的 HTML；同时把页面图存到输出目录，便于人工对照。
 * 不做“自动判定准确/错误”，因为合并单元格/跨页表没有可靠真值——
 * 结论需要看图人工核对；本脚本只把关键指标和证据集中起来。
 *
 * 用法：
 *   node scripts/eval-table.mjs --pdf 样张.pdf --pages 5-7 --out reports/table-eval.md
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ocrImageBatch } from "../lib/ocr.js";
import { findTableBlocks, groupOcrRows, ocrTableLayout } from "../lib/table-layout.js";

function parseArgs(argv) {
  const out = { pages: "1", dpi: 200, out: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--pdf") out.pdf = argv[++i];
    else if (argv[i] === "--pages") out.pages = argv[++i];
    else if (argv[i] === "--dpi") out.dpi = Number(argv[++i]) || 200;
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  if (!out.pdf) throw new Error("需要 --pdf");
  return out;
}

function parsePages(spec, total) {
  const set = new Set();
  for (const part of String(spec).split(",")) {
    const [a, b] = part.split("-").map((v) => Number(v.trim()));
    if (!Number.isFinite(a)) continue;
    for (let p = Math.max(1, a); p <= Math.min(total, b || a); p += 1) set.add(p);
  }
  return [...set];
}

function tableStats(html) {
  const rows = (html.match(/<tr>/g) ?? []).length;
  const cells = [...html.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  const nonEmpty = cells.filter((text) => text.trim() !== "").length;
  return { rows, cells: cells.length, nonEmpty, emptyRatio: cells.length ? 1 - nonEmpty / cells.length : 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { default: mupdf } = await import("mupdf");
  const data = await readFile(args.pdf);
  const doc = mupdf.Document.openDocument(new Uint8Array(data), "application/pdf");
  const pages = parsePages(args.pages, doc.countPages());
  const pagesDirName = `${basename(args.pdf, ".pdf")}-pages`;
  const outDir = args.out ? join(dirname(resolve(args.out)), pagesDirName) : join("/tmp", "table-eval-pages");
  await mkdir(outDir, { recursive: true });
  const lines = [
    "# 本地 OCR 表格重建评估",
    "",
    `- 文件：${args.pdf}`,
    `- 页数：${doc.countPages()}（本次 ${pages.join("、")}）`,
    `- 页面图目录：${outDir}`,
    "",
    "> 表格重建是启发式结果，需要对照页面图人工判断；非空单元格占比低通常意味着多级表头/合并单元格被拆成了空列。",
    "",
  ];
  for (const pageNo of pages) {
    const page = doc.loadPage(pageNo - 1);
    const zoom = Math.max(0.5, args.dpi / 72);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false, true);
    const png = pixmap.asPNG();
    pixmap.destroy();
    page.destroy();
    const imagePath = join(outDir, `page-${pageNo}.png`);
    await writeFile(imagePath, png);
    const [result] = await ocrImageBatch([{ png, page: pageNo }], { engine: "auto" });
    const rows = groupOcrRows(result?.lines ?? []);
    const width = Math.max(0, ...rows.flatMap((row) => row.cells.map((cell) => cell.x2)));
    const blocks = findTableBlocks(rows, { pageWidth: width });
    const laid = ocrTableLayout(result?.lines ?? []);
    const stats = laid ? tableStats(laid.text) : { rows: 0, cells: 0, nonEmpty: 0, emptyRatio: 0 };
    const covered = blocks.reduce((sum, block) => sum + (block.end - block.start), 0);
    lines.push(`## 第 ${pageNo} 页`);
    lines.push("");
    lines.push(`![第 ${pageNo} 页](${pagesDirName}/page-${pageNo}.png)`);
    lines.push("");
    lines.push(`- OCR 行数：${rows.length}`);
    lines.push(`- 检测表格块：${blocks.length}`);
    lines.push(`- 表格行/单元格：${stats.rows} / ${stats.cells}（非空 ${stats.nonEmpty}，空单元格 ${(stats.emptyRatio * 100).toFixed(0)}%）`);
    lines.push(`- 被表格覆盖的 OCR 行：${covered}/${rows.length}`);
    lines.push("");
    if (laid) {
      lines.push("```html");
      lines.push(laid.text.length > 6000 ? `${laid.text.slice(0, 6000)}\n<!-- 截断 -->` : laid.text);
      lines.push("```");
    } else {
      lines.push("（未检测到表格块）");
    }
    lines.push("");
  }
  doc.destroy();
  const report = lines.join("\n");
  if (args.out) {
    await writeFile(args.out, report, "utf8");
    console.log(`报告已写入 ${args.out}`);
  } else {
    console.log(report);
  }
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
