#!/usr/bin/env node
/**
 * 存量「图文页」体检（只读）：找出正文页文字层几乎为空、但页面本身有内容的 PDF。
 *
 * 背景：扫描件常有两类漏网 ——
 *   ① 文字层只剩一段水印/页眉（字数刚好高于阈值）；
 *   ② 扫描图包在 Form XObject 里，walk 看不到图像块，被当成空白页。
 * 导入时的启发式已修（0.38.1），本脚本用于排查修复之前入库的老资料。
 *
 * 判据：逐页统计 markdown 正文字符（去掉“本页无文字内容/影印古籍”等占位符）。
 * 命中页 = 低文字页（< LOW_CHARS）或“模板页”（整页文字=同一段短串，出现在 >=30% 页上，
 * 典型是每页只剩水印）；命中页占比 >= MIN_RATIO 的文档进入候选；
 * 再对候选用 mupdf 约 36 DPI 渲染做墨迹复核（非白像素占比 >= INK_THRESHOLD 视为有画面）。
 *
 * 用法：
 *   node scripts/audit-text-gap.mjs [--kb 标准] [--min-ratio 0.3] [--json out.json]
 * 只读：不修改任何知识库文件。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { kbDirPath, readManifest } from '../lib/store.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ROOT = process.env.KB_ROOT || join(homedir(), 'workspace', 'knowledge');
const ONLY_KB = flag('--kb', '');
const MIN_RATIO = Math.max(0.05, Math.min(1, Number(flag('--min-ratio', '0.3')) || 0.3));
const JSON_OUT = flag('--json', '');
const LOW_CHARS = 20;
const TEMPLATE_MAX_CHARS = 200;
const TEMPLATE_RATIO = 0.3;
const INK_THRESHOLD = 0.006; // 与 lib/parsers.js INK_RATIO_THRESHOLD 保持一致
const MAX_SAMPLES = 5;

const PLACEHOLDER = /（[^（）]*(?:本页无文字内容|影印古籍|页面渲染失败|OCR 失败)[^（）]*）/g;

function pageTexts(markdown) {
  return markdown
    .split(/### 第 \d+ 页/)
    .slice(1)
    .map((body) => body.replace(/<!--[\s\S]*?-->/g, '').replace(PLACEHOLDER, '').replace(/\s+/g, ''));
}

function classify(doc) {
  const type = String(doc.type ?? '');
  if (type === 'pdf-scanned') return '扫描件（已 OCR）';
  if (type === 'pdf-mixed') return '混合型';
  return '文字版';
}

async function inkRatio(mupdf, pdfDoc, pageNo) {
  let page = null;
  let pixmap = null;
  try {
    page = pdfDoc.loadPage(pageNo - 1);
    pixmap = page.toPixmap(mupdf.Matrix.scale(0.5, 0.5), mupdf.ColorSpace.DeviceGray, false, true);
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const stride = pixmap.getStride();
    const pixels = pixmap.getPixels();
    const stepX = Math.max(1, Math.floor(width / 80));
    const stepY = Math.max(1, Math.floor(height / 80));
    let ink = 0;
    let total = 0;
    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        total += 1;
        if (pixels[y * stride + x] < 245) ink += 1;
      }
    }
    return total > 0 ? ink / total : 0;
  } catch {
    return null;
  } finally {
    try { pixmap?.destroy(); } catch { /* ignore */ }
    try { page?.destroy(); } catch { /* ignore */ }
  }
}

