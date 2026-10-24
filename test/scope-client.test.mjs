/**
 * 胶囊（conversation.input.left）行为测试：在 node:vm 里加载 lib/client.js。
 *
 * 计划 Task 12 原来的 stub 用 hook 下标收集 useState/useEffect，但从不执行 effect，
 * 也不因 setState 重渲染——胶囊的加载、面板、应用、toast、Esc、锚定、卸载全都盖不到。
 * 这里按任务要求换成能真正跑 effect 的最小 React 运行时：
 *   - 每个组件实例有稳定的 hook 槽位（state / ref / effect）；
 *   - setState 同步触发重渲染，effect 在渲染提交后运行；
 *   - effect 重跑前、组件卸载时先跑 cleanup；
 *   - 渲染循环直到没有待处理更新，超过上限直接报错（防止死循环）；
 *   - fetch 用可逐条应答的队列，setTimeout 只记录回调，测试完全确定。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await readFile(join(root, "lib/client.js"), "utf8");
const Fragment = Symbol.for("react.fragment");

const MAX_RENDER_ROUNDS = 100;
const MAX_MICROTASK_TURNS = 60;

/** 应答体：`{ status, body, jsonThrows, reject }`。 */
function makeResponse(spec = {}) {
  const status = spec.status ?? 200;
  const ok = spec.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    async json() {
      if (spec.jsonThrows) throw new SyntaxError("Unexpected token < in JSON");
      return spec.body === undefined ? {} : spec.body;
    },
  };
}

function toMatcher(where) {
  if (typeof where === "function") return where;
  if (typeof where === "string") return (call) => call.url.includes(where);
  const entries = Object.entries(where ?? {});
  if (entries.length === 0) throw new Error("respondWhere needs a matcher");
  return (call) => entries.every(([key, value]) => (
    key === "urlIncludes" ? call.url.includes(value) : call[key] === value
  ));
}

function createFetch() {
  const calls = [];
  const pending = [];

  function fetch(url, init = {}) {
    const call = {
      url: String(url),
      init,
      method: String(init?.method ?? "GET").toUpperCase(),
    };
    calls.push(call);
    const promise = new Promise((resolve, reject) => {
      pending.push({ call, resolve, reject });
    });
    return promise;
  }

  function respondWhere(where, spec = {}) {
    const matches = toMatcher(where);
    const index = pending.findIndex((entry) => matches(entry.call));
    if (index === -1) {
      const list = pending.map((entry) => `${entry.call.method} ${entry.call.url}`).join(", ") || "<none>";
      throw new Error(`no pending fetch matches; pending: ${list}`);
    }
    const [entry] = pending.splice(index, 1);
    if (spec.reject) entry.reject(spec.reject);
    else entry.resolve(makeResponse(spec));
    return entry.call;
  }

  function respond(spec = {}) {
    return respondWhere(() => true, spec);
  }

  function pendingCalls() {
    return pending.map((entry) => entry.call);
  }

  return { fetch, calls, respond, respondWhere, pending: pendingCalls };
}

function createDocument() {
  const styles = [];
  const listeners = [];

  const document = {
    head: {
      appendChild(node) {
        styles.push(node);
      },
    },
    body: { style: {} },
    createElement(tagName) {
      return { tagName, dataset: {}, textContent: "", style: {} };
    },
    querySelector(selector) {
      const id = /data-plugin-css="([^"]+)"/.exec(String(selector))?.[1];
      return styles.find((style) => style.dataset.pluginCss === id) ?? null;
    },
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index !== -1) listeners.splice(index, 1);
    },
  };

  return { document, styles, listeners };
}

function createWindow(entryRef) {
  const listeners = [];
  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    __ModuleLoader__: {
      load(value) {
        entryRef.value = value;
      },
    },
    addEventListener(type, handler, capture) {
      listeners.push({ type, handler, capture: Boolean(capture) });
    },
    removeEventListener(type, handler, capture) {
      const index = listeners.findIndex((entry) => (
        entry.type === type && entry.handler === handler && entry.capture === Boolean(capture)
      ));
      if (index !== -1) listeners.splice(index, 1);
    },
  };
  return { window, listeners };
}

function createTimers() {
  const set = [];
  const pending = [];
  const cleared = [];
  let nextId = 1;

  return {
    set,
    pending,
    cleared,
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      const timer = { id, callback, delay };
      set.push(timer);
      pending.push(timer);
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      const index = pending.findIndex((timer) => timer.id === id);
      if (index !== -1) pending.splice(index, 1);
    },
    fireLatest() {
      const timer = pending.pop();
      if (!timer) throw new Error("fireLatest(): no pending timer");
      timer.callback();
      return timer;
    },
  };
}

