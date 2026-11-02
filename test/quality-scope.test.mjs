/**
 * 质量口径（0.39）：短公文不再算"正文不完整"，已 OCR 修复的坏页不再算质量问题。
 * 这里锁住判定边界，避免以后调整 lint 时把两类噪声又放回质量队列。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { countsAsIncomplete } from "../lib/quality-scope.js";
import { lintManifest } from "../lib/lint.js";
import { countQualityFlags } from "../lib/quality.js";

function doc(id, patch = {}) {
  return {
    id,
    title: patch.title ?? `资料 ${id}`,
    type: "pdf-text",
    status: "ready",
    pages: 10,
    chars: 3000,
    parts: 1,
    version: 1,
    sourceHash: `hash-${id}`,
    textHash: `text-${id}`,
    parserVersion: "test",
    summary: `这是 ${id} 的一行摘要，用来占位并保证长度足够，不会被当成空摘要或噪声摘要处理。`,
    trust: "medium",
    standardNo: "",
    standardSource: "none",
    contentIntegrity: "full",
    bodyChars: 3000,
    clauseCount: 5,
    stage: "published",
    ...patch,
  };
}

test("cover-only 任何资料都算不完整", () => {
  assert.equal(countsAsIncomplete(doc("a", { contentIntegrity: "cover-only", pages: 1 })), true);
  assert.equal(
    countsAsIncomplete(doc("a2", { contentIntegrity: "cover-only", stage: "notes" })),
    true
  );
});

test("partial 只在标准类资料上计入：有标准号、非说明材料、至少 5 页", () => {
  const std = doc("b", {
    title: "GB/T 11024.4-2001 标称电压1kV以上交流电力系统用并联电容器",
    standardNo: "GB/T 11024.4-2001",
    contentIntegrity: "partial",
    pages: 20,
  });
  assert.equal(countsAsIncomplete(std), true);

  assert.equal(
    countsAsIncomplete({ ...std, pages: 3 }),
    false,
    "1–4 页的修改单/短文不判缺页"
  );
  assert.equal(
    countsAsIncomplete({ ...std, stage: "notes" }),
    false,
    "编制说明等过程稿短是正常的"
  );
  assert.equal(
    countsAsIncomplete(doc("c", { contentIntegrity: "partial", pages: 20 })),
    false,
    "没有标准号的公文/文章不判缺页"
  );
});

test("lint 与徽标同一口径：短公文不进质量队列", () => {
  const manifest = {
    name: "口径库",
    docs: [
      // 通知：完整但短，partial 是规则副产物
      doc("notice", {
        title: "关于开展电能质量检查的通知",
        pages: 3,
        chars: 800,
        bodyChars: 700,
        clauseCount: 0,
        contentIntegrity: "partial",
      }),
      // 标准：20 页却只解析出封面范围，是真残缺
      doc("std", {
        title: "GB/T 19963.2-2024 风电场接入电力系统技术规定",
        standardNo: "GB/T 19963.2-2024",
        pages: 20,
        chars: 900,
        bodyChars: 800,
        clauseCount: 0,
        contentIntegrity: "partial",
      }),
    ],
  };
  const report = lintManifest(manifest, { kbName: "口径库", hasSchema: true, maxItems: 20 });
  const group = report.groups.find((g) => g.code === "content-incomplete");
  assert.ok(group, "标准那篇仍要报");
  assert.deepEqual(group.items.map((item) => item.docId), ["std"]);
  assert.equal(countQualityFlags(manifest.docs).contentIncomplete, 1);
});

test("已 OCR 修复的坏页只记 repairedPages，不计入质量数", () => {
  const docs = [
    doc("fixed", {
      corruptedPages: [],
      repairedPages: [2, 3],
      contentSource: "ocr",
      ocrPages: 5,
      ocrConfidence: 92,
    }),
  ];
  assert.equal(countQualityFlags(docs).corruptedDocs, 0);
});
