/**
 * 质量 tab（0.36 P3）：把 GET /quality 的读模型渲染成可筛选、可预览、可分批执行的队列。
 *
 * 纯渲染：不请求、不写库；所有动作由 app.js 的事件委托调用 P2 的动作接口。
 * 人工判断优先：摘要/标准号/标题不提供批量动作，按钮直接打开资料弹窗逐篇处理。
 */

/** 快捷筛选：空字符串=全部；actionable 走接口开关，其余按组过滤。 */
export const QUALITY_QUICK_FILTERS = Object.freeze([
  { id: "", label: "全部" },
  { id: "actionable", label: "仅可操作" },
  { id: "corrupted", label: "仅坏页" },
  { id: "unlabeled", label: "仅未编目" },
  { id: "summary-noise", label: "仅摘要噪声" },
]);

/** 可以在质量工作台里批量执行的动作（describe 必须逐篇人工写，不在其中）。 */
const BATCHABLE_ACTIONS = new Set(["retry-import", "reparse-pages", "trust", "keep", "remove"]);

export const QUALITY_ACTION_LABELS = Object.freeze({
  "retry-import": "重试导入",
  "reparse-pages": "重解析坏页",
  describe: "补摘要",
  trust: "标可信度",
  keep: "标记保留",
  remove: "软删除",
});

export const QUALITY_SEVERITIES = Object.freeze(["error", "warning", "info"]);

export function qualityFilter(value) {
  const id = String(value ?? "").trim();
  return QUALITY_QUICK_FILTERS.some((item) => item.id === id) ? id : "";
}

/** 快捷筛选 → 质量接口查询参数。 */
export function qualityFilterParams(value) {
  const id = qualityFilter(value);
  if (id === "") return {};
  if (id === "actionable") return { actionable: "1" };
  return { group: id };
}

export function severityMeta(severity) {
  if (severity === "error") return { icon: "⛔", label: "错误", className: "error" };
  if (severity === "warning") return { icon: "⚠", label: "警告", className: "warn" };
  return { icon: "ℹ", label: "提示", className: "" };
}

export function qualityActionLabel(action) {
  return QUALITY_ACTION_LABELS[action] ?? String(action ?? "");
}

/** 一批明细涉及的文档 id（重复组是逗号拼接的 docId / docIds 数组）。 */
export function qualityItemIds(item) {
  const ids = Array.isArray(item?.docIds) && item.docIds.length > 0
    ? item.docIds
    : String(item?.docId ?? "").split(",");
  return ids.map((id) => String(id).trim()).filter(Boolean);
}

/** 组内是否可以批量执行；不能批量时返回空串（如补摘要、无号判断）。 */
export function qualityBatchAction(group) {
  const action = String(group?.suggestedAction ?? "");
  if (group?.actionable !== true) return "";
  return BATCHABLE_ACTIONS.has(action) ? action : "";
}

/** 勾选/取消一组文档 id；checked 未给出时按“是否已全选”取反。 */
export function qualitySelectionToggle(selected, ids, checked) {
  const current = (Array.isArray(selected) ? selected : []).map(String);
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (list.length === 0) return current;
  const exists = list.every((id) => current.includes(id));
  const want = checked === undefined ? !exists : Boolean(checked);
  if (!want) return current.filter((id) => !list.includes(id));
  const next = [...current];
  for (const id of list) if (!next.includes(id)) next.push(id);
  return next;
}