function loadCapsule() {
  const entryRef = { value: null };
  const docState = createDocument();
  const winState = createWindow(entryRef);
  const fetchState = createFetch();
  const timers = createTimers();

  const runtime = {
    chipRect: null,
    focused: [],
    renderCount: 0,
    cleanupsRun: 0,
    document: docState.document,
    documentStyles: docState.styles,
    documentListeners: docState.listeners,
    window: winState.window,
    windowListeners: winState.listeners,
    timers,
    fetch: {
      calls: fetchState.calls,
      pending: fetchState.pending,
      respond: fetchState.respond,
      respondWhere: fetchState.respondWhere,
    },
  };

  // ---- 最小 React 运行时：每个组件实例一套稳定 hook 槽位 -------------------
  const instance = {
    props: {},
    hooks: [],
    tree: null,
    pending: false,
    flushing: false,
    rendering: false,
    unmounted: false,
  };
  let component = null;
  let hookIndex = 0;
  let pendingEffects = [];

  function createNode(type, props, key = null) {
    const node = { type, props: props ?? {}, key };
    node.focus = () => {
      runtime.focused.push(node);
    };
    node.getBoundingClientRect = () => runtime.chipRect ?? undefined;
    const ref = node.props.ref;
    if (ref && typeof ref === "object") ref.current = node;
    return node;
  }

  function sameDeps(previous, next) {
    if (previous === undefined || next === undefined) return false;
    if (previous.length !== next.length) return false;
    return previous.every((value, index) => Object.is(value, next[index]));
  }

  function useState(initial) {
    const index = hookIndex;
    hookIndex += 1;
    let slot = instance.hooks[index];
    if (slot === undefined) {
      const value = typeof initial === "function" ? initial() : initial;
      slot = { kind: "state", value };
      slot.setter = (next) => {
        // React 18 语义：组件卸载后的更新被忽略。
        if (instance.unmounted) return;
        const nextValue = typeof next === "function" ? next(slot.value) : next;
        if (Object.is(nextValue, slot.value)) return;
        slot.value = nextValue;
        requestRender();
      };
      instance.hooks[index] = slot;
    }
    if (slot.kind !== "state") throw new Error(`hook #${index} changed kind`);
    return [slot.value, slot.setter];
  }

  function useRef(initial) {
    const index = hookIndex;
    hookIndex += 1;
    let slot = instance.hooks[index];
    if (slot === undefined) {
      slot = { kind: "ref", current: initial };
      instance.hooks[index] = slot;
    }
    if (slot.kind !== "ref") throw new Error(`hook #${index} changed kind`);
    return slot;
  }

  function useEffect(create, deps) {
    const index = hookIndex;
    hookIndex += 1;
    pendingEffects.push({ index, create, deps });
  }

  function commitEffects() {
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      let slot = instance.hooks[effect.index];
      if (slot === undefined) {
        slot = { kind: "effect", initialized: false, deps: undefined, cleanup: undefined };
        instance.hooks[effect.index] = slot;
      }
      if (slot.kind !== "effect") throw new Error(`hook #${effect.index} changed kind`);
      if (slot.initialized && effect.deps !== undefined && sameDeps(slot.deps, effect.deps)) continue;
      if (typeof slot.cleanup === "function") {
        slot.cleanup();
        runtime.cleanupsRun += 1;
        slot.cleanup = undefined;
      }
      const cleanup = effect.create();
      slot.initialized = true;
      slot.deps = effect.deps;
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
  }

  function renderOnce() {
    runtime.renderCount += 1;
    hookIndex = 0;
    pendingEffects = [];
    instance.rendering = true;
    try {
      instance.tree = component(instance.props);
    } finally {
      instance.rendering = false;
    }
    commitEffects();
  }

  function flushRenders() {
    if (instance.flushing) return;
    instance.flushing = true;
    try {
      let rounds = 0;
      while (instance.pending) {
        rounds += 1;
        if (rounds > MAX_RENDER_ROUNDS) {
          throw new Error(`render loop did not settle after ${MAX_RENDER_ROUNDS} rounds`);
        }
        instance.pending = false;
        renderOnce();
      }
    } finally {
      instance.flushing = false;
    }
  }

  function requestRender() {
    if (instance.unmounted) return;
    instance.pending = true;
    if (!instance.rendering && !instance.flushing) flushRenders();
  }

  function unmount() {
    if (instance.unmounted) return;
    instance.unmounted = true;
    for (const slot of instance.hooks) {
      if (slot?.kind === "effect" && typeof slot.cleanup === "function") {
        slot.cleanup();
        runtime.cleanupsRun += 1;
        slot.cleanup = undefined;
      }
    }
  }

  // ---- VM 环境与 bundle 加载 ---------------------------------------------
  const context = {
    window: winState.window,
    document: docState.document,
    fetch: fetchState.fetch,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console,
  };
  vm.runInNewContext(bundle, context, { filename: "lib/client.js" });
  const entry = entryRef.value;
  assert.ok(entry, "bundle did not call window.__ModuleLoader__.load");

  const mod = entry.factory((id) => {
    if (id === "react") {
      return {
        createElement(type, props, ...children) {
          const normalized = { ...(props ?? {}) };
          if (children.length === 1) normalized.children = children[0];
          else if (children.length > 1) normalized.children = children;
          return createNode(type, normalized);
        },
        Fragment,
        useState,
        useEffect,
        useRef,
        useCallback(callback) {
          return callback;
        },
      };
    }
    if (id === "react/jsx-runtime") {
      return { jsx: createNode, jsxs: createNode, Fragment };
    }
    if (id === "react-dom") {
      return { createPortal: (node, container) => ({ portal: node, container }) };
    }
    throw new Error(`unexpected require: ${id}`);
  });

  mod.apply({
    slots: {
      inject(_name, callback) {
        callback();
      },
      register(declaration, value) {
        if (declaration.name === "conversation.input.left") component = value;
      },
    },
  });
  assert.equal(typeof component, "function", "KbScopeCapsule was not registered");

  // ---- 挂载句柄 -----------------------------------------------------------
  function mount(props = {}) {
    instance.props = props;
    instance.pending = true;
    flushRenders();
    return {
      get tree() {
        return instance.tree;
      },
      rerender(nextProps) {
        instance.props = nextProps === undefined ? instance.props : nextProps;
        instance.pending = true;
        flushRenders();
        return instance.tree;
      },
      unmount,
    };
  }

  // ---- 测试辅助 -----------------------------------------------------------
  function childrenOf(value) {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value;
    if (value.portal !== undefined) return [value.portal];
    const children = value.props?.children;
    if (children === undefined || children === null) return [];
    return Array.isArray(children) ? children : [children];
  }

  function walk(value, visit) {
    if (value === null || value === undefined || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
      return;
    }
    visit(value);
    for (const child of childrenOf(value)) walk(child, visit);
  }

  function hasClass(node, className) {
    return typeof node?.props?.className === "string"
      && node.props.className.split(/\s+/).includes(className);
  }

  function findByClass(value, className) {
    let found = null;
    walk(value, (node) => {
      if (found === null && hasClass(node, className)) found = node;
    });
    return found;
  }

  function findAllByClass(value, className) {
    const found = [];
    walk(value, (node) => {
      if (hasClass(node, className)) found.push(node);
    });
    return found;
  }

  function findByType(value, type) {
    let found = null;
    walk(value, (node) => {
      if (found === null && node.type === type) found = node;
    });
    return found;
  }

  function findAllByType(value, type) {
    const found = [];
    walk(value, (node) => {
      if (node.type === type) found.push(node);
    });
    return found;
  }

  function text(value) {
    if (value === null || value === undefined || typeof value === "boolean") return "";
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) return value.map((child) => text(child)).join("");
    if (typeof value !== "object") return "";
    return text(value.props?.children);
  }

  function click(node) {
    assert.ok(node, "click() needs a node");
    assert.equal(node.type, "button", "click() expects a button node");
    if (node.props.disabled) return false; // 浏览器不会给 disabled 按钮派发 click
    node.props.onClick?.({ type: "click", currentTarget: node, target: node });
    return true;
  }

  function dispatch(node) {
    assert.ok(node, "dispatch() needs a node");
    node.props.onClick?.({ type: "click", currentTarget: node, target: node });
  }

  function change(node, value) {
    assert.ok(node, "change() needs a node");
    const event = {
      target: {
        value,
        checked: typeof value === "boolean" ? value : Boolean(node.props.checked),
      },
    };
    node.props.onChange?.(event);
    return event;
  }

  function emitDocument(type, event) {
    const handlers = docState.listeners.filter((entry) => entry.type === type).map((entry) => entry.handler);
    for (const handler of handlers) handler(event);
    return handlers.length;
  }

  function stateSnapshot() {
    return JSON.parse(JSON.stringify(
      instance.hooks.filter((slot) => slot?.kind === "state").map((slot) => slot.value)
    ));
  }

  async function flush(turns = MAX_MICROTASK_TURNS) {
    for (let index = 0; index < turns; index += 1) await Promise.resolve();
  }

  Object.assign(runtime, {
    mount,
    flush,
    respond: fetchState.respond,
    respondWhere: fetchState.respondWhere,
    click,
    dispatch,
    change,
    text,
    emitDocument,
    stateSnapshot,
    findByClass,
    findAllByClass,
    findByType,
    findAllByType,
    urls: () => fetchState.calls.map((call) => call.url),
  });
  return runtime;
}

