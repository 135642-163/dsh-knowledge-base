/**
 * 0.12.0 双栏 PDF：行首聚类 + 通栏分隔 + 左栏/右栏阅读顺序。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { orderPageLines } from "../lib/parsers.js";

const line = (text, x, y, w, extra = {}) => ({
  text,
  x,
  y,
  w,
  gap: 0,
  size: 10,
  ...extra,
});

function twoColumnPage() {
  const lines = [
    line("文章标题", 50, 40, 500),
    line("左栏第一行", 50, 100, 220),
    line("右栏第一行", 340, 100, 220),
    line("左栏第二行", 50, 130, 220),
    line("右栏第二行", 340, 130, 220),
    line("左栏第三行", 50, 160, 220),
    line("右栏第三行", 340, 160, 220),
    line("左栏第四行", 50, 190, 220),
    line("右栏第四行", 340, 190, 220),
    line("页码 1", 50, 760, 500),
  ];
  return { lines, width: 600, height: 800 };
}

test("two-column page is reordered left column then right column", () => {
  const r = orderPageLines(twoColumnPage());
  assert.equal(r.columns, true);
  assert.deepEqual(
    r.lines.map((l) => l.text),
    [
      "文章标题",
      "左栏第一行",
      "左栏第二行",
      "左栏第三行",
      "左栏第四行",
      "右栏第一行",
      "右栏第二行",
      "右栏第三行",
      "右栏第四行",
      "页码 1",
    ]
  );
});

test("single-column page is untouched", () => {
  const page = {
    lines: Array.from({ length: 10 }, (_, i) =>
      line(`单栏第${i + 1}行`, 60, 100 + i * 20, 300)
    ),
    width: 600,
    height: 800,
  };
  const r = orderPageLines(page);
  assert.equal(r.columns, false);
  assert.deepEqual(
    r.lines.map((l) => l.text),
    page.lines.map((l) => l.text)
  );
});

test("table-like pages with many large gaps are not treated as columns", () => {
  const page = {
    lines: [
      line("设备", 50, 100, 100, { gap: 40 }),
      line("电压", 300, 100, 100, { gap: 40 }),
      line("海缆", 50, 130, 100, { gap: 40 }),
      line("220", 300, 130, 100, { gap: 40 }),
      line("左栏说明一", 50, 160, 200),
      line("右栏说明一", 340, 160, 200),
      line("左栏说明二", 50, 190, 200),
      line("右栏说明二", 340, 190, 200),
      line("左栏说明三", 50, 220, 200),
      line("右栏说明三", 340, 220, 200),
    ],
    width: 600,
    height: 800,
  };
  const r = orderPageLines(page);
  assert.equal(r.columns, false);
  assert.deepEqual(
    r.lines.map((l) => l.text),
    page.lines.map((l) => l.text)
  );
});
