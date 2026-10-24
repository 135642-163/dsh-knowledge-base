/**
 * 原件预览与重命名：预览类型判定、弹窗正文 HTML、URL 构造与重命名校验。
 * 全部是纯函数/客户端方法，不需要 DOM。
 */
import test from "node:test";
import assert from "node:assert/strict";

const calls = [];
let payload = { title: "笔记", markdown: "# 标题\n正文" };
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  return { ok: true, status: 200, json: async () => payload };
};

const { api } = await import("../ui/api.js");
const { normalizeRenameValue, previewKindFor, renderPreviewBody } = await import("../ui/views/modals.js");

const URLS = {
  inline: "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/d1/source?inline=1",
  pdf: "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/d1/preview.pdf",
  download: "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/d1/source",
};

test("原件 URL 构造区分下载 / 内联 / Office PDF 预览并编码库名与文档 id", () => {
  assert.equal(
    api.sourceUrl("标准/库", "id 1"),
    "/kb/api/kbs/%E6%A0%87%E5%87%86%2F%E5%BA%93/docs/id%201/source",
  );
  assert.equal(
    api.sourceInlineUrl("标准/库", "id 1"),
    "/kb/api/kbs/%E6%A0%87%E5%87%86%2F%E5%BA%93/docs/id%201/source?inline=1",
  );
  assert.equal(
    api.previewPdfUrl("标准/库", "id 1"),
    "/kb/api/kbs/%E6%A0%87%E5%87%86%2F%E5%BA%93/docs/id%201/preview.pdf",
  );
});

test("docContent 用 GET 打 /content 并解包 JSON", async () => {
  calls.length = 0;
  const content = await api.docContent("标准", "n1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/n1/content");
  assert.equal(calls[0].options.method, "GET");
  assert.deepEqual(content, { title: "笔记", markdown: "# 标题\n正文" });
});

test("previewKindFor 按类型与原件扩展名判定预览方式", () => {
  const cases = [
    [{ type: "note" }, "note"],
    [{ type: "note", sourceFile: "note.pdf" }, "note"],
    [{ type: "pdf-text", sourceFile: "DL 478-2013.pdf" }, "pdf"],
    [{ type: "pdf-scanned", sourceFile: "扫描.PDF" }, "pdf"],
    [{ type: "pdf-mixed" }, "pdf"],
    [{ type: "image", sourceFile: "接线图.PNG" }, "image"],
    [{ type: "unknown", sourceFile: "照片.jpeg" }, "image"],
    [{ type: "unknown", sourceFile: "图标.webp" }, "image"],
    [{ type: "text", sourceFile: "说明.txt" }, "text"],
    [{ type: "markdown", sourceFile: "笔记.MD" }, "text"],
    [{ type: "text" }, "text"],
    [{ type: "docx", sourceFile: "说明书.docx" }, "office"],
    [{ type: "xlsx", sourceFile: "台账.xlsx" }, "office"],
    [{ type: "pptx" }, "office"],
    [{ type: "unknown", sourceFile: "归档.tar.gz" }, "unsupported"],
    [{ type: "epub", sourceFile: "书.epub" }, "unsupported"],
    [{ type: "unknown", sourceFile: "没有扩展名" }, "unsupported"],
    [undefined, "unsupported"],
    [{}, "unsupported"],
  ];
  for (const [doc, kind] of cases) {
    assert.equal(previewKindFor(doc), kind, JSON.stringify(doc));
  }
});

test("PDF 用内联原件 iframe，Office 用转换后的 PDF 并提示首次较慢", () => {
  const pdf = renderPreviewBody({ kind: "pdf", urls: URLS });
  assert.match(pdf, /<iframe class="preview-frame" src="\/kb\/api\/kbs\/%E6%A0%87%E5%87%86\/docs\/d1\/source\?inline=1"/);
  assert.doesNotMatch(pdf, /正在转换原件/);

  const office = renderPreviewBody({ kind: "office", urls: URLS });
  assert.match(office, /<iframe class="preview-frame" src="\/kb\/api\/kbs\/%E6%A0%87%E5%87%86\/docs\/d1\/preview\.pdf"/);
  assert.match(office, /正在转换原件，首次可能需要几秒…/);
});

test("图片用 <img>，笔记/文本用转义后的 pre", () => {
  const image = renderPreviewBody({ kind: "image", urls: URLS });
  assert.match(image, /<img class="preview-image" src="\/kb\/api\/kbs\/%E6%A0%87%E5%87%86\/docs\/d1\/source\?inline=1"/);

  const note = renderPreviewBody({
    kind: "note",
    urls: URLS,
    content: { markdown: "<script>alert(1)</script>\n第二行", truncated: true },
  });
  assert.match(note, /<pre class="preview-text">&lt;script&gt;alert\(1\)&lt;\/script&gt;\n第二行<\/pre>/);
  assert.match(note, /仅显示前 2 MB/);
  assert.doesNotMatch(note, /<script>/);

  const text = renderPreviewBody({ kind: "text", urls: URLS, content: { markdown: "aa & bb" } });
  assert.match(text, /<pre class="preview-text">aa &amp; bb<\/pre>/);
});

test("内容读取失败显示错误与下载入口；未知格式提示下载原件", () => {
  const failed = renderPreviewBody({ kind: "text", urls: URLS, content: { error: "原件不存在" } });
  assert.match(failed, /原件不存在/);
  assert.match(failed, /href="\/kb\/api\/kbs\/%E6%A0%87%E5%87%86\/docs\/d1\/source"/);
  assert.match(failed, /下载原件/);

  const unsupported = renderPreviewBody({ kind: "unsupported", urls: URLS });
  assert.match(unsupported, /该格式暂不支持内嵌预览，请下载原件/);
  assert.match(unsupported, /下载原件/);
});

test("预览正文里的 URL 属性按 HTML 转义", () => {
  const html = renderPreviewBody({ kind: "pdf", urls: { inline: "/x?a=1&b=\"2\"", download: "/x" } });
  assert.match(html, /src="\/x\?a=1&amp;b=&quot;2&quot;"/);
  assert.doesNotMatch(html, /b="2"/);
});

test("normalizeRenameValue 拒绝空值与原名，返回 trim 后的新名", () => {
  assert.deepEqual(normalizeRenameValue("", "标准"), { ok: false, error: "请输入名称" });
  assert.deepEqual(normalizeRenameValue("   ", "标准"), { ok: false, error: "请输入名称" });
  assert.deepEqual(normalizeRenameValue(null, "标准"), { ok: false, error: "请输入名称" });
  assert.deepEqual(normalizeRenameValue(" 标准 ", "标准"), { ok: false, error: "名称没有变化" });
  assert.deepEqual(normalizeRenameValue("  新标准  ", "标准"), { ok: true, value: "新标准" });
  assert.deepEqual(normalizeRenameValue("标准 2", "标准"), { ok: true, value: "标准 2" });
});
