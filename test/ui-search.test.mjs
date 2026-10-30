/**
 * 检索页渲染与高亮纯函数：安全高亮必须只用文本节点 + <mark>，不得拼 HTML。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_TRUST_OPTIONS,
  SEARCH_TYPE_OPTIONS,
  applyHighlights,
  hasMore,
  highlightSegments,
  mergeResults,
  searchParamsOf,
  searchStateFromQuery,
  searchStatusLine,
} from "../ui/search-core.js";
import { renderSearch } from "../ui/views/search.js";

const icons = { search: "<svg></svg>", chevron: "" };
const fmtNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value) || 0);

function result(patch = {}) {
  return {
    kb: "标准",
    docId: "d1",
    title: "GB/T 19963.2-2024 风电场接入",
    standardNo: "GB/T 19963.2-2024",
    page: 12,
    clause: "5.2.2",
    snippet: "公共连接点电压偏差应不超过…",
    terms: ["电压偏差"],
    trust: "high",
    type: "pdf-text",
    tags: ["新能源"],
    hits: 3,
    deepLink: `/kb/?kb=${encodeURIComponent("标准")}&doc=d1&page=12&clause=5.2.2`,
    ...patch,
  };
}

function makeState(search = {}) {
  return {
    kbs: [
      { name: "标准", docs: { ready: 3 } },
      { name: "电能质量", docs: { ready: 1 } },
    ],
    search: {
      q: "", appliedQ: "", kb: "", tag: "", type: "", trust: "",
      results: [], total: 0, offset: 0, limit: 20, terms: [], engine: "",
      indexBuilding: false, note: "", tookMs: 0, estimated: false,
      facets: { tags: [], types: [], trust: [] },
      loading: false, loadingMore: false, error: "",
      ...search,
    },
  };
}

// ---------------------------------------------------------------------------
// 参数与 hash
// ---------------------------------------------------------------------------

test("searchStateFromQuery 归一 hash 条件", () => {
  assert.deepEqual(searchStateFromQuery({}), { q: "", kb: "", tag: "", type: "", trust: "" });
  assert.deepEqual(searchStateFromQuery({ q: "  电压 ", kb: "标准", trust: "high" }), {
    q: "电压", kb: "标准", tag: "", type: "", trust: "high",
  });
  assert.equal(searchStateFromQuery({ trust: "HIGH" }).trust, "", "非法 trust 回落为空");
});

test("searchParamsOf 跳过空值、q 放最后并 trim", () => {
  assert.equal(searchParamsOf({}), "");
  assert.equal(
    searchParamsOf({ q: "  电压  ", kb: "标准", tag: "并网", type: "pdf-text", trust: "high" }),
    `kb=${encodeURIComponent("标准")}&tag=${encodeURIComponent("并网")}&type=pdf-text&trust=high&q=${encodeURIComponent("电压")}`,
  );
  assert.equal(searchParamsOf({ q: "", kb: "", tag: "", type: "", trust: "" }), "");
});

// ---------------------------------------------------------------------------
// 高亮
// ---------------------------------------------------------------------------

test("highlightSegments 切出命中与未命中片段", () => {
  const segments = highlightSegments("电压偏差和电压暂降", ["电压"]);
  assert.deepEqual(segments, [
    { text: "电压", hit: true },
    { text: "偏差和", hit: false },
    { text: "电压", hit: true },
    { text: "暂降", hit: false },
  ]);
});

test("highlightSegments 大小写不敏感、保留原文大小写", () => {
  const segments = highlightSegments("GB/T 19963 风电场", ["gb/t 19963"]);
  assert.deepEqual(segments, [
    { text: "GB/T 19963", hit: true },
    { text: " 风电场", hit: false },
  ]);
});

test("highlightSegments 重叠命中取最长、不嵌套", () => {
  const segments = highlightSegments("电压偏差限值", ["电压偏差", "偏差"]);
  assert.deepEqual(segments, [
    { text: "电压偏差", hit: true },
    { text: "限值", hit: false },
  ]);
});

test("highlightSegments 无命中/空文本/空词", () => {
  assert.deepEqual(highlightSegments("电压偏差", []), [{ text: "电压偏差", hit: false }]);
  assert.deepEqual(highlightSegments("", ["电压"]), []);
  assert.deepEqual(highlightSegments("电压偏差", ["", "  "]), [{ text: "电压偏差", hit: false }]);
});

test("highlightSegments 把正则元字符当字面量", () => {
  const segments = highlightSegments("限值 5.2.2 条款", ["5.2.2"]);
  assert.deepEqual(segments, [
    { text: "限值 ", hit: false },
    { text: "5.2.2", hit: true },
    { text: " 条款", hit: false },
  ]);
});

function fakeDocument() {
  const created = [];
  return {
    created,
    createTextNode(text) {
      const node = { kind: "text", text };
      created.push(node);
      return node;
    },
    createElement(tag) {
      const node = {
        kind: "element",
        tag,
        children: [],
        appendChild(child) { this.children.push(child); },
      };
      created.push(node);
      return node;
    },
  };
}

function flatten(node) {
  if (node.kind === "text") return node.text;
  return node.children.map(flatten).join("");
}

test("applyHighlights 只用文本节点与 mark，文本不丢不改", () => {
  const doc = fakeDocument();
  const container = { children: [], appendChild(node) { this.children.push(node); } };
  const marks = applyHighlights(doc, container, "电压偏差和电压暂降", ["电压"]);
  assert.equal(marks, 2);
  assert.equal(container.children.length, 4);
  assert.deepEqual(container.children.map((node) => node.kind), ["element", "text", "element", "text"]);
  assert.equal(container.children[0].tag, "mark");
  assert.equal(container.children[0].children[0].text, "电压");
  assert.equal(container.children[1].text, "偏差和");
  const highlighted = doc.created.filter((node) => node.kind === "element");
  assert.equal(highlighted.length, 2);
  assert.equal(highlighted[0].tag, "mark");
  assert.equal(highlighted[0].children[0].text, "电压");
  assert.equal(container.children.map(flatten).join(""), "电压偏差和电压暂降");
});

test("applyHighlights 对脚本片段只当文本（不会变成元素）", () => {
  const doc = fakeDocument();
  const container = { children: [], appendChild(node) { this.children.push(node); } };
  const evil = "<img src=x onerror=alert(1)> 电压偏差";
  applyHighlights(doc, container, evil, ["电压偏差"]);
  assert.equal(container.children.map(flatten).join(""), evil);
  assert.equal(doc.created.filter((node) => node.kind === "element").every((node) => node.tag === "mark"), true);
});

// ---------------------------------------------------------------------------
// 状态行与合并
// ---------------------------------------------------------------------------

test("searchStatusLine 组合命中数、引擎、耗时与提示", () => {
  assert.equal(searchStatusLine({ total: 12, engine: "fts", tookMs: 34 }), "命中 12 篇 · 条款索引 · 34ms");
  assert.equal(
    searchStatusLine({ total: 3, engine: "rg", tookMs: 120, estimated: true }),
    "命中 3 篇 · 全文回退 · 120ms · 结果为预计值",
  );
  assert.equal(
    searchStatusLine({ total: 0, engine: "fts", tookMs: 5, note: "索引构建中" }),
    "命中 0 篇 · 条款索引 · 5ms · 索引构建中",
  );
  assert.equal(searchStatusLine({ total: 0, engine: "none", tookMs: 0 }), "命中 0 篇");
});

test("hasMore 与 mergeResults", () => {
  assert.equal(hasMore({ total: 40, offset: 0, results: new Array(20) }), true);
  assert.equal(hasMore({ total: 20, offset: 0, results: new Array(20) }), false);
  assert.equal(hasMore({ total: 0, offset: 0, results: [] }), false);
  const merged = mergeResults(
    [result({ docId: "d1" }), result({ docId: "d2" })],
    [result({ docId: "d2" }), result({ docId: "d3" })],
  );
  assert.deepEqual(merged.map((item) => item.docId), ["d1", "d2", "d3"]);
});

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

test("未输入时显示示例词与检索框", () => {
  const html = renderSearch(makeState(), { icons, fmtNumber });
  assert.match(html, /data-search-query/);
  assert.match(html, /搜索正文与条款/);
  assert.match(html, /电压偏差/);
  assert.match(html, /GB\/T 19963/);
  assert.match(html, /data-search-kb/);
  assert.match(html, /data-search-trust/);
});

test("加载中 / 错误 / 无结果各有独立状态", () => {
  const loading = renderSearch(makeState({ q: "电压", appliedQ: "电压", loading: true }), { icons, fmtNumber });
  assert.match(loading, /正在检索/);
  const failed = renderSearch(makeState({ q: "电压", appliedQ: "电压", error: "检索失败" }), { icons, fmtNumber });
  assert.match(failed, /检索失败/);
  assert.match(failed, /data-search-retry/);
  const none = renderSearch(makeState({ q: "电压", appliedQ: "电压", total: 0 }), { icons, fmtNumber });
  assert.match(none, /没有匹配/);
  assert.match(none, /data-search-clear/);
});

test("结果卡片包含标题、标准号、条款、页码、可信度、命中数与深链", () => {
  const state = makeState({
    q: "电压偏差", appliedQ: "电压偏差", total: 1, engine: "fts", tookMs: 12,
    results: [result()],
  });
  const html = renderSearch(state, { icons, fmtNumber });
  assert.match(html, /GB\/T 19963\.2-2024 风电场接入/);
  assert.match(html, /GB\/T 19963\.2-2024/);
  assert.match(html, /第 5\.2\.2 条/);
  assert.match(html, /第 12 页/);
  assert.match(html, /命中 3 条条款/);
  assert.match(html, /高可信度|高/);
  assert.match(html, /data-kb="标准"/);
  assert.match(html, /data-id="d1"/);
  assert.match(html, /data-page="12"/);
  assert.ok(html.includes(`href="/kb/?kb=${encodeURIComponent("标准")}&amp;doc=d1&amp;page=12&amp;clause=5.2.2"`), "深链应被转义");
  assert.match(html, /data-hl="0"/, "摘要容器必须由高亮步骤填充");
  assert.match(html, /data-search-index="0"/, "卡片要带结果下标，供预览取 terms");
  assert.ok(!html.includes("公共连接点电压偏差应不超过"), "摘要正文不能直接拼进 HTML");
  assert.match(html, /命中 1 篇 · 条款索引 · 12ms/);
});

test("卡片转义标题与摘要占位，裂开标签不会变成 HTML", () => {
  const state = makeState({
    q: "电压", appliedQ: "电压", total: 1,
    results: [result({ title: `<img src=x onerror="alert(1)">`, snippet: "" })],
  });
  const html = renderSearch(state, { icons, fmtNumber });
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(!html.includes("<img src=x"));
});

test("缺少页码/条款/标准号时不渲染空字段", () => {
  const state = makeState({
    q: "笔记", appliedQ: "笔记", total: 1,
    results: [result({ standardNo: "", page: null, clause: "", hits: 1, type: "note" })],
  });
  const html = renderSearch(state, { icons, fmtNumber });
  assert.ok(!html.includes("第 null 页"));
  assert.ok(!html.includes("第  条"));
  assert.match(html, /笔记/);
});

test("加载更多按钮按 remaining 显示，全部显示时不出现", () => {
  const more = renderSearch(makeState({
    q: "电压", appliedQ: "电压", total: 40, results: [result()], offset: 0, limit: 20,
  }), { icons, fmtNumber });
  assert.match(more, /data-search-more/);
  assert.match(more, /还有 39 篇/);
  const done = renderSearch(makeState({
    q: "电压", appliedQ: "电压", total: 1, results: [result()],
  }), { icons, fmtNumber });
  assert.ok(!done.includes("data-search-more"));
});

test("过滤控件回显当前条件，标签选项来自 facets", () => {
  const state = makeState({
    q: "电压", appliedQ: "电压", total: 1, kb: "标准", tag: "新能源", type: "pdf-text", trust: "high",
    results: [result()],
    facets: { tags: [{ name: "新能源", count: 3 }, { name: "并网", count: 1 }], types: [], trust: [] },
  });
  const html = renderSearch(state, { icons, fmtNumber });
  assert.match(html, /<option value="标准" selected/);
  assert.match(html, /<option value="新能源" selected/);
  assert.match(html, /<option value="pdf-text" selected/);
  assert.match(html, /<option value="high" selected/);
  assert.match(html, /data-search-clear/);
});

test("可信度与类型选项表覆盖接口取值", () => {
  assert.deepEqual(SEARCH_TRUST_OPTIONS.map((item) => item.value), ["", "high", "medium", "low", "unknown"]);
  assert.ok(SEARCH_TYPE_OPTIONS.some((item) => item.value === "pdf-scanned"));
  assert.ok(SEARCH_TYPE_OPTIONS.some((item) => item.value === "note"));
});
