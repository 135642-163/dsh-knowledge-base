import { api, ApiError } from "../api.js";

// 弹窗关闭统一走 closeOverlay：同时摘掉 Esc 监听并从栈里移除。
// 预览弹窗叠在资料详情弹窗上时，只有最上层响应 Esc。
const overlayStack = [];
const overlayClosers = new WeakMap();

function overlay(html, { className = "" } = {}) {
  const node = document.createElement("div");
  node.className = "overlay";
  node.innerHTML = `<div class="modal${className ? ` ${className}` : ""}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(node);

  const onKeydown = (event) => {
    if (event.key !== "Escape") return;
    if (overlayStack.at(-1) !== node) return;
    close();
  };
  const close = () => {
    overlayClosers.delete(node);
    const index = overlayStack.indexOf(node);
    if (index >= 0) overlayStack.splice(index, 1);
    document.removeEventListener("keydown", onKeydown);
    node.remove();
  };

  overlayStack.push(node);
  overlayClosers.set(node, close);
  document.addEventListener("keydown", onKeydown);
  node.addEventListener("mousedown", (event) => { if (event.target === node) close(); });
  node.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
  return node;
}

/** 关闭 overlay 创建的弹窗；对已被外部移除的节点是安全的空操作。 */
function closeOverlay(node) {
  const close = overlayClosers.get(node);
  if (close) {
    close();
    return;
  }
  node?.remove?.();
}

/**
 * 通用确认弹窗。body 按纯文本渲染（内部统一 escapeHtml），
 * requireCheckbox=true 时需勾选确认才能提交；
 * requireText 传入库名时需逐字输入，danger 用危险色确认按钮。
 * onConfirm 可同步或异步。
 */
export function openConfirmModal({ title, body = "", confirmText = "确认", requireCheckbox = false, requireText, danger = false, onConfirm } = {}) {
  const required = requireText === undefined || requireText === null ? "" : String(requireText);
  const needsText = required !== "";
  const node = overlay(`
    <form class="modal-form">
      <h2>${escapeHtml(title)}</h2>
      <div class="confirm-body"><p class="muted">${escapeHtml(body)}</p></div>
      ${requireCheckbox ? `<label class="check"><input type="checkbox" name="ack" /> 我已知晓</label>` : ""}
      ${needsText ? `<label class="field"><span>输入库名「${escapeHtml(required)}」以确认</span><input name="confirm" autocomplete="off" /></label>` : ""}
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn ${danger ? "danger" : "primary"}"${needsText ? " disabled" : ""}>${escapeHtml(confirmText)}</button>
      </div>
    </form>
  `);
  const form = node.querySelector("form");
  const error = node.querySelector(".form-error");
  const button = form.querySelector("button[type=submit]");
  const confirmInput = form.querySelector("input[name='confirm']");
  const syncConfirmState = () => {
    if (!needsText) {
      button.disabled = false;
      return;
    }
    button.disabled = String(confirmInput?.value ?? "") !== required;
  };
  if (needsText) {
    confirmInput?.addEventListener("input", () => {
      syncConfirmState();
      if (!button.disabled) error.hidden = true;
    });
    syncConfirmState();
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (requireCheckbox && !form.querySelector("input[name='ack']")?.checked) {
      error.textContent = "请先勾选「我已知晓」";
      error.hidden = false;
      return;
    }
    if (needsText && String(new FormData(form).get("confirm") ?? "") !== required) {
      error.textContent = "库名不匹配";
      error.hidden = false;
      return;
    }
    button.disabled = true;
    try {
      await onConfirm?.();
      closeOverlay(node);
    } catch (failure) {
      error.textContent = failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
      error.hidden = false;
      syncConfirmState();
    }
  };
  return node;
}

/** 知识库选择弹窗：标准更新入口用；只返回库名，具体跳转由调用方决定。 */
export function openKbPickerModal({ kbs = [], onPick } = {}) {
  const node = overlay(`
    <div class="modal-form">
      <h2>选择知识库</h2>
      <p class="muted">对哪个库检查标准更新？</p>
      <div class="uplist">
        ${kbs.length === 0 ? `<p class="muted">还没有知识库</p>` : kbs.map((kb) => {
          const docs = kb?.docs ?? {};
          const live = Number(docs.ready ?? 0) + Number(docs.importing ?? 0) + Number(docs.failed ?? 0);
          return `<button type="button" class="btn" data-kb="${escapeAttr(kb?.name ?? "")}">${escapeHtml(kb?.name ?? "")} <span class="muted">${live} 篇</span></button>`;
        }).join("")}
      </div>
      <div class="modal-actions"><button type="button" class="btn" data-close>取消</button></div>
    </div>
  `);
  node.querySelectorAll("[data-kb]").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.dataset.kb;
      closeOverlay(node);
      if (name) onPick?.(name);
    });
  });
  return node;
}

export function openCreateModal({ onCreated }) {
  const node = overlay(`
    <form class="modal-form">
      <h2>新建知识库</h2>
      <label class="field"><span>名称</span><input name="name" required maxlength="64" placeholder="例如：电气" /></label>
      <label class="field"><span>简介（可选）</span><textarea name="description" rows="3" maxlength="500" placeholder="这个库收录什么？"></textarea></label>
      <label class="field"><span>标签（可选，逗号分隔）</span><input name="tags" placeholder="电气, 一次, 二次" /></label>
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn primary">创建</button>
      </div>
    </form>
  `);
  const form = node.querySelector("form");
  const error = node.querySelector(".form-error");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    if (name === "") { error.textContent = "请输入名称"; error.hidden = false; return; }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await api.createKb({
        name,
        description: String(data.get("description") ?? ""),
        tags: String(data.get("tags") ?? "").split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      });
      closeOverlay(node);
      onCreated?.(name);
    } catch (failure) {
      error.textContent = failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
      error.hidden = false;
      button.disabled = false;
    }
  };
}

export function openArchiveModal({ name, onArchived }) {
  const node = overlay(`
    <form class="modal-form">
      <h2>归档「${escapeHtml(name)}」</h2>
      <p class="muted">目录会移动到 <code>.trash/</code>，不会删除文件；可在侧栏“回收站”恢复。</p>
      <label class="field"><span>输入库名确认</span><input name="confirm" autocomplete="off" placeholder="${escapeAttr(name)}" /></label>
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn danger">归档</button>
      </div>
    </form>
  `);
  const form = node.querySelector("form");
  const error = node.querySelector(".form-error");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const confirm = String(new FormData(form).get("confirm") ?? "");
    if (confirm !== name) { error.textContent = "库名不匹配"; error.hidden = false; return; }
    try {
      await api.archiveKb(name, confirm);
      closeOverlay(node);
      onArchived?.();
    } catch (failure) {
      error.textContent = failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
      error.hidden = false;
    }
  };
}

const PREVIEW_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const PREVIEW_TEXT_EXTENSIONS = new Set(["txt", "md"]);
const PREVIEW_OFFICE_EXTENSIONS = new Set(["doc", "docx", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "odp"]);

function extensionOf(file) {
  const name = String(file ?? "");
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 决定用哪种方式内嵌预览：
 * - note 走 /content 的合并版 markdown；txt/md 走 /content 原文；
 * - pdf 走 source?inline=1，图片直接 inline；
 * - Office 走 preview.pdf（首次请求会触发转换）；
 * - 其余格式（含电子书/压缩包等）下载原件。
 */
export function previewKindFor(doc) {
  const type = String(doc?.type ?? "").trim().toLowerCase();
  if (type === "note") return "note";
  const ext = extensionOf(doc?.sourceFile);
  if (ext === "pdf") return "pdf";
  if (PREVIEW_IMAGE_EXTENSIONS.has(ext)) return "image";
  if (PREVIEW_TEXT_EXTENSIONS.has(ext)) return "text";
  if (PREVIEW_OFFICE_EXTENSIONS.has(ext)) return "office";
  // 列表项可能没有 sourceFile：退回 api.doc 的类型字段。
  if (type === "pdf" || type.startsWith("pdf-")) return "pdf";
  if (type === "text" || type === "markdown") return "text";
  if (PREVIEW_OFFICE_EXTENSIONS.has(type)) return "office";
  return "unsupported";
}

/**
 * 预览弹窗正文（纯函数，便于单测）。urls = { inline, pdf, download }，
 * content 仅 note/text 需要：{ markdown, truncated } 或 { error }。
 */
export function renderPreviewBody({ kind, urls = {}, content } = {}) {
  const download = escapeAttr(urls.download ?? "");
  if (kind === "pdf" || kind === "office") {
    const src = escapeAttr(kind === "pdf" ? urls.inline ?? "" : urls.pdf ?? "");
    const loading = kind === "office" ? `<p class="muted preview-loading">正在转换原件，首次可能需要几秒…</p>` : "";
    return `${loading}<iframe class="preview-frame" src="${src}" title="原件预览"></iframe>`;
  }
  if (kind === "image") {
    return `<img class="preview-image" src="${escapeAttr(urls.inline ?? "")}" alt="原件预览" />`;
  }
  if (kind === "note" || kind === "text") {
    if (content?.error) {
      return `
        <div class="preview-content-error">
          <p class="form-error">${escapeHtml(content.error)}</p>
          <p class="muted">请下载原件后查看。</p>
          <a class="btn" href="${download}">下载原件</a>
        </div>
      `;
    }
    const truncated = content?.truncated ? `<p class="muted">内容较长，仅显示前 2 MB。</p>` : "";
    return `<pre class="preview-text">${escapeHtml(content?.markdown ?? "")}</pre>${truncated}`;
  }
  return `
    <div class="state preview-unsupported">
      <p>该格式暂不支持内嵌预览，请下载原件</p>
      <a class="btn" href="${download}">下载原件</a>
    </div>
  `;
}

/**
 * 打开原件预览。note/text 先拉 /content；pdf/image/office 直接内嵌。
 * 弹窗在请求返回前被关闭时，结果直接丢弃（不再写 DOM）。
 */
export function openPreviewModal({ name, doc, icons } = {}) {
  const kind = previewKindFor(doc);
  const urls = {
    inline: api.sourceInlineUrl(name, doc?.id ?? ""),
    pdf: api.previewPdfUrl(name, doc?.id ?? ""),
    download: api.sourceUrl(name, doc?.id ?? ""),
  };
  const node = overlay(`
    <div class="modal-form preview-form">
      <h2>${escapeHtml(doc?.title ?? "原件预览")}</h2>
      <div class="preview-body"><p class="state">加载中…</p></div>
      <div class="modal-actions">
        <a class="btn" href="${escapeAttr(urls.download)}">下载原件</a>
        <button type="button" class="btn" data-close>关闭</button>
      </div>
    </div>
  `, { className: "preview-modal" });
  const body = node.querySelector(".preview-body");
  const paint = (html) => {
    if (!node.isConnected || !body) return;
    body.innerHTML = html;
  };
  if (kind === "note" || kind === "text") {
    api.docContent(name, doc?.id ?? "").then((content) => {
      paint(renderPreviewBody({ kind, urls, content }));
    }).catch((failure) => {
      paint(renderPreviewBody({ kind, urls, content: { error: failure?.message ?? String(failure) } }));
    });
  } else {
    paint(renderPreviewBody({ kind, urls }));
  }
  return node;
}

export function openDocModal({ name, id, icons } = {}) {
  const node = overlay(`<div class="modal-form"><h2>加载中…</h2></div>`);
  api.doc(name, id).then((doc) => {
    if (!node.isConnected) return;
    node.querySelector(".modal").innerHTML = `
      <div class="modal-form">
        <h2>${escapeHtml(doc.title)}</h2>
        <div class="kv"><span>ID</span><strong>${escapeHtml(doc.id)}</strong></div>
        <div class="kv"><span>类型</span><strong>${escapeHtml(doc.type ?? "")}</strong></div>
        <div class="kv"><span>页数 / 字数</span><strong>${doc.pages} / ${doc.chars}</strong></div>
        <div class="kv"><span>可信度</span><strong>${escapeHtml(doc.trust)}</strong></div>
        <div class="kv"><span>来源文件</span><strong>${escapeHtml(doc.sourceFile || "—")}</strong></div>
        <div class="kv"><span>摘要</span><strong>${escapeHtml(doc.summary || "—")}</strong></div>
        <div class="kv"><span>标签</span><strong>${escapeHtml((doc.tags ?? []).join("、") || "—")}</strong></div>
        <div class="modal-actions">
          <button type="button" class="btn primary" data-preview>查看原件</button>
          <a class="btn" href="${escapeAttr(api.sourceUrl(name, id))}">下载原件</a>
          <button type="button" class="btn" data-close>关闭</button>
        </div>
      </div>
    `;
    node.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeOverlay(node)));
    node.querySelector("[data-preview]")?.addEventListener("click", () => {
      openPreviewModal({ name, doc, icons });
    });
  }).catch((failure) => {
    if (!node.isConnected) return;
    node.querySelector(".modal").innerHTML = `<div class="modal-form"><p class="form-error">${escapeHtml(failure?.message ?? failure)}</p><button class="btn" data-close>关闭</button></div>`;
    node.querySelector("[data-close]").onclick = () => closeOverlay(node);
  });
}

/**
 * 重命名输入校验（纯函数）：trim 后不能为空，也不能与原名相同。
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function normalizeRenameValue(value, current) {
  const next = String(value ?? "").trim();
  if (next === "") return { ok: false, error: "请输入名称" };
  if (next === String(current ?? "")) return { ok: false, error: "名称没有变化" };
  return { ok: true, value: next };
}

/** 页头/设置页共用的重命名弹窗；成功后回调新库名。 */
export function openRenameModal({ name, onRenamed } = {}) {
  const node = overlay(`
    <form class="modal-form">
      <h2>重命名「${escapeHtml(name)}」</h2>
      <label class="field"><span>新名称</span><input name="name" value="${escapeAttr(name)}" maxlength="64" autocomplete="off" /></label>
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn primary">重命名</button>
      </div>
    </form>
  `);
  const form = node.querySelector("form");
  const error = node.querySelector(".form-error");
  const input = form.querySelector("input[name='name']");
  input?.focus?.();
  input?.select?.();
  input?.addEventListener("input", () => { error.hidden = true; });
  form.onsubmit = async (event) => {
    event.preventDefault();
    const check = normalizeRenameValue(new FormData(form).get("name"), name);
    if (!check.ok) {
      error.textContent = check.error;
      error.hidden = false;
      return;
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const result = await api.patchKb(name, { name: check.value });
      closeOverlay(node);
      try {
        await onRenamed?.(result?.kb?.name ?? check.value);
      } catch {
        /* 改名已经成功；页面级刷新失败不回滚，也不恢复弹窗。 */
      }
    } catch (failure) {
      error.textContent = failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
      error.hidden = false;
      button.disabled = false;
    }
  };
  return node;
}


export function openRestoreModal({ name, dir, onRestored }) {
  const node = overlay(`
    <form class="modal-form">
      <h2>恢复「${escapeHtml(name)}」</h2>
      <p class="muted">原名称被占用时，换一个名称再恢复。</p>
      <label class="field"><span>恢复后的名称</span><input name="name" value="${escapeAttr(name)}" maxlength="64" /></label>
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn primary">恢复</button>
      </div>
    </form>
  `);
  const form = node.querySelector("form");
  const error = node.querySelector(".form-error");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const next = String(new FormData(form).get("name") ?? "").trim();
    if (next === "") { error.textContent = "请输入名称"; error.hidden = false; return; }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const result = await api.restoreKb(dir, next === name ? undefined : next);
      closeOverlay(node);
      onRestored?.(result.restoredTo);
    } catch (failure) {
      error.textContent = failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
      error.hidden = false;
      button.disabled = false;
    }
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