// ---- 组合辅助 -------------------------------------------------------------

function chipOf(rt, ui) {
  return rt.findByClass(ui.tree, "dsh-kb-scope-chip");
}

function panelOf(rt, ui) {
  return rt.findByClass(ui.tree, "dsh-kb-scope-panel");
}

function rowsOf(rt, ui) {
  const panel = panelOf(rt, ui);
  assert.ok(panel, "scope panel is not open");
  return rt.findAllByClass(panel, "dsh-kb-scope-row");
}

function checkboxOf(rt, row) {
  return rt.findByType(row, "input");
}

function buttonByText(rt, ui, label) {
  const panel = panelOf(rt, ui);
  assert.ok(panel, "scope panel is not open");
  const button = rt.findAllByType(panel, "button").find((node) => rt.text(node) === label);
  assert.ok(button, `button "${label}" is missing`);
  return button;
}

async function respondScopeData(rt, { scope, kbs }) {
  rt.respondWhere("/scope?", { body: { scope } });
  rt.respondWhere("/kbs", { body: { kbs } });
  await rt.flush();
}

async function loadReady(scope, kbs, { sessionId = "s1" } = {}) {
  const rt = loadCapsule();
  const ui = rt.mount({ sessionId });
  rt.respond({ body: { features: { scope: true } } });
  await rt.flush();
  await respondScopeData(rt, { scope, kbs });
  return { rt, ui };
}

async function openPanel(rt, ui, data) {
  rt.click(chipOf(rt, ui));
  assert.equal(panelOf(rt, ui), null, "panel must stay hidden until the refresh resolves");
  assert.equal(rt.fetch.pending().filter((call) => call.url.includes("/scope?")).length, 1);
  assert.equal(rt.fetch.pending().filter((call) => call.url.endsWith("/kbs")).length, 1);
  await respondScopeData(rt, data);
  assert.ok(panelOf(rt, ui), "panel did not open after the refresh");
}

async function applyAndRespond(rt, ui, response) {
  rt.click(buttonByText(rt, ui, "应用"));
  const put = rt.fetch.calls.filter((call) => call.method === "PUT").at(-1);
  assert.ok(put, "apply did not send a PUT");
  rt.respondWhere({ method: "PUT" }, response);
  await rt.flush();
  return put;
}

