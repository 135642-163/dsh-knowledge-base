/**
 * /kb 路由注册与静态页：没有 webServer 时不注册；有则注册 3 条路由。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerKbWeb } from "../lib/web/server.js";

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

test("registerKbWeb registers /kb, /kb/api and /kb/ routes", () => {
  const { ctx, routes } = fakeCtx();
  registerKbWeb(ctx, { kbRoot: "/tmp/none", uiEnabled: true });
  assert.deepEqual(routes.map((route) => `${route.kind}:${route.path}`), [
    "exact:/kb",
    "exact:/kb/api",
    "prefix:/kb/api/",
    "prefix:/kb/",
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
  assert.equal(routes.length, 4);
});

test("static /kb/api.js is not captured by the JSON API route", () => {
  const { ctx, routes } = fakeCtx();
  registerKbWeb(ctx, { kbRoot: "/tmp/none", uiEnabled: true });
  const match = (path) => {
    const exact = routes.find((route) => route.kind === "exact" && route.path === path);
    if (exact) return exact.path;
    const prefixes = routes
      .filter((route) => route.kind === "prefix" && path.startsWith(route.path))
      .sort((a, b) => b.path.length - a.path.length);
    return prefixes[0]?.path ?? null;
  };
  assert.equal(match("/kb/api"), "/kb/api");
  assert.equal(match("/kb/api/kbs"), "/kb/api/");
  assert.equal(match("/kb/api.js"), "/kb/");
  assert.equal(match("/kb/app.js"), "/kb/");
});
