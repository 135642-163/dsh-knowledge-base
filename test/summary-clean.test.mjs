/**
 * 0.31.3 摘要清洗：跳过 OCR 页眉（ICS/标准号行）与乱码行，正常段落不受影响。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cleanSummaryText, isOcrNoiseLine, summarizeSections } from "../lib/wiki.js";

test("cleanSummaryText：跳过 ICS 页眉与 OCR 乱码行", () => {
  const text = [
    "ICS 01.120 ng oe a 00 ye aa GE HP TE A B BG 2 A OBI OE] is HE GB/T 20001.10-2014",
    "标准编写规则 第10部分：产品标准",
    "本文件规定了产品标准的编写规则。",
  ].join("\n");
  assert.equal(cleanSummaryText(text), "标准编写规则 第10部分：产品标准 本文件规定了产品标准的编写规则。");
  assert.equal(isOcrNoiseLine("ng oe a 00 ye aa GE HP TE A B BG 2 A OBI OE is HE"), true);
  assert.equal(isOcrNoiseLine("本文件规定了产品标准的编写规则。"), false);
});

test("cleanSummaryText：正常长段落即使以标准号开头也不整段丢弃", () => {
  const paragraph = "GB/T 20001.10-2014 规定了产品标准的结构、起草表述规则和编排格式，适用于各类产品标准的编写。";
  assert.equal(cleanSummaryText(paragraph), paragraph);
});

test("summarizeSections：跳过噪声后取第一段实质正文", () => {
  const sections = [
    { heading: "封面", text: "ICS 01.120\nng oe a 00 ye aa GE HP TE A B BG 2 A OBI OE is HE" },
    { heading: "正文", text: "本文件规定了产品标准的编写规则，包括结构、要素和表述要求。" },
  ];
  assert.match(summarizeSections(sections, 80), /^本文件规定了产品标准的编写规则/);
});

test("summarizeSections：全是噪声时退回原文，不返回空", () => {
  const sections = [{ heading: "扫描页", text: "ICS 01.120\nng oe a 00 ye aa GE HP TE A B BG 2 A OBI OE is HE" }];
  const summary = summarizeSections(sections, 80);
  assert.ok(summary.length > 0);
});
