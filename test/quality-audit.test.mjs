/**
 * 0.32 质量只读审计：脚本必须能在临时 kbRoot 上覆盖
 * 失败/导入中/临时文件/0 字/极小正文/损坏页/内容层乱码/重复/多版本/
 * 笔记问题/缺 schema/清单损坏，并且**一个字节都不写被扫描的库**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeDerivedText, auditRoot, buildTopActions, aggregateCategories } from "../scripts/quality-audit.mjs";
import { PARSER_VERSION } from "../lib/version.js";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/quality-audit.mjs", import.meta.url));
const NOW = "2026-10-30T12:00:00.000Z";

function doc(id, title, patch = {}) {
  return {
    id,
    title,
    type: "text",
    status: "ready",
    pages: 0,
    chars: 1200,
    parts: 1,
    version: 1,
    importedAt: NOW,
    updatedAt: NOW,
    outline: [],
    warnings: [],
    contentSource: "text",
    parserVersion: PARSER_VERSION,
    sourceHash: `hash-${id}`,
    textHash: `text-${id}`,
    summary: `这是 ${title} 的一行摘要，用来占位；为了让默认摘要足够长、不被当成过短摘要统计，这里多写一些说明文字，确保总长度稳定超过六十个字符。`,
    summarySource: "auto",
    tags: [],
    trust: "medium",
    trustSource: "heuristic",
    standardNo: "",
    standardPrefix: "",
    standardNumber: "",
    standardBase: "",
    standardYear: null,
    standardPart: null,
    standardSource: "none",
    filenameStandardNo: "",
    contentIntegrity: "full",
    bodyChars: 1200,
    clauseCount: 0,
    stage: "published",
    stageLabel: "发布稿",
    dedupKeep: false,
    ...patch,
  };
}

function stdDoc(id, title, standardNo, year, stage = "published") {
  const number = standardNo.replace(/^\S+\s+/, "").split("-")[0];
  return doc(id, title, {
    type: "pdf-text",
    pages: 3,
    standardNo,
    standardPrefix: standardNo.startsWith("GB/T") ? "GB/T" : "GB",
    standardNumber: number,
    standardBase: number.replace(/\.\d+$/, ""),
    standardYear: year,
    standardPart: null,
    standardSource: "content",
    stage,
    stageLabel: stage === "published" ? "发布稿" : "征求意见稿",
  });
}

function note(id, title, patch = {}) {
  return doc(id, title, {
    type: "note",
    kind: "note",
    chars: 300,
    parts: 1,
    sources: [],
    linksOut: [],
    summary: "",
    trust: "medium",
    ...patch,
  });
}

/** 递归指纹：相对路径 → 目录标记 / size:mtime。用来证明扫描没写库。 */
async function treeFingerprint(dir) {
  const out = {};
  async function walk(current, rel) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[`${key}/`] = "dir";
        await walk(full, key);
      } else {
        const info = await stat(full);
        out[key] = `${info.size}:${Math.round(info.mtimeMs)}`;
      }
    }
  }
  await walk(dir, "");
  return out;
}

async function writeManifest(dir, name, docs, extra = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "kb.json"),
    JSON.stringify({ schemaVersion: 6, name, createdAt: NOW, updatedAt: NOW, docs, ...extra }, null, 2),
    "utf8"
  );
}

async function writeDerived(dir, id, text, { parts = 1, pagesJson = null, skipParts = false } = {}) {
  const base = join(dir, "markdown", id);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, `${id}.md`), text, "utf8");
  if (!skipParts) {
    await mkdir(join(base, "parts"), { recursive: true });
    for (let i = 0; i < parts; i += 1) {
      await writeFile(join(base, "parts", `${String(i + 1).padStart(4, "0")}.md`), `分块 ${i + 1}`, "utf8");
    }
  }
  if (pagesJson) {
    await writeFile(join(base, "pages.json"), JSON.stringify(pagesJson), "utf8");
  }
}

