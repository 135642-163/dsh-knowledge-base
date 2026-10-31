/**
 * 资料 tab：工具栏（搜索/每页条数/分页/跳页）与空状态渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DOCS_STATUSES, clampDocsPage, docsPageCount, docsPageSize, docsStatus, renderDetail } from "../ui/views/detail.js";
import { renderOverview } from "../ui/views/overview.js";
import { statusBadges } from "../ui/views/badges.js";

const icons = { upload: "", archive: "", search: "", chevron: "", database: "" };
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
  assert.match(html, /placeholder="搜索标题、摘要、标准号或标签…"/);
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
  assert.match(stale, /data-docs-query/);
  assert.match(stale, /value="新词"/);
  // 旧查询的行/表格/分页不能挂在新搜索词下面，分页在搜索中也保持隐藏。
  assert.doesNotMatch(stale, /data-action="open-doc"/);
  assert.doesNotMatch(stale, /<table/);
  assert.doesNotMatch(stale, /第 1–1 篇/);
  assert.doesNotMatch(stale, /data-action="docs-page"/);
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
  assert.match(html, /<option value="medium" selected>中<\/option>/);
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

// ---------------------------------------------------------------------------
// 状态筛选 / 笔记列表 / 状态徽标 / 重命名入口（0.22.0 Task 5）
// ---------------------------------------------------------------------------

function makeNote(id, patch = {}) {
  return {
    id,
    title: `笔记 ${id}`,
    type: "note",
    summary: "",
    updatedAt: "2026-10-01T00:00:00.000Z",
    trust: "high",
    ...patch,
  };
}

function renderNotes(notes) {
  const state = makeState();
  state.notes = notes;
  return renderDetail(state, { page: "detail", name: "标准", tab: "notes" }, { icons, fmtNumber });
}

test("资料状态筛选渲染全部/有失败/导入中，当前项高亮", () => {
  const all = render({ items: [makeDoc("a1")], total: 1, status: "" });
  assert.match(all, /data-docs-status=""/);
  assert.match(all, /data-docs-status="failed"/);
  assert.match(all, /data-docs-status="importing"/);
  assert.match(all, /class="seg active" data-action="docs-status" data-docs-status="" aria-pressed="true">全部/);
  assert.match(all, /class="seg" data-action="docs-status" data-docs-status="failed" aria-pressed="false">有失败/);

  const failed = render({ items: [makeDoc("f1")], total: 1, status: "failed" });
  assert.match(failed, /class="seg active" data-action="docs-status" data-docs-status="failed" aria-pressed="true">有失败/);

  const importing = render({ items: [makeDoc("i1")], total: 1, status: "importing" });
  assert.match(importing, /class="seg active" data-action="docs-status" data-docs-status="importing" aria-pressed="true">导入中/);

  // 非法状态回落到「全部」。
  const invalid = render({ items: [makeDoc("a1")], total: 1, status: "ready" });
  assert.match(invalid, /class="seg active" data-action="docs-status" data-docs-status="" aria-pressed="true">全部/);
});

test("状态筛选无结果时保留工具栏，可切回全部", () => {
  const failed = render({ total: 0, status: "failed" });
  assert.match(failed, /没有导入失败的资料/);
  assert.match(failed, /data-docs-query/);
  assert.match(failed, /data-docs-status=""/);
  assert.doesNotMatch(failed, /data-action="docs-page"/);

  const importing = render({ total: 0, status: "importing" });
  assert.match(importing, /没有导入中的资料/);

  const searched = render({ total: 0, query: "不存在的标准", status: "failed" });
  assert.match(searched, /没有匹配的资料/);
  assert.match(searched, /data-docs-clear/);
});

test("docsStatus 收敛合法值", () => {
  assert.deepEqual(DOCS_STATUSES, ["", "failed", "importing", "deleted"]);
  assert.equal(docsStatus("failed"), "failed");
  assert.equal(docsStatus(" importing "), "importing");
  assert.equal(docsStatus("deleted"), "deleted");
  assert.equal(docsStatus("ready"), "");
  assert.equal(docsStatus(undefined), "");
});

test("笔记 tab 渲染标题按钮、日期、摘要与总数", () => {
  const html = renderNotes({
    items: [
      makeNote("n1", { title: "继电保护摘要", summary: "第一条摘要" }),
      makeNote("n2", { title: "<img src=x onerror=alert(1)>", summary: "<b>粗体</b>" }),
    ],
    total: 2,
    loading: false,
    error: "",
  });
  assert.match(html, /共 2 篇/);
  assert.match(html, /data-action="open-note" data-id="n1"/);
  assert.match(html, /data-action="open-note" data-id="n2"/);
  assert.match(html, /继电保护摘要/);
  assert.match(html, /2026-10-01/);
  assert.match(html, /第一条摘要/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b&gt;粗体&lt;\/b&gt;/);
});

test("笔记 tab 的加载/空/错误状态", () => {
  const loading = renderNotes({ items: [], total: 0, loading: true, error: "" });
  assert.match(loading, /加载中…/);
  assert.doesNotMatch(loading, /还没有笔记/);

  const empty = renderNotes({ items: [], total: 0, loading: false, error: "" });
  assert.match(empty, /还没有笔记/);

  const failed = renderNotes({ items: [], total: 0, loading: false, error: "读取失败" });
  assert.match(failed, /读取失败/);
  assert.match(failed, /class="form-error"/);
});

test("笔记超过返回上限时提示仅显示前 N 篇", () => {
  const capped = renderNotes({
    items: [makeNote("n1"), makeNote("n2")],
    total: 350,
    loading: false,
    error: "",
  });
  assert.match(capped, /共 350 篇/);
  assert.match(capped, /仅显示前 2 篇（共 350 篇）/);

  const full = renderNotes({
    items: [makeNote("n1"), makeNote("n2")],
    total: 2,
    loading: false,
    error: "",
  });
  assert.doesNotMatch(full, /仅显示前/);
});

test("笔记摘要过长时截断", () => {
  const summary = "摘".repeat(200);
  const html = renderNotes({ items: [makeNote("n1", { summary })], total: 1, loading: false, error: "" });
  assert.match(html, /…/);
  assert.doesNotMatch(html, new RegExp(summary));
});

test("statusBadges 只渲染非零项并带完整拆分 title", () => {
  assert.equal(statusBadges({ docs: { ready: 3, importing: 0, failed: 0 } }), "");

  const importing = statusBadges({ docs: { ready: 3, importing: 2, failed: 0 } });
  assert.match(importing, /<span class="badge accent" title="成功 3 · 导入中 2 · 失败 0">导入中 2<\/span>/);
  assert.doesNotMatch(importing, /有失败/);

  const failed = statusBadges({ docs: { ready: 5, importing: 2, failed: 3 } });
  assert.match(failed, /<span class="badge warn" title="成功 5 · 导入中 2 · 失败 3">有失败 3<\/span>/);
  assert.match(failed, /导入中 2/);

  const interactive = statusBadges({ docs: { ready: 5, importing: 0, failed: 3 } }, { interactiveFailed: true });
  assert.match(interactive, /<button type="button" class="badge warn badge-action" data-action="docs-status" data-docs-status="failed" title="成功 5 · 导入中 0 · 失败 3">有失败 3<\/button>/);
});

test("详情页头把导入中和有失败拆成两个徽标，失败可点进筛选", () => {
  const state = makeState({ items: [makeDoc("a1")], total: 1 });
  state.detail.kb.docs = { ready: 5, importing: 2, failed: 3, notes: 0, deleted: 0 };
  const html = renderDetail(state, current, { icons, fmtNumber });
  assert.match(html, /导入中 2/);
  assert.match(html, /有失败 3/);
  assert.match(html, /title="成功 5 · 导入中 2 · 失败 3"/);
  assert.match(html, /data-action="docs-status" data-docs-status="failed"/);
});

test("总览卡片状态徽标保持只读", () => {
  const kb = {
    name: "标准",
    description: "",
    tags: [],
    docs: { ready: 5, importing: 2, failed: 3, notes: 0, deleted: 0 },
    pages: 10,
    chars: 100,
    types: {},
    trust: {},
    updatedAt: "2026-10-01T00:00:00.000Z",
    status: "warn",
  };
  const html = renderOverview({ kbs: [kb], filter: "all", query: "" }, { icons, fmtNumber });
  assert.match(html, /导入中 2/);
  assert.match(html, /<span class="badge warn" title="成功 5 · 导入中 2 · 失败 3">有失败 3<\/span>/);
  assert.doesNotMatch(html, /data-action="docs-status"/);
});

test("详情页头提供重命名入口，保留上传与归档", () => {
  const html = renderDetail(makeState(), current, { icons, fmtNumber });
  assert.match(html, /data-action="rename-kb-modal" data-name="标准"[^>]*>重命名<\/button>/);
  assert.match(html, /data-action="upload"/);
  assert.match(html, /data-action="archive-kb"/);
});

test("库详情页提供导入/导出入口，资料行可信度可内联修改", () => {
  const html = render({ items: [makeDoc("a1", { status: "ready" })], total: 1, offset: 0, limit: 50 });
  assert.match(html, /data-action="import-package"/);
  assert.match(html, /data-action="export-kb"[^>]*data-name="标准"/);
  assert.match(html, /data-action="docs-trust"/);
  assert.match(html, /data-id="a1"/);
  assert.match(html, /<option value="high" selected>高<\/option>/);
  const deleted = render({ items: [makeDoc("d1", { status: "deleted", deleted: true })], total: 1 });
  assert.doesNotMatch(deleted, /data-action="docs-trust"/);
});
