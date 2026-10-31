/**
 * 资料弹窗编目：纯函数与可编辑字段渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DOC_TRUST_LEVELS, docMetaPatch, docMetaUnchanged, normalizeDocSummary, normalizeDocTitleInput,
  normalizeStandardNoInput, normalizeDocTrust, parseDocTagsInput, summarySourceLabel, trustLevelLabel,
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

test("docMetaUnchanged 比较归一化后的标题、摘要、标签、标准号与可信度", () => {
  const doc = { title: "风电场接入", summary: "摘要", tags: ["a", "b"], standardNo: "GB/T 1-2020", trust: "high" };
  assert.equal(docMetaUnchanged(doc, { title: " 风电场接入 ", summary: " 摘要 ", tags: "a,b", standardNo: " GB/T 1-2020 " }), true);
  assert.equal(normalizeStandardNoInput("  GB/T 1-2020 "), "GB/T 1-2020");
  assert.equal(docMetaUnchanged(doc, { title: "风电场接入", summary: "摘要", tags: "a,b", standardNo: "" }), false);
  assert.equal(docMetaUnchanged(doc, { title: "海上风电", summary: "摘要", tags: "a,b" }), false);
  assert.equal(docMetaUnchanged(doc, { title: "风电场接入", summary: "别的", tags: "a,b" }), false);
  assert.equal(docMetaUnchanged(doc, { title: "风电场接入", summary: "摘要", tags: "a,c" }), false);
  assert.equal(docMetaUnchanged(doc, { title: "风电场接入", summary: "摘要", tags: "a,b", trust: "high" }), true);
  assert.equal(docMetaUnchanged(doc, { title: "风电场接入", summary: "摘要", tags: "a,b", trust: "low" }), false);
  assert.equal(normalizeDocTrust(" HIGH "), "high");
  assert.equal(normalizeDocTrust("bogus"), "unknown");
  assert.deepEqual(DOC_TRUST_LEVELS, ["high", "medium", "low", "unknown"]);
  assert.match(trustLevelLabel("high"), /现行/);
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
  assert.match(html, /name="doc-standard-no"/);
  assert.match(html, /name="doc-trust"/);
  assert.match(html, /来源：人工/);
  assert.match(html, /保存名称\/摘要\/标签\/标准号\/可信度/);
  assert.match(html, /摘要 &lt;x&gt;/);
  assert.match(html, /value="并网, 海上风电"/);
});

test("标准号输入框可编辑并显示当前值", () => {
  const html = renderDocModalBody({ name: "标准", id: "d1", doc: {
    title: "标准编写规则", type: "pdf-scanned", status: "ready",
    standardNo: "GB/T 20001.10-2014", stageLabel: "发布稿", summary: "", tags: [],
  }});
  assert.match(html, /name="doc-standard-no"[^>]*value="GB\/T 20001.10-2014"/);
  assert.doesNotMatch(html, /<span>标准号<\/span><strong>/, "编辑态不再重复只读标准号");
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