/** 一组明细里所有文档 id（去重、保持顺序）——“全选本组”。 */
export function qualitySelectionAll(items) {
  const ids = [];
  for (const item of Array.isArray(items) ? items : []) {
    for (const id of qualityItemIds(item)) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 单条明细的证据文本：kb_lint 的 detail 优先，再补坏页/正文完整性。 */
export function qualityEvidence(item, group = {}) {
  const detail = String(item?.detail ?? "").trim();
  const badPages = Array.isArray(item?.badPages) ? item.badPages : [];
  const parts = [];
  if (detail) parts.push(detail);
  if (badPages.length > 0) parts.push(`坏页 ${badPages.join(",")}`);
  const integrity = String(item?.contentIntegrity ?? "");
  if (integrity && integrity !== "unknown" && !detail.includes(integrity)) parts.push(`正文 ${integrity}`);
  if (item?.summaryMissing === true && group?.code !== "unlabeled") parts.push("缺摘要");
  return parts.join(" · ") || "—";
}

/** 预览里“将要发生什么”的一行说明。 */
export function previewTargetText(item) {
  const preview = item?.preview ?? {};
  const parts = [];
  if (preview.forceOcr === true) parts.push("整篇 OCR");
  else if (Array.isArray(preview.pages) && preview.pages.length > 0) parts.push(`页码 ${preview.pages.join(",")}`);
  if (preview.dedupKeep !== undefined) parts.push(preview.dedupKeep ? "标记已核对保留" : "取消保留标记");
  if (preview.trust) parts.push(`可信度 ${preview.trust}`);
  if (preview.soft === true) parts.push("软删除");
  if (preview.forceReparse === true && parts.length === 0) parts.push("整篇重解析");
  return parts.join(" · ") || "执行";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 顶部统计卡片：数量 + 是否延迟加载。 */
function summaryCards(summary, { fmtNumber }) {
  const cards = [
    { label: "错误", value: summary.error, className: "error" },
    { label: "警告", value: summary.warning, className: "warn" },
    { label: "提示", value: summary.info, className: "" },
    { label: "可操作文档", value: summary.actionable, className: "accent" },
    { label: "延迟加载", value: summary.deferredItems, className: "", title: "旧管线产物：本版不批量重解析" },
  ];
  return `
    <div class="quality-summary">
      ${cards.map((card) => `
        <div class="quality-stat${card.className ? ` ${card.className}` : ""}"${card.title ? ` title="${escapeAttr(card.title)}"` : ""}>
          <span class="quality-stat-value">${fmtNumber(card.value)}</span>
          <span class="quality-stat-label">${escapeHtml(card.label)}</span>
        </div>`).join("")}
    </div>
  `;
}

function selectionBar({ name, group, selected, busy }) {
  if (selected.length === 0) return "";
  const action = qualityBatchAction(group);
  const actionLabel = action === "trust" ? "批量标可信度" : `预览并执行：${qualityActionLabel(action)}`;
  return `
    <div class="quality-bulk">
      <strong>已选 ${selected.length} 篇</strong>
      <span class="muted">${escapeHtml(group?.label ?? "")}${group?.hint ? ` · ${escapeHtml(group.hint)}` : ""}</span>
      ${action === ""
        ? `<span class="muted">该组需要逐篇人工处理</span>`
        : `<button type="button" class="btn primary" data-action="quality-preview" data-name="${escapeAttr(name)}" data-code="${escapeAttr(group.code)}" data-act="${escapeAttr(action)}"${busy ? " disabled" : ""}>${escapeHtml(actionLabel)}</button>`}
      <button type="button" class="btn" data-action="quality-select-clear"${busy ? " disabled" : ""}>取消选择</button>
    </div>
  `;
}

function rowActions({ name, group, item, readOnly, busy }) {
  if (readOnly) return `<span class="muted">只读共享</span>`;
  const ids = qualityItemIds(item);
  const disabled = busy ? " disabled" : "";
  const buttons = [];
  const badPages = Array.isArray(item?.badPages) ? item.badPages : [];
  const single = ids.length === 1 && item?.docs?.length !== 2;
  if (single && badPages.length > 0) {
    buttons.push(`<button type="button" class="btn" data-action="quality-open" data-name="${escapeAttr(name)}" data-id="${escapeAttr(ids[0])}" data-page="${badPages[0]}">查看原页</button>`);
  }
  const allowed = Array.isArray(group?.allowedActions) ? group.allowedActions : [];
  if (allowed.includes("reparse-pages")) {
    buttons.push(`<button type="button" class="btn" data-action="quality-act" data-name="${escapeAttr(name)}" data-code="${escapeAttr(group.code)}" data-act="reparse-pages" data-ids="${escapeAttr(ids.join(","))}"${disabled}>重解析</button>`);
  }
  if (allowed.includes("retry-import")) {
    buttons.push(`<button type="button" class="btn" data-action="quality-act" data-name="${escapeAttr(name)}" data-code="${escapeAttr(group.code)}" data-act="retry-import" data-ids="${escapeAttr(ids.join(","))}"${disabled}>重试导入</button>`);
  }
  if (allowed.includes("keep")) {
    buttons.push(`<button type="button" class="btn" data-action="quality-act" data-name="${escapeAttr(name)}" data-code="${escapeAttr(group.code)}" data-act="keep" data-ids="${escapeAttr(ids.join(","))}"${disabled}>标记保留</button>`);
  }
  if (allowed.includes("remove")) {
    buttons.push(`<button type="button" class="btn danger" data-action="quality-act" data-name="${escapeAttr(name)}" data-code="${escapeAttr(group.code)}" data-act="remove" data-ids="${escapeAttr(ids.join(","))}"${disabled}>软删除</button>`);
  }
  // 摘要与标准号必须人工判断：直接打开资料弹窗，逐篇处理。
  if (allowed.includes("describe") || allowed.includes("trust")) {
    buttons.push(`<button type="button" class="btn" data-action="open-doc" data-kb="${escapeAttr(name)}" data-id="${escapeAttr(ids[0])}"${disabled}>${allowed.includes("describe") ? "补摘要" : "标可信度"}</button>`);
  }
  return buttons.join("") || `<span class="muted">—</span>`;
}

function documentLines(item) {
  const docs = Array.isArray(item?.docs) ? item.docs.filter((doc) => doc?.missing !== true) : [];
  if (docs.length < 2) return "";
  return `<ul class="quality-docs">${docs.map((doc) => `<li>${escapeHtml(doc.title || doc.id)}${doc.standardNo ? ` <span class="muted">${escapeHtml(doc.standardNo)}</span>` : ""}</li>`).join("")}</ul>`;
}

function rowsForGroup({ name, group, selected, readOnly, busy, fmtNumber }) {
  const batchAction = qualityBatchAction(group);
  const canSelect = !readOnly && batchAction !== "";
  const items = Array.isArray(group.items) ? group.items : [];
  if (items.length === 0) {
    return `<p class="muted quality-empty">${group.deferred ? "该组明细按需加载（旧管线产物不影响现有内容）。" : "没有需要展示的明细。"}</p>`;
  }
  return `
    <table class="table quality-table">
      <thead>
        <tr>
          ${canSelect ? `<th class="col-check"><input type="checkbox" data-action="quality-select-all" data-code="${escapeAttr(group.code)}" aria-label="选择本组可操作资料"${qualitySelectionAll(items).every((id) => selected.includes(id)) && items.length > 0 ? " checked" : ""} /></th>` : `<th></th>`}
          <th>资料</th>
          <th>证据</th>
          <th>动作</th>
        </tr>
      </thead>
      <tbody>
        ${items.map((item) => {
          const ids = qualityItemIds(item);
          const checked = ids.length > 0 && ids.every((id) => selected.includes(id));
          return `<tr${checked ? ` class="selected"` : ""}>
            <td class="col-check">${canSelect
              ? `<input type="checkbox" data-action="quality-select" data-code="${escapeAttr(group.code)}" data-ids="${escapeAttr(ids.join(","))}"${checked ? " checked" : ""} aria-label="选择 ${escapeAttr(item.title)}" />`
              : ""}</td>
            <td>
              <div class="quality-title">${escapeHtml(item.title || item.docId)}</div>
              <div class="muted quality-id">${escapeHtml(ids.join(", "))}${item.version ? ` · v${fmtNumber(item.version)}` : ""}${item.updatedAt ? ` · ${formatDate(item.updatedAt)}` : ""}</div>
              ${documentLines(item)}
            </td>
            <td class="muted quality-evidence">${escapeHtml(qualityEvidence(item, group))}</td>
            <td class="quality-actions">${rowActions({ name, group, item, readOnly, busy })}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

function groupPager({ group, focused, fmtNumber }) {
  if (!focused) {
    if (group.count > group.returned) {
      return `<div class="quality-more"><span class="muted">还有 ${fmtNumber(group.count - group.returned)} 条未显示</span><button type="button" class="btn" data-action="quality-group" data-code="${escapeAttr(group.code)}">查看本组全部</button></div>`;
    }
    return "";
  }
  const total = Math.max(0, Math.round(Number(group.matched) || 0));
  const offset = Math.max(0, Math.round(Number(group.offset) || 0));
  const returned = Math.max(0, Math.round(Number(group.returned) || 0));
  const limit = Math.max(1, Math.round(Number(group.limit) || 50));
  const start = total === 0 ? 0 : offset + 1;
  const end = offset + returned;
  return `
    <div class="pager quality-pager">
      <button type="button" class="btn" data-action="quality-page" data-offset="${Math.max(0, offset - limit)}"${offset <= 0 ? " disabled" : ""}>上一页</button>
      <span class="muted">第 ${start}–${end} 条 / 共 ${fmtNumber(total)} 条</span>
      <button type="button" class="btn" data-action="quality-page" data-offset="${offset + limit}"${offset + returned >= total ? " disabled" : ""}>下一页</button>
    </div>
  `;
}

function groupSection({ name, group, filter, focused, selected, readOnly, busy, fmtNumber }) {
  const meta = severityMeta(group.severity);
  const canSelect = !readOnly && qualityBatchAction(group) !== "";
  return `
    <section class="quality-group" data-code="${escapeAttr(group.code)}">
      <header class="quality-group-head">
        <span class="quality-group-icon ${meta.className}" title="${escapeAttr(meta.label)}">${meta.icon}</span>
        <strong>${escapeHtml(group.label)}</strong>
        <span class="badge${meta.className ? ` ${meta.className}` : ""}">${fmtNumber(group.count)}</span>
        ${group.deferred ? `<span class="badge">延迟加载</span>` : ""}
        ${group.actionable ? `<span class="badge accent">可操作</span>` : ""}
        ${group.hint ? `<span class="muted quality-hint">${escapeHtml(group.hint)}</span>` : ""}
        <span class="quality-group-actions">
          ${group.deferred && group.returned === 0
            ? `<button type="button" class="btn" data-action="quality-group" data-code="${escapeAttr(group.code)}">加载明细</button>`
            : ""}
          ${focused ? `<button type="button" class="btn" data-action="quality-filter" data-filter="">返回全部组</button>` : ""}
          ${canSelect ? `<button type="button" class="btn" data-action="quality-select-group" data-code="${escapeAttr(group.code)}"${busy ? " disabled" : ""}>全选本组</button>` : ""}
        </span>
      </header>
      ${rowsForGroup({ name, group, selected, readOnly, busy, fmtNumber })}
      ${groupPager({ group, focused, fmtNumber })}
    </section>
  `;
}

/** 上次执行结果（逐项列出成功/失败），刷新页面后仍是同一份 state。 */
export function renderQualityLastResult(result) {
  if (!result) return "";
  const results = Array.isArray(result.results) ? result.results : [];
  const ok = Math.max(0, Math.round(Number(result.ok) || 0));
  const failed = Math.max(0, Math.round(Number(result.failed) || 0));
  return `
    <div class="panel quality-result">
      <div class="table-head">
        <h3>上次执行：${escapeHtml(qualityActionLabel(result.action))}</h3>
        <span class="muted">成功 ${ok} 篇${failed > 0 ? ` · 失败 ${failed} 篇` : ""}${result.jobId ? ` · 任务 ${escapeHtml(result.jobId)}` : ""}</span>
      </div>
      ${results.length === 0 ? `<p class="muted">没有逐项结果。</p>` : `
        <ul class="quality-result-list">
          ${results.map((item) => `<li class="${item.ok ? "ok" : "fail"}">${item.ok ? "✓" : "✗"} ${escapeHtml(item.title || item.id)}${item.ok ? "" : `：${escapeHtml(item.error ?? "失败")}`}</li>`).join("")}
        </ul>`}
    </div>
  `;
}

/** 动作预览弹窗正文（纯 HTML，由 modals.js 放进表单里）。 */
export function renderQualityPreviewBody(preview) {
  const items = Array.isArray(preview?.items) ? preview.items : [];
  const errors = Array.isArray(preview?.errors) ? preview.errors : [];
  const valid = Math.max(0, Math.round(Number(preview?.valid) || items.length));
  const invalid = Math.max(0, Math.round(Number(preview?.invalid) || errors.length));
  return `
    <div class="quality-preview">
      <p class="muted">将执行 <strong>${escapeHtml(qualityActionLabel(preview?.action))}</strong>：${valid} 篇有效${invalid > 0 ? `，${invalid} 篇跳过` : ""}。预览不会写入任何数据。</p>
      ${items.length > 0 ? `
        <table class="table quality-preview-table">
          <thead><tr><th>资料</th><th>将执行</th></tr></thead>
          <tbody>
            ${items.map((item) => `<tr>
              <td>${escapeHtml(item.title || item.id)}${item.badPages?.length ? `<div class="muted">坏页 ${escapeHtml(item.badPages.join(","))}</div>` : ""}</td>
              <td class="muted">${escapeHtml(previewTargetText(item))}</td>
            </tr>`).join("")}
          </tbody>
        </table>` : `<p class="muted">没有可执行的资料。</p>`}
      ${errors.length > 0 ? `
        <div class="quality-preview-errors">
          <strong>跳过 ${errors.length} 篇</strong>
          <ul>${errors.map((item) => `<li>${escapeHtml(item.title || item.id)}：${escapeHtml(item.error ?? "")}</li>`).join("")}</ul>
        </div>` : ""}
      ${preview?.hint ? `<p class="muted quality-preview-hint">${escapeHtml(preview.hint)}</p>` : ""}
    </div>
  `;
}

/** 质量 tab 主渲染。state.quality 由 app.js 维护。 */
export function renderQualityPanel(state, detail, { fmtNumber }) {
  const quality = state.quality ?? {};
  const kb = detail?.kb ?? {};
  const name = String(kb.name ?? "");
  const readOnly = kb.readOnly === true;
  const data = quality.data ?? null;
  const loading = quality.loading === true;
  const error = String(quality.error ?? "");
  const busy = quality.busy === true;
  const selected = Array.isArray(quality.selected) ? quality.selected : [];
  const selectionGroupCode = String(quality.selectionGroup ?? "");
  const filter = qualityFilter(quality.filter);
  const focused = String(quality.group ?? "");
  const query = String(quality.query ?? "");

  const toolbar = `
    <div class="quality-toolbar">
      <div class="segmented" role="group" aria-label="质量筛选">
        ${QUALITY_QUICK_FILTERS.map((item) => `
          <button type="button" class="seg ${filter === item.id ? "active" : ""}" data-action="quality-filter" data-filter="${escapeAttr(item.id)}">${escapeHtml(item.label)}</button>`).join("")}
      </div>
      <label class="search">
        <input data-quality-query value="${escapeAttr(query)}" placeholder="搜索标题或标准号" aria-label="搜索质量问题" />
      </label>
      <button type="button" class="btn" data-action="quality-search">搜索</button>
      <button type="button" class="btn" data-action="quality-reload"${loading ? " disabled" : ""}>刷新</button>
    </div>
  `;

  if (error && !data) {
    return `<div class="panel"><h3>质量</h3><p class="form-error">${escapeHtml(error)}</p>${toolbar}</div>`;
  }
  if (!data) {
    return `<div class="panel"><h3>质量</h3><div class="state">${loading ? "正在体检…" : "加载中…"}</div>${toolbar}</div>`;
  }

  const summary = data.summary ?? {};
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const selectionGroup = groups.find((group) => group.code === selectionGroupCode) ?? null;
  const lastResult = quality.lastResult ?? null;
  const showSelection = selected.length > 0 && selectionGroup !== null;

  return `
    <div class="panel quality-panel">
      <div class="table-head">
        <h3>质量队列</h3>
        <span class="muted">${fmtNumber(summary.totalDocs)} 篇 · ${fmtNumber(summary.groups)} 组 · ${focused ? `只看 ${escapeHtml(groups[0]?.label ?? focused)}` : "全部组"}</span>
      </div>
      ${readOnly ? `<p class="muted quality-readonly">只读共享：可以查看与筛选，动作已禁用。</p>` : ""}
      ${summaryCards(summary, { fmtNumber })}
      ${toolbar}
      ${showSelection ? selectionBar({ name, group: selectionGroup, selected, busy }) : ""}
      ${groups.length === 0
        ? `<div class="state quality-empty-state">没有发现机械问题${query ? `（搜索「${escapeHtml(query)}」无结果）` : ""}。</div>`
        : groups.map((group) => groupSection({
            name,
            group,
            filter,
            focused: focused !== "" && group.code === focused,
            selected,
            readOnly,
            busy,
            fmtNumber,
          })).join("")}
    </div>
    ${renderQualityLastResult(lastResult)}
  `;
}
