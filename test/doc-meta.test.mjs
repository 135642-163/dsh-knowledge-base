/**
 * 资料身份元数据：标题规范化、标准要素、正文/封面标准号、正文完整性、trust。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeTitle,
  contentIntegrityFor,
  needsRetitle,
  mergeDocMeta,
  parseContentStandard,
  parseCoverTitle,
  parseDocMeta,
  safeRetitle,
  stageKeyOf,
  textFingerprint,
  titleKey,
  trustHeuristic,
} from "../lib/doc-meta.js";

test("parseDocMeta 解析 DL/T587—2025+ 并规范化标题", () => {
  const meta = parseDocMeta(
    "DL/T587—2025+继电保护和安全自动装置运行管理规程",
    "DLT587—2025+继电保护和安全自动装置运行管理规程"
  );
  assert.equal(meta.standardPrefix, "DL/T");
  assert.equal(meta.standardNumber, "587");
  assert.equal(meta.standardYear, 2025);
  assert.equal(meta.standardNo, "DL/T 587-2025");
  assert.equal(meta.canonicalTitle, "DL/T 587-2025 继电保护和安全自动装置运行管理规程");
  assert.equal(meta.standardSource, "filename");
  assert.equal(meta.stage, "published");
});

test("parseDocMeta 解析 GB/T 19963.2 的部分号与 base", () => {
  const meta = parseDocMeta("GB/T 19963.2-2024 风电场接入电力系统技术规定 第2部分：海上风电");
  assert.equal(meta.standardPrefix, "GB/T");
  assert.equal(meta.standardNumber, "19963.2");
  assert.equal(meta.standardBase, "19963");
  assert.equal(meta.standardYear, 2024);
  assert.equal(meta.standardPart, "2");
  assert.equal(meta.standardNo, "GB/T 19963.2-2024");
  assert.equal(meta.stage, "published");
});

test("parseDocMeta 识别括号内的报批稿/征求意见稿", () => {
  const draft = parseDocMeta("DL/T 587—2025 继电保护和安全自动装置运行管理规程（报批稿）");
  assert.equal(draft.stage, "draft");
  assert.equal(draft.stageLabel, "报批稿");
  const comment = parseDocMeta("GB/T 11032-2020 交流无间隙金属氧化物避雷器 征求意见稿");
  assert.equal(comment.stage, "comment");
});

test("parseDocMeta 不把通知正文里的 IEC/GB 引用当自己的标准号", () => {
  assert.equal(parseDocMeta("2020年标34号 关于召开IEC63222-3国际标准国内工作组会议的通知", "x").standardNo, "");
  assert.equal(parseDocMeta("comtrade99", "comtrade99").standardNo, "");
  assert.equal(parseDocMeta("风力发电场设计规范 GB 51096-2015 住建部版", "x").standardNo, "GB 51096-2015");
  assert.equal(parseDocMeta("±800kV直流换流站设计规范 GB/T 50789-2012 住建部版 2022局部修订版", "x").standardNo, "GB/T 50789-2012");
});

test("parseDocMeta 对非标准标题返回空标准号", () => {
  const meta = parseDocMeta("电能质量管理办法（暂行）");
  assert.equal(meta.standardNo, "");
  assert.equal(meta.standardSource, "none");
  assert.equal(meta.titleKey, titleKey("电能质量管理办法（暂行）"));
});

test("canonicalizeTitle 只规范开头标准号，不改正文", () => {
  assert.equal(canonicalizeTitle("DL/T587—2025+继电保护"), "DL/T 587-2025 继电保护");
  assert.equal(canonicalizeTitle("GB_T 15543-1995 电能质量"), "GB/T 15543-1995 电能质量");
  assert.equal(canonicalizeTitle("2018 500kV XLPE 海底电缆线路参数"), "2018 500kV XLPE 海底电缆线路参数");
  assert.equal(canonicalizeTitle("电能质量管理办法（暂行）"), "电能质量管理办法（暂行）");
});

test("parseContentStandard 从封面识别 GB/T 19963.2 与标题", () => {
  const content = parseContentStandard(`
中华人民共和国国家标准
GB/T 19963.2-2024
风电场接入电力系统技术规定 第2部分：海上风电
2024-09-29 发布
2025-04-01 实施
`);
  assert.ok(content);
  assert.equal(content.standardPrefix, "GB/T");
  assert.equal(content.standardNumber, "19963.2");
  assert.equal(content.standardYear, 2024);
  assert.equal(content.standardNo, "GB/T 19963.2-2024");
  assert.equal(content.contentTitle, "风电场接入电力系统技术规定 第2部分：海上风电");
  assert.equal(content.confidence, "high");
});

test("parseContentStandard 能从文件名写 GB 的正文里识别 GB/T", () => {
  const content = parseContentStandard("GB/T 19963.2-2024\n风电场接入电力系统技术规定 第2部分：海上风电");
  assert.equal(content.standardNo, "GB/T 19963.2-2024");
});

test("parseContentStandard 不接受正文条款号", () => {
  assert.equal(parseContentStandard("5.2.2 继电保护装置应满足以下要求。\n6.1 试验方法。"), null);
  assert.equal(parseContentStandard(""), null);
});

test("parseContentStandard 处理全角数字", () => {
  const content = parseContentStandard("ＧＢ／Ｔ １９９６３．２－２０２４\n风电场接入电力系统技术规定");
  assert.ok(content);
  assert.equal(content.standardNo, "GB/T 19963.2-2024");
});

test("parseCoverTitle 取书籍封面标题", () => {
  const book = parseCoverTitle("中华人民共和国国家标准\n电力系统分析\n第一章 绪论\n正文…");
  assert.equal(book.title, "电力系统分析");
});

test("contentIntegrityFor 区分 full/partial/cover-only", () => {
  const longBody = `${"5.1 正文内容。\n".repeat(600)}`;
  const full = contentIntegrityFor({
    sections: [
      { page: 1, text: "GB/T 19963.2-2024 封面" },
      { page: 2, text: "目 次" },
      { page: 3, text: longBody },
    ],
  });
  assert.equal(full.integrity, "full");
  assert.ok(full.bodyChars >= 1000);
  assert.ok(full.clauseCount >= 3);

  const coverOnly = contentIntegrityFor({
    sections: [{ page: 1, text: "GB/T 19963.2-2024 风电场接入电力系统技术规定" }],
  });
  assert.equal(coverOnly.integrity, "cover-only");

  const partial = contentIntegrityFor({
    sections: [
      { page: 1, text: "封面" },
      { page: 2, text: "目录" },
      { page: 3, text: "5.1 一段正文。".repeat(30) },
    ],
  });
  assert.equal(partial.integrity, "partial");
});

test("contentIntegrityFor 单段全文不被误判为封面", () => {
  const full = contentIntegrityFor({ sections: [{ text: "5.1 正文。\n".repeat(600) }] });
  assert.equal(full.integrity, "full");
});

test("trustHeuristic：发布→medium，过程稿→low，非标准→unknown", () => {
  assert.deepEqual(trustHeuristic({ stage: "published", standardNo: "GB/T 1-2020" }), {
    trust: "medium",
    reason: "已发布标准，尚未核实现行/废止",
  });
  assert.equal(trustHeuristic({ stage: "draft", standardNo: "GB/T 1-2020" }).trust, "low");
  assert.equal(trustHeuristic({ stage: "comment", standardNo: "GB/T 1-2020" }).trust, "low");
  assert.equal(trustHeuristic({ stage: "published" }).trust, "unknown");
});

test("stageKeyOf 映射中英文阶段", () => {
  assert.equal(stageKeyOf("发布稿"), "published");
  assert.equal(stageKeyOf("报批稿"), "draft");
  assert.equal(stageKeyOf("说明材料"), "notes");
  assert.equal(stageKeyOf("未知"), "unknown");
});

test("textFingerprint 忽略空白/注释且稳定", () => {
  const a = textFingerprint([{ heading: "5.1", text: "正文  内容\n" }]);
  const b = textFingerprint([{ heading: "5.1", text: "正文 内容" }]);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(textFingerprint("正文 内容"), textFingerprint([{ text: "正文  内容" }]));
  assert.notEqual(textFingerprint("正文 A"), textFingerprint("正文 B"));
});

test("mergeDocMeta 不拿正文里的别的标准号覆盖文件名", () => {
  const filename = parseDocMeta("DL 1773-2017-报批稿", "DL 1773-2017-报批稿");
  const content = parseContentStandard("NB 2\n某表格标题\n2020-01-01 发布");
  const merged = mergeDocMeta(filename, content);
  assert.equal(merged.standardNo, "DL 1773-2017");
  assert.equal(merged.standardSource, "filename");
});

test("mergeDocMeta 允许 GB 与 GB/T 同主编号的正文纠正", () => {
  const filename = parseDocMeta("GB 19963.2-2024", "GB 19963.2-2024");
  const content = parseContentStandard("GB/T 19963.2-2024\n风电场接入电力系统技术规定 第2部分：海上风电");
  const merged = mergeDocMeta(filename, content);
  assert.equal(merged.standardNo, "GB/T 19963.2-2024");
  assert.equal(merged.standardSource, "content");
  assert.equal(merged.filenameStandardNo, "GB 19963.2-2024");
});

test("canonicalizeTitle：噪声前缀/加号/两位年份与阶段词", () => {
  assert.equal(
    canonicalizeTitle("DL/T587—2025+继电保护和安全自动装置运行管理规程"),
    "DL/T 587-2025 继电保护和安全自动装置运行管理规程"
  );
  assert.equal(canonicalizeTitle("GB/T 14549-93 电能质量 公用电网谐波"), "GB/T 14549-1993 电能质量 公用电网谐波");
  const meta = parseDocMeta("Q/GDW 10650.6-2019 报批稿", "Q/GDW 10650.6-2019 报批稿");
  assert.equal(meta.standardNo, "Q/GDW 10650.6-2019");
  assert.equal(meta.standardYear, 2019);
});

test("needsRetitle/safeRetitle 只放行格式噪声", () => {
  assert.equal(needsRetitle("DL/T587—2025+继电保护"), true);
  assert.equal(needsRetitle("GB 19862-2016-征求意见稿"), false);
  assert.equal(safeRetitle("DL/T587—2025+继电保护", "DL/T 587-2025 继电保护"), true);
  assert.equal(safeRetitle("GB/T 14549-93 电能质量", "GB/T 14549-1993 电能质量"), false);
});

test("从书名号/括注里识别标准号并重排为「编号 名称」", () => {
  const cases = [
    ["《电能质量 公用电网谐波》（GB/T 14549-1993）", "GB/T 14549-1993", "GB/T 14549-1993 电能质量 公用电网谐波"],
    ["《电能质量评估技术导则 电压暂降与短时中断》(DL/T2833-2024)", "DL/T 2833-2024", "DL/T 2833-2024 电能质量评估技术导则 电压暂降与短时中断"],
    ["NB/T 10113-2018 《光伏发电站技术监督导则》(1)", "NB/T 10113-2018", "NB/T 10113-2018 光伏发电站技术监督导则"],
    ["TCES 113-2022《GIS设备红外热像检测现场应用导则》", "T/CES 113-2022", "T/CES 113-2022 GIS设备红外热像检测现场应用导则"],
  ];
  for (const [title, std, canonical] of cases) {
    const meta = parseDocMeta(title, title);
    assert.equal(meta.standardNo, std);
    assert.equal(meta.canonicalTitle, canonical);
  }
});

test("书名号标题保留报批稿/送审稿，清理上传版后缀", () => {
  assert.equal(
    canonicalizeTitle("《电力系统无功补偿配置技术导则》（Q/GDW 10212）（报批稿）"),
    "Q/GDW 10212 电力系统无功补偿配置技术导则（报批稿）"
  );
  assert.equal(
    canonicalizeTitle("《高压有源谐振抑制装置 第1部分：总则》（标准送审稿-内部） - 上传版(1)"),
    "高压有源谐振抑制装置 第1部分：总则（送审稿-内部）"
  );
  assert.equal(
    canonicalizeTitle("20240213PA（启动会）《高压有源谐振抑制装置 第1部分：总则》-征求意见稿Ver1.0"),
    "高压有源谐振抑制装置 第1部分：总则（征求意见稿 Ver1.0）"
  );
});

test("parseContentStandard 不把正文引用 GB/T 1.1 当自己的标准号", () => {
  const r = parseContentStandard("本文件按照 GB/T 1.1-2020《标准化工作导则》的规则起草。\n高压有源谐振抑制装置 第1部分：总则", { expectedStandardNo: "" });
  assert.equal(r, null);
});

test("parseContentStandard 从封面补齐名称（中文/分部分）", () => {
  const tb = parseContentStandard(
    "中华人民共和国铁道行业标准\nTB/T 2797—1997\n电气化铁道\n负序电流计算条件和方法\n1997—07—10 发布",
    { expectedStandardNo: "TB 2797-1997" }
  );
  assert.equal(tb.standardNo, "TB/T 2797-1997");
  assert.equal(tb.contentTitle, "电气化铁道 负序电流计算条件和方法");

  const nb = parseContentStandard(
    "ICS 27.180\nNB/T 31005 — 2011\n风电场电能质量测试方法\n2011-08-06发布",
    { expectedStandardNo: "NB 31005-2011" }
  );
  assert.equal(nb.standardNo, "NB/T 31005-2011");
  assert.equal(nb.contentTitle, "风电场电能质量测试方法");

  const dl = parseContentStandard(
    "中华人民共和国电力行业标准化指导性技术文件\nDL/Z 860.1 — 2018/IEC 61850-1:2013\n电力自动化通信网络和系统\n第工部分:概论\n2018-12-25 发布",
    { expectedStandardNo: "DL 860.1-2018" }
  );
  assert.equal(dl.standardNo, "DL/Z 860.1-2018");
  assert.equal(dl.contentTitle, "电力自动化通信网络和系统 第1部分:概论");
});
