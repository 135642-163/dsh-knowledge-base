/**
 * 水印 A/B 的 CER 口径（去空白/标点、编辑距离 ÷ 真值长度）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { charErrorRate, normalizeText } from "../scripts/watermark-ab.mjs";

test("normalizeText 去空白/标点并转小写", () => {
  assert.equal(normalizeText(" GB/T 12326—2008，电压 波动！ "), "gbt123262008电压波动");
});

test("charErrorRate：完全一致 0，单字替换 1/n", () => {
  assert.equal(charErrorRate("电压偏差", "电压偏差"), 0);
  assert.equal(charErrorRate("电压偏差", "电压偏压"), 0.25);
  assert.equal(charErrorRate("ABC", "AC"), 1 / 3);
  assert.equal(charErrorRate("", "x"), 1);
  assert.equal(charErrorRate("", ""), 0);
});
