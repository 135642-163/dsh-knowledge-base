/**
 * 批次导入：查重过滤、批次锁定、任务结算、成功删批次/失败保留。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
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

function fakeWorkerSpawn({
  exitCode = 0,
  report = { ok: 1, fail: 0, skip: 0, files: [{ title: "a", status: "ok" }] },
  onArgs,
} = {}) {
  return (spec) => {
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    (async () => {
      const raw = spec.argv[spec.argv.length - 1];
      const argsFile = raw.startsWith("@") ? raw.slice(1) : null;
      const args = argsFile ? JSON.parse(await readFile(argsFile, "utf8")) : {};
      if (onArgs) await onArgs(args);
      if (args.progressFile) {
        await writeFile(
          args.progressFile,
          JSON.stringify({ done: 1, total: 1, ok: 1, fail: 0, skip: 0, current: "a.md", files: [{ path: "a.md", status: "ok" }] }),
          "utf8"
        );
      }
      if (args.reportFile && report !== null) await writeFile(args.reportFile, JSON.stringify(report), "utf8");
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
  assert.equal(job.result.files[0].path, "电气/a.md");
  assert.equal(job.result.files[0].status, "ok");
  await waitFor(() => (existsSync(join(dir, id)) ? null : true));
  assert.equal(existsSync(join(dir, id)), false);
});

test("部分失败：任务 succeeded 但 result.fail>0，批次目录保留且状态 failed", async () => {
  const { kbRoot, opts } = await setup();
  const kbDir = join(kbRoot, "标准");
  // 错误文本里带批次绝对路径，用来验证逐文件 error 的净化确实生效。
  opts.spawn = fakeWorkerSpawn({
    exitCode: 0,
    report: {
      ok: 1,
      fail: 1,
      skip: 0,
      files: [
        { title: "a", status: "ok" },
        { title: "b", status: "failed", error: `坏文件：${kbDir}/import-tmp/ui-batches/x/b.md` },
      ],
    },
  });
  const dir = join(kbDir, "import-tmp", "ui-batches");
  const id = await createBatch(opts, { "a.md": "# a\n", "b.md": "# b\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.fail, 1);
  assert.equal(job.result.files[1].path, "b.md");
  assert.equal(job.result.files[1].status, "failed");
  assert.match(job.result.files[1].error, /<path>/);
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
  const id = await createBatch(opts, { "a.md": "# a\n", "电气/b.md": "# b\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "failed");
  assert.match(job.detail, /启动导入进程失败/);
  assert.equal(job.detail.includes(kbRoot), false);
  assert.equal(JSON.stringify(job.result).includes(kbRoot), false);
  assert.equal(job.result.fail, 2);
  assert.deepEqual(job.result.files.map((file) => file.path), ["a.md", "电气/b.md"]);
  assert.ok(job.result.files.every((file) => file.status === "failed" && file.error));
  // 启动失败后批次不能停在 importing（否则永远无法重试/删除）。
  const batch = await call(opts, makeReq({ method: "GET", url: `/kb/api/upload-batches/${id}` }));
  assert.equal(batch.json.batch.status, "failed");
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

test("启动阶段失败（importConfig 抛错）：500、批次置 failed 且不残留参数文件", async () => {
  const { kbRoot, opts } = await setup();
  const kbDir = join(kbRoot, "标准");
  opts.importConfig = () => { throw new Error(`配置失败：${kbDir}/import-tmp/x.json`); };
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  } finally {
    console.error = originalError;
  }
  assert.equal(result.res.status, 500);
  assert.equal(result.json.error.code, "UPLOAD_FAILED");
  assert.equal(result.res.body.includes(kbRoot), false);
  const batch = await call(opts, makeReq({ method: "GET", url: `/kb/api/upload-batches/${id}` }));
  assert.equal(batch.json.batch.status, "failed");
  const entries = await readdir(join(kbDir, "import-tmp")).catch(() => []);
  assert.deepEqual(entries.filter((name) => name.startsWith("worker-")), []);
});

test("库目录被重命名后导入：用新库名，不复活旧目录", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const oldDir = join(kbRoot, "标准");
  const newName = "新标准";
  const newDir = join(kbRoot, newName);
  await rename(oldDir, newDir);
  const manifestPath = join(newDir, "kb.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = newName;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  // worker 会按 args.kb 落到 <kbRoot>/<kb>：若仍传旧名，旧目录会被重新建出来。
  opts.spawn = fakeWorkerSpawn({
    onArgs: async (args) => {
      await mkdir(join(args.kbRoot, args.kb), { recursive: true });
      await writeFile(join(args.kbRoot, args.kb, "landed.md"), "# landed\n", "utf8");
    },
  });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "succeeded");
  assert.equal(job.kb, newName);
  assert.ok(existsSync(join(newDir, "landed.md")));
  assert.equal(existsSync(oldDir), false);
});

test("worker 未留下逐文件统计：任务 failed、批次保留且状态 failed", async () => {
  const { kbRoot, opts } = await setup({ spawn: fakeWorkerSpawn({ exitCode: 0, report: null }) });
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches");
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "failed");
  assert.match(job.detail, /未取得逐文件统计/);
  assert.equal(job.result.files.length, 1);
  assert.equal(job.result.files[0].path, "a.md");
  assert.equal(job.result.files[0].status, "failed");
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

test("全部跳过（skip>0）：任务 succeeded 但批次保留并置 failed", async () => {
  const { kbRoot, opts } = await setup({
    spawn: fakeWorkerSpawn({ exitCode: 0, report: { ok: 0, fail: 0, skip: 1, files: [{ title: "a", status: "skipped" }] } }),
  });
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches");
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.skip, 1);
  assert.equal(job.result.files[0].status, "skipped");
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

test("查重期间批次被改动：409 BATCH_CHANGED 且批次保持 open", async () => {
  const { opts } = await setup();
  const id = await createBatch(opts, { "a.md": "# a\n" });
  opts.dedup = async ({ files }) => {
    await call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=b.md`, body: "# b\n" }));
    return { kept: files, duplicates: [], similar: [] };
  };
  const { res, json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  assert.equal(res.status, 409);
  assert.equal(json.error.code, "BATCH_CHANGED");
  const batch = await call(opts, makeReq({ method: "GET", url: `/kb/api/upload-batches/${id}` }));
  assert.equal(batch.json.batch.status, "open");
});

test("worker 全部失败（退出码 1）：任务 failed、逐文件 failed、批次保留", async () => {
  const { kbRoot, opts } = await setup({
    spawn: fakeWorkerSpawn({ exitCode: 1, report: { ok: 0, fail: 1, skip: 0, files: [{ title: "a", status: "failed", error: "解析失败" }] } }),
  });
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches");
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.result.fail, 1);
  assert.equal(job.result.files[0].path, "a.md");
  assert.equal(job.result.files[0].status, "failed");
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

test("进程启动前的初始进度：done=0、全部 pending、相对路径", async () => {
  const { kbRoot, opts } = await setup();
  let initial = null;
  opts.spawn = fakeWorkerSpawn({
    onArgs: async (args) => {
      initial = JSON.parse(await readFile(args.progressFile, "utf8"));
    },
  });
  const id = await createBatch(opts, { "电气/a.md": "# a\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "succeeded");
  assert.equal(initial.done, 0);
  assert.equal(initial.total, 1);
  assert.deepEqual(initial.files, [{ path: "电气/a.md", status: "pending" }]);
  assert.equal(JSON.stringify(initial).includes(kbRoot), false);
});
