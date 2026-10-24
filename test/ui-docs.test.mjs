/**
 * 资料 tab：工具栏（搜索/每页条数/分页/跳页）与空状态渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clampDocsPage, docsPageCount, docsPageSize, renderDetail } from "../ui/views/detail.js";

const icons = { upload: "", archive: "", search: "" };
const fmtNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
const current = { page: "detail", name: "标准", tab: "docs" };

function makeDoc(id, patch = {}) {
  return {
    id,
    title: `资料 ${id}`,
    type: "pdf-text",
    pages: 3,
    trust: "high",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  };
}

function makeState(docs = {}) {
  return {
    detailLoading: false,
    detailError: "",
    detail: {
      kb: {
        name: "标准",
        status: "ok",
        description: "现行标准",
        docs: { ready: 2, importing: 0, failed: 0, notes: 0, deleted: 0 },
        pages: 20,
        chars: 1000,
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      health: { failed: 0, importing: 0, lowConfidenceDocs: 0, corruptedDocs: 0, hasSchema: true },
      recentDocs: [],
      logTail: "",
    },
    docs: { items: [], total: 0, offset: 0, limit: 50, query: "", ...docs },
  };
}

function render(docs) {
  return renderDetail(makeState(docs), current, { icons, fmtNumber });
}

test("资料工具栏渲染搜索框、每页条数和顶部/底部分页", () => {
  const html = render({ items: [makeDoc("a1"), makeDoc("a2")], total: 120, offset: 0, limit: 50 });
  assert.match(html, /data-docs-query/);
  assert.match(html, /placeholder="搜索标题、摘要或标签…"/);
  assert.match(html, /<select data-docs-size/);
  assert.match(html, /<option value="50" selected>50<\/option>/);
  assert.match(html, /<option value="100">100<\/option>/);
  assert.match(html, /<option value="200">200<\/option>/);
  assert.match(html, /第 1 \/ 3 页 · 共 120 篇/);
  assert.match(html, /type="number" min="1" max="3"/);
  assert.match(html, /data-docs-jump/);
  // 上下各一组上一页/下一页。
  assert.equal((html.match(/data-action="docs-page"/g) ?? []).length, 4);
  assert.equal((html.match(/data-docs-page/g) ?? []).length, 2);
});

test("第一页禁用上一页、末页禁用下一页", () => {
  const first = render({ items: [makeDoc("a1")], total: 120, offset: 0, limit: 50 });
  assert.match(first, /data-action="docs-page" data-offset="0" disabled>上一页/);
  assert.doesNotMatch(first, /data-action="docs-page"[^>]*disabled>下一页/);

  const last = render({ items: [makeDoc("a3")], total: 120, offset: 100, limit: 50 });
  assert.doesNotMatch(last, /data-action="docs-page"[^>]*disabled>上一页/);
  assert.match(last, /data-action="docs-page"[^>]*disabled>下一页/);
  assert.match(last, /第 3 \/ 3 页 · 共 120 篇/);
  assert.match(last, /data-offset="50"[^>]*>上一页/);

  const middle = render({ items: [makeDoc("a2")], total: 120, offset: 50, limit: 50 });
  assert.doesNotMatch(middle, /data-action="docs-page"[^>]*disabled>上一页/);
  assert.doesNotMatch(middle, /data-action="docs-page"[^>]*disabled>下一页/);
  assert.match(middle, /第 2 \/ 3 页 · 共 120 篇/);
});

test("每页条数选中当前 limit 且总页数按 limit 计算", () => {
  const html = render({ items: [makeDoc("a1")], total: 250, offset: 0, limit: 100 });
  assert.match(html, /<option value="100" selected>100<\/option>/);
  assert.match(html, /第 1 \/ 3 页 · 共 250 篇/);
  assert.match(html, /min="1" max="3"/);
});

test("空库显示「还没有资料」，不渲染工具栏和分页", () => {
  const html = render({ total: 0, query: "" });
  assert.match(html, /还没有资料/);
  assert.doesNotMatch(html, /data-docs-query/);
  assert.doesNotMatch(html, /data-action="docs-page"/);
});

test("有搜索词无结果显示「没有匹配的资料」和清除搜索", () => {
  const html = render({ total: 0, query: "不存在的标准" });
  assert.match(html, /没有匹配的资料/);
  assert.match(html, /data-docs-clear/);
  assert.match(html, /data-docs-query/);
  assert.match(html, /value="不存在的标准"/);
  assert.doesNotMatch(html, /data-action="docs-page"/);
  assert.doesNotMatch(html, /还没有资料/);

  const blank = render({ total: 0, query: "   " });
  assert.match(blank, /还没有资料/);
  assert.doesNotMatch(blank, /data-docs-query/);
});

test("新搜索还没有结果时显示「正在搜索…」，不把旧结果说成新词", () => {
  const empty = render({ total: 0, query: "新词", appliedQuery: "旧词" });
  assert.match(empty, /正在搜索…/);
  assert.doesNotMatch(empty, /没有匹配的资料/);
  assert.match(empty, /data-docs-query/);

  const stale = render({
    items: [makeDoc("old")],
    total: 60,
    offset: 0,
    limit: 50,
    query: "新词",
    appliedQuery: "旧词",
  });
  assert.match(stale, /正在搜索…/);
  assert.doesNotMatch(stale, /第 1–1 篇/);
});

test("表格列和行保持原样并显示条目区间", () => {
  const html = render({
    items: [
      makeDoc("d1", { title: "DL/T 478-2013", type: "pdf-text", pages: 10, trust: "high" }),
      makeDoc("d2", { title: "绝缘油规程", type: "text", pages: 2, trust: "medium" }),
    ],
    total: 60,
    offset: 50,
    limit: 50,
  });
  assert.match(html, /<th>标题<\/th><th>类型<\/th><th>页数<\/th><th>可信度<\/th><th>更新<\/th>/);
  assert.match(html, /data-action="open-doc" data-kb="标准" data-id="d1"/);
  assert.match(html, /data-action="open-doc" data-kb="标准" data-id="d2"/);
  assert.match(html, /<td class="muted">pdf-text<\/td>/);
  assert.match(html, /<td class="muted">medium<\/td>/);
  assert.match(html, /第 51–52 篇/);
  assert.match(html, /第 2 \/ 2 页 · 共 60 篇/);
});

test("搜索词与标题按 HTML 转义", () => {
  const html = render({
    items: [makeDoc("x", { title: "<img src=x onerror=alert(1)>" })],
    total: 1,
    query: '"><script>alert(1)</script>',
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /value="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
});

test("分页辅助函数收敛每页条数与跳页范围", () => {
  assert.equal(docsPageSize(100), 100);
  assert.equal(docsPageSize(200), 200);
  assert.equal(docsPageSize(999), 50);
  assert.equal(docsPageSize(undefined), 50);
  assert.equal(docsPageCount(0, 50), 1);
  assert.equal(docsPageCount(120, 50), 3);
  assert.equal(docsPageCount(121, 50), 3);
  assert.equal(docsPageCount(120, 100), 2);
  assert.equal(clampDocsPage(0, 3), 1);
  assert.equal(clampDocsPage("abc", 3), 1);
  assert.equal(clampDocsPage("", 3), 1);
  assert.equal(clampDocsPage(2, 3), 2);
  assert.equal(clampDocsPage(99, 3), 3);
});
