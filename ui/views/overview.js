import { statusBadges } from "./badges.js";

export function renderOverview(state, { icons, fmtNumber }) {
  const kbs = state.kbs.filter((kb) => matches(kb, state));
  const totalDocs = state.kbs.reduce((sum, kb) => sum + kb.docs.ready + kb.docs.importing + kb.docs.failed, 0);
  const totalNotes = state.kbs.reduce((sum, kb) => sum + kb.docs.notes, 0);
  const totalPages = state.kbs.reduce((sum, kb) => sum + (kb.pages ?? 0), 0);
  const totalChars = state.kbs.reduce((sum, kb) => sum + (kb.chars ?? 0), 0);
  const empty = state.kbs.filter((kb) => kb.docs.total === 0 || (kb.docs.ready + kb.docs.importing + kb.docs.failed) === 0).length;
  return `
    <section class="overview">
      <div class="overview-head">
        <div>
          <h1>知识库</h1>
          <p class="muted">${fmtNumber(state.kbs.length)} 个库 · ${fmtNumber(totalDocs)} 篇有效文档 · ${fmtNumber(totalNotes)} 篇笔记 · ${compact(totalPages)} 页 · ${compact(totalChars)} 字</p>
        </div>
        <div class="head-actions">
          <button class="btn" data-action="std-open">标准更新</button>
          <button class="btn" data-action="upload">上传资料</button>
        </div>
        <div class="filters">
          <div class="segmented">
            ${["all", "active", "empty"].map((value) => `
              <button class="seg ${state.filter === value ? "active" : ""}" data-filter="status" data-value="${value}">
                ${value === "all" ? "全部" : value === "active" ? "有内容" : `空库 ${empty}`}
              </button>`).join("")}
          </div>
          <label class="search">
            ${icons.search}
            <input data-filter="query" value="${escapeAttr(state.query)}" placeholder="搜索名称、简介或标签" />
          </label>
        </div>
      </div>
      ${state.kbs.length === 0 ? emptyState(icons) : kbs.length === 0 ? `<div class="state">没有匹配的知识库</div>` : `
        <div class="cards">
          ${kbs.map((kb) => card(kb, { icons, fmtNumber })).join("")}
        </div>`}
    </section>
  `;
}

function matches(kb, state) {
  const query = state.query.trim().toLowerCase();
  if (query !== "") {
    const haystack = [kb.name, kb.description, ...(kb.tags ?? [])].join(" ").toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  const live = kb.docs.ready + kb.docs.importing + kb.docs.failed;
  if (state.filter === "active") return live > 0;
  if (state.filter === "empty") return live === 0;
  return true;
}

function card(kb, { icons, fmtNumber }) {
  const live = kb.docs.ready + kb.docs.importing + kb.docs.failed;
  return `
    <article class="card" data-action="open-kb" data-name="${escapeAttr(kb.name)}" tabindex="0">
      <div class="card-top">
        <span class="dot" style="--dot:${colorFor(kb.name)}"></span>
        <h2>${escapeHtml(kb.name)}</h2>
        ${kb.status === "empty" ? `<span class="badge">空库</span>` : ""}
        ${statusBadges(kb)}
        ${kb.mergedInto ? `<span class="badge">已合并至 ${escapeHtml(kb.mergedInto)}</span>` : ""}
        <span class="card-more">${icons.chevron}</span>
      </div>
      <p class="desc">${kb.description ? escapeHtml(kb.description) : `<span class="muted">未填写简介</span>`}</p>
      <div class="stats">
        <span><strong>${fmtNumber(live)}</strong> 篇</span>
        <span><strong>${compact(kb.pages)}</strong> 页</span>
        <span><strong>${compact(kb.chars)}</strong> 字</span>
        <span><strong>${fmtNumber(kb.docs.notes)}</strong> 笔记</span>
      </div>
      <div class="bars">
        ${typeBar(kb.types)}
        ${trustBar(kb.trust)}
      </div>
      <div class="card-foot muted">
        <span>${kb.updatedAt ? `更新 ${formatDate(kb.updatedAt)}` : "尚未更新"}</span>
        ${(kb.tags ?? []).slice(0, 3).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
      </div>
    </article>
  `;
}

const TYPE_COLORS = {
  "pdf-text": "#6b8afd", "pdf-scanned": "#3f5fd6", "pdf-mixed": "#8ea6ff",
  docx: "#3b82f6", pptx: "#f59e0b", markdown: "#10b981", text: "#94a3b8",
  note: "#a855f7", epub: "#14b8a6", mobi: "#14b8a6", pdf: "#64748b", unknown: "#cbd5e1",
};

function typeBar(types = {}) {
  const total = Object.values(types).reduce((sum, value) => sum + Number(value || 0), 0);
  if (total === 0) return `<div class="bar empty"></div>`;
  return `<div class="bar" title="${escapeAttr(typeTitle(types))}">${Object.entries(types)
    .filter(([, value]) => Number(value) > 0)
    .map(([type, value]) => `<i style="width:${(Number(value) / total) * 100}%;background:${TYPE_COLORS[type] ?? "#cbd5e1"}"></i>`)
    .join("")}</div>`;
}

function typeTitle(types) {
  return Object.entries(types).map(([type, value]) => `${type} ${value}`).join(" · ");
}

function trustBar(trust = {}) {
  const total = Object.values(trust).reduce((sum, value) => sum + Number(value || 0), 0);
  if (total === 0) return `<div class="bar thin empty"></div>`;
  const colors = { high: "#16a34a", medium: "#f59e0b", low: "#dc2626", unknown: "#94a3b8" };
  return `<div class="bar thin" title="${escapeAttr(Object.entries(trust).map(([key, value]) => `${key} ${value}`).join(" · "))}">${Object.entries(trust)
    .map(([key, value]) => `<i style="width:${(Number(value) / total) * 100}%;background:${colors[key] ?? "#94a3b8"}"></i>`)
    .join("")}</div>`;
}

function emptyState(icons) {
  return `
    <div class="empty-card">
      <div class="empty-icon">${icons.database}</div>
      <h2>还没有知识库</h2>
      <p class="muted">新建一个库，或从已有资料开始整理。</p>
      <button class="btn primary" data-action="create-kb">${icons.plus}<span>新建知识库</span></button>
    </div>
  `;
}

function colorFor(name) {
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `hsl(${hash % 360} 55% 52%)`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
}

function compact(value) {
  const number = Number(value) || 0;
  if (number >= 100000000) return `${(number / 100000000).toFixed(2)} 亿`;
  if (number >= 10000) return `${(number / 10000).toFixed(1)} 万`;
  return new Intl.NumberFormat("zh-CN").format(number);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
