/**
 * 去重索引：sourceHash / std / std-family / title；§6.4.1 正文完整性矩阵。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildDedupIndex, decideDuplicate, matchCandidate } from "../lib/dedup-index.js";

function doc(patch = {}) {
  return {
    kb: "标准",
    dir: "标准",
    id: "a1",
    title: "GB/T 19963.2-2024 风电场接入电力系统技术规定 第2部分",
    status: "ready",
    type: "pdf-text",
    sourceHash: "",
    textHash: "",
    standardNo: "GB/T 19963.2-2024",
    standardPrefix: "GB/T",
    standardNumber: "19963.2",
    standardBase: "19963",
    standardYear: 2024,
    standardPart: "2",
    stage: "published",
    contentIntegrity: "full",
    ...patch,
  };
}

function indexOf(docs, targetKb = "标准") {
  return buildDedupIndex(docs, { targetKb });
}

function cand(patch = {}) {
  return {
    docId: "new",
    title: "GB/T 19963.2-2024 风电场接入电力系统技术规定 第2部分",
    standardNo: "GB/T 19963.2-2024",
    standardPrefix: "GB/T",
    standardNumber: "19963.2",
    standardBase: "19963",
    standardYear: 2024,
    standardPart: "2",
    stage: "published",
    contentIntegrity: "full",
    ...patch,
  };
}

test("source hash match skips even when titles differ", () => {
  const index = indexOf([doc({ sourceHash: "h1" })]);
  const hits = matchCandidate(index, cand({ sourceHash: "h1", title: "另一个标题" }));
  assert.equal(hits[0].kind, "source-hash");
  const decision = decideDuplicate(hits, cand({ sourceHash: "h1", title: "另一个标题" }));
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "duplicate");
});

test("std match catches GB vs GB/T when content standard is GB/T", () => {
  const index = indexOf([doc()]);
  const hits = matchCandidate(index, cand({ title: "GB 19963.2-2024" }));
  assert.equal(hits[0].kind, "std");
  assert.equal(decideDuplicate(hits, cand()).skip, true);
});

test("same family but different stage is not a duplicate", () => {
  const index = indexOf([doc()]);
  const hits = matchCandidate(index, cand({ title: "GB/T 19963.2-2024（报批稿）", stage: "draft" }));
  assert.equal(hits.length, 0);
});

test("same number different year/part is not an exact duplicate", () => {
  const index = indexOf([doc()]);
  assert.equal(matchCandidate(index, cand({ standardYear: 2021 })).length, 0);
  assert.equal(matchCandidate(index, cand({ standardPart: "1" })).length, 0);
});

test("std-family catches GB vs GB/T only when content standard is unavailable", () => {
  const index = indexOf([doc({ standardNo: "GB/T 19963.2-2024" })]);
  const hits = matchCandidate(index, cand({
    standardNo: "GB 19963.2-2024", standardPrefix: "GB", standardNumber: "19963.2",
    standardBase: "19963", standardYear: 2024, standardPart: "2", stage: "published",
  }));
  assert.ok(hits.some((hit) => hit.kind === "std-family"));
});

test("full new file can replace an existing cover-only copy", () => {
  const index = indexOf([doc({ contentIntegrity: "cover-only" })]);
  const hits = matchCandidate(index, cand({ contentIntegrity: "full" }));
  const decision = decideDuplicate(hits, cand({ contentIntegrity: "full" }));
  assert.equal(decision.skip, false);
  assert.equal(decision.reasons, undefined);
  assert.equal(decision.reason, "replaces-incomplete");
  assert.equal(decision.replacesIncomplete, true);
});

test("cover-only new file is skipped when an existing full copy exists", () => {
  const index = indexOf([doc({ contentIntegrity: "full" })]);
  const hits = matchCandidate(index, cand({ contentIntegrity: "cover-only" }));
  const decision = decideDuplicate(hits, cand({ contentIntegrity: "cover-only" }));
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "existing-full");
});

test("two incomplete copies are skipped with both-incomplete", () => {
  const index = indexOf([doc({ contentIntegrity: "partial" })]);
  const hits = matchCandidate(index, cand({ contentIntegrity: "cover-only" }));
  const decision = decideDuplicate(hits, cand({ contentIntegrity: "cover-only" }));
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "both-incomplete");
});

test("cross-kb duplicates default to skip and allowCrossKb overrides", () => {
  const index = indexOf([doc({ kb: "其他库", dir: "其他库" })], "标准");
  const hits = matchCandidate(index, cand());
  assert.equal(hits[0].sameKb, false);
  assert.equal(decideDuplicate(hits, cand()).skip, true);
  assert.equal(decideDuplicate(hits, cand(), { allowCrossKb: true }).skip, false);
});

test("same-kb duplicate still skips even when allowCrossKb is true", () => {
  const index = indexOf([doc()]);
  const hits = matchCandidate(index, cand());
  assert.equal(decideDuplicate(hits, cand(), { allowCrossKb: true }).skip, true);
});

test("title exact/prefix only apply without standard number", () => {
  const index = indexOf([doc({
    title: "电能质量管理办法（暂行）", standardNo: "", standardPrefix: "", standardNumber: "",
    standardBase: "", standardYear: null, standardPart: null, stage: "published",
  })]);
  const exact = matchCandidate(index, cand({
    title: "电能质量管理办法（暂行）", standardNo: "", standardPrefix: "", standardNumber: "",
    standardBase: "", standardYear: null, standardPart: null,
  }));
  assert.ok(exact.some((hit) => hit.kind === "title-exact"));
  const near = matchCandidate(index, cand({
    title: "电能质量管理办法（暂行）补充规定", standardNo: "", standardPrefix: "", standardNumber: "",
    standardBase: "", standardYear: null, standardPart: null,
  }));
  assert.ok(near.some((hit) => hit.kind === "title-prefix"));
  assert.equal(decideDuplicate(near, cand({ title: "电能质量管理办法（暂行）补充规定", standardNo: "" })).skip, false);
});

test("buildDedupIndex ignores notes, deleted and non-ready docs", () => {
  const index = indexOf([
    doc({ id: "note", type: "note" }),
    doc({ id: "deleted", status: "deleted" }),
    doc({ id: "failed", status: "failed" }),
  ]);
  assert.equal(index.byStdKey.size, 0);
});
