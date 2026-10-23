import { api, ApiError } from "./api.js";
import { icons } from "./icons.js";
import { hrefForKb, hrefForOverview, hrefForTrash, parseHash } from "./router.js";
import { renderOverview } from "./views/overview.js";
import { renderDetail } from "./views/detail.js";
import { renderTrash } from "./views/trash.js";
import { openCreateModal, openDocModal, openRestoreModal } from "./views/modals.js";

const app = document.querySelector("#app");

const state = {
  kbs: [],
  loading: true,
  error: "",
  filter: "all",
  query: "",
  detail: null,
  detailLoading: false,
  detailError: "",
  docs: { items: [], total: 0, offset: 0, limit: 50 },
  trash: { items: [], loading: false, error: "" },
};

function fmtNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

function route() {
  return parseHash(window.location.hash);
}

async function loadKbs() {
  state.loading = true;
  state.error = "";
  render();
  try {
    const payload = await api.kbs();
    state.kbs = Array.isArray(payload?.kbs) ? payload.kbs : [];
  } catch (error) {
    state.error = error instanceof ApiError ? error.message : String(error?.message ?? error);
  } finally {
    state.loading = false;
    render();
  }
}

async function loadDetail(name, tab) {
  if (state.detail?.kb?.name !== name) {
    state.detail = null;
    state.docs = { items: [], total: 0, offset: 0, limit: 50, query: "" };
  }
  state.detailLoading = true;
  state.detailError = "";
  render();
  try {
    const detail = await api.kb(name);
    state.detail = detail;
    if (tab === "docs") {
      const docs = await api.docs(name, { offset: state.docs.offset, limit: state.docs.limit, query: state.docs.query });
      state.docs = { items: docs.docs, total: docs.total, offset: docs.offset, limit: docs.limit, query: state.docs.query };
    }
  } catch (error) {
    state.detailError = error instanceof ApiError ? error.message : String(error?.message ?? error);
    state.detail = null;
  } finally {
    state.detailLoading = false;
    render();
  }
}

async function loadTrash() {
  state.trash.loading = true;
  state.trash.error = "";
  render();
  try {
    const payload = await api.trash();
    state.trash.items = Array.isArray(payload?.items) ? payload.items : [];
  } catch (error) {
    state.trash.error = error instanceof ApiError ? error.message : String(error?.message ?? error);
  } finally {
    state.trash.loading = false;
    render();
  }
}

