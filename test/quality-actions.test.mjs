/**
 * 0.36 P2 质量动作：白名单、dryRun 缺省、单批上限、只读库、逐项结果、
 * 快照开关、后台重解析任务与并发限制。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createJobRegistry } from "../lib/web/jobs.js";
import { createKb } from "../lib/kbmeta.js";
import { kbDirPath, readManifest, restoreDoc, writeManifestAtomic } from "../lib/store.js";
import {
  normalizeQualityActionRequest,
  planQualityAction,
  renderQualityActionPreview,
  runQualityAction,
  QUALITY_ACTION_MAX_BATCH,
} from "../lib/quality-actions.js";

function baseDoc(id, title, extra = {}) {
  return {
    id,
    title,
    type: "pdf-mixed",
    status: "ready",
    pages: 10,
    chars: 1000,
    parts: 1,
    version: 2,
    contentSource: "text",
    outline: [],
    summary: "有摘要",
    tags: [],
    trust: "high",
    updatedAt: "2026-10-01T00:00:00.000Z",
    sourceHash: `hash-${id}`,
    sourceFile: `${id}.pdf`,
    ...extra,
  };
}

function makeDocs() {
  return [
    baseDoc("ok1", "GB/T 1001-2020 坏页样本", {
      pages: 10,
      corruptedPages: [3],
      lowConfidencePages: [5],
      contentIntegrity: "full",
      summary: "",
      trust: undefined,
      sourceFile: "ok1.pdf",
    }),
    baseDoc("ok2", "GB/T 1002-2020 无坏页扫描件", {
      type: "pdf-scanned",
      pages: 5,
      sourceFile: "ok2.pdf",
    }),
    baseDoc("ok3", "GB/T 1003-2020 Word 资料", {
      type: "docx",
      sourceFile: "ok3.docx",
    }),
    baseDoc("fail1", "失败样本", {
      status: "failed",
      error: "解析失败",
      sourceFile: "fail1.pdf",
    }),
    baseDoc("nosrc1", "没有原件的资料", {
      type: "pdf-text",
      corruptedPages: [2],
      sourceFile: "nosrc1.pdf",
    }),
    baseDoc("del1", "已删除资料", {
      status: "deleted",
      deletedAt: "2026-10-02T00:00:00.000Z",
      deletedFromStatus: "ready",
    }),
    baseDoc("imp1", "导入中资料", { status: "importing" }),
    baseDoc("note1", "笔记", { type: "note", kind: "note", sourceFile: "" }),
  ];
}

const SOURCED = ["ok1", "ok2", "fail1", "nosrc1"];

async function makeKb({ readOnly = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kb-quality-actions-"));
  await createKb(root, { name: "质量库" });
  const dir = kbDirPath(root, "质量库");
  const manifest = await readManifest(dir);
  manifest.docs = makeDocs();
  manifest.readOnly = readOnly;
  await writeManifestAtomic(dir, manifest);
  await mkdir(join(dir, "sources"), { recursive: true });
  for (const id of SOURCED) {
    // 真实布局：sources/<id>.pdf + markdown/<id>/<id>.md（restoreDoc 要求内容还在）。
    await mkdir(join(dir, "markdown", id), { recursive: true });
    await writeFile(join(dir, "sources", `${id}.pdf`), "%PDF-1.4 fake\n", "utf8");
    await writeFile(join(dir, "markdown", id, `${id}.md`), `# ${id}\n\n正文\n`, "utf8");
  }
  return { root, dir };
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/status", body } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1" },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitSettled(jobs, id) {
  for (let index = 0; index < 200; index += 1) {
    const job = await jobs.get(id);
    if (job && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not settle");
}

test("请求校验：白名单、ids 上限、dryRun 缺省 true、参数护栏", () => {
  const base = { action: "describe", ids: ["ok1"], params: { summary: "摘要" } };
  assert.equal(normalizeQualityActionRequest(base).dryRun, true, "缺省 dryRun=true");
  assert.equal(normalizeQualityActionRequest({ ...base, dryRun: false }).dryRun, false);
  assert.equal(normalizeQualityActionRequest({ ...base, dryRun: "false" }).dryRun, true, "字符串不是显式 false");

  const invalid = (body, code, status) => {
    assert.throws(
      () => normalizeQualityActionRequest(body),
      (error) => error.code === code && error.status === status
    );
  };
  invalid({ action: "drop-table", ids: ["ok1"] }, "QUALITY_ACTION_INVALID", 400);
  invalid({ action: "describe" }, "QUALITY_ACTION_INVALID", 400);
  invalid({ action: "describe", ids: [] }, "QUALITY_ACTION_INVALID", 400);
  invalid({ action: "describe", ids: ["ok1"] }, "QUALITY_ACTION_INVALID", 400);
  invalid({ action: "describe", ids: ["ok1"], params: { title: "新标题" } }, "QUALITY_ACTION_INVALID", 400);
  invalid({ action: "trust", ids: ["ok1"], params: { level: "critical" } }, "QUALITY_ACTION_INVALID", 400);
  invalid({ action: "remove", ids: ["ok1"], params: { soft: false } }, "QUALITY_ACTION_INVALID", 400);
  invalid({ action: "remove", ids: ["ok1"], params: { permanent: true } }, "QUALITY_ACTION_INVALID", 400);
  invalid({ action: "reparse-pages", ids: ["ok1"], params: { pages: "2,abc" } }, "QUALITY_ACTION_INVALID", 400);
  invalid({ action: "reparse-pages", ids: ["ok1"], params: { ocrModel: "ultra" } }, "QUALITY_ACTION_INVALID", 400);
  invalid({ action: "reparse-pages", ids: ["ok1"], params: { watermark: "max" } }, "QUALITY_ACTION_INVALID", 400);

  const many = { action: "describe", ids: Array.from({ length: QUALITY_ACTION_MAX_BATCH + 1 }, (_, i) => `d${i}`), params: { summary: "x" } };
  invalid(many, "QUALITY_TOO_MANY", 413);

  const normalized = normalizeQualityActionRequest({
    action: "describe",
    ids: ["ok1", "ok1", "ok2"],
    params: { summary: "  范围句  ", tags: "标准, 电能质量" },
  });
  assert.deepEqual(normalized.ids, ["ok1", "ok2"], "重复 id 去重");
  assert.equal(normalized.params.summary, "范围句");
  assert.equal(normalized.params.summarySource, "manual");
  assert.deepEqual(normalized.params.tags, ["标准", "电能质量"]);

  const reparse = normalizeQualityActionRequest({
    action: "reparse-pages",
    ids: ["ok1"],
    params: { pages: "5,3,3", ocrModel: "fast", watermark: "off" },
  });
  assert.deepEqual(reparse.params.pages, [3, 5]);
  assert.equal(reparse.params.forceOcr, false);
  assert.equal(reparse.params.ocrModel, "fast");
  assert.equal(reparse.params.watermark, "off");
});

test("计划：逐篇前置检查区分可执行与不可执行（不写清单）", async () => {
  const { root, dir } = await makeKb();
  try {
    const before = await readFile(join(dir, "kb.json"), "utf8");
    const plan = await planQualityAction({
      dir,
      name: "质量库",
      body: {
        action: "reparse-pages",
        ids: ["ok1", "ok2", "ok3", "note1", "del1", "imp1", "ghost"],
      },
    });
    assert.deepEqual(plan.items.map((item) => item.id), ["ok1"]);
    assert.deepEqual(plan.items[0].preview.pages, [3, 5], "默认取坏页 ∪ 低置信页");
    const errors = new Map(plan.errors.map((item) => [item.id, item.error]));
    assert.equal(errors.get("ok2"), "没有坏页/低置信页；如确认要整篇 OCR，请传 params.forceOcr=true");
    assert.match(errors.get("ok3"), /仅支持 PDF/);
    assert.match(errors.get("note1"), /笔记/);
    assert.match(errors.get("del1"), /已删除/);
    assert.match(errors.get("imp1"), /正在导入/);
    assert.equal(errors.get("ghost"), "文档不存在");
    assert.equal(await readFile(join(dir, "kb.json"), "utf8"), before, "计划阶段零写入");

    const force = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "reparse-pages", ids: ["ok2"], params: { forceOcr: true } },
    });
    assert.equal(force.items.length, 1);
    assert.deepEqual(force.items[0].preview.pages, []);
    assert.equal(force.items[0].preview.forceOcr, true);

    const retry = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "retry-import", ids: ["fail1", "ok1"] },
    });
    assert.deepEqual(retry.items.map((item) => item.id), ["fail1"]);
    assert.match(retry.errors[0].error, /不是导入失败/);

    const preview = renderQualityActionPreview(plan);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.valid, 1);
    assert.equal(preview.invalid, plan.errors.length);
    assert.equal(preview.snapshotSuggested, true);
    assert.match(preview.hint, /不要反复 OCR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("只读库：计划阶段直接 409 KB_READONLY（dryRun 也拒绝）", async () => {
  const { root, dir } = await makeKb({ readOnly: true });
  try {
    for (const dryRun of [true, false]) {
      await assert.rejects(
        planQualityAction({
          dir,
          name: "质量库",
          body: { action: "describe", ids: ["ok1"], params: { summary: "x" }, dryRun },
        }),
        (error) => error.code === "KB_READONLY" && error.status === 409
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("元数据动作：describe/trust/keep 写清单、记日志、不递增内容版本号", async () => {
  const { root, dir } = await makeKb();
  try {
    const describe = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "describe", ids: ["ok1"], params: { summary: "规定了电能质量测量方法", tags: ["电能质量"] }, dryRun: false },
    });
    const described = await runQualityAction({ dir, name: "质量库", plan: describe });
    assert.equal(described.ok, 1);
    assert.equal(described.failed, 0);
    let manifest = await readManifest(dir);
    let doc = manifest.docs.find((item) => item.id === "ok1");
    assert.equal(doc.summary, "规定了电能质量测量方法");
    assert.equal(doc.summarySource, "manual");
    assert.deepEqual(doc.tags, ["电能质量"]);
    assert.equal(doc.version, 2, "编目不改内容版本号");
    let log = await readFile(join(dir, "log.md"), "utf8");
    assert.match(log, /describe/);
    assert.match(log, /质量工作台/);

    const trust = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "trust", ids: ["ok1"], params: { level: "medium", reason: "企业标准" }, dryRun: false },
    });
    const trusted = await runQualityAction({ dir, name: "质量库", plan: trust });
    assert.equal(trusted.ok, 1);
    manifest = await readManifest(dir);
    doc = manifest.docs.find((item) => item.id === "ok1");
    assert.equal(doc.trust, "medium");
    assert.equal(doc.trustSource, "manual");
    assert.equal(doc.trustReason, "企业标准");

    const keep = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "keep", ids: ["ok1"], params: { note: "中英译本" }, dryRun: false },
    });
    const kept = await runQualityAction({ dir, name: "质量库", plan: keep });
    assert.equal(kept.ok, 1);
    manifest = await readManifest(dir);
    doc = manifest.docs.find((item) => item.id === "ok1");
    assert.equal(doc.dedupKeep, true);
    assert.equal(doc.dedupNote, "中英译本");
    assert.ok(doc.dedupReviewedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remove 只做软删除，可恢复；逐项错误不影响其他项", async () => {
  const { root, dir } = await makeKb();
  try {
    const plan = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "remove", ids: ["ok2", "ok1"], dryRun: false },
    });
    assert.equal(plan.items.length, 2);
    // 模拟清单在计划后变化：ok1 已被删除（并发），执行时应逐项报错而不是中断。
    const manifest = await readManifest(dir);
    const target = manifest.docs.find((item) => item.id === "ok1");
    target.status = "deleted";
    target.deletedAt = "2026-10-03T00:00:00.000Z";
    target.deletedFromStatus = "ready";
    await writeManifestAtomic(dir, manifest);

    const outcome = await runQualityAction({ dir, name: "质量库", plan });
    assert.equal(outcome.ok, 1);
    assert.equal(outcome.failed, 1);
    const failed = outcome.results.find((item) => item.id === "ok1");
    assert.equal(failed.ok, false);
    assert.match(failed.error, /已删除/);

    const after = await readManifest(dir);
    const removed = after.docs.find((item) => item.id === "ok2");
    assert.equal(removed.status, "deleted");
    assert.ok(removed.deletedAt);
    await restoreDoc(dir, "ok2");
    const restored = (await readManifest(dir)).docs.find((item) => item.id === "ok2");
    assert.equal(restored.status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("重解析动作：默认坏页、指定页、整篇 OCR 与失败逐项汇总", async () => {
  const { root, dir } = await makeKb();
  try {
    const calls = [];
    const reparse = async ({ doc, config }) => {
      calls.push({ id: doc.id, config });
      if (doc.id === "nosrc1") throw new Error("不应走到这里");
      return { docId: doc.id };
    };

    const byDefault = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "reparse-pages", ids: ["ok1"], dryRun: false },
    });
    const first = await runQualityAction({ dir, name: "质量库", plan: byDefault, reparse });
    assert.equal(first.ok, 1);
    assert.deepEqual(calls[0].config.forceOcrPages, [3, 5]);
    assert.equal(calls[0].config.forceReparse, true);

    const explicit = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "reparse-pages", ids: ["ok1"], params: { pages: "7", ocrModel: "fast" }, dryRun: false },
    });
    await runQualityAction({ dir, name: "质量库", plan: explicit, reparse });
    assert.deepEqual(calls[1].config.forceOcrPages, [7]);
    assert.equal(calls[1].config.ocrModel, "fast");

    const whole = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "reparse-pages", ids: ["ok2"], params: { forceOcr: true, watermark: "off" }, dryRun: false },
    });
    await runQualityAction({ dir, name: "质量库", plan: whole, reparse });
    assert.equal(calls[2].config.forceOcr, true);
    assert.equal(calls[2].config.watermark, "off");

    // nosrc1 没有原件：plan 通过，执行时逐项报错；ok1 继续成功。
    const mixed = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "reparse-pages", ids: ["nosrc1", "ok1"], dryRun: false },
    });
    assert.equal(mixed.items.length, 2);
    const failing = async ({ doc }) => {
      if (doc.id === "ok1") throw new Error(`重解析失败：${doc.title}`);
      return { docId: doc.id };
    };
    const outcome = await runQualityAction({ dir, name: "质量库", plan: mixed, reparse: failing });
    assert.equal(outcome.total, 2);
    assert.equal(outcome.ok, 1);
    assert.equal(outcome.failed, 1);
    assert.match(outcome.results.find((item) => item.ok === false).error, /重解析失败/);

    const retry = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "retry-import", ids: ["fail1"], dryRun: false },
    });
    const retried = await runQualityAction({ dir, name: "质量库", plan: retry, reparse });
    assert.equal(retried.ok, 1);
    assert.equal(calls.at(-1).config.forceReparse, true);
    assert.equal(calls.at(-1).config.forceOcrPages, undefined);
    const log = await readFile(join(dir, "log.md"), "utf8");
    assert.match(log, /reparse/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("快照：plan.snapshot=true 时先留库级快照并记日志", async () => {
  const { root, dir } = await makeKb();
  try {
    const plan = await planQualityAction({
      dir,
      name: "质量库",
      body: { action: "describe", ids: ["ok1"], params: { summary: "摘要", snapshot: true }, dryRun: false },
    });
    const snapshots = [];
    const outcome = await runQualityAction({
      dir,
      name: "质量库",
      plan,
      snapshotImpl: async (snapshotDir, manifest, options) => {
        snapshots.push({ dir: snapshotDir, docs: manifest.docs.length, options });
        return { name: "2026-11-02-00-00-00-pre-quality-describe.zip", bytes: 2048, docs: manifest.docs.length };
      },
    });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].dir, dir);
    assert.equal(snapshots[0].options.label, "pre-quality-describe");
    assert.equal(snapshots[0].options.includeSources, false);
    assert.equal(outcome.ok, 1);
    assert.equal(outcome.snapshot.name, "2026-11-02-00-00-00-pre-quality-describe.zip");
    const log = await readFile(join(dir, "log.md"), "utf8");
    assert.match(log, /snapshot/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP：dryRun 零写入、真实执行写清单、只读 409、超限 413、未知动作 400", async () => {
  const { root, dir } = await makeKb();
  try {
    const opts = { kbRoot: root };
    const before = await readFile(join(dir, "kb.json"), "utf8");
    const preview = await call(opts, makeReq({
      method: "POST",
      url: "/kb/api/kbs/%E8%B4%A8%E9%87%8F%E5%BA%93/quality/actions",
      body: { action: "describe", ids: ["ok1"], params: { summary: "预览摘要" } },
    }));
    assert.equal(preview.res.status, 200);
    assert.equal(preview.json.dryRun, true);
    assert.equal(preview.json.valid, 1);
    assert.equal(await readFile(join(dir, "kb.json"), "utf8"), before, "dryRun 不写清单");

    const executed = await call(opts, makeReq({
      method: "POST",
      url: "/kb/api/kbs/%E8%B4%A8%E9%87%8F%E5%BA%93/quality/actions",
      body: { action: "describe", ids: ["ok1"], params: { summary: "真实摘要" }, dryRun: false },
    }));
    assert.equal(executed.res.status, 200);
    assert.equal(executed.json.ok, 1);
    assert.equal(executed.json.dryRun, false);
    const manifest = await readManifest(dir);
    assert.equal(manifest.docs.find((item) => item.id === "ok1").summary, "真实摘要");

    const tooMany = await call(opts, makeReq({
      method: "POST",
      url: "/kb/api/kbs/%E8%B4%A8%E9%87%8F%E5%BA%93/quality/actions",
      body: {
        action: "describe",
        ids: Array.from({ length: QUALITY_ACTION_MAX_BATCH + 1 }, (_, i) => `d${i}`),
        params: { summary: "x" },
      },
    }));
    assert.equal(tooMany.res.status, 413);
    assert.equal(tooMany.json.error.code, "QUALITY_TOO_MANY");

    const unknown = await call(opts, makeReq({
      method: "POST",
      url: "/kb/api/kbs/%E8%B4%A8%E9%87%8F%E5%BA%93/quality/actions",
      body: { action: "nuke", ids: ["ok1"] },
    }));
    assert.equal(unknown.res.status, 400);
    assert.equal(unknown.json.error.code, "QUALITY_ACTION_INVALID");

    const missingKb = await call(opts, makeReq({
      method: "POST",
      url: "/kb/api/kbs/nope/quality/actions",
      body: { action: "describe", ids: ["ok1"], params: { summary: "x" } },
    }));
    assert.equal(missingKb.res.status, 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP：只读库 409 KB_READONLY（dryRun 也拒绝）", async () => {
  const { root } = await makeKb({ readOnly: true });
  try {
    const opts = { kbRoot: root };
    const response = await call(opts, makeReq({
      method: "POST",
      url: "/kb/api/kbs/%E8%B4%A8%E9%87%8F%E5%BA%93/quality/actions",
      body: { action: "describe", ids: ["ok1"], params: { summary: "x" }, dryRun: false },
    }));
    assert.equal(response.res.status, 409);
    assert.equal(response.json.error.code, "KB_READONLY");

    const preview = await call(opts, makeReq({
      method: "POST",
      url: "/kb/api/kbs/%E8%B4%A8%E9%87%8F%E5%BA%93/quality/actions",
      body: { action: "describe", ids: ["ok1"], params: { summary: "x" } },
    }));
    assert.equal(preview.res.status, 409);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP：重解析走后台任务，同库并发动作 409；缺 jobs 时 409", async () => {
  const { root } = await makeKb();
  try {
    const jobs = createJobRegistry();
    const gate = deferred();
    const calls = [];
    const opts = {
      kbRoot: root,
      jobs,
      reparseImpl: async ({ doc, config }) => {
        calls.push({ id: doc.id, config });
        await gate.promise;
        return { docId: doc.id };
      },
    };
    const url = "/kb/api/kbs/%E8%B4%A8%E9%87%8F%E5%BA%93/quality/actions";
    const started = await call(opts, makeReq({
      method: "POST",
      url,
      body: { action: "reparse-pages", ids: ["ok1"], dryRun: false },
    }));
    assert.equal(started.res.status, 202);
    assert.ok(started.json.jobId);
    assert.equal(started.json.valid, 1);

    const busy = await call(opts, makeReq({
      method: "POST",
      url,
      body: { action: "describe", ids: ["ok1"], params: { summary: "x" }, dryRun: false },
    }));
    assert.equal(busy.res.status, 409);
    assert.equal(busy.json.error.code, "QUALITY_ACTION_RUNNING");

    gate.resolve();
    const job = await waitSettled(jobs, started.json.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.result.ok, 1);
    assert.deepEqual(calls[0].config.forceOcrPages, [3, 5]);

    const noJobs = await call({ kbRoot: root }, makeReq({
      method: "POST",
      url,
      body: { action: "reparse-pages", ids: ["ok1"], dryRun: false },
    }));
    assert.equal(noJobs.res.status, 409);
    assert.equal(noJobs.json.error.code, "QUALITY_JOB_UNAVAILABLE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
