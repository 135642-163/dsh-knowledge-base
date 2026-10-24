import { api, ApiError } from "./api.js";
import { icons } from "./icons.js";
import { hrefForKb, hrefForOverview, hrefForTrash, parseHash } from "./router.js";
import { renderOverview } from "./views/overview.js";
import { docsPageSize, renderDetail } from "./views/detail.js";
import { attachDocsControls, createRequestGate } from "./docs-controls.js";
import { renderTrash } from "./views/trash.js";
import { openConfirmModal, openCreateModal, openDocModal, openKbPickerModal, openRestoreModal } from "./views/modals.js";
import { openUploadModal } from "./views/upload.js";

const app = document.querySelector("#app");
const EMBED = new URLSearchParams(window.location.search).has("embed");
if (EMBED) document.body.classList.add("embed");

const state = {
  kbs: [],
  loading: true,
  error: "",
  filter: "all",
  query: "",
  appliedQuery: "",
  detail: null,
  detailLoading: false,
  detailError: "",
  docs: { items: [], total: 0, offset: 0, limit: 50, query: "", appliedQuery: "" },
  trash: { items: [], loading: false, error: "" },
  std: {
    kb: "", loading: false, error: "", warning: "", starting: false, cancelling: false,
    status: null, job: null, timer: null, pollRetry: 0, inFlight: null,
  },
};

// 切库/离开标准 tab 时自增：所有在途状态请求与轮询回调凭 token 自行作废。
let stdToken = 0;
// 详情页请求（含资料搜索）的代号：路由/切库或更新的搜索让旧响应自行作废。
const detailGate = createRequestGate();
// 每次 render 重新挂载的资料工具栏控件；bind() 负责先 detach 上一份。
let docsControls = null;

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
    const all = Array.isArray(payload?.kbs) ? payload.kbs : [];
    // 自动创建的空 default 库不展示；一旦有内容（含归档文档/笔记）就正常显示。
    state.kbs = all.filter((kb) => {
      if (kb.name !== "default") return true;
      const d = kb.docs ?? {};
      return (d.ready ?? 0) + (d.importing ?? 0) + (d.failed ?? 0) + (d.deleted ?? 0) + (d.notes ?? 0) > 0;
    });
  } catch (error) {
    state.error = error instanceof ApiError ? error.message : String(error?.message ?? error);
  } finally {
    state.loading = false;
    render();
  }
}

/**
 * 结算后的静默刷新：只更新侧栏计数，不切 state.loading、不 render。
 * 失败最多让侧栏数字旧一点，不会把详情面板/结果表 unmount 掉。
 */
async function refreshKbsQuiet() {
  try {
    const payload = await api.kbs();
    state.kbs = Array.isArray(payload?.kbs) ? payload.kbs : [];
  } catch {
    /* ignore：下一轮整页刷新会补齐 */
  }
}

/**
 * 加载详情页。每次调用领一个 token：await 之后 token 过期（更晚的 loadDetail
 * 或路由切换调了 invalidate）就不再写 state，避免旧响应覆盖新页面。
 * 返回 { stale } 供资料工具栏判断是否记录 appliedQuery / 恢复焦点。
 */
async function loadDetail(name, tab) {
  const token = detailGate.begin();
  if (state.detail?.kb?.name !== name) {
    state.detail = null;
    state.docs = { items: [], total: 0, offset: 0, limit: 50, query: "", appliedQuery: "" };
  }
  state.detailLoading = true;
  state.detailError = "";
  render();
  try {
    const detail = await api.kb(name);
    if (!detailGate.isCurrent(token)) return { stale: true };
    state.detail = detail;
    if (tab === "std") {
      await loadStd(name);
      if (!detailGate.isCurrent(token)) return { stale: true };
    } else if (tab === "docs") {
      // 搜索请求发出时的 query/offset；返回后还要确认用户没有继续输入，
      // 否则旧词的结果不能挂在新词下面（本轮直接丢弃，等下一次防抖请求）。
      const query = String(state.docs.query ?? "");
      const limit = docsPageSize(state.docs.limit);
      const offset = Math.max(0, Math.round(Number(state.docs.offset) || 0));
      const docs = await api.docs(name, { offset, limit, query });
      if (!detailGate.isCurrent(token) || query !== String(state.docs.query ?? "")) return { stale: true };
      state.docs = {
        items: docs.docs,
        total: docs.total,
        offset: docs.offset,
        limit: docs.limit,
        query,
        appliedQuery: query,
      };
    }
    return { stale: false };
  } catch (error) {
    if (!detailGate.isCurrent(token)) return { stale: true };
    state.detailError = error instanceof ApiError ? error.message : String(error?.message ?? error);
    state.detail = null;
    return { stale: false, error: true };
  } finally {
    if (detailGate.isCurrent(token)) {
      state.detailLoading = false;
      render();
    }
  }
}

