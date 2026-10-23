/** Hash 路由：只认 #/、#/trash 与 #/kb/<name>/<tab>，其余回退总览。 */
export function parseHash(hash = "") {
  const raw = String(hash ?? "").replace(/^#/, "");
  const [path, queryString = ""] = raw.split("?");
  const segments = path.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const query = Object.fromEntries(new URLSearchParams(queryString));
  if (segments.length === 0) return { page: "overview", query };
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
