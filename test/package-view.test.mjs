/**
 * 工作台 kbpack 弹窗：预检摘要纯函数与模式文案。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PACKAGE_MODAL_MODE_LABELS, packageSummaryHtml } from "../ui/views/package.js";

test("packageSummaryHtml 显示包名/篇数/体积并转义", () => {
  const html = packageSummaryHtml({
    package: { filename: "<script>.zip", kbName: "标准", docs: 913, withSources: true, bytes: 58 * 1024 * 1024 },
    needsChoice: true,
  });
  assert.match(html, /&lt;script&gt;\.zip/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /标准/);
  assert.match(html, /913/);
  assert.match(html, /含原件/);
  assert.match(html, /58 MB/);
  assert.doesNotMatch(html, /预检：/);
});

test("packageSummaryHtml 预检计数", () => {
  const html = packageSummaryHtml({
    package: { filename: "p.zip", kbName: "库", docs: 2, withSources: false, bytes: 1024 },
    created: 1,
    replaced: 0,
    remapped: 1,
    skipped: 0,
  });
  assert.match(html, /仅正文/);
  assert.match(html, /新建 1/);
  assert.match(html, /重映射 1/);
});

test("导入模式文案齐全", () => {
  assert.equal(PACKAGE_MODAL_MODE_LABELS.merge, "合并到同名知识库");
  assert.equal(PACKAGE_MODAL_MODE_LABELS.rename, "另存为新知识库");
  assert.equal(PACKAGE_MODAL_MODE_LABELS.replace, "覆盖同 id 文档");
});
