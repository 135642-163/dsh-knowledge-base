/**
 * /kb 路由注册与静态页：没有 webServer 时不注册；有则注册 3 条路由。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerKbWeb } from "../lib/web/server.js";
import { createKb } from "../lib/kbmeta.js";

function fakeCtx({ withWebServer = true } = {}) {
  const routes = [];
  const ctx = {
    get(name) {
      if (name === "webRuntime") return { trustedHosts: [] };
      return undefined;
    },
    inject(deps, callback) {
      if (!withWebServer || !deps.includes("webServer")) return;
      callback({
        webServer: {
          register(route) {
            routes.push(route);
            return () => {};
          },
        },
        get: ctx.get,
      });
    },
    effect() {},
  };
  return { ctx, routes };
}

test("registerKbWeb is a no-op without webServer", () => {
  const { ctx, routes } = fakeCtx({ withWebServer: false });
  registerKbWeb(ctx, { kbRoot: "/tmp/none", uiEnabled: true });
  assert.equal(routes.length, 0);
});

test("registerKbWeb registers /kb, /kb/api and /kb static routes", () => {
  const { ctx, routes } = fakeCtx();
  registerKbWeb(ctx, { kbRoot: "/tmp/none", uiEnabled: true });
  assert.deepEqual(routes.map((route) => `${route.kind}:${route.path}`), [
    "exact:/kb",
    "prefix:/kb/api",
    "prefix:/kb",
  ]);
});

test("uiEnabled=false disables routes", () => {
  const { ctx, routes } = fakeCtx();
  registerKbWeb(ctx, { kbRoot: "/tmp/none", uiEnabled: false });
  assert.equal(routes.length, 0);
});

test("kbRoot option is accepted (no filesystem access at registration)", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-web-server-"));
  const { ctx, routes } = fakeCtx();
  registerKbWeb(ctx, { kbRoot: root, uiEnabled: true });
  assert.equal(routes.length, 3);
});

test("DSH prefix semantics keep /kb/api.js out of the JSON API route", () => {
  const { ctx, routes } = fakeCtx();
  registerKbWeb(ctx, { kbRoot: "/tmp/none", uiEnabled: true });
  // dsh-host-webserver: prefix p 命中 p 或 p/<anything>，最长前缀优先。
  const match = (path) => {
    const exact = routes.find((route) => route.kind === "exact" && route.path === path);
    if (exact) return exact.path;
    let best = null;
    for (const route of routes) {
      if (route.kind !== "prefix") continue;
      if (path !== route.path && !path.startsWith(`${route.path}/`)) continue;
      if (!best || route.path.length > best.path.length) best = route;
    }
    return best?.path ?? null;
  };
  assert.equal(match("/kb/api"), "/kb/api");
  assert.equal(match("/kb/api/kbs"), "/kb/api");
  assert.equal(match("/kb/api.js"), "/kb");
  assert.equal(match("/kb/app.js"), "/kb");
  assert.equal(match("/kb/"), "/kb");
});

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/status", headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1", ...headers },
    async *[Symbol.asyncIterator]() {},
  };
}

test("registerKbWeb 注入 jobs/limits 并注册任务清单与 dispose", async () => {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-web-assembly-")), "kb");
  await createKb(kbRoot, { name: "标准" });
  const registered = [];
  const effects = [];
  const ctx = {
    inject(names, fn) {
      fn({
        webServer: { register(route) { registered.push(route); return () => {}; } },
        effect(fn, label) { effects.push({ label, fn }); },
        get: () => undefined,
      });
    },
    subprocess: { spawn: () => { throw new Error("unused"); } },
  };
  registerKbWeb(ctx, {
    kbRoot,
    limits: { maxUploadBytes: 1024, maxBatchFiles: 2, extensions: [".md"] },
    // 用与默认值不同的 ttl/configured：漏接 opts.std 时会退回 false/7，测试才有区分度。
    std: {
      configured: true,
      baseUrl: "https://example.invalid",
      cookie: "test-cookie",
      rateMs: 1,
      maxAgeDays: 2,
      importConfig: {},
    },
    importConfig: () => ({}),
  });

  const route = registered.find((item) => item.path === "/kb/api");
  assert.ok(route, "应注册 /kb/api 路由");

  const statusRes = makeRes();
  await route.handler(makeReq({ method: "GET", url: "/kb/api/status" }), statusRes);
  const status = JSON.parse(statusRes.body);
  assert.equal(status.features.upload, true);
  assert.equal(status.features.std, true);
  assert.equal(status.features.jobs, true);
  assert.equal(status.limits.maxUploadBytes, 1024);
  assert.equal(status.limits.maxBatchFiles, 2);
  assert.deepEqual(status.limits.extensions, [".md"]);

  const jobRes = makeRes();
  await route.handler(makeReq({ method: "GET", url: "/kb/api/jobs/kb-import-nope" }), jobRes);
  assert.equal(jobRes.status, 404);
  assert.equal(JSON.parse(jobRes.body).error.code, "JOB_NOT_FOUND");

  const stdRes = makeRes();
  await route.handler(makeReq({ method: "GET", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std" }), stdRes);
  assert.equal(stdRes.status, 200);
  const std = JSON.parse(stdRes.body);
  assert.equal(std.configured, true);
  assert.equal(std.cache.ttlDays, 2);
  assert.ok(!stdRes.body.includes("test-cookie"), "cookie 不能出现在响应里");

  const jobsEffect = effects.find((item) => item.label === "kb-web: jobs-dispose");
  assert.ok(jobsEffect, "应注册 jobs dispose effect");
  const dispose = jobsEffect.fn();
  assert.equal(typeof dispose, "function");
  assert.doesNotThrow(() => dispose(), "dispose 应调用 cancelAll 且不抛错");
});
