/** Hash 路由：只认 #/、#/search、#/trash 与 #/kb/<name>/<tab>，其余回退总览。 */
export function parseHash(hash = "") {
  const raw = String(hash ?? "").replace(/^#/, "");
  const [path, queryString = ""] = raw.split("?");
  const segments = path.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const query = Object.fromEntries(new URLSearchParams(queryString));
  if (segments.length === 0) return { page: "overview", query };
  if (segments[0] === "search") return { page: "search", query };
  if (segments[0] === "trash") return { page: "trash", query };
  if (segments[0] === "kb" && segments[1]) {
    return { page: "detail", name: segments[1], tab: segments[2] || "overview", query };
  }
  return { page: "overview", query };
}

export function hrefForKb(name, tab = "overview") {
  return `#/kb/${encodeURIComponent(name)}/${tab}`;
}

export function hrefForTrash() {
  return "#/trash";
}

export function hrefForOverview() {
  return "#/";
}

/** 检索页 href：跳过空条件，q 放最后（短 URL 更好读）。 */
export function hrefForSearch(params = {}) {
  const query = new URLSearchParams();
  if (params.kb) query.set("kb", String(params.kb));
  if (params.tag) query.set("tag", String(params.tag));
  if (params.type) query.set("type", String(params.type));
  if (params.trust) query.set("trust", String(params.trust));
  const q = String(params.q ?? "").trim();
  if (q !== "") query.set("q", q);
  const value = query.toString();
  return `#/search${value === "" ? "" : `?${value}`}`;
}
