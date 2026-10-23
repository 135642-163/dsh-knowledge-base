/**
 * 上传批次：创建、raw PUT 落盘、路径/类型/限额校验、丢弃、24h 清扫。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { createJobRegistry } from "../lib/web/jobs.js";

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
  batch.createdAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  await writeFile(batchPath, JSON.stringify(batch), "utf8");
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
