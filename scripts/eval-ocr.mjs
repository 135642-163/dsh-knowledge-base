#!/usr/bin/env node
/**
 * OCR 引擎对比：本地（rapidocr/tesseract）vs DeepSeek 云端 OCR。
 *
 * 用途：在决定是否把云端 OCR 设为某类资料的默认引擎前，用样张量化差异。
 * 只上传 --cloud 时显式指定的页；默认只跑本地，绝不自动上云。
 *
 * 用法：
 *   node scripts/eval-ocr.mjs --pdf 样张.pdf --pages 1-3 --local
 *   node scripts/eval-ocr.mjs --image 封面.png --cloud --host-key
 *   node scripts/eval-ocr.mjs --pdf 样张.pdf --pages 1-5 --local --cloud --out report.md
 *
 * 密钥：--host-key 读取宿主 ~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY；
 * 否则用环境变量 DEEPSEEK_API_KEY。
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deepseekOcrImage } from "../lib/deepseek-api.js";
import { ocrImageBatch } from "../lib/ocr.js";

/** 云端会把表格输出成 HTML、公式输出成 $...$；对比 CER 前先摊平成纯文字。 */
export function flattenRichOcr(text) {
  return String(text ?? "")
    .replace(/<\/?(?:table|thead|tbody|tr|td|th)[^>]*>/g, " ")
    .replace(/\$([^$]*)\$/g, (_, math) => math
      .replace(/\\leqslant/g, "≤").replace(/\\geqslant/g, "≥").replace(/\\times/g, "×")
      .replace(/\\lg/g, "Iq").replace(/\\text\{([^}]*)\}/g, "$1").replace(/\\%/g, "%").replace(/[\\{}]/g, ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseArgs(argv) {
  const out = { pages: "1", local: false, cloud: false, hostKey: false, dpi: 200 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--local") out.local = true;
    else if (arg === "--cloud") out.cloud = true;
    else if (arg === "--host-key") out.hostKey = true;
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--pdf") out.pdf = argv[++i];
    else if (arg === "--image") out.image = argv[++i];
    else if (arg === "--pages") out.pages = argv[++i];
    else if (arg === "--dpi") out.dpi = Number(argv[++i]) || 200;
    else if (arg === "--truth") out.truth = argv[++i];
  }
  if (!out.pdf && !out.image) throw new Error("需要 --pdf 或 --image");
  if (!out.local && !out.cloud) out.local = true;
  return out;
}

function parsePages(spec, total) {
  const pages = new Set();
  for (const part of String(spec ?? "1").split(",")) {
    const [a, b] = part.split("-").map((v) => Number(v.trim()));
    if (!Number.isFinite(a)) continue;
    const end = Number.isFinite(b) ? b : a;
    for (let p = Math.max(1, a); p <= Math.min(total, end); p += 1) pages.add(p);
  }
  return [...pages].sort((x, y) => x - y);
}

async function hostKey() {
  const path = join(homedir(), ".dsh", ".credentials.yaml");
  const text = await readFile(path, "utf8");
  const m = /^\s+refs:\s*$([\s\S]*?)(?=^\S|\Z)/m.exec(text);
  const block = m ? m[1] : text;
  const hit = /^\s+DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m.exec(block);
  if (!hit) throw new Error("宿主凭据里没有 DEEPSEEK_API_KEY");
  return hit[1];
}

async function renderPages(path, dpi, pagesSpec) {
  const data = await readFile(path);
  const ext = String(path).toLowerCase();
  if (!ext.endsWith(".pdf")) {
    // 图片本身就是一页，直接原样送 OCR，避免 mupdf 图像文档的页边界裁切。
    return { total: 1, pages: [{ page: 1, png: data }] };
  }
  const { default: mupdf } = await import("mupdf");
  const mime = "application/pdf";
  const doc = mupdf.Document.openDocument(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), mime);
  try {
    const total = doc.countPages();
    const indexes = parsePages(pagesSpec, total);
    const out = [];
    for (const pageNo of indexes) {
      const page = doc.loadPage(pageNo - 1);
      try {
        const zoom = Math.max(0.5, Number(dpi) / 72);
        const pixmap = page.toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false, true);
        try {
          out.push({ page: pageNo, png: pixmap.asPNG() });
        } finally {
          try { pixmap.destroy(); } catch { /* ignore */ }
        }
      } finally {
        try { page.destroy(); } catch { /* ignore */ }
      }
    }
    return { total, pages: out };
  } finally {
    try { doc.destroy(); } catch { /* ignore */ }
  }
}

