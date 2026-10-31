/**
 * 工作台导出 API：POST /kbs/:kb/export → 后台任务 → /exports/:file 下载。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { createJobRegistry } from "../lib/web/jobs.js";
import { importFileInto } from "../lib/pipeline.js";
import { readManifest } from "../lib/store.js";

function makeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.status = 0;
  res.headers = {};
  res.chunks = chunks;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  return res;
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
  if (!res.writableFinished) {
    await new Promise((resolve) => {
      res.once("finish", resolve);
      res.once("close", resolve);
    });
  }
  const raw = Buffer.concat(res.chunks);
  return { res, raw, json: raw.length > 0 && /json/.test(res.headers?.["content-type"] ?? "") ? JSON.parse(raw.toString("utf8")) : null };
}
async function waitFor(check, { attempts = 300, delay = 10 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("timeout");
}
async function waitJob(jobs, id) {
  return waitFor(async () => {
    const job = await jobs.get(id);
    return job && job.status !== "running" ? job : null;
  });
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-export-web-"));
  const kbRoot = join(root, "kb");
  const { dir } = await createKb(kbRoot, { name: "标准" });
  const src = join(root, "资料.txt");
  await writeFile(src, "导出测试正文。\n", "utf8");
  await importFileInto(dir, { sourcePath: src, relKey: "资料.txt", title: "导出资料", config: { partMaxChars: 500 } });
  const jobs = createJobRegistry();
  const opts = { kbRoot, jobs, limits: { maxUploadBytes: 10 * 1024 * 1024, maxBatchFiles: 10, extensions: [".md"] } };
  return { root, kbRoot, dir, jobs, opts };
}

const KB_API = "/kb/api/kbs/%E6%A0%87%E5%87%86";

test("导出 zip：后台任务、文件落 exports，下载路由可读", async () => {
  const { root, dir, jobs, opts } = await setup();
  try {
    const started = await call(opts, makeReq({
      method: "POST",
      url: `${KB_API}/export`,
      body: { format: "zip" },
    }));
    assert.equal(started.res.status, 202);
    const job = await waitJob(jobs, started.json.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.result.format, "zip");
    assert.ok(job.result.bytes > 0);
    assert.match(job.result.url, /\/exports\//);
    const file = await readFile(join(dir, "exports", job.result.fileName));
    assert.ok(file.length > 0);
    const download = await call(opts, makeReq({ method: "GET", url: job.result.url }));
    assert.equal(download.res.status, 200);
    assert.match(download.res.headers["content-disposition"], /attachment/);
    assert.ok(download.raw.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("导出 md 且 includeSources 只对 zip 生效；非法 format 400", async () => {
  const { root, jobs, opts } = await setup();
  try {
    const md = await call(opts, makeReq({ method: "POST", url: `${KB_API}/export`, body: { format: "md", includeSources: true } }));
    const job = await waitJob(jobs, md.json.jobId);
    assert.equal(job.result.format, "md");
    assert.equal(job.result.includeSources, false);

    const bad = await call(opts, makeReq({ method: "POST", url: `${KB_API}/export`, body: { format: "pdf" } }));
    assert.equal(bad.res.status, 400);
    assert.equal(bad.json.error.code, "INVALID_ARGS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("导出下载拒绝目录穿越", async () => {
  const { root, opts } = await setup();
  try {
    const result = await call(opts, makeReq({
      method: "GET",
      url: `/kb/api/kbs/%E6%A0%87%E5%87%86/exports/..%2Fkb.json`,
    }));
    assert.equal(result.res.status, 400);
    assert.equal(result.json.error.code, "INVALID_ARGS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("导出可只包含选中的文档", async () => {
  const { root, dir, jobs, opts } = await setup();
  try {
    const src2 = join(root, "第二篇.txt");
    await writeFile(src2, "第二篇正文。\n", "utf8");
    await importFileInto(dir, { sourcePath: src2, relKey: "第二篇.txt", title: "第二篇资料", config: { partMaxChars: 500 } });
    const manifest = await readManifest(dir);
    const first = manifest.docs.find((doc) => doc.title === "导出资料");
    assert.ok(first);
    const started = await call(opts, makeReq({
      method: "POST",
      url: `${KB_API}/export`,
      body: { format: "zip", docIds: [first.id] },
    }));
    const job = await waitJob(jobs, started.json.jobId);
    assert.equal(job.status, "succeeded");
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(join(dir, "exports", job.result.fileName)));
    const pack = JSON.parse(await zip.file("manifest.json").async("string"));
    assert.equal(pack.counts.docs, 1);
    assert.equal(pack.docs[0].id, first.id);
    assert.ok(zip.file(`markdown/${first.id}/${first.id}.md`));
    assert.equal(zip.file("markdown/" + manifest.docs.find((doc) => doc.id !== first.id && doc.type !== "note").id), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
