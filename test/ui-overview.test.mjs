/**
 * 总览：文件类型汇总在页头「概览」，卡片只保留可信度条；标签提到简介下方。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderOverview } from "../ui/views/overview.js";

const icons = {
  search: '<svg data-icon="search"></svg>',
  chevron: '<svg data-icon="chevron"></svg>',
  database: '<svg data-icon="database"></svg>',
};
const fmtNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
const TRUST_COLORS = ["#4f9d69", "#c9a36a", "#b96a6a", "#93a3b8"];

function makeKb(patch = {}) {
  return {
    name: "标准",
    description: "现行标准",
    tags: ["国家标准", "电能质量"],
    docs: { total: 6, ready: 4, importing: 1, failed: 1, deleted: 0, notes: 2 },
    pages: 1200,
    chars: 34500,
    types: { "pdf-scanned": 3, docx: 2, "pdf-text": 1 },
    trust: { high: 3, medium: 2, low: 1, unknown: 0 },
    updatedAt: "2026-10-01T00:00:00.000Z",
    status: "ok",
    ...patch,
  };
}

function render(kbs, extra = {}) {
  return renderOverview({ kbs, filter: "all", query: "", ...extra }, { icons, fmtNumber });
}

function segments(html) {
  return [...html.matchAll(/<i style="width:([\d.]+)%;background:(#[0-9a-f]{6})"><\/i>/g)]
    .map((match) => ({ width: Number(match[1]), color: match[2] }));
}

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return readFileSync(new URL("../ui/style.css", import.meta.url), "utf8")
    .match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

test("总览不再显示文件类型；标签行无论有无标签都占位，保证彩色条对齐", () => {
  const html = render([
    makeKb({ name: "标准", tags: ["国家标准", "电能质量"] }),
    makeKb({ name: "历史", tags: [] }),
  ]);
  assert.doesNotMatch(html, /overview-types/);
  assert.doesNotMatch(html, /<p class="muted">类型：/);
  assert.equal((html.match(/class="tag-row"/g) ?? []).length, 2, "每张卡片都保留标签行");
  assert.match(html, /<div class="tag-row"><span class="tag">国家标准<\/span>/);
  assert.match(html, /<div class="tag-row"><\/div>/, "无标签时也渲染空行占位");
  assert.match(cssRule(".tag-row"), /min-height:\s*20px/);
  assert.match(html, /placeholder="搜索名称、简介或标签"/);
});

test("卡片彩色条画可信度；标签移到简介下方，底部只留更新时间", () => {
  const html = render([makeKb()]);
  const bars = segments(html);
  assert.equal(bars.length, 3);
  assert.deepEqual(bars.map((bar) => bar.color), TRUST_COLORS.slice(0, 3));
  assert.ok(Math.abs(bars.reduce((sum, bar) => sum + bar.width, 0) - 100) < 1e-6);
  assert.match(html, /title="可信度：高 3 · 中 2 · 低 1 · 未知 0"/);
  assert.doesNotMatch(html, /trust-dots|trust-dot\b/);
  assert.match(html, /<div class="tag-row"><span class="tag">国家标准<\/span><span class="tag">电能质量<\/span><\/div>/);
  assert.match(html, /<div class="card-foot muted">\s*<span>更新/);
  assert.doesNotMatch(html, /card-foot[\s\S]{0,200}class="tag"/);
});

test("可信度四档都非零时四段，颜色与数量对应", () => {
  const html = render([makeKb({ trust: { high: 1, medium: 2, low: 3, unknown: 4 } })]);
  const bars = segments(html);
  assert.equal(bars.length, 4);
  assert.deepEqual(bars.map((bar) => bar.color), TRUST_COLORS);
  assert.deepEqual(bars.map((bar) => Math.round(bar.width)), [10, 20, 30, 40]);
  assert.match(html, /title="可信度：高 1 · 中 2 · 低 3 · 未知 4"/);
});

test("可信度为零：中性空条；标签与简介仍在", () => {
  const html = render([makeKb({ trust: {} })]);
  assert.match(html, /<div class="bar empty" role="img" aria-label="暂无可信度" title="暂无可信度"><i><\/i><\/div>/);
  assert.equal(segments(html).length, 0);
  assert.match(html, /class="tag-row"/);
});

test("标签超过 3 个折叠为 +N，title 列出全部", () => {
  const html = render([makeKb({ tags: ["一", "二", "三", "四", "五"] })]);
  assert.match(html, /<span class="tag">一<\/span><span class="tag">二<\/span><span class="tag">三<\/span>/);
  assert.match(html, /<span class="tag-more" title="一、二、三、四、五">\+2<\/span>/);
});

test("空库：空库徽标 + 空可信度条，不渲染标签行", () => {
  const html = render([makeKb({
    status: "empty",
    tags: [],
    docs: { total: 0, ready: 0, importing: 0, failed: 0, deleted: 0, notes: 0 },
    pages: 0,
    chars: 0,
    types: {},
    trust: {},
    updatedAt: null,
  })]);
  assert.match(html, /<span class="badge">空库<\/span>/);
  assert.match(html, /class="bar empty"/);
  assert.equal(segments(html).length, 0);
  assert.match(html, /<div class="tag-row"><\/div>/, "空库也保留标签行占位");
});

test("知识库名称与标签都做 HTML 转义", () => {
  const html = render([makeKb({ name: '<img src=x onerror=alert(1)>', tags: ["<x>"] })]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<span class="tag">&lt;x&gt;<\/span>/);
});

test("样式约定：可信度条连续、类型概览/标签行各就各位、hidden 生效", () => {
  const css = readFileSync(new URL("../ui/style.css", import.meta.url), "utf8");
  const bar = cssRule(".bar");
  assert.match(bar, /display:\s*flex/);
  assert.match(bar, /gap:\s*0/);
  assert.match(bar, /height:\s*8px/);
  assert.match(bar, /border-radius:\s*999px/);
  assert.match(bar, /overflow:\s*hidden/);
  const segment = cssRule(".bar i");
  assert.match(segment, /height:\s*100%/);
  assert.match(segment, /border-radius:\s*0/);
  assert.match(cssRule(".bar.empty i"), /background:\s*var\(--line\)/);
  assert.match(cssRule(".tag-row"), /display:\s*flex/);
  assert.match(cssRule(".tag-row"), /min-height:\s*20px/);
  assert.doesNotMatch(css, /\.overview-types/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test("总览页只读展示知识库根目录", () => {
  const html = render([makeKb()], { server: { kbRoot: "/srv/知识库" } });
  assert.match(html, /class="muted root-line"/);
  assert.match(html, /知识库根目录/);
  assert.match(html, /<code class="root-path" title="[^"]*kbRoot[^"]*">\/srv\/知识库<\/code>/);
  assert.match(render([], { server: { kbRoot: "/srv/知识库" } }), /class="root-path"/);
});
