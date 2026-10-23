/**
 * Slice 1 写 API：新建、简介/标签、重命名、归档、回收站恢复。
 * 所有写请求必须带 x-kb-ui: 1 且同源。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { listKbs, readManifest } from "../lib/store.js";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/kbs", headers = {}, body } = {}) {
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

async function call(kbRoot, req) {
  const res = makeRes();
  await handleApi(req, res, { opts: { kbRoot }, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

test("POST /kbs creates a kb", async () => {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-api-write-")), "kb");
  const { res, json } = await call(kbRoot, makeReq({
    method: "POST",
    url: "/kb/api/kbs",
    body: { name: "电气", description: "电气资料", tags: ["电气"] },
  }));
  assert.equal(res.status, 201);
  assert.equal(json.kb.name, "电气");
  assert.equal((await listKbs(kbRoot))[0].description, "电气资料");
});

test("PATCH updates description and renames", async () => {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-api-write-")), "kb");
  await call(kbRoot, makeReq({ method: "POST", url: "/kb/api/kbs", body: { name: "旧名" } }));
  const { res, json } = await call(kbRoot, makeReq({
    method: "PATCH",
    url: "/kb/api/kbs/%E6%97%A7%E5%90%8D",
    body: { name: "新名", description: "更新后的简介", tags: ["新"] },
  }));
  assert.equal(res.status, 200);
  assert.equal(json.kb.name, "新名");
  assert.equal(json.renamedFrom, "旧名");
  const kbs = await listKbs(kbRoot);
  assert.deepEqual(kbs.map((kb) => kb.name), ["新名"]);
  const manifest = await readManifest(join(kbRoot, "新名"));
  assert.equal(manifest.description, "更新后的简介");
});

test("POST archive requires confirm and moves to .trash", async () => {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-api-write-")), "kb");
  await call(kbRoot, makeReq({ method: "POST", url: "/kb/api/kbs", body: { name: "空库" } }));
  const bad = await call(kbRoot, makeReq({
    method: "POST",
    url: "/kb/api/kbs/%E7%A9%BA%E5%BA%93/archive",
    body: { confirm: "错误" },
  }));
  assert.equal(bad.res.status, 400);
  const ok = await call(kbRoot, makeReq({
    method: "POST",
    url: "/kb/api/kbs/%E7%A9%BA%E5%BA%93/archive",
    body: { confirm: "空库" },
  }));
  assert.equal(ok.res.status, 200);
  assert.match(ok.json.trashedTo, /\.trash/);
  assert.ok(ok.json.dir);
  assert.deepEqual(await listKbs(kbRoot), []);
});

test("GET /trash lists an archived kb and POST restore moves it back", async () => {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-api-write-")), "kb");
  await call(kbRoot, makeReq({ method: "POST", url: "/kb/api/kbs", body: { name: "资料库" } }));
  const archived = await call(kbRoot, makeReq({
    method: "POST",
    url: "/kb/api/kbs/%E8%B5%84%E6%96%99%E5%BA%93/archive",
    body: { confirm: "资料库" },
  }));
  assert.equal(archived.res.status, 200);
  const dir = archived.json.dir;
  const trash = await call(kbRoot, makeReq({ url: "/kb/api/trash" }));
  assert.equal(trash.res.status, 200);
  assert.equal(trash.json.items.length, 1);
  assert.equal(trash.json.items[0].name, "资料库");
  assert.equal(trash.json.items[0].dir, dir);

  const restored = await call(kbRoot, makeReq({
    method: "POST",
    url: `/kb/api/trash/${encodeURIComponent(dir)}/restore`,
    body: {},
  }));
  assert.equal(restored.res.status, 200);
  assert.equal(restored.json.restoredTo, "资料库");
  assert.deepEqual((await listKbs(kbRoot)).map((kb) => kb.name), ["资料库"]);
  assert.deepEqual((await call(kbRoot, makeReq({ url: "/kb/api/trash" }))).json.items, []);
});

test("POST restore returns 409 on name conflict and supports a new name", async () => {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-api-write-")), "kb");
  await call(kbRoot, makeReq({ method: "POST", url: "/kb/api/kbs", body: { name: "冲突" } }));
  const archived = await call(kbRoot, makeReq({
    method: "POST",
    url: "/kb/api/kbs/%E5%86%B2%E7%AA%81/archive",
    body: { confirm: "冲突" },
  }));
  const dir = archived.json.dir;
  await call(kbRoot, makeReq({ method: "POST", url: "/kb/api/kbs", body: { name: "冲突" } }));

  const conflict = await call(kbRoot, makeReq({
    method: "POST",
    url: `/kb/api/trash/${encodeURIComponent(dir)}/restore`,
    body: {},
  }));
  assert.equal(conflict.res.status, 409);

  const renamed = await call(kbRoot, makeReq({
    method: "POST",
    url: `/kb/api/trash/${encodeURIComponent(dir)}/restore`,
    body: { name: "冲突恢复" },
  }));
  assert.equal(renamed.res.status, 200);
  assert.equal(renamed.json.restoredTo, "冲突恢复");
  assert.ok((await listKbs(kbRoot)).some((kb) => kb.name === "冲突恢复"));
});

test("mutations without x-kb-ui are rejected", async () => {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-api-write-")), "kb");
  const res = makeRes();
  await handleApi(makeReq({ method: "POST", url: "/kb/api/kbs", headers: { "x-kb-ui": "" }, body: { name: "x" } }), res, {
    opts: { kbRoot },
    fence: () => true,
  });
  assert.equal(res.status, 403);
});
