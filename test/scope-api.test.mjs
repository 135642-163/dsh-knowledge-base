/**
 * GET/PUT /kb/api/scope：校验、鉴权、归档判定、features.scope。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/scope", headers = {}, body } = {}) {
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

async function call(kbRoot, req, { ctx, fence = () => true } = {}) {
  const res = makeRes();
  await handleApi(req, res, { ctx, opts: { kbRoot }, fence });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

const CHMOD_GUARD = {
  skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0),
};

async function setup() {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-scope-api-")), "kb");
  for (const name of ["甲库", "乙库"]) {
    const { res } = await call(kbRoot, makeReq({ method: "POST", url: "/kb/api/kbs", body: { name } }));
    assert.equal(res.status, 201);
  }
  return kbRoot;
}

test("status advertises features.scope", async () => {
  const kbRoot = await setup();
  const { res, json } = await call(kbRoot, makeReq({ url: "/kb/api/status" }));
  assert.equal(res.status, 200);
  assert.equal(json.features.scope, true);
});

test("GET returns all mode for a fresh session", async () => {
  const kbRoot = await setup();
  const { res, json } = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=s1" }));
  assert.equal(res.status, 200);
  assert.deepEqual(json.scope, { mode: "all", kbs: [], inheritedFrom: null });
  assert.deepEqual(json.resolved, []);
});

test("GET validates the session parameter", async () => {
  const kbRoot = await setup();
  const missing = await call(kbRoot, makeReq({ url: "/kb/api/scope" }));
  assert.equal(missing.res.status, 400);
  assert.equal(missing.json.error.code, "SCOPE_INVALID");
  const tooLong = await call(kbRoot, makeReq({ url: `/kb/api/scope?session=${"a".repeat(201)}` }));
  assert.equal(tooLong.res.status, 400);
});

test("PUT saves a selected scope and GET reflects it with resolved counts", async () => {
  const kbRoot = await setup();
  const put = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "selected", kbs: ["甲库"] },
  }));
  assert.equal(put.res.status, 200);
  assert.deepEqual(put.json.scope.kbs, ["甲库"]);
  assert.deepEqual(put.json.resolved.map((row) => row.name), ["甲库"]);
  assert.equal(put.json.resolved[0].docs, 0);
  assert.equal(put.json.resolved[0].empty, true);
  assert.ok(put.json.updatedAt);

  const get = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=s1" }));
  assert.deepEqual(get.json.scope.kbs, ["甲库"]);
  assert.ok(get.json.updatedAt);
});

test("resolved rows use the directory name when manifest.name differs", async () => {
  const kbRoot = await setup();
  // 范围条目与 resolved 的身份都是目录名；清单 name 只作为工作台显示名。
  const manifestPath = join(kbRoot, "甲库", "kb.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.name = "显示名";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const put = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "selected", kbs: ["甲库"] },
  }));
  assert.equal(put.res.status, 200);
  assert.deepEqual(put.json.scope.kbs, ["甲库"]);
  assert.deepEqual(put.json.resolved, [{ name: "甲库", docs: 0, empty: true }]);

  const get = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=s1" }));
  assert.deepEqual(get.json.resolved, [{ name: "甲库", docs: 0, empty: true }]);
});

test("GET trims the session id so updatedAt matches the stored entry", async () => {
  const kbRoot = await setup();
  const put = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "selected", kbs: ["甲库"] },
  }));
  assert.equal(put.res.status, 200);
  const get = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=%20s1%20" }));
  assert.equal(get.res.status, 200);
  assert.deepEqual(get.json.scope, put.json.scope);
  assert.equal(get.json.updatedAt, put.json.updatedAt);
  // 带空白的 session 不能另写条目
  const data = JSON.parse(await readFile(join(kbRoot, ".scopes.json"), "utf8"));
  assert.deepEqual(Object.keys(data.scopes), ["s1"]);
});

test("PUT mode=all clears kbs", async () => {
  const kbRoot = await setup();
  await call(kbRoot, makeReq({ method: "PUT", body: { session: "s1", mode: "selected", kbs: ["甲库"] } }));
  const put = await call(kbRoot, makeReq({ method: "PUT", body: { session: "s1", mode: "all", kbs: ["甲库"] } }));
  assert.equal(put.res.status, 200);
  assert.deepEqual(put.json.scope, { mode: "all", kbs: [], inheritedFrom: null });
});

test("PUT rejects an invalid mode", async () => {
  const kbRoot = await setup();
  const { res, json } = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "weird", kbs: [] },
  }));
  assert.equal(res.status, 400);
  assert.equal(json.error.code, "SCOPE_INVALID");
});

test("PUT reports missing and archived kbs distinctly", async () => {
  const kbRoot = await setup();
  const missing = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "selected", kbs: ["不存在"] },
  }));
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error.code, "KB_NOT_FOUND");

  await call(kbRoot, makeReq({ method: "POST", url: "/kb/api/kbs/%E4%B9%99%E5%BA%93/archive", body: { confirm: "乙库" } }));
  const archived = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "selected", kbs: ["乙库"] },
  }));
  assert.equal(archived.res.status, 409);
  assert.equal(archived.json.error.code, "KB_ARCHIVED");
});

test("PUT requires the x-kb-ui header", async () => {
  const kbRoot = await setup();
  const { res } = await call(kbRoot, makeReq({
    method: "PUT",
    headers: { "x-kb-ui": "" },
    body: { session: "s1", mode: "all", kbs: [] },
  }));
  assert.equal(res.status, 403);
});

test("PUT rejects a cross-origin request", async () => {
  const kbRoot = await setup();
  const { res } = await call(kbRoot, makeReq({
    method: "PUT",
    headers: { origin: "http://evil.example" },
    body: { session: "s1", mode: "all", kbs: [] },
  }));
  assert.equal(res.status, 403);
});

test("PUT reports SCOPE_WRITE_FAILED when the scopes file cannot be written", CHMOD_GUARD, async () => {
  const kbRoot = await setup();
  await chmod(kbRoot, 0o555);
  try {
    const { res, json } = await call(kbRoot, makeReq({
      method: "PUT",
      body: { session: "s1", mode: "all", kbs: [] },
    }));
    assert.equal(res.status, 500);
    assert.equal(json.error.code, "SCOPE_WRITE_FAILED");
    // 5xx 不回显可能带绝对路径的 details
    assert.equal(json.error.details, undefined);
    assert.equal(res.body.includes(kbRoot), false);
  } finally {
    await chmod(kbRoot, 0o755);
  }
});

test("GET is rejected by the fence", async () => {
  const kbRoot = await setup();
  const { res } = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=s1" }), { fence: () => false });
  assert.equal(res.status, 403);
});

test("GET of a fresh session reports null updatedAt and no resolved rows", async () => {
  const kbRoot = await setup();
  const { res, json } = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=fresh" }));
  assert.equal(res.status, 200);
  assert.equal(json.updatedAt, null);
  assert.deepEqual(json.resolved, []);
});

test("GET prunes an expired entry and falls back to all", async () => {
  const kbRoot = await setup();
  const stale = new Date(Date.now() - 40 * 86400000).toISOString();
  await writeFile(join(kbRoot, ".scopes.json"), JSON.stringify({
    version: 1,
    scopes: { s1: { mode: "selected", kbs: ["甲库"], updatedAt: stale, inheritedFrom: null } },
  }), "utf8");
  const { res, json } = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=s1" }));
  assert.equal(res.status, 200);
  assert.deepEqual(json.scope, { mode: "all", kbs: [], inheritedFrom: null });
  const data = JSON.parse(await readFile(join(kbRoot, ".scopes.json"), "utf8"));
  assert.equal(Object.hasOwn(data.scopes, "s1"), false);
});

test("GET resolves the parent scope from the live agent registry without snapshotting", async () => {
  const kbRoot = await setup();
  const put = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "parent", mode: "selected", kbs: ["甲库"] },
  }));
  assert.equal(put.res.status, 200);
  const ctx = {
    get: (name) => name === "agents"
      ? { get: (id) => id === "child" ? { session: { header: { parentSession: "parent" } } } : undefined }
      : undefined,
  };
  const get = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=child" }), { ctx });
  assert.equal(get.res.status, 200);
  assert.deepEqual(get.json.scope, { mode: "selected", kbs: ["甲库"], inheritedFrom: "parent" });
  const data = JSON.parse(await readFile(join(kbRoot, ".scopes.json"), "utf8"));
  assert.equal(Object.hasOwn(data.scopes, "child"), false);
});

test("GET degrades to all mode when .scopes.json is unreadable", CHMOD_GUARD, async () => {
  const kbRoot = await setup();
  const file = join(kbRoot, ".scopes.json");
  await writeFile(file, JSON.stringify({
    version: 1,
    scopes: { s1: { mode: "selected", kbs: ["甲库"], updatedAt: new Date().toISOString(), inheritedFrom: null } },
  }), "utf8");
  await chmod(file, 0o000);
  try {
    const { res, json } = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=s1" }));
    assert.equal(res.status, 200);
    assert.deepEqual(json.scope, { mode: "all", kbs: [], inheritedFrom: null });
    assert.equal(json.updatedAt, null);
  } finally {
    await chmod(file, 0o600);
  }
});

test("PUT rejects non-array kbs", async () => {
  const kbRoot = await setup();
  const { res, json } = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "selected", kbs: "甲库" },
  }));
  assert.equal(res.status, 400);
  assert.equal(json.error.code, "SCOPE_INVALID");
});

test("resolved follows the input order and drops an archived kb", async () => {
  const kbRoot = await setup();
  const put = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "selected", kbs: ["乙库", "甲库"] },
  }));
  assert.deepEqual(put.json.resolved.map((row) => row.name), ["乙库", "甲库"]);
  await call(kbRoot, makeReq({
    method: "POST",
    url: `/kb/api/kbs/${encodeURIComponent("甲库")}/archive`,
    body: { confirm: "甲库" },
  }));
  const get = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=s1" }));
  assert.deepEqual(get.json.resolved.map((row) => row.name), ["乙库"]);
});

test("PUT enforces the scope size cap", async () => {
  const kbRoot = await setup();
  const kbs = Array.from({ length: 51 }, (_, i) => `库${i}`);
  const { res, json } = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "selected", kbs },
  }));
  assert.equal(res.status, 400);
  assert.equal(json.error.code, "SCOPE_INVALID");
});