// ===========================================================================
// 1. 隐藏：没有工作台 / 没有 scope 能力 / 没有说话会话时静默
// ===========================================================================

test("capsule stays hidden when /status is unavailable (HTTP 404)", async () => {
  const rt = loadCapsule();
  const ui = rt.mount({ sessionId: "s1" });
  assert.deepEqual(rt.urls(), ["/kb/api/status"]);
  rt.respond({ status: 404 });
  await rt.flush();
  assert.equal(ui.tree, null);
  assert.equal(rt.fetch.calls.filter((call) => call.url.includes("/scope")).length, 0);
});

test("capsule stays hidden when /status returns a non-JSON body", async () => {
  const rt = loadCapsule();
  const ui = rt.mount({ sessionId: "s1" });
  rt.respond({ jsonThrows: true });
  await rt.flush();
  assert.equal(ui.tree, null);
  assert.equal(rt.fetch.calls.filter((call) => call.url.includes("/scope")).length, 0);
});

test("capsule stays hidden when /status fetch rejects", async () => {
  const rt = loadCapsule();
  const ui = rt.mount({ sessionId: "s1" });
  rt.respond({ reject: new Error("offline") });
  await rt.flush();
  assert.equal(ui.tree, null);
  assert.equal(rt.fetch.calls.filter((call) => call.url.includes("/scope")).length, 0);
});

test("capsule stays hidden when features.scope is false", async () => {
  const rt = loadCapsule();
  const ui = rt.mount({ sessionId: "s1" });
  rt.respond({ body: { features: { scope: false } } });
  await rt.flush();
  assert.equal(ui.tree, null);
  assert.equal(rt.fetch.calls.filter((call) => call.url.includes("/scope")).length, 0);
});

test("capsule renders nothing and fetches nothing without sessionId", async () => {
  const rt = loadCapsule();
  const ui = rt.mount({});
  await rt.flush();
  assert.equal(ui.tree, null);
  assert.equal(rt.fetch.calls.length, 0);
});

// ===========================================================================
// 2. 胶囊文案：加载 / 全部 / N 个 / 失败重试
// ===========================================================================

test("chip renders the loading label before /status resolves", () => {
  const rt = loadCapsule();
  const ui = rt.mount({ sessionId: "s1" });
  const chip = chipOf(rt, ui);
  assert.ok(chip, "chip missing");
  assert.equal(chip.type, "button");
  assert.equal(chip.props["aria-label"], "知识库：…");
  assert.equal(chip.props["aria-expanded"], false);
  assert.equal(chip.props.title, "知识库：…");
  assert.equal(rt.text(chip), "知识库：…");
});

test("chip shows 全部 for an all-mode scope", async () => {
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, [{ name: "Alpha" }]);
  const chip = chipOf(rt, ui);
  assert.equal(rt.text(chip), "知识库：全部");
  assert.equal(chip.props["aria-label"], "知识库：全部");
  assert.equal(chip.props.title, "知识库：全部");
  assert.doesNotMatch(chip.props.className, /dsh-kb-scope-chip-active/);
});

test("chip shows N 个 and the active style for a selected scope", async () => {
  const { rt, ui } = await loadReady(
    { mode: "selected", kbs: ["Alpha", "Beta"] },
    [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }]
  );
  const chip = chipOf(rt, ui);
  assert.equal(rt.text(chip), "知识库：2 个");
  assert.equal(chip.props["aria-label"], "知识库：2 个");
  assert.match(chip.props.className, /dsh-kb-scope-chip-active/);
});

test("chip shows — when the scope request fails; clicking retries and recovers", async () => {
  const rt = loadCapsule();
  const ui = rt.mount({ sessionId: "s1" });
  rt.respond({ body: { features: { scope: true } } });
  await rt.flush();
  rt.respondWhere("/scope?", { status: 500 });
  await rt.flush();
  // kbs 请求此时还挂着；先收掉，避免干扰重试后的队列顺序
  rt.respondWhere("/kbs", { body: { kbs: [{ name: "Alpha" }] } });
  await rt.flush();
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：—");
  assert.equal(chipOf(rt, ui).props.title, "知识库：点击重试");
  assert.doesNotMatch(chipOf(rt, ui).props.className, /dsh-kb-scope-chip-active/);
  assert.equal(panelOf(rt, ui), null);

  rt.click(chipOf(rt, ui));
  await rt.flush();
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：…");
  assert.match(rt.fetch.calls.at(-1).url, /\/kb\/api\/status$/);
  rt.respond({ body: { features: { scope: true } } });
  await rt.flush();
  await respondScopeData(rt, { scope: { mode: "all", kbs: [] }, kbs: [{ name: "Alpha" }] });
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：全部");
  assert.equal(panelOf(rt, ui), null, "retry must not open the panel");
});

test("chip shows — when the kbs request fails", async () => {
  const rt = loadCapsule();
  const ui = rt.mount({ sessionId: "s1" });
  rt.respond({ body: { features: { scope: true } } });
  await rt.flush();
  rt.respondWhere("/scope?", { body: { scope: { mode: "all", kbs: [] } } });
  rt.respondWhere("/kbs", { status: 500 });
  await rt.flush();
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：—");
});

// ===========================================================================
// 3. 打开面板：刷新完成前不渲染、行过滤、草稿播种、关闭不发请求
// ===========================================================================

