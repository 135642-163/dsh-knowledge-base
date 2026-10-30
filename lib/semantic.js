/**
 * 0.31 可选语义层：纯函数（Task 1）。
 *
 * 这里只放「给定数据算结果」的逻辑，不读盘、不加载模型、不依赖知识库目录：
 *  - 向量：L2 归一化、余弦 topK（文档级 dense 候选）；
 *  - 融合：文档级 RRF（B 的 boost 文档序 + dense 文档序，k=20）；
 *  - 排序修正：词面强命中判定（标题命中 + 条款命中 ≥2 个不同词 + trust != low）；
 *  - 两阶段页码：B 已命中直接用；dense 独有文档用单文档 FTS 首条条款补页码；
 *    都没有时 page=null 并标注 source。
 *
 * 口径与 `scripts/eval/fusion.mjs` 的 rrfFuse 保持一致：生产侧不能 import 评测脚本
 * （scripts/ 不进 npm 包），单测用同一输入逐条比对两边结果。
 */

export const SEMANTIC_LIMITS = Object.freeze({
  /** dense 文档候选数（与 0.30 评测的 top-50 一致）。 */
  denseTopK: 50,
  /** RRF 常数：score = 1/(k+rank_lex) + 1/(k+rank_dense)。 */
  rrfK: 20,
  /** 强词面命中要求条款内命中的「不同查询词」数下限。 */
  strongMinTerms: 2,
});

/**
 * L2 归一化。零向量、空向量、含非有限值的向量返回 null（调用方按缺向量处理）。
 * 返回新的 Float32Array，不改写入参。
 */
export function normalizeVector(vector) {
  const input = vector ?? [];
  const length = input.length ?? 0;
  if (!Number.isInteger(length) || length <= 0) return null;
  let norm = 0;
  for (let index = 0; index < length; index += 1) {
    const value = Number(input[index]);
    if (!Number.isFinite(value)) return null;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 0) return null;
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) out[index] = Number(input[index]) / norm;
  return out;
}

/**
 * 余弦 topK。`query` 与 `vectors` 都应是已归一化向量（相似度 = 点积）；
 * 维度不符或含非有限值的候选跳过（索引损坏时退化为少几条，而不是整次检索失败）。
 * 并列按输入顺序稳定兜底。
 * @returns Array<{id: string|number, score: number}> 按分数降序
 */
export function cosineTopK({ query, vectors = [], ids = [], k = SEMANTIC_LIMITS.denseTopK } = {}) {
  const dim = query?.length ?? 0;
  const limit = Math.max(0, Math.round(Number(k) || 0));
  const list = Array.isArray(vectors) ? vectors : [];
  const idList = Array.isArray(ids) ? ids : [];
  if (dim === 0 || limit === 0 || list.length === 0) return [];
  const scored = [];
  for (let index = 0; index < list.length; index += 1) {
    const vector = list[index];
    if (!vector || vector.length !== dim) continue;
    let score = 0;
    let valid = true;
    for (let offset = 0; offset < dim; offset += 1) {
      const value = Number(vector[offset]);
      if (!Number.isFinite(value)) {
        valid = false;
        break;
      }
      score += Number(query[offset]) * value;
    }
    if (!valid || !Number.isFinite(score)) continue;
    scored.push({ id: idList[index] ?? index, score, order: index });
  }
  scored.sort((left, right) => right.score - left.score || left.order - right.order);
  return scored.slice(0, limit).map(({ id, score }) => ({ id, score }));
}

/**
 * 文档级倒数排名融合：`lexical` 是 B 的文档序，`dense` 是文档向量余弦序。
 * 忽略空 id 与非有限数字；同分时数字 id 升序（与评测脚本一致），字符串 id 按首次出现。
 * @returns Array<{id: string|number, score: number}> 按分数降序
 */
export function fuseDocRrf({ lexical = [], dense = [], k = SEMANTIC_LIMITS.rrfK } = {}) {
  const constant = Number.isFinite(Number(k)) && Number(k) > 0 ? Number(k) : SEMANTIC_LIMITS.rrfK;
  const scores = new Map();
  const add = (ids) => {
    const list = Array.isArray(ids) ? ids : [];
    list.forEach((id, index) => {
      if (id === null || id === undefined || id === "") return;
      if (typeof id === "number" && !Number.isFinite(id)) return;
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (constant + rank));
    });
  };
  add(lexical);
  add(dense);
  return [...scores.entries()]
    .map(([id, score], order) => ({ id, score, order }))
    .sort((left, right) => right.score - left.score
      || (typeof left.id === "number" && typeof right.id === "number"
        ? left.id - right.id
        : left.order - right.order))
    .map(({ id, score }) => ({ id, score }));
}

