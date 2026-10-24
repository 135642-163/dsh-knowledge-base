export function renderTrash(state, { icons, fmtNumber }) {
  const { items, loading, error } = state.trash;
  if (loading && items.length === 0) return `<div class="state">回收站加载中…</div>`;
  if (error) {
    return `<div class="state error">${escapeHtml(error)}<button class="btn" data-action="reload-trash">重试</button></div>`;
  }
  return `
    <section class="trash">
      <div class="overview-head">
        <div>
          <h1>回收站</h1>
          <p class="muted">归档的库不在总览和检索里；恢复后回到正常使用。${fmtNumber(items.length)} 个归档库。</p>
        </div>
      </div>
      <p class="muted trash-help">彻底删除不可撤销；仅对回收站中的库生效。</p>
      ${items.length === 0 ? `
        <div class="empty-card">
          <div class="empty-icon">${icons.trash}</div>
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