/** 资料工具栏的 load 回调：只在当前路由仍是该库的资料 tab 时发请求。 */
function loadCurrentDocs() {
  const current = route();
  if (current.page !== "detail" || (current.tab || "overview") !== "docs") return Promise.resolve({ stale: true });
  return loadDetail(current.name, "docs");
}

function stdErrorText(error) {
  return error instanceof ApiError ? error.message : String(error?.message ?? error);
}

function isStdRoute(name) {
  const current = route();
  return current.page === "detail" && current.name === name && current.tab === "std";
}

function clearStdTimer() {
  if (state.std.timer) clearTimeout(state.std.timer);
  state.std.timer = null;
}

/** 离开标准 tab / 切库 / 关页面：停掉轮询并作废所有在途回调。 */
function stopStd() {
  clearStdTimer();
  stdToken += 1;
}

/** 任务注册表里的公开摘要，用作 stdStatus 刷新失败时的 lastJob 兜底。 */
function stdJobRecord(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    finishedAt: job.finishedAt ?? null,
    summary: job.result?.counts ?? null,
  };
}

async function loadStd(name) {
  if (!isStdRoute(name)) return;
  const token = ++stdToken;
  clearStdTimer();
  const sameKb = state.std.kb === name && state.std.status !== null;
  state.std = {
    ...state.std,
    kb: name,
    loading: true,
    error: "",
    warning: "",
    starting: false,
    cancelling: false,
    pollRetry: 0,
    ...(sameKb ? {} : { status: null, job: null }),
  };
  render();
  try {
    const status = await api.stdStatus(name);
    if (token !== stdToken || state.std.kb !== name || !isStdRoute(name)) return;
    state.std.status = status;
    if (status.activeJobId) {
      const job = await api.job(status.activeJobId);
      if (token !== stdToken || state.std.kb !== name || !isStdRoute(name)) return;
      state.std.job = job;
      void pollStd(name, token);
    } else if (status.lastJob) {
      const job = await api.job(status.lastJob.id).catch(() => null);
      if (token !== stdToken || state.std.kb !== name || !isStdRoute(name)) return;
      state.std.job = job;
    } else {
      // 注册表里既没有运行中任务也没有历史任务：不要保留上一个 running job。
      state.std.job = null;
    }
  } catch (error) {
    if (token !== stdToken || state.std.kb !== name || !isStdRoute(name)) return;
    state.std.error = stdErrorText(error);
  } finally {
    if (token === stdToken && state.std.kb === name) {
      state.std.loading = false;
      if (isStdRoute(name)) render();
    }
  }
}

