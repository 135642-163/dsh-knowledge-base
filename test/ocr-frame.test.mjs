/**
 * 0.5.0 OCR 帧协议：新版 Python worker 返回 {text, confidence} JSON；
 * 旧版/异常输出退回纯文本，confidence=null。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseOcrFrame } from "../lib/ocr.js";

test("parses a JSON frame with confidence", () => {
  const r = parseOcrFrame(JSON.stringify({ text: "电能质量", confidence: 87.5 }));
  assert.equal(r.text, "电能质量");
  assert.equal(r.confidence, 87.5);
});

test("falls back to plain text for legacy frames", () => {
  const r = parseOcrFrame("电能质量");
  assert.equal(r.text, "电能质量");
  assert.equal(r.confidence, null);
});

test("tolerates malformed or missing confidence", () => {
  assert.equal(parseOcrFrame('{"text":"abc"}').confidence, null);
  assert.equal(parseOcrFrame('{"text":"abc","confidence":null}').confidence, null);
  assert.equal(parseOcrFrame('{"text":"abc","confidence":"oops"}').confidence, null);
  assert.equal(parseOcrFrame("{not json").text, "{not json");
});
