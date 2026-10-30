/**
 * 0.32 「书目索引（自动生成）」生成器：
 * 从当前清单重建表格，清掉书签/文字层里不可读的 U+FFFD / 私用区字符，
 * 排除索引自身，类型/字数格式与旧索引一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildCatalogMarkdown, sanitizeCatalogText } from "../scripts/build-catalog-index.mjs";

function doc(id, title, patch = {}) {
  return {
    id,
    title,
    type: "pdf-scanned",
    status: "ready",
    pages: 100,
    chars: 123456,
    sourceFile: `${id}.pdf`,
    outline: [],
    ...patch,
  };
}

const manifest = {
  schemaVersion: 6,
  name: "测试库",
  docs: [
    doc("b", "乙资料", { type: "docx", pages: 0, chars: 999 }),
    doc("a", "甲资料", {
      outline: [
        { title: "封面\uFFFD\uFFFD", level: 1 },
        { title: "第一章 概述", level: 1 },
        { title: "\uE000私用区", level: 1 },
        { title: "第四条不应出现", level: 1 },
      ],
    }),
    doc("self", "测试库书目索引（自动生成）", { type: "markdown", sourceFile: "_书目索引.md", chars: 100 }),
    doc("del", "已删除资料", { deletedAt: "2026-10-01T00:00:00.000Z" }),
    doc("note", "一条笔记", { type: "note", chars: 20, pages: 0 }),
  ],
};

test("buildCatalogMarkdown renders a clean table from the manifest", () => {
  const md = buildCatalogMarkdown(manifest, {
    kbName: "测试库",
    now: new Date("2026-10-31T00:30:00+08:00"),
  });
  assert.match(md, /^# 测试库 书目索引（自动生成）$/m);
  assert.match(md, /生成时间：2026\/10\/31 00:30:00｜共 3 部（不含本索引）/);
  assert.equal((md.match(/^\| \d+ \|/gm) ?? []).length, 3, "排除索引自身与软删除文档");
  assert.doesNotMatch(md, /书目索引（自动生成） \|/m, "索引不能把自己列进表格");
  assert.match(md, /\| 2 \| 一条笔记 \| 笔记 \| 0 \| 20 \|  \|/, "笔记照旧列出");
  assert.match(md, /\| 3 \| 乙资料 \| Word \| 0 \| 999 \|  \|/, "Word 类型与小于一万的字数原样显示");
  assert.match(md, /\| 1 \| 甲资料 \| PDF扫描 \| 100 \| 12.3万 \| 封面；第一章 概述；私用区 \|/, "大纲去乱码、最多 3 条");
  assert.doesNotMatch(md, /第四条不应出现/, "第 4 条大纲不出现");
  assert.doesNotMatch(md, /[\uFFFD\uE000-\uF8FF]/);
});

test("sanitizeCatalogText strips replacement/private-use chars and collapses spaces", () => {
  assert.equal(sanitizeCatalogText("封面\uFFFD\uFFFD  书名\uE000"), "封面 书名");
  assert.equal(sanitizeCatalogText(null), "");
});
