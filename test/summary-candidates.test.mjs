import test from "node:test";
import assert from "node:assert/strict";
import { extractScopeSummary, looksNoisySummary } from "../lib/summary-candidates.js";

test("识别封面/OCR 噪声摘要", () => {
  assert.equal(looksNoisySummary("!!89 WxT PQjk"), true);
  assert.equal(looksNoisySummary("ICS 29.020 中华人民共和国国家标准"), true);
  assert.equal(looksNoisySummary("本标准规定了电压偏差的限值。"), false);
  assert.equal(looksNoisySummary(""), true);
});

test("从正文提取范围句并截断", () => {
  const md = `# 标题\n### 第 1 页\nICS 29.020 封面\n### 第 2 页\n本标准规定了电压暂降与短时中断的指标及测试、统计和评估方法。\n本标准适用于交流 50 Hz 电力系统。`;
  assert.equal(
    extractScopeSummary(md),
    "本标准规定了电压暂降与短时中断的指标及测试、统计和评估方法。 本标准适用于交流 50 Hz 电力系统。",
  );
  assert.equal(extractScopeSummary("# 只有标题"), "");
});


test("标准号页眉被跳过，但以标准号开头的正文范围句保留", () => {
  const md = `### 第 1 页
GB/T 18039.8一2012
### 第 2 页
GB/T 18039 的本部分规定了高空核电磁脉冲传导环境。
本部分的目的是建立共同标准。
2 规范性引用文件`;
  assert.equal(
    extractScopeSummary(md),
    "GB/T 18039 的本部分规定了高空核电磁脉冲传导环境。 本部分的目的是建立共同标准。",
  );
});


test("无空格的下一章节标题（2规范性引用文件）也会截断范围", () => {
  const md = `本部分规定了电能质量评价方法。\n本部分适用于 10 kV 电网。\n2规范性引用文件\n下列文件...`;
  assert.equal(extractScopeSummary(md), "本部分规定了电能质量评价方法。 本部分适用于 10 kV 电网。");
});


test("带编号的 1.2 规范性引用文件 也截断范围", () => {
  const md = `本标准适用于高压开关设备。\n本标准包括户内和户外设备。\n1.2 规范性引用文件\n下列文件...`;
  assert.equal(extractScopeSummary(md), "本标准适用于高压开关设备。 本标准包括户内和户外设备。");
});
