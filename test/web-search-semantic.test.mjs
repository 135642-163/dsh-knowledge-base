/**
 * 0.31 可选语义层接入（Task 4，HTTP 层）：
 * GET /kb/api/search 在 on/off 下的差异、engine=hybrid、dense 独有文档与状态块。
 * 全部用临时 kbRoot + 预置向量 + 假 runtime，不加载模型。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { readManifest } from "../lib/store.js";
import { manifestStamp } from "../lib/fts-index.js";

const KB = "标准";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq(url) {
  return {
    method: "GET",
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929" },
    on() {}, off() {},
  };
}

async function call(opts, url) {
  const res = makeRes();
  await handleApi(makeReq(url), res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

async function writeDoc(dir, id, title, body) {
  const target = join(dir, "markdown", id);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, `${id}.md`), `# ${title}\n${body}\n`, "utf8");
}

async function writeDocVectors(dir, manifest, vectors) {
  const dim = 2;
  const flat = new Float32Array(vectors.length * dim);
  vectors.forEach((vector, index) => flat.set(vector, index * dim));
  const data = Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
  await mkdir(join(dir, ".index"), { recursive: true });
  await writeFile(join(dir, ".index", "doc-vectors.f32"), data, { mode: 0o600 });
  const docs = manifest.docs
    .filter((doc) => doc.status === "ready" && !doc.deletedAt)
    .map((doc) => ({ id: doc.id, version: doc.version ?? 0, updatedAt: doc.updatedAt ?? "" }));
  const meta = {
    schemaVersion: "1",
    model: "BAAI/bge-small-zh-v1.5",
    dim,
    docs,
    manifestStamp: manifestStamp(manifest),
    builtAt: new Date().toISOString(),
    dataHash: createHash("sha256").update(data).digest("hex"),
  };
  await writeFile(join(dir, ".index", "doc-vectors.meta.json"), JSON.stringify(meta), { mode: 0o600 });
}

function fakeRuntime({ embed = true } = {}) {
  return {
    status: async () => ({ available: true, reason: "", model: "fake", dim: 2 }),
    embedQuery: async () => (embed
      ? { ok: true, vector: Float32Array.from([1, 0]), dim: 2 }
      : { ok: false, reason: "model_missing" }),
    embedDocuments: async (texts) => ({
      ok: true,
      vectors: texts.map(() => Float32Array.from([1, 0])),
      dim: 2,
    }),
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-web-semantic-"));
  const kbRoot = join(root, "kb");
  const { dir } = await createKb(kbRoot, { name: KB });
  const manifest = await readManifest(dir);
  manifest.docs.push(
    {
      id: "d1", title: "电能质量 电压偏差", type: "pdf-text", status: "ready", version: 1,
      pages: 10, chars: 100, standardNo: "GB/T 12325-2008", tags: ["电能质量"], trust: "high",
      updatedAt: "2026-10-20T00:00:00.000Z",
    },
    {
      id: "d2", title: "电力系统频率偏差", type: "pdf-text", status: "ready", version: 1,
      pages: 6, chars: 80, standardNo: "GB/T 15945-2008", tags: ["电能质量"], trust: "medium",
      updatedAt: "2026-10-19T00:00:00.000Z",
    },
    {
      id: "d3", title: "电网运行说明", type: "text", status: "ready", version: 1,
      pages: 4, chars: 60, standardNo: "", tags: [], trust: "medium",
      updatedAt: "2026-10-18T00:00:00.000Z",
    },
  );
  await writeFile(join(dir, "kb.json"), JSON.stringify(manifest), "utf8");
  await writeDoc(dir, "d1", "电能质量 电压偏差", "### 第 4 页\n4.1 供电电压偏差限值：35 kV 及以上不超过 10%。");
  await writeDoc(dir, "d2", "电力系统频率偏差", "### 第 3 页\n3.1 频率偏差限值为 ±0.2 Hz。");
  // 完全不含查询词：B 不会命中，只能靠 dense 进入。
  await writeDoc(dir, "d3", "电网运行说明", "### 第 7 页\n电网运行的一般说明。");
  await writeDocVectors(dir, manifest, [
    Float32Array.from([0.6, 0.8]),
    Float32Array.from([0, 1]),
    Float32Array.from([1, 0]),
  ]);
  return { root, kbRoot, dir };
}

async function withSetup(run) {
  const env = await setup();
  try {
    await run(env);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
}

const semanticOpts = (kbRoot, runtime = fakeRuntime()) => ({
  kbRoot,
  semanticSearch: "on",
  semanticRuntime: runtime,
  semanticStatus: async () => ({
    enabled: true, indexReady: true, model: fakeModelName, dim: 2, docs: 3, reason: "",
  }),
});

const fakeModelName = "BAAI/bge-small-zh-v1.5";

function searchUrl(query, extra = {}) {
  const params = new URLSearchParams({ q: query, ...extra });
  return `/kb/api/search?${params.toString()}`;
}

test("关闭语义：/search 仍是 0.30 的 FTS 结果，dense 独有文档不出现", async () => {
  await withSetup(async ({ kbRoot }) => {
    const { json } = await call({ kbRoot }, searchUrl("供电电压偏差限值"));
    assert.equal(json.engine, "fts");
    assert.ok(json.results.some((result) => result.docId === "d1"));
    assert.ok(!json.results.some((result) => result.docId === "d3"), "关闭时不应出现 dense 独有文档");
  });
});

test("开启语义：engine=hybrid，dense 独有文档进入结果并标注无页码", async () => {
  await withSetup(async ({ kbRoot }) => {
    const { json } = await call(semanticOpts(kbRoot), searchUrl("供电电压偏差限值"));
    assert.equal(json.engine, "hybrid");
    const d3 = json.results.find((result) => result.docId === "d3");
    assert.ok(d3, "dense 独有文档应进入结果");
    assert.equal(d3.page, null);
    assert.match(json.note, /1 篇语义命中未定位到页码/);
    assert.equal(json.results[0].docId, "d1", "强词面命中保持第一");
  });
});

test("开启语义：查询嵌入不可用时回退 B", async () => {
  await withSetup(async ({ kbRoot }) => {
    const { json } = await call(semanticOpts(kbRoot, fakeRuntime({ embed: false })), searchUrl("供电电压偏差限值"));
    assert.equal(json.engine, "fts");
    assert.ok(!json.results.some((result) => result.docId === "d3"));
  });
});

test("GET /status 暴露 semantic 块（enabled/indexReady/model/dim/docs/reason）", async () => {
  await withSetup(async ({ kbRoot }) => {
    const off = await call({ kbRoot }, "/kb/api/status");
    assert.deepEqual(off.json.semantic, {
      enabled: false, indexReady: false, model: "", dim: 0, docs: 0, reason: "disabled",
    });
    const on = await call(semanticOpts(kbRoot), "/kb/api/status");
    assert.deepEqual(on.json.semantic, {
      enabled: true, indexReady: true, model: "BAAI/bge-small-zh-v1.5", dim: 2, docs: 3, reason: "",
    });
    assert.equal(on.json.kbRoot, kbRoot);
  });
});
