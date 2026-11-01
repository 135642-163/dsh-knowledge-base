import test from "node:test";
import assert from "node:assert/strict";
import { splitClauses } from "../lib/clauses.js";

test("splitClauses 按条款号/章节切分并带页码与行号", () => {
  const md = [
    "# 标准",
    "### 第 1 页",
    "5.2.2 电压偏差应满足要求。",
    "第二行正文。",
    "### 第 2 页",
    "5.2.3 谐波限值。",
    "### 第 3 页",
    "第1章 范围",
    "本标准适用于……",
  ].join("\n");
  const clauses = splitClauses(md, { docId: "d1" });
  assert.equal(clauses.length, 3);
  assert.deepEqual(clauses[0], {
    docId: "d1", clause: "5.2.2", heading: "电压偏差应满足要求。",
    text: "第二行正文。", pageStart: 1, pageEnd: 1, lineStart: 3, lineEnd: 4,
  });
  assert.equal(clauses[1].clause, "5.2.3");
  assert.equal(clauses[1].pageStart, 2);
  assert.equal(clauses[2].clause, "第1章");
  assert.equal(clauses[2].pageStart, 3);
});

test("长条款按句末/换行切块且保留 clause", () => {
  const sentence = "这是很长的条款正文。";
  const md = `5.1 标题\n${sentence.repeat(200)}`;
  const clauses = splitClauses(md, { docId: "d2", maxChars: 100 });
  assert.ok(clauses.length > 1);
  assert.ok(clauses.every((item) => item.docId === "d2" && item.clause === "5.1"));
  assert.ok(clauses.every((item) => item.text.length <= 120));
});

test("页眉标准号不会被当成附录条款 Q", () => {
  const md = [
    "# 标准",
    "",
    "### 第 1 页",
    "Q / GDW 1168—2013",
    "5.1 试验项目",
    "5.1.1 应进行绝缘试验。",
  ].join("\n");
  const clauses = splitClauses(md, { docId: "d3" });
  assert.ok(!clauses.some((c) => c.clause === "Q"));
  assert.ok(clauses.some((c) => c.clause === "5.1"));
  assert.ok(clauses.some((c) => c.clause === "5.1.1"));
});

test("缺编号的标准页眉也不会被当成条款 Q", () => {
  const md = ["### 第 1 页", "Q / GDW — 直流设备", "5.2 试验周期", "5.2.1 每年一次。"].join("\n");
  const clauses = splitClauses(md, { docId: "d4" });
  assert.ok(!clauses.some((c) => c.clause === "Q"));
  assert.ok(clauses.some((c) => c.clause === "5.2"));
});

test("单独一行 Q / GDW 页眉也不产生条款 Q", () => {
  const md = ["### 第 1 页", "Q / GDW", "GDW 1168 — 2013", "5.3 试验项目", "5.3.1 应进行试验。"].join("\n");
  const clauses = splitClauses(md, { docId: "d5" });
  assert.ok(!clauses.some((c) => c.clause === "Q"));
  assert.ok(clauses.some((c) => c.clause === "5.3"));
});
