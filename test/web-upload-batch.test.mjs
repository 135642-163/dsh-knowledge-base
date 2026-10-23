/**
 * 上传批次：创建、raw PUT 落盘、路径/类型/限额校验、丢弃、24h 清扫。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { createJobRegistry } from "../lib/web/jobs.js";
import { markBatchImporting, normalizeLimits, sweepOldBatches } from "../lib/web/upload.js";

const LIMITS = { maxUploadBytes: 1024, maxBatchFiles: 2, extensions: [".md", ".pdf"] };

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

async function* bodyOf(body) {
  if (body !== undefined) yield Buffer.isBuffer(body) ? body : Buffer.from(String(body));
}

function makeReq({ method = "GET", url = "/kb/api/status", headers = {}, body } = {}) {
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
      yield* bodyOf(body);
    },
  };
}

async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

async function setup(limits = LIMITS) {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-upload-")), "kb");
  await createKb(kbRoot, { name: "标准" });
  const opts = { kbRoot, limits, jobs: createJobRegistry() };
  return { kbRoot, opts };
}

async function createBatch(opts) {
  const { json } = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", body: JSON.stringify({ kb: "标准" }) }));
  assert.ok(json?.batch?.id, JSON.stringify(json));
  return json.batch.id;
}

test("POST /upload-batches 创建批次目录并回 limits", async () => {
  const { kbRoot, opts } = await setup();
  const { res, json } = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", body: JSON.stringify({ kb: "标准" }) }));
  assert.equal(res.status, 201);
  assert.match(json.batch.id, /^b-[0-9a-f]{12}$/);
  assert.equal(json.batch.status, "open");
  assert.equal(json.limits.maxBytes, 1024);
  assert.ok(existsSync(join(kbRoot, "标准", "import-tmp", "ui-batches", json.batch.id, "batch.json")));
});

test("POST /upload-batches 对不存在的库返回 404，create:true 时建库", async () => {
  const { opts } = await setup();
  const missing = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", body: JSON.stringify({ kb: "新库" }) }));
  assert.equal(missing.res.status, 404);
  const created = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", body: JSON.stringify({ kb: "新库", create: true }) }));
  assert.equal(created.res.status, 201);
});

test("PUT 落盘保留目录结构并更新 batch.json", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts);
  const url = `/kb/api/upload-batches/${id}/files?path=${encodeURIComponent("电气/说明.md")}`;
  const { res, json } = await call(opts, makeReq({ method: "PUT", url, body: "# 说明\n" }));
  assert.equal(res.status, 200);
  assert.equal(json.path, "电气/说明.md");
  assert.ok(json.size > 0);
  const stored = await readFile(join(kbRoot, "标准", "import-tmp", "ui-batches", id, "电气", "说明.md"), "utf8");
  assert.equal(stored, "# 说明\n");
  const batch = JSON.parse(await readFile(join(kbRoot, "标准", "import-tmp", "ui-batches", id, "batch.json"), "utf8"));
  assert.deepEqual(batch.files.map((f) => f.path), ["电气/说明.md"]);
});

test("PUT 拒绝路径穿越、反斜杠、非法扩展名、超限与超文件数", async () => {
  const { opts } = await setup();
  const id = await createBatch(opts);
  const put = (p, body = "x") =>
    call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=${encodeURIComponent(p)}`, body }));

  assert.equal((await put("../evil.md")).res.status, 400);
  assert.equal((await put("电气\\evil.md")).res.status, 400);
  assert.equal((await put(".hidden")).json.error.code, "UNSUPPORTED_TYPE");
  const big = "a".repeat(2048);
  const tooLarge = await put("big.md", big);
  assert.equal(tooLarge.res.status, 413);
  assert.equal(tooLarge.json.error.code, "UPLOAD_TOO_LARGE");

  assert.equal((await put("a.md")).res.status, 200);
  assert.equal((await put("b.md")).res.status, 200);
  const third = await put("c.md");
  assert.equal(third.res.status, 413);
  assert.equal(third.json.error.code, "BATCH_TOO_MANY_FILES");
});

test("GET/DELETE 批次；锁定状态拒绝写入与删除", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts);
  await call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=a.md`, body: "x" }));
  const got = await call(opts, makeReq({ method: "GET", url: `/kb/api/upload-batches/${id}` }));
  assert.equal(got.res.status, 200);
  assert.equal(got.json.batch.files.length, 1);

  // 手动锁定批次，模拟导入已启动
  const batchPath = join(kbRoot, "标准", "import-tmp", "ui-batches", id, "batch.json");
  const batch = JSON.parse(await readFile(batchPath, "utf8"));
  batch.status = "importing";
  await writeFile(batchPath, JSON.stringify(batch), "utf8");
  const locked = await call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=b.md`, body: "x" }));
  assert.equal(locked.res.status, 409);
  assert.equal((await call(opts, makeReq({ method: "DELETE", url: `/kb/api/upload-batches/${id}` }))).res.status, 409);
});

test("批次 id 非法返回 400，不存在返回 404", async () => {
  const { opts } = await setup();
  assert.equal((await call(opts, makeReq({ method: "GET", url: "/kb/api/upload-batches/nope" }))).res.status, 400);
  assert.equal((await call(opts, makeReq({ method: "GET", url: "/kb/api/upload-batches/b-000000000000" }))).res.status, 404);
});

test("创建新批次时清扫 24 小时前的旧批次", async () => {
  const { kbRoot, opts } = await setup();
  const oldId = await createBatch(opts);
  const oldDir = join(kbRoot, "标准", "import-tmp", "ui-batches", oldId);
  const batchPath = join(oldDir, "batch.json");
  const batch = JSON.parse(await readFile(batchPath, "utf8"));
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  batch.createdAt = old.toISOString();
  batch.updatedAt = old.toISOString();
  await writeFile(batchPath, JSON.stringify(batch), "utf8");
  await utimes(batchPath, old, old);
  await createBatch(opts);
  assert.equal(existsSync(oldDir), false);
});

test("缺 x-kb-ui 或跨源时返回 403", async () => {
  const { opts } = await setup();
  const noHeader = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", headers: { "x-kb-ui": "" }, body: JSON.stringify({ kb: "标准" }) }));
  assert.equal(noHeader.res.status, 403);
  const cross = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", headers: { origin: "http://evil.example" }, body: JSON.stringify({ kb: "标准" }) }));
  assert.equal(cross.res.status, 403);
});

test("清扫：importing 批次有新鲜 progress.json 时保留，双旧时移除", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts);
  const kbDir = join(kbRoot, "标准");
  const dir = join(kbDir, "import-tmp", "ui-batches", id);
  const batchPath = join(dir, "batch.json");
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  const batch = JSON.parse(await readFile(batchPath, "utf8"));
  batch.status = "importing";
  batch.createdAt = old.toISOString();
  batch.updatedAt = old.toISOString();
  await writeFile(batchPath, JSON.stringify(batch), "utf8");
  await utimes(batchPath, old, old);
  const progressPath = join(dir, "progress.json");
  await writeFile(progressPath, "{}", "utf8");
  assert.equal(await sweepOldBatches({ kbDir }), 0);
  assert.equal(existsSync(dir), true);
  await utimes(progressPath, old, old);
  assert.equal(await sweepOldBatches({ kbDir }), 1);
  assert.equal(existsSync(dir), false);
});

test("清扫：open 以最新活动时间为准，failed 按 updatedAt 移除", async () => {
  const { kbRoot, opts } = await setup();
  const kbDir = join(kbRoot, "标准");
  const old = new Date(Date.now() - 30 * 3600 * 1000);

  const openId = await createBatch(opts);
  const openDir = join(kbDir, "import-tmp", "ui-batches", openId);
  const openBatchPath = join(openDir, "batch.json");
  const openBatch = JSON.parse(await readFile(openBatchPath, "utf8"));
  openBatch.createdAt = old.toISOString();
  openBatch.updatedAt = new Date().toISOString();
  await writeFile(openBatchPath, JSON.stringify(openBatch), "utf8");
  assert.equal(await sweepOldBatches({ kbDir }), 0);
  assert.equal(existsSync(openDir), true);

  const failedId = await createBatch(opts);
  const failedDir = join(kbDir, "import-tmp", "ui-batches", failedId);
  const failedBatchPath = join(failedDir, "batch.json");
  const failedBatch = JSON.parse(await readFile(failedBatchPath, "utf8"));
  failedBatch.status = "failed";
  failedBatch.createdAt = new Date().toISOString();
  failedBatch.updatedAt = old.toISOString();
  await writeFile(failedBatchPath, JSON.stringify(failedBatch), "utf8");
  await utimes(failedBatchPath, old, old);
  assert.equal(await sweepOldBatches({ kbDir }), 1);
  assert.equal(existsSync(failedDir), false);
  assert.equal(existsSync(openDir), true);
});

test("缺省 limits 时使用 2 GiB / 1000 个文件默认值", async () => {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-upload-")), "kb");
  await createKb(kbRoot, { name: "标准" });
  const opts = { kbRoot }; // 没有 limits / jobs / spawn
  const status = await call(opts, makeReq({ url: "/kb/api/status" }));
  assert.equal(status.res.status, 200);
  assert.equal(status.json.limits.maxUploadBytes, 2 * 1024 ** 3);
  assert.equal(status.json.limits.maxBatchFiles, 1000);
  assert.ok(status.json.limits.extensions.includes(".md"));

  const created = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", body: JSON.stringify({ kb: "标准" }) }));
  assert.equal(created.res.status, 201);
  assert.equal(created.json.limits.maxBytes, 2 * 1024 ** 3);
  assert.equal(created.json.limits.maxFiles, 1000);
  const id = created.json.batch.id;
  const threeMiB = "a".repeat(3 * 1024 * 1024);
  const put = await call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=big.md`, body: threeMiB }));
  assert.equal(put.res.status, 200);
  assert.equal(put.json.size, 3 * 1024 * 1024);
});

test("normalizeLimits 对 0 / 负数 / NaN / Infinity / 0.4 回退默认值", () => {
  for (const limits of [
    { maxUploadBytes: 0, maxBatchFiles: 0 },
    { maxUploadBytes: -1, maxBatchFiles: -1 },
    { maxUploadBytes: NaN, maxBatchFiles: NaN },
    { maxUploadBytes: Infinity, maxBatchFiles: Infinity },
    { maxUploadBytes: 0.4, maxBatchFiles: 0.4 },
  ]) {
    const normalized = normalizeLimits(limits);
    assert.equal(normalized.maxUploadBytes, 2 * 1024 ** 3, `maxUploadBytes=${limits.maxUploadBytes}`);
    assert.equal(normalized.maxBatchFiles, 1000, `maxBatchFiles=${limits.maxBatchFiles}`);
  }
});

test("markBatchImporting 并发只成功一次，锁定后丢弃返回 409", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts);
  await call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=a.md`, body: "x" }));
  const kbDir = join(kbRoot, "标准");
  const results = await Promise.allSettled([markBatchImporting(kbDir, id), markBatchImporting(kbDir, id)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "BATCH_LOCKED");
  assert.equal(rejected.reason.status, 409);
  const discard = await call(opts, makeReq({ method: "DELETE", url: `/kb/api/upload-batches/${id}` }));
  assert.equal(discard.res.status, 409);
});

test("markBatchImporting 校验空批次与文件快照", async () => {
  const { kbRoot, opts } = await setup();
  const kbDir = join(kbRoot, "标准");
  const emptyId = await createBatch(opts);
  await assert.rejects(markBatchImporting(kbDir, emptyId), (error) => error.code === "BATCH_EMPTY" && error.status === 400);

  const id = await createBatch(opts);
  await call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=a.md`, body: "x" }));
  await assert.rejects(
    markBatchImporting(kbDir, id, { expectedFiles: [{ path: "b.md", size: 1 }] }),
    (error) => error.code === "BATCH_CHANGED" && error.status === 409,
  );
  const locked = await markBatchImporting(kbDir, id, { expectedFiles: [{ path: "a.md", size: 1 }] });
  assert.equal(locked.status, "importing");
});

test("写入失败返回 500 UPLOAD_FAILED 且不回显路径", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts);
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches", id);
  await writeFile(join(dir, "block"), "x", "utf8");
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  let result;
  try {
    result = await call(
      opts,
      makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=${encodeURIComponent("block/x.md")}`, body: "x" }),
    );
  } finally {
    console.error = originalError;
  }
  const { res, json } = result;
  assert.equal(res.status, 500);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "[kb-web] upload failed");
  assert.equal(json.error.code, "UPLOAD_FAILED");
  assert.equal(json.error.message, "上传写入失败");
  assert.ok(!res.body.includes(kbRoot), res.body);
  assert.ok(!res.body.includes(dir), res.body);
  assert.ok(!res.body.includes("ENOTDIR") && !res.body.includes("EEXIST"), res.body);
  const entries = await readdir(dir);
  assert.ok(!entries.some((name) => name.endsWith(".part")), `临时文件未清理: ${entries}`);
  assert.equal(existsSync(join(dir, "block", "x.md")), false);
});

test("DELETE 批次成功并释放目录，之后 GET 返回 404", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts);
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches", id);
  const del = await call(opts, makeReq({ method: "DELETE", url: `/kb/api/upload-batches/${id}` }));
  assert.equal(del.res.status, 200);
  assert.equal(del.json.ok, true);
  assert.equal(existsSync(dir), false);
  const got = await call(opts, makeReq({ method: "GET", url: `/kb/api/upload-batches/${id}` }));
  assert.equal(got.res.status, 404);
  assert.equal(got.json.error.code, "BATCH_NOT_FOUND");
});

test("超限写入不创建父目录也不留临时文件", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts);
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches", id);
  const { res, json } = await call(
    opts,
    makeReq({
      method: "PUT",
      url: `/kb/api/upload-batches/${id}/files?path=${encodeURIComponent("深层/目录/big.md")}`,
      body: "a".repeat(2048),
    }),
  );
  assert.equal(res.status, 413);
  assert.equal(json.error.code, "UPLOAD_TOO_LARGE");
  assert.equal(existsSync(join(dir, "深层")), false);
  assert.deepEqual(await readdir(dir), ["batch.json"]);
});

test("并发 PUT 同一批次的两个文件都落盘", async () => {
  const { opts } = await setup();
  const id = await createBatch(opts);
  const results = await Promise.all([
    call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=a.md`, body: "aa" })),
    call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=b.md`, body: "bb" })),
  ]);
  assert.deepEqual(results.map((result) => result.res.status), [200, 200]);
  const got = await call(opts, makeReq({ method: "GET", url: `/kb/api/upload-batches/${id}` }));
  assert.deepEqual(got.json.batch.files.map((file) => file.path).sort(), ["a.md", "b.md"]);
});

test("路径片段超长/尾部点空格与大小写重复返回 400", async () => {
  const { opts } = await setup();
  const id = await createBatch(opts);
  const put = (path, body = "x") =>
    call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=${encodeURIComponent(path)}`, body }));

  assert.equal((await put(`${"中".repeat(100)}.md`)).res.status, 400);
  assert.equal((await put("bad./x.md")).res.status, 400);
  assert.equal((await put("bad /x.md")).res.status, 400);
  assert.equal((await put("a.md")).res.status, 200);
  const dup = await put("A.MD");
  assert.equal(dup.res.status, 400);
  assert.equal(dup.json.error.code, "UPLOAD_PATH_INVALID");
  assert.match(dup.json.error.message, /大小写重复/);
  assert.equal((await put("a.md", "xyz")).res.status, 200);
  const got = await call(opts, makeReq({ method: "GET", url: `/kb/api/upload-batches/${id}` }));
  assert.equal(got.json.batch.files.length, 1);
});
