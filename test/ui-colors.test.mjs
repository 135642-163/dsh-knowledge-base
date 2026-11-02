import test from "node:test";
import assert from "node:assert/strict";
import { KB_COLORS, colorFor } from "../ui/colors.js";

function luminance(hex) {
  const [r, g, b] = hex.slice(1).match(/../g)
    .map((part) => parseInt(part, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function saturation(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return 0;
  return (max - min) / (1 - Math.abs(2 * lightness - 1));
}

test("同一名称颜色稳定，且只返回色板中的颜色", () => {
  assert.equal(colorFor("标准"), colorFor("标准"));
  assert.ok(KB_COLORS.includes(colorFor("标准")));
  assert.match(colorFor("标准"), /^#[0-9a-f]{6}$/);
});

test("空名称也有稳定颜色", () => {
  assert.ok(KB_COLORS.includes(colorFor("")));
  assert.equal(colorFor(""), colorFor(""));
});

test("色板保持高明度、高饱和，避免发灰发脏", () => {
  for (const color of KB_COLORS) {
    const level = luminance(color);
    assert.ok(level > 0.25, `${color} 相对亮度 ${level.toFixed(3)} 偏低`);
    assert.ok(saturation(color) >= 0.55, `${color} 饱和度不足，容易发灰`);
  }
});

test("大量名称不会全撞到同一个颜色", () => {
  const names = Array.from({ length: 64 }, (_, index) => `知识库-${index}`);
  const colors = new Set(names.map((name) => colorFor(name)));
  assert.ok(colors.size >= 12, `64 个名称只分到 ${colors.size} 种颜色`);
});
