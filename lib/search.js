/**
 * 检索工作台核心：把引擎命中（FTS5 / ripgrep）归并成「文档级」结果，
 * 再做过滤、boost 排序、facets 与分页。纯逻辑 + 一个可注入 searcher 的编排函数，
 * 不读 HTTP、不读 DOM、不读盘。
 *
 * 口径（见 docs/specs/2026-10-27-search-workbench-design.md §4.3）：
 *  - 一条结果 = 一篇资料；(kb, docId) 去重，best hit 取引擎序第一条；
 *  - 排序 = 引擎序 base + 标题/标准号/标签/trust/新近度 boost（B 变体）；
 *  - boost=false 时只按引擎序（A 变体，评测脚本使用）。
 */
import { deepLinkFor, keywordsOfQuery } from "./sources.js";

export const SEARCH_LIMITS = Object.freeze({
  defaultLimit: 20,
  maxLimit: 50,
  maxOffset: 5000,
  maxQueryChars: 200,
  maxTerms: 8,
  snippetChars: 160,
});

const TRUST_VALUES = new Set(["high", "medium", "low", "unknown"]);
const TRUST_SCORE = { high: 1, medium: 0.5, unknown: 0, low: -0.5 };

/** 检索参数/输入错误；API 层据此映射 HTTP 状态码。 */
export class SearchError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "SearchError";
    this.code = code;
    this.status = status;
  }
}

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 校验并返回 trim 后的检索词；空/超长抛 SearchError。 */
export function validateQuery(value) {
  const query = String(value ?? "").trim();
  if (query === "") throw new SearchError("SEARCH_EMPTY", "检索词不能为空");
  if (query.length > SEARCH_LIMITS.maxQueryChars) {
    throw new SearchError("INVALID_ARGS", `检索词过长（最多 ${SEARCH_LIMITS.maxQueryChars} 字）`);
  }
  return query;
}

/** 过滤条件归一：tag/type 精确匹配，trust 白名单，limit/offset 夹取。 */
export function normalizeSearchFilters(input = {}) {
  const tag = typeof input.tag === "string" ? input.tag.trim() : "";
  const type = typeof input.type === "string" ? input.type.trim() : "";
  const trust = typeof input.trust === "string" ? input.trust.trim() : "";
  if (trust !== "" && !TRUST_VALUES.has(trust)) {
    throw new SearchError("INVALID_ARGS", "trust 只能是 high/medium/low/unknown");
  }
  return {
    tag,
    type,
    trust,
    limit: clampInt(input.limit, 1, SEARCH_LIMITS.maxLimit, SEARCH_LIMITS.defaultLimit),
    offset: clampInt(input.offset, 0, SEARCH_LIMITS.maxOffset, 0),
  };
}

