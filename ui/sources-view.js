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
