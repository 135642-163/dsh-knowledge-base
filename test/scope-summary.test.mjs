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

test("范围摘要上限 500 字，长范围不被截成 160 字", () => {
  const long = Array.from({ length: 8 }, (_, index) => `第${index + 1}句：本标准规定了电能质量参数的测量方法和结果处理要求。`).join("");
  const summary = summarizeStandardScope(`1 范围\n${long}\n2 规范性引用文件`, 500);
  assert.ok(summary.length > 160);
  assert.ok(summary.length <= 500);
  assert.doesNotMatch(summary, /…$/);
});

test("OCR 用竖线画版面边框时也能取到范围正文", () => {
  const text = [
    "|          1 范围",
    "|              本部分规定了链式静止同步补偿器及其辅助设备在现场安装中和安装后的试验和验收。",
    "|              本部分适用于链式 STATCOM 的现场试验。",
    "|          2 规范性引用文件",
  ].join("\n");
  const summary = summarizeStandardScope(text, 160, { title: "现场试验" });
  assert.match(summary, /^本部分规定了链式静止同步补偿器/);
  assert.doesNotMatch(summary, /\|/);
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

test("总则式设计规程：没有「1 范围」标题时从「1.0.2 本标准适用于」取范围", () => {
  // DL/T 5033-2023 扫描版的真实形态：OCR 把「总则」拆成「1总 / 点则」，
  // 范围句在 1.0.2，后面紧跟 1.0.3 与第 2 章。
  const text = [
    "### 第 10 页",
    "1总",
    "点则",
    "1.0.1为了贯彻执行国家的基本建设方针和技术经济政策，制定本标准。",
    "1.0.2本标准适用于110kV～1000kV交流架空输电线路对符",
    "合相关标准要求的电信线路危险和干扰影响的防护设计。",
    "1.0.3交流架空输电线路对电信线路危险和干扰影响防护设计",
    "除应符合本标准的规定外，尚应符合国家现行有关标准的规定。",
    "2术语和符号",
    "2.1术语",
    "2.1.1交流架空输电线路",
  ].join("\n");
  const summary = summarizeStandardScope(text, 500);
  assert.equal(summary, "本标准适用于110kV～1000kV交流架空输电线路对符合相关标准要求的电信线路危险和干扰影响的防护设计。");
  assert.doesNotMatch(summary, /^1\.0\.2|1\.0\.3|术语|总则/);
});

test("范围句兜底不跨到下一章，也不把目录行当正文", () => {
  const text = [
    "目 次",
    "1 总则 1",
    "2 术语 2",
    "1 总则",
    "1.0.2 本规程适用于 10kV 及以下配电网的规划与设计。",
    "2 术语",
    "2.1 本标准适用于另一本标准的目录行。",
  ].join("\n");
  assert.match(summarizeStandardScope(text, 200), /^本规程适用于 10kV 及以下配电网/);
});

test("有「1 范围」时优先用范围章节，不受后文「本标准适用于」干扰", () => {
  const text = [
    "1 范围",
    "本标准规定了电能质量参数的测量方法。",
    "本标准适用于公用电网。",
    "2 规范性引用文件",
    "3 总则",
    "3.0.2 本标准适用于其他场景。",
  ].join("\n");
  assert.match(summarizeStandardScope(text, 200), /^本标准规定了电能质量参数的测量方法/);
});
