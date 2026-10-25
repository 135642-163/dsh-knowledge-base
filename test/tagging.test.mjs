import test from "node:test";
import assert from "node:assert/strict";
import {
  addedTags,
  classifyDocTags,
  standardTypeTags,
  topicTags,
} from "../lib/tagging.js";

test("标准层级：国标/行标/企标/团标/国际", () => {
  assert.deepEqual(standardTypeTags({ standardPrefix: "GB/T" }), ["国家标准"]);
  assert.deepEqual(standardTypeTags({ standardPrefix: "DL/T" }), ["行业标准"]);
  assert.deepEqual(standardTypeTags({ standardPrefix: "Q/GDW" }), ["企业标准"]);
  assert.deepEqual(standardTypeTags({ standardPrefix: "T/CEC" }), ["团体标准"]);
  assert.deepEqual(standardTypeTags({ standardPrefix: "IEC" }), ["国际标准"]);
  assert.deepEqual(standardTypeTags({ title: "国网（运检／3）919-2018 电网谐波管理规定" }), ["企业标准"]);
  assert.deepEqual(standardTypeTags({ title: "会议通知" }), []);
  assert.deepEqual(standardTypeTags({ title: "comtrade99" }), []);
  assert.deepEqual(standardTypeTags({ title: "2020年标34号 关于召开IEC63222-3国际标准国内工作组会议的通知" }), []);
  assert.deepEqual(standardTypeTags({ title: "《电能质量 公用电网谐波》（GB/T 14549-1993）" }), ["国家标准"]);
  assert.deepEqual(standardTypeTags({ title: "【无水印无加密】IEC TR 63282 LVDC systems – Assessment of standard voltages and power quality requirements" }), ["国际标准"]);
});

test("主题标签：电能质量/继电保护/变压器/变电试验/绝缘/新能源", () => {
  assert.ok(topicTags({ title: "电能质量 公用电网谐波" }).includes("电能质量"));
  assert.ok(topicTags({ title: "继电保护和安全自动装置运行管理规程" }).includes("继电保护"));
  assert.ok(topicTags({ title: "电力变压器运行规程" }).includes("变压器"));
  assert.ok(topicTags({ title: "变电站设备交接试验规程" }).includes("变电试验"));
  assert.ok(!topicTags({ title: "变电站设计规范" }).includes("变电试验"));
  assert.ok(topicTags({ title: "局部放电带电检测技术" }).includes("绝缘"));
  assert.ok(topicTags({ title: "分布式光伏接入电网技术规定" }).includes("新能源"));
});

test("classifyDocTags 保留旧标签并去重", () => {
  const tags = classifyDocTags(
    { title: "电能质量 公用电网谐波", standardPrefix: "GB/T" },
    { existing: ["标准", "电能质量"] }
  );
  assert.deepEqual(tags, ["标准", "电能质量", "国家标准"]);
  assert.deepEqual(addedTags({ title: "电能质量 公用电网谐波", standardPrefix: "GB/T" }, ["标准"]), ["国家标准", "电能质量"]);
});

test("笔记/非标准资料不硬塞类型标签", () => {
  assert.deepEqual(standardTypeTags({ title: "关于召开标准审查会议的通知" }), []);
  assert.deepEqual(classifyDocTags({ title: "会议纪要" }), []);
});
