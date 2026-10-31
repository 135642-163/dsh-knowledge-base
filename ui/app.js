import { api, ApiError } from "./api.js";
import { icons } from "./icons.js";
import { hrefForKb, hrefForOverview, hrefForSearch, hrefForTrash, parseHash } from "./router.js";
import { renderOverview } from "./views/overview.js";
import { docsPageSize, docsStatus, renderDetail, selectionToggle, selectionToggleOne } from "./views/detail.js";
import { attachDocsControls, createRequestGate } from "./docs-controls.js";
import { parsePreviewDeepLink } from "./deep-link.js";
import { applyHighlights, mergeResults, searchParamsOf, searchStateFromQuery } from "./search-core.js";
import { attachSearchControls } from "./search-controls.js";
import { renderSearch } from "./views/search.js";
import {
  purgeDocsConfirmBody, renderTrash, renderTrashPurgeBody, trashDocKey, trashPurgePhrase,
  trashPurgeTarget, trashRestoreTargets, trashSelectionToggleAll, trashSelectionToggleOne,
} from "./views/trash.js";
import {
  deleteConfirmBody, openConfirmModal, openCreateModal, openDocModal, openKbPickerModal, openMoveModal,
  openPreviewModal, openRenameModal, openRestoreModal, openSemanticModal, retryFailedDoc,
} from "./views/modals.js";
import { openUploadModal } from "./views/upload.js";
import { openPackageImportModal } from "./views/package.js";
import { openExportModal } from "./views/export.js";

const app = document.querySelector("#app");
const EMBED = new URLSearchParams(window.location.search).has("embed");
if (EMBED) document.body.classList.add("embed");

const state = {
  kbs: [],
  loading: true,
  error: "",
  server: { kbRoot: "", version: "" },
  filter: "all",
  query: "",
  appliedQuery: "",
  detail: null,
  detailLoading: false,
  detailError: "",
  docs: {
    items: [], total: 0, offset: 0, limit: 50, query: "", appliedQuery: "", status: "",
    tag: "", facets: { tags: [] }, selected: [], busy: false, retrying: [],
  },
  notes: { items: [], total: 0, loading: false, error: "" },
  trash: {
    items: [],
    docs: { items: [], total: 0, truncated: false, error: "" },
    selectedDocs: [],
    query: "",
    sort: "deleted_desc",
    loading: false,
    error: "",
    busy: false,
  },
  std: {
    kb: "", loading: false, error: "", warning: "", starting: false, fetching: false, cancelling: false,
    status: null, job: null, timer: null, pollRetry: 0, inFlight: null,
  },
  search: {
    q: "", appliedQ: "", kb: "", tag: "", type: "", trust: "",
    results: [], total: 0, offset: 0, limit: 20, terms: [], engine: "none",
    indexBuilding: false, note: "", tookMs: 0, estimated: false,
    facets: { tags: [], types: [], trust: [] },
    loading: false, loadingMore: false, error: "",
  },
};

// 切库/离开标准 tab 时自增：所有在途状态请求与轮询回调凭 token 自行作废。
let stdToken = 0;
// 详情页请求（含资料搜索）的代号：路由/切库或更新的搜索让旧响应自行作废。
const detailGate = createRequestGate();
// 全文检索请求的代号：条件变化后旧响应自行作废，避免覆盖新结果。
const searchGate = createRequestGate();
// 每次 render 重新挂载的工具栏控件；bind() 负责先 detach 上一份。
let docsControls = null;
let searchControls = null;

function fmtNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

function route() {
  return parseHash(window.location.hash);
}

/** 侧栏可见库：自动创建的空 default 库不展示；一旦有内容（含归档文档/笔记）就正常显示。 */
function visibleKbs(all) {
  return (Array.isArray(all) ? all : []).filter((kb) => {
    if (kb.name !== "default") return true;
    const d = kb.docs ?? {};
    return (d.ready ?? 0) + (d.importing ?? 0) + (d.failed ?? 0) + (d.deleted ?? 0) + (d.notes ?? 0) > 0;
  });
}

async function loadKbs() {
  state.loading = true;
  state.error = "";
  render();
  try {
    const payload = await api.kbs();
    state.kbs = visibleKbs(payload?.kbs);
  } catch (error) {
    state.error = error instanceof ApiError ? error.message : String(error?.message ?? error);
  } finally {
    state.loading = false;
    render();
  }
}

/**
 * 读取服务信息（只读）：知识库根目录与版本。/status 不可用时保持为空，
 * 不影响库列表/检索主流程（总览页只是不显示根目录行）。
 */
async function loadServerInfo() {
  try {
    const status = await api.status();
    state.server = {
      kbRoot: String(status?.kbRoot ?? ""),
      version: String(status?.version ?? ""),
    };
  } catch {
    /* ignore：见函数注释 */
  }
}

/**
 * 结算后的静默刷新：只更新侧栏计数，不切 state.loading、不 render。
 * 失败最多让侧栏数字旧一点，不会把详情面板/结果表 unmount 掉。
 */