test("panel stays hidden until the open refresh resolves", async () => {
  const kbs = [{ name: "Alpha" }, { name: "Beta" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  assert.equal(panelOf(rt, ui), null);

  rt.click(chipOf(rt, ui));
  assert.equal(chipOf(rt, ui).props["aria-expanded"], true);
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：全部");
  assert.equal(panelOf(rt, ui), null, "panel must wait for the refresh");
  assert.deepEqual(rt.fetch.pending().map((call) => call.url), [
    "/kb/api/scope?session=s1",
    "/kb/api/kbs",
  ]);

  await respondScopeData(rt, { scope: { mode: "all", kbs: [] }, kbs });
  assert.ok(panelOf(rt, ui));
});

test("rows exclude merged knowledge bases and show live document counts", async () => {
  const kbs = [
    { name: "Alpha", docs: { total: 5, deleted: 2 } },
    { name: "Beta", docs: { total: 0 } },
    { name: "Gamma", docs: 4 },
    { name: "Delta", docs: { total: 2, deleted: 3 } },
    { name: "Merged", mergedInto: "Alpha" },
  ];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });
  const rows = rowsOf(rt, ui);
  assert.deepEqual(
    rows.map((row) => rt.text(rt.findByClass(row, "dsh-kb-scope-name"))),
    ["Alpha", "Beta", "Gamma", "Delta"]
  );
  assert.deepEqual(
    rows.map((row) => rt.text(rt.findByClass(row, "dsh-kb-scope-meta"))),
    ["3 篇", "空库", "4 篇", "空库"]
  );
});

test("draft is seeded from the fresh scope and drops archived names", async () => {
  const kbs = [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }];
  const { rt, ui } = await loadReady({ mode: "selected", kbs: ["Gamma"] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "selected", kbs: ["Beta", "Archived"] }, kbs });
  const rows = rowsOf(rt, ui);
  assert.deepEqual(
    rows.map((row) => [rt.text(rt.findByClass(row, "dsh-kb-scope-name")), checkboxOf(rt, row).props.checked]),
    [["Alpha", false], ["Beta", true], ["Gamma", false]]
  );
  assert.doesNotMatch(rt.text(panelOf(rt, ui)), /Archived/);
});

test("the search box filters rows by name or description", async () => {
  const kbs = [
    { name: "Alpha", description: "合同模板" },
    { name: "Beta", description: "国家标准" },
    { name: "Gamma" },
  ];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });

  const search = rt.findByType(panelOf(rt, ui), "input");
  assert.ok(search, "search input missing");
  assert.equal(search.props.placeholder, "搜索知识库");

  rt.change(search, "合同");
  assert.deepEqual(
    rowsOf(rt, ui).map((row) => rt.text(rt.findByClass(row, "dsh-kb-scope-name"))),
    ["Alpha"]
  );
  assert.equal(rt.findByType(panelOf(rt, ui), "input").props.value, "合同");

  rt.change(rt.findByType(panelOf(rt, ui), "input"), "beta");
  assert.deepEqual(
    rowsOf(rt, ui).map((row) => rt.text(rt.findByClass(row, "dsh-kb-scope-name"))),
    ["Beta"]
  );

  rt.change(rt.findByType(panelOf(rt, ui), "input"), "");
  assert.equal(rowsOf(rt, ui).length, 3);
});

test("clicking the chip while the panel is open closes it without a new fetch", async () => {
  const kbs = [{ name: "Alpha" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });
  const callsBefore = rt.fetch.calls.length;

  rt.click(chipOf(rt, ui));
  assert.equal(panelOf(rt, ui), null);
  assert.equal(chipOf(rt, ui).props["aria-expanded"], false);
  await rt.flush();
  assert.equal(rt.fetch.calls.length, callsBefore);
  assert.equal(rt.fetch.pending().length, 0);
});

test("closing and reopening during a refresh reuses the single in-flight request", async () => {
  const kbs = [{ name: "Alpha" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);

  rt.click(chipOf(rt, ui)); // 打开：刷新在途
  assert.equal(rt.fetch.pending().length, 2);
  rt.click(chipOf(rt, ui)); // 关闭
  rt.click(chipOf(rt, ui)); // 刷新返回前再打开
  assert.equal(rt.fetch.pending().length, 2, "single-flight must not start a second request");

  await respondScopeData(rt, { scope: { mode: "all", kbs: [] }, kbs });
  assert.ok(panelOf(rt, ui), "panel should open from the shared refresh");
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：全部");
});

// ===========================================================================
// 4. 应用：PUT 载荷、成功/失败、保存中禁用、双击单飞
// ===========================================================================

test("untouched all-mode applies {mode:'all',kbs:[]} with the UI header", async () => {
  const kbs = [{ name: "Alpha" }, { name: "Beta" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });

  const applyButton = rt.findByClass(ui.tree, "dsh-kb-scope-primary");
  assert.equal(rt.text(applyButton), "应用");
  rt.click(applyButton);

  const puts = rt.fetch.calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 1);
  const [call] = puts;
  assert.equal(call.url, "/kb/api/scope");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.equal(call.init.headers["x-kb-ui"], "1");
  assert.deepEqual(JSON.parse(call.init.body), { session: "s1", mode: "all", kbs: [] });

  rt.respondWhere({ method: "PUT" }, { body: { scope: { mode: "all", kbs: [] } } });
  await rt.flush();
  assert.equal(panelOf(rt, ui), null, "success should close the panel");
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：全部");
  assert.equal(rt.text(rt.findByClass(ui.tree, "dsh-kb-scope-toast")), "已改为全部知识库");
});

