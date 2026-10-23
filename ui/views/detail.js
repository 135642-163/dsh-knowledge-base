import { hrefForKb } from "../router.js";
import { renderStdPanel } from "./std.js";

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
            ${kb.status === "warn" ? `<span class="badge warn">有失败</span>` : ""}
          </div>
          <p class="muted">${kb.description ? escapeHtml(kb.description) : "未填写简介"}</p>
        </div>
        <div class="detail-actions">
          <button class="btn primary" data-action="upload" data-kb="${escapeAttr(kb.name)}">${icons.upload}<span>上传资料</span></button>
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
      ${tab === "docs" ? docs(kb.name, state, { fmtNumber }) : ""}
      ${tab === "notes" ? notes(kb, { fmtNumber }) : ""}
      ${tab === "log" ? log(detail.logTail) : ""}
      ${tab === "std" ? renderStdPanel(state, kb.name, { escapeHtml }) : ""}
      ${tab === "settings" ? settings(kb) : ""}
    </section>
  `;
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

function docs(name, state, { fmtNumber }) {
  const page = state.docs;
  if (!page.items || page.items.length === 0) {
    return `<div class="state">还没有资料，点右上角的「上传资料」开始导入。</div>`;
  }
  return `
    <div class="panel">
      <div class="table-head">
        <strong>${fmtNumber(page.total)} 篇</strong>
        <span class="muted">第 ${page.offset + 1}–${Math.min(page.offset + page.items.length, page.total)} 篇</span>
      </div>
      <table class="table">
        <thead><tr><th>标题</th><th>类型</th><th>页数</th><th>可信度</th><th>更新</th></tr></thead>
        <tbody>
          ${page.items.map((doc) => `<tr>
            <td><button class="link" data-action="open-doc" data-kb="${escapeAttr(name)}" data-id="${escapeAttr(doc.id)}">${escapeHtml(doc.title)}</button></td>
            <td class="muted">${escapeHtml(doc.type ?? "")}</td>
            <td class="muted">${fmtNumber(doc.pages)}</td>
            <td class="muted">${escapeHtml(doc.trust)}</td>
            <td class="muted">${formatDate(doc.updatedAt)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <div class="pager">
        <button class="btn" data-action="docs-page" data-offset="${Math.max(0, page.offset - page.limit)}" ${page.offset <= 0 ? "disabled" : ""}>上一页</button>
        <span class="muted">第 ${Math.floor(page.offset / page.limit) + 1} 页</span>
        <button class="btn" data-action="docs-page" data-offset="${page.offset + page.limit}" ${page.offset + page.items.length >= page.total ? "disabled" : ""}>下一页</button>
      </div>
    </div>
  `;
}

function notes(kb, { fmtNumber }) {
  return `<div class="panel"><h3>笔记</h3><p class="muted">${fmtNumber(kb.docs.notes)} 篇编译页；Slice 2 增加全文预览。</p></div>`;
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
