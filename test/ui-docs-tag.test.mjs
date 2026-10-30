/**
 * 资料页标签筛选：工具栏 select/当前 chip/行内标签/空态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderDetail } from "../ui/views/detail.js";

const icons = { upload: "", archive: "", search: "", chevron: "", database: "" };
const fmtNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
const current = { page: "detail", name: "标准", tab: "docs" };

function makeDoc(id, tags = []) {
  return {
    id, title: `资料 ${id}`, type: "pdf-text", pages: 1, trust: "high",
    status: "ready", updatedAt: "2026-10-01T00:00:00.000Z", tags,
  };
}
function makeState(docs = {}) {
  return {
    detailLoading: false,
    detailError: "",
    detail: {
      kb: { name: "标准", status: "ok", description: "", docs: { ready: 1, importing: 0, failed: 0, notes: 0, deleted: 0 }, pages: 1, chars: 10, updatedAt: "" },
      health: { failed: 0, importing: 0, lowConfidenceDocs: 0, corruptedDocs: 0, hasSchema: true },
      recentDocs: [], logTail: "",
    },
    docs: {
      items: [], total: 0, offset: 0, limit: 50, query: "", appliedQuery: "", status: "",
      tag: "", facets: { tags: [] }, selected: [], busy: false, retrying: [], ...docs,
    },
  };
}
function render(docs) {
  return renderDetail(makeState(docs), current, { icons, fmtNumber });
}

test("知识库标签显示在库名右侧", () => {
  const state = makeState();
  state.detail.kb.tags = ["国家标准", "电能质量"];
  const html = renderDetail(state, current, { icons, fmtNumber });
  assert.match(html, /<h1>标准<\/h1>[\s\S]{0,400}class="kb-tags"/);
  assert.match(html, /<span class="tag">国家标准<\/span>/);
  assert.match(html, /<span class="tag">电能质量<\/span>/);
});

test("标签 select 渲染 facets 并选中当前标签", () => {
  const html = render({
    items: [makeDoc("a", ["并网"])], total: 1,
    tag: "并网",
    facets: { tags: [{ name: "并网", count: 3 }, { name: "继电保护", count: 1 }] },
  });
  assert.match(html, /data-docs-tag/);
  assert.match(html, /<option value="">全部标签<\/option>/);
  assert.match(html, /<option value="并网" selected>并网（3）<\/option>/);
  assert.match(html, /标签：并网 ×/);
});

test("行内标签可点击并只显示前 3 个 +N", () => {
  const html = render({
    items: [makeDoc("a", ["一", "二", "三", "四", "五"])], total: 1,
    tag: "二",
    facets: { tags: [{ name: "二", count: 1 }] },
  });
  assert.match(html, /data-action="docs-tag" data-tag="一"/);
  assert.match(html, /data-action="docs-tag" data-tag="二"/);
  assert.match(html, /class="tag active"/);
  assert.match(html, />\+2<\/span>/);
  assert.doesNotMatch(html, /data-tag="四"/);
});

test("标签筛选无结果显示清除标签", () => {
  const html = render({ total: 0, tag: "不存在", facets: { tags: [{ name: "不存在", count: 0 }] } });
  assert.match(html, /没有匹配该标签的资料/);
  assert.match(html, /data-action="docs-tag-clear"/);
});

test("没有标签时仍保留搜索和分页工具栏，不渲染空 select", () => {
  const html = render({ items: [makeDoc("a")], total: 1, facets: { tags: [] } });
  assert.match(html, /data-docs-query/);
  assert.doesNotMatch(html, /data-docs-tag/);
});
