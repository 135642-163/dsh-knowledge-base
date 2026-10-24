/**
 * 文档生命周期 API：失败详情投影、软删除/恢复、永久删除、失败重试。
 * 全部走 handleApi，写请求带 x-kb-ui + 同源头，与工作台真实请求一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createJobRegistry } from "../lib/web/jobs.js";
import { createKb } from "../lib/kbmeta.js";
import { readManifest, writeManifestAtomic } from "../lib/store.js";

const KB = "标准";
const KB_URL = encodeURIComponent(KB);

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

function docsUrl(suffix = "") {
  return `/kb/api/kbs/${KB_URL}/docs${suffix}`;
}

function docUrl(id, action) {
  return `${docsUrl()}/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
}

/**
 * 三篇资料：
 * - doc1 ready（markdown/history/sources 齐全）
 * - doc2 failed（有 markdown 与 sources/doc2.txt，可恢复/重试）
 * - doc3 importing
 * - doc4 failed 但没有原件（重试应报 SOURCE_MISSING）
 */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-docs-lifecycle-"));
  const kbRoot = join(root, "kb");
  const { dir } = await createKb(kbRoot, { name: KB });
  for (const id of ["doc1", "doc2"]) {
    await mkdir(join(dir, "markdown", id), { recursive: true });
    await writeFile(join(dir, "markdown", id, `${id}.md`), `# ${id}\n\n正文。\n`, "utf8");
  }
  await mkdir(join(dir, "history", "doc1", "v1"), { recursive: true });
  await writeFile(join(dir, "history", "doc1", "v1", "doc1.md"), "# 历史\n", "utf8");
  await mkdir(join(dir, "sources"), { recursive: true });
  await writeFile(join(dir, "sources", "doc1.pdf"), "%PDF-1.4\n", "utf8");
  await writeFile(join(dir, "sources", "doc2.txt"), "失败资料重试后的正文。\n", "utf8");

  const manifest = await readManifest(dir);
  manifest.docs.push(
    {
      id: "doc1",
      title: "电压偏差",
      type: "pdf-text",
      status: "ready",
      pages: 2,
      chars: 12,
      parts: 1,
      sourceFile: "doc1.pdf",
      sourcePath: join(root, "outside", "doc1.pdf"),
      version: 1,
    },
    {
      id: "doc2",
      title: "失败资料",
      type: "pdf-text",
      status: "failed",
      pages: 3,
      chars: 0,
      parts: 1,
      sourceFile: "doc2.txt",
      sourcePath: join(root, "outside", "doc2.txt"),
      error: "解析失败：文件损坏",
      errorAt: "2026-10-01T00:00:00.000Z",
      warnings: ["第 2 页低置信度"],
      version: 0,
    },
    {
      id: "doc3",
      title: "导入中",
      type: "pdf-text",
      status: "importing",
      sourceFile: "doc3.pdf",
      version: 0,
    },
    {
      id: "doc4",
      title: "无原件失败",
      type: "pdf-text",
      status: "failed",
      sourceFile: "doc4.pdf",
      error: "原件读取失败",
      version: 0,
    }
  );
  await writeManifestAtomic(dir, manifest);
  return { root, kbRoot, dir, manifestPath: join(dir, "kb.json") };
}

async function docOf(dir, id) {
  const manifest = await readManifest(dir);
  return (manifest.docs ?? []).find((doc) => doc.id === id) ?? null;
}

