/**
 * 工作台 kbpack：上传 → 预检（同名三选一）→ 后台导入。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { createJobRegistry } from "../lib/web/jobs.js";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/status", headers = {}, body, raw } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1", ...headers },
    async *[Symbol.asyncIterator]() {
      if (raw !== undefined) yield Buffer.from(raw);
      else if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

async function waitFor(check, { attempts = 200, delay = 10 } = {}) {
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

async function makePack({ kbName = "包库", filename = "资料.txt", title = "包内资料" } = {}) {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    format: "kbpack/v1",
    schemaVersion: 6,
    kbName,
    withSources: false,
    counts: { docs: 1, notes: 0, sourceFiles: 0, contentBytes: 10 },
    docs: [{
      id: "abcdef123456", title, type: "text", stage: "unknown",
      sourceHash: "", textHash: "t", contentHash: "t", chars: 4, pages: 0, parts: 1,
      trust: "unknown", sourceFile: filename, hasSource: false, hasMarkdown: true,
    }],
  }));
  zip.file("markdown/abcdef123456/abcdef123456.md", `# ${title}\n\n正文。\n`);
  return await zip.generateAsync({ type: "nodebuffer" });
}

async function setup({ kbs = [] } = {}) {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-package-web-")), "kb");
  for (const name of kbs) await createKb(kbRoot, { name });
  const jobs = createJobRegistry();
  const opts = {
    kbRoot,
    jobs,
    limits: { maxUploadBytes: 10 * 1024 * 1024, maxBatchFiles: 10, extensions: [".md"] },
    std: { configured: false },
  };
  return { kbRoot, opts, jobs };
}

async function upload(opts, buffer, name = "包.zip") {
  return call(opts, makeReq({
    method: "POST",
    url: `/kb/api/packages?name=${encodeURIComponent(name)}`,
    raw: buffer,
  }));
}

function importUrl(id) {
  return `/kb/api/packages/${id}/import`;
}

test("上传 kbpack：预检返回计数，文件落在 .package-uploads", async () => {
  const { kbRoot, opts } = await setup();
  try {
    const pack = await makePack();
    const { res, json } = await upload(opts, pack);
    assert.equal(res.status, 200);
    assert.match(json.uploadId, /^[0-9a-f]{12}$/);
    assert.equal(json.filename, "包.zip");
    assert.equal(json.ok, true);
    assert.equal(json.dryRun, true);
    assert.equal(json.created, 1);
    assert.equal(json.needsChoice, false);
    assert.equal(json.package.filename, "包.zip");
    const files = await readdir(join(kbRoot, ".package-uploads"));
    assert.ok(files.includes(`${json.uploadId}.zip`));
  } finally {
    await rm(kbRoot, { recursive: true, force: true });
  }
});

test("同名库：预检返回三选一且不写入", async () => {
  const { kbRoot, opts } = await setup({ kbs: ["标准"] });
  try {
    const pack = await makePack({ kbName: "标准" });
    const { json } = await upload(opts, pack);
    assert.equal(json.needsChoice, true);
    assert.deepEqual(json.choices.map((item) => item.mode), ["merge", "rename", "replace"]);
    assert.equal((await readdir(kbRoot)).includes("标准"), true);
  } finally {
    await rm(kbRoot, { recursive: true, force: true });
  }
});

test("确认导入：启动 kb-package 任务并真正落盘", async () => {
  const { kbRoot, opts, jobs } = await setup();
  try {
    const pack = await makePack({ kbName: "包库" });
    const uploaded = await upload(opts, pack);
    const id = uploaded.json.uploadId;
    const { res, json } = await call(opts, makeReq({
      method: "POST",
      url: importUrl(id),
      body: { mode: "merge", kb: "包库" },
    }));
    assert.equal(res.status, 202);
    assert.ok(json.jobId);
    const job = await waitJob(jobs, json.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.result.created, 1);
    assert.ok(job.detail.includes("已导入"));
    const target = join(kbRoot, "包库");
    const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(join(target, "kb.json"), "utf8"));
    assert.equal(manifest.docs.some((doc) => doc.id === "abcdef123456"), true);
    const uploads = await readdir(join(kbRoot, ".package-uploads")).catch(() => []);
    assert.equal(uploads.includes(`${id}.zip`), false, "成功导入后清理上传文件");
  } finally {
    await rm(kbRoot, { recursive: true, force: true });
  }
});

test("replace 无 confirm → 400；非法 uploadId → 400", async () => {
  const { kbRoot, opts } = await setup();
  try {
    const pack = await makePack();
    const uploaded = await upload(opts, pack);
    let result = await call(opts, makeReq({
      method: "POST",
      url: importUrl(uploaded.json.uploadId),
      body: { mode: "replace" },
    }));
    assert.equal(result.res.status, 400);
    assert.equal(result.json.error.code, "CONFIRM_REQUIRED");

    result = await call(opts, makeReq({
      method: "POST",
      url: importUrl("zzzzzzzzzzzz"),
      body: { mode: "merge" },
    }));
    assert.equal(result.res.status, 400);
    assert.equal(result.json.error.code, "INVALID_ARGS");
  } finally {
    await rm(kbRoot, { recursive: true, force: true });
  }
});

test("非 zip 内容拒绝且不残留上传文件", async () => {
  const { kbRoot, opts } = await setup();
  try {
    const { res, json } = await upload(opts, Buffer.from("not a zip"));
    assert.equal(res.status, 400);
    assert.equal(json.error.code, "INVALID_PACKAGE");
    const uploads = await readdir(join(kbRoot, ".package-uploads")).catch(() => []);
    assert.deepEqual(uploads, []);
  } finally {
    await rm(kbRoot, { recursive: true, force: true });
  }
});