async function refreshKbsQuiet() {
  try {
    const payload = await api.kbs();
    // 与 loadKbs 用同一套可见性规则：静默刷新不能把空 default 库冒出来。
    state.kbs = visibleKbs(payload?.kbs);
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
    state.docs = {
      items: [], total: 0, offset: 0, limit: 50, query: "", appliedQuery: "", status: "",
      tag: "", facets: { tags: [] }, selected: [], busy: false, retrying: [],
    };
    state.notes = { items: [], total: 0, loading: false, error: "" };
  }
  // 离开资料 tab 时清空勾选；跨页/同页刷新时保留（loadCurrentDocs 只在搜索变化时清）。
  if (tab !== "docs") state.docs.selected = [];
  // 笔记 tab 先亮加载态再等列表：同库切 tab 时不会闪一下「还没有笔记」。
  if (tab === "notes") state.notes = { ...state.notes, loading: true, error: "" };
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
      // 搜索请求发出时的 query/offset/status；返回后还要确认用户没有继续输入或
      // 切换筛选，否则旧结果不能挂在新条件下面（本轮直接丢弃，等下一次请求）。
      const query = String(state.docs.query ?? "");
      const status = docsStatus(state.docs.status);
      const tag = String(state.docs.tag ?? "");
      const limit = docsPageSize(state.docs.limit);
      const offset = Math.max(0, Math.round(Number(state.docs.offset) || 0));
      const docs = await api.docs(name, { offset, limit, query, status, tag });
      if (!detailGate.isCurrent(token)
        || query !== String(state.docs.query ?? "")
        || status !== docsStatus(state.docs.status)
        || tag !== String(state.docs.tag ?? "")) return { stale: true };
      state.docs = {
        ...state.docs,
        items: docs.docs,
        total: docs.total,
        offset: docs.offset,
        limit: docs.limit,
        query,
        appliedQuery: query,
        status,
        tag,
        facets: docs.facets ?? { tags: [] },
      };
    } else if (tab === "notes") {
      // 笔记列表与资料共用同一份详情 token：切库/切 tab 后在途响应自动作废。
      try {
        const notes = await api.docs(name, { type: "note", limit: 200, offset: 0 });
        if (!detailGate.isCurrent(token)) return { stale: true };
        state.notes = {
          items: Array.isArray(notes.docs) ? notes.docs : [],
          total: Math.max(0, Math.round(Number(notes.total) || 0)),
          loading: false,
          error: "",
        };
      } catch (error) {
        if (!detailGate.isCurrent(token)) return { stale: true };
        state.notes = {
          items: [],
          total: 0,
          loading: false,
          error: error instanceof ApiError ? error.message : String(error?.message ?? error),
        };
      }
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
function loadCurrentDocs(request = {}) {
  const current = route();
  if (current.page !== "detail" || (current.tab || "overview") !== "docs") return Promise.resolve({ stale: true });
  // 搜索词变化时先清空勾选；翻页/改每页条数（query 未变）保留跨页选择。
  if (String(request?.query ?? "") !== String(state.docs.appliedQuery ?? "")) state.docs.selected = [];
  return loadDetail(current.name, "docs");
}

// ---------------------------------------------------------------------------
// 全文检索页（#/search）
// ---------------------------------------------------------------------------

/** 检索条件 -> hash。用 replaceState：不触发 hashchange，避免二次请求。 */
function syncSearchHash() {
  const current = route();
  if (current.page !== "search") return;
  const query = searchParamsOf(state.search);
  const next = `#/search${query === "" ? "" : `?${query}`}`;
  if (window.location.hash === next) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${next}`);
}

/** 进入检索页/浏览器后退：把 hash 条件写回 state，并清掉上一轮结果。 */
function applySearchQuery(query) {
  state.search = {
    ...state.search,
    ...searchStateFromQuery(query),
    appliedQ: "",
    results: [],
    total: 0,
    offset: 0,
    terms: [],
    engine: "none",
    indexBuilding: false,
    note: "",
    tookMs: 0,
    estimated: false,
    loading: false,
    loadingMore: false,
    error: "",
  };
}

/** 无检索词时回到空态，不发请求（服务端会 400 SEARCH_EMPTY）。 */
function clearSearchResults() {
  state.search = {
    ...state.search,
    appliedQ: "",
    results: [],
    total: 0,
    offset: 0,
    terms: [],
    engine: "none",
    indexBuilding: false,
    note: "",
    tookMs: 0,
    estimated: false,
    loading: false,
    loadingMore: false,
    error: "",
  };
}

/** 执行全文检索：reset=true 替换结果（新条件），false 追加（加载更多）。 */
async function loadSearch({ reset = true } = {}) {
  const current = route();
  if (current.page !== "search") return { stale: true };
  const q = String(state.search.q ?? "").trim();
  if (q === "") {
    clearSearchResults();
    render();
    return { stale: false, empty: true };
  }
  const token = searchGate.begin();
  const snapshot = {
    q,
    kb: String(state.search.kb ?? ""),
    tag: String(state.search.tag ?? ""),
    type: String(state.search.type ?? ""),
    trust: String(state.search.trust ?? ""),
    limit: Math.max(1, Math.round(Number(state.search.limit) || 20)),
    offset: reset ? 0 : Math.max(0, Math.round(Number(state.search.offset) || 0)),
  };
  state.search.offset = snapshot.offset;
  if (reset) {
    state.search.loading = true;
    state.search.loadingMore = false;
  } else {
    state.search.loadingMore = true;
  }
  state.search.error = "";
  render();
  try {
    const payload = await api.search(snapshot);
    if (!searchGate.isCurrent(token)) return { stale: true };
    const results = reset ? payload.results ?? [] : mergeResults(state.search.results, payload.results ?? []);
    state.search = {
      ...state.search,
      ...payload,
      q: snapshot.q,
      appliedQ: snapshot.q,
      offset: snapshot.offset,
      limit: snapshot.limit,
      results,
      loading: false,
      loadingMore: false,
      error: "",
    };
    return { stale: false };
  } catch (error) {
    if (!searchGate.isCurrent(token)) return { stale: true };
    state.search = {
      ...state.search,
      loading: false,
      loadingMore: false,
      error: errorText(error),
    };
    return { stale: false, error: true };
  } finally {
    if (searchGate.isCurrent(token)) render();
  }
}

/** 重绘后用文本节点把摘要里的检索词高亮（不拼 HTML）。 */
function paintSearchHighlights() {
  const current = route();
  if (current.page !== "search") return;
  const results = Array.isArray(state.search.results) ? state.search.results : [];
  const terms = Array.isArray(state.search.terms) ? state.search.terms : [];
  for (const node of app.querySelectorAll("[data-hl]")) {
    const index = Number(node.dataset.hl);
    const result = Number.isInteger(index) ? results[index] : null;
    if (!result) continue;
    const resultTerms = Array.isArray(result.terms) && result.terms.length > 0 ? result.terms : terms;
    applyHighlights(document, node, String(result.snippet ?? ""), resultTerms);
  }
}

/** 检索框整页重绘后聚焦并把光标放回末尾（输入法组合结束也走这里）。 */
function focusSearchInput() {
  const next = app.querySelector("[data-search-query]");
  if (!next) return;
  next.focus();
  next.setSelectionRange(next.value.length, next.value.length);
}

/** 点结果卡片：复用工作台预览弹窗（不新增全屏工作台），并把检索词带进 viewer 高亮。 */
async function openSearchResult(kb, id, page, terms = []) {
  if (!kb || !id) return;
  try {
    const doc = await api.doc(kb, id);
    if (!doc || doc.deleted) throw new Error("资料不存在或已删除");
    openPreviewModal({ name: kb, doc, icons, initialPage: page, terms });
  } catch {
    showToast("资料不存在或已删除", "error");
  }
}

/** 从结果卡片事件里取参数（标题链接与「打开原件」共用一套 data-*）。 */
function searchResultTarget(target) {
  const index = Number(target.dataset.searchIndex);
  const results = Array.isArray(state.search.results) ? state.search.results : [];
  const result = Number.isInteger(index) ? results[index] : null;
  const resultTerms = Array.isArray(result?.terms) && result.terms.length > 0 ? result.terms : null;
  const fallback = Array.isArray(state.search.terms) ? state.search.terms : [];
  return {
    kb: String(target.dataset.kb ?? ""),
    id: String(target.dataset.id ?? ""),
    page: Math.max(0, Math.round(Number(target.dataset.page) || 0)) || null,
    terms: resultTerms ?? fallback,
  };
}

function errorText(error) {
  return error instanceof ApiError ? error.message : String(error?.message ?? error);
}

/** 当前选中的资料（对象含 id/title/status，跨页保留）。 */
function selectedDocs() {
  return Array.isArray(state.docs.selected) ? state.docs.selected : [];
}

function pageDocById(id) {
  const key = String(id ?? "");
  return (Array.isArray(state.docs.items) ? state.docs.items : [])
    .find((doc) => String(doc.id) === key) ?? null;
}

/** 文档操作后的统一刷新：侧栏计数 + 当前详情页（不闪整页 loading）。 */
async function refreshAfterDocsChange() {
  await refreshKbsQuiet();
  const current = route();
  if (current.page === "detail") await loadDetail(current.name, current.tab || "overview");
}

/** 软删除一篇或多篇：先确认，再逐篇调用；部分失败时报告成功/失败数量。 */
function trashDocs(docs) {
  const current = route();
  const list = (Array.isArray(docs) ? docs : []).filter((doc) => doc?.id);
  if (current.page !== "detail" || list.length === 0) return;
  const name = current.name;
  openConfirmModal({
    title: list.length > 1 ? `移入回收站（${list.length} 篇）` : `移入回收站「${list[0].title}」`,
    body: deleteConfirmBody(list),
    confirmText: "移入回收站",
    onConfirm: async () => {
      state.docs.busy = true;
      render();
      const settled = await Promise.allSettled(list.map((doc) => api.deleteDoc(name, doc.id)));
      const failures = settled.filter((item) => item.status === "rejected");
      state.docs.selected = [];
      try {
        await refreshAfterDocsChange();
      } finally {
        state.docs.busy = false;
        render();
      }
      const ok = list.length - failures.length;
      if (failures.length === 0) {
        showToast(list.length > 1 ? `已移入回收站（${list.length} 篇）` : "已移入回收站");
        return;
      }
      const reason = errorText(failures[0].reason);
      showToast(ok > 0
        ? `${ok} 篇已移入回收站，${failures.length} 篇失败：${reason}`
        : `移入回收站失败：${reason}`, "error");
    },
  });
}

/** 从已删除行恢复；失败时保留列表并提示原因。 */
async function restoreDocAction(doc) {
  const current = route();
  if (current.page !== "detail" || !doc?.id) return;
  if (state.docs.busy) return;
  state.docs.busy = true;
  render();
  try {
    await api.restoreDoc(current.name, doc.id);
    state.docs.busy = false;
    showToast("已恢复");
    await refreshAfterDocsChange();
  } catch (error) {
    state.docs.busy = false;
    showToast(errorText(error), "error");
    render();
  }
}

/** 彻底删除：必须逐字输入标题；400 等错误留在弹窗内联显示。 */
function purgeDoc(doc) {
  const current = route();
  if (current.page !== "detail" || !doc?.id) return;
  const title = String(doc.title ?? "").trim();
  openConfirmModal({
    title: `彻底删除「${doc.title}」`,
    body: "彻底删除后，原件、解析内容与历史版本都会删除，无法恢复。",
    confirmText: "彻底删除",
    requireText: title,
    textLabel: "输入文档标题",
    danger: true,
    onConfirm: async () => {
      state.docs.busy = true;
      render();
      try {
        await api.deleteDoc(current.name, doc.id, { permanent: true, confirm: title });
      } finally {
        state.docs.busy = false;
        render();
      }
      showToast("已彻底删除");
      await refreshAfterDocsChange();
    },
  });
}

/** 撤销跨库移动：源库文档恢复、目标库副本进回收站。 */
function undoMoveDoc(doc) {
  const current = route();
  const target = String(doc?.movedTo?.kb ?? "");
  if (current.page !== "detail" || !doc?.id || target === "") return;
  openConfirmModal({
    title: `撤销移动「${doc.title}」`,
    body: `源库文档会恢复，目标库「${target}」中的副本会移入回收站；两边的原件与解析内容都保留。`,
    confirmText: "撤销移动",
    onConfirm: async () => {
      state.docs.busy = true;
      render();
      try {
        await api.undoMove(current.name, doc.id, { target });
      } finally {
        state.docs.busy = false;
        render();
      }
      showToast("已撤销移动");
      await refreshAfterDocsChange();
    },
  });
}

/** 失败行重试：启动 reparse 任务并轮询，结算后刷新列表；同一行不重复触发。 */
async function retryRowDoc(doc) {
  const current = route();
  if (current.page !== "detail" || !doc?.id) return;
  const id = String(doc.id);
  if (state.docs.retrying.includes(id)) return;
  state.docs.retrying = [...state.docs.retrying, id];
  render();
  try {
    await retryFailedDoc({
      name: current.name,
      id,
      notify: showToast,
      onSettled: async () => { await refreshAfterDocsChange(); },
    });
  } catch (error) {
    showToast(errorText(error), "error");
  } finally {
    state.docs.retrying = state.docs.retrying.filter((item) => item !== id);
    render();
  }
}

/** 多选移动：只有就绪资料可移动，其余跳过并提示。 */
function moveSelectedDocs() {
  const current = route();
  const selected = selectedDocs();
  const movable = selected.filter((doc) => doc.status === "ready");
  if (movable.length === 0) {
    showToast("所选资料中没有可移动的就绪资料");
    return;
  }
  if (movable.length < selected.length) {
    showToast(`仅移动就绪资料，已忽略 ${selected.length - movable.length} 篇`);
  }
  openMoveModal({
    name: current.name,
    ids: movable.map((doc) => doc.id),
    kbs: state.kbs,
    notify: showToast,
    onDone: async () => {
      state.docs.selected = [];
      await refreshAfterDocsChange();
    },
  });
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
    fetching: false,
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

/**
 * 按标准号补下载：先 dryRun 校验（检索 + 确认页反查 + 金币），
 * 用户确认后再启动 kb-std 后台任务（复用现有轮询/结果面板）。
 */
async function previewStdFetch() {
  const name = state.std.kb;
  const input = app.querySelector("#std-fetch-no");
  const stdNo = String(input?.value ?? "").trim();
  if (!name || state.std.fetching || state.std.starting) return;
  if (stdNo === "") {
    showToast("请输入要补下载的标准号");
    return;
  }
  const token = stdToken;
  state.std.fetching = true;
  state.std.error = "";
  render();
  try {
    const result = await api.stdFetch(name, { stdNo, dryRun: true });
    if (token !== stdToken || state.std.kb !== name || !isStdRoute(name)) return;
    if (!result?.ok) {
      showToast(result?.reason || "站点未找到可下载的该编号", "error");
      return;
    }
    const cost = result.costCoins == null
      ? "金币以确认页为准"
      : result.costCoins > 0 ? `${result.costCoins} 金币` : "免费";
    const free = result.vipFree ? "（VIP 免费）" : "";
    openConfirmModal({
      title: "补下载并导入",
      body: `${result.siteStdNo || stdNo}「${result.title || ""}」\n\n${cost}${free}；下载后会直接导入「${name}」。`,
      confirmText: "下载并导入",
      requireCheckbox: true,
      onConfirm: () => startStdFetch(result.siteStdNo || stdNo),
    });
  } catch (error) {
    if (token !== stdToken || state.std.kb !== name || !isStdRoute(name)) return;
    state.std.error = stdErrorText(error);
  } finally {
    if (state.std.kb === name) {
      state.std.fetching = false;
      if (isStdRoute(name)) render();
    }
  }
}

async function startStdFetch(stdNo) {
  const name = state.std.kb;
  if (!name || state.std.starting) return;
  const token = stdToken;
  state.std.job = null;
  state.std.error = "";
  state.std.warning = "";
  state.std.pollRetry = 0;
  state.std.cancelling = false;
  state.std.starting = true;
  render();
  try {
    const result = await api.stdFetch(name, { stdNo, dryRun: false });
    if (state.std.kb !== name || !isStdRoute(name)) return;
    if (token !== stdToken) {
      if (isStdRoute(name)) await loadStd(name);
      return;
    }
    if (!result?.jobId) throw new Error("补下载任务没有返回 jobId");
    const job = await api.job(result.jobId);
    if (token !== stdToken || state.std.kb !== name || !isStdRoute(name)) return;
    state.std.job = job;
    void pollStd(name, token);
  } catch (error) {
    if (state.std.kb !== name || !isStdRoute(name)) return;
    state.std.error = stdErrorText(error);
  } finally {
    if (state.std.kb === name) {
      state.std.starting = false;
      if (isStdRoute(name)) render();
    }
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

// 回收站请求代号：切 tab/连续刷新时旧响应自行作废。
let trashToken = 0;

/**
 * 并行拉取归档库与全局已删除资料；某一个失败不影响另一个展示。
 * query/sort 取自 state.trash，刷新（含操作后）不重置；搜索/排序变化时由调用方
 * 传 resetSelection 清空勾选——旧列表的跨页选择不能挂到新结果上。
 */
async function loadTrash({ resetSelection = false } = {}) {
  const token = ++trashToken;
  state.trash.loading = true;
  state.trash.error = "";
  if (resetSelection) state.trash.selectedDocs = [];
  render();
  const query = String(state.trash.query ?? "");
  const sort = String(state.trash.sort || "deleted_desc");
  const [archived, docs] = await Promise.allSettled([api.trash(), api.trashDocs({ query, sort })]);
  // 输入防抖期间状态里的 query 可能已经更新：旧响应不能再挂到新搜索词下面。
  if (token !== trashToken
    || query !== String(state.trash.query ?? "")
    || sort !== String(state.trash.sort || "deleted_desc")) return { stale: true };
  if (archived.status === "fulfilled") {
    state.trash.items = Array.isArray(archived.value?.items) ? archived.value.items : [];
  } else {
    state.trash.items = [];
    state.trash.error = errorText(archived.reason);
  }
  if (docs.status === "fulfilled") {
    const payload = docs.value ?? {};
    state.trash.docs = {
      items: Array.isArray(payload.items) ? payload.items : [],
      total: Math.max(0, Math.round(Number(payload.total) || 0)),
      truncated: payload.truncated === true,
      error: "",
    };
  } else {
    // 已删除资料单独失败：按空列表展示，并在该分区给出错误与重试。
    state.trash.docs = { items: [], total: 0, truncated: false, error: errorText(docs.reason) };
  }
  // 刷新后只保留仍在当前列表里的勾选：撤销移动/外部删除不会留下失效的待删条目。
  const visibleKeys = new Set((state.trash.docs.items ?? []).map((doc) => trashDocKey(doc)));
  state.trash.selectedDocs = (Array.isArray(state.trash.selectedDocs) ? state.trash.selectedDocs : [])
    .filter((entry) => visibleKeys.has(trashDocKey(entry)));
  state.trash.loading = false;
  render();
  return { stale: false };
}

/** 已删除资料列表里的一篇（同一个 id 可能出现在不同库）。 */
function trashDocByKey(kb, id) {
  const targetKb = String(kb ?? "");
  const targetId = String(id ?? "");
  return (state.trash.docs?.items ?? [])
    .find((doc) => String(doc.kb) === targetKb && String(doc.id) === targetId) ?? null;
}

/** 回收站操作后的统一刷新：归档库 + 已删除资料 + 侧栏计数，必要时刷新详情。 */
async function refreshAfterTrashChange(affectedKbs = []) {
  await loadTrash();
  // 侧栏计数静默更新：不切 state.loading，避免主面板闪一下整页加载态。
  await refreshKbsQuiet();
  const current = route();
  if (current.page === "detail" && (affectedKbs.length === 0 || affectedKbs.includes(current.name))) {
    await loadDetail(current.name, current.tab || "overview");
  }
}

function purgeDocsToast(result) {
  const purged = Math.max(0, Math.round(Number(result?.purged) || 0));
  const failed = Array.isArray(result?.failed) ? result.failed : [];
  if (failed.length === 0) return [`已彻底删除 ${purged} 篇`, "info"];
  return [`${purged} 篇已彻底删除，${failed.length} 篇失败`, "error"];
}

/** 逐篇恢复已删除资料；已移动的行只能撤销移动，批量恢复自动排除。失败不中断其余条目。 */
async function restoreTrashDocs(entries) {
  if (state.trash.busy) return;
  // 以当前列表为准确认 movedTo：旧的选择项可能没带移动标记。
  const { entries: list } = trashRestoreTargets(entries, state.trash.docs?.items ?? []);
  if (list.length === 0) return;
  state.trash.busy = true;
  state.trash.selectedDocs = [];
  render();
  const failures = [];
  let restored = 0;
  try {
    for (const entry of list) {
      try {
        await api.restoreDoc(entry.kb, entry.id);
        restored += 1;
      } catch (error) {
        failures.push({ ...entry, error: errorText(error) });
      }
    }
  } finally {
    state.trash.busy = false;
  }
  await refreshAfterTrashChange([...new Set(list.map((entry) => entry.kb))]);
  if (failures.length === 0) {
    showToast(list.length === 1 ? "已恢复" : `已恢复 ${restored} 篇`);
    return;
  }
  const reason = failures[0]?.error ?? "未知错误";
  showToast(
    restored > 0
      ? `${restored} 篇已恢复，${failures.length} 篇失败：${reason}`
      : `恢复失败：${reason}`,
    "error",
  );
}

/** 回收站里撤销跨库移动：源库文档恢复，目标库副本软删除进回收站。 */
async function undoTrashMove(doc, target = "") {
  if (state.trash.busy) return;
  const sourceKb = String(doc?.kb ?? "");
  const targetKb = String(target || doc?.movedTo?.kb || "");
  if (sourceKb === "" || !doc?.id || targetKb === "") return;
  state.trash.busy = true;
  render();
  try {
    await api.undoMove(sourceKb, doc.id, { target: targetKb });
  } catch (error) {
    state.trash.busy = false;
    render();
    showToast(errorText(error), "error");
    return;
  }
  state.trash.busy = false;
  showToast("已撤销移动");
  await refreshAfterTrashChange([sourceKb, targetKb]);
}

/** 单行彻底删除：沿用本库回收站接口，逐字输入库名确认。 */
function purgeTrashDoc(doc) {
  if (state.trash.busy) return;
  const target = trashPurgeTarget([doc]);
  if (!target.ok) {
    showToast(target.reason, "error");
    return;
  }
  const { kb, entries: list } = target;
  openConfirmModal({
    title: `彻底删除「${list[0].title}」`,
    body: purgeDocsConfirmBody({ docs: list, total: list.length }),
    confirmText: "彻底删除",
    requireText: kb,
    textLabel: "输入库名",
    danger: true,
    onConfirm: async () => {
      state.trash.busy = true;
      state.trash.selectedDocs = [];
      render();
      try {
        const result = await api.purgeDocs(kb, { ids: list.map((entry) => entry.id), confirm: kb });
        await refreshAfterTrashChange([kb]);
        const [message, kind] = purgeDocsToast(result);
        showToast(message, kind);
      } finally {
        state.trash.busy = false;
        render();
      }
    },
  });
}

/**
 * 跨库批量彻底删除：服务端先逐库预检再删除；确认短语固定为「彻底删除 N 篇」。
 * 部分失败由响应里的 {purged, failed} 汇报，不把成功条目回滚。
 */
function purgeSelectedTrashDocs(entries) {
  if (state.trash.busy) return;
  const target = trashPurgeTarget(entries);
  if (!target.ok) {
    showToast(target.reason, "error");
    return;
  }
  const list = target.entries;
  const count = list.length;
  const phrase = trashPurgePhrase(count);
  const affectedKbs = [...new Set(list.map((entry) => entry.kb))];
  openConfirmModal({
    title: count === 1 ? `彻底删除「${list[0].title}」` : `彻底删除 ${count} 篇已删除资料`,
    body: renderTrashPurgeBody(list),
    confirmText: "彻底删除",
    requireText: phrase,
    textLabel: "输入",
    danger: true,
    onConfirm: async () => {
      state.trash.busy = true;
      state.trash.selectedDocs = [];
      render();
      try {
        const result = await api.purgeTrashDocs(
          list.map((entry) => ({ kb: entry.kb, id: entry.id })),
          phrase,
        );
        await refreshAfterTrashChange(affectedKbs);
        const [message, kind] = purgeDocsToast(result);
        showToast(message, kind);
      } finally {
        state.trash.busy = false;
        render();
      }
    },
  });
}

/** 详情页「清空本库已删除资料」：all=true，同一个逐字输入库名确认。 */
function purgeAllDeletedDocs() {
  const current = route();
  if (current.page !== "detail" || !current.name || state.docs.busy) return;
  const name = current.name;
  const total = Math.max(0, Math.round(Number(state.detail?.kb?.docs?.deleted) || 0));
  openConfirmModal({
    title: `清空「${name}」的已删除资料`,
    body: purgeDocsConfirmBody({ total }),
    confirmText: "彻底删除",
    requireText: name,
    textLabel: "输入库名",
    danger: true,
    onConfirm: async () => {
      state.docs.busy = true;
      render();
      try {
        const result = await api.purgeDocs(name, { all: true, confirm: name });
        state.docs.busy = false;
        await refreshAfterDocsChange();
        const [message, kind] = purgeDocsToast(result);
        showToast(message, kind);
      } finally {
        state.docs.busy = false;
        render();
      }
    },
  });
}

function render() {
  if (!app) return;
  const current = route();
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="${hrefForOverview()}"><span>知识库工作台</span></a>
      <div class="topbar-actions">
        ${!EMBED ? `<button class="btn" data-action="semantic-settings">设置</button>` : ""}
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
          <a class="side-action ${current.page === "search" ? "active" : ""}" href="${hrefForSearch({})}">${icons.search}<span>全文搜索</span></a>
          <button class="side-action" data-action="semantic-settings">${icons.search}<span>检索设置</span></button>
          <a class="side-action" href="${hrefForTrash()}">${icons.archive}<span>回收站</span></a>
          <a class="side-action subtle" href="/kb/" target="_blank" rel="noreferrer">${icons.external}<span>在新标签打开</span></a>
        </div>
      </aside>
      <main class="main">
        ${state.loading ? `<div class="state">加载中…</div>` : ""}
        ${state.error ? `<div class="state error">${escapeHtml(state.error)}<button class="btn" data-action="reload">重试</button></div>` : ""}
        ${!state.loading && !state.error && current.page === "overview" ? renderOverview(state, { icons, fmtNumber }) : ""}
        ${!state.loading && !state.error && current.page === "detail" ? renderDetail(state, current, { icons, fmtNumber }) : ""}
        ${!state.loading && !state.error && current.page === "search" ? renderSearch(state, { icons, fmtNumber }) : ""}
        ${!state.loading && !state.error && current.page === "trash" ? renderTrash(state, current, { icons, fmtNumber }) : ""}
      </main>
    </div>
  `;
  bind();
  paintSearchHighlights();
}

function bind() {
  // 上一轮渲染的监听/定时器先摘掉，避免旧 DOM 上的过期闭包再触发一次请求。
  docsControls?.detach();
  searchControls?.detach();
  searchControls = null;
  // 资料列表的可信度下拉：change 事件单独处理（onclick 不会覆盖键盘选择）。
  app.onchange = async (event) => {
    const select = event.target.closest('[data-action="docs-trust"]');
    if (!select || select.disabled) return;
    const kb = select.dataset.kb;
    const id = select.dataset.id;
    if (!kb || !id) return;
    select.disabled = true;
    try {
      const saved = await api.patchDocMetadata(kb, id, { trust: select.value });
      const doc = pageDocById(id);
      if (doc && saved?.doc) doc.trust = saved.doc.trust;
      showToast("可信度已更新");
      render();
    } catch (error) {
      select.disabled = false;
      showToast(stdErrorText(error), "error");
    }
  };

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
    } else if (action === "semantic-settings") {
      openSemanticModal({ notify: showToast });
    } else if (action === "export-kb") {
      const name = target.dataset.name;
      if (name) {
        openExportModal({ name, notify: showToast });
      } else if (state.kbs.length === 0) {
        showToast("还没有知识库");
      } else {
        openKbPickerModal({
          kbs: state.kbs,
          onPick: (picked) => openExportModal({ name: picked, notify: showToast }),
        });
      }
    } else if (action === "import-package") {
      openPackageImportModal({
        notify: showToast,
        onFinished: async () => {
          await loadKbs();
          const current = route();
          if (current.page === "detail") await loadDetail(current.name, current.tab);
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
    } else if (action === "std-fetch-preview") {
      await previewStdFetch();
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
      openDocModal({
        name: target.dataset.kb,
        id: target.dataset.id,
        icons,
        notify: showToast,
        onChanged: refreshAfterDocsChange,
      });
    } else if (action === "open-note") {
      const current = route();
      const id = target.dataset.id;
      if (current.page !== "detail" || !id) return;
      let doc = (state.notes.items ?? []).find((item) => item.id === id) ?? null;
      if (!doc) {
        try {
          doc = await api.doc(current.name, id);
        } catch (error) {
          showToast(error instanceof ApiError ? error.message : String(error?.message ?? error), "error");
          return;
        }
      }
      openPreviewModal({ name: current.name, doc, icons });
    } else if (action === "docs-status") {
      const current = route();
      if (current.page !== "detail") return;
      state.docs.status = docsStatus(target.dataset.docsStatus);
      state.docs.selected = [];
      state.docs.offset = 0;
      if (current.tab !== "docs") {
        window.location.hash = hrefForKb(current.name, "docs");
        return;
      }
      await loadDetail(current.name, "docs");
    } else if (action === "docs-tag") {
      const current = route();
      if (current.page !== "detail") return;
      const tag = String(target.dataset.tag ?? "").trim();
      state.docs.tag = tag;
      state.docs.selected = [];
      state.docs.offset = 0;
      if (current.tab !== "docs") {
        window.location.hash = hrefForKb(current.name, "docs");
        return;
      }
      await loadDetail(current.name, "docs");
    } else if (action === "docs-tag-clear") {
      const current = route();
      if (current.page !== "detail") return;
      state.docs.tag = "";
      state.docs.selected = [];
      state.docs.offset = 0;
      if (current.tab !== "docs") {
        window.location.hash = hrefForKb(current.name, "docs");
        return;
      }
      await loadDetail(current.name, "docs");
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
    } else if (action === "docs-select") {
      const doc = pageDocById(target.dataset.id);
      if (!doc) return;
      state.docs.selected = selectionToggleOne(state.docs.selected, doc, target.checked);
      render();
    } else if (action === "docs-select-all") {
      state.docs.selected = selectionToggle(state.docs.selected, state.docs.items ?? []);
      render();
    } else if (action === "docs-clear-selection") {
      if (state.docs.busy) return;
      state.docs.selected = [];
      render();
    } else if (action === "docs-move") {
      if (state.docs.busy) return;
      moveSelectedDocs();
    } else if (action === "docs-trash-selected") {
      if (state.docs.busy) return;
      trashDocs(selectedDocs());
    } else if (action === "docs-remove") {
      if (state.docs.busy) return;
      const doc = pageDocById(target.dataset.id);
      if (doc) trashDocs([{ id: doc.id, title: doc.title }]);
    } else if (action === "docs-retry") {
      const doc = pageDocById(target.dataset.id);
      if (doc) await retryRowDoc(doc);
    } else if (action === "docs-restore") {
      const doc = pageDocById(target.dataset.id);
      if (doc) await restoreDocAction(doc);
    } else if (action === "docs-purge") {
      const doc = pageDocById(target.dataset.id);
      if (doc) purgeDoc(doc);
    } else if (action === "docs-purge-all") {
      purgeAllDeletedDocs();
    } else if (action === "docs-undo-move") {
      const doc = pageDocById(target.dataset.id);
      if (doc) undoMoveDoc(doc);
    } else if (action === "trash-doc-select") {
      if (state.trash.busy) return;
      const doc = trashDocByKey(target.dataset.kb, target.dataset.id);
      if (!doc) return;
      state.trash.selectedDocs = trashSelectionToggleOne(state.trash.selectedDocs, doc, target.checked);
      render();
    } else if (action === "trash-doc-select-all") {
      if (state.trash.busy) return;
      state.trash.selectedDocs = trashSelectionToggleAll(
        state.trash.selectedDocs,
        state.trash.docs?.items ?? [],
      );
      render();
    } else if (action === "trash-doc-clear") {
      if (state.trash.busy) return;
      state.trash.selectedDocs = [];
      render();
    } else if (action === "trash-docs-clear-query") {
      if (state.trash.busy) return;
      state.trash.query = "";
      state.trash.selectedDocs = [];
      const result = await loadTrash({ resetSelection: true });
      if (!result?.stale) focusTrashQueryInput();
    } else if (action === "trash-doc-restore") {
      const doc = trashDocByKey(target.dataset.kb, target.dataset.id);
      if (doc) await restoreTrashDocs([doc]);
    } else if (action === "trash-doc-undo-move") {
      if (state.trash.busy) return;
      const doc = trashDocByKey(target.dataset.kb, target.dataset.id);
      if (doc) await undoTrashMove(doc, target.dataset.target ?? "");
    } else if (action === "trash-doc-purge") {
      const doc = trashDocByKey(target.dataset.kb, target.dataset.id);
      if (doc) purgeTrashDoc(doc);
    } else if (action === "trash-docs-restore-selected") {
      if (state.trash.busy) return;
      await restoreTrashDocs(state.trash.selectedDocs);
    } else if (action === "trash-docs-purge-selected") {
      if (state.trash.busy) return;
      purgeSelectedTrashDocs(state.trash.selectedDocs);
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
    } else if (action === "rename-kb-modal") {
      const current = route();
      const name = target.dataset.name || (current.page === "detail" ? current.name : "");
      if (!name) return;
      openRenameModal({
        name,
        onRenamed: async (next) => {
          showToast("已重命名");
          await loadKbs();
          const tab = current.page === "detail" ? (current.tab || "overview") : "overview";
          window.location.hash = hrefForKb(next, tab);
        },
      });
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
          await refreshAfterTrashChange();
          showToast(`已彻底删除「${result?.name ?? item.name}」`);
        },
      });
    } else if (action === "restore-kb") {
      const dir = target.dataset.dir;
      const name = target.dataset.name;
      try {
        const result = await api.restoreKb(dir);
        await refreshAfterTrashChange();
        showToast(`已恢复「${result.restoredTo}」`);
        window.location.hash = hrefForKb(result.restoredTo);
      } catch (error) {
        if (error instanceof ApiError && error.code === "KB_EXISTS") {
          openRestoreModal({
            name,
            dir,
            onRestored: async (restoredTo) => {
              await refreshAfterTrashChange();
              showToast(`已恢复为「${restoredTo}」`);
              window.location.hash = hrefForKb(restoredTo);
            },
          });
        } else {
          showToast(error instanceof ApiError ? error.message : String(error?.message ?? error), "error");
        }
      }
    } else if (action === "search-open") {
      event.preventDefault();
      const picked = searchResultTarget(target);
      await openSearchResult(picked.kb, picked.id, picked.page, picked.terms);
    } else if (action === "search-submit") {
      const current = route();
      if (current.page !== "search") return;
      const input = app.querySelector("[data-search-query]");
      await searchControls?.applyQuery?.(String(input?.value ?? state.search.q ?? ""));
    } else if (action === "search-example") {
      const current = route();
      if (current.page !== "search") return;
      searchControls?.applyQuery?.(target.dataset.example ?? "");
    } else if (action === "search-retry") {
      await loadSearch({ reset: true });
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
  // 检索页：搜索防抖/输入法/Enter、四个过滤、清除、加载更多；hash 用 replaceState 同步
  searchControls = attachSearchControls({
    app,
    state,
    load: async ({ reset }) => {
      const current = route();
      if (current.page !== "search") return { stale: true };
      return loadSearch({ reset });
    },
    after: syncSearchHash,
    focus: focusSearchInput,
  });
  app.querySelectorAll("[data-filter='status']").forEach((button) => {
    button.onclick = () => { state.filter = button.dataset.value; render(); };
  });
  // 回收站已删除资料：搜索 300ms 防抖 + Enter + 输入法组合，排序切换立即生效。
  const trashSearch = app.querySelector("[data-trash-query]");
  if (trashSearch) {
    let composing = false;
    let timer = 0;
    const applyTrashQuery = async () => {
      clearTimeout(timer);
      state.trash.query = trashSearch.value;
      state.trash.selectedDocs = [];
      const result = await loadTrash({ resetSelection: true });
      if (!result?.stale) focusTrashQueryInput();
    };
    trashSearch.oncompositionstart = () => { composing = true; clearTimeout(timer); };
    trashSearch.oncompositionend = () => { composing = false; void applyTrashQuery(); };
    trashSearch.oninput = (event) => {
      state.trash.query = trashSearch.value;
      if (composing || event.isComposing) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void applyTrashQuery(); }, 300);
    };
    trashSearch.onkeydown = (event) => {
      if (event.key !== "Enter" || composing || event.isComposing) return;
      event.preventDefault();
      void applyTrashQuery();
    };
  }
  const trashSort = app.querySelector("[data-trash-sort]");
  if (trashSort) {
    trashSort.onchange = () => {
      state.trash.sort = trashSort.value || "deleted_desc";
      state.trash.selectedDocs = [];
      void loadTrash({ resetSelection: true });
    };
  }
}

