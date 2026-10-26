/**
 * 0.29 评测纯函数：RRF 融合、条款行 → 文档级顺序、嵌入文本拼装。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clauseText, rrfFuse, rowsToDocOrder } from "../scripts/eval/fusion.mjs";

// ---------------------------------------------------------------------------
// RRF
// ---------------------------------------------------------------------------

test("单列表融合保持原顺序", () => {
  const fused = rrfFuse({ lexical: [7, 3, 9] });
  assert.deepEqual(fused.map((item) => item.id), [7, 3, 9]);
  assert.ok(fused[0].score > fused[1].score && fused[1].score > fused[2].score);
});

test("两个列表都命中的条款排在只命中一个之前", () => {
  const fused = rrfFuse({ lexical: [1, 2, 3], dense: [3, 2, 1], k: 60 });
  // 1 与 3 的「1/61 + 1/63」相同且略高于中间的「1/62 + 1/62」，并列时按 id 升序兜底
  assert.deepEqual(fused.map((item) => item.id), [1, 3, 2]);
  assert.equal(fused[0].score.toFixed(6), fused[1].score.toFixed(6));
  const mixed = rrfFuse({ lexical: [10, 11], dense: [12, 11] });
  const order = mixed.map((item) => item.id);
  assert.equal(order[0], 11, `双命中应排第一：${order}`);
  assert.deepEqual(new Set(order), new Set([10, 11, 12]));
});

test("k 越大排名差异越平缓", () => {
  const small = rrfFuse({ lexical: [1, 2], dense: [], k: 1 });
  const large = rrfFuse({ lexical: [1, 2], dense: [], k: 1000 });
  const smallGap = small[0].score - small[1].score;
  const largeGap = large[0].score - large[1].score;
  assert.ok(smallGap > largeGap, `${smallGap} vs ${largeGap}`);
});

test("忽略空 id 与非有限数字；支持字符串（文档级融合）", () => {
  assert.deepEqual(rrfFuse({}), []);
  const fused = rrfFuse({ lexical: [null, undefined, "", Number.NaN, 5], dense: [] });
  assert.deepEqual(fused.map((item) => item.id), [5]);
  const docs = rrfFuse({ lexical: ["d1", "d2"], dense: ["d2", "d3"], k: 20 });
  assert.deepEqual(docs.map((item) => item.id), ["d2", "d1", "d3"]);
});

// ---------------------------------------------------------------------------
// 文档级归并
// ---------------------------------------------------------------------------

test("rowsToDocOrder 按首次出现去重并收集页码", () => {
  const { docOrder, pages } = rowsToDocOrder([
    { docId: "d1", page: 3, pageEnd: 3 },
    { docId: "d2", page: 1 },
    { docId: "d1", page: 7, pageEnd: 8 },
    { docId: "", page: 2 },
    { docId: "d3", page: null },
  ]);
  assert.deepEqual(docOrder, ["d1", "d2", "d3"]);
  assert.deepEqual(pages.get("d1"), [
    { pageStart: 3, pageEnd: 3 },
    { pageStart: 7, pageEnd: 8 },
  ]);
  assert.deepEqual(pages.get("d3"), [{ pageStart: null, pageEnd: null }]);
});

test("rowsToDocOrder 截断到 topK", () => {
  const rows = Array.from({ length: 15 }, (_, index) => ({ docId: `d${index}`, page: 1 }));
  assert.equal(rowsToDocOrder(rows, 10).docOrder.length, 10);
  assert.equal(rowsToDocOrder(rows, 3).docOrder.length, 3);
});

// ---------------------------------------------------------------------------
// 嵌入文本
// ---------------------------------------------------------------------------

test("clauseText 拼出标准号/标题/条款号/小标题并折叠空白", () => {
  const text = clauseText({
    standardNo: "GB/T 12325-2008",
    title: "电能质量 供电电压偏差",
    clause: "4.2",
    heading: "20 kV 及以下三相供电电压",
    text: "供电电压\n偏差为  标称电压的 ±7%。",
  });
  assert.match(text, /^GB\/T 12325-2008 电能质量 供电电压偏差 第4\.2条 20 kV 及以下三相供电电压：/);
  assert.ok(text.includes("供电电压 偏差为 标称电压的 ±7%。"), text);
  assert.equal(text.includes("\n"), false);
});

test("clauseText 截断到 maxChars 且保底 8 字", () => {
  const long = clauseText({ title: "标题", text: "正文".repeat(500) }, 40);
  assert.equal(long.length, 40);
  assert.equal(clauseText({ title: "标题", text: "正文".repeat(20) }, 1).length, 8, "maxChars 下限是 8");
  assert.equal(clauseText({ title: "标题", text: "正文" }, 1).length, 5, "内容本身不足时按实际长度");
});
