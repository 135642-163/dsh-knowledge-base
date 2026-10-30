/**
 * 检索页纯函数：hash 条件 <-> state、关键词高亮、状态文案、结果合并。
 *
 * 高亮是安全边界：`applyHighlights` 只创建文本节点与 `<mark>`，绝不把命中文本
 * 拼进 HTML 字符串（资料标题/正文由用户或 OCR 产生，必须按文本处理）。
 */

/** 输入防抖：与资料页/回收站保持一致的 300ms。 */
export const SEARCH_DELAY = 300;

export const SEARCH_PAGE_SIZE = 20;

export const SEARCH_TRUST_OPTIONS = Object.freeze([
  { value: "", label: "全部可信度" },
  { value: "high", label: "高可信" },
  { value: "medium", label: "中可信" },
  { value: "low", label: "低可信" },
  { value: "unknown", label: "未标注" },
]);

export const SEARCH_TYPE_OPTIONS = Object.freeze([
  { value: "", label: "全部类型" },
  { value: "pdf-text", label: "PDF（文字版）" },
  { value: "pdf-scanned", label: "PDF（扫描版）" },
  { value: "pdf-mixed", label: "PDF（混合）" },
  { value: "docx", label: "Word" },
  { value: "pptx", label: "PPT" },
  { value: "xlsx", label: "Excel" },
  { value: "epub", label: "EPUB" },
  { value: "markdown", label: "Markdown" },
  { value: "text", label: "纯文本" },
  { value: "note", label: "笔记" },
]);

const TRUST_VALUES = new Set(SEARCH_TRUST_OPTIONS.map((item) => item.value).filter(Boolean));

const ENGINE_LABEL = { fts: "条款索引", rg: "全文回退", mixed: "混合引擎", hybrid: "语义", none: "" };

/** 从 hash 的 query 归一检索条件；非法 trust 直接忽略（不把脏值发给服务端）。 */
export function searchStateFromQuery(query = {}) {
  const trust = String(query?.trust ?? "").trim();
  return {
    q: String(query?.q ?? "").trim(),
    kb: String(query?.kb ?? "").trim(),
    tag: String(query?.tag ?? "").trim(),
    type: String(query?.type ?? "").trim(),
    trust: TRUST_VALUES.has(trust) ? trust : "",
  };
}

/** 检索条件 -> hash query string（顺序固定：kb/tag/type/trust/q）。 */
export function searchParamsOf(state = {}) {
  const query = new URLSearchParams();
  if (state.kb) query.set("kb", String(state.kb));
  if (state.tag) query.set("tag", String(state.tag));
  if (state.type) query.set("type", String(state.type));
  if (state.trust) query.set("trust", String(state.trust));
  const q = String(state.q ?? "").trim();
  if (q !== "") query.set("q", q);
  return query.toString();
}

export function resultKey(result) {
  return `${String(result?.kb ?? "")}\u0000${String(result?.docId ?? "")}`;
}

/** 追加加载时合并结果：同一 (kb, docId) 只保留先出现的一条。 */
export function mergeResults(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const result of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const key = resultKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

/** 是否还有下一页（total 与已取条数比较）。 */
export function hasMore(payload = {}) {
  const total = Math.max(0, Math.round(Number(payload?.total) || 0));
  const offset = Math.max(0, Math.round(Number(payload?.offset) || 0));
  const count = Array.isArray(payload?.results) ? payload.results.length : 0;
  return total > offset + count;
}

/** 「命中 12 篇 · 条款索引 · 34ms · 提示」 */
export function searchStatusLine(payload = {}) {
  const total = Math.max(0, Math.round(Number(payload?.total) || 0));
  const parts = [`命中 ${total} 篇`];
  const engine = ENGINE_LABEL[String(payload?.engine ?? "")] ?? "";
  if (engine !== "") parts.push(engine);
  const tookMs = Math.round(Number(payload?.tookMs) || 0);
  if (tookMs > 0) parts.push(`${tookMs}ms`);
  if (payload?.estimated === true) parts.push("结果为预计值");
  if (payload?.indexBuilding === true) parts.push("索引构建中，本次回退全文检索");
  const note = String(payload?.note ?? "").trim();
  if (note !== "") parts.push(note);
  return parts.join(" · ");
}

function cleanTerms(terms) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(terms) ? terms : []) {
    const term = String(raw ?? "").trim();
    if (term === "" || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
  }
  // 长词优先：重叠时由长词吃掉，避免嵌套高亮。
  return out.sort((left, right) => right.length - left.length);
}

/**
 * 把文本切成 [{text, hit}]：大小写不敏感；重叠命中合并成一段；正则字符按字面量处理。
 * 空文本返回空数组；没有命中词时返回单个未命中片段。
 */
export function highlightSegments(text, terms = []) {
  const value = String(text ?? "");
  if (value === "") return [];
  const words = cleanTerms(terms);
  if (words.length === 0) return [{ text: value, hit: false }];
  const lower = value.toLowerCase();
  if (lower.length !== value.length) {
    // 极少数语言大小写映射会改变长度，退化为原始文本逐字匹配，避免切错索引。
    return [{ text: value, hit: false }];
  }
  const ranges = [];
  for (const word of words) {
    const needle = word.toLowerCase();
    let from = 0;
    for (;;) {
      const index = lower.indexOf(needle, from);
      if (index === -1) break;
      ranges.push([index, index + needle.length]);
      from = index + needle.length;
    }
  }
  if (ranges.length === 0) return [{ text: value, hit: false }];
  ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] < last[1]) {
      last[1] = Math.max(last[1], range[1]);
      continue;
    }
    merged.push([range[0], range[1]]);
  }
  const segments = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: value.slice(cursor, start), hit: false });
    segments.push({ text: value.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), hit: false });
  return segments;
}

/**
 * 把文本以「文本节点 + <mark>」写进容器（容器必须是空的）。
 * @returns 高亮段落数
 */
export function applyHighlights(doc, container, text, terms = []) {
  if (!container || typeof container.appendChild !== "function") return 0;
  const segments = highlightSegments(text, terms);
  let marks = 0;
  for (const segment of segments) {
    if (segment.text === "") continue;
    if (segment.hit) {
      const mark = doc.createElement("mark");
      mark.appendChild(doc.createTextNode(segment.text));
      container.appendChild(mark);
      marks += 1;
    } else {
      container.appendChild(doc.createTextNode(segment.text));
    }
  }
  return marks;
}