/** 搜索框整页重绘后聚焦并把光标放回末尾（输入法组合结束也走这里）。 */
function focusQueryInput() {
  const next = app.querySelector("[data-filter='query']");
  if (!next) return;
  next.focus();
  next.setSelectionRange(next.value.length, next.value.length);
}

/** 回收站搜索框重绘后恢复焦点与光标（不抢其他输入的焦点）。 */
function focusTrashQueryInput() {
  const next = app.querySelector("[data-trash-query]");
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

/** 深链 ?kb=&doc=&page=&clause=：加载完成后打开预览；失败给 toast，不阻塞工作台。 */
async function openDeepLinkPreview() {
  const link = parsePreviewDeepLink(window.location.search);
  if (!link.docId) return;
  const kb = link.kb || state.kbs.find((item) => item.mergedInto == null)?.name || "";
  const clear = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete("kb");
    params.delete("doc");
    params.delete("page");
    params.delete("clause");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  };
  if (!kb) {
    showToast("资料不存在或已删除", "error");
    clear();
    return;
  }
  try {
    const doc = await api.doc(kb, link.docId);
    if (!doc || doc.deleted) throw new Error("资料不存在或已删除");
    openPreviewModal({ name: kb, doc, icons, initialPage: link.page });
    clear();
  } catch {
    showToast("资料不存在或已删除", "error");
    clear();
  }
}