function render() {
  if (!app) return;
  const current = route();
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="${hrefForOverview()}">${icons.database}<span>知识库工作台</span></a>
      <div class="topbar-actions">
        ${window.history.length > 1 ? `<button class="btn" data-action="back">${icons.back}<span>返回</span></button>` : ""}
        <button class="btn primary" data-action="create-kb">${icons.plus}<span>新建知识库</span></button>
      </div>
    </header>
    <div class="layout">
      <aside class="sidebar">
        <div class="side-title">知识库 <span class="muted">${state.kbs.length}</span></div>
        <nav class="side-list">
          ${state.kbs.map((kb) => `
            <a class="side-item ${current.page === "detail" && current.name === kb.name ? "active" : ""}"
               href="${hrefForKb(kb.name)}">
              <span class="dot" style="--dot:${colorFor(kb.name)}"></span>
              <span class="side-name">${escapeHtml(kb.name)}</span>
              <span class="side-count">${fmtNumber(kb.docs.ready + kb.docs.importing + kb.docs.failed)}</span>
            </a>`).join("")}
        </nav>
        <div class="side-foot muted">${icons.archive}<a href="${hrefForTrash()}">回收站</a><a href="/kb/" target="_blank" rel="noreferrer">在新标签打开</a></div>
      </aside>
      <main class="main">
        ${state.loading ? `<div class="state">加载中…</div>` : ""}
        ${state.error ? `<div class="state error">${escapeHtml(state.error)}<button class="btn" data-action="reload">重试</button></div>` : ""}
        ${!state.loading && !state.error && current.page === "overview" ? renderOverview(state, { icons, fmtNumber }) : ""}
        ${!state.loading && !state.error && current.page === "detail" ? renderDetail(state, current, { icons, fmtNumber }) : ""}
        ${!state.loading && !state.error && current.page === "trash" ? renderTrash(state, { icons, fmtNumber }) : ""}
      </main>
    </div>
  `;
  bind();
}

function bind() {
  // 全局点击委托
  app.onclick = async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "create-kb") {
      openCreateModal({
        onCreated: async (name) => {
          await loadKbs();
          window.location.hash = hrefForKb(name);
        },
      });
    } else if (action === "reload") {
      await loadKbs();
    } else if (action === "back") {
      window.history.back();
    } else if (action === "open-kb") {
      window.location.hash = hrefForKb(target.dataset.name);
    } else if (action === "open-doc") {
      openDocModal({ name: target.dataset.kb, id: target.dataset.id, icons, fmtNumber });
    } else if (action === "tab") {
      const current = route();
      window.location.hash = hrefForKb(current.name, target.dataset.tab);
    } else if (action === "docs-page") {
      const current = route();
      state.docs.offset = Math.max(0, Number(target.dataset.offset) || 0);
      await loadDetail(current.name, "docs");
    } else if (action === "archive-kb") {
      const current = route();
      if (!current.name) return;
      const { openArchiveModal } = await import("./views/modals.js");
      openArchiveModal({
        name: current.name,
        onArchived: async () => {
          await loadKbs();
          window.location.hash = hrefForOverview();
        },
      });
    } else if (action === "save-meta") {
      const description = app.querySelector("#kb-description")?.value ?? "";
      const tags = String(app.querySelector("#kb-tags")?.value ?? "").split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
      try {
        await api.patchKb(target.dataset.name, { description, tags });
        showToast("简介与标签已保存");
        const current = route();
        await loadDetail(current.name, current.tab);
      } catch (error) {
        showToast(error instanceof ApiError ? error.message : String(error?.message ?? error), "error");
      }
    } else if (action === "rename-kb") {
      const next = app.querySelector("#kb-rename")?.value?.trim() ?? "";
      if (next === "" || next === target.dataset.name) return;
      try {
        const result = await api.patchKb(target.dataset.name, { name: next });
        showToast("已重命名");
        await loadKbs();
        window.location.hash = hrefForKb(result.kb.name, "settings");
      } catch (error) {
        showToast(error instanceof ApiError ? error.message : String(error?.message ?? error), "error");
      }
    } else if (action === "reload-trash") {
      await loadTrash();
    } else if (action === "restore-kb") {
      const dir = target.dataset.dir;
      const name = target.dataset.name;
      try {
        const result = await api.restoreKb(dir);
        await loadKbs();
        await loadTrash();
        showToast(`已恢复「${result.restoredTo}」`);
        window.location.hash = hrefForKb(result.restoredTo);
      } catch (error) {
        if (error instanceof ApiError && error.code === "KB_EXISTS") {
          openRestoreModal({
            name,
            dir,
            onRestored: async (restoredTo) => {
              await loadKbs();
              await loadTrash();
              showToast(`已恢复为「${restoredTo}」`);
              window.location.hash = hrefForKb(restoredTo);
            },
          });
        } else {
          showToast(error instanceof ApiError ? error.message : String(error?.message ?? error), "error");
        }
      }
    } else if (action === "toast-close") {
      hideToast();
    }
  };
  // 过滤器/搜索
  const search = app.querySelector("[data-filter='query']");
  if (search) {
    search.oninput = () => {
      state.query = search.value;
      render();
      const next = app.querySelector("[data-filter='query']");
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
    };
  }
  app.querySelectorAll("[data-filter='status']").forEach((button) => {
    button.onclick = () => { state.filter = button.dataset.value; render(); };
  });
}

function colorFor(name) {
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 55% 52%)`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function toastNode() {
  let node = document.querySelector("#toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "toast";
    node.className = "toast";
    node.hidden = true;
    document.body.appendChild(node);
  }
  return node;
}

function showToast(message, kind = "info") {
  const node = toastNode();
  node.textContent = message;
  node.className = `toast show ${kind}`;
  node.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => hideToast(), 3000);
}

function hideToast() {
  const node = document.querySelector("#toast");
  if (node) { node.hidden = true; node.className = "toast"; }
}

function boot() {
  window.addEventListener("hashchange", () => {
    const current = route();
    if (current.page === "trash") loadTrash();
    else if (current.page === "detail") loadDetail(current.name, current.tab);
    else render();
  });
  const current = route();
  loadKbs().then(() => {
    if (current.page === "trash") loadTrash();
    else if (current.page === "detail") loadDetail(current.name, current.tab);
  });
}

boot();

export { state, render, loadKbs, loadDetail, showToast, escapeHtml, fmtNumber };
