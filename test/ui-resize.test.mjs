/**
 * 弹窗拖拽调大小：几何计算 + 最小假 DOM 上的拖拽流程。
 * 重点是「拖边框不会触发遮罩关闭」——pointerdown 必须 stopPropagation，
 * 且整段拖拽只动弹窗自己的 style，不碰遮罩的点击路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clampNumber, fitRect, resizeRect } from "../ui/resize-geometry.js";
import { mountResize, readStoredSize, writeStoredSize } from "../ui/resizable.js";

test("clampNumber 在 min 大于 max 时保下限，非数值退回下限", () => {
  assert.equal(clampNumber(5, 0, 10), 5);
  assert.equal(clampNumber(-5, 0, 10), 0);
  assert.equal(clampNumber(50, 0, 10), 10);
  assert.equal(clampNumber(30, 40, 10), 40);
  assert.equal(clampNumber(Number.NaN, 7, 10), 7);
});

test("resizeRect：拖右/下边只改宽高，左边与上边不动", () => {
  const start = { left: 100, top: 80, width: 600, height: 400 };
  const east = resizeRect(start, { dx: 120, dy: 90 }, "e", { viewportWidth: 1440, viewportHeight: 900 });
  assert.deepEqual(east, { left: 100, top: 80, width: 720, height: 400 });
  const south = resizeRect(start, { dx: 120, dy: 90 }, "s", { viewportWidth: 1440, viewportHeight: 900 });
  assert.deepEqual(south, { left: 100, top: 80, width: 600, height: 490 });
});

test("resizeRect：拖左边时右边界锚定，拖上边时下边界锚定", () => {
  const start = { left: 100, top: 80, width: 600, height: 400 };
  const west = resizeRect(start, { dx: -50, dy: 0 }, "w", { viewportWidth: 1440, viewportHeight: 900 });
  assert.deepEqual(west, { left: 50, top: 80, width: 650, height: 400 });
  assert.equal(west.left + west.width, 700, "右边界保持 700 不动");
  const north = resizeRect(start, { dx: 0, dy: -50 }, "n", { viewportWidth: 1440, viewportHeight: 900 });
  assert.deepEqual(north, { left: 100, top: 30, width: 600, height: 450 });
  assert.equal(north.top + north.height, 480, "下边界保持 480 不动");
});

test("resizeRect：最小尺寸兜底，视口不够时不越过右边距", () => {
  const start = { left: 100, top: 80, width: 600, height: 400 };
  const tiny = resizeRect(start, { dx: -9999, dy: -9999 }, "e", { minWidth: 480, minHeight: 360, viewportWidth: 1440, viewportHeight: 900 });
  assert.equal(tiny.width, 480);
  const wide = resizeRect(start, { dx: 9999, dy: 0 }, "e", { margin: 8, viewportWidth: 1440, viewportHeight: 900 });
  assert.equal(wide.width, 1440 - 8 - 100);
  const north = resizeRect(start, { dx: 0, dy: -9999 }, "n", { minHeight: 360, margin: 8, viewportWidth: 1440, viewportHeight: 900 });
  assert.equal(north.top, 8);
  assert.equal(north.height, 480 - 8);
});

test("resizeRect：四角同时动两边，未知方向原样返回", () => {
  const start = { left: 100, top: 80, width: 600, height: 400 };
  const se = resizeRect(start, { dx: 60, dy: 40 }, "se", { viewportWidth: 1440, viewportHeight: 900 });
  assert.deepEqual(se, { left: 100, top: 80, width: 660, height: 440 });
  const nw = resizeRect(start, { dx: -40, dy: -20 }, "nw", { viewportWidth: 1440, viewportHeight: 900 });
  assert.deepEqual(nw, { left: 60, top: 60, width: 640, height: 420 });
  assert.deepEqual(resizeRect(start, { dx: 50, dy: 50 }, "", {}), start);
});

test("fitRect：记忆尺寸超视口时回夹并居中，最小值不被击穿", () => {
  const fitted = fitRect({ width: 4000, height: 3000 }, { minWidth: 640, minHeight: 420, margin: 24, viewportWidth: 1440, viewportHeight: 900 });
  assert.equal(fitted.width, 1440 - 48);
  assert.equal(fitted.height, 900 - 48);
  assert.equal(fitted.left, 24);
  assert.equal(fitted.top, 24);
  const small = fitRect({ width: 10, height: 10 }, { minWidth: 640, minHeight: 420, margin: 24, viewportWidth: 1440, viewportHeight: 900 });
  assert.equal(small.width, 640);
  assert.equal(small.left, (1440 - 640) / 2);
  const offscreen = fitRect({ left: -500, top: 5000, width: 600, height: 400 }, { minWidth: 480, minHeight: 360, margin: 8, viewportWidth: 1440, viewportHeight: 900 });
  assert.equal(offscreen.left, 8);
  assert.equal(offscreen.top, 900 - 8 - 400);
});

test("尺寸记忆：读写绕开脏数据，键带前缀", () => {
  const map = new Map();
  const storage = { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)) };
  assert.equal(writeStoredSize("preview", { width: 900.4, height: 640.6 }, storage), true);
  assert.equal(map.get("dsh-kb:size:preview"), "{\"width\":900,\"height\":641}");
  assert.deepEqual(readStoredSize("preview", storage), { width: 900, height: 641 });
  map.set("dsh-kb:size:preview", "{not json");
  assert.equal(readStoredSize("preview", storage), null);
  map.set("dsh-kb:size:preview", JSON.stringify({ width: -1, height: 10 }));
  assert.equal(readStoredSize("preview", storage), null);
  assert.equal(readStoredSize("", storage), null);
  assert.equal(writeStoredSize("preview", { width: 0, height: 0 }, storage), false);
});

// ---- 最小假 DOM：只覆盖 resizable.js 用到的那几个方法 ----

function fakeClassList() {
  const set = new Set();
  return {
    add: (...names) => { for (const name of names) set.add(name); },
    remove: (...names) => { for (const name of names) set.delete(name); },
    contains: (name) => set.has(name),
  };
}

function fakeElement(tag, rect) {
  const listeners = new Map();
  const element = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    isConnected: true,
    clientLeft: 0,
    clientTop: 0,
    rect: rect ?? { left: 100, top: 80, width: 800, height: 600 },
    classList: fakeClassList(),
    appendChild(child) {
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    remove() {
      const parent = element.parentNode;
      if (parent) {
        const index = parent.children.indexOf(element);
        if (index >= 0) parent.children.splice(index, 1);
      }
      element.parentNode = null;
      element.isConnected = false;
    },
    querySelectorAll: () => [],
    setAttribute() {},
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      const { left, top, width, height } = element.rect;
      return { left, top, width, height, right: left + width, bottom: top + height };
    },
  };
  return element;
}

function fakeWindow() {
  const listeners = new Map();
  const frames = [];
  const map = new Map();
  const win = {
    innerWidth: 1440,
    innerHeight: 900,
    localStorage: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
    flushFrames() {
      const pending = frames.splice(0);
      for (const callback of pending) callback();
    },
  };
  return win;
}

function harness({ stored = null } = {}) {
  const win = fakeWindow();
  const doc = {
    defaultView: win,
    documentElement: { style: {} },
    createElement: (tag) => fakeElement(tag),
  };
  const overlay = fakeElement("div", { left: 0, top: 0, width: 1440, height: 900 });
  const dialog = fakeElement("div", { left: 100, top: 80, width: 800, height: 600 });
  dialog.ownerDocument = doc;
  overlay.ownerDocument = doc;
  if (stored) win.localStorage.setItem("dsh-kb:size:preview", JSON.stringify(stored));
  return { win, doc, overlay, dialog };
}

test("mountResize：把八个把手挂到遮罩上，拖拽时不冒泡、不碰遮罩", () => {
  const { win, overlay, dialog } = harness();
  const handle = mountResize(dialog, overlay, { storageKey: "preview", minWidth: 480, minHeight: 360 });
  assert.equal(overlay.children.length, 8, "八向把手都挂在遮罩下");
  assert.deepEqual(overlay.children.map((child) => child.dataset.dir).sort(), ["e", "n", "ne", "nw", "s", "se", "sw", "w"]);
  assert.ok(dialog.classList.contains("kb-resizable"));

  const east = overlay.children.find((child) => child.dataset.dir === "e");
  let stopped = false;
  let prevented = false;
  east.dispatch("pointerdown", {
    button: 0,
    isPrimary: true,
    pointerId: 1,
    clientX: 900,
    clientY: 300,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  });
  assert.equal(stopped, true, "pointerdown 不冒泡到遮罩（遮罩按 mousedown 关闭）");
  assert.equal(prevented, true, "preventDefault 让浏览器不再派发兼容 mousedown");

  win.dispatch("pointermove", { clientX: 1000, clientY: 300 });
  win.flushFrames();
  assert.equal(dialog.style.width, "900px");
  assert.equal(dialog.style.left, "100px");
  assert.equal(dialog.style.position, "fixed");
  assert.ok(dialog.classList.contains("kb-sized"));

  win.dispatch("pointerup", { type: "pointerup", clientX: 1000, clientY: 300 });
  assert.equal(JSON.parse(win.localStorage.getItem("dsh-kb:size:preview")).width, 900);
  assert.equal(dialog.classList.contains("kb-resizing"), false);

  handle.destroy();
  assert.equal(overlay.children.length, 0, "关闭时把手清干净");
});

test("mountResize：打开时按记忆尺寸就位（仍居中），并夹到视口内", () => {
  const { overlay, dialog } = harness({ stored: { width: 4000, height: 3000 } });
  const handle = mountResize(dialog, overlay, { storageKey: "preview", minWidth: 480, minHeight: 360, margin: 24 });
  assert.equal(dialog.style.width, `${1440 - 48}px`);
  assert.equal(dialog.style.height, `${900 - 48}px`);
  assert.equal(dialog.style.position, undefined, "只是恢复尺寸，不改定位方式");
  assert.equal(dialog.classList.contains("kb-sized"), true);
  handle.destroy();
});

test("mountResize：最小尺寸兜底，拖拽不会把弹窗压成 0", () => {
  const { win, overlay, dialog } = harness();
  const handle = mountResize(dialog, overlay, { storageKey: "preview", minWidth: 480, minHeight: 360 });
  const west = overlay.children.find((child) => child.dataset.dir === "w");
  west.dispatch("pointerdown", { button: 0, isPrimary: true, pointerId: 2, clientX: 100, clientY: 300, preventDefault() {}, stopPropagation() {} });
  win.dispatch("pointermove", { clientX: 1200, clientY: 300 });
  win.flushFrames();
  assert.equal(dialog.style.width, "480px");
  assert.equal(dialog.style.left, "420px", "右边锚定在 900，宽度 480 → 左边 420");
  win.dispatch("pointerup", { type: "pointerup", clientX: 1200, clientY: 300 });
  handle.destroy();
});

test("mountResize：非主键/空节点安全退出", () => {
  assert.equal(typeof mountResize(null, null).destroy, "function");
  const { win, overlay, dialog } = harness();
  const handle = mountResize(dialog, overlay, { storageKey: "preview" });
  const north = overlay.children.find((child) => child.dataset.dir === "n");
  north.dispatch("pointerdown", { button: 2, isPrimary: true, pointerId: 3, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
  win.dispatch("pointermove", { clientX: 0, clientY: -100 });
  win.flushFrames();
  assert.equal(dialog.style.width, undefined, "右键不会开始拖拽");
  handle.destroy();
});
