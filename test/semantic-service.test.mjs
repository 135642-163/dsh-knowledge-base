/**
 * 0.31 语义层装配（Task 4）：/kb/api/status 的 semantic 汇总只看清单/索引文件，
 * 不加载模型；启用但索引缺失/过期时给出 reason。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKb } from "../lib/kbmeta.js";
import { readManifest } from "../lib/store.js";
import { ensureDocVectors } from "../lib/semantic-index.js";
import { semanticStatus } from "../lib/semantic-service.js";

function fakeEmbedder(dim = 4) {
  let counter = 0;
  return async (texts) => texts.map(() => {
    const vector = new Float32Array(dim);
    vector[counter % dim] = 1;
    counter += 1;
    return vector;
  });
}

async function writeDoc(dir, id, title, body = "4.1 正文") {
  await mkdir(join(dir, "markdown", id), { recursive: true });
  await writeFile(join(dir, "markdown", id, `${id}.md`), `# ${title}\n\n${body}\n`, "utf8");
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-semantic-service-"));
  const kbRoot = join(root, "kb");
  const { dir } = await createKb(kbRoot, { name: "标准" });
  const manifest = await readManifest(dir);
  manifest.docs.push(
    {
      id: "a", title: "电压偏差", standardNo: "GB/T 1", tags: [], status: "ready",
      version: 1, updatedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "b", title: "频率偏差", standardNo: "GB/T 2", tags: [], status: "ready",
      version: 1, updatedAt: "2026-10-01T00:00:00.000Z",
    },
  );
  await writeFile(join(dir, "kb.json"), JSON.stringify(manifest), "utf8");
  await writeDoc(dir, "a", "电压偏差");
  await writeDoc(dir, "b", "频率偏差");
  return { root, kbRoot, dir, manifest };
}

async function withSetup(run) {
  const env = await setup();
  try {
    await run(env);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
}

test("关闭语义：status 返回 enabled=false / reason=disabled，不读索引", async () => {
  await withSetup(async ({ kbRoot }) => {
    assert.deepEqual(await semanticStatus({ enabled: false, kbRoot }), {
      enabled: false,
      indexReady: false,
      model: "",
      dim: 0,
      docs: 0,
      reason: "disabled",
      kbs: 0,
    });
  });
});

test("启用语义：索引就绪时 indexReady=true；清单变动后变为 index_stale", async () => {
  await withSetup(async ({ kbRoot, dir, manifest }) => {
    const missing = await semanticStatus({ enabled: true, kbRoot });
    assert.equal(missing.enabled, true);
    assert.equal(missing.model, "BAAI/bge-small-zh-v1.5");
    assert.equal(missing.dim, 512);
    assert.equal(missing.indexReady, false);
    assert.equal(missing.reason, "missing");

    const built = await ensureDocVectors({ dir, manifest, embedder: fakeEmbedder() });
    assert.equal(built.ok, true);
    const ready = await semanticStatus({ enabled: true, kbRoot });
    assert.equal(ready.indexReady, true);
    assert.equal(ready.docs, 2);
    assert.equal(ready.kbs, 1);
    assert.equal(ready.reason, "");

    const changed = { ...manifest, docs: manifest.docs.map((doc) => (doc.id === "a" ? { ...doc, version: 2 } : doc)) };
    await writeFile(join(dir, "kb.json"), JSON.stringify(changed), "utf8");
    const stale = await semanticStatus({ enabled: true, kbRoot });
    assert.equal(stale.indexReady, false);
    assert.equal(stale.reason, "index_stale");
  });
});
