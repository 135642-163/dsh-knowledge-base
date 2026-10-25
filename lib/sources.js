/**
 * 检索/精读结果的结构化来源：把 docId/part/page/clause 组合成可点击深链。
 * 只做纯数据；路径与绝对文件系统信息不进入返回值。
 */

export function deepLinkFor({ kb, docId, page = null, clause = "" }) {
  const params = new URLSearchParams();
  if (kb) params.set("kb", String(kb));
  if (docId) params.set("doc", String(docId));
  if (Number.isInteger(page) && page > 0) params.set("page", String(page));
  if (clause) params.set("clause", String(clause));
  const query = params.toString();
  return `/kb/${query ? `?${query}` : ""}`;
}

export function snippetOf(text, maxChars = 160) {
  const value = String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

const QUERY_STOP = /^(?:的|了|和|与|在|中|请|查找|搜索|检索|资料|标准|关于|以及|这个|那个|如何|什么|哪些|多少|是否|可以|需要|进行|一个|其中|以及|并|及)$/;

/** 从用户查询提取用于 PDF 高亮的短词；不做语义扩展。 */
export function keywordsOfQuery(query) {
  const value = String(query ?? "");
  const words = [];
  try {
    const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    for (const item of segmenter.segment(value)) {
      const word = String(item.segment ?? "").trim();
      if (word.length >= 2 && /[\u4e00-\u9fa5A-Za-z0-9]/.test(word)) words.push(word);
    }
  } catch {
    /* fallback below */
  }
  words.push(...(value.match(/[\u4e00-\u9fa5]{2,8}|[A-Za-z][A-Za-z0-9/._-]{1,30}|\d+(?:\.\d+){1,6}/g) ?? []));
  const out = [];
  const seen = new Set();
  for (const raw of words) {
    const word = raw.trim();
    if (word.length < 2 || QUERY_STOP.test(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= 8) break;
  }
  return out;
}

export function normalizeSource(source) {
  if (!source || typeof source !== "object") return null;
  if (typeof source.docId !== "string" || source.docId === "") return null;
  const page = Number.isInteger(source.page) && source.page > 0 ? source.page : null;
  const clause = typeof source.clause === "string" && source.clause.trim() !== ""
    ? source.clause.trim().slice(0, 40)
    : "";
  return {
    kb: String(source.kb ?? ""),
    docId: source.docId,
    title: String(source.title ?? source.docId),
    ...(page !== null ? { page } : {}),
    ...(Number.isInteger(source.pageEnd) && source.pageEnd !== page ? { pageEnd: source.pageEnd } : {}),
    ...(clause !== "" ? { clause } : {}),
    ...(Array.isArray(source.keywords) && source.keywords.length > 0
      ? { keywords: source.keywords.map((word) => String(word).slice(0, 40)).filter(Boolean).slice(0, 8) }
      : {}),
    snippet: snippetOf(source.snippet, 160),
    deepLink: deepLinkFor({ kb: source.kb, docId: source.docId, page, clause }),
  };
}

export function dedupeSources(sources, { max = 20 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of sources ?? []) {
    const source = normalizeSource(raw);
    if (!source) continue;
    const key = `${source.kb}\u0000${source.docId}\u0000${source.page ?? ""}\u0000${source.clause ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
    if (out.length >= max) break;
  }
  return out;
}

export function sourcesFromMatches(matches, kb, { max = 20, query = "" } = {}) {
  const keywords = keywordsOfQuery(query);
  return dedupeSources(
    (matches ?? []).map((match) => ({
      kb: match.kb ?? kb,
      docId: match.docId,
      title: match.title,
      page: match.pageStart ?? match.page ?? null,
      pageEnd: match.pageEnd ?? null,
      clause: match.clause ?? "",
      ...(keywords.length > 0 ? { keywords } : {}),
      snippet: match.line ?? "",
    })),
    { max }
  );
}

/** 从分块正文的「### 第 N 页」标记定位条款所在页；找不到时返回 null。 */
export function pageOfClause(text, clause) {
  if (!clause) return null;
  let page = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const pageMatch = /^#{1,6}\s*第\s*(\d+)\s*页\s*$/.exec(line.trim());
    if (pageMatch) {
      page = Number(pageMatch[1]);
      continue;
    }
    if (page === null) continue;
    const clauseMatch = /^#{0,6}\s*(\d+(?:\.\d+){1,5})(?:\s+|$)/.exec(line);
    if (clauseMatch && clauseMatch[1] === String(clause)) return page;
  }
  return null;
}
