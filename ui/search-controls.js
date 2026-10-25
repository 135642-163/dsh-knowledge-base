/**
 * 检索页交互接线：搜索防抖/输入法/Enter、过滤与清除、加载更多、焦点恢复。
 *
 * 与资料页/回收站同一套约定：attach 在每次 render 之后重新挂载，旧实例由 bind()
 * 调 detach() 摘掉（清定时器 + 移除监听）；请求竞态由 app.js 的 searchGate 处理，
 * load() 返回 { stale: true } 时说明响应已被更新的检索/路由作废，不再抢焦点。
 */
import { SEARCH_DELAY } from "./search-core.js";

export { SEARCH_DELAY };

/**
 * @param {object} options
 * @param {object} options.app    #app 容器（只要求 querySelector/querySelectorAll）
 * @param {object} options.state  模块级 state；读写 state.search
 * @param {(request: {reset: boolean}) => Promise<{stale?: boolean}>} options.load 执行检索
 * @param {() => void} [options.after]  发请求前回调（同步 hash 用）
 * @param {() => void} [options.focus]  检索完成后恢复输入框焦点
 * @param {{set: Function, clear: Function}} [options.timers] 可注入定时器（测试用）
 */
export function attachSearchControls({
  app,
  state,
  load,
  after = () => {},
  focus = () => {},
  timers = {},
} = {}) {
  const setTimer = timers?.set ?? setTimeout;
  const clearTimer = timers?.clear ?? clearTimeout;
  const query = app?.querySelector?.("[data-search-query]") ?? null;
  const clear = app?.querySelector?.("[data-search-clear]") ?? null;
  const more = app?.querySelector?.("[data-search-more]") ?? null;
  const filters = [...(app?.querySelectorAll?.("[data-search-filter]") ?? [])];
  const bindings = [];
  let timer = null;
  let composing = false;

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

  function setQuery(value) {
    if (!state.search) state.search = {};
    state.search.q = String(value ?? "");
  }

  function readInput() {
    return String(query?.value ?? state.search?.q ?? "");
  }

  /**
   * 应用一次检索。reset=true 时 offset 归零（新条件），false 时保留（加载更多）。
   */
  async function apply({ reset = true, focusAfter = false } = {}) {
    cancelTimer();
    if (query) setQuery(query.value);
    if (reset) state.search.offset = 0;
    else state.search.offset = Math.max(0, Math.round(Number(state.search.offset) || 0));
    after();
    const result = await load({ reset });
    if (result?.stale) return;
    if (focusAfter) focus();
  }

  // 搜索框：防抖 + 输入法安全 + Enter 立即检索
  on(query, "compositionstart", () => {
    composing = true;
    cancelTimer();
  });
  on(query, "compositionend", () => {
    composing = false;
    void apply({ reset: true, focusAfter: true });
  });
  on(query, "input", (event) => {
    setQuery(readInput());
    if (composing || event?.isComposing === true) return;
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      void apply({ reset: true, focusAfter: true });
    }, SEARCH_DELAY);
  });
  on(query, "keydown", (event) => {
    if (event?.key !== "Enter" || composing || event?.isComposing === true) return;
    event.preventDefault?.();
    void apply({ reset: true, focusAfter: true });
  });

  // 过滤下拉：立即生效并重置分页
  for (const select of filters) {
    on(select, "change", () => {
      const key = String(select?.dataset?.searchFilter ?? "");
      if (key === "") return;
      if (!state.search) state.search = {};
      state.search[key] = String(select?.value ?? "");
      void apply({ reset: true });
    });
  }

  // 清除条件：检索词与所有过滤一起清空
  on(clear, "click", () => {
    if (!state.search) state.search = {};
    state.search.q = "";
    for (const key of ["kb", "tag", "type", "trust"]) state.search[key] = "";
    if (query) query.value = "";
    for (const select of filters) select.value = "";
    void apply({ reset: true, focusAfter: true });
  });

  // 加载更多：offset 前移后追加
  on(more, "click", () => {
    if (!state.search) state.search = {};
    const limit = Math.max(1, Math.round(Number(state.search.limit) || 20));
    state.search.offset = Math.max(0, Math.round(Number(state.search.offset) || 0)) + limit;
    void apply({ reset: false });
  });

  return {
    detach() {
      cancelTimer();
      for (const { target, type, handler } of bindings) {
        target.removeEventListener?.(type, handler);
      }
      bindings.length = 0;
    },
    /** 供测试与外部按钮（示例词）复用：按给定词立即检索。 */
    applyQuery(value) {
      if (query) query.value = String(value ?? "");
      setQuery(String(value ?? ""));
      return apply({ reset: true, focusAfter: true });
    },
  };
}