test("清空 applies an empty selection as mode=all", async () => {
  const kbs = [{ name: "Alpha" }, { name: "Beta" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });

  rt.click(buttonByText(rt, ui, "清空"));
  assert.deepEqual(
    rowsOf(rt, ui).map((row) => checkboxOf(rt, row).props.checked),
    [false, false]
  );
  rt.click(buttonByText(rt, ui, "应用"));
  const put = rt.fetch.calls.find((call) => call.method === "PUT");
  assert.deepEqual(JSON.parse(put.init.body), { session: "s1", mode: "all", kbs: [] });
  rt.respondWhere({ method: "PUT" }, { body: { scope: { mode: "all", kbs: [] } } });
  await rt.flush();
});

test("全选 in a selected scope applies mode=all", async () => {
  const kbs = [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }];
  const { rt, ui } = await loadReady({ mode: "selected", kbs: ["Alpha"] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "selected", kbs: ["Alpha"] }, kbs });

  rt.click(buttonByText(rt, ui, "全选"));
  assert.deepEqual(
    rowsOf(rt, ui).map((row) => checkboxOf(rt, row).props.checked),
    [true, true, true]
  );
  rt.click(buttonByText(rt, ui, "应用"));
  const put = rt.fetch.calls.find((call) => call.method === "PUT");
  assert.deepEqual(JSON.parse(put.init.body), { session: "s1", mode: "all", kbs: [] });
  rt.respondWhere({ method: "PUT" }, { body: { scope: { mode: "all", kbs: [] } } });
  await rt.flush();
});

test("subset applies a selected payload in knowledge-base list order", async () => {
  const kbs = [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }];
  const { rt, ui } = await loadReady({ mode: "selected", kbs: ["Gamma", "Alpha"] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "selected", kbs: ["Gamma", "Alpha"] }, kbs });

  assert.deepEqual(
    rowsOf(rt, ui).map((row) => checkboxOf(rt, row).props.checked),
    [true, false, true]
  );
  rt.click(buttonByText(rt, ui, "应用"));
  const put = rt.fetch.calls.find((call) => call.method === "PUT");
  assert.deepEqual(JSON.parse(put.init.body), {
    session: "s1",
    mode: "selected",
    kbs: ["Alpha", "Gamma"],
  });

  rt.respondWhere({ method: "PUT" }, { body: { scope: { mode: "selected", kbs: ["Alpha", "Gamma"] } } });
  await rt.flush();
  assert.equal(panelOf(rt, ui), null);
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：2 个");
  assert.equal(rt.text(rt.findByClass(ui.tree, "dsh-kb-scope-toast")), "已限定为 2 个知识库");
});

test("failed PUT keeps the panel and chip, disables controls while saving, shows server message", async () => {
  const kbs = [{ name: "Alpha" }, { name: "Beta" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });

  rt.click(buttonByText(rt, ui, "应用"));
  const saving = panelOf(rt, ui);
  assert.ok(saving, "panel should stay open while saving");
  const buttons = rt.findAllByType(saving, "button");
  assert.equal(buttons.length, 5);
  for (const button of buttons) {
    assert.equal(button.props.disabled, true, `button "${rt.text(button)}" should be disabled while saving`);
  }
  for (const row of rowsOf(rt, ui)) {
    assert.equal(checkboxOf(rt, row).props.disabled, true, "checkbox should be disabled while saving");
  }

  rt.respondWhere({ method: "PUT" }, { status: 400, body: { error: { message: "范围里的知识库已被归档" } } });
  await rt.flush();
  assert.ok(panelOf(rt, ui), "panel should stay open after a failed apply");
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：全部", "chip must keep the applied scope");
  assert.equal(
    rt.text(rt.findByClass(ui.tree, "dsh-kb-scope-toast")),
    "范围里的知识库已被归档"
  );
  for (const button of rt.findAllByType(panelOf(rt, ui), "button")) {
    assert.equal(button.props.disabled, false, "controls should re-enable after the failure");
  }
  for (const row of rowsOf(rt, ui)) {
    assert.equal(checkboxOf(rt, row).props.disabled, false, "checkboxes should re-enable after the failure");
  }
});

test("non-JSON PUT failure falls back to the generic toast text", async () => {
  const kbs = [{ name: "Alpha" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });
  rt.click(buttonByText(rt, ui, "应用"));
  rt.respondWhere({ method: "PUT" }, { status: 500, jsonThrows: true });
  await rt.flush();
  assert.ok(panelOf(rt, ui));
  assert.equal(rt.text(rt.findByClass(ui.tree, "dsh-kb-scope-toast")), "范围保存失败，请重试");
});

test("double apply sends a single PUT", async () => {
  const kbs = [{ name: "Alpha" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });

  rt.click(buttonByText(rt, ui, "应用"));
  const applyAgain = rt.findByClass(ui.tree, "dsh-kb-scope-primary");
  assert.equal(applyAgain.props.disabled, true);
  assert.equal(rt.click(applyAgain), false, "disabled button must not dispatch");
  rt.dispatch(applyAgain); // 即使硬派发，applySelection 的 saving 守卫也要挡住
  assert.equal(rt.fetch.calls.filter((call) => call.method === "PUT").length, 1);

  rt.respondWhere({ method: "PUT" }, { body: { scope: { mode: "all", kbs: [] } } });
  await rt.flush();
  assert.equal(panelOf(rt, ui), null);
});