/** 归一化：去掉空白与常见标点，只比较实际文字。 */
function normalizeText(text) {
  return String(text ?? "")
    .replace(/\s+/g, "")
    .replace(/[，。、；：！？（）【】《》“”‘’·,.;:!?()\[\]<>"']/g, "");
}

/** 字符错误率：编辑距离 / 参考长度。 */
export function cer(reference, hypothesis) {
  const a = [...normalizeText(reference)];
  const b = [...normalizeText(hypothesis)];
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] / a.length;
}

function preview(text, n = 120) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, n);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = args.cloud ? (args.hostKey ? await hostKey() : String(process.env.DEEPSEEK_API_KEY ?? "")) : "";
  if (args.cloud && apiKey === "") throw new Error("--cloud 需要 --host-key 或 DEEPSEEK_API_KEY");
  const source = args.pdf ?? args.image;
  const { total, pages } = await renderPages(source, args.dpi, args.pages);
  const truth = args.truth ? await readFile(args.truth, "utf8") : "";
  const rows = [];
  for (const item of pages) {
    const row = { page: item.page };
    if (args.local) {
      const started = Date.now();
      const [result] = await ocrImageBatch([{ png: item.png, page: item.page }], { engine: "auto" });
      row.localMs = Date.now() - started;
      row.localText = result?.text ?? "";
      row.localError = result?.error ?? "";
    }
    if (args.cloud) {
      const started = Date.now();
      try {
        const result = await deepseekOcrImage({ png: item.png, apiKey });
        row.cloudMs = Date.now() - started;
        row.cloudText = result.text;
        row.cloudTruncated = result.truncated;
      } catch (error) {
        row.cloudError = String(error?.message ?? error);
      }
    }
    if (truth && row.localText) row.localCer = cer(truth, row.localText);
    if (truth && row.cloudText) {
      row.cloudCer = cer(truth, row.cloudText);
      row.cloudPlainCer = cer(truth, flattenRichOcr(row.cloudText));
    }
    rows.push(row);
  }

  const lines = [];
  lines.push(`# OCR 对比报告`);
  lines.push("");
  lines.push(`- 来源：${source}`);
  lines.push(`- 页数：${total}（本次 ${pages.length} 页：${pages.map((p) => p.page).join("、")}）`);
  lines.push(`- 本地引擎：${args.local ? "是" : "否"}；云端：${args.cloud ? "是（页面图已上传）" : "否"}`);
  if (truth) lines.push(`- 参考文本：${args.truth}`);
  lines.push("");
  lines.push("| 页 | 本地耗时 | 云端耗时 | 本地 CER | 云端 CER（原文） | 云端 CER（去表格/公式标记） | 云端截断 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(
      `| ${row.page} | ${row.localMs ?? "-"} ms | ${row.cloudMs ?? "-"} ms | ${row.localCer == null ? "-" : (row.localCer * 100).toFixed(1) + "%"} | ${row.cloudCer == null ? "-" : (row.cloudCer * 100).toFixed(1) + "%"} | ${row.cloudPlainCer == null ? "-" : (row.cloudPlainCer * 100).toFixed(1) + "%"} | ${row.cloudTruncated ? "是" : "-"} |`
    );
  }
  lines.push("");
  for (const row of rows) {
    lines.push(`## 第 ${row.page} 页`);
    if (row.localError) lines.push(`本地错误：${row.localError}`);
    if (row.cloudError) lines.push(`云端错误：${row.cloudError}`);
    lines.push(`本地输出：${preview(row.localText)}`);
    lines.push("");
    lines.push(`云端输出：${preview(row.cloudText)}`);
    lines.push("");
  }
  const report = lines.join("\n");
  if (args.out) {
    await writeFile(args.out, report, "utf8");
    console.log(`报告已写入 ${args.out}`);
  } else {
    console.log(report);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}
