import { hrefForKb } from "../router.js";
import { statusBadges } from "./badges.js";
import { renderStdPanel } from "./std.js";
import { DOC_TRUST_LEVELS } from "./doc-meta.js";

/** 工作台允许的每页条数；服务端仍按 1–200 兜底。 */
export const DOCS_PAGE_SIZES = [50, 100, 200];

/** 资料 tab 的状态筛选（空字符串=全部）；其余值一律回落到全部。 */
export const DOCS_STATUSES = ["", "failed", "importing", "deleted"];

export function docsStatus(value) {
  const status = String(value ?? "").trim();
  return DOCS_STATUSES.includes(status) ? status : "";
}

export function docsStatusLabel(status) {
  if (status === "failed") return "有失败";
  if (status === "importing") return "导入中";
  if (status === "deleted") return "已删除";
  return "全部";
}

/** 只有 ready/failed 行可以勾选：导入中不能操作，已删除只保留行内操作。 */
export function selectableDoc(doc) {
  return doc?.status === "ready" || doc?.status === "failed";
}

function selectionEntry(doc) {
  return {
    id: String(doc?.id ?? ""),
    title: String(doc?.title ?? ""),
    status: String(doc?.status ?? ""),
  };
}

function selectionList(selected) {
  return (Array.isArray(selected) ? selected : []).map((item) => (
    typeof item === "string" ? { id: item, title: "", status: "" } : selectionEntry(item)
  ));
}

/** 选中项的 id 列表（保持选择顺序）。 */
export function selectionIds(selected) {
  return selectionList(selected).map((item) => item.id).filter(Boolean);
}

/** 某篇资料是否在当前选择里。 */
export function selectionHas(selected, id) {
  const target = String(id ?? "");
  return selectionList(selected).some((item) => item.id === target);
}

/** 表头复选框：本页可勾选行全选中时再点=全部取消，否则补齐本页。 */
export function selectionToggle(selected, rows) {
  const current = selectionList(selected);
  const pageRows = (Array.isArray(rows) ? rows : []).filter(selectableDoc);
  if (pageRows.length === 0) return current;
  const selectedIds = new Set(current.map((item) => item.id));
  if (pageRows.every((row) => selectedIds.has(String(row.id)))) {
    const pageIds = new Set(pageRows.map((row) => String(row.id)));
    return current.filter((item) => !pageIds.has(item.id));
  }
  const seen = new Set(current.map((item) => item.id));
  const next = [...current];
  for (const row of pageRows) {
    const entry = selectionEntry(row);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    next.push(entry);
  }
  return next;
}

/** 单行复选框：checked 明确给出时按它增删，否则按当前状态取反。 */
export function selectionToggleOne(selected, doc, checked) {
  const current = selectionList(selected);
  const id = String(doc?.id ?? "");
  if (id === "") return current;
  const exists = current.some((item) => item.id === id);
  const want = checked === undefined ? !exists : Boolean(checked);
  if (!want) return current.filter((item) => item.id !== id);
  return exists ? current : [...current, selectionEntry(doc)];
}

/** 本页可勾选行是否已全部选中（没有可勾选行时为 false）。 */
export function selectionAllSelected(selected, rows) {
  const pageRows = (Array.isArray(rows) ? rows : []).filter(selectableDoc);
  if (pageRows.length === 0) return false;
  const ids = new Set(selectionList(selected).map((item) => item.id));
  return pageRows.every((row) => ids.has(String(row.id)));
}

/** 行内操作集合：ready=移除；failed=重试+移除；deleted=恢复/撤销移动+彻底删除。 */
export function docRowActions(doc) {
  if (!doc) return [];
  if (doc.status === "failed") return ["retry", "remove"];
  if (doc.status === "ready") return ["remove"];
  if (doc.status === "deleted") {
    // 已跨库移动过的文档只能用「撤销移动」恢复；普通「恢复」会留下两份可用副本。
    return doc.movedTo ? ["undo-move", "purge"] : ["restore", "purge"];
  }
  return [];
}

const DOC_ACTION_LABELS = Object.freeze({
  retry: "重试",
  remove: "移除",
  restore: "恢复",
  purge: "彻底删除",
  "undo-move": "撤销移动",
});

