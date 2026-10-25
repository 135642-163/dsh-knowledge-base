/**
 * 工作台深链解析与 PDF 页码 fragment。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clampPage, parsePreviewDeepLink, withPageFragment } from "../ui/deep-link.js";
import { renderPreviewBody } from "../ui/views/modals.js";

test("parsePreviewDeepLink 解析编码参数与非法页码", () => {
  const link = parsePreviewDeepLink("?kb=%E6%A0%87%E5%87%86&doc=d1&page=12&clause=5.2.2");
  assert.deepEqual(link, { kb: "标准", docId: "d1", page: 12, clause: "5.2.2" });
  assert.equal(parsePreviewDeepLink("?doc=d1&page=0").page, null);
  assert.equal(parsePreviewDeepLink("?doc=d1&page=abc").page, null);
  assert.deepEqual(parsePreviewDeepLink(""), { kb: "", docId: "", page: null, clause: "" });
});

test("clampPage 收敛非法/超界页码", () => {
  assert.equal(clampPage(0, 10), 1);
  assert.equal(clampPage(999, 10), 10);
  assert.equal(clampPage(-5, 10), 1);
  assert.equal(clampPage(3, 10), 3);
  assert.equal(clampPage(3, 0), 1);
});

test("withPageFragment 只给 PDF/Office URL 追加 fragment", () => {
  assert.equal(withPageFragment("/a.pdf", 12), "/a.pdf#page=12&zoom=page-fit");
  assert.equal(withPageFragment("/a.pdf", null), "/a.pdf");
  assert.equal(withPageFragment("/a.pdf#old", 2), "/a.pdf#old&page=2&zoom=page-fit");
});

test("renderPreviewBody 在 PDF/Office iframe 上带页码，文本提示无页码", () => {
  const urls = { inline: "/a.pdf", pdf: "/p.pdf", download: "/d" };
  const pdf = renderPreviewBody({ kind: "pdf", urls, page: 12 });
  assert.match(pdf, /src="\/a\.pdf#page=12&amp;zoom=page-fit"/);
  assert.match(pdf, /已定位到第 12 页/);
  const office = renderPreviewBody({ kind: "office", urls, page: 3 });
  assert.match(office, /src="\/p\.pdf#page=3&amp;zoom=page-fit"/);
  const text = renderPreviewBody({ kind: "text", urls, content: { markdown: "正文" }, page: 2 });
  assert.match(text, /该资料没有页码/);
});
