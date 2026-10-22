/**
 * 0.4.1 检索排序：标题命中 > 标题行命中 > 命中密度 > 更新时间；
 * 每文档默认最多保留 5 条，避免一个文档刷屏。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rankMatches } from "../lib/query.js";

const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();

function hit(docId, title, lineNumber, line, updatedAt = NOW, kb) {
  return { docId, title, lineNumber, line, updatedAt, ...(kb ? { kb } : {}) };
}

test("title hit outranks body hits", () => {
  const ranked = rankMatches(
    [
      hit("b", "无关文档", 1, "这里提到电压偏差"),
      hit("a", "电压偏差分析", 10, "正文"),
    ],
    { pattern: "电压偏差", maxMatches: 10, perDocMax: 5 }
  );
  assert.equal(ranked[0].docId, "a");
});

test("heading hit outranks plain body lines", () => {
  const ranked = rankMatches(
    [
      hit("c", "文档C", 1, "正文提到电压偏差"),
      hit("b", "文档B", 20, "## 电压偏差"),
    ],
    { pattern: "电压偏差", maxMatches: 10, perDocMax: 5 }
  );
  assert.equal(ranked[0].docId, "b");
});

test("per-document cap keeps at most five hits", () => {
  const matches = Array.from({ length: 10 }, (_, i) =>
    hit("b", "文档B", i + 1, `第 ${i + 1} 条电压偏差`)
  );
  const ranked = rankMatches(matches, { pattern: "电压偏差", maxMatches: 40, perDocMax: 5 });
  assert.equal(ranked.length, 5);
  assert.ok(ranked.every((m) => m.docId === "b"));
});

test("newer document wins when title/heading/hits tie", () => {
  const ranked = rankMatches(
    [
      hit("old", "旧文档", 1, "电压偏差", OLD),
      hit("new", "新文档", 1, "电压偏差", NOW),
    ],
    { pattern: "电压偏差", maxMatches: 10, perDocMax: 5 }
  );
  assert.equal(ranked[0].docId, "new");
});

test("same docId in different knowledge bases is not merged", () => {
  const ranked = rankMatches(
    [
      hit("d1", "文档一", 1, "电压偏差", NOW, "kb1"),
      hit("d1", "文档一", 3, "电压偏差", NOW, "kb2"),
    ],
    { pattern: "电压偏差", maxMatches: 10, perDocMax: 5 }
  );
  assert.equal(ranked.length, 2);
  assert.deepEqual(new Set(ranked.map((m) => m.kb)), new Set(["kb1", "kb2"]));
});