function collapse(text) {
  return String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** FTS 命中行带 `[5.2.2] ` 前缀；结果里只保留正文。 */
function stripClausePrefix(line) {
  return String(line ?? "").replace(/^\[(?=[0-9A-Z])[0-9A-Za-z.\-]{1,20}\]\s+/, "");
}

/**
 * 围绕最早命中的检索词截一段（含两端省略号），总长不超过 maxChars。
 * 找不到命中词时取开头。命中词大小写不敏感，空词忽略。
 */
export function snippetAround(text, terms = [], maxChars = SEARCH_LIMITS.snippetChars) {
  const clean = collapse(text);
  if (clean === "") return "";
  const budget = Math.max(8, Math.round(Number(maxChars) || SEARCH_LIMITS.snippetChars));
  if (clean.length <= budget) return clean;
  const lower = clean.toLowerCase();
  let hitIndex = -1;
  let hitLength = 0;
  for (const raw of Array.isArray(terms) ? terms : []) {
    const term = String(raw ?? "").trim().toLowerCase();
    if (term === "") continue;
    const index = lower.indexOf(term);
    if (index === -1) continue;
    if (hitIndex === -1 || index < hitIndex || (index === hitIndex && term.length > hitLength)) {
      hitIndex = index;
      hitLength = term.length;
    }
  }
  if (hitIndex === -1) return `${clean.slice(0, budget - 1)}…`;
  const windowSize = budget - 2;
  let start = hitIndex - Math.floor(Math.max(0, windowSize - hitLength) / 2);
  start = Math.max(0, Math.min(start, clean.length - windowSize));
  let out = clean.slice(start, start + windowSize);
  if (start > 0) out = `…${out}`;
  if (start + windowSize < clean.length) out = `${out}…`;
  return out;
}

function docIndex(docs) {
  if (docs instanceof Map) return docs;
  return new Map((Array.isArray(docs) ? docs : []).map((doc) => [doc.id, doc]));
}

/**
 * 把逐条命中归并成文档级结果（保持引擎序）。
 * @returns Array<{kb,docId,title,standardNo,type,tags,trust,updatedAt,page,pageEnd,clause,line,hits,engineRank}>
 */
export function groupHitsByDoc(hits, { docs, kb = "" } = {}) {
  const byId = docIndex(docs);
  const groups = new Map();
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit || typeof hit.docId !== "string" || hit.docId === "") continue;
    let group = groups.get(hit.docId);
    if (group === undefined) {
      const doc = byId.get(hit.docId) ?? {};
      group = {
        kb: String(kb || hit.kb || ""),
        docId: hit.docId,
        title: String(doc.title ?? hit.title ?? hit.docId),
        standardNo: String(doc.standardNo ?? hit.standardNo ?? ""),
        type: String(doc.type ?? hit.type ?? ""),
        tags: Array.isArray(doc.tags) ? doc.tags.map((tag) => String(tag)) : [],
        trust: String(doc.trust ?? hit.trust ?? "unknown") || "unknown",
        updatedAt: String(doc.updatedAt ?? hit.updatedAt ?? ""),
        page: Number.isInteger(hit.pageStart) && hit.pageStart > 0 ? hit.pageStart : null,
        pageEnd: Number.isInteger(hit.pageEnd) && hit.pageEnd > 0 ? hit.pageEnd : null,
        clause: String(hit.clause ?? "").trim().slice(0, 40),
        line: stripClausePrefix(hit.line),
        hits: 0,
        engineRank: groups.size,
      };
      groups.set(hit.docId, group);
    }
    group.hits += 1;
  }
  return [...groups.values()];
}

/** 补 snippet/terms/deepLink 等展示字段。 */
export function finishResult(result, { terms = [] } = {}) {
  const page = Number.isInteger(result.page) && result.page > 0 ? result.page : null;
  const pageEnd = Number.isInteger(result.pageEnd) && result.pageEnd > 0 ? result.pageEnd : null;
  const clause = String(result.clause ?? "").trim().slice(0, 40);
  const cleanTerms = (Array.isArray(terms) ? terms : [])
    .map((term) => String(term ?? "").trim())
    .filter(Boolean)
    .slice(0, SEARCH_LIMITS.maxTerms);
  return {
    ...result,
    page,
    pageEnd,
    clause,
    snippet: snippetAround(result.line ?? "", cleanTerms, SEARCH_LIMITS.snippetChars),
    terms: cleanTerms,
    deepLink: deepLinkFor({ kb: result.kb, docId: result.docId, page, clause }),
  };
}

function compact(value) {
  return String(value ?? "").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]/g, "");
}

/** 标准号命中：删掉分隔符后双向包含（保证 GB/T 19963 不会奖励 GB 19963）。 */
function standardNoHit(standardNo, query, terms) {
  const target = compact(standardNo);
  if (target === "") return 0;
  const queryCompact = compact(query);
  if (queryCompact !== "" && (target.includes(queryCompact) || queryCompact.includes(target))) return 1;
  return terms.some((term) => {
    const value = compact(term);
    return value.length >= 4 && target.includes(value);
  }) ? 1 : 0;
}