// ===========================================================================
// 5. 代号守卫：过期打开刷新不能覆盖已应用范围；归档库名不进 PUT
// ===========================================================================

test("a stale open-refresh cannot overwrite an applied scope", async () => {
  const kbs = [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });
  const staleApply = rt.findByClass(ui.tree, "dsh-kb-scope-primary");

  rt.click(chipOf(rt, ui));
  assert.equal(panelOf(rt, ui), null);
  rt.click(chipOf(rt, ui)); // 重新打开：刷新在途，面板处于 loading
  assert.equal(panelOf(rt, ui), null);
  const pending = rt.fetch.pending();
  assert.equal(pending.filter((call) => call.url.includes("/scope?")).length, 1);
  assert.equal(pending.filter((call) => call.url.endsWith("/kbs")).length, 1);

  // 上一个就绪面板的“应用”在刷新期间被点到（排队 click 的真实竞态）
  rt.click(staleApply);
  await rt.flush();
  const put = rt.fetch.calls.find((call) => call.method === "PUT");
  assert.ok(put, "apply did not send a PUT");
  rt.respondWhere({ method: "PUT" }, { body: { scope: { mode: "selected", kbs: ["Beta"] } } });
  await rt.flush();
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：1 个");

  // 过期刷新在 PUT 之后才返回：必须因代号不符被丢弃
  rt.respondWhere("/scope?", { body: { scope: { mode: "all", kbs: [] } } });
  rt.respondWhere("/kbs", { body: { kbs } });
  await rt.flush();
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：1 个", "stale refresh overwrote the applied scope");
  assert.equal(panelOf(rt, ui), null);
  assert.equal(rt.text(rt.findByClass(ui.tree, "dsh-kb-scope-toast")), "已限定为 1 个知识库");
});

test("archived names are filtered out of the PUT payload", async () => {
  const { rt, ui } = await loadReady(
    { mode: "all", kbs: [] },
    [{ name: "Alpha" }, { name: "Beta" }]
  );
  await openPanel(rt, ui, {
    scope: { mode: "all", kbs: [] },
    kbs: [{ name: "Alpha" }, { name: "Beta" }],
  });

  // 会话切换触发重新加载；Beta 已归档，但草稿里还留着旧勾选
  ui.rerender({ sessionId: "s2" });
  rt.respondWhere("/status", { body: { features: { scope: true } } });
  await rt.flush();
  rt.respondWhere("/scope?", { body: { scope: { mode: "all", kbs: [] } } });
  rt.respondWhere("/kbs", { body: { kbs: [{ name: "Alpha" }, { name: "Gamma" }] } });
  await rt.flush();

  const rows = rowsOf(rt, ui);
  assert.deepEqual(
    rows.map((row) => rt.text(rt.findByClass(row, "dsh-kb-scope-name"))),
    ["Alpha", "Gamma"]
  );
  assert.equal(checkboxOf(rt, rows[0]).props.checked, true);
  assert.equal(checkboxOf(rt, rows[1]).props.checked, false);

  rt.click(buttonByText(rt, ui, "应用"));
  const put = rt.fetch.calls.find((call) => call.method === "PUT");
  assert.deepEqual(JSON.parse(put.init.body), {
    session: "s2",
    mode: "selected",
    kbs: ["Alpha"],
  });
  rt.respondWhere({ method: "PUT" }, { body: { scope: { mode: "selected", kbs: ["Alpha"] } } });
  await rt.flush();
  assert.equal(rt.text(chipOf(rt, ui)), "知识库：1 个");
  assert.equal(rt.text(rt.findByClass(ui.tree, "dsh-kb-scope-toast")), "已限定为 1 个知识库");
});

// ===========================================================================
// 6. Toast：可访问性、CSS 锚点、同文案重复出现要重新计时
// ===========================================================================

test("toast is a live status element anchored by the capsule CSS", async () => {
  const kbs = [{ name: "Alpha" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });
  await applyAndRespond(rt, ui, { body: { scope: { mode: "all", kbs: [] } } });

  const toast = rt.findByClass(ui.tree, "dsh-kb-scope-toast");
  assert.ok(toast, "toast missing");
  assert.equal(toast.props.role, "status");
  assert.equal(toast.props["aria-live"], "polite");
  assert.equal(rt.text(toast), "已改为全部知识库");

  const css = rt.documentStyles.map((style) => style.textContent).join("\n");
  const rule = /\.dsh-kb-scope-toast\s*\{([^}]*)\}/.exec(css)?.at(1) ?? "";
  assert.match(rule, /bottom:\s*24px/);
  assert.match(rule, /left:\s*50%/);
});

test("the same toast message twice re-arms the timer with a new id", async () => {
  const kbs = [{ name: "Alpha" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });
  await applyAndRespond(rt, ui, { body: { scope: { mode: "all", kbs: [] } } });
  assert.equal(rt.timers.set.length, 1);
  const first = rt.timers.set[0];
  assert.equal(first.delay, 2400);

  // 同样的文案再来一次：id 必须递增，effect（deps [toast?.id]）才会重新计时
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });
  await applyAndRespond(rt, ui, { body: { scope: { mode: "all", kbs: [] } } });
  assert.equal(rt.timers.set.length, 2);
  assert.ok(rt.timers.cleared.includes(first.id), "the previous toast timer was not cleared");
  assert.equal(rt.timers.pending.length, 1);
  assert.equal(rt.text(rt.findByClass(ui.tree, "dsh-kb-scope-toast")), "已改为全部知识库");

  rt.timers.fireLatest();
  assert.equal(rt.findByClass(ui.tree, "dsh-kb-scope-toast"), null);
  assert.equal(rt.timers.pending.length, 0);
});

