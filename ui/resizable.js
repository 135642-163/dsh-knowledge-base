/**
 * 给弹窗加「拖边框调大小」：八个把手挂在**遮罩层**上（不是弹窗里），
 * 所以把手永远在弹窗外面，不会盖住 iframe 的滚动条或正文边缘。
 *
 * 关键点（也是它不会破坏「点外部关闭」的原因）：
 * - 关闭逻辑挂在遮罩的 mousedown 上，判据是 event.target === 遮罩；
 *   把手的 target 是把手自己，事件还 stopPropagation，遮罩收不到；
 * - 拖拽用 pointer capture + 拖拽期间禁用 iframe 的 pointer-events，
 *   光标划过 iframe 也不会丢 pointermove；
 * - 拖完吞掉紧随的一次 click（万一以后有人把关闭逻辑改成 click，
 *   松开在遮罩上也不会误关）；拖拽中按 Esc 只结束拖拽、不关弹窗。
 *
 * 行为：第一次拖动时把弹窗切成 position:fixed 并固定当前矩形，之后
 * 哪条边被拖就只动哪条边；松手把 {width,height} 记到 localStorage，
 * 下次打开按记忆尺寸居中恢复，并夹到视口内。
 */

import { DEFAULT_LIMITS, RESIZE_CURSOR, fitRect, resizeRect } from "./resize-geometry.js";

const STORAGE_PREFIX = "dsh-kb:size:";
const HANDLE_SIZE = 6;
const CORNER_SIZE = 12;
const DRAG_THRESHOLD = 2;

export { RESIZE_CURSOR };

