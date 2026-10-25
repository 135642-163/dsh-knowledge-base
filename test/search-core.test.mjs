/**
 * 检索工作台核心（lib/search.js）：参数归一、片段窗口、文档级归并、boost 排序、
 * 过滤 / facets / 分页、跨库编排。纯函数为主，不读盘。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_LIMITS,
  SearchError,
  buildSearchResponse,
  facetsOf,
  groupHitsByDoc,
  matchesFilters,
  normalizeSearchFilters,
  rankResults,
  scoreResult,
  searchAll,
  snippetAround,
  validateQuery,
} from "../lib/search.js";

const KB = "标准";

const DOCS = [
  {
    id: "d1", title: "风电场接入电力系统技术规定", standardNo: "GB/T 19963-2011",
    type: "pdf-text", trust: "high", tags: ["新能源", "并网"],
    updatedAt: "2026-10-20T00:00:00.000Z", pages: 10,
  },
  {
    id: "d2", title: "电能质量 电压偏差", standardNo: "GB 12325-2008",
    type: "pdf-text", trust: "medium", tags: ["电能质量"],
    updatedAt: "2024-01-01T00:00:00.000Z", pages: 8,
  },
  {
    id: "d3", title: "光伏发电系统接入配电网", standardNo: "GB/T 29319-2012",
    type: "docx", trust: "low", tags: [],
    updatedAt: "", pages: 3,
  },
];

function hit(docId, extra = {}) {
  return {
    docId,
    title: DOCS.find((doc) => doc.id === docId)?.title ?? docId,
    line: "命中行",
    lineNumber: 1,
    pageStart: 1,
    pageEnd: 1,
    clause: "",
    ...extra,
  };
}

function groups(hits, docs = DOCS) {
  return groupHitsByDoc(hits, { docs, kb: KB });
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

test("validateQuery 拒绝空词与超长，接受 trim 后的词", () => {
  assert.equal(validateQuery("  电压偏差  "), "电压偏差");
  assert.throws(() => validateQuery("   "), (error) => error instanceof SearchError && error.code === "SEARCH_EMPTY");
  assert.throws(() => validateQuery(""), (error) => error.code === "SEARCH_EMPTY");
  assert.throws(() => validateQuery("电".repeat(201)), (error) => error.code === "INVALID_ARGS");
  assert.equal(validateQuery("电".repeat(200)).length, 200);
});

test("normalizeSearchFilters 默认值与夹取", () => {
  assert.deepEqual(normalizeSearchFilters({}), { tag: "", type: "", trust: "", limit: 20, offset: 0 });
  assert.equal(SEARCH_LIMITS.maxLimit, 50);
  const clamped = normalizeSearchFilters({ limit: 999, offset: -5 });
  assert.equal(clamped.limit, SEARCH_LIMITS.maxLimit);
  assert.equal(clamped.offset, 0);
  assert.equal(normalizeSearchFilters({ limit: "0", offset: "99999" }).limit, 1);
  assert.equal(normalizeSearchFilters({ limit: "0", offset: "99999" }).offset, SEARCH_LIMITS.maxOffset);
  assert.equal(normalizeSearchFilters({ tag: "  并网 " }).tag, "并网");
  assert.equal(normalizeSearchFilters({ type: " pdf-text " }).type, "pdf-text");
  assert.equal(normalizeSearchFilters({ trust: "high" }).trust, "high");
  assert.throws(() => normalizeSearchFilters({ trust: "HIGH" }), (error) => {
    assert.equal(error.code, "INVALID_ARGS");
    return true;
  });
});

// ---------------------------------------------------------------------------
// 片段
// ---------------------------------------------------------------------------

test("snippetAround 围绕最早命中词取窗口并限长", () => {
  const text = `${"甲".repeat(200)}电压偏差${"乙".repeat(200)}`;
  const snippet = snippetAround(text, ["电压偏差"], 40);
  assert.ok(snippet.includes("电压偏差"), snippet);
  assert.ok(snippet.length <= 40, `length=${snippet.length}`);
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…"), snippet);
});

test("snippetAround 没有命中词时取开头并加省略号", () => {
  const text = "丙".repeat(300);
  const snippet = snippetAround(text, ["电压偏差"], 30);
  assert.ok(snippet.startsWith("丙"));
  assert.ok(snippet.endsWith("…"));
  assert.ok(snippet.length <= 30);
});

test("snippetAround 去注释、折叠空白、空文本返回空串", () => {
  assert.equal(snippetAround("", ["电压"]), "");
  assert.equal(snippetAround("<!-- doc:1 -->\n\n5.2.2   电压   偏差。", ["电压"]), "5.2.2 电压 偏差。");
});

test("snippetAround 大小写不敏感且忽略空词", () => {
  const snippet = snippetAround("GB/T 19963 风电场", ["gb/t 19963"], 40);
  assert.ok(snippet.includes("GB/T 19963"), snippet);
});

// ---------------------------------------------------------------------------
// 归并
// ---------------------------------------------------------------------------

test("groupHitsByDoc 同一文档只留一条并记 hits，取引擎序第一条为最优命中", () => {
  const out = groups([
    hit("d1", { pageStart: 3, clause: "5.2.2", line: "第一条" }),
    hit("d1", { pageStart: 9, clause: "6.1", line: "第二条" }),
    hit("d2", { pageStart: 1 }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].docId, "d1");
  assert.equal(out[0].hits, 2);
  assert.equal(out[0].page, 3);
  assert.equal(out[0].clause, "5.2.2");
  assert.equal(out[0].engineRank, 0);
  assert.equal(out[1].engineRank, 1);
});

test("groupHitsByDoc 投影 manifest 元数据，过滤空 docId", () => {
  const out = groups([hit("d1"), hit(""), hit(undefined), hit("ghost", { title: "无清单标题" })]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    { standardNo: out[0].standardNo, type: out[0].type, trust: out[0].trust, tags: out[0].tags },
    { standardNo: "GB/T 19963-2011", type: "pdf-text", trust: "high", tags: ["新能源", "并网"] },
  );
  assert.equal(out[1].docId, "ghost");
  assert.equal(out[1].title, "无清单标题");
  assert.equal(out[1].trust, "unknown");
});

test("groupHitsByDoc 去掉 FTS 行首的条款前缀，保留正文", () => {
  const [result] = groups([hit("d1", { clause: "5.2.2", line: "[5.2.2] 风电场应满足电压偏差要求。" })]);
  assert.ok(!result.line.startsWith("["), result.line);
  assert.ok(result.line.includes("电压偏差"));
});

// ---------------------------------------------------------------------------
// 打分与排序
// ---------------------------------------------------------------------------

test("scoreResult 关闭 boost 时只按引擎序", () => {
  assert.equal(scoreResult({ engineRank: 0 }, { terms: ["电压"], boost: false }), 1);
  assert.equal(scoreResult({ engineRank: 3 }, { terms: ["电压"], boost: false }), 0.25);
});

test("标准号命中把 GB/T 文档排在同号 GB 文档前面", () => {
  const results = [
    { ...groups([hit("d2")])[0] },
    { ...groups([hit("d1")])[0] },
  ];
  const ranked = rankResults(results, { terms: [], query: "GB/T 19963", boost: true });
  assert.equal(ranked[0].docId, "d1");
  const plain = rankResults(results, { terms: [], query: "GB/T 19963", boost: false });
  assert.equal(plain[0].docId, "d2", "关闭 boost 时保持引擎序");
});

test("标题命中与标签命中提升得分，trust 有正负", () => {
  const base = { engineRank: 5, title: "无关标题", standardNo: "", tags: [], trust: "unknown", updatedAt: "" };
  const titleHit = scoreResult({ ...base, title: "电压偏差限值" }, { terms: ["电压偏差"] });
  const noTitle = scoreResult(base, { terms: ["电压偏差"] });
  assert.ok(titleHit > noTitle);
  const tagHit = scoreResult({ ...base, tags: ["电压偏差"] }, { terms: ["电压偏差"] });
  assert.ok(tagHit > noTitle);
  const high = scoreResult({ ...base, trust: "high" }, { terms: ["电压偏差"] });
  const low = scoreResult({ ...base, trust: "low" }, { terms: ["电压偏差"] });
  assert.ok(high > noTitle && noTitle > low);
});

test("rankResults 按 (kb, title) 稳定兜底", () => {
  const ranked = rankResults([
    { kb: "乙", docId: "b", title: "同名", engineRank: 0 },
    { kb: "甲", docId: "a", title: "同名", engineRank: 0 },
  ], { terms: [], boost: false });
  assert.deepEqual(ranked.map((item) => item.docId), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// 过滤与 facets
// ---------------------------------------------------------------------------

test("matchesFilters 标签精确匹配（不是子串）、类型与可信度", () => {
  const [d1, d2] = groups([hit("d1"), hit("d2")]);
  assert.equal(matchesFilters(d1, { tag: "新能源", type: "", trust: "" }), true);
  assert.equal(matchesFilters(d1, { tag: "新能", type: "", trust: "" }), false);
  assert.equal(matchesFilters(d1, { tag: "", type: "pdf-text", trust: "" }), true);
  assert.equal(matchesFilters(d1, { tag: "", type: "docx", trust: "" }), false);
  assert.equal(matchesFilters(d2, { tag: "", type: "", trust: "high" }), false);
  assert.equal(matchesFilters(d2, { tag: "", type: "", trust: "" }), true);
});

test("facetsOf 统计过滤前结果，按 count 降序、name 升序，最多 20 项", () => {
  const results = [
    ...groups([hit("d1")]),
    ...groups([hit("d1", { line: "第二条" })]),
    ...groups([hit("d2")]),
  ];
  const facets = facetsOf(results);
  assert.deepEqual(facets.tags.map((item) => item.name), ["并网", "新能源", "电能质量"]);
  assert.equal(facets.tags[0].count, 2);
  assert.deepEqual(facets.types, [{ name: "pdf-text", count: 3 }]);
  assert.deepEqual(facets.trust.map((item) => item.name).sort(), ["high", "medium"]);
  const many = Array.from({ length: 30 }, (_, index) => ({ tags: [`tag${String(index).padStart(2, "0")}`] }));
  assert.equal(facetsOf(many).tags.length, 20);
});

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

test("buildSearchResponse 分页、total、note 与公开字段", () => {
  const results = rankResults(
    groups([hit("d1", { pageStart: 3, pageEnd: 4, clause: "5.2.2" }), hit("d2", { pageStart: 2 }), hit("d3")]),
    { terms: ["电压"] },
  );
  const payload = buildSearchResponse({
    q: "电压",
    kb: "",
    kbs: ["标准"],
    terms: ["电压"],
    engine: "fts",
    indexBuilding: false,
    notes: ["索引构建中", "索引构建中", ""],
    results,
    facets: facetsOf(results),
    filters: normalizeSearchFilters({ limit: 2, offset: 1 }),
    tookMs: 12,
    estimated: false,
  });
  assert.equal(payload.total, 3);
  assert.equal(payload.offset, 1);
  assert.equal(payload.limit, 2);
  assert.equal(payload.results.length, 2);
  assert.equal(payload.note, "索引构建中");
  assert.equal(payload.estimated, false);
  assert.equal(payload.engine, "fts");
  const [first] = payload.results;
  assert.equal(first.page, 3);
  assert.equal(first.pageEnd, 4);
  assert.equal(first.clause, "5.2.2");
  assert.equal(first.deepLink, `/kb/?kb=${encodeURIComponent(KB)}&doc=d1&page=3&clause=5.2.2`);
  assert.ok(!("score" in first), "score 属于内部字段");
  assert.ok(!("line" in first));
  assert.ok(!("engineRank" in first));
  assert.equal(first.terms.length, 1);
});

test("buildSearchResponse 不输出相同的 pageEnd，缺少页码时省略 page", () => {
  const results = rankResults(groups([hit("d3", { pageStart: null, pageEnd: null, clause: "" })]), { terms: [] });
  const payload = buildSearchResponse({
    q: "光伏", kbs: ["标准"], terms: [], engine: "rg", notes: [],
    results, facets: facetsOf(results), filters: normalizeSearchFilters({}), tookMs: 1,
  });
  assert.equal(payload.results[0].page, null);
  assert.ok(!("pageEnd" in payload.results[0]));
  assert.equal(payload.results[0].deepLink, `/kb/?kb=${encodeURIComponent(KB)}&doc=d3`);
});

// ---------------------------------------------------------------------------
// 跨库编排
// ---------------------------------------------------------------------------

test("searchAll 合并多库、汇总 engine 与 note、单库失败不中断", async () => {
  const targets = [
    { kb: "标准", dir: "/tmp/a", docs: DOCS },
    { kb: "电能质量", dir: "/tmp/b", docs: [] },
    { kb: "坏库", dir: "/tmp/c", docs: [] },
  ];
  const seen = [];
  const outcome = await searchAll({
    targets,
    query: "电压偏差",
    filters: normalizeSearchFilters({}),
    searcher: async (target) => {
      seen.push(target.kb);
      if (target.kb === "坏库") throw new Error("spawn 失败");
      if (target.kb === "标准") return { engine: "fts", matches: [hit("d1"), hit("d2")], truncated: false };
      return { engine: "rg", matches: [hit("x1", { title: "另一个库的资料" })], truncated: true, note: "索引构建中" };
    },
  });
  assert.deepEqual(seen, ["标准", "电能质量", "坏库"]);
  assert.equal(outcome.results.length, 3);
  assert.equal(outcome.engine, "mixed");
  assert.equal(outcome.estimated, true);
  assert.ok(outcome.notes.some((note) => note.includes("坏库")), outcome.notes.join("|"));
  assert.ok(outcome.notes.includes("索引构建中"));
  assert.ok(outcome.terms.includes("电压"), outcome.terms.join("|"));
  assert.ok(outcome.terms.length <= 8);
  assert.ok(outcome.results[0].snippet.includes("命中行"));
});

test("searchAll 无匹配时 engine=none、结果为空", async () => {
  const outcome = await searchAll({
    targets: [{ kb: "标准", docs: DOCS }],
    query: "不存在的词",
    filters: normalizeSearchFilters({}),
    searcher: async () => ({ engine: "fts", matches: [] }),
  });
  assert.deepEqual(outcome.results, []);
  assert.equal(outcome.engine, "fts");
  assert.equal(outcome.estimated, false);
});

test("searchAll 过滤在归并之后、facets 反映过滤前", async () => {
  const outcome = await searchAll({
    targets: [{ kb: "标准", docs: DOCS }],
    query: "电压",
    filters: normalizeSearchFilters({ trust: "high" }),
    searcher: async () => ({ engine: "fts", matches: [hit("d1"), hit("d2")] }),
  });
  assert.deepEqual(outcome.results.map((item) => item.docId), ["d1"]);
  assert.ok(outcome.facets.trust.some((item) => item.name === "medium"), "facets 应包含被过滤掉的可信度");
});
