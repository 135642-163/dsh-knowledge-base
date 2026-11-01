/**
 * P0-2 标准数据只读审计：分类函数与只读报告流程。
 *
 * 重点覆盖：
 *  - 封面核对分类（前缀可修 / 文件更新 / 文件不符 / 年份可疑 / 误报）；
 *  - stage 与标题过程标记冲突、标准号字段自相矛盾；
 *  - 同号同年同阶段重复组（保留建议优先文字层）；
 *  - 可信度占位理由分流（可刷新 / 前缀卡住 / 站外 / 无缓存 / 旧 low）；
 *  - 站点检查缓存分流（update / 站外未收录 / 非站外未收录 / 缓存滞后 / 历史键）；
 *  - 临时知识库上跑完整 runAudit：只读校验通过、报告不写进知识库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditCover,
  classifyCheckCache,
  classifyCoverRow,
  classifyTrustReasons,
  detectDuplicateGroups,
  detectStdNoAnomalies,
  detectSupersededNotLow,
  detectTitleStageIssues,
  renderMarkdown,
  runAudit,
} from "../scripts/std-data-audit.mjs";
import { coverStdNo, coverText, metaStdNo } from "../scripts/audit-cover-stdno.mjs";

const NOW = "2026-11-01T00:00:00.000Z";

function doc(id, title, patch = {}) {
  return {
    id,
    title,
    type: "pdf-text",
    status: "ready",
    chars: 12000,
    stages: "",
    ...patch,
  };
}

function coverOf(text) {
  return coverStdNo(
    String(text)
      .replace(/(\d)\s*[一]\s*(\d)/g, "$1-$2")
      .replace(/[—–－‐]/g, "-")
  );
}

function classify(d, text) {
  return classifyCoverRow(d, text, coverOf(text), metaStdNo(d));
}

test("封面：编号+年份+前缀一致 → 不报", () => {
  const d = doc("a", "GB/T 1234-2020 某标准", { standardNo: "GB/T 1234-2020" });
  assert.equal(classify(d, "GB/T 1234-2020 某标准"), null);
});

test("封面：仅前缀不同（封面 DL/T、元数据 DL）→ prefix", () => {
  const d = doc("b", "DL 5383-2007 风力发电场设计技术规范", { standardNo: "DL 5383-2007" });
  const row = classify(d, "DL/T 5383-2007 风力发电场设计技术规范");
  assert.equal(row.kind, "prefix");
  assert.equal(row.docId, "b");
});

test("封面：本文编号在非代替上下文出现 → 首号命中引用，属误报", () => {
  const d = doc("c", "TB/T 2798-1997 交流电气化铁道…", { standardNo: "TB/T 2798-1997" });
  const row = classify(d, "前言 本标准考虑了GB/T 15543-1995；TB/T 2798-1997 交流电气化铁道");
  assert.equal(row.kind, "false-positive");
});

test("封面：封面是更新版本、元数据年份只在代替里出现 → cover-newer", () => {
  const d = doc("d", "GB/T 4109-2008 绝缘套管", { standardNo: "GB/T 4109-2008" });
  const row = classify(d, "GB/T 4109一2022 代替 GB/T 4109-2008 绝缘套管");
  assert.equal(row.kind, "cover-newer");
  assert.deepEqual(row.otherYears, [2022]);
});

test("封面：封面完全没有元数据编号 → cover-missing", () => {
  const d = doc("e", "GB/T 32880.3-2016 电能质量经济性评估", { standardNo: "GB/T 32880.3-2016" });
  const row = classify(d, "GB/T 29590-2013 企业现场管理准则");
  assert.equal(row.kind, "cover-missing");
});

test("封面：元数据缺标准号时只对「标题像标准号」的文档提示", () => {
  const yes = doc("f", "Q/GDW 002-00701-2012 标准体系表框架");
  assert.equal(classify(yes, "Q/GDW 002-2012 标准体系表框架").kind, "meta-missing");
  const no = doc("g", "高压有源谐振抑制装置 第5部分（征求意见稿）");
  assert.equal(classify(no, "GB/T 1.1-2020 标准化工作导则"), null);
});

test("auditCover 跳过笔记并容忍派生正文缺失", () => {
  const rows = auditCover({
    docs: [
      doc("h", "GB/T 1.1-2020 标准化工作导则", { standardNo: "GB/T 1.1-2020" }),
      doc("n", "笔记", { type: "note" }),
    ],
    readText: (id) => (id === "h" ? "GB 1.1-2020 标准化工作导则" : ""),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "prefix");
});

test("stage：published 但标题含过程稿标记", () => {
  const issues = detectTitleStageIssues([
    doc("a", "GB 19862-2016 征求意见稿", { stage: "published", stageLabel: "发布稿" }),
    doc("b", "GB/T 1.1-2020 标准化工作导则", { stage: "published", stageLabel: "发布稿" }),
    doc("c", "Q/GDW 649-2011 电能质量监测系统技术规范（含印发通知）", { stage: "notes", stageLabel: "说明材料", chars: 30000 }),
  ]);
  assert.deepEqual(issues.map((x) => x.docId), ["a", "c"]);
});

test("标准号：标题编号与元数据冲突（IEC edition 后缀）", () => {
  const issues = detectStdNoAnomalies([
    doc("a", "IEC 61000-3-5-ed2.0c2-2010", {
      standardNo: "IEC 61000-3-5-ed2.0c2-2010",
      standardPrefix: "IEC",
      standardNumber: "61000-3-5-ed2.0c2",
      standardYear: 2010,
    }),
    doc("b", "GB/T 1.1-2020 标准化工作导则", {
      standardNo: "GB/T 1.1-2020",
      standardPrefix: "GB/T",
      standardNumber: "1.1",
      standardYear: 2020,
    }),
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "stdno-title-conflict");
  assert.equal(issues[0].docId, "a");
});

test("重复组：同号同年同阶段才并组，建议保留文字层更好的一篇", () => {
  const groups = detectDuplicateGroups([
    doc("a", "GB/T 39853.1-2021 供电系统中的电能质量测量", { standardNo: "GB/T 39853.1-2021", standardYear: 2021, stageLabel: "发布稿", type: "pdf-scanned", chars: 28600 }),
    doc("b", "GB/T 39853.1-2021 供电系统中的电能质量测量", { standardNo: "GB/T 39853.1-2021", standardYear: 2021, stageLabel: "发布稿", type: "pdf-text", chars: 28400 }),
    doc("c", "GB/T 39853.1-2021 征求意见稿", { standardNo: "GB/T 39853.1-2021", standardYear: 2021, stageLabel: "征求意见稿" }),
    doc("d", "笔记", { type: "note" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].docs.length, 2);
  assert.equal(groups[0].suggestKeep, "b");
});

test("可信度：占位理由按站点状态分流，旧 low 理由单独列出", () => {
  const docs = [
    doc("cur", "GB/T 1.1-2020", { standardNo: "GB/T 1.1-2020", trust: "high", trustReason: "已发布标准（需按现行/废止再核对）" }),
    doc("pre", "DL 860.3-2004", { standardNo: "DL 860.3-2004", trust: "high", trustReason: "已发布标准（需按现行/废止再核对）" }),
    doc("new", "DL/T 393-2021", { standardNo: "DL/T 393-2021", trust: "high", trustReason: "已发布标准（需按现行/废止再核对）" }),
    doc("off", "Q/GDW 1-2020", { standardNo: "Q/GDW 1-2020", trust: "high", trustReason: "已发布标准（需按现行/废止再核对）" }),
    doc("low", "Q/GDW 12777-2026 变电站SVG动态无功补偿设计规范", { standardNo: "Q/GDW 12777-2026", stage: "published", trust: "low", trustReason: "过程稿/说明材料/勘误（非现行发布版）" }),
  ];
  const docGroup = new Map([
    ["cur", { key: "GB:1.1", it: { status: "current", siteNo: "GB/T 1.1-2020" } }],
    ["pre", { key: "DL:860.3", it: { status: "current", siteNo: "DL/T 860.3-2004" } }],
    ["new", { key: "DL:393", it: { status: "newer-in-kb", siteNo: "DL/T 393-2010" } }],
    ["off", { key: "QGDW:1", it: { status: "not-found", siteNo: "" } }],
  ]);
  const out = classifyTrustReasons({ docs, docGroup });
  assert.deepEqual(out.refreshCurrent.map((x) => x.docId), ["cur"]);
  assert.deepEqual(out.refreshNewer.map((x) => x.docId).sort(), ["new", "pre"]);
  assert.deepEqual(out.offsiteUnverified.map((x) => x.docId), ["off"]);
  assert.deepEqual(out.staleLow.map((x) => x.docId), ["low"]);
});

test("检查缓存：站外未收录与站外缺口分开；历史键与滞后组单列", () => {
  const groups = [
    { key: "GB:1.1", docs: [{ id: "cur" }] },
    { key: "GB:311", docs: [{ id: "bare" }] },
    { key: "QGDW:1", docs: [{ id: "off" }] },
  ];
  const cache = {
    items: {
      "GB:1.1": { key: "GB:1.1", status: "update", siteNo: "GB/T 1.1-2020", siteYear: 2020, downloadAid: 1, docs: [{ id: "cur" }] },
      "GB:311": { key: "GB:311", status: "not-found", docs: [{ id: "bare" }] },
      "QGDW:1": { key: "QGDW:1", status: "not-found", docs: [{ id: "off" }] },
      "GB:legacy": { key: "GB:legacy", status: "ambiguous", docs: [{ id: "gone" }] },
    },
  };
  const out = classifyCheckCache({ groups, cache, docsById: new Map([["cur", { id: "cur", trust: "low" }]]) });
  assert.equal(out.updates.length, 1);
  assert.deepEqual(out.notFoundOffsite, ["QGDW:1"]);
  assert.deepEqual(out.notFoundOnsite.map((x) => x.key), ["GB:311"]);
  assert.deepEqual(out.legacyKeys, ["GB:legacy"]);
  assert.equal(out.staleGroups.length, 0);
});

test("库内同号旧版：只报未标 low 的旧版", () => {
  const manifest = {
    docs: [
      { id: "new", title: "GB/Z 18039.1-2019 电磁兼容 环境 电磁环境的描述和分类", standardNo: "GB/Z 18039.1-2019", standardYear: 2019, type: "pdf-text", chars: 1000, stage: "published", stageLabel: "发布稿" },
      { id: "old", title: "GB/Z 18039.1-2000 电磁兼容 环境 电磁环境的分类", standardNo: "GB/Z 18039.1-2000", standardYear: 2000, type: "pdf-text", chars: 1000, stage: "published", stageLabel: "发布稿", trust: "high" },
    ],
  };
  const out = detectSupersededNotLow({ manifest, docsById: new Map(manifest.docs.map((d) => [d.id, d])) });
  assert.deepEqual(out.items.map((x) => x.docId), ["old"]);
});

test("renderMarkdown 输出三组与条目", () => {
  const md = renderMarkdown({
    kb: "标准",
    generatedAt: NOW,
    totals: { docs: 3, live: 2, notes: 0, deleted: 1, withStdNo: 2, groups: 2, cacheKeys: 2, status: {} },
    readOnly: { verified: true },
    findings: [
      { group: "auto", code: "cover-prefix", title: "前缀", summary: "1 篇", action: "修复", count: 1, items: [{ id: "a", title: "DL 1-2020", evidence: "封面 DL/T", action: "fix" }] },
      { group: "manual", code: "dup", title: "重复", summary: "1 组", count: 1, items: [] },
      { group: "info", code: "off", title: "站外", summary: "10 组", count: 10, items: [] },
    ],
  });
  assert.match(md, /## 1\. 可自动修正/);
  assert.match(md, /## 2\. 需人工确认/);
  assert.match(md, /## 3\. 仅报告/);
  assert.match(md, /cover-prefix/);
  assert.match(md, /DL 1-2020/);
});


test("封面文本：OCR 的「一」作连字符时也能解析出编号", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-std-cover-text-"));
  try {
    await mkdir(join(root, "markdown", "x"), { recursive: true });
    await writeFile(join(root, "markdown", "x", "x.md"), "# x\nGB/T 3859.2一2013 半导体变流器\n代替 GB/T 3859.2-1993\n", "utf8");
    const text = coverText(root, "x", 700);
    assert.match(text, /3859\.2-2013/);
    assert.deepEqual(coverStdNo(text), { prefix: "GB/T", number: "3859.2", year: 2013 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAudit 在临时知识库上只读并写出报告", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-std-audit-"));
  const out = await mkdtemp(join(tmpdir(), "kb-std-audit-out-"));
  try {
    const kbDir = join(root, "标准");
    await mkdir(join(kbDir, "markdown", "a"), { recursive: true });
    await mkdir(join(kbDir, "sources"), { recursive: true });
    const docs = [
      {
        id: "a",
        title: "GB/T 1.1-2020 标准化工作导则 第1部分：标准化文件的结构和起草规则",
        type: "pdf-text",
        status: "ready",
        chars: 12000,
        summary: "本文件确立了标准化文件的结构及其起草的总体原则和要求。",
        summarySource: "auto",
        trust: "high",
        trustReason: "已发布标准（需按现行/废止再核对）",
        standardNo: "GB/T 1.1-2020",
        standardPrefix: "GB/T",
        standardNumber: "1.1",
        standardYear: 2020,
        stage: "published",
        stageLabel: "发布稿",
        contentIntegrity: "full",
        importedAt: NOW,
      },
    ];
    await writeFile(join(kbDir, "kb.json"), JSON.stringify({ schemaVersion: 3, name: "标准", docs }), "utf8");
    await writeFile(join(kbDir, "schema.md"), "# schema\n", "utf8");
    await writeFile(join(kbDir, "index.md"), "# index\n", "utf8");
    await writeFile(join(kbDir, "log.md"), "# log\n", "utf8");
    await writeFile(join(kbDir, "markdown", "a", "a.md"), "# GB/T 1.1-2020\nGB/T 1.1-2020 标准化工作导则\n本文件确立了标准化文件的结构。\n", "utf8");
    await writeFile(
      join(kbDir, ".std-check.json"),
      JSON.stringify({ items: { "GB:1.1": { key: "GB:1.1", status: "current", siteNo: "GB/T 1.1-2020", siteYear: 2020, docs: [{ id: "a", title: docs[0].title }] } } }),
      "utf8"
    );
    const before = await readFile(join(kbDir, "kb.json"), "utf8");
    const { report, files } = await runAudit({ kbDir, kb: "标准", outDir: out, now: Date.parse(NOW) });
    const after = await readFile(join(kbDir, "kb.json"), "utf8");
    assert.equal(before, after);
    assert.equal(report.readOnly.verified, true);
    assert.ok(files.json && files.markdown);
    assert.match(await readFile(files.markdown, "utf8"), /标准数据只读审计/);
    const json = JSON.parse(await readFile(files.json, "utf8"));
    assert.equal(json.totals.docs, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("runAudit 拒绝把报告写进被检查的知识库", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-std-audit-guard-"));
  try {
    const kbDir = join(root, "标准");
    await mkdir(kbDir, { recursive: true });
    await writeFile(join(kbDir, "kb.json"), JSON.stringify({ schemaVersion: 3, name: "标准", docs: [] }), "utf8");
    await assert.rejects(() => runAudit({ kbDir, kb: "标准", outDir: join(kbDir, "reports"), now: Date.parse(NOW) }), /拒绝把报告写进/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("标准号：IEEE C37.111 字母编号不误报前缀/编号/标题冲突", () => {
  const issues = detectStdNoAnomalies([
    doc("ieee", "IEEE Std C37.111-1999 电力系统暂态数据交换通用格式（COMTRADE）", {
      standardNo: "IEEE C37.111-1999",
      standardPrefix: "IEEE",
      standardNumber: "C37.111",
      standardYear: 1999,
    }),
  ]);
  assert.deepEqual(issues, []);
});