function termHits(text, terms) {
  if (terms.length === 0) return 0;
  const haystack = String(text ?? "").toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (haystack.includes(String(term).toLowerCase())) hits += 1;
  }
  return hits;
}

function recencyScore(updatedAt) {
  const stamp = Date.parse(String(updatedAt ?? ""));
  if (!Number.isFinite(stamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - stamp) / 86_400_000);
  return 1 - Math.min(ageDays, 365) / 365;
}

/**
 * 单条结果得分。boost=false 只返回引擎序（1/(1+rank)），A 变体使用。
 */
export function scoreResult(result, { terms = [], query = "", boost = true } = {}) {
  const base = 1 / (1 + Math.max(0, Number(result?.engineRank) || 0));
  if (!boost) return base;
  const cleanTerms = (Array.isArray(terms) ? terms : []).filter((term) => String(term ?? "").trim() !== "");
  const titleRatio = cleanTerms.length === 0
    ? 0
    : termHits(result?.title, cleanTerms) / cleanTerms.length;
  const tagHit = cleanTerms.some((term) => (result?.tags ?? []).some((tag) => String(tag) === String(term))) ? 1 : 0;
  return base
    + 3 * titleRatio
    + 4 * standardNoHit(result?.standardNo, query ?? "", cleanTerms)
    + 1 * tagHit
    + (TRUST_SCORE[result?.trust] ?? 0)
    + 0.3 * recencyScore(result?.updatedAt);
}

function compareText(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""), "zh-Hans-CN");
}

/** 打分 + 排序（稳定兜底：kb、title、docId）。返回补全展示字段的结果。 */
export function rankResults(results, { terms = [], query = "", boost = true } = {}) {
  const scored = (Array.isArray(results) ? results : []).map((result, index) => ({
    result,
    index,
    score: scoreResult({ engineRank: index, ...result }, { terms, query, boost }),
  }));
  scored.sort((left, right) => right.score - left.score
    || compareText(left.result.kb, right.result.kb)
    || compareText(left.result.title, right.result.title)
    || compareText(left.result.docId, right.result.docId));
  return scored.map((entry) => finishResult(entry.result, { terms }));
}

/** 过滤在归并之后执行（manifest 字段，不进 FTS 查询）。 */
export function matchesFilters(result, filters = {}) {
  const tag = String(filters.tag ?? "").trim();
  if (tag !== "" && !(Array.isArray(result?.tags) ? result.tags : []).includes(tag)) return false;
  const type = String(filters.type ?? "").trim();
  if (type !== "" && String(result?.type ?? "") !== type) return false;
  const trust = String(filters.trust ?? "").trim();
  if (trust !== "" && String(result?.trust ?? "unknown") !== trust) return false;
  return true;
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) {
    const key = String(value ?? "").trim();
    if (key === "") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || compareText(left.name, right.name));
}

/** facets 反映「过滤前」的命中集合，便于用户切换标签/类型/可信度。 */
export function facetsOf(results, { max = 20 } = {}) {
  const list = Array.isArray(results) ? results : [];
  const tags = [];
  for (const result of list) for (const tag of result?.tags ?? []) tags.push(tag);
  const cap = Math.max(1, Math.round(Number(max) || 20));
  return {
    tags: countBy(tags).slice(0, cap),
    types: countBy(list.map((result) => result?.type)).slice(0, cap),
    trust: countBy(list.map((result) => result?.trust)).slice(0, cap),
  };
}

