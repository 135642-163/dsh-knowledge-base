/**
 * 0.29 评测用的纯函数：RRF 融合、条款行 → 文档级顺序、嵌入文本拼装。
 * 不读盘、不依赖插件运行时；供 eval-benchmark.mjs / build-corpus.mjs 与单测共用。
 */

/**
 * 倒数排名融合：两个「已按相关性排好序」的 clause id 列表。
 * score = 1/(k+rank_lex) + 1/(k+rank_dense)；k 越大排名差异越平缓。
 * @returns {Array<{id:number|string,score:number}>} 按 score 降序、id 升序稳定兜底
 */
export function rrfFuse({ lexical = [], dense = [], k = 60 } = {}) {
  const scores = new Map();
  const add = (ids, weight) => {
    ids.forEach((id, index) => {
      // 允许数字（clause id）与字符串（doc id）；空值与非有限数字忽略。
      if (id === null || id === undefined || id === "") return;
      if (typeof id === "number" && !Number.isFinite(id)) return;
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank));
    });
  };
  add(lexical, 1);
  add(dense, 1);
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .map(([id, score]) => ({ id, score }));
}

/**
 * 条款行（按相关性排好序）→ 文档级顺序 + 每篇文档的页码区间。
 * rows: { docId, page, pageEnd? }；同一文档只保留首次出现位置。
 */
export function rowsToDocOrder(rows = [], topK = 10) {
  const docOrder = [];
  const seen = new Set();
  const pages = new Map();
  for (const row of rows) {
    if (!row || typeof row.docId !== "string" || row.docId === "") continue;
    if (!pages.has(row.docId)) pages.set(row.docId, []);
    pages.get(row.docId).push({ pageStart: row.page ?? null, pageEnd: row.pageEnd ?? row.page ?? null });
    if (seen.has(row.docId)) continue;
    seen.add(row.docId);
    docOrder.push(row.docId);
  }
  return { docOrder: docOrder.slice(0, Math.max(1, topK)), pages };
}

function collapse(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** 条款的嵌入文本：标准号 + 标题 + 条款号 + 小标题 + 正文，截断到 maxChars。 */
export function clauseText(row, maxChars = 480) {
  const head = [
    row?.standardNo,
    row?.title,
    row?.clause ? `第${row.clause}条` : "",
    row?.heading,
  ].filter((part) => String(part ?? "").trim() !== "").join(" ");
  const body = collapse(row?.text);
  return `${head}：${body}`.slice(0, Math.max(8, Math.round(Number(maxChars) || 480))).trim();
}
