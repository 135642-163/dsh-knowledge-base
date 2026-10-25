/**
 * 资料弹窗编目：纯函数与可编辑字段渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  docMetaPatch, docMetaUnchanged, normalizeDocSummary, normalizeDocTitleInput,
  parseDocTagsInput, summarySourceLabel,
} from "../ui/views/doc-meta.js";
import { renderDocModalBody } from "../ui/views/modals.js";

test("normalizeDocSummary 折叠空白并截断 500 字", () => {
  assert.equal(normalizeDocSummary("  人 工\n摘要  "), "人 工 摘要");
  assert.equal(normalizeDocSummary("x".repeat(600)).length, 500);
  assert.equal(normalizeDocSummary(null), "");
});

test("parseDocTagsInput 去 #、去重、限长、最多 20 个", () => {
  assert.deepEqual(parseDocTagsInput("#并网, 海上风电，并网"), ["并网", "海上风电"]);
  assert.deepEqual(parseDocTagsInput(["  ", "a".repeat(40), "正常"]), ["正常"]);
  assert.equal(parseDocTagsInput(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 20);
});

test("summarySourceLabel 与 docMetaPatch", () => {
  assert.equal(summarySourceLabel("manual"), "人工");
  assert.equal(summarySourceLabel("model"), "模型");
  assert.equal(summarySourceLabel(""), "未编目");
  assert.deepEqual(docMetaPatch({ summary: " 摘要 ", tags: "#a,b" }), { summary: "摘要", tags: ["a", "b"] });
});

test("docMetaUnchanged 比较归一化后的标题、摘要与标签", () => {
  const doc = { title: "风电场接入", summary: "摘要", tags: ["a", "b"] };
  assert.equal(docMetaUnchanged(doc, { title: " 风电场接入 ", summary: " 摘要 ", tags: "a,b" }), true);
  assert.equal(docMetaUnchanged(doc, { title: "海上风电", summary: "摘要", tags: "a,b" }), false);
  assert.equal(docMetaUnchanged(doc, { title: "风电场接入", summary: "别的", tags: "a,b" }), false);
  assert.equal(docMetaUnchanged(doc, { title: "风电场接入", summary: "摘要", tags: "a,c" }), false);
  assert.equal(normalizeDocTitleInput("  风电场  接入 "), "风电场 接入");
  assert.deepEqual(docMetaPatch({ title: "  新  名称 ", summary: " 摘要 ", tags: "#a,b" }), { title: "新 名称", summary: "摘要", tags: ["a", "b"] });
});

test("弹窗渲染可编辑摘要/标签与来源徽标", () => {
  const html = renderDocModalBody({ name: "标准", id: "d1", doc: {
    title: "风电场接入", type: "pdf-text", pages: 3, chars: 100, trust: "medium",
    summary: "摘要 <x>", summarySource: "manual", tags: ["并网", "海上风电"],
  }});
  assert.match(html, /name="doc-summary"/);
  assert.match(html, /name="doc-title"/);
  assert.match(html, /name="doc-tags"/);
  assert.match(html, /来源：人工/);
  assert.match(html, /保存名称\/摘要\/标签/);
  assert.match(html, /摘要 &lt;x&gt;/);
  assert.match(html, /value="并网, 海上风电"/);
});

test("已删除/导入中弹窗不渲染编辑器", () => {
  const deleted = renderDocModalBody({ name: "标准", id: "d1", doc: {
    title: "T", status: "deleted", deleted: true, summary: "S", tags: ["a"],
  }});
  assert.doesNotMatch(deleted, /name="doc-summary"/);
  assert.doesNotMatch(deleted, /name="doc-title"/);
  assert.match(deleted, /恢复后才能编辑/);
  const importing = renderDocModalBody({ name: "标准", id: "d1", doc: {
    title: "T", status: "importing", summary: "", tags: [],
  }});
  assert.doesNotMatch(importing, /name="doc-summary"/);
  assert.match(importing, /解析完成后才能编辑/);
});
