/**
 * /kb/api/office/*：引擎状态与一键安装入口。
 * 安装器全部注入，不访问网络；POST 走真实 jobs 注册表，验证 202 + 任务结算。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../lib/web/api.js";
import { createJobRegistry } from "../lib/web/jobs.js";

const STATUS_MISSING = {
  available: false,
  running: false,
  installDir: "/home/u/.dsh/tools/libreoffice-kit",
  platform: "darwin",
  arch: "arm64",
  canInstall: true,
  toolchain: "pnpm",
};

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/office/status", headers = {}, body } = {}) {
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

const INSTALL_URL = "/kb/api/office/install";

function installReq({ body = { confirm: true }, headers = {} } = {}) {
  return makeReq({ method: "POST", url: INSTALL_URL, body, headers });
}

async function waitSettled(jobs, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await jobs.get(id);
    if (job && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not settle");
}

test("GET /office/status returns the injected engine status", async () => {
  let calls = 0;
  const status = { ...STATUS_MISSING, available: true, version: "0.2.2" };
  const { res, json } = await call({
    kbRoot: "/tmp/none",
    officeStatus: async () => {
      calls += 1;
      return status;
    },
  }, makeReq());
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(json, status);
  assert.match(res.headers["content-type"], /application\/json/);
});

test("POST /office/install requires explicit confirm", async () => {
  const jobs = createJobRegistry();
  const base = { kbRoot: "/tmp/none", jobs, officeStatus: async () => STATUS_MISSING };
  for (const body of [{}, { confirm: false }, { confirm: "true" }, null]) {
    const { res, json } = await call(base, installReq({ body }));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(json.error.code, "CONSENT_REQUIRED");
    assert.equal(json.error.message, "安装需要用户确认");
  }
  assert.deepEqual(await jobs.list({ kind: "office-install" }), []);
});

test("POST /office/install starts a background job with the installer and settles succeeded", async () => {
  const jobs = createJobRegistry();
  const seen = [];
  const opts = {
    kbRoot: "/tmp/none",
    jobs,
    officeStatus: async () => STATUS_MISSING,
    officeInstaller: async ({ onProgress }) => {
      seen.push(typeof onProgress);
      onProgress({ phase: "download", text: "正在下载并安装…" });
      onProgress({ phase: "verify", text: "正在校验安装…" });
      return { cliPath: "/fake/libreoffice-kit/lib/cli.js", version: "0.2.2" };
    },
  };
  const { res, json } = await call(opts, installReq());
  assert.equal(res.status, 202);
  assert.equal(typeof json.jobId, "string");
  assert.deepEqual(seen, ["function"]);

  const job = await waitSettled(jobs, json.jobId);
  assert.equal(job.kind, "office-install");
  assert.equal(job.label, "安装 Office 转换引擎");
  assert.equal(job.status, "succeeded");
  assert.equal(job.detail, "已安装 Office 转换引擎");
  assert.equal(job.result.cliPath, "/fake/libreoffice-kit/lib/cli.js");
  assert.equal(job.result.version, "0.2.2");
  assert.equal(job.progress?.phase, "verify");
});

test("POST /office/install marks the job failed when the installer throws", async () => {
  const jobs = createJobRegistry();
  const opts = {
    kbRoot: "/tmp/none",
    jobs,
    officeStatus: async () => STATUS_MISSING,
    officeInstaller: async () => {
      throw new Error("安装包下载失败");
    },
  };
  const { res, json } = await call(opts, installReq());
  assert.equal(res.status, 202);
  const job = await waitSettled(jobs, json.jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.detail, "安装包下载失败");
});

test("POST /office/install returns 200 alreadyInstalled when the engine is available", async () => {
  const jobs = createJobRegistry();
  let installs = 0;
  const status = { ...STATUS_MISSING, available: true, version: "0.2.2" };
  const { res, json } = await call({
    kbRoot: "/tmp/none",
    jobs,
    officeStatus: async () => status,
    officeInstaller: async () => {
      installs += 1;
      return {};
    },
  }, installReq());
  assert.equal(res.status, 200);
  assert.deepEqual(json, { alreadyInstalled: true, status });
  assert.equal(installs, 0);
  assert.deepEqual(await jobs.list({ kind: "office-install" }), []);
});

test("POST /office/install rejects a concurrent install with 409", async () => {
  const jobs = createJobRegistry();
  const { res, json } = await call({
    kbRoot: "/tmp/none",
    jobs,
    officeStatus: async () => ({ ...STATUS_MISSING, running: true }),
  }, installReq());
  assert.equal(res.status, 409);
  assert.equal(json.error.code, "OFFICE_INSTALL_RUNNING");
  assert.match(json.error.message, /正在安装/);
});

test("POST /office/install rejects environments without Node/npm with 409", async () => {
  const jobs = createJobRegistry();
  const { res, json } = await call({
    kbRoot: "/tmp/none",
    jobs,
    officeStatus: async () => ({ ...STATUS_MISSING, canInstall: false, toolchain: null }),
  }, installReq());
  assert.equal(res.status, 409);
  assert.equal(json.error.code, "OFFICE_TOOLCHAIN_MISSING");
  assert.match(json.error.message, /缺少 Node\/npm/);
});

test("POST /office/install enforces the UI header and same-origin checks", async () => {
  const jobs = createJobRegistry();
  let installs = 0;
  const opts = {
    kbRoot: "/tmp/none",
    jobs,
    officeStatus: async () => STATUS_MISSING,
    officeInstaller: async () => {
      installs += 1;
      return {};
    },
  };

  const noHeader = await call(opts, installReq({ headers: { "x-kb-ui": "" } }));
  assert.equal(noHeader.res.status, 403);
  assert.equal(noHeader.json.error.code, "FORBIDDEN");

  const crossOrigin = await call(opts, installReq({ headers: { origin: "http://evil.example" } }));
  assert.equal(crossOrigin.res.status, 403);
  assert.equal(crossOrigin.json.error.code, "FORBIDDEN");

  const crossSite = await call(opts, installReq({ headers: { "sec-fetch-site": "cross-site" } }));
  assert.equal(crossSite.res.status, 403);
  assert.equal(crossSite.json.error.code, "FORBIDDEN");
  assert.equal(installs, 0);
});
