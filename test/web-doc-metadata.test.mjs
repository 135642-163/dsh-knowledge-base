/**
 * 资料编目 API：PATCH metadata（summarySource=manual）与标签筛选/facets。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { readManifest } from "../lib/store.js";

const KB = "标准";
const KB_URL = encodeURIComponent(KB);

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
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}
async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}
function docUrl(id, action = "") {
  return `/kb/api/kbs/${KB_URL}/docs/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-doc-metadata-"));
  const kbRoot = join(root, "kb");
  const { dir } = await createKb(kbRoot, { name: KB });
  const manifest = await readManifest(dir);
  manifest.docs.push(
    { id: "d1", title: "风电场接入", type: "pdf-text", status: "ready", version: 3, tags: ["并网"], summary: "旧摘要", summarySource: "auto", pages: 10, chars: 100 },
    { id: "d2", title: "导入中", type: "pdf-text", status: "importing", version: 0 },
    { id: "d3", title: "已删除", type: "pdf-text", status: "deleted", deletedAt: "2026-10-01T00:00:00.000Z", version: 1 },
    { id: "d4", title: "继电保护", type: "pdf-text", status: "ready", version: 1, tags: ["继电保护", "并网"], summary: "保护", summarySource: "manual" },
  );
  await writeFile(join(dir, "kb.json"), JSON.stringify(manifest), "utf8");
  await mkdir(join(dir, "markdown", "d1"), { recursive: true });
  await writeFile(join(dir, "markdown", "d1", "d1.md"), "# 风电场接入\n\n正文。\n", "utf8");
  return { root, kbRoot, dir };
}

test("PATCH title marks manual and preserves on reimport", async (t) => {
  const { root, kbRoot, dir } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  const opts = { kbRoot, defaultKb: KB, jobs: null };
  const { res, json } = await call(opts, makeReq({
    method: "PATCH", url: docUrl("d1", "metadata"),
    body: { title: "  风电场接入技术规定  ", summary: "  人工  摘要  ", tags: ["#并网", "海上风电", "并网"] },
  }));
  assert.equal(res.status, 200);
  assert.equal(json.doc.title, "风电场接入技术规定");
  assert.equal(json.doc.summary, "人工 摘要");
  assert.equal(json.doc.summarySource, "manual");
  assert.deepEqual(json.doc.tags, ["并网", "海上风电"]);
  assert.equal(json.doc.version, 3);
  assert.ok(json.doc.metaUpdatedAt);
  const manifest = await readManifest(dir);
  const doc = manifest.docs.find((item) => item.id === "d1");
  assert.equal(doc.title, "风电场接入技术规定");
  assert.equal(doc.titleSource, "manual");
  assert.equal(doc.summarySource, "manual");
  assert.equal(doc.version, 3);
});

test("clear summary resets source; tags-only keeps manual source", async (t) => {
  const { root, kbRoot } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  const opts = { kbRoot, defaultKb: KB, jobs: null };
  let result = await call(opts, makeReq({ method: "PATCH", url: docUrl("d1", "metadata"), body: { summary: "人工" } }));
  assert.equal(result.json.doc.summarySource, "manual");
  result = await call(opts, makeReq({ method: "PATCH", url: docUrl("d1", "metadata"), body: { tags: ["新标签"] } }));
  assert.equal(result.json.doc.summarySource, "manual");
  assert.deepEqual(result.json.doc.tags, ["新标签"]);
  result = await call(opts, makeReq({ method: "PATCH", url: docUrl("d1", "metadata"), body: { summary: "" } }));
  assert.equal(result.json.doc.summary, "");
  assert.equal(result.json.doc.summarySource, "");
});

test("tag filter and facets count across filtered docs", async (t) => {
  const { root, kbRoot } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  const opts = { kbRoot, defaultKb: KB, jobs: null };
  const { res, json } = await call(opts, makeReq({ url: `/kb/api/kbs/${KB_URL}/docs?tag=${encodeURIComponent("并网")}` }));
  assert.equal(res.status, 200);
  assert.equal(json.tag, "并网");
  assert.deepEqual(json.docs.map((doc) => doc.id).sort(), ["d1", "d4"]);
  assert.equal(json.total, 2);
  assert.ok(json.facets.tags.some((tag) => tag.name === "继电保护" && tag.count === 1));
  const all = await call(opts, makeReq({ url: `/kb/api/kbs/${KB_URL}/docs` }));
  assert.equal(all.json.tag, "");
  assert.ok(all.json.facets.tags.length >= 2);
});

test("metadata rejects importing/deleted/unknown docs and bad bodies", async (t) => {
  const { root, kbRoot } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  const opts = { kbRoot, defaultKb: KB, jobs: null };
  const cases = [
    ["d2", { summary: "x" }, 409, "DOC_IMPORTING"],
    ["d3", { summary: "x" }, 409, "DOC_DELETED"],
    ["nope", { summary: "x" }, 404, "DOC_NOT_FOUND"],
    ["d1", { summary: 1 }, 400, "INVALID_ARGS"],
    ["d1", { tags: 1 }, 400, "INVALID_ARGS"],
    ["d1", { title: 1 }, 400, "INVALID_ARGS"],
    ["d1", { title: "   " }, 400, "INVALID_ARGS"],
    ["d1", {}, 400, "INVALID_ARGS"],
  ];
  for (const [id, body, status, code] of cases) {
    const { res, json } = await call(opts, makeReq({ method: "PATCH", url: docUrl(id, "metadata"), body }));
    assert.equal(res.status, status, `${id} ${JSON.stringify(body)}`);
    assert.equal(json.error.code, code);
  }
});

test("metadata requires UI header and same origin", async (t) => {
  const { root, kbRoot } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  const opts = { kbRoot, defaultKb: KB, jobs: null };
  const noHeader = await call(opts, makeReq({ method: "PATCH", url: docUrl("d1", "metadata"), body: { summary: "x" }, headers: { "x-kb-ui": "" } }));
  assert.equal(noHeader.res.status, 403);
});
