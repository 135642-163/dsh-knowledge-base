/**
 * 总览库卡片：类型构成条 + 可信度圆点图例（0.23.0 Task 4，方案 B）。
 * 卡片只保留一条横向条；可信度不再画比例条。
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

function makeKb(patch = {}) {
  return {
    name: "标准",
    description: "现行标准",
    tags: [],
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

function render(kbs) {
  return renderOverview({ kbs, filter: "all", query: "" }, { icons, fmtNumber });
}

function segments(html) {
  return [...html.matchAll(/<i style="width:([\d.]+)%;background:(#[0-9a-f]{6})"><\/i>/g)]
    .map((match) => ({ width: Number(match[1]), color: match[2] }));
}

function trustDots(html) {
  return [...html.matchAll(
    /<span class="trust-dot" title="([^"]+)" aria-label="([^"]+)"><span class="trust-dot-mark" style="color:(#[0-9a-f]{6})" aria-hidden="true">●<\/span>([\d]+)<\/span>/g,
  )].map((match) => ({ title: match[1], ariaLabel: match[2], color: match[3], count: Number(match[4]) }));
}

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return readFileSync(new URL("../ui/style.css", import.meta.url), "utf8")
    .match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

test("每张卡片只有一条类型构成条，不再渲染可信度比例条", () => {
  const html = render([makeKb()]);
  assert.equal((html.match(/<div class="bar[^"]*"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /class="bar thin/);
  assert.doesNotMatch(html, /<div class="bar[^"]*"[^>]*title="可信度/);
  assert.match(html, /class="trust-dots"/);
});

test("类型条只为非零类型渲染分段，宽度合计 100%", () => {
  const html = render([makeKb({
    types: { "pdf-scanned": 3, docx: 2, "pdf-text": 1, markdown: 0 },
  })]);
  const bars = segments(html);
  assert.equal(bars.length, 3);
  assert.ok(Math.abs(bars.reduce((sum, bar) => sum + bar.width, 0) - 100) < 1e-6);
  assert.deepEqual(bars.map((bar) => bar.color), ["#5f7fb8", "#7aa2d0", "#7f96c9"]);
  // 零计数类型既不占分段，也不出现在 title 里。
  assert.doesNotMatch(html, /markdown 0/);
});

test("类型条使用低饱和同族配色，不再出现旧的饱和色", () => {
  const html = render([makeKb()]);
  for (const color of ["#5f7fb8", "#7f96c9", "#7aa2d0"]) assert.ok(html.includes(color), color);
  for (const stale of ["#6b8afd", "#3f5fd6", "#8ea6ff", "#3b82f6", "#f59e0b", "#10b981", "#a855f7", "#14b8a6", "#64748b", "#cbd5e1"]) {
    assert.ok(!html.includes(stale), `旧配色仍在渲染：${stale}`);
  }
});

test("全部类型都映射到低饱和色，未知类型回落到灰色", () => {
  const all = render([makeKb({
    types: {
      "pdf-scanned": 1, "pdf-text": 1, "pdf-mixed": 1, docx: 1, pptx: 1, markdown: 1,
      note: 1, epub: 1, mobi: 1, text: 1, pdf: 1, unknown: 1,
    },
  })]);
  for (const color of ["#5f7fb8", "#7f96c9", "#a3b6d9", "#7aa2d0", "#c9a36a", "#7fae9a", "#a48bc4", "#6fb3aa", "#93a3b8", "#8a9bb5", "#b8c0cc"]) {
    assert.ok(all.includes(`background:${color}`), color);
  }
  assert.equal(segments(all).length, 12);

  const fallback = render([makeKb({ types: { xlsx: 2 } })]);
  assert.deepEqual(segments(fallback).map((bar) => bar.color), ["#b8c0cc"]);
});

test("类型条 title / aria-label 列出非零类型与数量", () => {
  const html = render([makeKb({ types: { "pdf-scanned": 3, docx: 2, "pdf-text": 1 } })]);
  assert.match(html, /title="类型 pdf-scanned 3 · docx 2 · pdf-text 1"/);
  assert.match(html, /aria-label="类型 pdf-scanned 3 · docx 2 · pdf-text 1"/);
  assert.match(html, /role="img"/);
});

test("可信度圆点只渲染非零项，数量、颜色与完整 title 正确", () => {
  const html = render([makeKb({ trust: { high: 3, medium: 2, low: 1, unknown: 0 } })]);
  const dots = trustDots(html);
  assert.equal(dots.length, 3);
  assert.deepEqual(dots.map((dot) => dot.title), ["高 3", "中 2", "低 1"]);
  assert.deepEqual(dots.map((dot) => dot.ariaLabel), ["可信度：高 3", "可信度：中 2", "可信度：低 1"]);
  assert.deepEqual(dots.map((dot) => dot.color), ["#4f9d69", "#c9a36a", "#b96a6a"]);
  assert.deepEqual(dots.map((dot) => dot.count), [3, 2, 1]);
  // 整行 title 保留全部四档（含零值），方便 hover 看完整拆分。
  assert.match(html, /class="trust-dots" title="可信度：高 3 · 中 2 · 低 1 · 未知 0"/);
  assert.doesNotMatch(html, /title="未知 0"/);
});

test("未知可信度非零时使用灰色圆点", () => {
  const html = render([makeKb({ trust: { high: 1, medium: 0, low: 0, unknown: 4 } })]);
  const dots = trustDots(html);
  assert.equal(dots.length, 2);
  assert.deepEqual(dots.map((dot) => dot.title), ["高 1", "未知 4"]);
  assert.equal(dots[1].color, "#93a3b8");
  assert.match(html, /title="可信度：高 1 · 中 0 · 低 0 · 未知 4"/);
});

test("可信度全为零时不渲染空行", () => {
  const html = render([makeKb({ trust: { high: 0, medium: 0, low: 0, unknown: 0 } })]);
  assert.doesNotMatch(html, /trust-dots|trust-dot\b/);
  assert.doesNotMatch(html, /可信度/);
});

test("空库卡片显示空库徽标和中性占位类型条", () => {
  const html = render([makeKb({
    status: "empty",
    docs: { total: 0, ready: 0, importing: 0, failed: 0, deleted: 0, notes: 0 },
    pages: 0,
    chars: 0,
    types: {},
    trust: {},
    updatedAt: null,
  })]);
  assert.match(html, /<span class="badge">空库<\/span>/);
  assert.match(html, /<div class="bar empty" role="img" aria-label="暂无文档类型" title="暂无文档类型"><i><\/i><\/div>/);
  assert.equal(segments(html).length, 0);
  assert.doesNotMatch(html, /trust-dots/);
  assert.doesNotMatch(html, /bar thin/);
});

test("空类型但可信度非零时仍是空条且不显示比例条", () => {
  const html = render([makeKb({ types: { docx: 0 }, trust: { high: 2 } })]);
  assert.match(html, /<div class="bar empty"/);
  assert.equal(segments(html).length, 0);
  assert.equal(trustDots(html).length, 1);
  assert.equal((html.match(/<div class="bar[^"]*"/g) ?? []).length, 1);
});

test("知识库名称在标题与 data-name 中均转义", () => {
  const html = render([makeKb({ name: '<img src=x onerror=alert(1)>' })]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-name="&lt;img src=x onerror=alert\(1\)&gt;"/);
});

test("样式约定：透明条、2px 间距、胶囊分段与中性空条", () => {
  const bar = cssRule(".bar");
  assert.match(bar, /gap:\s*2px/);
  assert.match(bar, /height:\s*8px/);
  assert.match(bar, /width:\s*100%/);
  assert.match(bar, /background:\s*transparent/);
  assert.match(cssRule(".bar i"), /border-radius:\s*999px/);
  assert.match(cssRule(".bar i"), /height:\s*100%/);
  assert.match(cssRule(".bar.empty i"), /background:\s*var\(--line\)/);
  assert.doesNotMatch(readFileSync(new URL("../ui/style.css", import.meta.url), "utf8"), /\.bar\.thin/);
});
