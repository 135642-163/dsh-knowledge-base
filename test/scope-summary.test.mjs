/**
 * 标准摘要优先取「1 范围」：中英文页眉/页码/下一章都要正确处理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeStandardScope } from "../lib/wiki.js";

test("取 1 范围，遇到 2 引用标准停止", () => {
  const text = [
    "1  范围",
    "本标准规定了微电网并网测试的测试条件、测试项目和测试方法。",
    "本标准适用于通过 35 kV 及以下电压等级接入配电网的新建、扩建及改造并网型微电网的并网测试。",
    "2  规范性引用文件",
    "下列文件中的内容通过文中的规范性引用而构成本文件必不可少的条款。",
  ].join("\n");
  const summary = summarizeStandardScope(text, 200);
  assert.match(summary, /^本标准规定了微电网并网测试/);
  assert.match(summary, /并网测试。$/);
  assert.doesNotMatch(summary, /规范性引用文件|下列文件/);
});

test("兼容 1范围、主题内容与适用范围、全角括号", () => {
  assert.match(summarizeStandardScope("1范围\n本标准规定了公用电网谐波的允许值及其测试方法。\n2 引用标准\nGB 156", 80), /^本标准规定了公用电网谐波/);
  assert.match(summarizeStandardScope("主题内容与适用范围\n本标准规定了电能质量的各项指标及其测量方法。\n引用标准\nGB/T 1", 80), /^本标准规定了电能质量/);
  assert.match(summarizeStandardScope("（1）范围\n本标准适用于电能质量治理设备的性能检测。\n（2）术语和定义\n无。", 80), /^本标准适用于/);
});

test("跳过页眉、页码、标准号和标题重复行", () => {
  const text = [
    "1范围",
    "GB/Z 26854--2011/IEC/TR 62510 12008",
    "### 电特性的标准化",
    "### 第 3 页",
    "3/4",
    "本指导性技术文件概述了电能作为一种商品的质量描述方法。",
    "本指导性技术文件适用于交流 50 Hz 供电系统。",
    "2电能质量现象",
  ].join("\n");
  const summary = summarizeStandardScope(text, 120, { title: "电特性的标准化" });
  assert.match(summary, /^本指导性技术文件概述/);
  assert.doesNotMatch(summary, /GB\/Z|第 3 页|3\/4/);
});

test("目次里的「1 范围 1」不会被当成正文", () => {
  const text = [
    "目 次",
    "1 范围 1",
    "2 规范性引用文件 2",
    "3 术语和定义 3",
    "1 范围",
    "本标准规定了测试方法。",
    "本标准适用于新建项目。",
    "2 规范性引用文件",
    "下列文件中的内容...",
  ].join("\n");
  assert.match(summarizeStandardScope(text, 160), /^本标准规定了测试方法/);
});

test("没有范围章节或内容过短时返回空串", () => {
  assert.equal(summarizeStandardScope("1 总则\n本标准规定了相关要求。", 80), "");
  assert.equal(summarizeStandardScope("1 范围\n2 引用标准", 80), "");
  assert.equal(summarizeStandardScope("", 80), "");
});
