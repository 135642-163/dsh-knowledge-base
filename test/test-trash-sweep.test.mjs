/**
 * 0.25.0 数据治理（任务 1）：回收站自动清理 sweepTrash。
 *  - 超过 trashRetentionDays 的普通软删除资料被彻底删除；
 *  - movedTo 墓碑、缺失/非法 deletedAt、未到期资料一律保留；
 *  - 单篇失败继续，逐库刷新索引；GET /trash/docs 每小时最多触发一次；
 *  - 工作台创建时（registerKbWeb）也会做一次启动清理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, resetTrashSweepForTests, sweepTrash } from "../lib/web/api.js";
import { registerKbWeb } from "../lib/web/server.js";
import { archiveKb, createKb } from "../lib/kbmeta.js";
import { readManifest, removeDoc, writeManifestAtomic } from "../lib/store.js";

/** 固定时钟：所有“几天前”的日期都以它为基准，避免用例随真实时间漂移。 */
const NOW = Date.parse("2026-10-25T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function isoDaysAgo(days) {
  return new Date(NOW - days * DAY).toISOString();
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

function makeReq({ method = "GET", url = "/kb/api/trash/docs", headers = {}, body } = {}) {
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:55929",
      origin: "http://127.0.0.1:55929",
      "x-kb-ui": "1",
      ...headers,
    },
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

async function tempRoot() {
  return join(await mkdtemp(join(tmpdir(), "kb-trash-sweep-")), "kb");
}

function doc(id, title, patch = {}) {
  return { id, title, type: "pdf-text", status: "ready", chars: 10, parts: 1, version: 1, ...patch };
}

function deletedDoc(id, title, deletedAt, patch = {}) {
  return doc(id, title, {
    status: "deleted",
    deletedFromStatus: "ready",
    deletedAt,
    ...patch,
  });
}

async function setupKb(kbRoot, name, docs = []) {
  const { dir } = await createKb(kbRoot, { name });
  if (docs.length > 0) {
    const manifest = await readManifest(dir);
    manifest.docs.push(...docs);
    await writeManifestAtomic(dir, manifest);
  }
  return dir;
}

async function docOf(dir, id) {
  const manifest = await readManifest(dir);
  return (manifest.docs ?? []).find((item) => item.id === id) ?? null;
}

/** 铺 markdown/sources，验证彻底删除会清掉派生产物。 */
async function materialize(dir, id) {
  await mkdir(join(dir, "markdown", id), { recursive: true });
  await writeFile(join(dir, "markdown", id, `${id}.md`), `# ${id}\n\n正文。\n`, "utf8");
  await mkdir(join(dir, "sources"), { recursive: true });
  await writeFile(join(dir, "sources", `${id}.pdf`), "%PDF-1.4\n", "utf8");
}

/** 假宿主上下文：捕获 registerKbWeb 的注入回调（异步启动清理可 await）。 */
function fakeWebCtx() {
  const routes = [];
  let pending = null;
  const ctx = {
    get() { return undefined; },
    inject(names, callback) {
      pending = callback({
        webServer: {
          register(route) {
            routes.push(route);
            return () => {};
          },
        },
        get: ctx.get,
        effect() {},
      });
    },
    effect() {},
    subprocess: { spawn() { throw new Error("unused"); } },
  };
  return {
    ctx,
    routes,
    ready: async () => {
      if (pending) await pending;
    },
  };
}

// ---------------------------------------------------------------------------
// sweepTrash 单元行为
// ---------------------------------------------------------------------------

test("sweepTrash is a no-op when retention days is 0 or negative", async () => {
  resetTrashSweepForTests();
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [
    deletedDoc("old", "旧资料", isoDaysAgo(90)),
  ]);

  for (const days of [0, -1, Number.NaN]) {
    const result = await sweepTrash(kbRoot, { days, now: NOW });
    assert.deepEqual(result, { purged: 0, skipped: 0, capped: false, byKb: {} });
  }
  assert.ok(await docOf(dir, "old"));
  const log = await readFile(join(dir, "log.md"), "utf8");
  assert.equal(log.includes("自动清理"), false);
});

