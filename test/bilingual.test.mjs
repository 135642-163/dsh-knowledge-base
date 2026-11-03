/**
 * 0.40 中英双语检索扩展：词表匹配、最长覆盖、方向判定与文档语言识别。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  chineseTermsForEnglish,
  docIdsForDirection,
  englishTermsForChinese,
  expandBilingualQuery,
  isChineseDoc,
  isEnglishDoc,
} from "../lib/bilingual.js";

test("中文查询按术语表补充英文词，长词优先且不重复", () => {
  const terms = englishTermsForChinese("电压暂降和短时中断对电能质量测量的影响");
  assert.ok(terms.includes("voltage dip"));
  assert.ok(terms.includes("voltage sag"));
  assert.ok(terms.includes("short interruption"));
  assert.ok(terms.includes("power quality measurement"));
  // “电压”不应在“电压暂降”已覆盖后再单独补一次
  assert.equal(terms.filter((term) => term === "voltage").length, 0);
  assert.equal(new Set(terms).size, terms.length);
});

test("英文查询反向补充中文词，最长短语优先", () => {
  const terms = chineseTermsForEnglish("Power quality measurement and voltage dip immunity");
  assert.ok(terms.includes("电能质量测量"));
  // “voltage dip immunity”整段命中词表，优先于拆成“电压暂降 + 抗扰度”
  assert.ok(terms.includes("电压暂降抗扰度"));
});

test("expandBilingualQuery 只对可安全扩展的普通文本生效", () => {
  const zh = expandBilingualQuery("电能质量测量");
  assert.equal(zh.direction, "zh-en");
  assert.deepEqual(zh.terms, ["power quality measurement"]);
  assert.match(zh.regex, /power quality measurement/);

  const en = expandBilingualQuery("voltage dip");
  assert.equal(en.direction, "en-zh");
  assert.ok(en.terms.includes("电压暂降"));

  assert.equal(expandBilingualQuery("GB/T 11032"), null);
  assert.equal(expandBilingualQuery("电力.*系统"), null);
  assert.equal(expandBilingualQuery("完全不在词表里的中文"), null);
});

test("文档语言识别与影子检索范围", () => {
  assert.equal(isEnglishDoc({ title: "Power quality measurement instruments" }), true);
  assert.equal(isEnglishDoc({ title: "电能质量测量仪器" }), false);
  assert.equal(isEnglishDoc({ title: "电能质量", standardNo: "IEC 61000-4-30" }), false);
  assert.equal(isEnglishDoc({ title: "IEC 61000-4-30" }), true);
  assert.equal(isEnglishDoc({ title: "IEC 61000-4-30 Power quality", standardNo: "IEC 61000-4-30" }), true);
  assert.equal(isChineseDoc({ title: "电压暂降与短时中断" }), true);

  const manifest = { docs: [
    { id: "en", title: "Power quality measurement instruments", status: "ready" },
    { id: "zh", title: "电压暂降与短时中断", status: "ready" },
    { id: "gone", title: "Power quality (deleted)", status: "deleted" },
  ] };
  assert.deepEqual(docIdsForDirection(manifest, "zh-en"), ["en"]);
  assert.deepEqual(docIdsForDirection(manifest, "en-zh"), ["zh"]);
});
