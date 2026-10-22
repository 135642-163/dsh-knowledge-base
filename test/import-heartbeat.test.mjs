/**
 * P0-7：长任务的“活跃导入”不能只靠 30 分钟前的 updatedAt 判断。
 * 心跳必须独立于文档的 updatedAt，避免更新展示时间。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markImporting, readManifest, touchImportHeartbeat } from "../lib/store.js";

const ENTRY = {
  id: "d1",
  title: "长任务",
  sourceFile: "t.txt",
  sourcePath: "/tmp/t.txt",
  type: "text",
  pages: 0,
  chars: 0,
  parts: 0,
  outline: [],
  warnings: [],
};

async function writeManifest(dir, manifest) {
  await writeFile(join(dir, "kb.json"), JSON.stringify(manifest, null, 2), "utf8");
}

test("a fresh heartbeat blocks duplicate imports even when updatedAt is old", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-heartbeat-"));
  try {
    assert.equal(await markImporting(dir, ENTRY), true);
    let manifest = await readManifest(dir);
    assert.ok(manifest.docs[0].heartbeatAt, "markImporting must record heartbeatAt");

    const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    manifest.docs[0].updatedAt = old;
    manifest.docs[0].heartbeatAt = new Date().toISOString();
    await writeManifest(dir, manifest);
    assert.equal(
      await markImporting(dir, ENTRY),
      false,
      "a fresh heartbeat must keep the import active even if updatedAt is old"
    );

    manifest = await readManifest(dir);
    manifest.docs[0].updatedAt = old;
    manifest.docs[0].heartbeatAt = old;
    await writeManifest(dir, manifest);
    assert.equal(await markImporting(dir, ENTRY), true, "a stale heartbeat allows takeover");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("heartbeat touch does not change the document updatedAt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-heartbeat-touch-"));
  try {
    assert.equal(await markImporting(dir, ENTRY), true);
    let manifest = await readManifest(dir);
    const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    manifest.docs[0].updatedAt = old;
    manifest.docs[0].heartbeatAt = old;
    await writeManifest(dir, manifest);

    await touchImportHeartbeat(dir, "d1");

    manifest = await readManifest(dir);
    assert.ok(Date.now() - Date.parse(manifest.docs[0].heartbeatAt) < 5000);
    assert.equal(manifest.docs[0].updatedAt, old, "heartbeat must not rewrite updatedAt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
