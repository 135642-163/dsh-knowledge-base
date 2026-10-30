/**
 * 0.31 语义层纯函数（Task 1）：向量归一化/余弦 topK、文档级 RRF、词面强命中、
 * 两阶段页码回填。不加载模型、不读盘；RRF 与评测实现（scripts/eval/fusion.mjs）
 * 对同一输入逐条比对，避免生产与评测口径分叉。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SEMANTIC_LIMITS,
  cosineTopK,
  fuseDocRrf,
  isStrongLexicalHit,
  locatePageInDoc,
  normalizeVector,
} from "../lib/semantic.js";
import { rrfFuse } from "../scripts/eval/fusion.mjs";

const close = (actual, expected, eps = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} 与 ${expected} 相差超过 ${eps}`);
};
const vector = (values) => Float32Array.from(values);

// ---------------------------------------------------------------------------
// 向量归一化 / 余弦 topK
// ---------------------------------------------------------------------------

test("normalizeVector：L2 归一化，零/空/非有限向量返回 null", () => {
  const out = normalizeVector([3, 4]);
  assert.ok(out instanceof Float32Array);
  close(out[0], 0.6);
  close(out[1], 0.8);
  assert.equal(normalizeVector([0, 0]), null);
  assert.equal(normalizeVector([]), null);
  assert.equal(normalizeVector([Number.NaN, 1]), null);
  assert.equal(normalizeVector([0, Number.POSITIVE_INFINITY]), null);
  close(normalizeVector(new Float32Array([0, 5]))[1], 1);
  // 不改写入参
  const input = new Float32Array([3, 4]);
  normalizeVector(input);
  assert.deepEqual([...input], [3, 4]);
});

test("cosineTopK：按余弦降序取 topK，id 支持文档字符串", () => {
  const scores = cosineTopK({
    query: vector([1, 0]),
    vectors: [vector([1, 0]), vector([0, 1]), vector([0.6, 0.8])],
    ids: ["a", "b", "c"],
    k: 2,
  });
  assert.deepEqual(scores.map((item) => item.id), ["a", "c"]);
  close(scores[0].score, 1);
  close(scores[1].score, 0.6);
});

test("cosineTopK：并列保持输入序、维度不符跳过、空输入与 k=0", () => {
  const query = vector([1, 0]);
  const tie = cosineTopK({
    query,
    vectors: [vector([1, 0]), vector([1, 0]), vector([0, 1])],
    ids: ["x", "y", "z"],
    k: 5,
  });
  assert.deepEqual(tie.map((item) => item.id), ["x", "y", "z"]);
  const mixed = cosineTopK({
    query,
    vectors: [vector([1, 0, 0]), vector([1, 0])],
    ids: ["bad", "ok"],
    k: 5,
  });
  assert.deepEqual(mixed.map((item) => item.id), ["ok"]);
  assert.deepEqual(cosineTopK({ query, vectors: [], ids: [], k: 5 }), []);
  assert.deepEqual(cosineTopK({ query, vectors: [vector([1, 0])], ids: ["a"], k: 0 }), []);
  // k 超过候选数时返回全部，不报错
  assert.deepEqual(cosineTopK({ query, vectors: [vector([1, 0])], ids: ["a"], k: 99 }).length, 1);
});

// ---------------------------------------------------------------------------
// 文档级 RRF
// ---------------------------------------------------------------------------

test("fuseDocRrf：与评测 rrfFuse 对同一输入完全一致", () => {
  const args = { lexical: [7, 3, 9, 1], dense: [9, 1, 4, 7], k: 20 };
  assert.deepEqual(fuseDocRrf(args), rrfFuse(args));
  const numericTie = { lexical: [1, 2, 3], dense: [3, 2, 1], k: 60 };
  assert.deepEqual(fuseDocRrf(numericTie), rrfFuse(numericTie));
});

test("fuseDocRrf：文档 id 字符串、双命中优先、并列按首次出现", () => {
  // a、b 双命中且分数相同（1/21+1/22），a 先从 lexical 出现，排在 b 前。
  const fused = fuseDocRrf({ lexical: ["a", "b", "c"], dense: ["b", "a"], k: 20 });
  assert.deepEqual(fused.map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(fuseDocRrf({}), []);
  assert.deepEqual(fuseDocRrf({ lexical: [null, undefined, "", Number.NaN], dense: [] }), []);
});

test("fuseDocRrf：默认 k=20，只出现一路也保留，单条得分 1/(k+1)", () => {
  assert.equal(SEMANTIC_LIMITS.rrfK, 20);
  const fused = fuseDocRrf({ lexical: ["only"] });
  assert.equal(fused.length, 1);
  close(fused[0].score, 1 / 21);
});

// ---------------------------------------------------------------------------
// 词面强命中
// ---------------------------------------------------------------------------

const strongTerms = ["风电场", "电压", "穿越"];

test("isStrongLexicalHit：标题命中 + 条款命中 ≥2 个不同词 + trust!=low → true", () => {
  assert.equal(isStrongLexicalHit({
    terms: strongTerms,
    topDoc: { title: "GB/T 19963.1-2021 风电场接入电力系统技术规定", trust: "high" },
    topClause: { line: "[9.2.1] 风电场低电压穿越 — 并网点电压跌至 20% 时应保持不脱网运行" },
  }), true);
  // topClause 允许直接传文本
  assert.equal(isStrongLexicalHit({
    terms: strongTerms,
    topDoc: { title: "风电场接入电力系统技术规定", trust: "unknown" },
    topClause: "风电场低电压穿越要求",
  }), true);
});

test("isStrongLexicalHit：标题不命中 / 条款只命中 1 个词 / trust=low → false", () => {
  assert.equal(isStrongLexicalHit({
    terms: ["电压", "穿越"],
    topDoc: { title: "GB/T 12325-2008 电能质量 供电电压偏差", trust: "high" },
    topClause: "电压偏差限值",
  }), false, "条款只命中 1 个不同词（标题命中不参与条款计数）");
  assert.equal(isStrongLexicalHit({
    terms: strongTerms,
    topDoc: { title: "风电场接入电力系统技术规定", trust: "high" },
    topClause: "风电场接入要求",
  }), false, "条款只命中 1 个不同词");
  assert.equal(isStrongLexicalHit({
    terms: strongTerms,
    topDoc: { title: "风电场接入电力系统技术规定", trust: "low" },
    topClause: "风电场低电压穿越要求",
  }), false, "trust=low 不锁定");
  assert.equal(isStrongLexicalHit({ terms: strongTerms }), false, "缺 topDoc/topClause");
});

test("isStrongLexicalHit：单字词不参与标题命中，大小写不敏感", () => {
  assert.equal(isStrongLexicalHit({
    terms: ["电", "风电场"],
    topDoc: { title: "风电场", trust: "high" },
    topClause: "风电场",
  }), false, "单字词忽略后条款只剩 1 个词");
  assert.equal(isStrongLexicalHit({
    terms: ["GB/T", "电压"],
    topDoc: { title: "GB/T 19963.1-2021 风电场", trust: "high" },
    topClause: "gb/t 19963.1 的电压要求",
  }), true);
});

// ---------------------------------------------------------------------------
// 两阶段页码
// ---------------------------------------------------------------------------

test("locatePageInDoc：B 已命中时用 B 的页码/条款（不改现状）", () => {
  const located = locatePageInDoc({
    docHits: [{ page: 4, pageEnd: 4, clause: "4.1", line: "[4.1] 35 kV 及以上供电电压…" }],
    ftsMatches: [{ clause: "9.9", heading: "别的", text: "不该被使用", pageStart: 99 }],
  });
  assert.deepEqual(located, {
    page: 4,
    pageEnd: null,
    clause: "4.1",
    line: "[4.1] 35 kV 及以上供电电压…",
    source: "lexical",
  });
  const range = locatePageInDoc({ docHits: [{ page: 4, pageEnd: 6, clause: "4.1", line: "x" }] });
  assert.equal(range.pageEnd, 6);
});

test("locatePageInDoc：dense 独有文档用单文档 FTS 的首条条款补页码", () => {
  const located = locatePageInDoc({
    docHits: [],
    ftsMatches: [
      { clause: "5.2.2", heading: "电压偏差", text: "供电电压偏差限值…", pageStart: 12, pageEnd: 12 },
      { clause: "5.2.1", heading: "电压偏差", text: "第二条", pageStart: 11, pageEnd: 11 },
    ],
  });
  assert.equal(located.page, 12);
  assert.equal(located.pageEnd, null);
  assert.equal(located.clause, "5.2.2");
  assert.equal(located.source, "doc-fts");
  assert.equal(located.line, "[5.2.2] 电压偏差 — 供电电压偏差限值…");
});

test("locatePageInDoc：都没有命中时 page=null 并标注来源，不伪造页码", () => {
  assert.deepEqual(locatePageInDoc({}), { page: null, pageEnd: null, clause: "", line: "", source: "none" });
  const noPage = locatePageInDoc({
    docHits: [{ page: null, pageEnd: null, clause: "", line: "无页码命中" }],
  });
  assert.equal(noPage.page, null);
  assert.equal(noPage.source, "lexical");
  const ftsNoPage = locatePageInDoc({
    ftsMatches: [{ clause: "A", heading: "", text: "附录内容", pageStart: null, pageEnd: null }],
  });
  assert.equal(ftsNoPage.page, null);
  assert.equal(ftsNoPage.clause, "A");
  assert.equal(ftsNoPage.source, "doc-fts");
});

test("SEMANTIC_LIMITS：排序/强命中阈值只此一组", () => {
  assert.deepEqual(SEMANTIC_LIMITS, { denseTopK: 50, rrfK: 20, strongMinTerms: 2 });
});
