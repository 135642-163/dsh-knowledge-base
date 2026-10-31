/**
 * OCR 前水印净化：浅灰水印被洗掉、正文保留、干净页/低对比页不动。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { preprocessPixmap, removeWatermarkPixels } from "../lib/watermark.js";

function makePage(width, height) {
  const components = 3;
  const stride = width * components;
  const samples = new Uint8ClampedArray(stride * height).fill(255);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = y * stride + x * components;
    samples[offset] = r;
    samples[offset + 1] = g;
    samples[offset + 2] = b;
  };
  const get = (x, y) => {
    const offset = y * stride + x * components;
    return [samples[offset], samples[offset + 1], samples[offset + 2]];
  };
  return { width, height, stride, components, samples, set, get };
}

/** 模拟正文：若干条黑色横线。 */
function drawText(page) {
  for (let line = 0; line < 6; line += 1) {
    const y = 20 + line * 28;
    for (let yy = y; yy < y + 8; yy += 1) {
      for (let x = 20; x < page.width - 20; x += 1) page.set(x, yy, 10, 10, 10);
    }
  }
}

/** 模拟浅灰水印：斜向粗线，穿过正文与空白。 */
function drawWatermark(page, color = [205, 205, 205]) {
  for (let x = 0; x < page.width; x += 1) {
    const y = Math.round(20 + x * 0.5);
    for (let d = -2; d <= 2; d += 1) page.set(x, y + d, ...color);
  }
}

test("auto：洗掉远离正文的浅灰水印，正文保持深色", () => {
  const page = makePage(320, 220);
  drawText(page);
  drawWatermark(page);
  const before = page.get(100, 70); // 两行正文之间的空白水印
  assert.deepEqual(before, [205, 205, 205]);
  const result = removeWatermarkPixels(page.samples, page);
  assert.equal(result.changed, true);
  assert.ok(result.removed > 100);
  assert.ok(result.threshold > 150 && result.threshold < 240);
  assert.deepEqual(page.get(100, 70), [255, 255, 255], "watermark on blank paper must be removed");
  assert.deepEqual(page.get(30, 25), [10, 10, 10], "text core must stay");
});

test("干净页不产生改动", () => {
  const page = makePage(320, 220);
  drawText(page);
  const result = removeWatermarkPixels(page.samples, page);
  assert.equal(result.changed, false);
  assert.equal(result.removed, 0);
});

test("off 模式不处理", () => {
  const page = makePage(320, 220);
  drawText(page);
  drawWatermark(page);
  const result = removeWatermarkPixels(page.samples, { ...page, mode: "off" });
  assert.equal(result.changed, false);
  assert.deepEqual(page.get(100, 70), [205, 205, 205]);
});

test("strong：连压在正文边缘的浅灰也洗掉", () => {
  const page = makePage(320, 220);
  drawText(page);
  // 在正文横线上方 1px 画一条水印，auto 因邻域保护会保留，strong 会洗掉
  for (let x = 20; x < 300; x += 1) page.set(x, 16, 200, 200, 200);
  const autoPage = makePage(320, 220);
  drawText(autoPage);
  for (let x = 20; x < 300; x += 1) autoPage.set(x, 16, 200, 200, 200);
  const auto = removeWatermarkPixels(autoPage.samples, autoPage);
  assert.equal(auto.changed, false, "auto should not touch watermark adjacent to text");
  const strong = removeWatermarkPixels(page.samples, { ...page, mode: "strong" });
  assert.equal(strong.changed, true);
  assert.deepEqual(page.get(100, 16), [255, 255, 255]);
  assert.deepEqual(page.get(30, 25), [10, 10, 10], "text core survives strong mode");
});

test("低对比扫描（纸灰字浅）不做净化", () => {
  const page = makePage(200, 120);
  for (let y = 0; y < page.height; y += 1) {
    for (let x = 0; x < page.width; x += 1) page.set(x, y, 180, 180, 180);
  }
  for (let y = 40; y < 50; y += 1) {
    for (let x = 20; x < 180; x += 1) page.set(x, y, 150, 150, 150);
  }
  const result = removeWatermarkPixels(page.samples, page);
  assert.equal(result.changed, false);
});

test("彩色浅水印也能处理（按亮度判定）", () => {
  const page = makePage(300, 200);
  drawText(page);
  drawWatermark(page, [190, 205, 235]);
  const result = removeWatermarkPixels(page.samples, page);
  assert.equal(result.changed, true);
  assert.deepEqual(page.get(100, 70), [255, 255, 255]);
});

test("preprocessPixmap 读取 stride/components 并原地改像素", () => {
  const page = makePage(260, 180);
  drawText(page);
  drawWatermark(page);
  const pixmap = {
    getWidth: () => page.width,
    getHeight: () => page.height,
    getStride: () => page.stride,
    getNumberOfComponents: () => page.components,
    getPixels: () => page.samples,
  };
  const result = preprocessPixmap(pixmap, { mode: "auto" });
  assert.equal(result.changed, true);
  assert.deepEqual(page.get(100, 70), [255, 255, 255]);
});
