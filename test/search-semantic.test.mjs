/**
 * 0.31 可选语义层接入（Task 4，纯编排层）：searchAll 的 semantic 通道。
 * 关闭时与 0.30 完全一致；开启时空值/失败一律回退 B，强词面优先只改排序。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchFilters, searchAll } from "../lib/search.js";

const docs = [
  { id: "a", title: "GB/T 1 电压偏差", standardNo: "GB/T 1", type: "pdf-text", tags: ["电能质量"], trust: "high", updatedAt: "2026-10-01T00:00:00.000Z" },
  { id: "b", title: "频率偏差", standardNo: "GB/T 2", type: "pdf-text", tags: [], trust: "unknown", updatedAt: "2026-10-02T00:00:00.000Z" },
  { id: "c", title: "电压偏差分析说明", standardNo: "", type: "note", tags: [], trust: "medium", updatedAt: "2026-10-03T00:00:00.000Z" },
];
const hits = [
  { docId: "a", title: "GB/T 1 电压偏差", trust: "high", pageStart: 4, pageEnd: 4, clause: "4.1", line: "[4.1] 供电电压偏差限值" },
  { docId: "b", title: "频率偏差", trust: "unknown", pageStart: 3, pageEnd: 3, clause: "3.1", line: "[3.1] 频率偏差限值" },
];

function vector(values) {
  return Float32Array.from(values);
}

function fakeSemantic({ ids = ["a", "b", "c"], vectors = [vector([0.6, 0.8]), vector([0, 1]), vector([1, 0])], locate = null, note = "" } = {}) {
  const located = [];
  return {
    enabled: true,
    note,
    located,
    async loadIndex() {
      return { ok: true, fresh: true, dim: 2, ids, vectors };
    },
    async embedQuery() {
      return { ok: true, vector: vector([1, 0]), dim: 2 };
    },
    async locateInDoc(_target, docId) {
      located.push(docId);
      return locate ? locate(docId) : [];
    },
  };
}

const GOLDEN = {
  terms: ["电压", "偏差", "电压偏差"],
  engine: "fts",
  indexBuilding: false,
  notes: [],
  facets: {
    tags: [{ name: "电能质量", count: 1 }],
    types: [{ name: "pdf-text", count: 2 }],
    trust: [{ name: "high", count: 1 }, { name: "unknown", count: 1 }],
  },
  results: [
    {
      kb: "标准",
      docId: "a",
      title: "GB/T 1 电压偏差",
      standardNo: "GB/T 1",
      type: "pdf-text",
      tags: ["电能质量"],
      trust: "high",
      updatedAt: "2026-10-01T00:00:00.000Z",
      page: 4,
      pageEnd: 4,
      clause: "4.1",
      line: "供电电压偏差限值",
      hits: 1,
      engineRank: 0,
      snippet: "供电电压偏差限值",
      terms: ["电压", "偏差", "电压偏差"],
      deepLink: "/kb/?kb=%E6%A0%87%E5%87%86&doc=a&page=4&clause=4.1",
    },
    {
      kb: "标准",
      docId: "b",
      title: "频率偏差",
      standardNo: "GB/T 2",
      type: "pdf-text",
      tags: [],
      trust: "unknown",
      updatedAt: "2026-10-02T00:00:00.000Z",
      page: 3,
      pageEnd: 3,
      clause: "3.1",
      line: "频率偏差限值",
      hits: 1,
      engineRank: 1,
      snippet: "频率偏差限值",
      terms: ["电压", "偏差", "电压偏差"],
      deepLink: "/kb/?kb=%E6%A0%87%E5%87%86&doc=b&page=3&clause=3.1",
    },
  ],
  estimated: false,
};

async function run({ semantic = null, query = "电压偏差", hits: inputHits = hits, targetDocs = docs, limit = 10 } = {}) {
  return searchAll({
    targets: [{ kb: "标准", docs: targetDocs }],
    query,
    filters: normalizeSearchFilters({ limit }),
    semantic,
    searcher: async () => ({ matches: inputHits, engine: "fts" }),
  });
}

// ---------------------------------------------------------------------------
// 关闭：golden
// ---------------------------------------------------------------------------

test("semanticSearch=off：结果与 0.30 的 B 路径逐字段一致", async () => {
  const response = await run();
  const { semantic, ...rest } = response;
  assert.deepEqual(rest, GOLDEN, "关闭语义时的结果必须与 0.30 完全相同");
  assert.deepEqual(semantic, { applied: false, reason: "" });
});

test("关闭语义时不读取索引、不嵌入查询", async () => {
  let touched = 0;
  const semantic = {
    enabled: false,
    async loadIndex() { touched += 1; return { ok: false }; },
    async embedQuery() { touched += 1; return { ok: false }; },
  };
  const response = await run({ semantic });
  assert.equal(touched, 0);
  assert.equal(response.engine, "fts");
  assert.deepEqual(response.semantic, { applied: false, reason: "" });
});

// ---------------------------------------------------------------------------
// 开启：融合 + 两阶段页码
// ---------------------------------------------------------------------------

test("开启语义：dense 独有文档进入结果，页码由单文档 FTS 回填", async () => {
  const semantic = fakeSemantic({
    locate: (docId) => (docId === "c"
      ? [{ clause: "9.9", heading: "语义命中", text: "电压偏差相关内容", pageStart: 33, pageEnd: 33 }]
      : []),
  });
  const response = await run({ semantic });
  assert.equal(response.engine, "hybrid");
  assert.equal(response.semantic.applied, true);
  assert.equal(response.estimated, false);
  assert.deepEqual(response.results.map((result) => result.docId), ["a", "b", "c"]);
  const denseOnly = response.results.find((result) => result.docId === "c");
  assert.equal(denseOnly.page, 33);
  assert.equal(denseOnly.clause, "9.9");
  assert.match(denseOnly.snippet, /电压偏差/);
  assert.match(denseOnly.deepLink, /page=33/);
  assert.deepEqual(semantic.located, ["c"], "只对 dense 独有文档跑单文档 FTS");
  assert.equal(response.notes.length, 0);
});

test("dense 独有文档找不到页码时 page=null，并在 note 里标注", async () => {
  const semantic = fakeSemantic();
  const response = await run({ semantic });
  const denseOnly = response.results.find((result) => result.docId === "c");
  assert.equal(denseOnly.page, null);
  assert.equal(denseOnly.clause, "");
  assert.match(response.notes.join("；"), /1 篇语义命中未定位到页码/);
});

test("强词面命中只锁第一位，不改变召回集合", async () => {
  const semantic = fakeSemantic({ ids: ["b", "c"], vectors: [vector([1, 0]), vector([0, 1])] });
  const response = await run({ semantic });
  assert.equal(response.engine, "hybrid");
  assert.deepEqual(new Set(response.results.map((result) => result.docId)), new Set(["a", "b", "c"]));
  assert.equal(response.results[0].docId, "a", "强词面命中应把 B 的 top-1 锁回第一位");

  const lowTrust = docs.map((doc) => (doc.id === "a" ? { ...doc, trust: "low" } : doc));
  const responseLowTrust = await run({ semantic, targetDocs: lowTrust });
  assert.equal(responseLowTrust.results[0].docId, "b", "trust=low 不锁定词面 top-1");
});

// ---------------------------------------------------------------------------
// 失败回退
// ---------------------------------------------------------------------------

test("索引构建中：回退 B + note，不返回 hybrid", async () => {
  const semantic = fakeSemantic();
  semantic.loadIndex = async () => ({ ok: false, reason: "index_building" });
  semantic.note = "语义索引构建中，本次已回退词面检索；稍后重试即可使用语义";
  const response = await run({ semantic });
  assert.equal(response.engine, "fts");
  assert.deepEqual(response.results.map((result) => result.docId), ["a", "b"]);
  assert.match(response.notes.join("；"), /语义索引构建中/);
  assert.deepEqual(response.semantic, { applied: false, reason: "index_building" });
});

test("查询嵌入不可用：回退 B 并报告 reason", async () => {
  const semantic = fakeSemantic();
  semantic.embedQuery = async () => ({ ok: false, reason: "model_missing" });
  const response = await run({ semantic });
  assert.equal(response.engine, "fts");
  assert.deepEqual(response.results.map((result) => result.docId), ["a", "b"]);
  assert.deepEqual(response.semantic, { applied: false, reason: "model_missing" });
});

test("语义通道抛异常：检索仍返回 B 结果", async () => {
  const semantic = fakeSemantic();
  semantic.loadIndex = async () => { throw new Error("boom"); };
  const response = await run({ semantic });
  assert.equal(response.engine, "fts");
  assert.deepEqual(response.results.map((result) => result.docId), ["a", "b"]);
  assert.equal(response.semantic.applied, false);
  assert.match(response.semantic.reason, /boom/);
});