/** 多选工具条；没有选中项时不渲染。 */
export function renderDocsBulkBar({ selected = [], busy = false } = {}) {
  const count = Array.isArray(selected) ? selected.length : 0;
  if (count === 0) return "";
  return `
    <div class="docs-bulk">
      <strong>已选 ${count} 篇</strong>
      <button type="button" class="btn" data-action="docs-export-selected"${busy ? " disabled" : ""}>导出选中</button>
      <button type="button" class="btn" data-action="docs-move"${busy ? " disabled" : ""}>移动到…</button>
      <button type="button" class="btn danger" data-action="docs-trash-selected"${busy ? " disabled" : ""}>移入回收站</button>
      <button type="button" class="btn" data-action="docs-clear-selection"${busy ? " disabled" : ""}>取消选择</button>
    </div>
  `;
}

/** 旧状态/手改 URL 里的其它 limit 一律回落到默认 50。 */
export function docsPageSize(value) {
  const size = Math.round(Number(value) || 0);
  return DOCS_PAGE_SIZES.includes(size) ? size : DOCS_PAGE_SIZES[0];
}

/** 总页数；0 篇也有第 1 页（视图层在 total=0 时整体隐藏分页）。 */
export function docsPageCount(total, limit = DOCS_PAGE_SIZES[0]) {
  const count = Math.max(0, Math.round(Number(total) || 0));
  return Math.max(1, Math.ceil(count / docsPageSize(limit)));
}

/** 跳页输入的范围保护：非数字/过小→1，超过末页→末页。 */
export function clampDocsPage(value, pages = 1) {
  const max = Math.max(1, Math.round(Number(pages) || 0));
  const page = Math.round(Number(value) || 0);
  return Math.min(max, Math.max(1, page));
}

export function renderDetail(state, current, { icons, fmtNumber }) {
  if (state.detailLoading && !state.detail) return `<div class="state">加载中…</div>`;
  if (state.detailError) return `<div class="state error">${escapeHtml(state.detailError)}</div>`;
  const detail = state.detail;
  if (!detail) return `<div class="state">未找到知识库</div>`;
  const kb = detail.kb;
  const tab = current.tab || "overview";
  return `
    <section class="detail">
      <div class="detail-head">
        <div>
          <div class="crumbs"><a href="#/">知识库</a><span>/</span><strong>${escapeHtml(kb.name)}</strong></div>
          <div class="detail-title">
            <h1>${escapeHtml(kb.name)}</h1>
            ${kb.status === "empty" ? `<span class="badge">空库</span>` : ""}
            ${statusBadges(kb, { interactiveFailed: true })}
            ${kbTagChips(kb.tags)}
          </div>
          <p class="muted">${kb.description ? escapeHtml(kb.description) : "未填写简介"}</p>
        </div>
        <div class="detail-actions">
          <button class="btn primary" data-action="upload" data-kb="${escapeAttr(kb.name)}">${icons.upload}<span>上传资料</span></button>
          <button class="btn" data-action="import-package">导入知识库包</button>
          <button class="btn" data-action="export-kb" data-name="${escapeAttr(kb.name)}">导出知识库</button>
          <button class="btn" data-action="rename-kb-modal" data-name="${escapeAttr(kb.name)}">重命名</button>
          <button class="btn" data-action="archive-kb" data-name="${escapeAttr(kb.name)}">${icons.archive}<span>归档</span></button>
        </div>
      </div>
      <nav class="tabs">
        ${tabLink(kb.name, "overview", "概览", tab)}
        ${tabLink(kb.name, "docs", "资料", tab)}
        ${tabLink(kb.name, "notes", "笔记", tab)}
        ${tabLink(kb.name, "log", "日志", tab)}
        ${tabLink(kb.name, "std", "标准更新", tab)}
        ${tabLink(kb.name, "settings", "设置", tab)}
      </nav>
      ${tab === "overview" ? overview(kb, detail, { fmtNumber }) : ""}
      ${tab === "docs" ? docs(kb, state, { fmtNumber, icons }) : ""}
      ${tab === "notes" ? notes(state, { fmtNumber }) : ""}
      ${tab === "log" ? log(detail.logTail) : ""}
      ${tab === "std" ? renderStdPanel(state, kb.name, { escapeHtml }) : ""}
      ${tab === "settings" ? settings(kb) : ""}
    </section>
  `;
}

/** 知识库标签：显示在库名右侧（最多 5 个，其余 +N）。 */
function kbTagChips(tags = []) {
  const list = (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag ?? "").trim())
    .filter(Boolean);
  if (list.length === 0) return "";
  const shown = list.slice(0, 5);
  const rest = list.length - shown.length;
  return `<span class="kb-tags">${shown.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}${rest > 0 ? `<span class="tag-more" title="${escapeAttr(list.join("、"))}">+${rest}</span>` : ""}</span>`;
}

