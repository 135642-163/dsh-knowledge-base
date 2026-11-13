/**
 * 英文标准摘要：Abstract 抽取、英文「1 Scope」、可用性门槛与版权页噪声过滤。
 * 同时覆盖 importFileInto 的候选顺序（Abstract → 范围 → 正文首段）与「全是噪声就不写摘要」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeEnglishAbstract, summarizeStandardScope, isUsableSummary } from "../lib/wiki.js";
import { looksLikeNoisyAutoSummary } from "../lib/doc-meta.js";
import { importFileInto } from "../lib/pipeline.js";
import { readManifest } from "../lib/store.js";

const CONFIG = { partMaxChars: 4000 };

const ABSTRACT_DOC = [
  "IEEE Std 1124-2003",
  "IEEE Recommended Practice for the Installation and Protection of Equipment",
  "Sponsor",
  "Transmission and Distribution Committee",
  "© 2003 IEEE",
  "Abstract: This recommended practice provides guidance for the installation and protection of equipment used in electric power systems.",
  "Keywords: installation, protection, power systems",
  "1. Scope",
  "This recommended practice applies to the installation and protection of equipment.",
].join("\n");

test("summarizeEnglishAbstract: 行内 Abstract 取到 Keywords 停止", () => {
  const summary = summarizeEnglishAbstract(ABSTRACT_DOC, 500);
  assert.equal(
    summary,
    "This recommended practice provides guidance for the installation and protection of equipment used in electric power systems."
  );
  assert.doesNotMatch(summary, /Keywords|Scope|©|IEEE Std/);
});

test("summarizeEnglishAbstract: 独占一行 Abstract + 跨行正文，遇到 IEEE 版权页脚中断", () => {
  const text = [
    "Abstract",
    "This standard specifies the measurement methods for power quality",
    "parameters in low-voltage distribution systems and their limits.",
    "Authorized licensed use limited to: Tsinghua University. Downloaded on May 01,2020 at 03:00:00 UTC from IEEE Xplore. Restrictions apply.",
    "Index Terms: power quality, measurement, limits",
    "1. Scope",
    "This standard applies to low-voltage distribution systems.",
  ].join("\n");
  assert.equal(
    summarizeEnglishAbstract(text, 500),
    "This standard specifies the measurement methods for power quality parameters in low-voltage distribution systems and their limits."
  );
});

test("summarizeEnglishAbstract: 没有 Abstract 或正文过短时返回空串", () => {
  assert.equal(summarizeEnglishAbstract("No abstract here. Body text goes on for a while.", 500), "");
  assert.equal(summarizeEnglishAbstract("Abstract: Test.", 500), "");
  assert.equal(summarizeEnglishAbstract("", 500), "");
});

test("summarizeEnglishAbstract: 目次里的 Abstract 行不会误命中，后面的真 Abstract 仍能取到", () => {
  const text = [
    "Abstract ..... 5",
    "Foreword ..... 6",
    "1. Scope ..... 7",
    "Abstract: This standard provides requirements for the design and testing of protective relays.",
    "Keywords: relays",
  ].join("\n");
  assert.equal(
    summarizeEnglishAbstract(text, 500),
    "This standard provides requirements for the design and testing of protective relays."
  );
});

test("isUsableSummary: 成句英文/中文可用，碎片与词数不足不可用", () => {
  assert.equal(isUsableSummary("This standard provides requirements for the design and testing of protective relay systems."), true);
  assert.equal(isUsableSummary("本标准规定了公用电网谐波的允许值及其测试方法。"), true);
  assert.equal(isUsableSummary("3 Park Avenue"), false, "短碎片");
  assert.equal(isUsableSummary("This standard provides guidance for equipment"), false, "没有句末标点");
  assert.equal(isUsableSummary("This standard applies to equipment in substations."), false, "英文不足 8 个词");
  assert.equal(isUsableSummary("12345 67890 111213 141516"), false, "纯数字行");
  assert.equal(isUsableSummary(""), false);
});

test("summarizeStandardScope: 英文 1 Scope 跳过版权页且遇到 2 Normative references 停止", () => {
  const text = [
    "1 Scope",
    "Sponsored by the Transmission and Distribution Committee",
    "3 Park Avenue, New York, NY 10016-5997, USA",
    "This standard provides requirements for the installation, testing, and",
    "maintenance of protective relay systems in electric power substations.",
    "2 Normative references",
    "The following documents are referred to in the text.",
  ].join("\n");
  const summary = summarizeStandardScope(text, 300);
  assert.equal(
    summary,
    "This standard provides requirements for the installation, testing, and maintenance of protective relay systems in electric power substations."
  );
  assert.doesNotMatch(summary, /Park Avenue|Normative references/);
});

test("summarizeStandardScope: 英文范围里的页码/水印行被跳过，正文照常拼接", () => {
  const text = [
    "1 Scope",
    "GB688",
    "17",
    "This standard applies to the design and testing of",
    "protective relay systems used in power systems.",
    "2 Normative references",
  ].join("\n");
  assert.equal(
    summarizeStandardScope(text, 300),
    "This standard applies to the design and testing of protective relay systems used in power systems."
  );
});

test("summarizeStandardScope: 只剩版权页或碎片句时不给摘要", () => {
  const frontMatterOnly = [
    "1 Scope",
    "Sponsored by the Committee",
    "3 Park Avenue, New York, NY 10016-5997, USA",
    "2 Normative references",
  ].join("\n");
  assert.equal(summarizeStandardScope(frontMatterOnly, 300), "");
  assert.equal(summarizeStandardScope("1 Scope\nThis standard applies\n2 Normative references", 300), "");
});

test("looksLikeNoisyAutoSummary: 英文封面/版权页与授权水印都算噪声", () => {
  for (const text of [
    "Sponsored by the Transmission and Distribution Committee 3 Park Avenue, New York",
    "FORM DTR 61000-4-30",
    "© 2003 IEEE. All rights reserved.",
    "使用方：某大学 提供机构：图书馆",
    "No part of this publication may be reproduced in any form.",
  ]) {
    assert.equal(looksLikeNoisyAutoSummary(text), true, text);
  }
  assert.equal(
    looksLikeNoisyAutoSummary("This standard provides requirements for the design and testing of protective relay systems."),
    false
  );
});

test("importFileInto: 英文 Abstract 优先于 1 Scope 成为摘要", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-summary-en-"));
  try {
    const src = join(root, "ieee.txt");
    await writeFile(src, ABSTRACT_DOC, "utf8");
    const { docId } = await importFileInto(join(root, "kb"), {
      sourcePath: src, relKey: "ieee.txt", title: "IEEE Std 1124-2003", config: CONFIG,
    });
    const doc = (await readManifest(join(root, "kb"))).docs.find((item) => item.id === docId);
    assert.equal(doc.summarySource, "auto");
    assert.match(doc.summary, /^This recommended practice provides guidance/);
    assert.doesNotMatch(doc.summary, /Scope|Keywords/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("importFileInto: 英文标准（中文标题）也能从 1 Scope 取摘要", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-summary-en-scope-"));
  try {
    const src = join(root, "gb.txt");
    await writeFile(
      src,
      [
        "1 Scope",
        "",
        "This standard provides requirements for the installation, testing, and maintenance of protective relay systems in electric power substations.",
        "",
        "2 Normative references",
        "",
        "The following documents are referred to in the text.",
        "",
      ].join("\n"),
      "utf8"
    );
    const { docId } = await importFileInto(join(root, "kb"), {
      sourcePath: src, relKey: "gb.txt", title: "GB/T 12326-2008 电能质量 电压波动和闪变", config: CONFIG,
    });
    const doc = (await readManifest(join(root, "kb"))).docs.find((item) => item.id === docId);
    assert.equal(doc.summarySource, "auto");
    assert.equal(
      doc.summary,
      "This standard provides requirements for the installation, testing, and maintenance of protective relay systems in electric power substations."
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("importFileInto: 正文全是版权页噪声时不写摘要，summarySource 置空", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-summary-en-noise-"));
  try {
    const src = join(root, "noise.txt");
    await writeFile(
      src,
      [
        "Sponsored by the Transmission and Distribution Committee",
        "3 Park Avenue, New York, NY 10016-5997, USA",
        "Authorized licensed use limited to: Tsinghua University. Downloaded on May 01,2020 at 03:00:00 UTC from IEEE Xplore. Restrictions apply.",
        "",
      ].join("\n"),
      "utf8"
    );
    const { docId } = await importFileInto(join(root, "kb"), {
      sourcePath: src, relKey: "noise.txt", title: "资料甲", config: CONFIG,
    });
    const doc = (await readManifest(join(root, "kb"))).docs.find((item) => item.id === docId);
    assert.equal(doc.summary, "", "宁可不写摘要，也不把版权页文字写进索引");
    assert.equal(doc.summarySource, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
