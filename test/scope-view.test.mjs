/**
 * 范围纯函数：chip 文案、提示文本、选择合并。服务端与客户端共用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chipLabel, DISABLED_PROMPT_TEXT, isAllSelection, scopePromptText, selectionPayload } from "../lib/scope-view.js";

const DISABLED_LINE =
  "[知识库范围] 本会话未启用知识库：不要调用 kb_* 工具，也不要检索知识库；用户需要时提示其在输入框旁的知识库选择器中选择库或「全部」。";

test("chipLabel covers all/selected/none/loading/failed", () => {
  assert.equal(chipLabel({ mode: "all", kbs: [] }), "知识库：全部");
  assert.equal(chipLabel({ mode: "selected", kbs: ["A", "B"] }), "知识库：2 个");
  assert.equal(chipLabel({ mode: "selected", kbs: [] }), "知识库：未启用");
  assert.equal(chipLabel({ mode: "none", kbs: [] }), "知识库：未启用");
  assert.equal(chipLabel(null), "知识库：…");
  assert.equal(chipLabel({ mode: "all", kbs: [] }, { failed: true }), "知识库：—");
  assert.equal(chipLabel({ mode: "none", kbs: [] }, { failed: true }), "知识库：—");
  assert.equal(chipLabel(null, { loading: true }), "知识库：…");
});

test("scopePromptText is empty for all mode", () => {
  assert.equal(scopePromptText({ mode: "all", kbs: [] }), "");
  assert.equal(scopePromptText(null), "");
});

test("scopePromptText injects exactly the disabled line in none mode", () => {
  assert.equal(scopePromptText({ mode: "none", kbs: [] }), DISABLED_LINE);
  assert.equal(DISABLED_PROMPT_TEXT, DISABLED_LINE);
  const text = scopePromptText({ mode: "none", kbs: [] });
  assert.doesNotMatch(text, /本会话用户选定/);
  assert.doesNotMatch(text, /未限定|可使用全部/);
  assert.doesNotMatch(text, /\{\{|\}\}/);
});

test("scopePromptText treats empty selected as disabled too", () => {
  assert.equal(scopePromptText({ mode: "selected", kbs: [] }), DISABLED_LINE);
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

test("selectionPayload maps full/empty/partial selections", () => {
  assert.deepEqual(selectionPayload(["A", "B"], ["A", "B"]), { mode: "all", kbs: [] });
  assert.deepEqual(selectionPayload([], ["A", "B"]), { mode: "none", kbs: [] });
  assert.deepEqual(selectionPayload([], []), { mode: "none", kbs: [] }, "empty list means none, never all");
  assert.deepEqual(selectionPayload(["A"], ["A", "B"]), { mode: "selected", kbs: ["A"] });
  assert.deepEqual(selectionPayload(["B", "A"], ["A", "B", "C"], ["A", "B", "C"]), { mode: "selected", kbs: ["A", "B"] });
});

test("isAllSelection ignores order and duplicates", () => {
  assert.equal(isAllSelection(["A", "B"], ["B", "A"]), true);
  assert.equal(isAllSelection(["A"], ["A", "B"]), false);
  assert.equal(isAllSelection([], []), true);
});