async function pollStd(name, token) {
  if (token !== stdToken || state.std.kb !== name) return;
  if (!isStdRoute(name)) { clearStdTimer(); return; }
  const jobId = state.std.job?.id;
  if (!jobId) return;
  // 同一轮 token+job 只允许一个在途请求：visibility 切换不会叠出两条 api.job。
  const inFlightKey = `${token}:${jobId}`;
  if (state.std.inFlight === inFlightKey) return;
  state.std.inFlight = inFlightKey;
  clearStdTimer();
  try {
    const job = await api.job(jobId);
    if (token !== stdToken || state.std.kb !== name || state.std.job?.id !== jobId) return;
    if (!isStdRoute(name)) { clearStdTimer(); return; }
    state.std.pollRetry = 0;
    state.std.warning = "";
    state.std.error = "";
    state.std.job = job;
    if (job.status === "running") {
      render();
      // 页面隐藏时暂停轮询；visibilitychange 回到可见再续查。
      if (!document.hidden) {
        state.std.timer = setTimeout(() => { void pollStd(name, token); }, 1000);
      }
      return;
    }

    // 结算：先清掉 stale running 状态，再做静默刷新 + 唯一一次 render。
    state.std.starting = false;
    state.std.cancelling = false;
    let status = null;
    try {
      const fresh = await api.stdStatus(name);
      status = fresh && typeof fresh === "object" ? fresh : {};
    } catch {
      const previous = state.std.status ?? {};
      status = { ...previous, activeJobId: null, lastJob: stdJobRecord(job) };
    }
    if (token !== stdToken || state.std.kb !== name || !isStdRoute(name)) return;
    status = {
      ...status,
      activeJobId: status.activeJobId === job.id ? null : status.activeJobId ?? null,
      lastJob: status.lastJob ?? stdJobRecord(job),
    };
    state.std.status = status;
    state.std.job = job;
    await refreshKbsQuiet();
    if (token !== stdToken || state.std.kb !== name || !isStdRoute(name)) return;
    render();
  } catch (error) {
    if (token !== stdToken || state.std.kb !== name) return;
    if (!isStdRoute(name)) { clearStdTimer(); return; }
    if (error instanceof ApiError && (error.code === "JOB_NOT_FOUND" || error.status === 404)) {
      // 任务已过期/丢失：停止轮询并重新同步状态，不做无限重试。
      clearStdTimer();
      state.std.job = null;
      state.std.warning = "";
      state.std.pollRetry = 0;
      await loadStd(name);
      return;
    }
    // 网络抖动/临时 5xx：最多等两轮，每次 2 秒后再拉一次进度。
    if (state.std.pollRetry < 2) {
      state.std.pollRetry += 1;
      state.std.warning = "进度获取失败，2 秒后重试…";
      render();
      state.std.timer = setTimeout(() => { void pollStd(name, token); }, 2000);
      return;
    }
    state.std.warning = "";
    state.std.pollRetry = 0;
    state.std.error = `读取任务进度失败：${stdErrorText(error)}`;
    clearStdTimer();
    render();
  } finally {
    if (state.std.inFlight === inFlightKey) state.std.inFlight = null;
  }
}

async function startStd(mode) {
  const name = state.std.kb;
  if (!name || state.std.starting) return;
  const token = stdToken;
  const force = Boolean(app.querySelector("#std-force")?.checked);
  const limit = Math.max(0, Math.round(Number(app.querySelector("#std-limit")?.value) || 0));
  // 新一轮开始前丢掉上轮进度/结果（result 挂在 job 上，置空 job 即清掉），避免 running 时还显示旧 job。
  state.std.job = null;
  state.std.error = "";
  state.std.warning = "";
  state.std.pollRetry = 0;
  state.std.cancelling = false;
  state.std.starting = true;
  render();
  try {
    const result = await api.stdCheck(name, { action: mode, force, limit });
    if (state.std.kb !== name || !isStdRoute(name)) return;
    if (token !== stdToken) {
      // 期间切走又切回来：不把旧请求的 job 硬塞给新状态，改为重新同步。
      if (isStdRoute(name)) await loadStd(name);
      return;
    }
    if (!result?.jobId) throw new Error("标准任务没有返回 jobId");
    const job = await api.job(result.jobId);
    if (token !== stdToken || state.std.kb !== name || !isStdRoute(name)) return;
    state.std.job = job;
    void pollStd(name, token);
  } catch (error) {
    if (state.std.kb !== name) return;
    if (!isStdRoute(name)) return;
    if (error instanceof ApiError && error.code === "STD_JOB_RUNNING") {
      showToast("该库已有标准任务在运行，正在同步进度");
      await loadStd(name);
      return;
    }
    state.std.error = stdErrorText(error);
  } finally {
    if (state.std.kb === name) {
      state.std.starting = false;
      if (isStdRoute(name)) render();
    }
  }
}