test("sweepTrash purges expired plain docs, logs and refreshes the index", async () => {
  resetTrashSweepForTests();
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [
    deletedDoc("old", "旧资料", isoDaysAgo(90)),
    deletedDoc("recent", "新资料", isoDaysAgo(5)),
    doc("live", "在用资料"),
  ]);
  await materialize(dir, "old");

  const result = await sweepTrash(kbRoot, { days: 30, now: NOW });
  assert.deepEqual(result, { purged: 1, skipped: 0, capped: false, byKb: { 甲库: 1 } });
  assert.equal(await docOf(dir, "old"), null);
  assert.equal(existsSync(join(dir, "markdown", "old")), false);
  assert.equal(existsSync(join(dir, "sources", "old.pdf")), false);
  // 未到期资料与在用资料保持原状。
  assert.equal((await docOf(dir, "recent")).status, "deleted");
  assert.ok(await docOf(dir, "live"));

  const log = await readFile(join(dir, "log.md"), "utf8");
  assert.match(log, /remove\s+旧资料（old）\s+自动清理（超过 30 天）/);
  assert.equal(log.includes("新资料"), false);

  const index = await readFile(join(dir, "index.md"), "utf8");
  assert.match(index, /共 2 篇/);
  assert.equal(index.includes("旧资料"), false);
});

test("sweepTrash keeps moved tombstones, invalid/missing deletedAt and recent rows", async () => {
  resetTrashSweepForTests();
  const kbRoot = await tempRoot();
  const movedTo = { kb: "乙库", docId: "t1", transferId: "abc123", at: isoDaysAgo(91) };
  const dir = await setupKb(kbRoot, "甲库", [
    // 跨库移动的源库墓碑：即使远超过保留期也必须保留，撤销移动还要用。
    deletedDoc("moved", "移动墓碑", isoDaysAgo(90), { movedTo }),
    deletedDoc("invalid", "非法时间", "not-a-date"),
    deletedDoc("missing", "缺少时间", undefined),
    deletedDoc("recent", "保留资料", isoDaysAgo(10)),
  ]);

  const result = await sweepTrash(kbRoot, { days: 30, now: NOW });
  // 只有无法判断年龄的两篇计入 skipped；movedTo 与未到期资料不参与清理。
  assert.deepEqual(result, { purged: 0, skipped: 2, capped: false, byKb: {} });
  assert.deepEqual((await docOf(dir, "moved")).movedTo, movedTo);
  assert.ok(await docOf(dir, "invalid"));
  assert.ok(await docOf(dir, "missing"));
  assert.ok(await docOf(dir, "recent"));
  const log = await readFile(join(dir, "log.md"), "utf8");
  assert.equal(log.includes("自动清理"), false);
});

test("sweepTrash skips merged and archived kbs", async () => {
  resetTrashSweepForTests();
  const kbRoot = await tempRoot();
  const mergedDir = await setupKb(kbRoot, "合并源", [
    deletedDoc("m1", "已合并资料", isoDaysAgo(90)),
  ]);
  const merged = await readManifest(mergedDir);
  merged.mergedInto = "甲库";
  merged.mergedAt = isoDaysAgo(1);
  await writeManifestAtomic(mergedDir, merged);

  const archivedDir = await setupKb(kbRoot, "归档库", [
    deletedDoc("z1", "归档资料", isoDaysAgo(90)),
  ]);
  const trashedTo = await archiveKb(kbRoot, "归档库");

  const result = await sweepTrash(kbRoot, { days: 30, now: NOW });
  assert.deepEqual(result, { purged: 0, skipped: 0, capped: false, byKb: {} });
  assert.ok(await docOf(mergedDir, "m1"));
  assert.equal(existsSync(join(archivedDir, "kb.json")), false);
  const archivedManifest = JSON.parse(await readFile(join(trashedTo, "kb.json"), "utf8"));
  assert.equal(archivedManifest.docs.some((item) => item.id === "z1"), true);
});

test("sweepTrash continues after a per-doc failure and counts it as skipped", async () => {
  resetTrashSweepForTests();
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [
    deletedDoc("old1", "第一篇", isoDaysAgo(90)),
    deletedDoc("old2", "第二篇", isoDaysAgo(90)),
  ]);
  const attempted = [];
  const removeDocImpl = async (kbDir, docId) => {
    attempted.push(docId);
    if (docId === "old2") {
      throw new Error(`EACCES: permission denied, rmdir '${join(kbDir, "markdown", docId)}'`);
    }
    return removeDoc(kbDir, docId);
  };

  const result = await sweepTrash(kbRoot, { days: 30, now: NOW, removeDocImpl });
  assert.deepEqual(result, { purged: 1, skipped: 1, capped: false, byKb: { 甲库: 1 } });
  assert.deepEqual(attempted, ["old1", "old2"]);
  assert.equal(await docOf(dir, "old1"), null);
  assert.ok(await docOf(dir, "old2"));
  const log = await readFile(join(dir, "log.md"), "utf8");
  assert.match(log, /第一篇（old1）\s+自动清理/);
  assert.equal(log.includes("第二篇"), false);
});

