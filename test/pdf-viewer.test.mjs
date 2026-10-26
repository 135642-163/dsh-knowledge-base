/**
 * PDF viewer：页码语义、旋转坐标、命中计数与截断、无文字层降级、转义。
 * 用真实 mupdf 渲染最小 PDF（文字页 / 空白页），不依赖本机知识库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VIEWER_MAX_MARKS_PER_PAGE,
  VIEWER_MAX_TERMS,
  clampViewerPage,
  collectPageMarks,
  hitsLabel,
  normalizeRotate,
  normalizeViewerTerms,
  parseViewerPage,
  renderPdfViewerHtml,
  resolveStartPage,
  rotatePoint,
  rotatedBounds,
  transformQuad,
} from "../lib/web/pdf-viewer.js";

// ---------------------------------------------------------------------------
// 最小 PDF 构造（文字页 / 无文字层页）
// ---------------------------------------------------------------------------

function buildPdf(pageStreams) {
  const total = pageStreams.length;
  const kids = pageStreams.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  const fontId = 3 + total * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`,
  ];
  for (const stream of pageStreams) {
    const contentId = objects.length + 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "binary");
}

const textPage = (text) => `BT /F1 14 Tf 20 100 Td (${text}) Tj ET\n`;
const blankPage = "0 0 1 rg 10 10 100 100 re f\n";

async function makePdf(t, pages) {
  const dir = await mkdtemp(join(tmpdir(), "kb-viewer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "fixture.pdf");
  await writeFile(path, buildPdf(pages));
  return path;
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("normalizeViewerTerms 去重、限长、限数量", () => {
  assert.deepEqual(normalizeViewerTerms("电压|电压| 谐波 |a|"), ["电压", "谐波"]);
  assert.deepEqual(normalizeViewerTerms(["GB/T 19963", "gb/t 19963"]), ["GB/T 19963"]);
  assert.deepEqual(normalizeViewerTerms(""), []);
  assert.deepEqual(normalizeViewerTerms(null), []);
  assert.equal(normalizeViewerTerms("x".repeat(60))[0].length, 40);
  const many = Array.from({ length: 12 }, (_, index) => `词${index + 10}`);
  assert.equal(normalizeViewerTerms(many).length, VIEWER_MAX_TERMS);
});

test("parseViewerPage / clampViewerPage", () => {
  assert.equal(parseViewerPage(null), null);
  assert.equal(parseViewerPage(""), null);
  assert.equal(parseViewerPage("abc"), null);
  assert.equal(parseViewerPage("0"), null);
  assert.equal(parseViewerPage("3.4"), 3);
  assert.equal(parseViewerPage(7), 7);
  assert.equal(clampViewerPage(0, 10), 1);
  assert.equal(clampViewerPage(999, 10), 10);
  assert.equal(clampViewerPage(5, 10), 5);
  assert.equal(clampViewerPage("x", 10), 1);
  assert.equal(clampViewerPage(3, 0), 1);
});

test("normalizeRotate 只接受 0/90/180/270", () => {
  assert.equal(normalizeRotate(0), 0);
  assert.equal(normalizeRotate("90"), 90);
  assert.equal(normalizeRotate("270"), 270);
  assert.equal(normalizeRotate(45), 0);
  assert.equal(normalizeRotate(-90), 270);
  assert.equal(normalizeRotate("x"), 0);
});

test("resolveStartPage：显式页码优先，其次命中最多的页", () => {
  const pageHits = new Map([[3, 5], [7, 2]]);
  assert.equal(resolveStartPage({ requested: 7, total: 20, pageHits }), 7);
  assert.equal(resolveStartPage({ requested: null, total: 20, pageHits }), 3);
  assert.equal(resolveStartPage({ requested: 999, total: 20, pageHits }), 20);
  assert.equal(resolveStartPage({ requested: null, total: 20, pageHits: new Map() }), 1);
});

test("旋转坐标与 mupdf Matrix.rotate 同向", () => {
  assert.deepEqual(rotatePoint(2, 3, 0), [2, 3]);
  assert.deepEqual(rotatePoint(2, 3, 90), [-3, 2]);
  assert.deepEqual(rotatePoint(2, 3, 180), [-2, -3]);
  assert.deepEqual(rotatePoint(2, 3, 270), [3, -2]);
  const portrait = rotatedBounds([0, 0, 300, 200], 0);
  assert.deepEqual(portrait, { minX: 0, minY: 0, width: 300, height: 200 });
  const rotated = rotatedBounds([0, 0, 300, 200], 90);
  assert.deepEqual(rotated, { minX: -200, minY: 0, width: 200, height: 300 });
  const quad = [20, 84.95, 86.136, 84.95, 20, 104.19, 86.136, 104.19];
  const box = transformQuad(quad, [0, 0, 300, 200], 0);
  assert.equal(box.left.toFixed(4), (20 / 300).toFixed(4));
  assert.equal(box.top.toFixed(4), (84.95 / 200).toFixed(4));
  const rotatedBox = transformQuad(quad, [0, 0, 300, 200], 90);
  assert.equal(rotatedBox.left.toFixed(4), ((-104.19 + 200) / 200).toFixed(4));
  assert.equal(rotatedBox.top.toFixed(4), (20 / 300).toFixed(4));
});

test("collectPageMarks 截断到每页上限并如实标记", () => {
  const quad = [20, 80, 60, 80, 20, 100, 60, 100];
  const quads = Array.from({ length: VIEWER_MAX_MARKS_PER_PAGE + 30 }, () => quad);
  const result = collectPageMarks({ quads, bounds: [0, 0, 300, 200], rotate: 0 });
  assert.equal(result.marks.length, VIEWER_MAX_MARKS_PER_PAGE);
  assert.equal(result.truncated, true);
  const small = collectPageMarks({ quads: [quad, quad], bounds: [0, 0, 300, 200], rotate: 0 });
  assert.equal(small.marks.length, 2);
  assert.equal(small.truncated, false);
});

test("hitsLabel 如实提示截断", () => {
  assert.equal(hitsLabel({ hits: 0 }), "");
  assert.equal(hitsLabel({ hits: 3 }), "高亮 3 处");
  assert.equal(
    hitsLabel({ hits: VIEWER_MAX_MARKS_PER_PAGE, truncated: true }),
    `高亮 ${VIEWER_MAX_MARKS_PER_PAGE} 处（每页最多 ${VIEWER_MAX_MARKS_PER_PAGE} 处，已截断）`,
  );
});

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

test("文字 PDF：命中、显式页码优先、无横幅", async (t) => {
  const pdfPath = await makePdf(t, [textPage("VOLTAGE 7 PERCENT"), textPage("HARMONIC CURRENT")]);
  const rendered = await renderPdfViewerHtml({
    pdfPath, title: "测试标准", page: 2, terms: ["HARMONIC"],
  });
  assert.equal(rendered.total, 2);
  assert.ok(rendered.hits > 0, String(rendered.hits));
  assert.equal(rendered.start, 2);
  assert.equal(rendered.hasTextLayer, true);
  assert.equal(rendered.truncated, false);
  assert.match(rendered.html, /<span class="hl"/);
  assert.match(rendered.html, /高亮 \d+ 处/);
  assert.doesNotMatch(rendered.html, /没有文字层/);
});

test("没有 page 参数时落到命中最多的页", async (t) => {
  const pdfPath = await makePdf(t, [textPage("NOTHING HERE"), textPage("VOLTAGE"), textPage("VOLTAGE VOLTAGE")]);
  const rendered = await renderPdfViewerHtml({ pdfPath, title: "自动页", page: null, terms: ["VOLTAGE"] });
  assert.equal(rendered.start, 3);
  assert.equal(rendered.requestedPage, null);
});

test("扫描件（无文字层）给出降级横幅且不报错", async (t) => {
  const pdfPath = await makePdf(t, [blankPage]);
  const rendered = await renderPdfViewerHtml({ pdfPath, title: "扫描件", page: 1, terms: ["电压偏差"] });
  assert.equal(rendered.hits, 0);
  assert.equal(rendered.hasTextLayer, false);
  assert.equal(rendered.start, 1);
  assert.match(rendered.html, /没有文字层/);
  assert.match(rendered.html, /扫描件/);
});

test("有文字层但没命中：提示未找到关键词", async (t) => {
  const pdfPath = await makePdf(t, [textPage("VOLTAGE")]);
  const rendered = await renderPdfViewerHtml({ pdfPath, title: "无命中", page: 1, terms: ["谐波电流"] });
  assert.equal(rendered.hits, 0);
  assert.equal(rendered.hasTextLayer, true);
  assert.match(rendered.html, /未在原件中找到/);
  assert.doesNotMatch(rendered.html, /没有文字层/);
});

test("没有关键词时不显示横幅", async (t) => {
  const pdfPath = await makePdf(t, [textPage("VOLTAGE")]);
  const rendered = await renderPdfViewerHtml({ pdfPath, title: "无词", page: null, terms: [] });
  assert.equal(rendered.hits, 0);
  assert.doesNotMatch(rendered.html, /没有文字层|未在原件中找到/);
});

test("旋转：页图 URL 带 rotate，标记仍在", async (t) => {
  const pdfPath = await makePdf(t, [textPage("VOLTAGE")]);
  const rendered = await renderPdfViewerHtml({ pdfPath, title: "旋转", page: 1, terms: ["VOLTAGE"], rotate: 90 });
  assert.equal(rendered.rotate, 90);
  assert.match(rendered.html, /page\.png\?page=1&amp;dpi=144&amp;rotate=90/);
  assert.match(rendered.html, /<span class="hl"/);
});

test("标题与关键词转义，不产生可执行 HTML", async (t) => {
  const pdfPath = await makePdf(t, [blankPage]);
  const rendered = await renderPdfViewerHtml({
    pdfPath,
    title: `<img src=x onerror="alert(1)">`,
    page: 1,
    terms: ["<b>x</b>"],
  });
  assert.ok(rendered.html.includes("&lt;img src=x"));
  assert.ok(!rendered.html.includes("<img src=x"));
  assert.ok(!rendered.html.includes("<b>x</b>"));
});
