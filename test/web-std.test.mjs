/**
 * 标准更新：状态推导、结果裁剪、任务校验（无 cookie / 并发 / 非法 action）、
 * 失败去重、导入失败提示与路径净化。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { createJobRegistry } from "../lib/web/jobs.js";
import { buildStdEntries, buildStdResult, readStdStatus } from "../lib/web/std.js";

const KB_API = "/kb/api/kbs/%E6%A0%87%E5%87%86";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/status", headers = {}, body } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1", ...headers },
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

function postStd(opts, body) {
  return call(opts, makeReq({ method: "POST", url: `${KB_API}/std-check`, body }));
}

function postStdFetch(opts, body) {
  return call(opts, makeReq({ method: "POST", url: `${KB_API}/std-fetch`, body }));
}

function getStd(opts) {
  return call(opts, makeReq({ method: "GET", url: `${KB_API}/std` }));
}

function cancelStdJob(opts, id) {
  return call(opts, makeReq({ method: "POST", url: `/kb/api/jobs/${encodeURIComponent(id)}/cancel` }));
}

async function setup({ configured = true, runStdCheck, importDownloadedImpl, fetchStdNumberImpl } = {}) {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-std-")), "kb");
  await createKb(kbRoot, { name: "标准" });
  const jobs = createJobRegistry();
  const opts = {
    kbRoot,
    jobs,
    limits: { maxUploadBytes: 1024, maxBatchFiles: 10, extensions: [".md"] },
    std: {
      configured,
      baseUrl: "https://example.invalid",
      cookie: configured ? "secret-cookie" : "",
      rateMs: 1,
      maxAgeDays: 7,
      importConfig: {},
      ...(runStdCheck ? { runStdCheck } : {}),
      ...(importDownloadedImpl ? { importDownloadedImpl } : {}),
      ...(fetchStdNumberImpl ? { fetchStdNumberImpl } : {}),
    },
  };
  return { kbRoot, kbDir: join(kbRoot, "标准"), opts, jobs };
}

async function waitFor(check, { attempts = 100, delay = 10 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("waitFor timeout");
}

async function waitJob(jobs, id) {
  return waitFor(async () => {
    const job = await jobs.get(id);
    return job && job.status !== "running" ? job : null;
  });
}

function fakeReport(overrides = {}) {
  return {
    totalDocs: 3,
    stdGroups: 2,
    checked: 2,
    fresh: 0,
    deferred: 0,
    updates: [{ key: "k1", number: "GB/T 111", siteNo: "GB/T 111", siteTitle: "新版", siteYear: "2024", docs: [{ year: "2015" }] }],
    draftsReleased: [],
    currents: [{ key: "k2", number: "GB/T 222", siteNo: "GB/T 222", siteTitle: "现行" }],
    notFound: [],
    newerInKb: [],
    downloaded: [{ stdNo: "GB/T 111", file: "GB_T 111.pdf", bytes: 10 }],
    downloadFailed: [],
    authOk: true,
    ...overrides,
  };
}

test("readStdStatus 推导 lastCheckAt/pending/valid 且不含 cookie", async () => {
  const kbDir = await mkdtemp(join(tmpdir(), "kb-std-cache-"));
  const now = Date.parse("2026-10-24T00:00:00.000Z");
  await writeFile(
    join(kbDir, ".std-check.json"),
    JSON.stringify({
      items: {
        k1: { status: "update", checkedAt: now - 3 * 86400000, siteNo: "GB/T 1" },
        k2: { status: "released", checkedAt: now - 10 * 86400000, siteNo: "GB/T 2" },
        k3: { status: "update", checkedAt: now - 12 * 86400000, downloadedAt: "2026-10-14T00:00:00.000Z" },
        k4: { status: "current", checkedAt: now - 86400000 },
      },
    }),
    "utf8"
  );
  const status = await readStdStatus({ kbDir, kb: "标准", configured: true, ttlDays: 7, now });
  assert.equal(status.cache.items, 4);
  assert.equal(status.pending.update, 1);
  assert.equal(status.pending.released, 1);
  assert.equal(status.pending.downloadable, 2);
  // 最新时间来自 current 条目（now - 1d），不是 update 条目：max over all。
  assert.equal(status.cache.lastCheckAt, new Date(now - 86400000).toISOString());
  assert.equal(status.cache.ageDays, 1);
  assert.equal(status.cache.valid, true);
  assert.equal(JSON.stringify(status).includes("cookie"), false);
});

test("buildStdEntries 映射状态、合并下载/导入结果并按上限截断", () => {
  const report = fakeReport();
  const imported = [{ stdNo: "GB/T 111", file: "GB_T 111.pdf", docId: "abc", title: "新版" }];
  const entries = buildStdEntries(report, imported);
  assert.equal(entries.find((e) => e.number === "GB/T 111")?.status, "imported");
  assert.equal(entries.find((e) => e.number === "GB/T 222")?.status, "current");

  const many = { ...fakeReport(), currents: Array.from({ length: 300 }, (_, i) => ({ siteNo: `GB/T ${i}`, siteTitle: "" })) };
  const result = buildStdResult({ report: many, imported: [] });
  assert.equal(result.entries.length, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.counts.currents, 300);
});

test("下载失败的更新/草案合并为一条失败条目，未命中的失败单独保留", () => {
  const report = fakeReport({
    updates: [{ number: "GB/T 111", siteNo: "GB/T 111", siteTitle: "新版", siteYear: "2024", docs: [{ year: "2015" }] }],
    draftsReleased: [{ number: "GB/T 333", siteNo: "GB/T 333", siteTitle: "转正版", siteYear: "2024" }],
    currents: [],
    downloaded: [],
    downloadFailed: [
      { stdNo: "GB/T 111", reason: "金币不足" },
      { stdNo: "GB/T 333", reason: "未登录" },
    ],
  });
  const entries = buildStdEntries(report, []);
  assert.equal(entries.length, 2, JSON.stringify(entries));
  const update = entries.find((e) => e.number === "GB/T 111");
  assert.equal(update?.status, "failed");
  assert.equal(update?.title, "新版");
  assert.equal(update?.message, "金币不足");
  const draft = entries.find((e) => e.number === "GB/T 333");
  assert.equal(draft?.status, "failed");
  assert.equal(draft?.title, "转正版");
  assert.equal(draft?.message, "未登录");

  const standalone = buildStdEntries(
    fakeReport({ updates: [], draftsReleased: [], currents: [], downloaded: [], downloadFailed: [{ stdNo: "GB/T 999", reason: "网络错误" }] }),
    []
  );
  assert.equal(standalone.length, 1);
  assert.equal(standalone[0].status, "failed");
  assert.equal(standalone[0].number, "GB/T 999");
});

test("导入失败计入 counts、映射条目并追加 hint", () => {
  const imported = [{ stdNo: "GB/T 111", file: "GB_T 111.pdf", error: "EACCES: /private/x" }];
  const result = buildStdResult({ report: fakeReport(), imported });
  assert.equal(result.counts.importFailed, 1);
  assert.equal(result.counts.imported, 0);
  const entry = result.entries.find((e) => e.number === "GB/T 111");
  assert.equal(entry?.status, "importFailed");
  assert.equal(entry?.message, "EACCES: /private/x");
  assert.match(result.hint, /有 1 份下载文件导入失败：EACCES: \/private\/x/);
});

test("GET /kbs/:name/std 返回状态与 activeJobId", async () => {
  const { opts } = await setup();
  const { res, json } = await getStd(opts);
  assert.equal(res.status, 200);
  assert.equal(json.kb, "标准");
  assert.equal(json.configured, true);
  assert.equal(json.activeJobId, null);
  assert.equal(json.lastJob, null);
  assert.equal(JSON.stringify(json).includes("secret-cookie"), false);
});

test("std-check 校验 action 与 cookie", async () => {
  const { opts } = await setup({
    configured: false,
    runStdCheck: async ({ onProgress }) => {
      onProgress({ phase: "check", done: 1, total: 1 });
      return { report: fakeReport(), cache: { items: {} } };
    },
  });
  const bad = await postStd(opts, { action: "nope" });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.json.error.code, "STD_ACTION_INVALID");

  const noCookie = await postStd(opts, { action: "check-download" });
  assert.equal(noCookie.res.status, 400);
  assert.equal(noCookie.json.error.code, "STD_NO_COOKIE");

  const check = await postStd(opts, { action: "check" });
  assert.equal(check.res.status, 202);
  assert.ok(check.json.jobId);
});

test("同一库已有运行中标准任务时 409；完成后结果可读", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { opts, jobs } = await setup({
    runStdCheck: async ({ onProgress }) => {
      onProgress({ phase: "check", done: 1, total: 1 });
      await gate;
      return { report: fakeReport(), cache: { items: {} } };
    },
  });
  const first = await postStd(opts, { action: "check" });
  assert.equal(first.res.status, 202);
  const second = await postStd(opts, { action: "check" });
  assert.equal(second.res.status, 409);
  assert.equal(second.json.error.code, "STD_JOB_RUNNING");
  assert.equal(second.json.error.details.jobId, first.json.jobId);
  release();
  const settled = await waitJob(jobs, first.json.jobId);
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.result.counts.currents, 1);
  assert.equal(settled.result.entries.length, 2);
});

test("并发 std-check 只启动一个任务，409 带运行中 jobId", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { opts, jobs } = await setup({
    runStdCheck: async () => {
      await gate;
      return { report: fakeReport(), cache: { items: {} } };
    },
  });
  const [first, second] = await Promise.all([postStd(opts, { action: "check" }), postStd(opts, { action: "check" })]);
  const accepted = [first, second].filter((result) => result.res.status === 202);
  const rejected = [first, second].filter((result) => result.res.status === 409);
  assert.equal(accepted.length, 1, `accepted=${accepted.length}`);
  assert.equal(rejected.length, 1, `rejected=${rejected.length}`);
  assert.equal(rejected[0].json.error.code, "STD_JOB_RUNNING");
  assert.equal(rejected[0].json.error.details.jobId, accepted[0].json.jobId);
  const running = await jobs.list({ kb: "标准", kind: "kb-std" });
  assert.equal(running.filter((job) => job.status === "running").length, 1);
  release();
  const settled = await waitJob(jobs, accepted[0].json.jobId);
  assert.equal(settled.status, "succeeded");
  const after = await jobs.list({ kb: "标准", kind: "kb-std" });
  assert.equal(after.filter((job) => job.status === "running").length, 0);
});

test("std-check 把 force/limit/action/dryRun 转发给 runStdCheck", async () => {
  let captured;
  const { opts, jobs } = await setup({
    runStdCheck: async (params) => {
      captured = params;
      return { report: fakeReport(), cache: { items: {} } };
    },
  });
  const started = await postStd(opts, { action: "check", force: true, limit: 3, dryRun: true });
  assert.equal(started.res.status, 202);
  const settled = await waitJob(jobs, started.json.jobId);
  assert.equal(settled.status, "succeeded");
  assert.equal(captured.force, true);
  assert.equal(captured.limit, 3);
  assert.equal(captured.action, "check");
  assert.equal(captured.dryRun, true);
});

test("GET std 运行中返回 activeJobId，结算后返回 lastJob", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { opts, jobs } = await setup({
    runStdCheck: async () => {
      await gate;
      return { report: fakeReport(), cache: { items: {} } };
    },
  });
  const started = await postStd(opts, { action: "check" });
  assert.equal(started.res.status, 202);
  const running = await getStd(opts);
  assert.equal(running.res.status, 200);
  assert.equal(running.json.activeJobId, started.json.jobId);
  assert.equal(running.json.lastJob, null);
  release();
  const settled = await waitJob(jobs, started.json.jobId);
  assert.equal(settled.status, "succeeded");
  const after = await getStd(opts);
  assert.equal(after.json.activeJobId, null);
  assert.equal(after.json.lastJob.id, started.json.jobId);
  assert.equal(after.json.lastJob.status, "succeeded");
  assert.equal(after.json.lastJob.summary.currents, 1);
});

test("未配置 cookie 时 dryRun 下载仍可启动", async () => {
  const { opts } = await setup({
    configured: false,
    runStdCheck: async () => ({ report: fakeReport(), cache: { items: {} } }),
  });
  const started = await postStd(opts, { action: "check-download", dryRun: true });
  assert.equal(started.res.status, 202);
  assert.ok(started.json.jobId);
});

test("导入进度覆盖跳过文件（done 达到 total，skipped/processed 正确）", async () => {
  const srcDir = await mkdtemp(join(tmpdir(), "kb-std-import-"));
  await writeFile(join(srcDir, "old.txt"), "旧文件内容\n", "utf8");
  await writeFile(join(srcDir, "new.txt"), "新文件内容\n", "utf8");
  const { kbRoot, opts, jobs } = await setup({
    runStdCheck: async () => ({
      report: fakeReport({ downloaded: [{ stdNo: "GB/T 1", file: "old.txt" }, { stdNo: "GB/T 2", file: "new.txt" }] }),
      cache: { items: { k1: { downloadedFile: "old.txt" }, k2: { downloadedFile: "new.txt" } } },
    }),
    importDownloadedImpl: async (_kbDir, _cache, importFile) => {
      const out = [];
      for (const [file, stdNo] of [["old.txt", "GB/T 1"], ["new.txt", "GB/T 2"]]) {
        const result = await importFile(join(srcDir, file), stdNo, {});
        out.push({ stdNo, file, ...(result?.docId ? { docId: result.docId } : {}), ...(result?.skipped ? { skipped: true } : {}) });
      }
      return out;
    },
  });
  const kbDir = join(kbRoot, "标准");
  const manifest = JSON.parse(await readFile(join(kbDir, "kb.json"), "utf8"));
  manifest.docs = [{ id: "old-doc", title: "旧标准", sourceFile: "old.txt", status: "ready" }];
  await writeFile(join(kbDir, "kb.json"), JSON.stringify(manifest), "utf8");

  const started = await postStd(opts, { action: "check-download" });
  assert.equal(started.res.status, 202);
  const settled = await waitJob(jobs, started.json.jobId);
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.result.counts.imported, 1);
  assert.equal(settled.result.counts.importFailed, 0);
  assert.equal(settled.progress.phase, "import");
  assert.equal(settled.progress.done, 2);
  assert.equal(settled.progress.total, 2);
  assert.equal(settled.progress.processed, 2);
  assert.equal(settled.progress.skipped, 1);
  assert.equal(settled.progress.imported, 1);
});

test("导入失败映射条目与 hint，任务结果不含绝对路径", async () => {
  let kbDirRef = "";
  const { kbRoot, opts, jobs } = await setup({
    runStdCheck: async () => ({ report: fakeReport(), cache: { items: { k1: { downloadedFile: "GB_T 111.pdf" } } } }),
    importDownloadedImpl: async () => [
      { stdNo: "GB/T 111", file: "GB_T 111.pdf", error: `EACCES: ${kbDirRef}/GB_T 111.pdf` },
    ],
  });
  kbDirRef = join(kbRoot, "标准");
  const started = await postStd(opts, { action: "check-download" });
  assert.equal(started.res.status, 202);
  const settled = await waitJob(jobs, started.json.jobId);
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.result.counts.importFailed, 1);
  assert.equal(settled.result.counts.imported, 0);
  const entry = settled.result.entries.find((e) => e.number === "GB/T 111");
  assert.equal(entry?.status, "importFailed");
  assert.match(entry?.message ?? "", /EACCES: <path>/);
  assert.match(settled.result.hint, /有 1 份下载文件导入失败：EACCES: <path>/);
  const serialized = JSON.stringify(settled);
  assert.equal(serialized.includes(kbDirRef), false);
  assert.equal(serialized.includes(kbRoot), false);
});

test("检查抛错时任务详情净化绝对路径", async () => {
  let kbDirRef = "";
  const { kbRoot, opts, jobs } = await setup({
    runStdCheck: async () => {
      throw new Error(`站点请求失败 ${kbDirRef}/.std-check.json`);
    },
  });
  kbDirRef = join(kbRoot, "标准");
  const started = await postStd(opts, { action: "check" });
  assert.equal(started.res.status, 202);
  const settled = await waitJob(jobs, started.json.jobId);
  assert.equal(settled.status, "failed");
  assert.equal(settled.detail.includes(kbDirRef), false);
  assert.equal(settled.detail.includes(kbRoot), false);
  assert.match(settled.detail, /<path>/);
});

test("limit 顺延时 result.hint 明确尚未查完", async () => {
  const { opts, jobs } = await setup({
    runStdCheck: async () => ({ report: fakeReport({ deferred: 2, downloaded: [] }), cache: { items: {} } }),
  });
  const started = await postStd(opts, { action: "check" });
  assert.equal(started.res.status, 202);
  const settled = await waitJob(jobs, started.json.jobId);
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.result.counts.deferred, 2);
  assert.match(settled.result.hint, /本轮达 limit 上限/);
  assert.match(settled.result.hint, /尚有 2 组未检查/);
  assert.match(settled.result.hint, /请再次检查续查/);
});

test("std 任务协作取消：状态 cancelled、保留部分结果、跳过导入", async () => {
  let sawStop = false;
  let importCalled = false;
  const { opts, jobs } = await setup({
    runStdCheck: async ({ onProgress, shouldStop }) => {
      onProgress({ phase: "check", done: 0, total: 2 });
      for (let i = 0; i < 400; i += 1) {
        if (shouldStop?.() === true) {
          sawStop = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { report: fakeReport(), cache: { items: {} } };
    },
    importDownloadedImpl: async () => {
      importCalled = true;
      return [];
    },
  });

  const started = await postStd(opts, { action: "check-download" });
  assert.equal(started.res.status, 202);
  await waitFor(async () => {
    const job = await jobs.get(started.json.jobId);
    return job?.status === "running" ? job : null;
  });

  const cancelRes = await cancelStdJob(opts, started.json.jobId);
  assert.equal(cancelRes.res.status, 200);
  assert.equal(cancelRes.json.job.id, started.json.jobId);

  const settled = await waitJob(jobs, started.json.jobId);
  assert.equal(settled.status, "cancelled");
  assert.equal(sawStop, true);
  assert.equal(importCalled, false);
  // 已完成部分保留：report 里的条目依然投影到 result。
  assert.equal(settled.result.counts.checked, 2);
  assert.ok(settled.result.entries.length > 0);
  assert.match(settled.result.hint, /任务已取消/);
  assert.match(settled.result.hint, /已完成的部分保留/);

  // 已结算任务再取消：409 + jobId，不改变终态。
  const again = await cancelStdJob(opts, started.json.jobId);
  assert.equal(again.res.status, 409);
  assert.equal(again.json.error.code, "JOB_NOT_RUNNING");
  assert.equal(again.json.error.details.jobId, started.json.jobId);
  assert.equal((await jobs.get(started.json.jobId)).status, "cancelled");
});

test("取消未知任务 404 JOB_NOT_FOUND", async () => {
  const { opts } = await setup();
  const missing = await cancelStdJob(opts, "kb-std-nope");
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error.code, "JOB_NOT_FOUND");
});

test("std-fetch dryRun：同步校验并返回确认页信息", async () => {
  const calls = [];
  const { opts } = await setup({
    fetchStdNumberImpl: async (args) => {
      calls.push(args);
      return { ok: true, status: "ready", stdNo: args.stdNo, siteStdNo: "GB/T 4728.12-2022", title: "图形符号", costCoins: 2, vipFree: false };
    },
  });
  const { res, json } = await postStdFetch(opts, { stdNo: "GB/T 4728.12-2022", dryRun: true });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.costCoins, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[0].cookie, "secret-cookie");
});

test("std-fetch 参数/登录态校验", async () => {
  const { opts } = await setup({ configured: false });
  let result = await postStdFetch(opts, { dryRun: true });
  assert.equal(result.res.status, 400);
  assert.equal(result.json.error.code, "INVALID_ARGS");
  result = await postStdFetch(opts, { stdNo: "GB/T 1-2020", dryRun: false });
  assert.equal(result.res.status, 400);
  assert.equal(result.json.error.code, "STD_NO_COOKIE");
});

test("std-fetch dryRun=false：启动 kb-std 任务并把结果投影成标准面板形状", async () => {
  const { opts, jobs } = await setup({
    fetchStdNumberImpl: async (args) => {
      args.onProgress?.({ phase: "download", current: "GB/T 4728.12-2022" });
      return {
        ok: true,
        status: "imported",
        stdNo: args.stdNo,
        siteStdNo: "GB/T 4728.12-2022",
        title: "图形符号",
        docId: "doc123",
        downloaded: true,
        costCoins: 0,
        file: { name: "GB_T 4728.12-2022.pdf", bytes: 10 },
      };
    },
  });
  const { res, json } = await postStdFetch(opts, { stdNo: "GB/T 4728.12-2022", dryRun: false });
  assert.equal(res.status, 202);
  assert.ok(json.jobId);
  const job = await waitJob(jobs, json.jobId);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.counts.downloaded, 1);
  assert.equal(job.result.counts.imported, 1);
  assert.equal(job.result.entries[0].status, "imported");
  assert.match(job.result.entries[0].number, /GB\/T 4728\.12/);
  assert.match(job.detail, /已下载并导入/);
});

test("std-fetch 失败结果：任务 failed 且保留原因", async () => {
  const { opts, jobs } = await setup({
    fetchStdNumberImpl: async () => ({
      ok: false,
      status: "confirm-mismatch",
      stdNo: "GB/T 1-2020",
      siteStdNo: "GB/T 1-2020",
      title: "目标",
      reason: "下载确认页与目标标准不一致",
    }),
  });
  const { json } = await postStdFetch(opts, { stdNo: "GB/T 1-2020", dryRun: false });
  const job = await waitJob(jobs, json.jobId);
  assert.equal(job.status, "failed");
  assert.match(job.detail, /不一致/);
  assert.equal(job.result.entries[0].status, "confirm-mismatch");
});