function boot() {
  clearStdTimer();
  window.addEventListener("hashchange", () => {
    // 路由/切库/切 tab：让所有在途详情/资料/检索请求作废，且不重新渲染旧页面。
    detailGate.invalidate();
    searchGate.invalidate();
    // 离开资料 tab / 换库：跨页勾选只在当前资料 tab 内保留。
    state.docs.selected = [];
    stopStd();
    const current = route();
    // 进入回收站时保留上次搜索/排序，但旧勾选不带入新页面。
    if (current.page === "trash") loadTrash({ resetSelection: true });
    else if (current.page === "search") {
      applySearchQuery(current.query);
      void loadSearch({ reset: true });
    } else if (current.page === "detail") loadDetail(current.name, current.tab);
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
  // 根目录是只读展示信息：与库列表并行取，晚到只在总览页补一次 render。
  const serverReady = loadServerInfo();
  loadKbs().then(async () => {
    await serverReady;
    if (current.page === "overview") render();
    if (current.page === "trash") await loadTrash();
    else if (current.page === "search") {
      applySearchQuery(current.query);
      await loadSearch({ reset: true });
    } else if (current.page === "detail") await loadDetail(current.name, current.tab);
    await openDeepLinkPreview();
  });
}

boot();

export { state, render, loadKbs, loadDetail, showToast, escapeHtml, fmtNumber };
