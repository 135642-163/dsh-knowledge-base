/**
 * 0.31.2 语义检索设置 API：GET/PUT /kb/api/semantic、POST /prepare（同意 + 后台任务）。
 * 用临时 kbRoot 与临时模型目录；不装依赖、不联网。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createJobRegistry } from "../lib/web/jobs.js";
import { readSemanticEnabled, readSemanticProfile } from "../lib/semantic-settings.js";
import { probeSemanticDependencies } from "../lib/semantic-setup.js";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/semantic", body } = {}) {
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:55929",
      origin: "http://127.0.0.1:55929",
      "x-kb-ui": "1",
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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-web-semantic-settings-"));
  const kbRoot = join(root, "kb");
  const modelDir = join(root, "model");
  const jobs = createJobRegistry();
  const opts = {
    kbRoot,
    semanticModelDir: modelDir,
    jobs,
    semanticEnabled: () => readSemanticEnabled(kbRoot, false),
    getSemanticProfile: () => readSemanticProfile(kbRoot, "summary"),
    semanticStatus: async () => ({
      enabled: await readSemanticEnabled(kbRoot, false),
      indexReady: false,
      model: "BAAI/bge-small-zh-v1.5",
      dim: 512,
      docs: 0,
      reason: "missing",
      kbs: 0,
    }),
    semanticPrepare: async ({ onProgress }) => {
      onProgress({ phase: "model", text: "fake prepare" });
      return { ready: true };
    },
  };
  return { root, kbRoot, modelDir, jobs, opts };
}

async function withSetup(run) {
  const env = await setup();
  try {
    await run(env);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
}

async function waitJob(jobs, jobId) {
  for (let index = 0; index < 100; index += 1) {
    const job = await jobs.get(jobId);
    if (job && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not settle");
}

test("GET /semantic：默认关闭、依赖/模型状态与索引状态都是只读探测", async () => {
  await withSetup(async ({ opts }) => {
    const { res, json } = await call(opts, makeReq());
    assert.equal(res.status, 200);
    assert.equal(json.enabled, false);
    assert.equal(typeof json.ready, "boolean");
    assert.equal(Array.isArray(json.dependencies.missing), true);
    assert.equal(Array.isArray(json.model.missing), true);
    assert.equal(json.model.missing.includes("model.onnx"), true);
    assert.equal(json.preparing, false);
    assert.equal(json.profile, "summary");
    assert.equal(json.index.enabled, false);
  });
});

test("PUT /semantic：开关写入 <kbRoot>/.semantic.json，GET 立即反映", async () => {
  await withSetup(async ({ opts, kbRoot }) => {
    const on = await call(opts, makeReq({ method: "PUT", body: { enabled: true } }));
    assert.equal(on.res.status, 200);
    assert.equal(on.json.enabled, true);
    assert.equal(await readSemanticEnabled(kbRoot, false), true);
    const file = JSON.parse(await readFile(join(kbRoot, ".semantic.json"), "utf8"));
    assert.equal(file.enabled, true);
    assert.equal(file.profile, "summary");

    const off = await call(opts, makeReq({ method: "PUT", body: { enabled: false } }));
    assert.equal(off.json.enabled, false);
    assert.equal(await readSemanticEnabled(kbRoot, true), false);
  });
});

test("PUT /semantic：profile 保存为 window，且不丢 enabled", async () => {
  await withSetup(async ({ opts, kbRoot }) => {
    await call(opts, makeReq({ method: "PUT", body: { enabled: true, profile: "window" } }));
    const settings = JSON.parse(await readFile(join(kbRoot, ".semantic.json"), "utf8"));
    assert.deepEqual({ enabled: settings.enabled, profile: settings.profile }, { enabled: true, profile: "window" });
    const status = await call(opts, makeReq());
    assert.equal(status.json.profile, "window");
    assert.equal(status.json.enabled, true);
    const back = await call(opts, makeReq({ method: "PUT", body: { profile: "summary" } }));
    assert.equal(back.json.profile, "summary");
    assert.equal(back.json.enabled, true);
    const bad = await call(opts, makeReq({ method: "PUT", body: { profile: "full" } }));
    assert.equal(bad.res.status, 400);
    assert.equal(bad.json.error.code, "INVALID_ARGS");
  });
});

test("PUT /semantic：enabled 不是布尔值时 400", async () => {
  await withSetup(async ({ opts }) => {
    const { res, json } = await call(opts, makeReq({ method: "PUT", body: { enabled: "on" } }));
    assert.equal(res.status, 400);
    assert.equal(json.error.code, "INVALID_ARGS");
  });
});

test("POST /prepare：必须显式同意；同意后走后台任务", async () => {
  await withSetup(async ({ opts, jobs }) => {
    const denied = await call(opts, makeReq({ method: "POST", url: "/kb/api/semantic/prepare", body: {} }));
    assert.equal(denied.res.status, 400);
    assert.equal(denied.json.error.code, "CONSENT_REQUIRED");

    const accepted = await call(opts, makeReq({
      method: "POST", url: "/kb/api/semantic/prepare", body: { confirm: true },
    }));
    assert.equal(accepted.res.status, 202);
    assert.ok(accepted.json.jobId);
    const job = await waitJob(jobs, accepted.json.jobId);
    assert.equal(job.status, "succeeded");
    assert.equal(job.detail, "语义检索组件已就绪");
  });
});

test("组件与模型都就绪时 /prepare 直接返回 alreadyReady", { skip: probeSemanticDependencies().ok ? false : "本机未安装可选依赖" }, async () => {
  await withSetup(async ({ opts, modelDir }) => {
    await mkdir(modelDir, { recursive: true });
    for (const file of ["model.onnx", "tokenizer.json", "tokenizer_config.json"]) {
      await writeFile(join(modelDir, file), "x", "utf8");
    }
    const status = await call(opts, makeReq());
    assert.equal(status.json.ready, true);
    const ready = await call(opts, makeReq({ method: "POST", url: "/kb/api/semantic/prepare", body: { confirm: true } }));
    assert.equal(ready.res.status, 200);
    assert.equal(ready.json.alreadyReady, true);
  });
});
