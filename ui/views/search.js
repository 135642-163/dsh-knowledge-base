/**
 * 检索页渲染（纯字符串）。摘要正文不拼进 HTML：只输出空容器 + data-hl 下标，
 * 由 app.js 渲染后用 applyHighlights 以文本节点填充（XSS 边界）。
 */
import {
  SEARCH_TRUST_OPTIONS,
  SEARCH_TYPE_OPTIONS,
  hasMore,
  searchStatusLine,
} from "../search-core.js";

const TYPE_LABEL = new Map(SEARCH_TYPE_OPTIONS.filter((item) => item.value !== "").map((item) => [item.value, item.label]));
const TRUST_LABEL = new Map(SEARCH_TRUST_OPTIONS.filter((item) => item.value !== "").map((item) => [item.value, item.label]));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

const escapeAttr = escapeHtml;

function option(value, label, current) {
  return `<option value="${escapeAttr(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function toolbar(state, { icons }) {
  const search = state.search ?? {};
  const kbs = Array.isArray(state.kbs) ? state.kbs : [];
  const facets = search.facets && Array.isArray(search.facets.tags) ? search.facets.tags : [];
  const tags = [...facets];
  if (search.tag && !tags.some((item) => item.name === search.tag)) tags.unshift({ name: search.tag, count: 0 });
  const active = Boolean(search.appliedQ) || Boolean(search.kb || search.tag || search.type || search.trust);
  return `
    <div class="search-toolbar">
      <div class="search-form">
        <input type="search" data-search-query value="${escapeAttr(search.q ?? "")}"
               placeholder="搜索正文与条款…" aria-label="全文检索" autocomplete="off" />
        <button class="btn primary" type="button" data-action="search-submit">${icons.search ?? ""}<span>搜索</span></button>
      </div>
      <div class="search-filters">
        <select data-search-filter="kb" data-search-kb aria-label="按知识库筛选">
          ${option("", "全部知识库", String(search.kb ?? ""))}
          ${kbs.map((kb) => option(String(kb.name), String(kb.name), String(search.kb ?? ""))).join("")}
        </select>
        <select data-search-filter="tag" data-search-tag aria-label="按标签筛选">
          ${option("", "全部标签", String(search.tag ?? ""))}
          ${tags.map((item) => option(item.name, item.count > 0 ? `${item.name}（${item.count}）` : item.name, String(search.tag ?? ""))).join("")}
        </select>
        <select data-search-filter="type" data-search-type aria-label="按类型筛选">
          ${SEARCH_TYPE_OPTIONS.map((item) => option(item.value, item.label, String(search.type ?? ""))).join("")}
        </select>
        <select data-search-filter="trust" data-search-trust aria-label="按可信度筛选">
          ${SEARCH_TRUST_OPTIONS.map((item) => option(item.value, item.label, String(search.trust ?? ""))).join("")}
        </select>
        ${active ? `<button class="btn" type="button" data-search-clear>清除条件</button>` : ""}
      </div>
      ${search.appliedQ
        ? `<p class="muted search-status" aria-live="polite">${escapeHtml(searchStatusLine({ ...search, total: search.total ?? 0 }))}</p>`
        : ""}
    </div>
  `;
}

function card(result, index) {
  const kb = String(result?.kb ?? "");
  const docId = String(result?.docId ?? "");
  const page = Number.isInteger(result?.page) && result.page > 0 ? String(result.page) : "";
  const clause = String(result?.clause ?? "");
  const trust = String(result?.trust ?? "unknown");
  const type = TYPE_LABEL.get(String(result?.type ?? "")) ?? String(result?.type ?? "");
  const meta = [
    result.standardNo ? escapeHtml(result.standardNo) : "",
    clause ? `第 ${escapeHtml(clause)} 条` : "",
    page ? `第 ${escapeHtml(page)} 页` : "",
    type ? escapeHtml(type) : "",
  ].filter(Boolean).join(" · ");
  const attrs = `data-action="search-open" data-search-index="${index}" data-kb="${escapeAttr(kb)}" data-id="${escapeAttr(docId)}"${page ? ` data-page="${escapeAttr(page)}"` : ""}${clause ? ` data-clause="${escapeAttr(clause)}"` : ""}`;
  const href = String(result?.deepLink ?? "");
  return `
    <article class="search-card" data-search-card>
      <div class="search-card-head">
        <a class="search-card-title" href="${escapeAttr(href)}" ${attrs}>${escapeHtml(result?.title ?? docId)}</a>
        <span class="search-card-badges">
          ${kb ? `<span class="badge">${escapeHtml(kb)}</span>` : ""}
          <span class="badge trust-${escapeAttr(trust)}">${escapeHtml(TRUST_LABEL.get(trust) ?? trust)}</span>
        </span>
      </div>
      ${meta ? `<p class="search-card-meta muted">${meta}</p>` : ""}
      <p class="search-card-snippet snippet" data-hl="${index}"></p>
      <div class="search-card-foot">
        <span class="muted" title="检索命中的条款数；页面里高亮的关键词次数在预览弹窗顶部显示">命中 ${Number(result?.hits) || 0} 条条款</span>
        <button class="btn" type="button" ${attrs}>打开原件</button>
      </div>
    </article>
  `;
}

function body(state, { icons }) {
  const search = state.search ?? {};
  const results = Array.isArray(search.results) ? search.results : [];
  const total = Math.max(0, Math.round(Number(search.total) || 0));
  if (search.error) {
    return `
      <div class="panel">
        <div class="state error">
          <p>${escapeHtml(search.error)}</p>
          <button class="btn" type="button" data-search-retry>重试</button>
        </div>
      </div>`;
  }
  if (search.loading) {
    return `<div class="panel"><div class="state">正在检索…</div></div>`;
  }
  if (!search.appliedQ) {
    return `
      <div class="panel">
        <div class="state search-empty">
          <p>搜索正文与条款，例如：</p>
          <div class="search-examples">
            <button class="chip" type="button" data-action="search-example" data-example="电压偏差">电压偏差</button>
            <button class="chip" type="button" data-action="search-example" data-example="谐波电流">谐波电流</button>
            <button class="chip" type="button" data-action="search-example" data-example="GB/T 19963">GB/T 19963</button>
          </div>
          <p class="muted">支持标准号写法归一（GB/T = GBT = GB_T），但 GB 与 GB/T 是不同标准，会分别匹配。</p>
        </div>
      </div>`;
  }
  if (results.length === 0) {
    return `
      <div class="panel">
        <div class="state search-empty">
          <p>没有匹配「${escapeHtml(search.appliedQ)}」的资料</p>
          <button class="btn" type="button" data-search-clear>清除条件</button>
        </div>
      </div>`;
  }
  return `
    <div class="panel">
      <div class="search-results">
        ${results.map((result, index) => card(result, index)).join("")}
      </div>
      <div class="search-more">
        ${hasMore({ ...search, total, results })
          ? `<button class="btn" type="button" data-search-more${search.loadingMore ? " disabled" : ""}>${search.loadingMore ? "正在加载…" : `加载更多（还有 ${total - (Math.round(Number(search.offset) || 0) + results.length)} 篇）`}</button>`
          : `<span class="muted">已全部显示（${total} 篇）</span>`}
      </div>
    </div>
  `;
}

export function renderSearch(state, { icons = {}, fmtNumber = (value) => String(value) } = {}) {
  const search = state?.search ?? {};
  return `
    <section class="search-page">
      <div class="detail-head">
        <div>
          <div class="crumbs"><a href="#/">知识库</a><span>/</span><strong>全文搜索</strong></div>
          <div class="detail-title"><h1>全文搜索</h1></div>
          <p class="muted">跨库检索资料正文与条款；结果按文档去重，点标题打开原件预览。</p>
        </div>
      </div>
      ${toolbar(state, { icons, fmtNumber })}
      ${body(state, { icons })}
    </section>
  `;
}