/** 有些浏览器（无痕 / 沙箱 iframe）连访问 localStorage 都会抛，取不到就当没有。 */
export function safeStorage(win) {
  try {
    return win?.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 读记忆尺寸；隐私模式 / 脏数据 / 没有 key 都返回 null。 */
export function readStoredSize(key, storage = globalThis.localStorage) {
  if (!key || !storage || typeof storage.getItem !== "function") return null;
  try {
    const raw = storage.getItem(`${STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const width = Number(parsed?.width);
    const height = Number(parsed?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/** 写记忆尺寸；写不进去（隐私模式 / 配额）就静默放弃，不影响拖拽。 */
export function writeStoredSize(key, size, storage = globalThis.localStorage) {
  if (!key || !storage || typeof storage.setItem !== "function") return false;
  const width = Math.round(Number(size?.width));
  const height = Math.round(Number(size?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  try {
    storage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify({ width, height }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 给 target 装上可拖拽缩放的把手。overlay 必须是覆盖整个视口的定位容器
 * （弹窗的遮罩层），把手会挂到它下面。
 *
 * @returns {{ destroy: () => void }}
 */
export function mountResize(target, overlay, options = {}) {
  const doc = target?.ownerDocument ?? (typeof document === "undefined" ? null : document);
  const win = doc?.defaultView ?? null;
  if (!target || !overlay || !doc || !win) return { destroy() {} };

  const { storageKey = "", minWidth = DEFAULT_LIMITS.minWidth, minHeight = DEFAULT_LIMITS.minHeight, margin = DEFAULT_LIMITS.margin } = options;
  const viewport = () => ({ viewportWidth: win.innerWidth, viewportHeight: win.innerHeight });
  const limits = () => ({ minWidth, minHeight, margin, ...viewport() });

  /** 把手坐标相对遮罩的 padding box；遮罩铺满视口时就是视口坐标。 */
  const offset = () => {
    const rect = overlay.getBoundingClientRect();
    return { x: rect.left + overlay.clientLeft, y: rect.top + overlay.clientTop };
  };

  const handleList = [];
  const handleByDir = new Map();
  let drag = null;
  let destroyed = false;
  let swallowTimer = 0;
  let pendingClickGuard = null;
  let pendingClickRelease = null;

  target.classList.add("kb-resizable");
  const storage = safeStorage(win);

  // 1) 记忆尺寸：打开时就位（仍然居中），避免先大后小闪一下。
  const stored = readStoredSize(storageKey, storage);
  if (stored) {
    const fitted = fitRect({ ...stored, left: null, top: null }, limits());
    target.style.width = `${fitted.width}px`;
    target.style.height = `${fitted.height}px`;
    target.style.maxWidth = "none";
    target.style.maxHeight = "none";
    target.style.boxSizing = "border-box";
    target.classList.add("kb-sized");
  }

  // 2) 八向把手
  for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const handle = doc.createElement("div");
    handle.className = "kb-resize-handle";
    handle.dataset.dir = dir;
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (event) => startDrag(event, dir, handle));
    overlay.appendChild(handle);
    handleList.push(handle);
    handleByDir.set(dir, handle);
  }

  function place() {
    if (destroyed || !target.isConnected) return;
    const rect = target.getBoundingClientRect();
    const { x, y } = offset();
    const put = (dir, left, top, width, height) => {
      const handle = handleByDir.get(dir);
      if (!handle) return;
      handle.style.left = `${left - x}px`;
      handle.style.top = `${top - y}px`;
      handle.style.width = `${Math.max(0, width)}px`;
      handle.style.height = `${Math.max(0, height)}px`;
    };
    const edge = HANDLE_SIZE;
    const corner = CORNER_SIZE / 2;
    put("n", rect.left + CORNER_SIZE, rect.top - edge, rect.width - CORNER_SIZE * 2, edge);
    put("s", rect.left + CORNER_SIZE, rect.bottom, rect.width - CORNER_SIZE * 2, edge);
    put("w", rect.left - edge, rect.top + CORNER_SIZE, edge, rect.height - CORNER_SIZE * 2);
    put("e", rect.right, rect.top + CORNER_SIZE, edge, rect.height - CORNER_SIZE * 2);
    put("nw", rect.left - corner, rect.top - corner, CORNER_SIZE, CORNER_SIZE);
    put("ne", rect.right - corner, rect.top - corner, CORNER_SIZE, CORNER_SIZE);
    put("sw", rect.left - corner, rect.bottom - corner, CORNER_SIZE, CORNER_SIZE);
    put("se", rect.right - corner, rect.bottom - corner, CORNER_SIZE, CORNER_SIZE);
  }

  /** 从「遮罩居中的流式盒子」切成固定定位，尺寸不变，所以不会跳。 */
  function detachToFixed(rect) {
    target.style.position = "fixed";
    target.style.margin = "0";
    target.style.left = `${rect.left}px`;
    target.style.top = `${rect.top}px`;
    target.style.width = `${rect.width}px`;
    target.style.height = `${rect.height}px`;
    target.style.maxWidth = "none";
    target.style.maxHeight = "none";
    target.style.boxSizing = "border-box";
    target.classList.add("kb-sized");
  }

  function applyRect(rect) {
    target.style.left = `${rect.left}px`;
    target.style.top = `${rect.top}px`;
    target.style.width = `${rect.width}px`;
    target.style.height = `${rect.height}px`;
  }

  function freezeFrames(frozen, frozenFrames) {
    if (frozen) {
      target.querySelectorAll("iframe").forEach((frame) => {
        frozenFrames.push({ frame, value: frame.style.pointerEvents });
        frame.style.pointerEvents = "none";
      });
      return;
    }
    for (const { frame, value } of frozenFrames.splice(0)) frame.style.pointerEvents = value;
  }

  /**
   * 拖完吞掉这一次手势尾巴上的 click：按下在把手、松开在遮罩时，click 会落到
   * 两者的最近公共祖先＝遮罩，若将来把关闭逻辑改成 click 就会误关。
   *
   * 只吞「拖拽自己的」那一下：新的手势从 pointerdown 开始，一旦按下就撤掉守卫，
   * 所以拖完马上点遮罩仍然能关（不能用固定延时，否则会吃掉用户的下一次点击）。
   */
  function guardClick() {
    dropClickGuard();
    const done = () => {
      win.removeEventListener("click", swallow, true);
      win.removeEventListener("pointerdown", release, true);
      win.clearTimeout?.(swallowTimer);
      swallowTimer = 0;
      if (pendingClickGuard === swallow) pendingClickGuard = null;
      if (pendingClickRelease === release) pendingClickRelease = null;
    };
    const swallow = (event) => {
      event.stopPropagation();
      event.preventDefault();
      done();
    };
    const release = () => done();
    pendingClickGuard = swallow;
    pendingClickRelease = release;
    win.addEventListener("click", swallow, true);
    win.addEventListener("pointerdown", release, true);
    // 兜底：浏览器一直不派发 click 时（例如触控被系统吃掉），别把守卫留到下一次手势。
    swallowTimer = win.setTimeout(done, 2000);
  }

  function dropClickGuard() {
    if (pendingClickGuard) win.removeEventListener("click", pendingClickGuard, true);
    if (pendingClickRelease) win.removeEventListener("pointerdown", pendingClickRelease, true);
    pendingClickGuard = null;
    pendingClickRelease = null;
    win.clearTimeout?.(swallowTimer);
    swallowTimer = 0;
  }

  function startDrag(event, dir, handle) {
    if (drag || destroyed) return;
    if (typeof event.button === "number" && event.button !== 0) return;
    if (event.isPrimary === false) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = target.getBoundingClientRect();
    const state = {
      dir,
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      detached: false,
      moved: false,
      latest: { dx: 0, dy: 0 },
      frame: 0,
      frozenFrames: [],
      lastRect: null,
    };
    drag = state;
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {
      /* Safari 旧版可能不支持，靠 window 上的监听兜底 */
    }
    win.addEventListener("pointermove", onDragMove, true);
    win.addEventListener("pointerup", onDragEnd, true);
    win.addEventListener("pointercancel", onDragEnd, true);
    win.addEventListener("blur", onDragEnd, true);
    win.addEventListener("keydown", onDragKeyDown, true);
    const { userSelect } = doc.documentElement.style;
    state.previousUserSelect = userSelect;
    doc.documentElement.style.userSelect = "none";
    doc.documentElement.style.cursor = RESIZE_CURSOR[dir] ?? "default";
  }

  function beginDragState(state) {
    detachToFixed(state.origin);
    state.detached = true;
    freezeFrames(true, state.frozenFrames);
    target.classList.add("kb-resizing");
    target.dataset.kbResizing = "1";
  }

  function onDragMove(event) {
    if (!drag) return;
    drag.latest = { dx: event.clientX - drag.startX, dy: event.clientY - drag.startY };
    if (!drag.detached) {
      if (Math.abs(drag.latest.dx) < DRAG_THRESHOLD && Math.abs(drag.latest.dy) < DRAG_THRESHOLD) return;
      beginDragState(drag);
    }
    drag.moved = true;
    if (drag.frame) return;
    drag.frame = win.requestAnimationFrame(() => {
      if (!drag) return;
      drag.frame = 0;
      const next = resizeRect(drag.origin, drag.latest, drag.dir, limits());
      drag.lastRect = next;
      applyRect(next);
      place();
    });
  }

  function onDragKeyDown(event) {
    if (event.key !== "Escape" || !drag) return;
    // 拖拽中按 Esc 只收尾，不关弹窗（否则弹窗先没了，pointerup 收不到）。
    event.preventDefault();
    event.stopPropagation();
    onDragEnd(event);
  }

  function onDragEnd(event) {
    const state = drag;
    if (!state) return;
    drag = null;
    if (state.frame) win.cancelAnimationFrame(state.frame);
    if (state.detached && state.latest) {
      const next = resizeRect(state.origin, state.latest, state.dir, limits());
      state.lastRect = next;
      applyRect(next);
    }
    try {
      state.handle.releasePointerCapture?.(state.pointerId);
    } catch {
      /* 指针已经释放过 */
    }
    win.removeEventListener("pointermove", onDragMove, true);
    win.removeEventListener("pointerup", onDragEnd, true);
    win.removeEventListener("pointercancel", onDragEnd, true);
    win.removeEventListener("blur", onDragEnd, true);
    win.removeEventListener("keydown", onDragKeyDown, true);
    doc.documentElement.style.userSelect = state.previousUserSelect ?? "";
    doc.documentElement.style.cursor = "";
    freezeFrames(false, state.frozenFrames);
    target.classList.remove("kb-resizing");
    delete target.dataset.kbResizing;
    place();
    const size = state.lastRect ?? target.getBoundingClientRect();
    if (state.moved) writeStoredSize(storageKey, { width: size.width, height: size.height }, storage);
    if (state.moved) guardClick();
    if (!target.isConnected) destroy();
  }

  function onWindowResize() {
    if (destroyed) return;
    if (!target.isConnected) {
      destroy();
      return;
    }
    if (!target.classList.contains("kb-sized")) {
      place();
      return;
    }
    const rect = target.getBoundingClientRect();
    const fitted = fitRect(rect, limits());
    if (target.style.position === "fixed") applyRect(fitted);
    else {
      target.style.width = `${fitted.width}px`;
      target.style.height = `${fitted.height}px`;
    }
    place();
  }

  // 弹窗尺寸可能被内部内容撑变（加载完 iframe 等），把手跟着走。
  const observer = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(() => place()) : null;
  try {
    observer?.observe(target);
  } catch {
    /* 老浏览器忽略 */
  }
  win.addEventListener("resize", onWindowResize);
  place();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (drag) {
      const state = drag;
      drag = null;
      if (state.frame) win.cancelAnimationFrame(state.frame);
      win.removeEventListener("pointermove", onDragMove, true);
      win.removeEventListener("pointerup", onDragEnd, true);
      win.removeEventListener("pointercancel", onDragEnd, true);
      win.removeEventListener("blur", onDragEnd, true);
      win.removeEventListener("keydown", onDragKeyDown, true);
      doc.documentElement.style.userSelect = state.previousUserSelect ?? "";
      doc.documentElement.style.cursor = "";
      freezeFrames(false, state.frozenFrames);
    }
    win.removeEventListener("resize", onWindowResize);
    dropClickGuard();
    observer?.disconnect();
    for (const handle of handleList.splice(0)) handle.remove();
    target.classList.remove("kb-resizable", "kb-resizing");
    delete target.dataset.kbResizing;
  }

  return { destroy };
}