/**
 * 取消运行中的标准任务：只发取消请求，不清理轮询计时器。
 * 后端在下一个网络请求前协作停止，已发出的请求可能完成；状态由轮询自然结算。
 */
async function cancelStd() {
  const name = state.std.kb;
  const jobId = state.std.job?.id ?? state.std.status?.activeJobId;
  if (!name || !jobId || state.std.cancelling) return;
  const token = stdToken;
  state.std.cancelling = true;
  render();
  try {
    const job = await api.cancelJob(jobId);
    if (token !== stdToken || state.std.kb !== name || !isStdRoute(name)) return;
    if (job) state.std.job = job;
    showToast("已请求取消，当前正在处理的标准完成后停止");
    render();
  } catch (error) {
    if (state.std.kb !== name) return;
    if (!isStdRoute(name)) return;
    if (error instanceof ApiError && (error.status === 404 || error.status === 409 || error.code === "JOB_NOT_FOUND" || error.code === "JOB_NOT_RUNNING")) {
      // 任务已结束/已过期：重新同步状态，取消态随 loadStd 复位。
      showToast(stdErrorText(error), "error");
      await loadStd(name);
      return;
    }
    state.std.cancelling = false;
    showToast(stdErrorText(error), "error");
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
      <a class="brand" href="${hrefForOverview()}"><span>知识库工作台</span></a>
      <div class="topbar-actions">
        ${!EMBED && window.history.length > 1 ? `<button class="btn" data-action="back">${icons.back}<span>返回</span></button>` : ""}
      </div>
    </header>
    <div class="layout">
      <aside class="sidebar">
        <a class="side-title" href="${hrefForOverview()}" aria-label="返回知识库总览">
          ${icons.database}
          <span>知识库</span>
          <span class="muted">${state.kbs.length}</span>
        </a>
        <nav class="side-list">
          ${state.kbs.map((kb) => `
            <a class="side-item ${current.page === "detail" && current.name === kb.name ? "active" : ""}"
               href="${hrefForKb(kb.name)}">
              <span class="dot" style="--dot:${colorFor(kb.name)}"></span>
              <span class="side-name">${escapeHtml(kb.name)}</span>
              <span class="side-count">${fmtNumber(kb.docs.ready + kb.docs.importing + kb.docs.failed)}</span>
            </a>`).join("")}
        </nav>
        <div class="side-foot">
          <button class="side-action" data-action="create-kb">${icons.plus}<span>新建知识库</span></button>
          <a class="side-action" href="${hrefForTrash()}">${icons.archive}<span>回收站</span></a>
          <a class="side-action subtle" href="/kb/" target="_blank" rel="noreferrer">${icons.external}<span>在新标签打开</span></a>
        </div>
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
  // 上一轮渲染的监听/定时器先摘掉，避免旧 DOM 上的过期闭包再触发一次请求。
  docsControls?.detach();
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
          openUploadModal({
            kbs: state.kbs,
            kb: name,
            onFinished: async () => {
              await loadKbs();
              const current = route();
              if (current.page === "detail") await loadDetail(current.name, current.tab);
            },
          });
        },
      });
    } else if (action === "upload") {
      if (state.kbs.length === 0) { showToast("还没有知识库，先新建一个"); return; }
      openUploadModal({
        kbs: state.kbs,
        kb: target.dataset.kb ?? "",
        onFinished: async () => {
          await loadKbs();
          const current = route();
          if (current.page === "detail") await loadDetail(current.name, current.tab);
        },
      });
    } else if (action === "std-open") {
      if (state.kbs.length === 0) { showToast("还没有知识库，先新建一个"); return; }
      openKbPickerModal({
        kbs: state.kbs,
        onPick: (name) => { window.location.hash = hrefForKb(name, "std"); },
      });
    } else if (action === "std-reload") {
      const current = route();
      const name = current.page === "detail" ? current.name : state.std.kb;
      if (name) await loadStd(name);
    } else if (action === "std-run") {
      await startStd(target.dataset.mode ?? "check");
    } else if (action === "std-download") {
      const mode = target.dataset.mode ?? "check-download";
      const limit = Math.max(0, Math.round(Number(app.querySelector("#std-limit")?.value) || 0));
      openConfirmModal({
        title: mode === "download" ? "补下载更新" : "检查并下载更新",
        body: `每个标准约 6 金币（VIP 免金币），本轮最多 ${limit > 0 ? `${limit} 个` : "不限"}；下载会消耗金币。`,
        confirmText: "开始下载",
        requireCheckbox: true,
        onConfirm: () => startStd(mode),
      });
    } else if (action === "std-cancel") {
      await cancelStd();
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
      if (current.page !== "detail") return;
      const limit = docsPageSize(state.docs.limit);
      state.docs.limit = limit;
      state.docs.offset = Math.max(0, Math.round(Number(target.dataset.offset) || 0));
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
    } else if (action === "purge-kb") {
      const dir = target.dataset.dir ?? "";
      const item = state.trash.items.find((entry) => entry.dir === dir);
      if (!item) return;
      openConfirmModal({
        title: `彻底删除「${item.name}」`,
        body: "彻底删除后，磁盘上的资料与原件将不可恢复。",
        confirmText: "彻底删除",
        requireText: item.name,
        danger: true,
        onConfirm: async () => {
          const result = await api.purgeTrash(dir);
          await loadTrash();
          await loadKbs();
          showToast(`已彻底删除「${result?.name ?? item.name}」`);
        },
      });
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
    let composing = false;
    let timer = 0;
    const applyQuery = () => {
      clearTimeout(timer);
      const value = search.value;
      state.query = value;
      if (state.appliedQuery === value) return;
      state.appliedQuery = value;
      render();
      focusQueryInput();
    };
    search.oncompositionstart = () => { composing = true; clearTimeout(timer); };
    search.oncompositionend = () => { composing = false; applyQuery(); };
    search.oninput = (event) => {
      state.query = search.value;
      if (composing || event.isComposing) return;
      clearTimeout(timer);
      timer = setTimeout(applyQuery, 180);
    };
    search.onkeydown = (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      applyQuery();
    };
  }
  // 资料 tab：搜索（防抖 + 输入法安全）、每页条数、跳页、清除搜索、焦点恢复
  docsControls = attachDocsControls({ app, state, load: loadCurrentDocs });
  app.querySelectorAll("[data-filter='status']").forEach((button) => {
    button.onclick = () => { state.filter = button.dataset.value; render(); };
  });
}

/** 搜索框整页重绘后聚焦并把光标放回末尾（输入法组合结束也走这里）。 */
function focusQueryInput() {
  const next = app.querySelector("[data-filter='query']");
  if (!next) return;
  next.focus();
  next.setSelectionRange(next.value.length, next.value.length);
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
  clearStdTimer();
  window.addEventListener("hashchange", () => {
    // 路由/切库/切 tab：让所有在途详情与资料请求作废，且不重新渲染旧页面。
    detailGate.invalidate();
    stopStd();
    const current = route();
    if (current.page === "trash") loadTrash();
    else if (current.page === "detail") loadDetail(current.name, current.tab);
    else render();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearStdTimer(); return; }
    const current = route();
    if (current.page !== "detail" || (current.tab || "overview") !== "std") return;
    if (state.std.kb !== current.name || state.std.job?.status !== "running") return;
    void pollStd(current.name, stdToken);
  });
  window.addEventListener("pagehide", () => { clearStdTimer(); });
  const current = route();
  loadKbs().then(() => {
    if (current.page === "trash") loadTrash();
    else if (current.page === "detail") loadDetail(current.name, current.tab);
  });
}

boot();

export { state, render, loadKbs, loadDetail, showToast, escapeHtml, fmtNumber };