/** 造一套覆盖全部分类的问题库；报告目录单独放在 root 之外。 */
async function makeFixture(root, out) {
  const kb = join(root, "体检库");
  const docs = [
    // 导入/状态
    doc("f1", "解析失败的文件", { status: "failed", type: "pdf-scanned", sourceFile: "f1.pdf", error: "文件损坏" }),
    doc("i1", "正在导入的文件", { status: "importing", type: "pdf-scanned", sourceFile: "i1.pdf" }),
    doc("t1", "Office 锁文件", { sourceFile: "~$锁文件.docx", type: "docx" }),
    doc("del1", "已软删除的资料", { deletedAt: NOW, sourceFile: "del1.pdf", type: "pdf-text" }),
    // 内容
    doc("z1", "空文件", { chars: 0, parts: 0, type: "pdf-scanned", sourceFile: "z1.pdf" }),
    doc("s1", "GB/T 528-2009 极小正文", {
      chars: 20, type: "pdf-scanned", sourceFile: "s1.pdf", contentIntegrity: "cover-only",
      standardNo: "GB/T 528-2009", standardPrefix: "GB/T", standardNumber: "528",
      standardBase: "528", standardYear: 2009, standardSource: "content",
    }),
    doc("c1", "清单标注坏页的扫描件", {
      chars: 5000, pages: 5, type: "pdf-scanned", sourceFile: "c1.pdf",
      corruptedPages: [2], lowConfidencePages: [3], contentSource: "ocr",
    }),
    doc("x1", "内容层丢字的资料", { chars: 5000, pages: 2, type: "pdf-text", sourceFile: "x1.pdf" }),
    doc("x2", "内容层私用区字符的资料", { chars: 6000, pages: 2, type: "pdf-text", sourceFile: "x2.pdf" }),
    doc("partial1", "GB 1234-2020 只有封面", {
      chars: 900, type: "pdf-text", sourceFile: "partial1.pdf", contentIntegrity: "partial",
      standardNo: "GB 1234-2020", standardPrefix: "GB", standardNumber: "1234",
      standardBase: "1234", standardYear: 2020, standardSource: "content",
    }),
    // 编译层
    doc("m1", "未编目资料", { summary: "", sourceHash: "", type: "pdf-text", sourceFile: "m1.pdf" }),
    doc("g1", "乱码摘要资料", { summary: "摘要抄到了正文乱码 \uFFFD\uFFFD\uFFFD" }),
    doc("thin1", "摘要太短的资料", { summary: "太短了" }),
    doc("u1", "未标可信度资料", { trust: "unknown", trustSource: "unknown" }),
    doc("p1", "手工摘要资料", { summarySource: "manual", summary: "手工摘要：这是人工写的一行摘要，不能被批量脚本覆盖。" }),
    // 标题/身份
    doc("q1", "GB/T 1234-2020 风电场电能质量", { type: "pdf-text", sourceFile: "q1.pdf" }),
    doc("cl1", "1. 带电检测作业指导书", { type: "docx", sourceFile: "cl1.docx" }),
    doc("r1", "重复标题资料", { type: "doc", sourceFile: "r1.doc" }),
    doc("r2", "重复标题资料", { type: "pdf", sourceFile: "r2.pdf" }),
    // 已用 kb_keep 标记「已核对保留」的同标题文档：不再报重复
    doc("v1", "保留的双份资料", { type: "docx", sourceFile: "v1.docx", dedupKeep: true }),
    doc("v2", "保留的双份资料", { type: "pdf", sourceFile: "v2.pdf", dedupKeep: true }),
    doc("l1", "旧管线产物", { parserVersion: "2020-01-01.0" }),
    doc("pm1", "分块数不一致资料", { parts: 2 }),
    // 重复
    doc("h1", "同一文件 A", { sourceHash: "same-hash", type: "pdf-text", sourceFile: "h1.pdf" }),
    doc("h2", "同一文件 B", { sourceHash: "same-hash", type: "pdf-text", sourceFile: "h2.pdf" }),
    doc("d1", "同一正文 A", { textHash: "same-text", type: "pdf-text", sourceFile: "d1.pdf" }),
    doc("d2", "同一正文 B", { textHash: "same-text", type: "pdf-text", sourceFile: "d2.pdf" }),
    // 两篇只有封面（20 字）的残件正文指纹相同：属噪声，不能算「正文重复」
    doc("t2", "残件甲", { textHash: "same-tiny", chars: 20, contentIntegrity: "cover-only", type: "pdf-text", sourceFile: "t2.pdf" }),
    doc("t3", "残件乙", { textHash: "same-tiny", chars: 20, contentIntegrity: "cover-only", type: "pdf-text", sourceFile: "t3.pdf" }),
    // 同号：同期同阶段重复 + 多版本 + 过程稿
    stdDoc("n1", "GB/T 11032-2020 交流避雷器", "GB/T 11032-2020", 2020),
    stdDoc("n2", "GB/T 11032-2020 交流避雷器（副本）", "GB/T 11032-2020", 2020),
    stdDoc("n3", "GB/T 11032-2013 交流避雷器", "GB/T 11032-2013", 2013),
    stdDoc("n4", "GB/T 11032-2020 征求意见稿", "GB/T 11032-2020", 2020, "comment"),
    // 笔记
    note("k1", "没有来源的笔记"),
    note("k2", "旧笔记（续）", { sources: ["d1#1"] }),
    note("k3", "孤页笔记", { sources: ["d1#1"], linksOut: ["h1"] }),
  ];
  // md1 完全没有派生目录 → derived-missing
  docs.push(doc("md1", "派生文件丢失的资料", { type: "pdf-text", sourceFile: "md1.pdf" }));

  await writeManifest(kb, "体检库", docs);
  await writeFile(join(kb, "schema.md"), "# 维护规范\n", "utf8");
  await mkdir(join(kb, "sources"), { recursive: true });

  // 派生层：默认建好，特殊文档单独处理
  const skipDerived = new Set(["md1", "z1", "pm1"]);
  for (const item of docs) {
    if (item.id === "del1") continue;
    if (skipDerived.has(item.id)) continue;
    await writeDerived(kb, item.id, `# ${item.title}\n\n正文内容\n`, { pagesJson: null });
  }
  await writeDerived(kb, "z1", "", { skipParts: true });
  await writeDerived(kb, "pm1", "# 分块不一致\n\n正文\n", { parts: 1 });
  // 内容层乱码：第 2 页 3 个 U+FFFD
  await writeDerived(kb, "x1", `# x1\n\n### 第 1 页\n正常内容\n### 第 2 页\n坏字\uFFFD\uFFFD\uFFFD结尾\n`, {
    parts: 1,
    pagesJson: [{ page: 1, source: "text-layer", corrupted: false, confidence: null }],
  });
  // 内容层私用区字符：2 页各 3 个
  await writeDerived(
    kb,
    "x2",
    `# x2\n\n### 第 1 页\n公式\uE000\uE001\uE002\n### 第 2 页\n再一个\uE003\uE004\uE005\n`,
    { parts: 1 }
  );
  // 分块数不一致后不覆盖 pm1（parts=2 但磁盘只有 1 块）
  await writeFile(join(kb, "markdown", "pm1", "pm1.md"), "# 分块不一致\n\n正文\n", "utf8");

  // 孤儿原件（清单里没有）
  await writeFile(join(kb, "sources", "deadbeef.pdf"), "orphan", "utf8");

  // 空库：没有 schema
  await writeManifest(join(root, "空库"), "空库", []);
  await mkdir(join(root, "空库", "sources"), { recursive: true });

  // 坏库：kb.json 不是合法 JSON
  const broken = join(root, "坏库");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "kb.json"), "{ not valid json", "utf8");

  return { kb, out };
}

