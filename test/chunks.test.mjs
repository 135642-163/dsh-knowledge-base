/**
 * RAG 小块切分：优先段落/句子边界，超长句硬切；
 * 可选相邻块重叠，保证每块不超过 maxChars。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { splitTextChunks } from "../lib/chunks.js";

test("short text is one chunk", () => {
  assert.deepEqual(splitTextChunks("电能质量", { maxChars: 100 }), ["电能质量"]);
});

test("empty text yields no chunks", () => {
  assert.deepEqual(splitTextChunks("  \n\n "), []);
});

test("paragraphs are packed up to maxChars", () => {
  const chunks = splitTextChunks("aaaa\n\nbbbb\n\ncccc", { maxChars: 10 });
  assert.deepEqual(chunks, ["aaaa\n\nbbbb", "cccc"]);
});

test("long unbroken text is hard-split without exceeding maxChars", () => {
  const chunks = splitTextChunks("甲".repeat(250), { maxChars: 100 });
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
  assert.equal(chunks.join(""), "甲".repeat(250));
});

test("sentences are preferred over hard splits", () => {
  const chunks = splitTextChunks("第一句。第二句。第三句。", { maxChars: 8 });
  assert.deepEqual(chunks, ["第一句。第二句。", "第三句。"]);
});

test("overlap prefixes the next chunk and keeps the limit", () => {
  const text = "11111111\n\n22222222\n\n33333333";
  const chunks = splitTextChunks(text, { maxChars: 20, overlap: 5 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(chunk.length <= 20, chunk);
  assert.ok(chunks[1].startsWith(chunks[0].slice(-5).trim()));
});

test("overlap is clamped and never duplicates beyond maxChars", () => {
  const chunks = splitTextChunks("甲".repeat(30), { maxChars: 10, overlap: 100 });
  for (const chunk of chunks) assert.ok(chunk.length <= 10);
});