// ===========================================================================
// 7. Esc：关闭面板、摘掉 keydown 监听、焦点回到胶囊
// ===========================================================================

test("Escape closes the panel, removes the keydown listener and refocuses the chip", async () => {
  const kbs = [{ name: "Alpha" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  await openPanel(rt, ui, { scope: { mode: "all", kbs: [] }, kbs });
  assert.equal(rt.documentListeners.filter((entry) => entry.type === "keydown").length, 1);
  assert.equal(rt.focused.length, 0);

  rt.emitDocument("keydown", { key: "a" });
  assert.ok(panelOf(rt, ui), "non-Escape keys must not close the panel");

  rt.emitDocument("keydown", { key: "Escape" });
  assert.equal(panelOf(rt, ui), null);
  assert.equal(chipOf(rt, ui).props["aria-expanded"], false);
  assert.equal(rt.documentListeners.filter((entry) => entry.type === "keydown").length, 0);
  const focused = rt.focused.at(-1);
  assert.ok(focused, "chip was not focused");
  assert.equal(focused.type, "button");
  assert.match(focused.props.className, /dsh-kb-scope-chip/);
});

// ===========================================================================
// 8. 定位：底部锚定 + 左右钳制、缺 rect 时居中、关闭摘监听
// ===========================================================================

test("panel anchors above the chip with a clamped left and no top", async () => {
  const kbs = [{ name: "Alpha" }];
  const data = { scope: { mode: "all", kbs: [] }, kbs };
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);

  rt.chipRect = { left: 100, top: 700, width: 120, height: 24 };
  await openPanel(rt, ui, data);
  let style = panelOf(rt, ui).props.style;
  assert.equal(style.left, 100);
  assert.equal(style.bottom, 800 - 700 + 8);
  assert.equal(Object.hasOwn(style, "top"), false, "bottom-anchored panel must not set top");

  rt.click(chipOf(rt, ui));
  rt.chipRect = { left: 5000, top: 700 };
  await openPanel(rt, ui, data);
  style = panelOf(rt, ui).props.style;
  assert.equal(style.left, 1280 - 328, "left edge should clamp to the viewport");

  rt.click(chipOf(rt, ui));
  rt.chipRect = { left: -40, top: 700 };
  await openPanel(rt, ui, data);
  assert.equal(panelOf(rt, ui).props.style.left, 8);
});

test("missing chip rect centers the panel; close removes resize/scroll listeners", async () => {
  const kbs = [{ name: "Alpha" }];
  const data = { scope: { mode: "all", kbs: [] }, kbs };
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  rt.chipRect = null;

  await openPanel(rt, ui, data);
  const style = panelOf(rt, ui).props.style;
  assert.equal(style.left, "50%");
  assert.equal(style.bottom, 24);
  assert.equal(style.transform, "translateX(-50%)");

  const resize = rt.windowListeners.filter((entry) => entry.type === "resize");
  const scroll = rt.windowListeners.filter((entry) => entry.type === "scroll");
  assert.equal(resize.length, 1);
  assert.equal(scroll.length, 1);
  assert.equal(scroll[0].capture, true, "scroll listener must be capture-phase");

  rt.click(chipOf(rt, ui));
  assert.equal(rt.windowListeners.filter((entry) => entry.type === "resize").length, 0);
  assert.equal(rt.windowListeners.filter((entry) => entry.type === "scroll").length, 0);
});

// ===========================================================================
// 9. 卸载：不抛错、cleanup 跑完、迟到的响应不再改状态
// ===========================================================================

test("unmount during the initial load is silent and ignores the late /status response", async () => {
  const rt = loadCapsule();
  const ui = rt.mount({ sessionId: "s1" });
  assert.equal(rt.fetch.pending().length, 1);
  const snapshot = rt.stateSnapshot();
  const renders = rt.renderCount;
  assert.equal(rt.cleanupsRun, 0);

  ui.unmount();
  assert.equal(rt.cleanupsRun, 1, "load effect cleanup did not run on unmount");
  rt.respond({ body: { features: { scope: true } } });
  await rt.flush();
  assert.equal(rt.renderCount, renders);
  assert.deepEqual(rt.stateSnapshot(), snapshot);
});

test("unmount during a panel refresh cleans up listeners and drops late data", async () => {
  const kbs = [{ name: "Alpha" }];
  const { rt, ui } = await loadReady({ mode: "all", kbs: [] }, kbs);
  rt.chipRect = { left: 12, top: 700 };
  rt.click(chipOf(rt, ui));
  assert.equal(rt.fetch.pending().length, 2);

  const snapshot = rt.stateSnapshot();
  const renders = rt.renderCount;
  const cleanups = rt.cleanupsRun;
  ui.unmount();
  assert.ok(rt.cleanupsRun > cleanups, "effect cleanups did not run on unmount");
  assert.equal(rt.documentListeners.length, 0);
  assert.equal(rt.windowListeners.length, 0);

  rt.respondWhere("/scope?", { body: { scope: { mode: "selected", kbs: ["Alpha"] } } });
  rt.respondWhere("/kbs", { body: { kbs: [{ name: "Alpha" }, { name: "Beta" }] } });
  await rt.flush();
  assert.equal(rt.renderCount, renders);
  assert.deepEqual(rt.stateSnapshot(), snapshot);
});
