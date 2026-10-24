/**
 * 资料工具栏交互（ui/docs-controls.js）：防抖/输入法/Enter、每页条数、跳页、
 * 清除搜索、焦点恢复、detach 与旧响应丢弃。全部用 fake element + fake timers。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { attachDocsControls, createRequestGate, DOCS_SEARCH_DELAY } from "../ui/docs-controls.js";

function createTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    pending,
    set(callback, delay) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { id, callback, delay });
      return id;
    },
    clear(id) {
      pending.delete(id);
    },
    get size() {
      return pending.size;
    },
    fireLatest() {
      const timer = [...pending.values()].at(-1);
      assert.ok(timer, "no pending timer to fire");
      pending.delete(timer.id);
      timer.callback();
      return timer;
    },
  };
}

function createElement(kind) {
  const listeners = new Map();
  const element = {
    kind,
    value: "",
    dataset: {},
    focusCount: 0,
    selection: null,
    wrapper: null,
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
    dispatch(type, patch = {}) {
      const event = {
        type,
        target: element,
        currentTarget: element,
        preventDefault() { event.defaultPrevented = true; },
        ...patch,
      };
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
      return event;
    },
    focus() {
      element.focusCount += 1;
    },
    setSelectionRange(start, end) {
      element.selection = { start, end };
    },
    closest(selector) {
      return selector === ".docs-jump" ? element.wrapper : null;
    },
    querySelector(selector) {
      if (selector === "[data-docs-page]") return element.wrapper?.pageInput ?? null;
      return null;
    },
  };
  return element;
}

function createHarness({ deferred = false } = {}) {
  const timers = createTimers();
  const search = createElement("search");
  const size = createElement("select");
  const clear = createElement("button");
  const pageInput = createElement("page");
  const jump = createElement("button");
  const wrapper = {
    pageInput,
    querySelector(selector) {
      return selector === "[data-docs-page]" ? pageInput : null;
    },
  };
  jump.wrapper = wrapper;
  pageInput.wrapper = wrapper;
  size.value = "50";

  const collections = new Map([
    ["[data-docs-size]", [size]],
    ["[data-docs-jump]", [jump]],
    ["[data-docs-page]", [pageInput]],
    ["[data-docs-clear]", [clear]],
  ]);
  const app = {
    querySelector(selector) {
      if (selector === "[data-docs-query]") return search;
      if (selector === "[data-docs-page]") return pageInput;
      return null;
    },
    querySelectorAll(selector) {
      return collections.get(selector) ?? [];
    },
  };
  const state = {
    docs: { items: [], total: 0, offset: 0, limit: 50, query: "", appliedQuery: "" },
  };
  const calls = [];
  const resolvers = [];
  const load = (request) => {
    calls.push({ ...request });
    if (!deferred) return Promise.resolve({ stale: false });
    return new Promise((resolve) => resolvers.push(resolve));
  };
  const controls = attachDocsControls({
    app,
    state,
    load,
    timers: { set: timers.set, clear: timers.clear },
  });
  return {
    app,
    timers,
    search,
    size,
    clear,
    pageInput,
    jump,
    state,
    calls,
    controls,
    resolveLoad(index, value = { stale: false }) {
      const resolve = resolvers[index];
      assert.ok(resolve, `no pending load #${index}`);
      resolve(value);
    },
  };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test("防抖把两次快速输入合并成一次请求，并记录真正应用的 query", async () => {
  const h = createHarness();
  h.state.docs.offset = 100;
  h.state.docs.total = 220;

  h.search.value = "继电";
  h.search.dispatch("input");
  h.search.value = "继电保护";
  h.search.dispatch("input");
  assert.equal(h.timers.size, 1, "two rapid inputs must share one pending timer");

  const timer = h.timers.fireLatest();
  assert.equal(timer.delay, DOCS_SEARCH_DELAY);
  await flush();

  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], { query: "继电保护", offset: 0, limit: 50 });
  assert.equal(h.state.docs.query, "继电保护");
  assert.equal(h.state.docs.appliedQuery, "继电保护");
  assert.equal(h.state.docs.offset, 0);
  assert.equal(h.search.focusCount, 1, "focus must be restored after the search reload");
  assert.deepEqual(h.search.selection, {
    start: "继电保护".length,
    end: "继电保护".length,
  });
});

test("输入法组合期间不发中间请求，compositionend 后立即应用", async () => {
  const h = createHarness();

  h.search.dispatch("compositionstart");
  h.search.value = "继电";
  h.search.dispatch("input", { isComposing: true });
  h.search.value = "继电保护";
  h.search.dispatch("input", { isComposing: true });
  assert.equal(h.timers.size, 0);
  await flush();
  assert.equal(h.calls.length, 0);

  h.search.dispatch("compositionend");
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].query, "继电保护");
  assert.equal(h.state.docs.appliedQuery, "继电保护");
  assert.equal(h.search.focusCount, 1);
});

test("Enter 立即请求并取消挂起的防抖计时器", async () => {
  const h = createHarness();

  h.search.value = "DL/T 478";
  h.search.dispatch("input");
  assert.equal(h.timers.size, 1);

  const event = h.search.dispatch("keydown", { key: "Enter" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.timers.size, 0, "Enter must clear the pending debounce timer");
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].query, "DL/T 478");

  // 输入法组合中的 Enter 不应提交。
  h.search.value = "继电保护";
  h.search.dispatch("compositionstart");
  h.search.dispatch("keydown", { key: "Enter", isComposing: true });
  await flush();
  assert.equal(h.calls.length, 1);
});

test("每页条数只接受 50/100/200，切换后回到第一页", async () => {
  const h = createHarness();
  h.state.docs.offset = 100;

  h.size.value = "200";
  h.size.dispatch("change");
  await flush();
  assert.equal(h.state.docs.limit, 200);
  assert.equal(h.state.docs.offset, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].limit, 200);
  assert.equal(h.calls[0].offset, 0);

  h.state.docs.offset = 300;
  h.size.value = "999";
  h.size.dispatch("change");
  await flush();
  assert.equal(h.state.docs.limit, 50, "invalid page size must fall back to 50");
  assert.equal(h.state.docs.offset, 0);
  assert.equal(h.calls.at(-1).limit, 50);
});

test("跳页把页码收敛到 1..总页数，0/999/NaN 都安全", async () => {
  const h = createHarness();
  h.state.docs.total = 120;
  h.state.docs.limit = 50;

  const cases = [
    ["0", 0],
    ["999", 100],
    ["abc", 0],
    ["1", 0],
    ["2", 50],
  ];
  for (const [value, offset] of cases) {
    h.pageInput.value = value;
    h.jump.dispatch("click");
    await flush();
    assert.equal(h.calls.at(-1).offset, offset, `jump(${value}) offset`);
  }
  assert.equal(h.state.docs.offset, 50);
  assert.equal(h.state.docs.limit, 50);

  // 页码输入框回车等价于点「跳转」。
  h.pageInput.value = "3";
  const event = h.pageInput.dispatch("keydown", { key: "Enter" });
  assert.equal(event.defaultPrevented, true);
  await flush();
  assert.equal(h.calls.at(-1).offset, 100);
  assert.equal(h.state.docs.offset, 100);
});

test("清除搜索取消挂起的防抖并清空 query/offset，随后不会补发旧词", async () => {
  const h = createHarness();
  h.state.docs.query = "旧词";
  h.state.docs.appliedQuery = "旧词";
  h.state.docs.offset = 100;
  h.state.docs.total = 120;

  h.search.value = "新词";
  h.search.dispatch("input");
  assert.equal(h.timers.size, 1);

  h.clear.dispatch("click");
  assert.equal(h.timers.size, 0, "clear must cancel the pending debounce");
  assert.equal(h.state.docs.query, "");
  assert.equal(h.state.docs.offset, 0);
  assert.equal(h.search.value, "", "the cleared input value must not linger");

  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].query, "");
  assert.equal(h.calls[0].offset, 0);
  assert.equal(h.state.docs.appliedQuery, "");
  assert.equal(h.search.focusCount, 1);
  assert.deepEqual(h.search.selection, { start: 0, end: 0 });

  // 模拟 load 触发的 render/detach：已清掉的词不会被旧计时器或旧闭包补发。
  h.controls.detach();
  assert.equal(h.timers.size, 0);
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.state.docs.query, "");
});

test("detach 清掉挂起的计时器并移除全部监听，之后不再触发请求", async () => {
  const h = createHarness();
  h.search.value = "继电";
  h.search.dispatch("input");
  assert.equal(h.timers.size, 1);
  assert.equal(h.search.listenerCount("input"), 1);

  h.controls.detach();
  assert.equal(h.timers.size, 0, "detach must clear the pending timer");
  assert.equal(h.search.listenerCount("input"), 0);
  assert.equal(h.search.listenerCount("compositionstart"), 0);
  assert.equal(h.search.listenerCount("compositionend"), 0);
  assert.equal(h.search.listenerCount("keydown"), 0);
  assert.equal(h.size.listenerCount("change"), 0);
  assert.equal(h.jump.listenerCount("click"), 0);
  assert.equal(h.pageInput.listenerCount("keydown"), 0);
  assert.equal(h.clear.listenerCount("click"), 0);

  // 旧元素上的事件不再排定新请求。
  h.search.dispatch("input");
  h.clear.dispatch("click");
  assert.equal(h.timers.size, 0);
  await flush();
  assert.equal(h.calls.length, 0);
});

test("createRequestGate 只放行最新 token，invalidate 会作废在途请求", () => {
  const gate = createRequestGate();
  const first = gate.begin();
  assert.equal(gate.isCurrent(first), true);

  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);

  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);

  const third = gate.begin();
  assert.equal(gate.isCurrent(third), true);
  assert.equal(gate.isCurrent(second), false);
});

test("旧请求晚到的响应不能覆盖更新的搜索状态", async () => {
  const h = createHarness({ deferred: true });

  h.search.value = "旧词";
  h.search.dispatch("input");
  h.timers.fireLatest();
  await flush();
  assert.equal(h.calls.length, 1);

  h.search.value = "新词";
  h.search.dispatch("input");
  h.timers.fireLatest();
  await flush();
  assert.equal(h.calls.length, 2);

  h.resolveLoad(1);
  await flush();
  assert.equal(h.state.docs.appliedQuery, "新词");
  assert.equal(h.search.focusCount, 1);

  h.resolveLoad(0);
  await flush();
  assert.equal(h.state.docs.appliedQuery, "新词", "the older response must not win");
  assert.equal(h.state.docs.query, "新词");
  assert.equal(h.search.focusCount, 1, "the stale response must not steal focus");
});

test("被 load 标记为 stale 的响应不记录 appliedQuery，也不恢复焦点", async () => {
  const h = createHarness({ deferred: true });

  h.search.value = "删掉的词";
  h.search.dispatch("input");
  h.timers.fireLatest();
  await flush();
  assert.equal(h.calls.length, 1);

  h.resolveLoad(0, { stale: true });
  await flush();
  assert.equal(h.state.docs.appliedQuery, "");
  assert.equal(h.search.focusCount, 0);
  assert.equal(h.state.docs.query, "删掉的词");
});
