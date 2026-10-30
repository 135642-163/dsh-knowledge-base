/**
 * 0.27 人工评测集（60 题）的离线校验：分组计数、id/问题唯一、期望字段完整。
 * 不依赖真实知识库；与真实库的一致性用 `node scripts/eval-benchmark.mjs --validate` 检查。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const DATASET = new URL("../scripts/eval/questions-2026-10-27.jsonl", import.meta.url);

function parseLines(text) {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

const items = parseLines(await readFile(DATASET, "utf8"));

test("数据集 60 题，分组 20/15/15/10", () => {
  assert.equal(items.length, 60);
  const counts = items.reduce((acc, item) => {
    acc[item.group] = (acc[item.group] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { clause: 20, "multi-doc": 15, numeric: 15, paraphrase: 10 });
});

test("id 与问题文本唯一，且都带 note", () => {
  const ids = new Set();
  const questions = new Set();
  for (const item of items) {
    assert.match(item.id, /^Q\d{2}$/, item.id);
    assert.ok(!ids.has(item.id), `id 重复：${item.id}`);
    ids.add(item.id);
    assert.equal(typeof item.q, "string");
    assert.ok(item.q.trim().length >= 4, `${item.id} 问题过短`);
    assert.ok(!questions.has(item.q), `问题重复：${item.q}`);
    questions.add(item.q);
    assert.equal(typeof item.note, "string");
    assert.ok(item.note.length > 0, `${item.id} 缺少 note`);
  }
});

test("expected 字段完整：kb/docId/title/standardNo/page/clause", () => {
  for (const item of items) {
    assert.ok(Array.isArray(item.expected) && item.expected.length > 0, `${item.id} 缺少 expected`);
    if (item.group === "multi-doc") {
      assert.ok(item.expected.length >= 2, `${item.id} 跨文档题应有 2 条以上期望`);
    }
    for (const exp of item.expected) {
      assert.equal(exp.kb, "标准");
      assert.match(String(exp.docId), /^[0-9a-f]{12}$/, `${item.id} docId 形态`);
      assert.ok(String(exp.title).length > 0);
      assert.equal(typeof exp.standardNo, "string");
      assert.ok(Number.isInteger(exp.page) && exp.page >= 1, `${item.id} 页码`);
      assert.equal(typeof exp.clause, "string");
      assert.ok(exp.clause.length > 0, `${item.id} 条款号`);
    }
  }
});

test("同一题内的 expected 不重复", () => {
  for (const item of items) {
    const keys = item.expected.map((exp) => `${exp.docId}#${exp.clause}#${exp.page}`);
    assert.equal(new Set(keys).size, keys.length, `${item.id} 期望重复`);
  }
});

test("0.30 独立同义题集：20 题、全 paraphrase、id/字段完整", async () => {
  const text = await readFile(new URL("../scripts/eval/questions-2026-10-30-paraphrase.jsonl", import.meta.url), "utf8");
  const items = parseLines(text);
  assert.equal(items.length, 20);
  const ids = new Set();
  const questions = new Set();
  for (const item of items) {
    assert.match(item.id, /^N\d{2}$/);
    assert.equal(item.group, "paraphrase");
    assert.ok(!ids.has(item.id), `id 重复：${item.id}`);
    ids.add(item.id);
    assert.ok(item.q.trim().length >= 6, `${item.id} 问题过短`);
    assert.ok(!questions.has(item.q), `问题重复：${item.q}`);
    questions.add(item.q);
    assert.match(item.note, /独立同义改写/);
    assert.equal(item.expected.length, 1, `${item.id} 独立同义题应为单文档期望`);
    const exp = item.expected[0];
    assert.equal(exp.kb, "标准");
    assert.match(String(exp.docId), /^[0-9a-f]{12}$/);
    assert.ok(Number.isInteger(exp.page) && exp.page >= 1);
    assert.ok(String(exp.clause).length > 0);
  }
});

test("0.30 与 0.27 两套题集 id 不冲突、问题不重复", async () => {
  const text = await readFile(new URL("../scripts/eval/questions-2026-10-30-paraphrase.jsonl", import.meta.url), "utf8");
  const extra = parseLines(text);
  const ids = new Set(items.map((item) => item.id));
  const questions = new Set(items.map((item) => item.q));
  for (const item of extra) {
    assert.ok(!ids.has(item.id), `id 冲突：${item.id}`);
    assert.ok(!questions.has(item.q), `问题重复：${item.q}`);
  }
});
