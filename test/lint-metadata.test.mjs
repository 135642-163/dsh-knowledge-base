/**
 * 0.26 lint：结构化标准号/正文完整性/正文指纹/文件名与封面不一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lintManifest } from "../lib/lint.js";

const NOW = Date.parse("2026-10-25T00:00:00.000Z");
function doc(patch = {}) {
  return {
    id: "d1", title: "GB/T 1-2020 标准", type: "pdf-text", status: "ready",
    trust: "medium", sourceHash: "h1", chars: 1200, parts: 1,
    ...patch,
  };
}
function report(docs) {
  return lintManifest({ schemaVersion: 6, name: "库", docs }, { kbName: "库", hasSchema: true, now: NOW });
}
function group(result, code) {
  return result.groups.find((item) => item.code === code);
}

test("metadata-missing reports old docs without sourceHash/structured standard", () => {
  const result = report([
    doc({ id: "a", title: "GB/T 1-2020 标准", sourceHash: "", standardNo: "" }),
    doc({ id: "b", title: "普通资料", sourceHash: "h2", standardNo: "" }),
  ]);
  const g = group(result, "metadata-missing");
  assert.ok(g);
  assert.equal(g.count, 1);
  assert.match(g.items[0].detail, /sourceHash/);
});

test("duplicate-text groups identical textHash", () => {
  const result = report([
    doc({ id: "a", textHash: "same" }),
    doc({ id: "b", textHash: "same", title: "GB/T 2-2020" }),
  ]);
  const g = group(result, "duplicate-text");
  assert.ok(g);
  assert.equal(g.count, 1);
  assert.match(g.items[0].detail, /同一正文/);
});

test("same-number-family reports GB vs GB/T variants", () => {
  const result = report([
    doc({ id: "a", title: "GB 19963.2-2024", standardNo: "GB 19963.2-2024", standardPrefix: "GB",
      standardBase: "19963", standardNumber: "19963.2", standardYear: 2024, standardPart: "2", stage: "published" }),
    doc({ id: "b", title: "GB/T 19963.2-2024", standardNo: "GB/T 19963.2-2024", standardPrefix: "GB/T",
      standardBase: "19963", standardNumber: "19963.2", standardYear: 2024, standardPart: "2", stage: "published" }),
  ]);
  assert.equal(group(result, "same-number-family").count, 1);
});

test("content-incomplete and filename mismatch are reported", () => {
  const result = report([
    doc({ id: "a", title: "GB/T 19963.2-2024 风电场", standardNo: "GB/T 19963.2-2024",
      standardPrefix: "GB/T", standardBase: "19963", standardYear: 2024, standardPart: "2",
      stage: "published", standardSource: "content", filenameStandardNo: "GB 19963.3-2024",
      contentIntegrity: "cover-only" }),
  ]);
  assert.equal(group(result, "filename-standard-mismatch").count, 1);
  assert.equal(group(result, "content-incomplete").count, 1);
  assert.equal(result.counts.contentIncomplete, 1);
});

test("structured standard fields win over title; same stage/year is still duplicate", () => {
  const result = report([
    doc({ id: "a", title: "标准甲", standardNo: "GB/T 9-2020", standardPrefix: "GB/T",
      standardBase: "9", standardYear: 2020, standardPart: null, stage: "published" }),
    doc({ id: "b", title: "标准乙", standardNo: "GB/T 9-2020", standardPrefix: "GB/T",
      standardBase: "9", standardYear: 2020, standardPart: null, stage: "published" }),
  ]);
  assert.equal(group(result, "same-number").count, 1);
  assert.equal(result.counts.sameNumberDuplicateGroups, 1);
});

test("different stages/years/parts are not duplicates", () => {
  const result = report([
    doc({ id: "a", title: "GB/T 9-2020", standardNo: "GB/T 9-2020", standardPrefix: "GB/T",
      standardBase: "9", standardYear: 2020, standardPart: null, stage: "published" }),
    doc({ id: "b", title: "GB/T 9-2020 报批稿", standardNo: "GB/T 9-2020", standardPrefix: "GB/T",
      standardBase: "9", standardYear: 2020, standardPart: null, stage: "draft" }),
    doc({ id: "c", title: "GB/T 9-2024", standardNo: "GB/T 9-2024", standardPrefix: "GB/T",
      standardBase: "9", standardYear: 2024, standardPart: null, stage: "published" }),
    doc({ id: "d", title: "GB/T 9.1-2020", standardNo: "GB/T 9.1-2020", standardPrefix: "GB/T",
      standardBase: "9", standardYear: 2020, standardPart: "1", stage: "published" }),
  ]);
  assert.equal(result.counts.sameNumberDuplicateGroups, 0);
  assert.equal(result.counts.sameNumberStageGroups, 1);
  assert.equal(result.counts.sameNumberMultiYearGroups, 1);
});
