/**
 * 回收站：归档库与全局已删除资料两个分区。
 *  - 归档库：沿用 0.23.0 的列表/空状态；
 *  - 已删除资料：只列活跃库里的软删除资料（归档库随库恢复，不单独列出），
 *    支持勾选、批量恢复（排除已跨库移动的行）、撤销移动与按库彻底删除。
 * 纯渲染与选择/确认文案都是可导出函数，DOM 交互留给 app.js 绑定。
 */

export const TRASH_DOCS_CAP = 500;
export const TRASH_DOCS_COPY = "已删除资料只列活跃库中的资料；归档库内的资料随库一起恢复，不单独列出。";
export const PURGE_DOCS_WARNING = "彻底删除会移除原件、解析内容与历史版本，且撤销移动将不再可用。";
export const MULTI_KB_PURGE_HINT = "彻底删除一次只能处理同一个库的资料";

/** 路由 `?tab=docs` 才展示已删除资料，其余值（含手改 URL）回落到归档库。 */
export function trashTab(current) {
  return String(current?.query?.tab ?? "") === "docs" ? "docs" : "archived";
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

/** 已删除资料的选择项键：同一 id 可能出现在不同库里。 */
export function trashDocKey(doc) {
  return `${String(doc?.kb ?? "")}\u0000${String(doc?.id ?? "")}`;
}

/** 是否是跨库移动留下的源库墓碑（`movedTo.kb` 非空）；脏数据按未移动处理。 */
function trashDocMoved(doc) {
  return Boolean(doc?.movedTo && typeof doc.movedTo === "object"
    && typeof doc.movedTo.kb === "string" && doc.movedTo.kb !== "");
}

/**
 * 移动源行的目标副本状态：服务端给出 deleted/missing 时可直接恢复；
 * 其它（含旧服务端没有 movedToState）一律按 live 处理——只能撤销移动，安全默认。
 */
export function trashMovedState(doc) {
  if (!trashDocMoved(doc)) return "";
  return doc.movedToState === "deleted" || doc.movedToState === "missing"
    ? doc.movedToState
    : "live";
}

function selectionEntry(doc) {
  const entry = {
    kb: String(doc?.kb ?? ""),
    id: String(doc?.id ?? ""),
    title: String(doc?.title ?? ""),
  };
  // 选择项带上移动标记与目标状态：批量恢复要排除目标仍可用的移动行，
  // 目标已删除/缺失的移动行则可以像普通软删除资料一样恢复。
  if (trashDocMoved(doc)) {
    entry.movedTo = { kb: doc.movedTo.kb };
    const state = trashMovedState(doc);
    if (state !== "live") entry.movedToState = state;
  }
  return entry;
}

function selectionList(selected) {
  return (Array.isArray(selected) ? selected : [])
    .map(selectionEntry)
    .filter((entry) => entry.kb !== "" && entry.id !== "");
}

/** 勾选是否都来自同一个库（空选择视为可批量处理，按钮仅在已选时渲染）。 */
export function sameTrashKb(selected) {
  const kbs = new Set(selectionList(selected).map((entry) => entry.kb));
  return kbs.size <= 1;
}

/** 勾选所在库；跨库或空选择返回 ""。 */
export function trashSelectionKb(selected) {
  const kbs = new Set(selectionList(selected).map((entry) => entry.kb));
  return kbs.size === 1 ? [...kbs][0] : "";
}

export function trashSelectionHas(selected, kb, id) {
  const key = `${String(kb ?? "")}\u0000${String(id ?? "")}`;
  return selectionList(selected).some((entry) => trashDocKey(entry) === key);
}

/** 单行复选框：checked 明确给出时按它增删，否则按当前状态取反。 */
export function trashSelectionToggleOne(selected, doc, checked) {
  const current = selectionList(selected);
  const entry = selectionEntry(doc);
  if (entry.kb === "" || entry.id === "") return current;
  const key = trashDocKey(entry);
  const exists = current.some((item) => trashDocKey(item) === key);
  const want = checked === undefined ? !exists : Boolean(checked);
  if (!want) return current.filter((item) => trashDocKey(item) !== key);
  return exists ? current : [...current, entry];
}

/** 表头复选框：当前列表全选时再点=全部取消，否则补齐缺少的行。 */
export function trashSelectionToggleAll(selected, docs) {
  const rows = (Array.isArray(docs) ? docs : [])
    .map(selectionEntry)
    .filter((entry) => entry.kb !== "" && entry.id !== "");
  const current = selectionList(selected);
  if (rows.length === 0) return current;
  const selectedKeys = new Set(current.map(trashDocKey));
  if (rows.every((row) => selectedKeys.has(trashDocKey(row)))) {
    const pageKeys = new Set(rows.map(trashDocKey));
    return current.filter((item) => !pageKeys.has(trashDocKey(item)));
  }
  const seen = new Set(current.map(trashDocKey));
  const next = [...current];
  for (const row of rows) {
    const key = trashDocKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(row);
  }
  return next;
}

export function trashSelectionAllSelected(selected, docs) {
  const rows = (Array.isArray(docs) ? docs : [])
    .map(selectionEntry)
    .filter((entry) => entry.kb !== "" && entry.id !== "");
  if (rows.length === 0) return false;
  const keys = new Set(selectionList(selected).map(trashDocKey));
  return rows.every((row) => keys.has(trashDocKey(row)));
}

/**
 * 批量彻底删除的目标校验：空选择或多库混合时返回可展示的原因。
 * @returns {{ok: boolean, kb: string, entries: Array<{kb:string,id:string,title:string}>, reason: string}}
 */
export function trashPurgeTarget(selected) {
  const entries = selectionList(selected);
  if (entries.length === 0) {
    return { ok: false, kb: "", entries, reason: "请先选择要彻底删除的资料" };
  }
  const kbs = new Set(entries.map((entry) => entry.kb));
  if (kbs.size > 1) {
    return { ok: false, kb: "", entries, reason: MULTI_KB_PURGE_HINT };
  }
  return { ok: true, kb: entries[0].kb, entries, reason: "" };
}

/**
 * 批量恢复的目标：排除目标副本仍可用（live）的移动行——普通恢复会造出第二份
 * 可用副本；目标副本已删除/缺失的移动行可以恢复。选择本身仍保留这些行，以便
 * 一起彻底删除；`excluded` 供工具条提示。
 */
export function trashRestoreTargets(selected, docs = []) {
  const entries = selectionList(selected);
  const byKey = new Map(
    (Array.isArray(docs) ? docs : []).map((doc) => [trashDocKey(doc), doc])
  );
  const restorable = [];
  let excluded = 0;
  for (const entry of entries) {
    // 以当前列表为准：旧选择项可能没带移动标记，或状态已经变化。
    const state = trashMovedState(byKey.get(trashDocKey(entry)) ?? entry);
    if (state === "live") excluded += 1;
    else restorable.push(entry);
  }
  return { entries: restorable, excluded };
}

/**
 * 彻底删除确认正文：最多列 10 个标题 + 「共 N 篇」+ 不可恢复警告。
 * 传 total 用于「清空本库已删除资料」这类没有逐篇标题的场景。
 */
export function purgeDocsConfirmBody({ docs = [], total, kb = "" } = {}) {
  const list = (Array.isArray(docs) ? docs : []).map((doc) => String(doc?.title ?? doc?.id ?? ""));
  const shown = list.slice(0, 10);
  const lines = shown.map((title) => `· ${title}`);
  if (list.length > shown.length) lines.push(`…等 ${list.length} 篇`);
  const hasTotal = total !== undefined && total !== null && Number.isFinite(Number(total));
  const count = hasTotal ? Math.max(0, Math.round(Number(total))) : list.length;
  return [
    ...(kb !== "" ? [`库：${kb}`] : []),
    ...lines,
    `共 ${count} 篇`,
    "",
    PURGE_DOCS_WARNING,
  ].join("\n");
}

/** 顶部两个分区页签；链接直接写 hash，刷新/后退都能回到同一分区。 */
export function renderTrashTabs({ tab = "archived", archivedCount = 0, docsCount = 0, fmtNumber = formatNumber } = {}) {
  const active = tab === "docs" ? "docs" : "archived";
  return `
    <nav class="segmented trash-tabs" role="tablist" aria-label="回收站分区">
      <a class="seg${active === "archived" ? " active" : ""}" role="tab" aria-selected="${active === "archived"}" href="#/trash">归档库 <span class="seg-count">${fmtNumber(archivedCount)}</span></a>
      <a class="seg${active === "docs" ? " active" : ""}" role="tab" aria-selected="${active === "docs"}" href="#/trash?tab=docs">已删除资料 <span class="seg-count">${fmtNumber(docsCount)}</span></a>
    </nav>
  `;
}

/** 归档库分区：保持 0.23.0 的加载/错误/列表/空状态。 */
export function renderTrashArchived({ items = [], loading = false, error = "", icons = {}, fmtNumber = formatNumber } = {}) {
  if (loading && items.length === 0) return `<div class="state">回收站加载中…</div>`;
  if (error) {
    return `<div class="state error">${escapeHtml(error)}<button class="btn" data-action="reload-trash">重试</button></div>`;
  }
  return `
    <p class="muted trash-help">彻底删除不可撤销；仅对回收站中的库生效。</p>
    ${items.length === 0 ? `
      <div class="empty-card">
        <div class="empty-icon">${icons.trash ?? ""}</div>
        <h2>回收站是空的</h2>
        <p class="muted">在库设置里归档的库会出现在这里。</p>
      </div>` : `
      <div class="panel">
        <table class="table">
          <thead><tr><th>名称</th><th>文档</th><th>笔记</th><th>归档时间</th><th></th></tr></thead>
          <tbody>
            ${items.map((item) => `<tr>
              <td>
                <strong>${escapeHtml(item.name)}</strong>
                ${item.restorable ? "" : `<div class="muted">不可恢复：${escapeHtml(item.reason ?? "")}</div>`}
              </td>
              <td class="muted">${fmtNumber(item.docs)}</td>
              <td class="muted">${fmtNumber(item.notes)}</td>
              <td class="muted">${formatDate(item.archivedAt)}</td>
              <td class="right">
                <div class="trash-actions">
                  ${item.restorable
                    ? `<button class="btn" data-action="restore-kb" data-dir="${escapeAttr(item.dir)}" data-name="${escapeAttr(item.name)}">恢复</button>`
                    : `<button class="btn" disabled>不可恢复</button>`}
                  <button class="btn danger" data-action="purge-kb" data-dir="${escapeAttr(item.dir)}" data-name="${escapeAttr(item.name)}">彻底删除</button>
                </div>
              </td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>`}
  `;
}

/** 多选工具条：跨库时彻底删除禁用并展示原因；批量恢复自动排除已移动资料。 */
export function renderTrashBulk({
  selected = [],
  docs = [],
  busy = false,
  fmtNumber = formatNumber,
} = {}) {
  const list = selectionList(selected);
  if (list.length === 0) return "";
  const sameKb = sameTrashKb(list);
  const restore = trashRestoreTargets(list, docs);
  return `
    <div class="docs-bulk trash-bulk">
      <strong>已选 ${fmtNumber(list.length)} 篇</strong>
      <button type="button" class="btn" data-action="trash-docs-restore-selected"${busy || restore.entries.length === 0 ? " disabled" : ""}>恢复所选</button>
      ${restore.excluded > 0 ? `<span class="muted trash-bulk-hint">已排除 ${fmtNumber(restore.excluded)} 篇已移动资料，请在对应库中撤销移动</span>` : ""}
      <button type="button" class="btn danger" data-action="trash-docs-purge-selected"${busy || !sameKb ? " disabled" : ""}>彻底删除所选</button>
      ${sameKb ? "" : `<span class="muted trash-bulk-hint">${MULTI_KB_PURGE_HINT}</span>`}
      <button type="button" class="btn" data-action="trash-doc-clear"${busy ? " disabled" : ""}>取消选择</button>
    </div>
  `;
}

/**
 * 已删除资料分区：表头勾选/全选、行内恢复与彻底删除。
 * docs = { items, total, truncated, error }。
 */
export function renderTrashDocs({
  docs = {},
  selectedDocs = [],
  loading = false,
  busy = false,
  icons = {},
  fmtNumber = formatNumber,
} = {}) {
  // 接口只返回软删除资料；这里再挡一次 status/deleted 明确表示在用的脏数据。
  const items = (Array.isArray(docs?.items) ? docs.items : []).filter((doc) => doc?.deleted !== false);
  const total = Math.max(0, Math.round(Number(docs?.total) || 0));
  const truncated = docs?.truncated === true;
  const error = String(docs?.error ?? "");
  if (error) {
    return `<div class="state error">${escapeHtml(error)}<button class="btn" data-action="reload-trash">重试</button></div>`;
  }
  if (loading && items.length === 0) return `<div class="state">已删除资料加载中…</div>`;
  if (items.length === 0) {
    return `
      <div class="trash-docs-head">
        <span class="muted">共 ${fmtNumber(total)} 篇</span>
      </div>
      <div class="empty-card">
        <div class="empty-icon">${icons.trash ?? ""}</div>
        <h2>没有已删除的资料</h2>
        <p class="muted">已删除的资料会先进入这里，可恢复或彻底删除。</p>
      </div>
    `;
  }
  const selected = selectionList(selectedDocs);
  const allSelected = trashSelectionAllSelected(selected, items);
  return `
    <div class="trash-docs-head">
      <span class="muted">共 ${fmtNumber(total)} 篇</span>
      ${truncated ? `<span class="badge warn">仅显示前 ${fmtNumber(TRASH_DOCS_CAP)} 篇</span>` : ""}
    </div>
    ${renderTrashBulk({ selected, docs: items, busy, fmtNumber })}
    <div class="table-scroll">
      <table class="table trash-docs-table">
        <thead><tr>
          <th class="col-check"><input type="checkbox" data-action="trash-doc-select-all" aria-label="选择全部已删除资料"${allSelected ? " checked" : ""}${busy ? " disabled" : ""} /></th>
          <th>库</th><th>标题</th><th>类型</th><th>删除时间</th><th class="col-actions">操作</th>
        </tr></thead>
        <tbody>
          ${items.map((doc) => {
            const checked = trashSelectionHas(selected, doc.kb, doc.id);
            // 目标副本仍可用：只能撤销移动（普通恢复会与目标副本并存）；
            // 目标副本已删除/缺失：源库墓碑可以恢复，由服务端清掉 movedTo。
            const movedState = trashMovedState(doc);
            const action = movedState === "live"
              ? `<button type="button" class="btn mini" data-action="trash-doc-undo-move" data-kb="${escapeAttr(doc.kb)}" data-id="${escapeAttr(doc.id)}" data-target="${escapeAttr(doc.movedTo.kb)}"${busy ? " disabled" : ""}>撤销移动</button>`
              : `<button type="button" class="btn mini" data-action="trash-doc-restore" data-kb="${escapeAttr(doc.kb)}" data-id="${escapeAttr(doc.id)}"${busy ? " disabled" : ""}>恢复</button>`;
            return `<tr class="trash-doc-row">
              <td class="col-check"><input type="checkbox" data-action="trash-doc-select" data-kb="${escapeAttr(doc.kb)}" data-id="${escapeAttr(doc.id)}" aria-label="选择 ${escapeAttr(doc.title)}"${checked ? " checked" : ""}${busy ? " disabled" : ""} /></td>
              <td><span class="badge trash-kb-badge">${escapeHtml(doc.kb)}</span></td>
              <td>${escapeHtml(doc.title)}</td>
              <td class="muted">${escapeHtml(doc.type ?? "")}</td>
              <td class="muted">${formatDate(doc.deletedAt)}</td>
              <td class="col-actions">
                <div class="trash-actions">
                  ${action}
                  <button type="button" class="btn mini danger" data-action="trash-doc-purge" data-kb="${escapeAttr(doc.kb)}" data-id="${escapeAttr(doc.id)}"${busy ? " disabled" : ""}>彻底删除</button>
                </div>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

export function renderTrash(state, current, { icons = {}, fmtNumber = formatNumber } = {}) {
  const trash = state?.trash ?? {};
  const items = Array.isArray(trash.items) ? trash.items : [];
  const docs = trash.docs ?? {};
  const docItems = Array.isArray(docs.items) ? docs.items : [];
  const docTotal = Math.max(0, Math.round(Number(docs.total) || 0));
  const tab = trashTab(current);
  const loading = Boolean(trash.loading);
  const description = tab === "docs"
    ? TRASH_DOCS_COPY
    : `归档的库不在总览和检索里；恢复后回到正常使用。${fmtNumber(items.length)} 个归档库。`;
  return `
    <section class="trash">
      <div class="overview-head">
        <div>
          <h1>回收站</h1>
          <p class="muted">${description}</p>
        </div>
      </div>
      ${renderTrashTabs({ tab, archivedCount: items.length, docsCount: docTotal, fmtNumber })}
      ${tab === "docs"
        ? renderTrashDocs({
          docs: { ...docs, items: docItems, total: docTotal },
          selectedDocs: trash.selectedDocs,
          loading,
          busy: Boolean(trash.busy),
          icons,
          fmtNumber,
        })
        : renderTrashArchived({ items, loading, error: trash.error ?? "", icons, fmtNumber })}
    </section>
  `;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
