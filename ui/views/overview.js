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
          ${rootLine(state)}
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
            <input data-filter="query" value="${escapeAttr(state.query)}" placeholder="搜索名称、摘要、标准号或标签" />
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

/**
 * 只读展示当前知识库根目录：让用户确认 kbRoot 配置生效，路径长也照实显示。
 * 服务信息还没取到（或 /status 失败）时不占位。
 */
function rootLine(state) {
  const root = String(state.server?.kbRoot ?? "").trim();
  if (root === "") return "";
  return `<p class="muted root-line">知识库根目录 <code class="root-path" title="由插件配置 kbRoot 决定；修改方法见 README「指定知识库目录」">${escapeHtml(root)}</code></p>`;
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
      ${typeLine(kb.types)}
      <div class="stats">
        <span><strong>${fmtNumber(live)}</strong> 篇</span>
        <span><strong>${compact(kb.pages)}</strong> 页</span>
        <span><strong>${compact(kb.chars)}</strong> 字</span>
        <span><strong>${fmtNumber(kb.docs.notes)}</strong> 笔记</span>
      </div>
      <div class="composition">
        ${trustBar(kb.trust)}
        ${trustDots(kb.trust)}
      </div>
      <div class="card-foot muted">
        <span>${kb.updatedAt ? `更新 ${formatDate(kb.updatedAt)}` : "尚未更新"}</span>
        ${(kb.tags ?? []).slice(0, 3).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
      </div>
    </article>
  `;
}

const TRUST_COLORS = { high: "#4f9d69", medium: "#c9a36a", low: "#b96a6a", unknown: "#93a3b8" };
const TRUST_LABELS = { high: "高", medium: "中", low: "低", unknown: "未知" };
const TRUST_LEVELS = ["high", "medium", "low", "unknown"];

/** 文件类型数量（概括行）；用户主要关注可信度，类型退居次要位置。 */
function typeLine(types = {}) {
  const entries = Object.entries(types)
    .map(([type, value]) => [type, Math.max(0, Number(value) || 0)])
    .filter(([, value]) => value > 0);
  if (entries.length === 0) return "";
  return `<p class="type-line muted">类型：${entries.map(([type, value]) => `${escapeHtml(type)} ${value}`).join(" · ")}</p>`;
}

/** 可信度构成条：绿/黄/红/灰四档，title 列出全部四项（含 0）。 */
function trustBar(trust = {}) {
  const entries = TRUST_LEVELS.map((level) => [level, Math.max(0, Number(trust[level]) || 0)]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total === 0) {
    return `<div class="bar empty" role="img" aria-label="暂无可信度" title="暂无可信度"><i></i></div>`;
  }
  const title = `可信度：${entries.map(([level, value]) => `${TRUST_LABELS[level]} ${value}`).join(" · ")}`;
  return `<div class="bar" role="img" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}">${entries
    .filter(([, value]) => value > 0)
    .map(([level, value]) => `<i style="width:${(value / total) * 100}%;background:${TRUST_COLORS[level]}"></i>`)
    .join("")}</div>`;
}

/**
 * 可信度只保留紧凑圆点图例：非零项才渲染 `● N`。
 * 四项都为零时不占位（空库卡片只留空类型条）。
 */
function trustDots(trust = {}) {
  const entries = TRUST_LEVELS.map((level) => [level, Math.max(0, Number(trust[level]) || 0)]);
  if (entries.every(([, value]) => value === 0)) return "";
  const title = `可信度：${entries.map(([level, value]) => `${TRUST_LABELS[level]} ${value}`).join(" · ")}`;
  return `<div class="trust-dots" role="group" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}"><span class="trust-label muted">可信度</span>${entries
    .filter(([, value]) => value > 0)
    .map(([level, value]) => {
      const label = `${TRUST_LABELS[level]} ${value}`;
      return `<span class="trust-dot" role="img" title="${escapeAttr(label)}" aria-label="${escapeAttr(`可信度：${label}`)}"><span class="trust-dot-mark" style="color:${TRUST_COLORS[level]}" aria-hidden="true">●</span>${value}</span>`;
    })
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
