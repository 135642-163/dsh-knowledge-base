/**
 * 范围纯函数：chip 文案、提示文本、选择合并。服务端与客户端共用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chipLabel, isAllSelection, scopePromptText, selectionPayload } from "../lib/scope-view.js";

test("chipLabel covers all/selected/loading/failed", () => {
  assert.equal(chipLabel({ mode: "all", kbs: [] }), "知识库：全部");
  assert.equal(chipLabel({ mode: "selected", kbs: ["A", "B"] }), "知识库：2 个");
  assert.equal(chipLabel({ mode: "selected", kbs: [] }), "知识库：全部");
  assert.equal(chipLabel(null), "知识库：…");
  assert.equal(chipLabel({ mode: "all", kbs: [] }, { failed: true }), "知识库：—");
  assert.equal(chipLabel(null, { loading: true }), "知识库：…");
});

test("scopePromptText is empty for all mode", () => {
  assert.equal(scopePromptText({ mode: "all", kbs: [] }), "");
  assert.equal(scopePromptText(null), "");
});

test("scopePromptText lists selected kbs and tells how to switch", () => {
  const text = scopePromptText({ mode: "selected", kbs: ["标准", "变电试验"] });
  assert.match(text, /^\[知识库范围\] 本会话用户选定：标准、变电试验。/);
  assert.match(text, /在输入框旁的知识库选择器里调整范围/);
});

test("scopePromptText truncates beyond 20 names", () => {
  const kbs = Array.from({ length: 23 }, (_, i) => `库${i + 1}`);
  const text = scopePromptText({ mode: "selected", kbs });
  assert.match(text, /库20。?.*等 23 个/);
  assert.doesNotMatch(text, /库21/);
});

test("scopePromptText neutralizes brace interpolation and drops empty names", () => {
  const text = scopePromptText({ mode: "selected", kbs: ["{{cwd}}", "a{b}c\n库", "\u0000"] });
  assert.doesNotMatch(text, /\{\{|\}\}/);
  assert.doesNotMatch(text, /[\u0000-\u001f\u007f]/);
  assert.match(text, /本会话用户选定：｛｛cwd｝｝、a｛b｝c 库。/);
});

test("selectionPayload collapses all/empty to mode all", () => {
  assert.deepEqual(selectionPayload("all", ["A"]), { mode: "all", kbs: [] });
  assert.deepEqual(selectionPayload("selected", []), { mode: "all", kbs: [] });
  assert.deepEqual(selectionPayload("selected", ["B", "A"], ["A", "B"]), { mode: "selected", kbs: ["A", "B"] });
});

test("isAllSelection ignores order and duplicates", () => {
  assert.equal(isAllSelection(["A", "B"], ["B", "A"]), true);
  assert.equal(isAllSelection(["A"], ["A", "B"]), false);
  assert.equal(isAllSelection([], []), true);
});