const { default: mupdf } = await import('mupdf');
const kbs = (await readdir(ROOT, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== 'Icon')
  .map((entry) => entry.name)
  .filter((name) => (ONLY_KB ? name === ONLY_KB : true))
  .sort();

const rows = [];
let pdfDocs = 0;
let skippedBooks = 0;

for (const kb of kbs) {
  const dir = kbDirPath(ROOT, kb);
  let manifest;
  try {
    manifest = await readManifest(dir);
  } catch {
    continue;
  }
  for (const doc of manifest.docs ?? []) {
    if (doc.status !== 'ready') continue;
    if (!String(doc.type ?? '').startsWith('pdf')) continue;
    const mdPath = join(dir, 'markdown', doc.id, `${doc.id}.md`);
    let markdown;
    try {
      markdown = await readFile(mdPath, 'utf8');
    } catch {
      continue;
    }
    const texts = pageTexts(markdown);
    if (texts.length < 2) continue;
    pdfDocs += 1;
    // 影印古籍（导入时 skipOcr，正文按设计只给 kb_view 看）：整本都是占位符，不计入问题。
    const facsimilePages = (markdown.match(/影印古籍页面/g) ?? []).length;
    if (facsimilePages >= texts.length * 0.8) {
      skippedBooks += 1;
      continue;
    }
    const counts = new Map();
    for (const text of texts) {
      if (text && text.length <= TEMPLATE_MAX_CHARS) counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    const templateMinPages = Math.max(2, Math.ceil(texts.length * TEMPLATE_RATIO));
    const hitFlags = texts.map((text) => {
      const isLow = text.length < LOW_CHARS;
      const isTemplate = Boolean(text) && (counts.get(text) ?? 0) >= templateMinPages;
      return { low: isLow, template: isTemplate, page: 0 };
    }).map((flag, index) => ({ ...flag, page: index + 1 }));
    const lowPages = hitFlags.filter((flag) => flag.low).length;
    const templatePages = hitFlags.filter((flag) => flag.template && !flag.low).length;
    const hitPages = lowPages + templatePages;
    const ratio = hitPages / texts.length;
    if (ratio < MIN_RATIO) continue;
    const sample = hitFlags
      .filter((flag) => flag.low || flag.template)
      .slice(0, MAX_SAMPLES)
      .map((flag) => flag.page);
    let inkHits = 0;
    let inkMax = 0;
    let pdfDoc = null;
    try {
      const data = await readFile(join(dir, 'sources', `${doc.id}.pdf`));
      pdfDoc = mupdf.Document.openDocument(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        'application/pdf'
      );
      for (const pageNo of sample) {
        const ratioInk = await inkRatio(mupdf, pdfDoc, pageNo);
        if (ratioInk === null) continue;
        inkMax = Math.max(inkMax, ratioInk);
        if (ratioInk >= INK_THRESHOLD) inkHits += 1;
      }
    } catch {
      /* 原件缺失/损坏：只报文字层结论 */
    } finally {
      try { pdfDoc?.destroy(); } catch { /* ignore */ }
    }
    rows.push({
      kb,
      docId: doc.id,
      title: doc.title,
      kind: classify(doc),
      pages: doc.pages || texts.length,
      lowPages,
      templatePages,
      hitRatio: Math.round(ratio * 100) / 100,
      avgChars: Math.round(texts.reduce((sum, text) => sum + text.length, 0) / texts.length),
      inkHits,
      inkMaxPct: Math.round(inkMax * 1000) / 10,
      verdict: inkHits > 0 ? '疑似图片页未识别（建议 forceOcr）' : '文字稀薄但页面也淡（人工看）',
    });
  }
}

rows.sort((a, b) => b.hitRatio - a.hitRatio || b.lowPages - a.lowPages);
const summary = {
  root: ROOT,
  scannedPdfDocs: pdfDocs,
  skippedScannedBooks: skippedBooks,
  minRatio: MIN_RATIO,
  candidates: rows.length,
  suspicious: rows.filter((row) => row.verdict.startsWith('疑似')).length,
  rows,
};
if (JSON_OUT) await writeFile(JSON_OUT, `${JSON.stringify(summary, null, 1)}\n`);

console.log(`知识库根目录：${ROOT}`);
console.log(`已扫描 PDF 文档 ${pdfDocs} 篇（跳过影印古籍 ${skippedBooks} 篇，低文字页占比阈值 ${MIN_RATIO}）`);
console.log(`候选 ${rows.length} 篇，其中疑似图片页未识别 ${summary.suspicious} 篇`);
if (rows.length === 0) {
  console.log('没有发现需要补 OCR 的存量文档。');
} else {
  for (const row of rows.slice(0, 40)) {
    console.log(
      `- [${row.kb}] ${row.kind} ${row.lowPages} 页低文字 + ${row.templatePages} 页模板串 /${row.pages} 页(${row.hitRatio}) 墨迹峰值 ${row.inkMaxPct}% · ${row.verdict}\n  ${row.docId}  ${row.title.slice(0, 70)}`
    );
  }
  if (rows.length > 40) console.log(`…还有 ${rows.length - 40} 篇（用 --json 导出完整清单）`);
}
