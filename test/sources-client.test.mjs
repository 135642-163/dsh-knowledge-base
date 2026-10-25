/**
 * 客户端来源视图：注册 tool.call.toolview / turnTail，渲染 meta.sources 与降级。
 * 只调用组件函数并遍历返回的 React 元素树，不跑真实 React 渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await readFile(join(root, "lib/client.js"), "utf8");

function createRuntime() {
  const registrations = [];
  const styles = [];
  const React = {
    createElement(type, props, ...children) {
      const next = { ...(props ?? {}) };
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      return { type, props: next };
    },
    Fragment: Symbol.for("react.fragment"),
    useState(value) { return [value, () => {}]; },
    useRef(value) { return { current: value }; },
    useEffect() {},
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
  };
  const jsxRuntime = {
    jsx: (type, props) => React.createElement(type, props),
    jsxs: (type, props) => React.createElement(type, props),
    Fragment: React.Fragment,
  };
  const req = (name) => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "react-dom") return { createPortal: (node) => node };
    return {};
  };
  const document = {
    head: { appendChild(node) { styles.push(node); } },
    body: { style: {} },
    createElement(tag) { return { tag, dataset: {}, textContent: "", style: {} }; },
    querySelector() { return null; },
  };
  const opened = [];
  const window = {
    location: { origin: "http://127.0.0.1:51436", assign(url) { opened.push(url); } },
    open(url) { opened.push(url); return { opener: null }; },
    __DSH_BOOT__: { entries: [{ id: "dsh-knowledge-wiki" }] },
    __ModuleLoader__: {
      load({ factory }) {
        const exports = factory(req);
        globalThis.__kbClient = exports;
      },
    },
  };
  const context = { window, document, console, URL, URLSearchParams, setTimeout, clearTimeout };
  vm.runInNewContext(bundle, context);
  const client = context.window.__kbClient ?? globalThis.__kbClient;
  assert.ok(client, "client bundle loaded");
  client.apply({
    slots: {
      inject(name, callback) { callback(); },
      register(declaration, component) { registrations.push({ declaration, component }); },
    },
  });
  return { registrations, styles, opened };
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object") {
    if (typeof node.type === "function") return textOf(node.type(node.props));
    return textOf(node.props?.children);
  }
  return "";
}

function hrefsOf(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) hrefsOf(item, out);
    return out;
  }
  if (typeof node.type === "function") {
    hrefsOf(node.type(node.props), out);
    return out;
  }
  if (node.props?.href) out.push(node.props.href);
  hrefsOf(node.props?.children, out);
  return out;
}

function findByClass(node, className) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findByClass(item, className);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node.type === "function") return findByClass(node.type(node.props), className);
  if (String(node.props?.className ?? "").includes(className)) return node;
  return findByClass(node.props?.children, className);
}

test("client registers tool views and turnTail", () => {
  const { registrations, styles } = createRuntime();
  const keys = registrations.map((item) => `${item.declaration.name}:${item.declaration.key ?? item.declaration.id}`);
  assert.ok(keys.includes("tool.call.toolview:kb_query"));
  assert.ok(keys.includes("tool.call.toolview:kb_read"));
  assert.ok(keys.includes("conversation.chat.turnTail:kb-sources"));
  assert.ok(keys.includes("conversation.chat.assistant-actions:kb-citations"));
  assert.ok(styles.length >= 1);
});

test("kb_query tool view renders sources and deep links", () => {
  const { registrations } = createRuntime();
  const row = registrations.find((item) => item.declaration.name === "tool.call.toolview" && item.declaration.key === "kb_query");
  const tree = row.component({
    toolName: "kb_query",
    phase: "result",
    block: { meta: { sources: [
      { kb: "标准", docId: "d1", title: "GB/T 1-2020", page: 12, clause: "5.2.2", snippet: "电压偏差", deepLink: "/kb/?kb=%E6%A0%87%E5%87%86&doc=d1&page=12" },
    ] } },
    useDisclosure: () => ({ expanded: true, toggle() {} }),
  });
  const text = textOf(tree);
  assert.match(text, /GB\/T 1-2020/);
  assert.match(text, /第 12 页/);
  assert.ok(hrefsOf(tree).some((href) => href.includes("doc=d1")));
});

test("source card click installs an explicit preview handler", () => {
  const { registrations, opened } = createRuntime();
  const row = registrations.find((item) => item.declaration.name === "tool.call.toolview" && item.declaration.key === "kb_query");
  const tree = row.component({
    toolName: "kb_query",
    phase: "result",
    block: { meta: { sources: [
      { kb: "标准", docId: "d1", title: "GB/T 1-2020", page: 12, deepLink: "/kb/?kb=%E6%A0%87%E5%87%86&doc=d1&page=12" },
    ] } },
    useDisclosure: () => ({ expanded: true, toggle() {} }),
  });
  const card = findByClass(tree, "dsh-kb-source-card");
  assert.ok(card, "source card missing");
  let prevented = false;
  card.props.onClick({ preventDefault() { prevented = true; }, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 });
  assert.equal(prevented, true);
  assert.equal(typeof card.props.onClick, "function");
});

test("missing/empty meta degrades to a neutral row", () => {
  const { registrations } = createRuntime();
  const row = registrations.find((item) => item.declaration.name === "tool.call.toolview" && item.declaration.key === "kb_query");
  const tree = row.component({ toolName: "kb_query", phase: "result", block: { meta: {} }, useDisclosure: () => ({ expanded: false, toggle() {} }) });
  assert.match(textOf(tree), /没有可定位的来源/);
});

test("assistant citation action renders a low-risk 引用 button", () => {
  const { registrations } = createRuntime();
  const action = registrations.find((item) => item.declaration.name === "conversation.chat.assistant-actions");
  const tree = action.component({ messageId: "m1" });
  assert.match(textOf(tree), /引用/);
});

test("turnTail panel aggregates sources for the current turn", () => {
  const { registrations } = createRuntime();
  const panel = registrations.find((item) => item.declaration.name === "conversation.chat.turnTail");
  const nodes = new Map([
    ["a", { kind: "tool-call", location: { turn: { turn: 1 } }, data: { root: { meta: { sources: [
      { kb: "标准", docId: "d1", title: "GB/T 1-2020", page: 2, deepLink: "/kb/?doc=d1&page=2" },
    ] } } } }],
    ["b", { kind: "tool-call", location: { turn: { turn: 2 } }, data: { root: { meta: { sources: [
      { kb: "标准", docId: "d2", title: "GB/T 2-2020", page: 3, deepLink: "/kb/?doc=d2&page=3" },
    ] } } } }],
  ]);
  const tree = panel.component({ turn: { turn: 1 }, useChat: (selector) => selector({ nodes }) });
  const text = textOf(tree);
  assert.match(text, /本轮来源（\s*1\s*）/);
  assert.match(text, /GB\/T 1-2020/);
  assert.doesNotMatch(text, /GB\/T 2-2020/);
});