test("sweepTrash reports purged counts per kb", async () => {
  resetTrashSweepForTests();
  const kbRoot = await tempRoot();
  await setupKb(kbRoot, "甲库", [
    deletedDoc("a1", "甲一", isoDaysAgo(90)),
    deletedDoc("a2", "甲二", isoDaysAgo(60)),
    deletedDoc("a3", "甲未到期", isoDaysAgo(3)),
  ]);
  await setupKb(kbRoot, "乙库", [
    deletedDoc("b1", "乙一", isoDaysAgo(45)),
    doc("b-live", "乙在用"),
  ]);

  const result = await sweepTrash(kbRoot, { days: 30, now: NOW });
  assert.deepEqual(result, { purged: 3, skipped: 0, capped: false, byKb: { 甲库: 2, 乙库: 1 } });
});

// ---------------------------------------------------------------------------
// API / 启动触发与节流
// ---------------------------------------------------------------------------

test("GET /trash/docs sweeps expired docs at most once per hour per kb root", async () => {
  resetTrashSweepForTests();
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [
    deletedDoc("old1", "第一旧", "2026-08-01T00:00:00.000Z"),
    deletedDoc("recent", "最近", "2026-10-20T00:00:00.000Z"),
  ]);
  await materialize(dir, "old1");

  let clock = NOW;
  const opts = { kbRoot, trashRetentionDays: 30, now: () => clock };

  // 首次列举触发清理：超过 30 天的 old1 被删，未到期的 recent 保留。
  const first = await call(opts, makeReq());
  assert.equal(first.res.status, 200);
  assert.deepEqual(first.json.items.map((item) => item.id), ["recent"]);
  assert.equal(await docOf(dir, "old1"), null);

  // 同一小时内新增的过期条目不会被再次扫描（节流）。
  const manifest = await readManifest(dir);
  manifest.docs.push(deletedDoc("old2", "第二旧", "2026-08-02T00:00:00.000Z"));
  await writeManifestAtomic(dir, manifest);
  clock += 30 * 60 * 1000;
  const second = await call(opts, makeReq());
  assert.equal(second.res.status, 200);
  assert.deepEqual(second.json.items.map((item) => item.id), ["recent", "old2"]);
  assert.ok(await docOf(dir, "old2"));

  // 超过一小时后再次列举：恢复清理。
  clock += 31 * 60 * 1000;
  const third = await call(opts, makeReq());
  assert.equal(third.res.status, 200);
  assert.deepEqual(third.json.items.map((item) => item.id), ["recent"]);
  assert.equal(await docOf(dir, "old2"), null);

  const log = await readFile(join(dir, "log.md"), "utf8");
  assert.equal((log.match(/自动清理（超过 30 天）/g) ?? []).length, 2);
});

test("GET /trash/docs stays read-only when trashRetentionDays is 0", async () => {
  resetTrashSweepForTests();
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [
    deletedDoc("old", "旧资料", "2026-08-01T00:00:00.000Z"),
  ]);

  const { res, json } = await call({ kbRoot, trashRetentionDays: 0, now: NOW }, makeReq());
  assert.equal(res.status, 200);
  assert.deepEqual(json.items.map((item) => item.id), ["old"]);
  assert.ok(await docOf(dir, "old"));
});

test("registerKbWeb runs a startup sweep and shares the hourly throttle", async () => {
  resetTrashSweepForTests();
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [
    deletedDoc("startup-old", "启动旧资料", isoDaysAgo(90)),
    deletedDoc("recent", "最近资料", isoDaysAgo(1)),
  ]);
  await materialize(dir, "startup-old");

  const { ctx, routes, ready } = fakeWebCtx();
  registerKbWeb(ctx, {
    kbRoot,
    uiEnabled: true,
    trashRetentionDays: 30,
    now: () => NOW,
  });
  // 注入回调等待启动清理完成；路由在此前已同步注册。
  await ready();
  assert.equal(await docOf(dir, "startup-old"), null);
  assert.ok(await docOf(dir, "recent"));

  // 启动清理同样计入小时节流：紧接着的 GET 不会再扫一遍。
  const manifest = await readManifest(dir);
  manifest.docs.push(deletedDoc("later", "启动后旧资料", isoDaysAgo(80)));
  await writeManifestAtomic(dir, manifest);
  const route = routes.find((item) => item.path === "/kb/api");
  assert.ok(route, "应注册 /kb/api 路由");
  const res = makeRes();
  await route.handler(makeReq({ url: "/kb/api/trash/docs" }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).items.map((item) => item.id), ["recent", "later"]);
  assert.ok(await docOf(dir, "later"));
});
