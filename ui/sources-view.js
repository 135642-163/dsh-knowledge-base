/** 来源纯函数：工作台与客户端 tool view 共用（无 DOM、无 node 依赖）。 */

export function sourceHref(source) {
  if (!source || typeof source.docId !== "string") return "";
  if (typeof source.deepLink === "string" && source.deepLink !== "") return source.deepLink;
  const params = new URLSearchParams();
  if (source.kb) params.set("kb", String(source.kb));
  params.set("doc", source.docId);
  if (Number.isInteger(source.page) && source.page > 0) params.set("page", String(source.page));
  if (source.clause) params.set("clause", String(source.clause));
  return `/kb/?${params.toString()}`;
}

export function sourceLabel(source) {
  if (!source) return "";
  const parts = [String(source.title ?? source.docId ?? "")];
  if (source.clause) parts.push(`第 ${source.clause} 条`);
  if (Number.isInteger(source.page) && source.page > 0) parts.push(`第 ${source.page} 页`);
  if (source.kb) parts.push(`来自 ${source.kb}`);
  return parts.join(" · ");
}

export function dedupeSources(sources, max = 20) {
  const out = [];
  const seen = new Set();
  for (const source of sources ?? []) {
    if (!source || typeof source.docId !== "string" || source.docId === "") continue;
    const key = `${source.kb ?? ""}\u0000${source.docId}\u0000${source.page ?? ""}\u0000${source.clause ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 按文档合并来源：同一篇资料的多个命中位置（不同页/条款）只保留一张卡片。
 *
 * 为什么不在服务端合并：kb_query 的 `sources` 还要给模型做逐条定位；界面末尾的
 * 「引用资料」是整篇回答级的，重复卡片只会拉长列表。合并后 `pages/clauses`
 * 保留全部命中位置，点击仍跳到第一条命中页。
 */
export function mergeSourcesByDoc(sources, max = 20) {
  const out = [];
  const byKey = new Map();
  for (const source of sources ?? []) {
    if (!source || typeof source.docId !== "string" || source.docId === "") continue;
    const key = `${source.kb ?? ""}\u0000${source.docId}`;
    const page = Number.isInteger(source.page) && source.page > 0 ? source.page : null;
    const pageEnd = Number.isInteger(source.pageEnd) && source.pageEnd > (page ?? 0) ? source.pageEnd : null;
    const clause = typeof source.clause === "string" ? source.clause.trim() : "";
    let entry = byKey.get(key);
    if (entry === undefined) {
      // 达到卡片上限后不再新增资料，但仍继续合并已出现资料的其它命中页。
      if (out.length >= max) continue;
      entry = {
        ...source,
        ...(page !== null ? { pages: [page] } : {}),
        ...(clause !== "" ? { clauses: [clause] } : {}),
      };
      byKey.set(key, entry);
      out.push(entry);
      continue;
    }
    if (page !== null) {
      entry.pages ??= [];
      if (!entry.pages.includes(page)) entry.pages.push(page);
      // 第一条命中没有页码时，补一个可跳转的页码；有页码时保留第一条（引擎最优）定位。
      if (!Number.isInteger(entry.page) || entry.page <= 0) entry.page = page;
    }
    if (pageEnd !== null && page !== null) {
      entry.pages ??= [];
      // 只展开一小段页范围，避免异常 pageEnd 把数组撑爆。
      for (let pageNo = page + 1; pageNo <= Math.min(pageEnd, page + 20); pageNo += 1) {
        if (!entry.pages.includes(pageNo)) entry.pages.push(pageNo);
      }
    }
    if (clause !== "") {
      entry.clauses ??= [];
      if (!entry.clauses.includes(clause)) entry.clauses.push(clause);
    }
    if (Array.isArray(source.keywords) && source.keywords.length > 0) {
      const merged = [...new Set([...(Array.isArray(entry.keywords) ? entry.keywords : []), ...source.keywords])];
      entry.keywords = merged.slice(0, 8);
    }
    if (!entry.snippet && source.snippet) entry.snippet = source.snippet;
  }
  for (const entry of out) {
    if (Array.isArray(entry.pages)) entry.pages.sort((left, right) => left - right);
    if (Array.isArray(entry.clauses)) entry.clauses = entry.clauses.slice(0, 6);
  }
  return out;
}
