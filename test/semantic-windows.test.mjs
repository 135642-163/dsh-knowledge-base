import test from "node:test";
import assert from "node:assert/strict";
import { splitMarkdownWindows } from "../lib/semantic-windows.js";

const md = `# 文档\n\n### 第 1 页\n\n第一页正文。\n\n### 第 2 页\n\n${"中段内容。".repeat(80)}\n\n### 第 3 页\n\n第三页结论。\n`;

test("窗口覆盖开头/中段/结尾并带页码", () => {
  const windows = splitMarkdownWindows(md, { maxWindows: 4, windowChars: 120, prefix: "GB/T 1-2020 文档" });
  assert.equal(windows.length, 4);
  assert.match(windows[0].text, /GB\/T 1-2020 文档/);
  assert.equal(windows[0].pageStart, 1);
  assert.equal(windows[windows.length - 1].pageStart, 3);
  assert.match(windows[windows.length - 1].text, /第三页结论/);
  assert.ok(windows.some((window) => window.pageStart === 2));
});

test("窗口不超过 windowChars+prefix；只有一页时也可以工作", () => {
  const windows = splitMarkdownWindows("### 第 1 页\n\n短正文。", { maxWindows: 8, windowChars: 50, prefix: "标题" });
  assert.equal(windows.length, 1);
  assert.match(windows[0].text, /短正文/);
});

test("空文档返回空数组", () => {
  assert.deepEqual(splitMarkdownWindows(""), []);
});
