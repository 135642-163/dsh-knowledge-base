/**
 * 版本收敛规则：同号存在更新年份 ⇒ 旧版按已废止处理。
 * 纯函数测试，不碰网络与磁盘。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  nameKey,
  nameSimilarity,
  collectLibrarySuperseded,
  librarySupersedeReason,
  replacementTargets,
  collectCoverSuperseded,
  coverSupersedeReason,
} from "../lib/supersede.js";

function doc(id, title, { stage = "published", stageLabel = "发布稿", standardNo, standardNumber, standardYear, deletedAt } = {}) {
  return {
    id,
    title,
    stage,
    stageLabel,
    ...(standardNo ? { standardNo, standardPrefix: String(standardNo).split(/\s/)[0], standardNumber, standardYear } : {}),
    ...(deletedAt ? { deletedAt } : {}),
  };
}

test("nameKey/nameSimilarity：忽略编号、阶段词与标点", () => {
  assert.equal(nameKey("GB/T 12326-2008 电能质量 电压波动和闪变"), nameKey("电能质量 电压波动和闪变"));
  assert.ok(nameSimilarity("GB 12326-2000 电能质量 电压允许波动和闪变", "GB/T 12326-2008 电能质量 电压波动和闪变") >= 0.8);
  assert.ok(nameSimilarity("DL/T 478-2013 继电保护和安全自动装置通用技术条件", "DL/T 478-2019 电力系统时间同步") < 0.4);
});

test("同号不同年份：旧版进入 olds，新版保留", () => {
  const manifest = {
    docs: [
      doc("a", "GB/T 12326-1990 电能质量 电压允许波动和闪变", { standardNo: "GB 12326-1990", standardNumber: "12326", standardYear: 1990 }),
      doc("b", "GB 12326-2000 电能质量 电压允许波动和闪变", { standardNo: "GB 12326-2000", standardNumber: "12326", standardYear: 2000 }),
      doc("c", "GB/T 12326-2008 电能质量 电压波动和闪变", { standardNo: "GB/T 12326-2008", standardNumber: "12326", standardYear: 2008 }),
    ],
  };
  const { groups, docs } = collectLibrarySuperseded(manifest);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].keep.map((k) => k.year), [2008]);
  assert.deepEqual(groups[0].olds.map((o) => o.year).sort(), [1990, 2000]);
  assert.equal(docs, 2);
  assert.match(librarySupersedeReason(groups[0]), /库内已有同号更新版本 GB\/T 12326-2008/);
});

test("同号但名称不同 → 不判废止（名称相似度门槛）", () => {
  const manifest = {
    docs: [
      doc("a", "DL/T 478-2013 继电保护和安全自动装置通用技术条件", { standardNo: "DL/T 478-2013", standardNumber: "478", standardYear: 2013 }),
      doc("b", "DL/T 478-2019 电力系统时间同步系统技术规范", { standardNo: "DL/T 478-2019", standardNumber: "478", standardYear: 2019 }),
    ],
  };
  const { groups } = collectLibrarySuperseded(manifest);
  assert.equal(groups.length, 0, "名称差太多时不能仅凭编号判废止");
});

test("草案不作为“更新版本”，也不被标废止", () => {
  const manifest = {
    docs: [
      doc("a", "GB/T 19963-2011 风电场接入电力系统技术规定", { standardNo: "GB/T 19963-2011", standardNumber: "19963", standardYear: 2011 }),
      doc("b", "GB/T 19963-2019 风电场接入电力系统技术规定 送审稿", { stage: "review", stageLabel: "送审稿" }),
    ],
  };
  const { groups } = collectLibrarySuperseded(manifest);
  assert.equal(groups.length, 0, "草案不能证明正式版失效");
});

test("分册编号各自收敛，不互相取代", () => {
  const manifest = {
    docs: [
      doc("a", "GB/T 4728.6-2008 电气简图用图形符号 第6部分：电能的发生与转换", { standardNo: "GB/T 4728.6-2008", standardNumber: "4728.6", standardYear: 2008 }),
      doc("b", "GB/T 4728.6-2022 电气简图用图形符号 第6部分：电能的发生与转换", { standardNo: "GB/T 4728.6-2022", standardNumber: "4728.6", standardYear: 2022 }),
      doc("c", "GB/T 4728.7-2008 电气简图用图形符号 第7部分：开关、控制和保护器件", { standardNo: "GB/T 4728.7-2008", standardNumber: "4728.7", standardYear: 2008 }),
    ],
  };
  const { groups } = collectLibrarySuperseded(manifest);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].number, "4728.6");
  assert.deepEqual(groups[0].olds.map((o) => o.docId), ["a"]);
});

test("不同体系同号不互相收敛（GB 311 vs DL/T 311）", () => {
  const manifest = {
    docs: [
      doc("a", "GB 311-1997 高压输变电设备的绝缘配合", { standardNo: "GB 311-1997", standardNumber: "311", standardYear: 1997 }),
      doc("b", "DL/T 311-2024 1100kV气体绝缘金属封闭开关设备检修导则", { standardNo: "DL/T 311-2024", standardNumber: "311", standardYear: 2024 }),
    ],
  };
  const { groups } = collectLibrarySuperseded(manifest);
  assert.equal(groups.length, 0);
});

test("软删除文档不参与收敛", () => {
  const manifest = {
    docs: [
      doc("a", "GB/T 14549-1993 电能质量 公用电网谐波", { standardNo: "GB/T 14549-1993", standardNumber: "14549", standardYear: 1993 }),
      doc("b", "GB/T 14549-2020 电能质量 公用电网谐波", { standardNo: "GB/T 14549-2020", standardNumber: "14549", standardYear: 2020, deletedAt: "2026-01-01T00:00:00.000Z" }),
    ],
  };
  const { groups } = collectLibrarySuperseded(manifest);
  assert.equal(groups.length, 0, "已删除的新版不能把旧版判成废止");
});

test("同一年份有多份（重复导入）时全部保留为新版", () => {
  const manifest = {
    docs: [
      doc("a", "GB/T 1179-2008 圆线同心绞架空导线", { standardNo: "GB/T 1179-2008", standardNumber: "1179", standardYear: 2008 }),
      doc("b", "GB/T 1179-2017 圆线同心绞架空导线", { standardNo: "GB/T 1179-2017", standardNumber: "1179", standardYear: 2017 }),
      doc("c", "GB/T 1179-2017 圆线同心绞架空导线（扫描件）", { standardNo: "GB/T 1179-2017", standardNumber: "1179", standardYear: 2017 }),
    ],
  };
  const { groups } = collectLibrarySuperseded(manifest);
  assert.equal(groups[0].keep.length, 2);
  assert.deepEqual(groups[0].olds.map((o) => o.docId), ["a"]);
});

test("replacementTargets：只取「代替 …」方向，忽略「被 … 代替」", () => {
  assert.deepEqual(replacementTargets("代替 GB/T 20000.2—2009、GB/T 20000.9—2014"), ["GB/T 20000.2-2009", "GB/T 20000.9-2014"]);
  assert.deepEqual(replacementTargets("本标准代替 GB 12326—2000《电能质量 电压波动和闪变》。"), ["GB 12326-2000"]);
  assert.deepEqual(replacementTargets("代替GB/Z 19963-2005被GB/T 19963.1-2021代替"), ["GB/Z 19963-2005"]);
  assert.deepEqual(replacementTargets("被GB/T 14598.24-2017代替"), []);
});

test("collectCoverSuperseded：跨编号替代也能建立关系（22386 ← 14598.24）", () => {
  const manifest = {
    docs: [
      doc("new", "GB/T 14598.24-2017 量度继电器和保护装置 第24部分", { standardNo: "GB/T 14598.24-2017", standardNumber: "14598.24", standardYear: 2017 }),
      doc("old", "GB/T 22386-2008 电力系统暂态数据交换通用格式", { standardNo: "GB/T 22386-2008", standardNumber: "22386", standardYear: 2008 }),
    ],
  };
  const texts = new Map([["new", "GB/T 14598.24—2017\n代替 GB/T 22386-2008\n前言 …"]]);
  const { groups, docs } = collectCoverSuperseded({ manifest, texts });
  assert.equal(docs, 1);
  assert.equal(docs, groups.length);
  assert.deepEqual(groups[0].olds.map((o) => o.docId), ["old"]);
  assert.deepEqual(groups[0].keep.map((k) => k.docId), ["new"]);
  assert.match(coverSupersedeReason(groups[0]), /封面声明代替 GB\/T 22386-2008/);
});

test("collectCoverSuperseded：声明的被替代标准不在库里时不产生条目；自引用忽略", () => {
  const manifest = {
    docs: [
      doc("a", "GB/T 1.2-2020 标准化工作导则 第2部分", { standardNo: "GB/T 1.2-2020", standardNumber: "1.2", standardYear: 2020 }),
      doc("b", "GB/T 20000.2-2009 标准化工作指南 第2部分", { standardNo: "GB/T 20000.2-2009", standardNumber: "20000.2", standardYear: 2009 }),
    ],
  };
  // 声明代替 20000.2 且库里也有 → 建立关系
  const hit = collectCoverSuperseded({ manifest, texts: new Map([["a", "代替 GB/T 20000.2—2009"]]) });
  assert.equal(hit.docs, 1);
  // 声明代替一个库里没有的编号 → 不产生条目
  const miss = collectCoverSuperseded({ manifest, texts: new Map([["a", "代替 GB/T 99999-2001"]]) });
  assert.equal(miss.docs, 0);
  // 自己声明代替自己 → 忽略
  const self = collectCoverSuperseded({ manifest, texts: new Map([["a", "代替 GB/T 1.2-2020"]]) });
  assert.equal(self.docs, 0);
});

test("collectCoverSuperseded：草案/编制说明里的「代替」声明不作数", () => {
  const manifest = {
    docs: [
      // 新版是送审稿 → 不能据此判定旧版废止
      doc("draft", "NB/T 42043-2021 高压静止同步补偿装置 送审稿", { stage: "review", stageLabel: "送审稿" }),
      doc("old", "NB/T 42043-2014 高压静止同步补偿装置", { standardNo: "NB/T 42043-2014", standardNumber: "42043", standardYear: 2014 }),
    ],
  };
  const { docs } = collectCoverSuperseded({ manifest, texts: new Map([["draft", "代替 NB/T 42043-2014"]]) });
  assert.equal(docs, 0, "草案声明代替不能作为废止依据");
});
