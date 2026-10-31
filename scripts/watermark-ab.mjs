#!/usr/bin/env node
/**
 * 水印净化 A/B：用真实**文字层** PDF 页做真值（toStructuredText），
 * 给页面叠加合成浅灰水印，比较三种输入的 OCR 字符错误率（CER）：
 *   1) clean      原图
 *   2) watermark  原图 + 合成水印
 *   3) cleaned    原图 + 合成水印 + preprocessPixmap(auto/strong)
 *
 * 只读真实知识库；不写 sources/markdown，只输出报告（可选 --report）。
 * 依赖本机 OCR 引擎（默认 rapidocr 环境）。
 *
 * 用法：
 *   node scripts/watermark-ab.mjs --root ~/workspace/knowledge --kb 标准 --docs 3
 *   node scripts/watermark-ab.mjs --root ~/workspace/knowledge --kb 标准 --docs 3 --report /tmp/ab.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as mupdf from "mupdf";
import { expandRoot, kbDirPath, readManifest } from "../lib/store.js";
import { preprocessPixmap } from "../lib/watermark.js";
import { ocrImageBatch } from "../lib/ocr.js";

function parseArgs(argv) {
  const args = {
    root: "",
    kb: "标准",
    docs: 3,
    page: 0,
    dpi: 200,
    alpha: 0.4,
    mode: "auto",
    engine: "rapidocr",
    python: process.env.KB_OCR_PYTHON || join(process.env.HOME ?? "", ".dsh", "tools", "rapidocr-env", "bin", "python"),
    report: "",
    json: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i] ?? "";
    else if (arg === "--kb") args.kb = argv[++i] ?? "标准";
    else if (arg === "--docs") args.docs = Math.max(1, Number(argv[++i]) || 3);
    else if (arg === "--page") args.page = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--alpha") args.alpha = Math.min(0.9, Math.max(0.05, Number(argv[++i]) || 0.4));
    else if (arg === "--dpi") args.dpi = Math.max(120, Number(argv[++i]) || 200);
    else if (arg === "--mode") args.mode = argv[++i] ?? "auto";
    else if (arg === "--engine") args.engine = argv[++i] ?? "rapidocr";
    else if (arg === "--python") args.python = argv[++i] ?? args.python;
    else if (arg === "--report") args.report = argv[++i] ?? "";
    else if (arg === "--json") args.json = argv[++i] ?? "";
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: node scripts/watermark-ab.mjs --root <kbRoot> [--kb 标准] [--docs 3] [--page 0=自动选正文页] [--dpi 200] [--alpha 0.4] [--mode auto|strong] [--engine rapidocr] [--report out.json]");
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (!args.root) throw new Error("需要 --root");
  return args;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 编辑距离 / 真值长度，越接近 0 越好。 */
export function charErrorRate(truth, output) {
  const a = [...normalizeText(truth)];
  const b = [...normalizeText(output)];
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  const prev = new Uint32Array(b.length + 1);
  const next = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    next[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost);
    }
    prev.set(next);
  }
  return prev[b.length] / a.length;
}

/** 在 RGB pixmap 上画斜向浅灰水印（模拟网站/单位水印）。 */
function drawSyntheticWatermark(pixmap, { color = [205, 205, 205], step = 160, thickness = 6, alpha = 0.4 } = {}) {
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const stride = pixmap.getStride();
  const components = pixmap.getNumberOfComponents();
  if (components < 3) return;
  const samples = pixmap.getPixels();
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = y * stride + x * components;
    // 半透明叠加（水印不会把正文完全盖掉），模拟真实水印与文字混叠。
    samples[offset] = Math.round(color[0] * alpha + samples[offset] * (1 - alpha));
    samples[offset + 1] = Math.round(color[1] * alpha + samples[offset + 1] * (1 - alpha));
    samples[offset + 2] = Math.round(color[2] * alpha + samples[offset + 2] * (1 - alpha));
  };
  for (let base = -height; base < width + height; base += step) {
    for (let y = 0; y < height; y += 1) {
      const x = base + y;
      for (let d = -thickness; d <= thickness; d += 1) set(x + d, y);
    }
  }
}

/** 自动选正文页：在指定页/前 6 页里取正文字符最多的一页。 */
function pickPage(pdf, requested) {
  const count = pdf.countPages();
  const candidates = new Set();
  if (requested > 0) candidates.add(Math.min(requested - 1, count - 1));
  for (let i = 0; i < Math.min(count, 6); i += 1) candidates.add(i);
  let best = { index: requested > 0 ? Math.min(requested - 1, count - 1) : 0, truth: "" };
  for (const index of candidates) {
    const page = pdf.loadPage(index);
    let text = "";
    try { text = page.toStructuredText().asText(); } finally { page.destroy(); }
    if (normalizeText(text).length > normalizeText(best.truth).length) best = { index, truth: text };
  }
  return best;
}