function tabLink(name, tab, label, active) {
  return `<a class="tab ${active === tab ? "active" : ""}" href="${hrefForKb(name, tab)}">${label}</a>`;
}

function overview(kb, detail, { fmtNumber }) {
  const live = kb.docs.ready + kb.docs.importing + kb.docs.failed;
  return `
    <div class="panel-grid">
      <div class="panel">
        <h3>概况</h3>
        <div class="kv"><span>有效文档</span><strong>${fmtNumber(live)}</strong></div>
        <div class="kv"><span>笔记</span><strong>${fmtNumber(kb.docs.notes)}</strong></div>
        <div class="kv"><span>页数</span><strong>${fmtNumber(kb.pages)}</strong></div>
        <div class="kv"><span>字数</span><strong>${fmtNumber(kb.chars)}</strong></div>
        <div class="kv"><span>软删除</span><strong>${fmtNumber(kb.docs.deleted)}</strong></div>
        <div class="kv"><span>更新时间</span><strong>${formatDate(kb.updatedAt)}</strong></div>
      </div>
      <div class="panel">
        <h3>健康</h3>
        <div class="kv"><span>导入失败</span><strong>${fmtNumber(detail.health.failed)}</strong></div>
        <div class="kv"><span>导入中</span><strong>${fmtNumber(detail.health.importing)}</strong></div>
        <div class="kv"><span>低置信 OCR</span><strong>${fmtNumber(detail.health.lowConfidenceDocs)}</strong></div>
        <div class="kv"><span>文字层损坏</span><strong>${fmtNumber(detail.health.corruptedDocs)}</strong></div>
        <div class="kv"><span>schema.md</span><strong>${detail.health.hasSchema ? "有" : "无"}</strong></div>
      </div>
      <div class="panel">
        <h3>文件类型</h3>
        ${Object.entries(kb.types ?? {})
          .map(([type, value]) => [type, Math.max(0, Number(value) || 0)])
          .filter(([, value]) => value > 0)
          .sort((left, right) => right[1] - left[1])
          .map(([type, value]) => `<div class="kv"><span>${escapeHtml(type)}</span><strong>${fmtNumber(value)}</strong></div>`)
          .join("") || `<p class="muted">还没有资料</p>`}
      </div>
      <div class="panel wide">
        <h3>最近资料</h3>
        ${detail.recentDocs.length === 0 ? `<p class="muted">还没有资料</p>` : `
          <table class="table">
            <thead><tr><th>标题</th><th>类型</th><th>更新</th></tr></thead>
            <tbody>
              ${detail.recentDocs.map((doc) => `<tr>
                <td><button class="link" data-action="open-doc" data-kb="${escapeAttr(kb.name)}" data-id="${escapeAttr(doc.id)}">${escapeHtml(doc.title)}</button></td>
                <td class="muted">${escapeHtml(doc.type ?? "")}</td>
                <td class="muted">${formatDate(doc.updatedAt)}</td>
              </tr>`).join("")}
            </tbody>
          </table>`}
      </div>
    </div>
  `;
}