function publicResult(result) {
  const page = Number.isInteger(result.page) && result.page > 0 ? result.page : null;
  const clause = String(result.clause ?? "").trim();
  const out = {
    kb: result.kb,
    docId: result.docId,
    title: result.title,
    standardNo: String(result.standardNo ?? ""),
    page,
    clause,
    snippet: result.snippet ?? "",
    terms: Array.isArray(result.terms) ? result.terms : [],
    trust: String(result.trust ?? "unknown"),
    type: String(result.type ?? ""),
    tags: Array.isArray(result.tags) ? result.tags : [],
    hits: Number(result.hits) || 0,
    deepLink: result.deepLink ?? deepLinkFor({ kb: result.kb, docId: result.docId, page, clause }),
  };
  if (Number.isInteger(result.pageEnd) && result.pageEnd > 0 && result.pageEnd !== page) {
    out.pageEnd = result.pageEnd;
  }
  return out;
}

/**
 * 组装 HTTP 响应：分页 + 公开字段（内部 score/line/engineRank 不外泄）。
 */
export function buildSearchResponse({
  q = "",
  kb = "",
  kbs = [],
  terms = [],
  engine = "none",
  indexBuilding = false,
  notes = [],
  results = [],
  facets = null,
  filters = normalizeSearchFilters({}),
  tookMs = 0,
  estimated = false,
} = {}) {
  const all = Array.isArray(results) ? results : [];
  const offset = Math.max(0, Math.round(Number(filters.offset) || 0));
  const limit = Math.max(1, Math.round(Number(filters.limit) || SEARCH_LIMITS.defaultLimit));
  const page = all.slice(offset, offset + limit);
  const note = [...new Set((Array.isArray(notes) ? notes : []).map((item) => String(item ?? "").trim()).filter(Boolean))].join("；");
  return {
    q: String(q ?? ""),
    kb: String(kb ?? ""),
    kbs: Array.isArray(kbs) ? kbs.map((name) => String(name)) : [],
    terms: (Array.isArray(terms) ? terms : []).slice(0, SEARCH_LIMITS.maxTerms),
    engine: String(engine ?? "none"),
    indexBuilding: indexBuilding === true,
    note,
    total: all.length,
    estimated: estimated === true,
    offset,
    limit,
    tookMs: Math.max(0, Math.round(Number(tookMs) || 0)),
    facets: facets ?? { tags: [], types: [], trust: [] },
    results: page.map(publicResult),
  };
}

/**
 * 跨库检索编排：逐库调用注入的 searcher，归并 → 排序 → facets → 过滤。
 * 单个库失败只记录 note，不中断其他库（检索是只读操作，不该整页报错）。
 * @returns {terms, engine, indexBuilding, notes, facets, results, estimated}
 */
export async function searchAll({
  targets = [],
  query,
  filters = normalizeSearchFilters({}),
  searcher,
  boost = true,
} = {}) {
  const terms = keywordsOfQuery(query).slice(0, SEARCH_LIMITS.maxTerms);
  const engines = new Set();
  const notes = [];
  const groups = [];
  let indexBuilding = false;
  let truncated = false;
  for (const target of Array.isArray(targets) ? targets : []) {
    let outcome;
    try {
      outcome = await searcher(target);
    } catch {
      notes.push(`${target?.kb ?? "知识库"} 检索失败`);
      continue;
    }
    if (!outcome) continue;
    if (outcome.indexBuilding === true) indexBuilding = true;
    if (outcome.truncated === true) truncated = true;
    if (typeof outcome.note === "string" && outcome.note !== "") notes.push(outcome.note);
    if (typeof outcome.engine === "string" && outcome.engine !== "") engines.add(outcome.engine);
    groups.push(...groupHitsByDoc(outcome.matches ?? [], { docs: target?.docs, kb: target?.kb ?? "" }));
  }
  const ranked = rankResults(groups, { terms, query, boost });
  const facets = facetsOf(ranked);
  const results = ranked.filter((result) => matchesFilters(result, filters));
  const engine = engines.size === 0 ? "none" : engines.size === 1 ? [...engines][0] : "mixed";
  return {
    terms,
    engine,
    indexBuilding,
    notes,
    facets,
    results,
    estimated: truncated || engine !== "fts",
  };
}
