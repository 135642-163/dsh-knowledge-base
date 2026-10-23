/**
 * Slice 1 只读 API：/status /kbs /kbs/:name /docs /source。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKb } from "../lib/kbmeta.js";
import { handleApi } from "../lib/web/api.js";
import { findSource } from "../lib/web/data.js";

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
    headers: { host: "127.0.0.1:55929", ...headers },
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
  const root = await mkdtemp(join(tmpdir(), "kb-api-read-"));
  const kbRoot = join(root, "kb");
  await createKb(kbRoot, { name: "标准", description: "现行标准", tags: ["标准"] });
  const dir = join(kbRoot, "标准");
  await mkdir(join(dir, "sources"), { recursive: true });
  await mkdir(join(dir, "markdown", "abc123"), { recursive: true });
  await writeFile(join(dir, "markdown", "abc123", "part-1.md"), "# 正文\n\n继电保护。\n", "utf8");
  await writeFile(join(dir, "sources", "abc123.pdf"), "%PDF", "utf8");
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "kb.json"), "utf8"));
  manifest.docs.push({
    id: "abc123",
    title: "DL/T 478-2013 继电保护通用技术条件",
    type: "pdf-text",
    status: "ready",
    pages: 10,
    chars: 100,
    parts: 1,
    summary: "继电保护通用技术条件",
    tags: ["继电保护"],
    trust: "high",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  await writeFile(join(dir, "kb.json"), JSON.stringify(manifest), "utf8");
  return { root, kbRoot };
}

test("GET /status returns feature flags", async () => {
  const { kbRoot } = await setup();
  const { res, json } = await call({ kbRoot }, makeReq({ url: "/kb/api/status" }));
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.features.merge, false);
});

test("GET /kbs returns summaries with description and stats", async () => {
  const { kbRoot } = await setup();
  const { res, json } = await call({ kbRoot }, makeReq({ url: "/kb/api/kbs" }));
  assert.equal(res.status, 200);
  assert.equal(json.kbs.length, 1);
  assert.equal(json.kbs[0].name, "标准");
  assert.equal(json.kbs[0].description, "现行标准");
  assert.equal(json.kbs[0].docs.ready, 1);
  assert.equal(json.kbs[0].pages, 10);
});

test("GET /kbs/:name returns detail with recent docs", async () => {
  const { kbRoot } = await setup();
  const { json } = await call({ kbRoot }, makeReq({ url: "/kb/api/kbs/%E6%A0%87%E5%87%86" }));
  assert.equal(json.kb.name, "标准");
  assert.equal(json.recentDocs.length, 1);
  assert.equal(json.recentDocs[0].id, "abc123");
});

test("GET docs paginates and filters by query", async () => {
  const { kbRoot } = await setup();
  const { json } = await call({ kbRoot }, makeReq({ url: "/kb/api/kbs/%E6%A0%87%E5%87%86/docs?query=%E7%BB%A7%E7%94%B5" }));
  assert.equal(json.total, 1);
  assert.equal(json.docs[0].id, "abc123");
});

test("findSource resolves the stored source file by doc id prefix", async () => {
  const { kbRoot } = await setup();
  const found = await findSource(kbRoot, "标准", "abc123");
  assert.match(found.path, /sources\/abc123\.pdf$/);
  assert.equal(found.name, "abc123.pdf");
});