test("analyzeDerivedText counts U+FFFD / PUA per page and ignores known ligature hyphens", () => {
  const text = [
    "# 标题",
    "### 第 1 页",
    "正常\uE011内容", // E011 是已知连字符，不算私用区
    "### 第 2 页",
    "坏\uFFFD坏\uFFFD坏\uFFFD",
    "### 第 3 页",
    "公式\uE000\uE001\uE002",
  ].join("\n");
  const result = analyzeDerivedText(text);
  assert.equal(result.fffd, 3);
  assert.equal(result.pua, 3);
  assert.deepEqual(
    result.pages.map((page) => page.page),
    [2, 3]
  );
  assert.equal(result.pages[0].fffd, 3);
  assert.equal(result.pages[1].pua, 3);
});

test("analyzeDerivedText never throws on empty / non-string input", () => {
  assert.deepEqual(analyzeDerivedText("").pages, []);
  assert.equal(analyzeDerivedText(null).chars, 0);
  assert.equal(analyzeDerivedText(undefined).fffd, 0);
});

test("quality-audit writes a report without touching the scanned knowledge base", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-quality-audit-"));
  let out = "";
  try {
    out = await mkdtemp(join(tmpdir(), "kb-quality-audit-out-"));
    const { kb } = await makeFixture(root, out);
    const before = await treeFingerprint(join(root, "体检库"));
    const beforeEmpty = await treeFingerprint(join(root, "空库"));

    const report = await auditRoot({ root, out, maxItems: 50 });

    // 1) 只读：库目录指纹完全一致，且报告没有写进库里
    assert.deepEqual(await treeFingerprint(join(root, "体检库")), before);
    assert.deepEqual(await treeFingerprint(join(root, "空库")), beforeEmpty);
    assert.equal(report.readOnly.verified, true);
    assert.deepEqual(report.readOnly.changedKbs, []);
    assert.equal(report.readOnly.before["体检库"] !== undefined, true);

    // 2) 报告文件落盘且可解析
    assert.equal(report.files.json.startsWith(out), true, "报告应写在 --out 指定的目录");
    const parsed = JSON.parse(await readFile(report.files.json, "utf8"));
    assert.equal(parsed.report, "kb-quality-audit");
    assert.equal(parsed.readOnly.verified, true);
    const markdown = await readFile(report.files.markdown, "utf8");
    assert.match(markdown, /Top 10 建议动作/);
    assert.match(markdown, /只读校验/);
    assert.match(markdown, /回滚手册/);

    // 3) 关键分类计数
    const counts = report.counts;
    assert.equal(counts["kb-manifest-unreadable"], 1, "坏库应单独报出来");
    assert.equal(counts.failed, 1);
    assert.equal(counts.importing, 1);
    assert.equal(counts["deleted-soft"], 1);
    assert.equal(counts["temp-files"], 1);
    assert.equal(counts["schema-missing"], 1, "空库没有 schema");
    assert.equal(counts["zero-content"], 1);
    assert.equal(counts["tiny-content"], 3, "s1 + 两篇 20 字残件");
    assert.equal(counts["content-incomplete"], 2, "cover-only 的 s1 + partial 的 partial1");
    assert.equal(counts["content-fffd"], 1, "内容层 U+FFFD");
    assert.equal(counts["content-pua"], 1, "只统计私用区；E011 不算");
    assert.equal(counts.corrupted, 1, "清单标注的坏页/低置信页");
    assert.equal(counts["summary-missing"], 1);
    assert.equal(counts["summary-garbled"], 1);
    assert.equal(counts["summary-thin"], 2, "thin1 + p1 的手工短摘要（手工摘要只统计、不批改）");
    assert.equal(counts["title-standard-without-meta"], 1);
    assert.equal(counts["title-cleanup"], 1);
    assert.equal(counts["title-duplicate"], 1, "r1/r2 一组；v1/v2 已 kb_keep 不再计入");
    assert.equal(counts["duplicate-content"], 1);
    assert.equal(counts["duplicate-text"], 1, "20 字残件的相同指纹不算正文重复");
    assert.equal(counts["same-number"], 1, "只算同期同阶段的发布稿");
    assert.equal(counts["same-number-multi-year"], 1);
    assert.equal(counts["same-number-stages"], 1);
    assert.equal(counts["note-no-sources"], 1);
    assert.equal(counts.supersedeHint ?? counts["supersede-hint"], 1);
    assert.equal(counts["orphan-note"], 2, "k2 与 k3 都没有任何笔记入链");
    assert.equal(counts["trust-unknown"], 1);
    assert.equal(counts.stale, 1);
    assert.equal(counts["derived-missing"], 2, "md1 没有派生目录；z1 合并文件为空");
    assert.equal(counts["parts-mismatch"], 1);
    assert.equal(counts["orphan-source"], 1);
    assert.equal(counts["manual-protected"], 1, "p1 的手工摘要必须被列出");
    assert.ok(counts["metadata-missing"] >= 2, "m1 缺 sourceHash、q1 有标准号但无结构化元数据");

    // 4) 手工数据清单
    assert.equal(report.manualProtected.summary.length, 1);
    assert.equal(report.manualProtected.summary[0].docId, "p1");

    // 5) Top 动作：内容层 U+FFFD 排第一，且含回滚与快照要求
    assert.equal(report.topActions[0].code, "content-fffd");
    assert.ok(report.topActions[0].snapshot.length > 0);
    assert.ok(report.topActions[0].rollback.length > 0);
    assert.ok(report.topActions.length <= 10);

    // 6) 每个分类都带分区与建议动作（报告可行动）
    for (const category of report.categories) {
      assert.ok(category.section, `${category.code} 缺分区`);
      assert.ok(category.action, `${category.code} 缺建议动作`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("quality-audit refuses to write reports inside the scanned root", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-quality-audit-guard-"));
  try {
    await makeFixture(root, join(root, "guard-out"));
    await assert.rejects(
      () => auditRoot({ root, out: join(root, "体检库", "reports") }),
      /拒绝把报告写进被扫描的知识库根目录/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality-audit tolerates a root whose kbs are all unreadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-quality-audit-broken-"));
  try {
    await mkdir(join(root, "坏库"), { recursive: true });
    await writeFile(join(root, "坏库", "kb.json"), "not json", "utf8");
    const out = await mkdtemp(join(tmpdir(), "kb-quality-audit-broken-out-"));
    const report = await auditRoot({ root, out });
    await rm(out, { recursive: true, force: true });
    assert.equal(report.totals.kbs, 1);
    assert.equal(report.counts["kb-manifest-unreadable"], 1);
    assert.equal(report.readOnly.verified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality-audit aggregates categories and ranks actions deterministically", () => {
  const categories = aggregateCategories([
    {
      name: "甲",
      categories: [
        { code: "content-fffd", label: "x", severity: "warning", section: "content", count: 2, items: [] },
        { code: "content-fffd", label: "x", severity: "warning", section: "content", count: 1, items: [] },
        { code: "trust-unknown", label: "y", severity: "info", section: "compiled", count: 5, items: [] },
      ],
    },
    {
      name: "乙",
      categories: [
        { code: "content-fffd", label: "x", severity: "warning", section: "content", count: 4, items: [] },
      ],
    },
  ]);
  const fffd = categories.find((category) => category.code === "content-fffd");
  assert.equal(fffd.count, 7);
  assert.deepEqual(fffd.kbCounts, { 甲: 3, 乙: 4 });
  // warning 排在 info 前面
  assert.equal(categories[0].code, "content-fffd");
  const top = buildTopActions(categories, 10);
  assert.equal(top[0].code, "content-fffd");
  assert.equal(top[0].count, 7);
  assert.equal(top.find((action) => action.code === "trust-unknown")?.rank, 2);
});

test("quality-audit script only imports read-only store helpers", async () => {
  const source = await readFile(SCRIPT_PATH, "utf8");
  const storeImport = /import \{([^}]+)\} from "\.\.\/lib\/store\.js"/.exec(source);
  assert.ok(storeImport, "应当显式 import store 的只读助手");
  assert.deepEqual(
    storeImport[1].split(",").map((name) => name.trim()).filter(Boolean).sort(),
    ["expandRoot", "tryReadManifest"]
  );
  // 绝不调用写清单/写文档/删除/锁函数（按调用点判断；注释里提到名字不算）
  for (const forbidden of [
    "writeManifestAtomic",
    "readManifest",
    "commitDoc",
    "softDeleteDoc",
    "removeDoc",
    "restoreDoc",
    "touchDoc",
    "updateDocMetaLocked",
    "withManifestLock",
    "markImporting",
    "renameKb",
    "removeKbDir",
    "snapshotKb",
    "listKbs",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\b${forbidden}\\s*\\(`),
      `${forbidden}() 只能在修复脚本里出现`
    );
  }
});
