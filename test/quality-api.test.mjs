/**
 * 0.36 P1 质量读模型：分组计数与 kb_lint 一致、证据补齐、延迟加载、
 * 组内筛选/分页、两个补充检查、只读（GET 不写清单）、性能门槛。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { summarizeKb } from "../lib/web/data.js";
import { lintManifest } from "../lib/lint.js";
import { buildQualityReport, countQualityFlags } from "../lib/quality.js";
import { PARSER_VERSION } from "../lib/version.js";

const now = Date.parse("2026-11-02T00:00:00Z");

function baseDoc(id, title, extra = {}) {
  return {
    id,
    title,
    type: "text",
    status: "ready",
    pages: 3,
    chars: 1000,
    parts: 1,
    version: 1,
    contentSource: "text",
    parserVersion: PARSER_VERSION,
    outline: [],
    summary: "有摘要",
    tags: [],
    trust: "high",
    updatedAt: "2026-10-01T00:00:00.000Z",
    sourceHash: `hash-${id}`,
    ...extra,
  };
}

function makeManifest(extra = {}) {
  return {
    schemaVersion: 3,
    name: "质量库",
    readOnly: false,
    docs: [
      // 失败 + 旧管线
      baseDoc("f1", "坏文件", { status: "failed", error: "解析失败: 文件损坏" }),
      baseDoc("s1", "旧管线资料", { parserVersion: "old-pipeline" }),
      // 坏页：一篇有摘要、一篇没摘要（同时落 unlabeled）
      baseDoc("c1", "GB/T 11032-2020 交流避雷器", {
        standardNo: "GB/T 11032-2020",
        type: "pdf-mixed",
        pages: 10,
        corruptedPages: [2],
        lowConfidencePages: [3],
        contentIntegrity: "full",
        trust: "medium",
        ocrConfidence: 92.5,
      }),
      baseDoc("c2", "GB/T 1001-2010 标称电压", {
        standardNo: "GB/T 1001-2010",
        type: "pdf-scanned",
        pages: 20,
        corruptedPages: [7],
        contentIntegrity: "partial",
        summary: "",
      }),
      // 内容完全相同（两个 docId 一条明细）+ 同号同期同阶段重复
      baseDoc("d1", "GB/T 2000-2021 重复样本", { standardNo: "GB/T 2000-2021", sourceHash: "same" }),
      baseDoc("d2", "GB/T 2000-2021 重复样本（副本）", { standardNo: "GB/T 2000-2021", sourceHash: "same" }),
      // 正文不完整（能解析标准号，lint 才统计）
      baseDoc("inc1", "GB/T 528-2009 硫化橡胶", {
        standardNo: "GB/T 528-2009",
        pages: 1,
        summary: "",
        contentIntegrity: "cover-only",
      }),
      // 临时文件
      baseDoc("t1", "~$会议记录.docx", { sourceFile: "~$会议记录.docx" }),
      // 笔记：无来源 / 续
      baseDoc("n1", "旧笔记（续）", {
        type: "note",
        kind: "note",
        sources: [],
        linksOut: [],
        summary: "",
        chars: 20,
      }),
      baseDoc("n2", "有来源但无入链的笔记", {
        type: "note",
        kind: "note",
        sources: ["c1#2"],
        linksOut: [],
        summary: "笔记摘要",
      }),
      // 未编目（有标准号、无摘要）+ 未标可信度
      baseDoc("u1", "GB/T 3000-2019 未编目资料", {
        standardNo: "GB/T 3000-2019",
        summary: "",
      }),
      baseDoc("tu1", "GB/T 4000-2020 未标可信度", {
        standardNo: "GB/T 4000-2020",
        trust: undefined,
      }),
      // 补充检查：摘要噪声 / 无标准号 / 自动生成索引页
      baseDoc("noisy1", "IEC 61000-4-30 电能质量测量方法", {
        type: "pdf-scanned",
        standardNo: "IEC 61000-4-30-2015",
        summary: "Copyright © 2015 IEC. All rights reserved.",
      }),
      baseDoc("nostd1", "电能质量管理办法（暂行） 2023年发改委令第8号", {
        type: "pdf-text",
        standardNo: "",
      }),
      // 标准号字段为空但标题能解析：属于「元数据缺失」（可回填），不是「无标准号」
      baseDoc("titleonly1", "GB/T 5000-2020 只有标题带标准号", { standardNo: "" }),
      baseDoc("idx1", "标准索引（自动生成）", {
        type: "markdown",
        standardNo: "",
        summary: "表格：标准号 / 库内版本 / 名称",
      }),
    ],
    ...extra,
  };
}

const lintOptions = { kbName: "质量库", hasSchema: true, now, staleDays: 90, maxItems: 5000 };

function quality(manifest = makeManifest(), options = {}) {
  return buildQualityReport(manifest, { kbName: "质量库", hasSchema: true, now, ...options });
}

test("分组计数与 kb_lint 逐组一致（判定逻辑只有 lintManifest 一个来源）", () => {
  const manifest = makeManifest();
  const lint = lintManifest(manifest, lintOptions);
  const report = quality(manifest);
  for (const group of lint.groups) {
    const mirrored = report.groups.find((item) => item.code === group.code);
    assert.ok(mirrored, `质量读模型缺少分组 ${group.code}`);
    assert.equal(mirrored.count, group.count, `${group.code} 计数应与 kb_lint 一致`);
    assert.equal(mirrored.severity, group.severity);
    assert.equal(mirrored.label, group.label);
  }
  // 两个补充检查不在 kb_lint 里，单独核对。
  const extraCodes = new Set(report.groups.map((g) => g.code).filter((code) => !lint.groups.some((g) => g.code === code)));
  assert.deepEqual([...extraCodes].sort(), ["no-standard-no", "summary-noise"]);
  assert.equal(report.summary.totalDocs, manifest.docs.length);
  assert.equal(report.summary.readyDocs, 15, "16 篇里 1 篇 failed 不算 ready");
});

test("旧管线组 deferred：默认不返回明细，显式请求才加载", () => {
  const manifest = makeManifest();
  const report = quality(manifest);
  const stale = report.groups.find((group) => group.code === "stale");
  assert.equal(stale.deferred, true);
  assert.equal(stale.count, 1);
  assert.equal(stale.items.length, 0, "deferred 组默认不返回明细");
  assert.equal(report.summary.deferred, 1);
  assert.equal(report.summary.deferredItems, 1);
  assert.ok(report.summary.info > 0);

  const focused = quality(manifest, { group: "stale" });
  assert.equal(focused.groups.length, 1);
  assert.equal(focused.groups[0].items.length, 1);
  assert.equal(focused.groups[0].items[0].docIds[0], "s1");

  const included = quality(manifest, { includeDeferred: true });
  assert.equal(included.groups.find((group) => group.code === "stale").items.length, 1);
});

test("明细证据：坏页/正文完整性/可信度/缺摘要，多篇组展开 docs[]", () => {
  const report = quality(makeManifest());
  const corrupted = report.groups.find((group) => group.code === "corrupted");
  assert.equal(corrupted.count, 2);
  const c1 = corrupted.items.find((item) => item.docId === "c1");
  assert.deepEqual(c1.docIds, ["c1"]);
  assert.equal(c1.pages, 10);
  assert.deepEqual(c1.badPages, [2, 3], "坏页与低置信页合并去重");
  assert.equal(c1.contentIntegrity, "full");
  assert.equal(c1.trust, "medium");
  assert.equal(c1.summaryMissing, false);
  assert.equal(c1.ocrConfidence, 92.5);
  assert.equal(c1.docs.length, 1);
  assert.equal(c1.docs[0].lowConfidencePages.length, 1);

  const c2 = corrupted.items.find((item) => item.docId === "c2");
  assert.equal(c2.summaryMissing, true);
  assert.equal(c2.contentIntegrity, "partial");

  const dupContent = report.groups.find((group) => group.code === "duplicate-content");
  assert.equal(dupContent.items.length, 1);
  const dupItem = dupContent.items[0];
  assert.deepEqual(dupItem.docIds.sort(), ["d1", "d2"]);
  assert.equal(dupItem.docs.length, 2);
  assert.equal(dupItem.pages, undefined, "多篇组不提升单篇证据，避免页码歧义");
  assert.equal(dupItem.docs.find((doc) => doc.id === "d2").title, "GB/T 2000-2021 重复样本（副本）");
});

test("组内分页与搜索：count 是总数，matched 是命中数，truncated 标记截断", () => {
  const manifest = makeManifest();
  const firstPage = quality(manifest, { group: "corrupted", maxItems: 10, limit: 1 });
  assert.equal(firstPage.groups[0].offset, 0);
  assert.equal(firstPage.groups[0].returned, 1);
  assert.equal(firstPage.groups[0].truncated, true, "还有未返回的明细");

  const page = quality(manifest, { group: "corrupted", maxItems: 10, offset: 1, limit: 1 });
  const group = page.groups[0];
  assert.equal(group.count, 2);
  assert.equal(group.matched, 2);
  assert.equal(group.offset, 1);
  assert.equal(group.returned, 1);
  assert.equal(group.truncated, false, "第 2 条是最后一条");

  const capped = quality(manifest, { maxItems: 1 });
  for (const item of capped.groups) {
    assert.ok(item.items.length <= 1, `${item.code} 每组明细不超过 maxItems`);
  }
  assert.equal(capped.groups.find((item) => item.code === "corrupted").count, 2);
  assert.equal(capped.groups.find((item) => item.code === "corrupted").truncated, true);

  const searched = quality(manifest, { group: "duplicate-content", query: "副本" });
  assert.equal(searched.groups[0].count, 1);
  assert.equal(searched.groups[0].matched, 1);
  assert.equal(searched.groups[0].items.length, 1);

  const miss = quality(manifest, { group: "corrupted", query: "不存在的标题" });
  assert.equal(miss.groups[0].matched, 0);
  assert.equal(miss.groups[0].items.length, 0);
});

test("筛选：severity / actionable，摘要计数与卡片一致", () => {
  const manifest = makeManifest();
  const report = quality(manifest);
  const warnings = quality(manifest, { severity: "warning" });
  assert.ok(warnings.groups.length > 0);
  assert.ok(warnings.groups.every((group) => group.severity === "warning"));

  const actionable = quality(manifest, { actionableOnly: true });
  assert.ok(actionable.groups.length > 0);
  assert.ok(actionable.groups.every((group) => group.actionable));
  assert.ok(actionable.groups.every((group) => group.allowedActions.length > 0));
  assert.equal(report.summary.actionableGroups, actionable.groups.length);
  assert.ok(report.summary.actionable >= 3, "可操作组里至少覆盖 f1/c1/c2/d1/d2 等文档");

  const errors = quality(manifest, { severity: "error" });
  assert.equal(errors.groups.length, 1);
  assert.equal(errors.groups[0].code, "failed");
  assert.equal(errors.summary.error, report.summary.error);
});

test("参数钳制：maxItems/offset/limit/staleDays 非法值回落到安全范围", () => {
  const manifest = makeManifest();
  const clamped = quality(manifest, { maxItems: 9999, limit: 9999, offset: -5, staleDays: "abc" });
  assert.ok(clamped.groups.every((group) => group.limit === 200));
  assert.ok(clamped.groups.every((group) => group.offset === 0));
  const zero = quality(manifest, { maxItems: 0 });
  assert.ok(zero.groups.every((group) => group.limit === 1));
  const reported = quality(manifest, { staleDays: 0 });
  assert.equal(reported.summary.generatedAt, new Date(now).toISOString());
});

test("补充检查：摘要噪声排除空摘要，无标准号排除笔记与自动生成索引页", () => {
  const manifest = makeManifest();
  const report = quality(manifest);
  const noisy = report.groups.find((group) => group.code === "summary-noise");
  assert.ok(noisy);
  const noisyIds = noisy.items.flatMap((item) => item.docIds);
  assert.deepEqual(noisyIds, ["noisy1"], "只有非空且命中的摘要进入噪声组");
  assert.equal(noisy.severity, "warning");
  assert.equal(noisy.actionable, true);
  assert.equal(noisy.suggestedAction, "describe");

  const noStd = report.groups.find((group) => group.code === "no-standard-no");
  assert.ok(noStd);
  const noStdIds = noStd.items.flatMap((item) => item.docIds);
  assert.ok(noStdIds.includes("nostd1"));
  assert.ok(!noStdIds.includes("titleonly1"), "标题能解析出标准号 = 元数据缺失，不是无标准号");
  assert.ok(!noStdIds.includes("idx1"), "自动生成索引页不是标准资料");
  assert.ok(!noStdIds.includes("n1"), "笔记不在身份层检查里");
  assert.equal(noStd.actionable, false, "补号必须人工判断，不提供自动动作");

  const flags = countQualityFlags(manifest.docs);
  assert.equal(flags.corruptedDocs, 2);
  assert.equal(flags.contentIncomplete, 2, "c2 partial + inc1 cover-only");
  assert.equal(flags.failed, 1);
  assert.equal(flags.summaryNoise, noisy.count);
  assert.equal(flags.noStandardNo, noStd.count);
  assert.equal(flags.unlabeled, report.groups.find((group) => group.code === "unlabeled").count);
});

test("只读库照常返回质量报告，并透传 readOnly", () => {
  const manifest = makeManifest({ readOnly: true });
  const report = quality(manifest);
  assert.equal(report.readOnly, true);
  assert.equal(report.summary.readOnly, true);
  assert.ok(report.groups.length > 0);
});

test("质量接口：GET 只读，不写清单；未知库 404；查询参数生效", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-quality-api-"));
  try {
    const kbDir = join(root, "质量库");
    await mkdir(kbDir, { recursive: true });
    const manifest = makeManifest();
    await writeFile(join(kbDir, "kb.json"), JSON.stringify(manifest, null, 2), "utf8");
    const before = await readFile(join(kbDir, "kb.json"), "utf8");

    const res = makeRes();
    await handleApi(makeReq({ url: "/kb/api/kbs/%E8%B4%A8%E9%87%8F%E5%BA%93/quality?maxItems=5" }), res, {
      opts: { kbRoot: root },
      fence: () => true,
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.kb, "质量库");
    assert.ok(payload.groups.length > 0);
    assert.equal(payload.summary.readOnly, false);

    const staleOnly = makeRes();
    await handleApi(
      makeReq({ url: "/kb/api/kbs/%E8%B4%A8%E9%87%8F%E5%BA%93/quality?group=stale" }),
      staleOnly,
      { opts: { kbRoot: root }, fence: () => true }
    );
    const stalePayload = JSON.parse(staleOnly.body);
    assert.equal(stalePayload.groups.length, 1);
    assert.equal(stalePayload.groups[0].items.length, 1);

    const missing = makeRes();
    await handleApi(makeReq({ url: "/kb/api/kbs/nope/quality" }), missing, {
      opts: { kbRoot: root },
      fence: () => true,
    });
    assert.equal(missing.status, 404);

    assert.equal(await readFile(join(kbDir, "kb.json"), "utf8"), before, "GET 不得改写 kb.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("总览徽标：summarizeKb 带轻量质量计数", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-quality-badge-"));
  try {
    const kbDir = join(root, "质量库");
    await mkdir(kbDir, { recursive: true });
    await writeFile(join(kbDir, "kb.json"), JSON.stringify(makeManifest(), null, 2), "utf8");
    const summary = await summarizeKb(root, { name: "质量库", dir: "质量库" });
    assert.equal(summary.quality.failed, 1);
    assert.equal(summary.quality.corruptedDocs, 2);
    assert.equal(summary.quality.contentIncomplete, 2);
    assert.equal(summary.quality.summaryNoise, 1);
    assert.equal(summary.docs.ready, 15);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("性能：900 篇混合清单的读模型远低于 500ms 门槛", () => {
  const docs = [];
  for (let index = 0; index < 900; index += 1) {
    const id = index.toString(16).padStart(12, "0");
    const flags = index % 7 === 0
      ? { corruptedPages: [2, 3], type: "pdf-mixed", contentIntegrity: "partial" }
      : index % 11 === 0
        ? { summary: "", standardNo: "", contentIntegrity: "cover-only" }
        : {};
    docs.push(baseDoc(id, `GB/T ${1000 + index}-2020 样本 ${index}`, { standardNo: `GB/T ${1000 + index}-2020`, ...flags }));
  }
  const manifest = { schemaVersion: 3, name: "大库", docs };
  const started = performance.now();
  const report = buildQualityReport(manifest, { kbName: "大库", hasSchema: true, now, maxItems: 50 });
  const elapsed = performance.now() - started;
  assert.equal(report.summary.totalDocs, 900);
  assert.ok(report.groups.length > 0);
  assert.ok(elapsed < 500, `质量读模型耗时 ${elapsed.toFixed(1)}ms，应低于 500ms`);
});

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/status" } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1" },
  };
}
