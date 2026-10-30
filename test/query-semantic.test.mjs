/**
 * 0.31 可选语义层接入（Task 4，kb_query）：on/off 行为、hybrid 排序、
 * dense 独有文档补位与两阶段页码。用假 runtime + 预置索引，不加载模型。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { manifestStamp } from "../lib/fts-index.js";
import { kbDirPath, readManifest } from "../lib/store.js";

function makeCtx() {
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
    logger: { warn() {} },
    subprocess: {
      spawn({ argv, cwd }) {
        const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = Buffer.alloc(0);
        child.stdout.on("data", (chunk) => { out = Buffer.concat([out, chunk]); });
        const done = new Promise((resolve) => {
          child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
        });
        return {
          done,
          collected: {
            stdout: { readFrom: (offset) => ({ text: out.subarray(offset).toString("utf8"), nextOffset: out.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
          },
          terminate: () => child.kill(),
        };
      },
    },
  };
  return { ctx, tools };
}

const exec = {
  agent: { session: { header: { cwd: "/tmp" } } },
  signal: new AbortController().signal,
};

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

async function writeDocVectors(dir, manifest, vectors) {
  const dim = 2;
  const flat = new Float32Array(vectors.length * dim);
  vectors.forEach((vector, index) => flat.set(vector, index * dim));
  const data = Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
  await mkdir(join(dir, ".index"), { recursive: true });
  await writeFile(join(dir, ".index", "doc-vectors.f32"), data, { mode: 0o600 });
  const meta = {
    schemaVersion: "1",
    model: "BAAI/bge-small-zh-v1.5",
    dim,
    docs: manifest.docs
      .filter((doc) => doc.status === "ready" && !doc.deletedAt)
      .map((doc) => ({ id: doc.id, version: doc.version ?? 0, updatedAt: doc.updatedAt ?? "" })),
    manifestStamp: manifestStamp(manifest),
    builtAt: new Date().toISOString(),
    dataHash: createHash("sha256").update(data).digest("hex"),
  };
  await writeFile(join(dir, ".index", "doc-vectors.meta.json"), JSON.stringify(meta), { mode: 0o600 });
}

/**
 * 两个笔记：A 命中查询词（B 的 top-1），B 完全不含查询词（只能靠 dense 进入）。
 * 索引按 manifest 顺序写：A=[0.6,0.8]、B=[1,0]；查询向量 [1,0]。
 */
async function setup(config = {}) {
  const root = await mkdtemp(join(tmpdir(), "kb-query-semantic-"));
  const kbRoot = join(root, "kb-root");
  await mkdir(kbRoot, { recursive: true });
  const { ctx, tools } = makeCtx();
  await apply(ctx, { kbRoot, defaultKb: "库A", ...config });
  const addNote = tools.get("kb_add_note");
  const noteA = await addNote.execute(
    { kb: "库A", title: "电压偏差说明", content: "## 一\n\n供电电压偏差限值说明。" },
    exec,
  );
  const noteB = await addNote.execute(
    { kb: "库A", title: "电网运行说明", content: "## 一\n\n电网运行的一般说明。" },
    exec,
  );
  const dir = kbDirPath(kbRoot, "库A");
  const manifest = await readManifest(dir);
  await writeDocVectors(dir, manifest, [
    Float32Array.from([0.6, 0.8]),
    Float32Array.from([1, 0]),
  ]);
  return { root, kbRoot, tools, dir, noteA, noteB, manifest };
}

async function withSetup(config, run) {
  const env = await setup(config);
  try {
    await run(env);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
}

test("关闭语义：kb_query 保持 0.30 的 FTS 结果，dense 独有文档不出现", async () => {
  await withSetup({}, async ({ tools, noteA, noteB }) => {
    const result = await tools.get("kb_query").execute({ kb: "库A", pattern: "电压偏差" }, exec);
    assert.notEqual(result.engine, "hybrid", "关闭时不应标记 hybrid");
    assert.ok(result.matches.some((match) => match.docId === noteA.docId));
    assert.ok(!result.matches.some((match) => match.docId === noteB.docId));
  });
});

test("开启语义：engine=hybrid，dense 独有文档补位并标注无页码", async () => {
  await withSetup({ semanticSearch: "on", semanticRuntime: fakeRuntime() }, async ({ tools, noteA, noteB }) => {
    const result = await tools.get("kb_query").execute({ kb: "库A", pattern: "电压偏差" }, exec);
    assert.equal(result.engine, "hybrid");
    assert.equal(result.matches[0].docId, noteA.docId, "强词面命中保持第一");
    const denseOnly = result.matches.find((match) => match.docId === noteB.docId);
    assert.ok(denseOnly, "dense 独有文档应补进 matches");
    assert.equal(denseOnly.pageStart, undefined, "拿不到页码时不伪造");
    assert.match(result.note ?? "", /1 篇语义命中未定位到页码/);
    assert.ok(result.sources.some((source) => source.docId === noteB.docId), "sources 也应包含补位文档");
  });
});

test("开启语义但查询嵌入不可用：回退 B", async () => {
  await withSetup({ semanticSearch: "on", semanticRuntime: fakeRuntime({ embed: false }) }, async ({ tools, noteB }) => {
    const result = await tools.get("kb_query").execute({ kb: "库A", pattern: "电压偏差" }, exec);
    assert.notEqual(result.engine, "hybrid");
    assert.ok(!result.matches.some((match) => match.docId === noteB.docId));
  });
});
