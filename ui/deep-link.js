/** 工作台深链：/kb/?kb=&doc=&page=&clause= → 预览弹窗参数。 */

export function parsePreviewDeepLink(search) {
  const value = String(search ?? "");
  const params = new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
  const kb = String(params.get("kb") ?? "").trim();
  const docId = String(params.get("doc") ?? "").trim();
  const clause = String(params.get("clause") ?? "").trim();
  const rawPage = Number(params.get("page"));
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.round(rawPage) : null;
  return { kb, docId, page, clause };
}

export function clampPage(page, pages) {
  const total = Math.max(0, Math.round(Number(pages) || 0));
  if (total <= 0) return 1;
  const value = Math.round(Number(page) || 1);
  return Math.min(total, Math.max(1, value));
}

export function withPageFragment(url, page) {
  if (!Number.isInteger(page) || page <= 0) return String(url);
  const [base, hash = ""] = String(url).split("#");
  const suffix = `page=${page}&zoom=page-fit`;
  return `${base}#${hash ? `${hash}&${suffix}` : suffix}`;
}
