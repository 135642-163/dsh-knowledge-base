import { api, ApiError } from "../api.js";

function overlay(html) {
  const node = document.createElement("div");
  node.className = "overlay";
  node.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(node);
  node.addEventListener("mousedown", (event) => { if (event.target === node) node.remove(); });
  node.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => node.remove()));
  return node;
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
      node.remove();
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
      node.remove();
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
      node.remove();
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
      node.remove();
      onArchived?.();
    } catch (failure) {
      error.textContent = failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
      error.hidden = false;
    }
  };
}

export function openDocModal({ name, id }) {
  const node = overlay(`<div class="modal-form"><h2>加载中…</h2></div>`);
  api.doc(name, id).then((doc) => {
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
          <a class="btn" href="${api.sourceUrl(name, id)}">下载原件</a>
          <button type="button" class="btn" data-close>关闭</button>
        </div>
      </div>
    `;
    node.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => node.remove()));
  }).catch((failure) => {
    node.querySelector(".modal").innerHTML = `<div class="modal-form"><p class="form-error">${escapeHtml(failure?.message ?? failure)}</p><button class="btn" data-close>关闭</button></div>`;
    node.querySelector("[data-close]").onclick = () => node.remove();
  });
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
      node.remove();
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
