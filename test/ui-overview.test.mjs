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

function render(kbs, extra = {}) {
  return renderOverview({ kbs, filter: "all", query: "", ...extra }, { icons, fmtNumber });
}

function segments(html) {
  return [...html.matchAll(/<i style="width:([\d.]+)%;background:(#[0-9a-f]{6})"><\/i>/g)]
    .map((match) => ({ width: Number(match[1]), color: match[2] }));
}

function trustDots(html) {
  return [...html.matchAll(
    /<span class="trust-dot" role="img" title="([^"]+)" aria-label="([^"]+)"><span class="trust-dot-mark" style="color:(#[0-9a-f]{6})" aria-hidden="true">●<\/span>([\d]+)<\/span>/g,
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
  assert.deepEqual(bars.map((bar) => bar.color), ["#4f7fc0", "#4f86c6", "#6fa0d8"]);
  // 分段首尾相接，标记之间没有空白或间隔元素。
  assert.match(html, /<\/i><i style="width:/);
  // 零计数类型既不占分段，也不出现在 title 里。
  assert.doesNotMatch(html, /markdown 0/);
});

test("类型条使用更丰富的配色并包含暖色", () => {
  const html = render([makeKb({
    types: {
      "pdf-scanned": 1, "pdf-text": 1, "pdf-mixed": 1, docx: 1, pptx: 1, xlsx: 1,
      markdown: 1, note: 1, epub: 1, mobi: 1, text: 1, pdf: 1, doc: 1,
    },
  })]);
  const colors = [
    "#4f7fc0", "#6fa0d8", "#93b3dd", "#4f86c6", "#e0a33e", "#d07a3f",
    "#4f9d69", "#a26bc4", "#3fa39a", "#93a3b8", "#6b7f9e", "#c26a6a",
  ];
  for (const color of colors) assert.ok(html.includes(`background:${color}`), color);
  // 至少出现一个暖色（琥珀/橙/红），避免整条色带只有冷色。
  assert.ok(["#e0a33e", "#d07a3f", "#c26a6a"].some((color) => html.includes(`background:${color}`)));
  for (const stale of ["#5f7fb8", "#7f96c9", "#a3b6d9", "#7aa2d0", "#7fae9a", "#a48bc4", "#6fb3aa", "#8a9bb5"]) {
    assert.ok(!html.includes(stale), `旧配色仍在渲染：${stale}`);
  }
});

test("全部类型都映射到配色，未知类型回落到灰色", () => {
  const all = render([makeKb({
    types: {
      "pdf-scanned": 1, "pdf-text": 1, "pdf-mixed": 1, docx: 1, pptx: 1, xlsx: 1,
      markdown: 1, note: 1, epub: 1, mobi: 1, text: 1, pdf: 1, doc: 1, unknown: 1,
    },
  })]);
  for (const color of [
    "#4f7fc0", "#6fa0d8", "#93b3dd", "#4f86c6", "#e0a33e", "#d07a3f",
    "#4f9d69", "#a26bc4", "#3fa39a", "#93a3b8", "#6b7f9e", "#c26a6a", "#b8c0cc",
  ]) {
    assert.ok(all.includes(`background:${color}`), color);
  }
  assert.equal(segments(all).length, 14);

  const fallback = render([makeKb({ types: { video: 2 } })]);
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
  assert.match(html, /class="trust-dots" role="group" title="可信度：高 3 · 中 2 · 低 1 · 未知 0"/);
  assert.doesNotMatch(html, /title="未知 0"/);
  // 圆点行是一个组合，单项是带 aria-label 的图像语义。
  assert.equal((html.match(/class="trust-dot" role="img"/g) ?? []).length, 3);
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

test("样式约定：连续条形（无间隙、父级圆角裁剪）与中性空条", () => {
  const css = readFileSync(new URL("../ui/style.css", import.meta.url), "utf8");
  const bar = cssRule(".bar");
  assert.match(bar, /display:\s*flex/);
  assert.match(bar, /gap:\s*0/);
  assert.match(bar, /height:\s*8px/);
  assert.match(bar, /width:\s*100%/);
  assert.match(bar, /background:\s*var\(--panel-2\)/);
  assert.match(bar, /border-radius:\s*999px/);
  assert.match(bar, /overflow:\s*hidden/);
  // 分段是连续色块：自身不圆角，由父级 overflow:hidden + 圆角裁剪两端。
  const segment = cssRule(".bar i");
  assert.match(segment, /height:\s*100%/);
  assert.match(segment, /border-radius:\s*0/);
  assert.match(cssRule(".bar.empty i"), /width:\s*100%/);
  assert.match(cssRule(".bar.empty i"), /background:\s*var\(--line\)/);
  assert.doesNotMatch(css, /\.bar\.thin/);
  assert.doesNotMatch(bar, /gap:\s*2px/);
});

test("总览页只读展示知识库根目录", () => {
  const html = render([makeKb()], { server: { kbRoot: "/srv/知识库" } });
  assert.match(html, /class="muted root-line"/);
  assert.match(html, /知识库根目录/);
  assert.match(html, /<code class="root-path" title="[^"]*kbRoot[^"]*">\/srv\/知识库<\/code>/);
  // 空库时也保留根目录行：用户正是靠它确认配置生效。
  assert.match(render([], { server: { kbRoot: "/srv/知识库" } }), /class="root-path"/);
});

test("没有服务信息或根目录为空时不渲染根目录行", () => {
  assert.doesNotMatch(render([makeKb()]), /root-line/);
  assert.doesNotMatch(render([makeKb()], { server: { kbRoot: "  " } }), /root-line/);
});

test("根目录路径做 HTML 转义", () => {
  const html = render([], { server: { kbRoot: `/tmp/<x>&"` } });
  assert.match(html, /\/tmp\/&lt;x&gt;&amp;&quot;/);
  assert.doesNotMatch(html, /\/tmp\/<x>/);
});

test("根目录行样式：等宽、可换行、不溢出面板", () => {
  assert.match(cssRule(".root-line"), /flex-wrap:\s*wrap/);
  assert.match(cssRule(".root-path"), /font-family:\s*ui-monospace/);
  assert.match(cssRule(".root-path"), /word-break:\s*break-all/);
});