function renderPage(pdf, pageIndex, dpi) {
  const page = pdf.loadPage(pageIndex);
  try {
    const pixmap = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false, true);
    return { page, pixmap };
  } catch (error) {
    page.destroy();
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = kbDirPath(expandRoot(args.root), args.kb);
  const manifest = await readManifest(dir);
  const candidates = manifest.docs
    .filter((doc) =>
      doc.status === "ready" &&
      !doc.deletedAt &&
      doc.type === "pdf-text" &&
      doc.sourceFile &&
      Number(doc.pages) >= Math.max(args.page, 2)
    )
    .sort((a, b) => Number(b.chars) - Number(a.chars))
    .slice(0, args.docs);
  if (candidates.length === 0) throw new Error("没有可用的文字层 PDF（pages 不足）");

  const results = [];
  for (const doc of candidates) {
    const ext = doc.sourceFile.match(/\.[a-z0-9]+$/i)?.[0] ?? ".pdf";
    const data = await readFile(join(dir, "sources", `${doc.id}${ext}`));
    const pdf = mupdf.Document.openDocument(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), "application/pdf");
    const picked = pickPage(pdf, args.page);
    if (normalizeText(picked.truth).length < 120) {
      pdf.destroy();
      console.log(`skip ${doc.id}: 正文页文字过少`);
      continue;
    }
    const pageIndex = picked.index;
    const truth = picked.truth;

    const clean = renderPage(pdf, pageIndex, args.dpi);
    const cleanPng = clean.pixmap.asPNG();
    clean.pixmap.destroy();
    clean.page.destroy();

    const wm = renderPage(pdf, pageIndex, args.dpi);
    drawSyntheticWatermark(wm.pixmap, { alpha: args.alpha });
    const wmPng = wm.pixmap.asPNG();
    const prepared = preprocessPixmap(wm.pixmap, { mode: args.mode });
    const cleanedPng = wm.pixmap.asPNG();
    wm.pixmap.destroy();
    wm.page.destroy();
    pdf.destroy();

    const ocrOptions = {
      engine: args.engine,
      pythonBin: args.python,
      workers: 1,
      lang: "chi_sim+eng",
    };
    const started = Date.now();
    const [cleanOcr, wmOcr, cleanedOcr] = await ocrImageBatch(
      [
        { png: cleanPng, page: 1 },
        { png: wmPng, page: 2 },
        { png: cleanedPng, page: 3 },
      ],
      ocrOptions
    );
    const row = {
      docId: doc.id,
      title: doc.title,
      page: pageIndex + 1,
      truthChars: normalizeText(truth).length,
      ocrMs: Date.now() - started,
      watermark: { changed: prepared.changed, ratio: +(prepared.ratio * 100).toFixed(2), removed: prepared.removed, paper: prepared.paper, ink: prepared.ink, threshold: prepared.threshold },
      cer: {
        clean: +charErrorRate(truth, cleanOcr?.text ?? "").toFixed(4),
        watermark: +charErrorRate(truth, wmOcr?.text ?? "").toFixed(4),
        cleaned: +charErrorRate(truth, cleanedOcr?.text ?? "").toFixed(4),
      },
      confidence: {
        clean: cleanOcr?.confidence ?? null,
        watermark: wmOcr?.confidence ?? null,
        cleaned: cleanedOcr?.confidence ?? null,
      },
      errors: [cleanOcr?.error, wmOcr?.error, cleanedOcr?.error].filter(Boolean),
    };
    results.push(row);
    console.log(`${doc.id} ${doc.title.slice(0, 40)} p${row.page}: CER clean=${row.cer.clean} wm=${row.cer.watermark} cleaned=${row.cer.cleaned}`);
  }

  const avg = (key) => results.length === 0 ? 0 : +(results.reduce((sum, row) => sum + row.cer[key], 0) / results.length).toFixed(4);
  const summary = {
    kb: args.kb,
    mode: args.mode,
    docs: results.length,
    dpi: args.dpi,
    average: { clean: avg("clean"), watermark: avg("watermark"), cleaned: avg("cleaned") },
    results,
    generatedAt: new Date().toISOString(),
  };
  const md = [
    `# 水印净化 A/B（${new Date().toISOString()}）`,
    "",
    `- 知识库：${args.kb}`,
    `- 样本：${results.length} 篇文字层 PDF 的自动选正文页（${args.dpi} DPI 渲染 + 半透明斜向浅灰水印）`,
    `- 净化模式：watermark=${args.mode}`,
    `- 平均 CER：干净 ${summary.average.clean} · 有水印 ${summary.average.watermark} · 水印+净化 ${summary.average.cleaned}`,
    "",
    "| 文档 | 页 | 真值字数 | CER 干净 | CER 水印 | CER 净化 | 净化像素% | 置信度(净/水/清) |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map((row) =>
      `| ${escapeHtml(row.title)} | ${row.page} | ${row.truthChars} | ${row.cer.clean} | ${row.cer.watermark} | ${row.cer.cleaned} | ${row.watermark.ratio}% | ${row.confidence.clean ?? "-"} / ${row.confidence.watermark ?? "-"} / ${row.confidence.cleaned ?? "-"} |`
    ),
    "",
    "## 解读",
    "",
    `- 平均 CER：干净 **${summary.average.clean}** → 加水印 **${summary.average.watermark}** → 净化后 **${summary.average.cleaned}**。`,
    `- 若 watermarked > clean：合成水印确实干扰 OCR；若 cleaned < watermarked：净化回补了部分损失。`,
    `- 本样本为 **半透明斜向灰线**，不等同于真实水印的字形/颜色/密度；真实库的水印样本仍建议人工标注后再跑。`,
    "",
    "> CER 用去空白/标点的编辑距离 ÷ 真值长度；越小越好。",
  ].join("\n");
  if (args.json) await writeFile(args.json, JSON.stringify(summary, null, 2), "utf8");
  if (args.report) await writeFile(args.report, md, "utf8");
  console.log(md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`水印 A/B 失败: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