function clauseText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  return [value.line, value.text, value.heading]
    .filter((part) => typeof part === "string" && part !== "")
    .join(" ");
}

/**
 * 强词面命中：用于把 B 的词面 top-1 锁定在融合结果第一位（只影响排序，不改召回集）。
 * 三个条件必须同时满足：
 *  1. 查询词命中标题（至少 1 个 length≥2 的词）；
 *  2. 该文档最佳条款命中 ≥2 个不同查询词；
 *  3. 文档 trust != low（草案/已废止不锁定）。
 * 单字词不参与匹配（与 keywordsOfQuery 的口径一致）。
 */
export function isStrongLexicalHit({ terms = [], topDoc = null, topClause = null, query = "" } = {}) {
  if (!topDoc || !topClause) return false;
  if (String(topDoc.trust ?? "unknown") === "low") return false;
  const cleanTerms = [...new Set((Array.isArray(terms) ? terms : [])
    .map((term) => String(term ?? "").trim().toLowerCase())
    .filter((term) => term.length >= 2))];
  if (cleanTerms.length < SEMANTIC_LIMITS.strongMinTerms) return false;
  const title = String(topDoc.title ?? "").toLowerCase();
  const titleHit = cleanTerms.some((term) => title.includes(term)) || sharesCjkBigram(title, query);
  if (!titleHit) return false;
  const clause = clauseText(topClause).toLowerCase();
  let hits = 0;
  for (const term of cleanTerms) {
    if (clause.includes(term)) hits += 1;
  }
  return hits >= SEMANTIC_LIMITS.strongMinTerms;
}

/** 标题与查询共享任一 CJK 二字片段（keywordsOfQuery 会切出长片段，纯子串命中会漏）。 */
function sharesCjkBigram(title, query) {
  const runs = String(query ?? "").match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const run of runs) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      if (title.includes(run.slice(index, index + 2))) return true;
    }
  }
  return false;
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** 条款行与 `lib/query.js` 的 FTS 命中行同格式：`[5.2.2] 标题 — 正文`。 */
function clauseLine(row) {
  const clause = String(row?.clause ?? "").trim();
  const heading = String(row?.heading ?? "").trim();
  const text = String(row?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  return `${clause ? `[${clause}] ` : ""}${heading ? `${heading} — ` : ""}${text}`;
}

/**
 * 两阶段页码定位（纯函数）：
 *  1. 该文档已在 B 的条款命中里 → 直接用 B 的首条命中（现状口径）；
 *  2. 只在 dense 命中 → 用该文档内单文档 FTS 的首条条款（BM25 序）的 pageStart/clause；
 *  3. 都没有 → page=null、clause=""、source=none（卡片显示「无页码」，不伪造）。
 * `pageEnd` 只在确实大于 `page` 时返回，避免展示重复页码。
 * @returns {{page: number|null, pageEnd: number|null, clause: string, line: string,
 *   source: "lexical"|"doc-fts"|"none"}}
 */
export function locatePageInDoc({ docHits = [], ftsMatches = [] } = {}) {
  const hits = Array.isArray(docHits) ? docHits : [];
  const fts = Array.isArray(ftsMatches) ? ftsMatches : [];
  if (hits.length > 0) {
    const hit = hits[0] ?? {};
    const page = positiveInt(hit.page ?? hit.pageStart);
    const pageEndRaw = positiveInt(hit.pageEnd);
    return {
      page,
      pageEnd: pageEndRaw !== null && pageEndRaw !== page ? pageEndRaw : null,
      clause: String(hit.clause ?? "").trim().slice(0, 40),
      line: String(hit.line ?? ""),
      source: "lexical",
    };
  }
  if (fts.length > 0) {
    const row = fts[0] ?? {};
    const page = positiveInt(row.pageStart ?? row.page);
    const pageEndRaw = positiveInt(row.pageEnd);
    return {
      page,
      pageEnd: pageEndRaw !== null && pageEndRaw !== page ? pageEndRaw : null,
      clause: String(row.clause ?? "").trim().slice(0, 40),
      line: clauseLine(row),
      source: "doc-fts",
    };
  }
  return { page: null, pageEnd: null, clause: "", line: "", source: "none" };
}
