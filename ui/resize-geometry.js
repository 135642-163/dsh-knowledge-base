/**
 * 弹窗拖拽调大小的纯几何计算：不碰 DOM，便于单测。
 * 坐标一律用视口坐标（与 getBoundingClientRect 一致），单位 px。
 *
 * 约定：
 * - dir 是八向之一：n/s/e/w + ne/nw/se/sw（可组合，如 "ne"）；
 * - 矩形 { left, top, width, height } 表示**边框盒**；
 * - margin 是弹窗与视口四边的最小间距，拖到边上就停住，不会留一条缝。
 */

export const RESIZE_DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export const RESIZE_CURSOR = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

export const DEFAULT_LIMITS = Object.freeze({ minWidth: 360, minHeight: 240, margin: 8 });

/** 数值夹取；min 大于 max（视口比最小尺寸还小）时以 min 为准，保证下限不被击穿。 */
export function clampNumber(value, min, max) {
  const lo = Number.isFinite(min) ? min : -Infinity;
  const hi = Number.isFinite(max) ? max : Infinity;
  if (lo > hi) return lo;
  if (!Number.isFinite(value)) return lo;
  return Math.min(Math.max(value, lo), hi);
}

/**
 * 把矩形收进视口：打开时应用记忆尺寸、窗口缩小后回夹都用它。
 * left/top 缺省时按视口居中。
 */
export function fitRect(rect, options = {}) {
  const { minWidth, minHeight, margin } = { ...DEFAULT_LIMITS, ...options };
  const viewportWidth = Math.max(0, Number(options.viewportWidth) || 0);
  const viewportHeight = Math.max(0, Number(options.viewportHeight) || 0);
  const maxWidth = Math.max(0, viewportWidth - margin * 2);
  const maxHeight = Math.max(0, viewportHeight - margin * 2);
  const width = clampNumber(Number(rect?.width) || 0, Math.min(minWidth, maxWidth), maxWidth);
  const height = clampNumber(Number(rect?.height) || 0, Math.min(minHeight, maxHeight), maxHeight);
  const centeredLeft = (viewportWidth - width) / 2;
  const centeredTop = (viewportHeight - height) / 2;
  const left = clampNumber(
    Number.isFinite(rect?.left) ? rect.left : centeredLeft,
    margin,
    Math.max(margin, viewportWidth - margin - width),
  );
  const top = clampNumber(
    Number.isFinite(rect?.top) ? rect.top : centeredTop,
    margin,
    Math.max(margin, viewportHeight - margin - height),
  );
  return { left: round(left), top: round(top), width: round(width), height: round(height) };
}

/**
 * 一次拖拽增量对应的新矩形：拖哪条边就只改哪条边，对边固定。
 * 视口不够时先保最小尺寸（clampNumber 的 min 优先），再保边距。
 */
export function resizeRect(rect, delta = {}, dir = "", options = {}) {
  const { minWidth, minHeight, margin } = { ...DEFAULT_LIMITS, ...options };
  const viewportWidth = Math.max(0, Number(options.viewportWidth) || 0);
  const viewportHeight = Math.max(0, Number(options.viewportHeight) || 0);
  const start = {
    left: Number(rect?.left) || 0,
    top: Number(rect?.top) || 0,
    width: Math.max(0, Number(rect?.width) || 0),
    height: Math.max(0, Number(rect?.height) || 0),
  };
  const dx = Number(delta?.dx) || 0;
  const dy = Number(delta?.dy) || 0;
  const direction = String(dir ?? "");
  const right = start.left + start.width;
  const bottom = start.top + start.height;

  let width = start.width;
  let height = start.height;
  let left = start.left;
  let top = start.top;

  if (direction.includes("e")) {
    // 右边界最多推到视口右边距；可推进的距离小于最小宽度时以可推进的距离为准。
    const maxWidth = Math.max(0, viewportWidth - margin - start.left);
    width = clampNumber(start.width + dx, Math.min(minWidth, maxWidth), maxWidth);
  } else if (direction.includes("w")) {
    const maxWidth = Math.max(0, right - margin);
    width = clampNumber(start.width - dx, Math.min(minWidth, maxWidth), maxWidth);
    left = right - width;
  }

  if (direction.includes("s")) {
    const maxHeight = Math.max(0, viewportHeight - margin - start.top);
    height = clampNumber(start.height + dy, Math.min(minHeight, maxHeight), maxHeight);
  } else if (direction.includes("n")) {
    const maxHeight = Math.max(0, bottom - margin);
    height = clampNumber(start.height - dy, Math.min(minHeight, maxHeight), maxHeight);
    top = bottom - height;
  }

  return { left: round(left), top: round(top), width: round(width), height: round(height) };
}

function round(value) {
  return Math.round(value * 100) / 100;
}
