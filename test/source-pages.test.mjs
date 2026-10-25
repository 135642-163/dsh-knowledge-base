import test from "node:test";
import assert from "node:assert/strict";
import { pageOfClause } from "../lib/sources.js";

test("pageOfClause 按页标题定位条款，兼容条款号独占一行", () => {
  const text = [
    "### 第 1 页", "封面",
    "### 第 2 页", "3.1 公共连接点", "正文",
    "### 第 3 页", "5.1", "谐波限值",
    "### 第 4 页", "3.2 间谐波", "正文",
  ].join("\n");
  assert.equal(pageOfClause(text, "3.1"), 2);
  assert.equal(pageOfClause(text, "5.1"), 3);
  assert.equal(pageOfClause(text, "3.2"), 4);
  assert.equal(pageOfClause(text, "9.9"), null);
});

import { keywordsOfQuery, sourcesFromMatches } from "../lib/sources.js";

test("检索关键词不包含条款号，kb_query 来源带关键词", () => {
  assert.deepEqual(keywordsOfQuery("谐波限值"), ["谐波限值"]);
  const sources = sourcesFromMatches([
    { docId: "d1", title: "Q/GDW", pageStart: 3, clause: "5.1", line: "谐波限值" },
  ], "标准", { query: "谐波限值" });
  assert.deepEqual(sources[0].keywords, ["谐波限值"]);
  assert.equal(sources[0].clause, "5.1");
});
