/**
 * 资料 tab 的交互接线：搜索防抖/输入法、每页条数、跳页、清除搜索与焦点恢复。
 *
 * 这里只做 DOM 事件绑定，不 import app.js 的状态；attachDocsControls 在每次 render
 * 之后重新挂载，旧实例由 bind() 调 detach() 摘掉（清定时器 + 移除监听），避免
 * 过期闭包往已经重绘的页面写值。请求竞态交给 app.js 的 detailGate：这里的 load()
 * 返回 { stale: true } 时结果已被更新的渲染/路由作废，不再记录 appliedQuery。
 */
import { clampDocsPage, docsPageCount, docsPageSize } from "./views/detail.js";

/** 搜索输入防抖：300ms 内连续输入只发一次请求。 */
export const DOCS_SEARCH_DELAY = 300;

/**
 * 单调递增的请求代号。begin() 拿到的 token 在 invalidate() 或下一次 begin() 后过期，
 * 供 loadDetail 在 await 之后判断是否还该写 state（路由切换用 invalidate）。
 */
export function createRequestGate() {
  let token = 0;
  return {
    begin() {
      token += 1;
      return token;
    },
    invalidate() {
      token += 1;
    },
    isCurrent(value) {
      return value === token;
    },
  };
}

/**
 * 绑定资料 tab 的工具栏控件。
 *
 * @param {object} options
 * @param {object} options.app    #app 容器（只要求 querySelector/querySelectorAll）
 * @param {object} options.state  模块级 state；读写 state.docs
 * @param {(request: {query: string, offset: number, limit: number}) => Promise<{stale?: boolean}>} options.load
 *        实际重载资料列表；返回 { stale: true } 表示响应已作废
 * @param {{set: Function, clear: Function}} [options.timers] 可注入的定时器（测试用）
 * @returns {{detach: () => void}}
 */
export function attachDocsControls({ app, state, load, timers = { set: setTimeout, clear: clearTimeout } }) {
  const setTimer = timers?.set ?? setTimeout;
  const clearTimer = timers?.clear ?? clearTimeout;
  const search = app?.querySelector?.("[data-docs-query]") ?? null;
  const tagSelect = app?.querySelector?.("[data-docs-tag]") ?? null;
  const sizeSelects = collect(app, "[data-docs-size]");
  const jumpButtons = collect(app, "[data-docs-jump]");
  const pageInputs = collect(app, "[data-docs-page]");
  const clearButtons = collect(app, "[data-docs-clear]");

  const bindings = [];
  let timer = null;
  let composing = false;
  let applySeq = 0;

  function on(target, type, handler) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler);
    bindings.push({ target, type, handler });
  }

  function cancelTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function requestSnapshot() {
    return {
      query: String(state.docs.query ?? ""),
      tag: String(state.docs.tag ?? ""),
      offset: Math.max(0, Math.round(Number(state.docs.offset) || 0)),
      limit: docsPageSize(state.docs.limit),
    };
  }

  /** 重绘后把焦点和光标送回资料搜索框末尾。 */
  function restoreSearchFocus() {
    const next = app?.querySelector?.("[data-docs-query]") ?? null;
    if (!next) return;
    next.focus?.();
    if (typeof next.setSelectionRange !== "function") return;
    const length = String(next.value ?? "").length;
    next.setSelectionRange(length, length);
  }

  /**
   * 发一次列表请求。只有「最新一次请求 + 未被路由作废」的响应才记录 appliedQuery
   * 并恢复焦点，旧响应直接丢弃（不覆盖更新的结果）。
   */
  async function requestDocs({ focus = false } = {}) {
    const request = requestSnapshot();
    const seq = (applySeq += 1);
    let result;
    try {
      result = await load(request);
    } catch {
      return false;
    }
    if (seq !== applySeq) return false;
    if (result?.stale) return false;
    state.docs.appliedQuery = request.query;
    if (focus) restoreSearchFocus();
    return true;
  }

  async function applyQuery() {
    cancelTimer();
    if (!search) return;
    const value = String(search.value ?? "");
    state.docs.query = value;
    if (value === (state.docs.appliedQuery ?? "")) {
      // 同一个词再按 Enter/输入法结束：不重复请求，只把焦点送回输入框。
      restoreSearchFocus();
      return;
    }
    state.docs.offset = 0;
    await requestDocs({ focus: true });
  }

  async function jumpTo(button) {
    cancelTimer();
    const wrapper = typeof button?.closest === "function" ? button.closest(".docs-jump") : null;
    const input = wrapper?.querySelector?.("[data-docs-page]") ?? app?.querySelector?.("[data-docs-page]") ?? null;
    const limit = docsPageSize(state.docs.limit);
    const pages = docsPageCount(state.docs.total, limit);
    state.docs.limit = limit;
    state.docs.offset = (clampDocsPage(input?.value, pages) - 1) * limit;
    await requestDocs();
  }

  if (search) {
    on(search, "input", (event) => {
      state.docs.query = String(search.value ?? "");
      if (composing || event?.isComposing) return;
      cancelTimer();
      timer = setTimer(() => {
        timer = null;
        void applyQuery();
      }, DOCS_SEARCH_DELAY);
    });
    on(search, "compositionstart", () => {
      composing = true;
      cancelTimer();
    });
    on(search, "compositionend", () => {
      composing = false;
      void applyQuery();
    });
    on(search, "keydown", (event) => {
      if (event?.key !== "Enter" || composing || event?.isComposing) return;
      event.preventDefault?.();
      void applyQuery();
    });
  }

  if (tagSelect) {
    on(tagSelect, "change", () => {
      cancelTimer();
      state.docs.tag = String(tagSelect.value ?? "").trim();
      state.docs.offset = 0;
      state.docs.selected = [];
      void requestDocs();
    });
  }

  for (const select of sizeSelects) {
    on(select, "change", () => {
      cancelTimer();
      state.docs.limit = docsPageSize(select.value);
      state.docs.offset = 0;
      void requestDocs();
    });
  }

  for (const button of jumpButtons) {
    on(button, "click", () => { void jumpTo(button); });
  }

  for (const input of pageInputs) {
    on(input, "keydown", (event) => {
      if (event?.key !== "Enter" || event?.isComposing) return;
      event.preventDefault?.();
      void jumpTo(input);
    });
  }

  for (const button of clearButtons) {
    on(button, "click", () => {
      cancelTimer();
      state.docs.query = "";
      state.docs.offset = 0;
      if (search) search.value = "";
      void requestDocs({ focus: true });
    });
  }

  return {
    detach() {
      cancelTimer();
      for (const { target, type, handler } of bindings.splice(0)) {
        target.removeEventListener?.(type, handler);
      }
    },
  };
}

function collect(app, selector) {
  const list = app?.querySelectorAll?.(selector);
  return list ? Array.from(list) : [];
}
