/**
 * 批次导入：查重过滤、批次锁定、任务结算、成功删批次/失败保留。
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
import { importFileInto } from "../lib/pipeline.js";

const LIMITS = { maxUploadBytes: 1024 * 1024, maxBatchFiles: 10, extensions: [".md"] };

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
      if (body !== undefined) yield Buffer.from(String(body));
    },
  };
}

async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

function fakeWorkerSpawn({ exitCode = 0, report = { ok: 1, fail: 0, skip: 0, files: [{ title: "a", status: "ok" }] } } = {}) {
  return (spec) => {
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    (async () => {
      const raw = spec.argv[spec.argv.length - 1];
      const argsFile = raw.startsWith("@") ? raw.slice(1) : null;
      const args = argsFile ? JSON.parse(await readFile(argsFile, "utf8")) : {};
      if (args.progressFile) {
        await writeFile(
          args.progressFile,
          JSON.stringify({ done: 1, total: 1, ok: 1, fail: 0, skip: 0, current: "a.md", files: [{ path: "a.md", status: "ok" }] }),
          "utf8"
        );
      }
      if (args.reportFile) await writeFile(args.reportFile, JSON.stringify(report), "utf8");
      resolveDone({ exitCode, signal: null });
    })();
    return {
      terminate: async () => resolveDone({ exitCode: 0, signal: "SIGTERM" }),
      done,
      collected: {
        stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
      },
    };
  };
}

async function setup({ spawn = fakeWorkerSpawn(), limits = LIMITS } = {}) {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-import-api-")), "kb");
  await createKb(kbRoot, { name: "标准" });
  const opts = {
    kbRoot,
    limits,
    jobs: createJobRegistry(),
    spawn,
    importConfig: () => ({ partMaxChars: 2000 }),
  };
  return { kbRoot, opts };
}

async function createBatch(opts, files) {
  const created = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", body: JSON.stringify({ kb: "标准" }) }));
  const id = created.json.batch.id;
  for (const [path, content] of Object.entries(files)) {
    await call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=${encodeURIComponent(path)}`, body: content }));
  }
  return id;
}

async function waitJob(opts, jobId) {
  for (let i = 0; i < 100; i += 1) {
    const job = await opts.jobs.get(jobId);
    if (job && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not settle");
}

async function waitFor(check, { attempts = 100, delay = 10 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("waitFor timeout");
}

test("成功导入：任务 succeeded、result 带逐文件、批次目录删除", async () => {
  const { kbRoot, opts } = await setup();
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches");
  const id = await createBatch(opts, { "电气/a.md": "# a\n内容\n" });
  const { res, json } = await call(opts, makeReq({
    method: "POST",
    url: `/kb/api/upload-batches/${id}/import`,
    body: JSON.stringify({ ocrModel: "best" }),
  }));
  assert.equal(res.status, 202);
  assert.ok(json.jobId);
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.fail, 0);
  assert.equal(job.result.files[0].status, "ok");
  await waitFor(() => (existsSync(join(dir, id)) ? null : true));
  assert.equal(existsSync(join(dir, id)), false);
});

test("部分失败：任务 succeeded 但 result.fail>0，批次目录保留且状态 failed", async () => {
  const { kbRoot, opts } = await setup({
    spawn: fakeWorkerSpawn({ exitCode: 0, report: { ok: 1, fail: 1, skip: 0, files: [{ title: "a", status: "ok" }, { title: "b", status: "failed", error: "坏文件" }] } }),
  });
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches");
  const id = await createBatch(opts, { "a.md": "# a\n", "b.md": "# b\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.fail, 1);
  assert.equal(JSON.stringify(job).includes(kbRoot), false);
  const batch = await waitFor(async () => {
    try {
      const parsed = JSON.parse(await readFile(join(dir, id, "batch.json"), "utf8"));
      return parsed.status === "failed" ? parsed : null;
    } catch {
      return null;
    }
  });
  assert.equal(batch.status, "failed");
  assert.ok(existsSync(join(dir, id, "progress.json")));
});

test("进程级失败：任务 failed、批次保留", async () => {
  const { kbRoot, opts } = await setup({ spawn: fakeWorkerSpawn({ exitCode: 3 }) });
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches");
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "failed");
  assert.match(job.detail, /进程异常退出/);
  const batch = await waitFor(async () => {
    try {
      const parsed = JSON.parse(await readFile(join(dir, id, "batch.json"), "utf8"));
      return parsed.status === "failed" ? parsed : null;
    } catch {
      return null;
    }
  });
  assert.equal(batch.status, "failed");
});

test("启动进程失败时任务 failed 且响应里没有绝对路径", async () => {
  const { kbRoot, opts } = await setup();
  opts.spawn = () => { throw new Error(`spawn 失败：${kbRoot}/标准/import-tmp/x.json 不存在`); };
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "failed");
  assert.match(job.detail, /启动导入进程失败/);
  assert.equal(job.detail.includes(kbRoot), false);
  assert.equal(JSON.stringify(job.result).includes(kbRoot), false);
});

test("全部重复：jobId 为 null、批次保持 open", async () => {
  const { kbRoot, opts } = await setup();
  const src = join(await mkdtemp(join(tmpdir(), "kb-dup-")), "说明.md");
  await writeFile(src, "# 说明\n内容\n", "utf8");
  // 查重规则：同 relKey → 同 docId → 视为同名文件原位更新，不算重合（lib/dedup.js）。
  // 这里用不同 relKey + 相同标题，让批次文件被判为同库重合。
  await importFileInto(join(kbRoot, "标准"), {
    sourcePath: src,
    relKey: "旧/电气设备安装说明.md",
    title: "电气设备安装说明",
    config: { partMaxChars: 2000 },
  });

  const id = await createBatch(opts, { "电气设备安装说明.md": "# 说明\n内容\n" });
  const { res, json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  assert.equal(res.status, 200);
  assert.equal(json.jobId, null);
  assert.equal(json.status, "empty");
  assert.ok(json.duplicates.length >= 1);
  // 查重命中的 sourcePath 是批次目录绝对路径，响应里不能带出去。
  assert.equal(res.body.includes(kbRoot), false);
  const batch = await call(opts, makeReq({ method: "GET", url: `/kb/api/upload-batches/${id}` }));
  assert.equal(batch.json.batch.status, "open");
});

test("已导入过的批次再次 import 返回 409", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const batchPath = join(kbRoot, "标准", "import-tmp", "ui-batches", id, "batch.json");
  const batch = JSON.parse(await readFile(batchPath, "utf8"));
  batch.status = "importing";
  await writeFile(batchPath, JSON.stringify(batch), "utf8");
  const { res, json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  assert.equal(res.status, 409);
  assert.equal(json.error.code, "BATCH_LOCKED");
});

test("并发 import：一个 202、一个 409（批次锁）", async () => {
  const { opts } = await setup();
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const request = () => call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const [first, second] = await Promise.all([request(), request()]);
  const statuses = [first.res.status, second.res.status].sort();
  assert.deepEqual(statuses, [202, 409]);
  const failed = first.res.status === 409 ? first : second;
  assert.equal(failed.json.error.code, "BATCH_LOCKED");
});

test("空批次 import 返回 400 BATCH_EMPTY", async () => {
  const { opts } = await setup();
  const id = await createBatch(opts, {});
  const { res, json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  assert.equal(res.status, 400);
  assert.equal(json.error.code, "BATCH_EMPTY");
});
