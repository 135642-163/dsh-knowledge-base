/**
 * 检索页交互接线（ui/search-controls.js）：防抖/输入法/Enter、过滤与清除、
 * 加载更多、焦点恢复、旧响应作废、detach。fake element + fake timers。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SEARCH_DELAY, attachSearchControls } from "../ui/search-controls.js";

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
    clear(id) { pending.delete(id); },
    get size() { return pending.size; },
    fireLatest() {
      const timer = [...pending.values()].at(-1);
      assert.ok(timer, "no pending timer to fire");
      pending.delete(timer.id);
      timer.callback();
      return timer;
    },
  };
}

function createElement(kind, props = {}) {
  const listeners = new Map();
  const element = {
    kind,
    value: "",
    dataset: {},
    focusCount: 0,
    selection: null,
    ...props,
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
        isComposing: false,
        preventDefault() {},
        ...patch,
      };
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
      return event;
    },
    focus() { this.focusCount += 1; },
    setSelectionRange(start, end) { this.selection = [start, end]; },
  };
  return element;
}

function createApp({ filters = ["kb", "tag", "type", "trust"] } = {}) {
  const query = createElement("input");
  const clear = createElement("button");
  const more = createElement("button");
  const selects = new Map(filters.map((key) => {
    const element = createElement("select");
    element.dataset.searchFilter = key;
    return [key, element];
  }));
  const app = {
    query,
    clear,
    more,
    selects,
    querySelector(selector) {
      if (selector === "[data-search-query]") return query;
      if (selector === "[data-search-clear]") return clear;
      if (selector === "[data-search-more]") return more;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-search-filter]") return [...selects.values()];
      return [];
    },
  };
  return app;
}

function makeState(search = {}) {
  return {
    search: {
      q: "", appliedQ: "", kb: "", tag: "", type: "", trust: "",
      offset: 0, limit: 20, results: [], total: 0,
      ...search,
    },
  };
}

function makeLoad(handler = () => ({ stale: false })) {
  const calls = [];
  const load = async (request) => {
    calls.push(request);
    return handler(request, calls.length);
  };
  return { load, calls };
}

function attach({ app = createApp(), state = makeState(), load, timers = createTimers(), after, focus } = {}) {
  const handle = attachSearchControls({
    app,
    state,
    load,
    timers,
    after: after ?? (() => {}),
    focus: focus ?? (() => {}),
  });
  return { app, state, timers, handle };
}

test("输入防抖：连续输入只发一次请求，且 offset 归零", async () => {
  const { load, calls } = makeLoad();
  const { app, state, timers } = attach({ load, state: makeState({ offset: 120 }) });
  app.query.value = "电";
  app.query.dispatch("input");
  app.query.value = "电压";
  app.query.dispatch("input");
  app.query.value = "电压偏差";
  app.query.dispatch("input");
  assert.equal(timers.size, 1, "300ms 防抖只留一个定时器");
  assert.equal(calls.length, 0);
  assert.equal(timers.fireLatest().delay, SEARCH_DELAY);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { reset: true });
  assert.equal(state.search.q, "电压偏差");
  assert.equal(state.search.offset, 0);
});

test("Enter 立即检索并取消待触发的防抖", async () => {
  const { load, calls } = makeLoad();
  const { app, timers } = attach({ load });
  app.query.value = "电压偏差";
  app.query.dispatch("input");
  assert.equal(timers.size, 1);
  app.query.dispatch("keydown", { key: "Enter" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.size, 0);
  assert.equal(calls.length, 1);
});

test("输入法组合期间不发请求，组合结束立即应用", async () => {
  const { load, calls } = makeLoad();
  const { app, timers } = attach({ load });
  app.query.dispatch("compositionstart");
  app.query.value = "电压";
  app.query.dispatch("input", { isComposing: true });
  assert.equal(timers.size, 0);
  app.query.value = "电压偏差";
  app.query.dispatch("compositionend");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1, "compositionend 应立即应用");
  assert.equal(timers.size, 0);
});

test("过滤变更立即检索并重置 offset", async () => {
  const { load, calls } = makeLoad();
  const { app, state } = attach({ load, state: makeState({ offset: 40, results: new Array(40) }) });
  const trust = app.selects.get("trust");
  trust.value = "high";
  trust.dispatch("change");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.search.trust, "high");
  assert.equal(state.search.offset, 0);
  assert.deepEqual(calls[0], { reset: true });
});

test("清除条件清空检索词与过滤", async () => {
  const { load, calls } = makeLoad();
  const { app, state } = attach({
    load,
    state: makeState({ q: "电压", appliedQ: "电压", kb: "标准", tag: "并网", type: "docx", trust: "high", offset: 20 }),
  });
  app.query.value = "电压";
  app.clear.dispatch("click");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.search.q, "");
  assert.equal(state.search.kb, "");
  assert.equal(state.search.tag, "");
  assert.equal(state.search.type, "");
  assert.equal(state.search.trust, "");
  assert.equal(state.search.offset, 0);
  assert.equal(app.query.value, "", "输入框也应清空");
  assert.deepEqual(calls[0], { reset: true });
});

test("加载更多把 offset 前移并追加", async () => {
  const { load, calls } = makeLoad();
  const { app, state } = attach({ load, state: makeState({ q: "电压", appliedQ: "电压", offset: 20, limit: 20 }) });
  app.more.dispatch("click");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.search.offset, 40);
  assert.deepEqual(calls[0], { reset: false });
});

test("旧响应作废时不记录 appliedQ、不抢焦点", async () => {
  const { load } = makeLoad(() => ({ stale: true }));
  let focused = 0;
  const { app } = attach({ load, focus: () => { focused += 1; } });
  app.query.value = "电压";
  app.query.dispatch("keydown", { key: "Enter" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(focused, 0);
});

test("检索完成后把焦点还给输入框", async () => {
  const { load } = makeLoad();
  let focused = 0;
  const { app } = attach({ load, focus: () => { focused += 1; } });
  app.query.value = "电压";
  app.query.dispatch("keydown", { key: "Enter" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(focused, 1);
});

test("after() 在请求之前调用（用于同步 hash）", async () => {
  const order = [];
  const { load } = makeLoad(() => { order.push("load"); return { stale: false }; });
  const { app } = attach({ load, after: () => order.push("after") });
  app.query.value = "电压";
  app.query.dispatch("keydown", { key: "Enter" });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["after", "load"]);
});

test("detach 清掉定时器与所有监听", async () => {
  const { load } = makeLoad();
  const { app, timers, handle } = attach({ load });
  app.query.value = "电压";
  app.query.dispatch("input");
  assert.equal(timers.size, 1);
  handle.detach();
  assert.equal(timers.size, 0);
  assert.equal(app.query.listenerCount("input"), 0);
  assert.equal(app.query.listenerCount("keydown"), 0);
  assert.equal(app.clear.listenerCount("click"), 0);
  assert.equal(app.more.listenerCount("click"), 0);
  for (const select of app.selects.values()) assert.equal(select.listenerCount("change"), 0);
});
