/**
 * 后台导入结果的展示：部分失败不能显示成“完成”。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeImportReport } from "../lib/report.js";

test("all-success report is completed", () => {
  const r = summarizeImportReport({ ok: 3, fail: 0, skip: 1 }, { fileCount: 4, kb: "标准" });
  assert.equal(r.status, "completed");
  assert.match(r.detail, /成功 3/);
  assert.match(r.detail, /跳过 1/);
  assert.doesNotMatch(r.detail, /失败/);
});

test("partial failure is reported as failed", () => {
  const r = summarizeImportReport({ ok: 2, fail: 1, skip: 0 }, { fileCount: 3, kb: "标准" });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /部分失败/);
  assert.match(r.detail, /成功 2/);
  assert.match(r.detail, /失败 1/);
});

test("missing report falls back without inventing counts", () => {
  const r = summarizeImportReport(null, { fileCount: 5, kb: "标准" });
  assert.equal(r.status, "completed");
  assert.match(r.detail, /未取得逐文件统计/);
  assert.equal(r.counts, null);
});
