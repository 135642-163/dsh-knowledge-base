/**
 * 标准更新：状态推导、结果裁剪、任务校验（无 cookie / 并发 / 非法 action）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { createJobRegistry } from "../lib/web/jobs.js";
import { buildStdEntries, buildStdResult, readStdStatus } from "../lib/web/std.js";

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

async function setup({ configured = true, runStdCheck } = {}) {
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
    },
  };
  return { kbRoot, opts, jobs };
}

async function waitFor(check, { attempts = 100, delay = 10 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("waitFor timeout");
}

function fakeReport() {
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
        k2: { status: "released", checkedAt: now - 2 * 86400000, siteNo: "GB/T 2" },
        k3: { status: "update", checkedAt: now - 10 * 86400000, downloadedAt: "2026-10-14T00:00:00.000Z" },
        k4: { status: "current", checkedAt: now - 9 * 86400000 },
      },
    }),
    "utf8"
  );
  const status = await readStdStatus({ kbDir, kb: "标准", configured: true, ttlDays: 7, now });
  assert.equal(status.cache.items, 4);
  assert.equal(status.pending.update, 1);
  assert.equal(status.pending.released, 1);
  assert.equal(status.pending.downloadable, 2);
  assert.equal(status.cache.valid, true);
  assert.ok(status.cache.ageDays >= 2.9);
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

test("GET /kbs/:name/std 返回状态与 activeJobId", async () => {
  const { opts } = await setup();
  const { res, json } = await call(opts, makeReq({ method: "GET", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std" }));
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
  const bad = await call(opts, makeReq({ method: "POST", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std-check", body: { action: "nope" } }));
  assert.equal(bad.res.status, 400);
  assert.equal(bad.json.error.code, "STD_ACTION_INVALID");

  const noCookie = await call(opts, makeReq({ method: "POST", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std-check", body: { action: "check-download" } }));
  assert.equal(noCookie.res.status, 400);
  assert.equal(noCookie.json.error.code, "STD_NO_COOKIE");

  const check = await call(opts, makeReq({ method: "POST", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std-check", body: { action: "check" } }));
  assert.equal(check.res.status, 202);
  assert.ok(check.json.jobId);
});

test("同一库已有运行中标准任务时 409；完成后结果可读", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { opts } = await setup({
    runStdCheck: async ({ onProgress }) => {
      onProgress({ phase: "check", done: 1, total: 1 });
      await gate;
      return { report: fakeReport(), cache: { items: {} } };
    },
  });
  const first = await call(opts, makeReq({ method: "POST", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std-check", body: { action: "check" } }));
  assert.equal(first.res.status, 202);
  const second = await call(opts, makeReq({ method: "POST", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std-check", body: { action: "check" } }));
  assert.equal(second.res.status, 409);
  assert.equal(second.json.error.code, "STD_JOB_RUNNING");
  release();
  const settled = await waitFor(async () => {
    const job = await opts.jobs.get(first.json.jobId);
    return job && job.status !== "running" ? job : null;
  });
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.result.counts.currents, 1);
  assert.equal(settled.result.entries.length, 2);
});