async function waitSettled(jobs, id) {
  for (let i = 0; i < 200; i += 1) {
    const job = await jobs.get(id);
    if (job && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not settle");
}

test("docs list/read expose error, sourceFile and errorAt", async () => {
  const { kbRoot } = await setup();
  const list = await call({ kbRoot }, makeReq({ url: docsUrl() }));
  assert.equal(list.res.status, 200);
  const row1 = list.json.docs.find((doc) => doc.id === "doc1");
  const row2 = list.json.docs.find((doc) => doc.id === "doc2");
  assert.equal(row1.error, "");
  assert.equal(row1.sourceFile, "doc1.pdf");
  assert.equal(row1.movedTo, null);
  assert.equal(row2.error, "解析失败：文件损坏");
  assert.equal(row2.sourceFile, "doc2.txt");

  const read = await call({ kbRoot }, makeReq({ url: docUrl("doc2") }));
  assert.equal(read.res.status, 200);
  assert.equal(read.json.error, "解析失败：文件损坏");
  assert.equal(read.json.errorAt, "2026-10-01T00:00:00.000Z");
  assert.deepEqual(read.json.warnings, ["第 2 页低置信度"]);
  assert.equal(read.json.movedTo, null);
  assert.equal(read.json.sourceFile, "doc2.txt");

  // 没有 errorAt 的旧条目返回空串，而不是 undefined。
  const read1 = await call({ kbRoot }, makeReq({ url: docUrl("doc1") }));
  assert.equal(read1.json.error, "");
  assert.equal(read1.json.errorAt, "");
});

test("deleted docs keep movedTo in list/read projections for undo UI", async () => {
  const { kbRoot, dir } = await setup();
  const movedTo = { kb: "目标库", docId: "t1", transferId: "abc123", at: "2026-10-02T00:00:00.000Z" };
  const manifest = await readManifest(dir);
  manifest.docs.push({
    id: "doc5",
    title: "已移走",
    type: "pdf-text",
    status: "deleted",
    deletedAt: "2026-10-02T00:00:00.000Z",
    deletedFromStatus: "ready",
    movedTo,
    version: 1,
  });
  await writeManifestAtomic(dir, manifest);

  const list = await call({ kbRoot }, makeReq({ url: docsUrl("?status=deleted") }));
  assert.equal(list.res.status, 200);
  assert.deepEqual(list.json.docs.map((doc) => doc.id), ["doc5"]);
  assert.deepEqual(list.json.docs[0].movedTo, movedTo);

  const read = await call({ kbRoot }, makeReq({ url: docUrl("doc5") }));
  assert.equal(read.res.status, 200);
  assert.deepEqual(read.json.movedTo, movedTo);
  assert.equal(read.json.deleted, true);
});

test("soft delete accepts ready and failed docs, restore returns the original status", async () => {
  const { kbRoot, dir } = await setup();

  const soft1 = await call({ kbRoot }, makeReq({ method: "POST", url: docUrl("doc1", "delete"), body: {} }));
  assert.equal(soft1.res.status, 200);
  assert.equal(soft1.json.soft, true);
  assert.equal(soft1.json.docId, "doc1");
  assert.ok(soft1.json.deletedAt);

  const soft2 = await call({ kbRoot }, makeReq({ method: "POST", url: docUrl("doc2", "delete"), body: {} }));
  assert.equal(soft2.res.status, 200);

  const d1 = await docOf(dir, "doc1");
  const d2 = await docOf(dir, "doc2");
  assert.equal(d1.status, "deleted");
  assert.equal(d1.deletedFromStatus, "ready");
  assert.ok(d1.deletedAt);
  assert.equal(d2.status, "deleted");
  assert.equal(d2.deletedFromStatus, "failed");
  assert.equal(d2.error, "解析失败：文件损坏");
  assert.equal(d2.errorAt, "2026-10-01T00:00:00.000Z");

  // 默认列表排除已删除；status=deleted 才可见。
  const live = await call({ kbRoot }, makeReq({ url: docsUrl() }));
  assert.equal(live.json.docs.some((doc) => doc.id === "doc1"), false);
  const deleted = await call({ kbRoot }, makeReq({ url: docsUrl("?status=deleted") }));
  assert.deepEqual(deleted.json.docs.map((doc) => doc.id).sort(), ["doc1", "doc2"]);

  const r1 = await call({ kbRoot }, makeReq({ method: "POST", url: docUrl("doc1", "restore") }));
  assert.equal(r1.res.status, 200);
  assert.equal(r1.json.doc.status, "ready");
  assert.equal(r1.json.doc.deleted, false);
  const r2 = await call({ kbRoot }, makeReq({ method: "POST", url: docUrl("doc2", "restore") }));
  assert.equal(r2.res.status, 200);
  assert.equal(r2.json.doc.status, "failed");
  assert.equal(r2.json.doc.error, "解析失败：文件损坏");

  const restored1 = await docOf(dir, "doc1");
  const restored2 = await docOf(dir, "doc2");
  assert.equal(restored1.status, "ready");
  assert.equal(restored1.deletedAt, undefined);
  assert.equal(restored1.deletedFromStatus, undefined);
  assert.equal(restored2.status, "failed");
  assert.equal(restored2.deletedAt, undefined);
  assert.equal(restored2.deletedFromStatus, undefined);
  // 恢复失败文档保留失败原因，工具/工作台还能看到为什么失败。
  assert.equal(restored2.error, "解析失败：文件损坏");
});

test("delete/restore map conflicts and missing docs to 404/409", async () => {
  const { kbRoot } = await setup();

  const importing = await call({ kbRoot }, makeReq({ method: "POST", url: docUrl("doc3", "delete"), body: {} }));
  assert.equal(importing.res.status, 409);
  assert.equal(importing.json.error.code, "DOC_IMPORTING");

  const first = await call({ kbRoot }, makeReq({ method: "POST", url: docUrl("doc1", "delete"), body: {} }));
  assert.equal(first.res.status, 200);
  const again = await call({ kbRoot }, makeReq({ method: "POST", url: docUrl("doc1", "delete"), body: {} }));
  assert.equal(again.res.status, 409);
  assert.equal(again.json.error.code, "DOC_DELETED");

  const missing = await call({ kbRoot }, makeReq({ method: "POST", url: docUrl("nope", "delete"), body: {} }));
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error.code, "DOC_NOT_FOUND");
  const missingRestore = await call({ kbRoot }, makeReq({ method: "POST", url: docUrl("nope", "restore") }));
  assert.equal(missingRestore.res.status, 404);

  const notDeleted = await call({ kbRoot }, makeReq({ method: "POST", url: docUrl("doc2", "restore") }));
  assert.equal(notDeleted.res.status, 409);
  assert.equal(notDeleted.json.error.code, "DOC_NOT_DELETED");
});

test("permanent delete requires the exact trimmed title and removes all artifacts", async () => {
  const { kbRoot, dir } = await setup();

  const wrong = await call({ kbRoot }, makeReq({
    method: "POST",
    url: docUrl("doc1", "delete"),
    body: { permanent: true, confirm: "错误标题" },
  }));
  assert.equal(wrong.res.status, 400);
  assert.equal(wrong.json.error.code, "CONFIRM_REQUIRED");
  assert.match(wrong.json.error.message, /彻底删除需要确认标题：电压偏差/);
  assert.ok(await docOf(dir, "doc1"));

  const missingConfirm = await call({ kbRoot }, makeReq({
    method: "POST",
    url: docUrl("doc1", "delete"),
    body: { permanent: true },
  }));
  assert.equal(missingConfirm.res.status, 400);
  assert.equal(missingConfirm.json.error.code, "CONFIRM_REQUIRED");

  const unknown = await call({ kbRoot }, makeReq({
    method: "POST",
    url: docUrl("nope", "delete"),
    body: { permanent: true, confirm: "nope" },
  }));
  assert.equal(unknown.res.status, 404);
  assert.equal(unknown.json.error.code, "DOC_NOT_FOUND");

  const ok = await call({ kbRoot }, makeReq({
    method: "POST",
    url: docUrl("doc1", "delete"),
    body: { permanent: true, confirm: "  电压偏差  " },
  }));
  assert.equal(ok.res.status, 200);
  assert.equal(ok.json.docId, "doc1");
  assert.equal(ok.json.removed, true);

  assert.equal(await docOf(dir, "doc1"), null);
  assert.equal(existsSync(join(dir, "markdown", "doc1")), false);
  assert.equal(existsSync(join(dir, "history", "doc1")), false);
  const sources = await readdir(join(dir, "sources"));
  assert.equal(sources.some((name) => name.startsWith("doc1")), false);
  // 其他文档不受影响。
  assert.ok(await docOf(dir, "doc2"));
  assert.equal(existsSync(join(dir, "sources", "doc2.txt")), true);
});

test("reparse starts a kb-reparse job with the doc and stored source", async () => {
  const { kbRoot, dir } = await setup();
  const calls = [];
  const started = [];
  const jobs = {
    start(spec) {
      started.push(spec);
      return "reparse-job-1";
    },
  };
  const result = await call(
    {
      kbRoot,
      jobs,
      importConfig: () => ({ ocrModel: "fast" }),
      reparseImpl: async (args) => {
        calls.push(args);
        return { docId: args.doc.id, pages: 3 };
      },
    },
    makeReq({ method: "POST", url: docUrl("doc2", "reparse") })
  );
  assert.equal(result.res.status, 202);
  assert.deepEqual(result.json, { jobId: "reparse-job-1" });
  assert.equal(started.length, 1);
  assert.equal(started[0].kind, "kb-reparse");
  assert.equal(started[0].kb, KB);
  assert.equal(started[0].label, `重试 ${KB}: 失败资料`);

  const outcome = await started[0].run();
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(outcome.result, { docId: "doc2", pages: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dir, dir);
  assert.equal(calls[0].doc.id, "doc2");
  assert.equal(calls[0].doc.status, "failed");
  assert.equal(calls[0].sourcePath, join(dir, "sources", "doc2.txt"));
  assert.deepEqual(calls[0].config, { ocrModel: "fast", forceReparse: true });
});

test("reparse rejects non-failed docs, missing sources and unknown docs", async () => {
  const { kbRoot } = await setup();
  const jobs = { start: () => "unused" };

  const ready = await call({ kbRoot, jobs }, makeReq({ method: "POST", url: docUrl("doc1", "reparse") }));
  assert.equal(ready.res.status, 409);
  assert.equal(ready.json.error.code, "DOC_NOT_FAILED");

  const noSource = await call({ kbRoot, jobs }, makeReq({ method: "POST", url: docUrl("doc4", "reparse") }));
  assert.equal(noSource.res.status, 409);
  assert.equal(noSource.json.error.code, "SOURCE_MISSING");
  assert.equal(noSource.json.error.message, "原件不存在，无法重试");

  const missing = await call({ kbRoot, jobs }, makeReq({ method: "POST", url: docUrl("nope", "reparse") }));
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error.code, "DOC_NOT_FOUND");
});

test("reparse default impl re-imports the stored source and makes the doc ready", async () => {
  const { kbRoot, dir } = await setup();
  const jobs = createJobRegistry();
  const result = await call(
    { kbRoot, jobs, importConfig: () => ({}) },
    makeReq({ method: "POST", url: docUrl("doc2", "reparse") })
  );
  assert.equal(result.res.status, 202);
  assert.ok(result.json.jobId);
  const job = await waitSettled(jobs, result.json.jobId);
  assert.equal(job.status, "succeeded");

  const doc = await docOf(dir, "doc2");
  assert.equal(doc.status, "ready");
  assert.ok(doc.chars > 0);
  assert.ok(existsSync(join(dir, "markdown", "doc2", "doc2.md")));
});

test("document lifecycle POSTs require x-kb-ui and same-origin", async () => {
  const { kbRoot } = await setup();
  const urls = [
    docUrl("doc1", "delete"),
    docUrl("doc1", "restore"),
    docUrl("doc2", "reparse"),
  ];
  for (const url of urls) {
    const noHeader = await call(
      { kbRoot, jobs: { start: () => "job" } },
      makeReq({ method: "POST", url, headers: { "x-kb-ui": "" }, body: {} })
    );
    assert.equal(noHeader.res.status, 403, `${url} without x-kb-ui`);
    const crossOrigin = await call(
      { kbRoot, jobs: { start: () => "job" } },
      makeReq({
        method: "POST",
        url,
        headers: { origin: "http://evil.example", host: "127.0.0.1:55929" },
        body: {},
      })
    );
    assert.equal(crossOrigin.res.status, 403, `${url} cross-origin`);
  }
});
