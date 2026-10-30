/**
 * 总览库卡片：可信度构成条 + 圆点图例；文件类型退到概括行（0.31.4）。
 * 用户更关注「资料可信度」，彩色条改画可信度。
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

test("彩色条画可信度：颜色按高/中/低，宽度按占比，类型移到概括行", () => {
  const html = render([makeKb()]);
  const bars = segments(html);
  assert.equal(bars.length, 3);
  assert.deepEqual(bars.map((bar) => bar.color), [TRUST_COLORS[0], TRUST_COLORS[1], TRUST_COLORS[2]]);
  assert.ok(Math.abs(bars.reduce((sum, bar) => sum + bar.width, 0) - 100) < 1e-6);
  assert.deepEqual(bars.map((bar) => Math.round(bar.width)), [50, 33, 17]);
  assert.match(html, /class="bar" role="img" title="可信度：高 3 · 中 2 · 低 1 · 未知 0"/);
  assert.doesNotMatch(html, /title="类型/);
  // 类型改为概括行的一行小字
  assert.match(html, /<p class="type-line muted">类型：pdf-scanned 3 · docx 2 · pdf-text 1<\/p>/);
  // 每张卡片只有一条彩色条
  assert.equal((html.match(/<div class="bar[^"]*"/g) ?? []).length, 1);
});

test("可信度四档都非零时四段，颜色与数量对应", () => {
  const html = render([makeKb({ trust: { high: 1, medium: 2, low: 3, unknown: 4 } })]);
  const bars = segments(html);
  assert.equal(bars.length, 4);
  assert.deepEqual(bars.map((bar) => bar.color), TRUST_COLORS);
  assert.deepEqual(bars.map((bar) => Math.round(bar.width)), [10, 20, 30, 40]);
  assert.match(html, /title="可信度：高 1 · 中 2 · 低 3 · 未知 4"/);
});

test("可信度全为零：中性空条、无圆点图例，类型行仍然展示", () => {
  const html = render([makeKb({ trust: {}, types: { docx: 2 } })]);
  assert.match(html, /<div class="bar empty" role="img" aria-label="暂无可信度" title="暂无可信度"><i><\/i><\/div>/);
  assert.equal(segments(html).length, 0);
  assert.doesNotMatch(html, /trust-dots/);
  assert.match(html, /类型：docx 2/);
});

test("空库：空库徽标 + 空可信度条，不渲染类型行与可信度图例", () => {
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
  assert.match(html, /class="bar empty"/);
  assert.equal(segments(html).length, 0);
  assert.doesNotMatch(html, /trust-dots|class="type-line"/);
});

test("类型计数为 0 不进入概括行", () => {
  const html = render([makeKb({ types: { docx: 2, markdown: 0 } })]);
  assert.match(html, /类型：docx 2</);
  assert.doesNotMatch(html, /markdown 0/);
});

test("可信度圆点只渲染非零项，数量、颜色与完整 title 正确", () => {
  const html = render([makeKb({ trust: { high: 3, medium: 2, low: 1, unknown: 0 } })]);
  const dots = trustDots(html);
  assert.equal(dots.length, 3);
  assert.deepEqual(dots.map((dot) => dot.title), ["高 3", "中 2", "低 1"]);
  assert.deepEqual(dots.map((dot) => dot.ariaLabel), ["可信度：高 3", "可信度：中 2", "可信度：低 1"]);
  assert.deepEqual(dots.map((dot) => dot.color), TRUST_COLORS.slice(0, 3));
  assert.deepEqual(dots.map((dot) => dot.count), [3, 2, 1]);
  assert.match(html, /class="trust-dots" role="group" title="可信度：高 3 · 中 2 · 低 1 · 未知 0"/);
  assert.doesNotMatch(html, /title="未知 0"/);
});

test("未知可信度非零时使用灰色圆点", () => {
  const html = render([makeKb({ trust: { high: 1, medium: 0, low: 0, unknown: 4 } })]);
  const bars = segments(html);
  assert.deepEqual(bars.map((bar) => bar.color), [TRUST_COLORS[0], TRUST_COLORS[3]]);
  const dots = trustDots(html);
  assert.equal(dots.length, 2);
  assert.deepEqual(dots.map((dot) => dot.title), ["高 1", "未知 4"]);
  assert.equal(dots[1].color, TRUST_COLORS[3]);
});

test("可信度全为零时既没有圆点也没有可信度文案", () => {
  const html = render([makeKb({ trust: { high: 0, medium: 0, low: 0, unknown: 0 } })]);
  assert.doesNotMatch(html, /trust-dots|trust-dot\b/);
  assert.doesNotMatch(html, /title="可信度/);
});

test("知识库名称与类型名都做 HTML 转义", () => {
  const html = render([makeKb({ name: '<img src=x onerror=alert(1)>', types: { '<x>': 2 } })]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-name="&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.match(html, /类型：&lt;x&gt; 2/);
});

test("样式约定：连续条形（无间隙、父级圆角裁剪）与类型概括行", () => {
  const css = readFileSync(new URL("../ui/style.css", import.meta.url), "utf8");
  const bar = cssRule(".bar");
  assert.match(bar, /display:\s*flex/);
  assert.match(bar, /gap:\s*0/);
  assert.match(bar, /height:\s*8px/);
  assert.match(bar, /width:\s*100%/);
  assert.match(bar, /background:\s*var\(--panel-2\)/);
  assert.match(bar, /border-radius:\s*999px/);
  assert.match(bar, /overflow:\s*hidden/);
  const segment = cssRule(".bar i");
  assert.match(segment, /height:\s*100%/);
  assert.match(segment, /border-radius:\s*0/);
  assert.match(cssRule(".bar.empty i"), /width:\s*100%/);
  assert.match(cssRule(".bar.empty i"), /background:\s*var\(--line\)/);
  assert.match(cssRule(".type-line"), /font-size:\s*12px/);
  assert.doesNotMatch(css, /\.bar\.thin/);
});

test("总览页只读展示知识库根目录", () => {
  const html = render([makeKb()], { server: { kbRoot: "/srv/知识库" } });
  assert.match(html, /class="muted root-line"/);
  assert.match(html, /知识库根目录/);
  assert.match(html, /<code class="root-path" title="[^"]*kbRoot[^"]*">\/srv\/知识库<\/code>/);
  assert.match(render([], { server: { kbRoot: "/srv/知识库" } }), /class="root-path"/);
});