function docs(kb, state, { fmtNumber, icons }) {
  const name = kb?.name ?? "";
  const page = state.docs;
  const query = String(page.query ?? "");
  const tag = String(page.tag ?? "");
  const facets = page.facets && Array.isArray(page.facets.tags) ? page.facets : { tags: [] };
  // 输入框显示的是正在输入的词；结果属于真正应用过的 appliedQuery。
  // 两者不一致时（防抖/请求在途）不把旧结果说成新词的结果。
  const appliedQuery = String(page.appliedQuery ?? query);
  const searching = query !== appliedQuery;
  const status = docsStatus(page.status);
  const total = Math.max(0, Math.round(Number(page.total) || 0));
  const limit = docsPageSize(page.limit);
  const offset = Math.max(0, Math.round(Number(page.offset) || 0));
  const items = Array.isArray(page.items) ? page.items : [];
  const selected = Array.isArray(page.selected) ? page.selected : [];
  const retrying = Array.isArray(page.retrying) ? page.retrying : [];
  const busy = Boolean(page.busy);
  const deleted = Math.max(0, Math.round(Number(kb?.docs?.deleted) || 0));
  // 「已删除」筛选只在有回收站内容时出现；正在看回收站时即使刚清空也保留入口。
  const showDeleted = deleted > 0 || status === "deleted";
  const toolbar = (extra) => docsToolbar({
    query, limit, status, tag, facets, deleted, showDeleted, busy, fmtNumber, icons, ...extra,
  });
  if (searching) {
    // 防抖/请求在途：只保留工具栏与「正在搜索…」，不把上一轮的行/表格挂在新搜索词下。
    return `
      <div class="panel">
        ${toolbar({ total, pages: 1, pageNo: 1, showPager: false })}
        <div class="state docs-empty"><p>正在搜索…</p></div>
      </div>
    `;
  }
  if (total === 0) {
    if (query.trim() === "" && status === "" && tag === "") {
      return `<div class="state">还没有资料，点右上角的「上传资料」开始导入。</div>`;
    }
    // 有搜索词/状态筛选但无结果：保留工具栏（可继续改词、清除或切回全部），不显示分页。
    const filtered = query.trim() !== "";
    const tagged = tag !== "";
    const message = filtered
      ? "没有匹配的资料"
      : tagged
        ? "没有匹配该标签的资料"
        : status === "failed"
          ? "没有导入失败的资料"
          : status === "deleted"
            ? "没有已删除的资料"
            : "没有导入中的资料";
    return `
      <div class="panel">
        ${toolbar({ total, pages: 1, pageNo: 1, showPager: false })}
        <div class="state docs-empty">
          <p>${message}</p>
          ${filtered ? `<button class="btn" data-docs-clear>清除搜索</button>` : ""}
          ${tagged && !filtered ? `<button class="btn" data-action="docs-tag-clear">清除标签</button>` : ""}
        </div>
      </div>
    `;
  }
  const pages = docsPageCount(total, limit);
  const pageNo = clampDocsPage(Math.floor(offset / limit) + 1, pages);
  const rangeEnd = Math.min(offset + items.length, total);
  const selectableCount = items.filter(selectableDoc).length;
  return `
    <div class="panel">
      ${toolbar({ total, pages, pageNo, showPager: true })}
      ${renderDocsBulkBar({ selected, busy })}
      <div class="table-head">
        <strong>${fmtNumber(total)} 篇</strong>
        ${items.length > 0
          ? `<span class="muted">第 ${fmtNumber(offset + 1)}–${fmtNumber(rangeEnd)} 篇</span>`
          : ""}
      </div>
      <div class="table-scroll">
        <table class="table docs-table">
          <thead><tr>
            <th class="col-check"><input type="checkbox" data-action="docs-select-all" aria-label="选择本页可操作资料"${selectionAllSelected(selected, items) ? " checked" : ""}${selectableCount === 0 ? " disabled" : ""} /></th>
            <th>标题</th><th>类型</th><th>页数</th><th>可信度</th><th>更新</th><th class="col-actions">操作</th>
          </tr></thead>
          <tbody>
            ${items.map((doc) => {
              const checkable = selectableDoc(doc);
              const checked = checkable && selectionHas(selected, doc.id);
              const isRetrying = retrying.includes(String(doc.id));
              const actions = docRowActions(doc);
              return `<tr class="doc-row${doc.deleted ? " doc-deleted" : ""}">
                <td class="col-check">${checkable ? `<input type="checkbox" data-action="docs-select" data-id="${escapeAttr(doc.id)}" aria-label="选择 ${escapeAttr(doc.title)}"${checked ? " checked" : ""} />` : ""}</td>
                <td>
                  <button class="link" data-action="open-doc" data-kb="${escapeAttr(name)}" data-id="${escapeAttr(doc.id)}">${escapeHtml(doc.title)}</button>
                  ${doc.deleted ? `<span class="badge">已删除</span>` : ""}
                  ${doc.status === "failed" ? `<span class="badge warn">失败</span>` : ""}
                  ${doc.movedTo?.kb ? `<span class="badge accent">已移至 ${escapeHtml(doc.movedTo.kb)}</span>` : ""}
                  ${renderDocTags(doc, tag)}
                </td>
                <td class="muted">${escapeHtml(doc.type ?? "")}</td>
                <td class="muted">${fmtNumber(doc.pages)}</td>
                <td class="muted">${trustSelect(doc, name)}</td>
                <td class="muted">${formatDate(doc.updatedAt)}</td>
                <td class="col-actions">${actions.map((action) => docActionButton(doc, action, { busy, retrying: isRetrying })).join("")}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      ${docsPager({ pageNo, pages, total, limit, fmtNumber, label: "底部分页" })}
    </div>
  `;
}

const TRUST_SHORT = { high: "高", medium: "中", low: "低", unknown: "未标注" };

/** 资料列表内联可信度选择：ready 文档可直接改，导入中/已删除保持只读。 */
function trustSelect(doc, kbName) {
  if (doc?.deleted || (doc?.status !== undefined && doc?.status !== "ready")) return escapeHtml(doc?.trust ?? "unknown");
  return `<select class="trust-select" data-action="docs-trust" data-kb="${escapeAttr(kbName)}" data-id="${escapeAttr(doc.id)}" aria-label="修改可信度">
    ${DOC_TRUST_LEVELS.map((level) => `<option value="${level}"${(doc.trust ?? "unknown") === level ? " selected" : ""}>${TRUST_SHORT[level] ?? level}</option>`).join("")}
  </select>`;
}

function renderDocTags(doc, activeTag) {
  const tags = Array.isArray(doc?.tags) ? doc.tags : [];
  if (tags.length === 0) return "";
  const shown = tags.slice(0, 3);
  const rest = tags.length - shown.length;
  return `<span class="doc-tags">${shown.map((tag) => `
    <button type="button" class="tag${tag === activeTag ? " active" : ""}" data-action="docs-tag" data-tag="${escapeAttr(tag)}" aria-pressed="${tag === activeTag}">#${escapeHtml(tag)}</button>`).join("")}${rest > 0 ? `<span class="tag-more" title="${escapeAttr(tags.join("、"))}">+${rest}</span>` : ""}</span>`;
}

function docActionButton(doc, action, { busy, retrying }) {
  const label = action === "retry" && retrying ? "重试中…" : DOC_ACTION_LABELS[action];
  const disabled = busy || (action === "retry" && retrying);
  const target = action === "undo-move" ? ` data-target="${escapeAttr(doc.movedTo?.kb ?? "")}"` : "";
  const danger = action === "purge" ? " danger" : "";
  return `<button type="button" class="btn mini${danger}" data-action="docs-${action}" data-id="${escapeAttr(doc.id)}"${target}${disabled ? " disabled" : ""}>${label}</button>`;
}

function docsToolbar({ query, limit, status, tag = "", facets = { tags: [] }, deleted = 0, showDeleted = false, busy = false, total, pages, pageNo, fmtNumber, icons, showPager }) {
  const statuses = DOCS_STATUSES.filter((value) => value !== "deleted" || showDeleted);
  const tags = Array.isArray(facets?.tags) ? facets.tags : [];
  return `
    <div class="table-tools">
      <div class="segmented docs-status" role="group" aria-label="按状态筛选资料">
        ${statuses.map((value) => {
          const title = value === "deleted" ? ` title="已删除 ${fmtNumber(deleted)} 篇"` : "";
          return `
          <button type="button" class="seg${status === value ? " active" : ""}" data-action="docs-status" data-docs-status="${value}" aria-pressed="${status === value}"${title}>${docsStatusLabel(value)}</button>
        `;
        }).join("")}
      </div>
      <label class="search docs-search">
        ${icons?.search ?? ""}
        <input type="search" data-docs-query value="${escapeAttr(query)}" placeholder="搜索标题、摘要、标准号或标签…" aria-label="搜索资料" autocomplete="off" />
      </label>
      ${tags.length > 0 || tag !== "" ? `
        <label class="docs-tag-filter">
          <span class="muted">标签</span>
          <select data-docs-tag aria-label="按标签筛选">
            <option value="">全部标签</option>
            ${tags.map((item) => `<option value="${escapeAttr(item.name)}"${item.name === tag ? " selected" : ""}>${escapeHtml(item.name)}（${fmtNumber(item.count)}）</option>`).join("")}
          </select>
        </label>` : ""}
      ${tag !== "" ? `<button type="button" class="badge accent docs-tag-active" data-action="docs-tag-clear" title="清除标签筛选">标签：${escapeHtml(tag)} ×</button>` : ""}
      <label class="docs-size">
        <span class="muted">每页</span>
        <select data-docs-size aria-label="每页条数">
          ${DOCS_PAGE_SIZES.map((size) => `<option value="${size}"${size === limit ? " selected" : ""}>${size}</option>`).join("")}
        </select>
      </label>
      ${status === "deleted" && deleted > 0
        ? `<button type="button" class="btn danger docs-purge-all" data-action="docs-purge-all"${busy ? " disabled" : ""}>清空本库已删除资料</button>`
        : ""}
      ${showPager ? docsPager({ pageNo, pages, total, limit, fmtNumber, label: "顶部分页" }) : ""}
    </div>
  `;
}

function docsPager({ pageNo, pages, total, limit, fmtNumber, label }) {
  const prevOffset = Math.max(0, (pageNo - 2) * limit);
  const nextOffset = pageNo * limit;
  return `
    <div class="pager docs-pager" role="group" aria-label="${label}">
      <button class="btn" data-action="docs-page" data-offset="${prevOffset}" ${pageNo <= 1 ? "disabled" : ""}>上一页</button>
      <span class="muted docs-page-text">第 ${pageNo} / ${pages} 页 · 共 ${fmtNumber(total)} 篇</span>
      <button class="btn" data-action="docs-page" data-offset="${nextOffset}" ${pageNo >= pages ? "disabled" : ""}>下一页</button>
      <span class="docs-jump">
        <input type="number" min="1" max="${pages}" step="1" value="${pageNo}" data-docs-page aria-label="页码" />
        <button class="btn" data-docs-jump>跳转</button>
      </span>
    </div>
  `;
}

function notes(state, { fmtNumber }) {
  const page = state.notes ?? {};
  const items = Array.isArray(page.items) ? page.items : [];
  const total = Math.max(0, Math.round(Number(page.total) || 0));
  const loading = Boolean(page.loading);
  const error = String(page.error ?? "");
  if (loading && items.length === 0) {
    return `<div class="panel"><h3>笔记</h3><div class="state note-state">加载中…</div></div>`;
  }
  if (error) {
    return `<div class="panel"><h3>笔记</h3><p class="form-error">${escapeHtml(error)}</p></div>`;
  }
  if (total === 0) {
    return `<div class="panel"><h3>笔记</h3><p class="muted">还没有笔记。在对话里用 kb_add_note 沉淀后，会显示在这里。</p></div>`;
  }
  const capped = total > items.length;
  return `
    <div class="panel">
      <div class="table-head">
        <h3>笔记</h3>
        <span class="muted">共 ${fmtNumber(total)} 篇</span>
      </div>
      <table class="table notes-table">
        <thead><tr><th>标题</th><th>更新</th><th>摘要</th></tr></thead>
        <tbody>
          ${items.map((doc) => `<tr>
            <td><button class="link" data-action="open-note" data-id="${escapeAttr(doc.id)}">${escapeHtml(doc.title)}</button></td>
            <td class="muted">${formatDate(doc.updatedAt)}</td>
            <td class="muted notes-summary">${escapeHtml(snippet(doc.summary))}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      ${capped ? `<p class="muted notes-cap">仅显示前 ${fmtNumber(items.length)} 篇（共 ${fmtNumber(total)} 篇）</p>` : ""}
    </div>
  `;
}

/** 摘要截断：没有摘要时用占位符，避免整列空白。 */
function snippet(value, max = 120) {
  const text = String(value ?? "").trim();
  if (text === "") return "—";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function log(text) {
  return `<div class="panel"><h3>操作日志</h3><pre class="log">${escapeHtml(text || "（暂无日志）")}</pre></div>`;
}

function settings(kb) {
  return `
    <div class="panel">
      <h3>库信息</h3>
      <label class="field"><span>简介</span><textarea id="kb-description" rows="3">${escapeHtml(kb.description)}</textarea></label>
      <label class="field"><span>标签（逗号分隔）</span><input id="kb-tags" value="${escapeAttr((kb.tags ?? []).join(", "))}" /></label>
      <button class="btn primary" data-action="save-meta" data-name="${escapeAttr(kb.name)}">保存简介与标签</button>
    </div>
    <div class="panel">
      <h3>重命名</h3>
      <label class="field"><span>新名称</span><input id="kb-rename" value="${escapeAttr(kb.name)}" /></label>
      <button class="btn" data-action="rename-kb" data-name="${escapeAttr(kb.name)}">重命名</button>
    </div>
    <div class="panel danger-zone">
      <h3>归档</h3>
      <p class="muted">移动到 <code>.trash/</code>，不会删除文件；可在侧栏“回收站”恢复。</p>
      <button class="btn danger" data-action="archive-kb" data-name="${escapeAttr(kb.name)}">归档这个库</button>
    </div>
  `;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
