/**
 * manifest v5：库级 description/tags/mergedInto/mergedAt 的惰性迁移与 listKbs 带出。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, listKbs, SCHEMA_VERSION } from "../lib/store.js";

async function tempRoot() {
  return mkdtemp(join(tmpdir(), "kb-manifest-v5-"));
}

test("v4 manifest is migrated in memory with empty kb metadata", async () => {
  const root = await tempRoot();
  const dir = join(root, "标准");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "kb.json"), JSON.stringify({
    schemaVersion: 4,
    name: "标准",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    docs: [],
  }), "utf8");

  const manifest = await readManifest(dir);
  assert.equal(SCHEMA_VERSION, 5);
  assert.equal(manifest.schemaVersion, 5);
  assert.equal(manifest.description, "");
  assert.deepEqual(manifest.tags, []);
  assert.equal(manifest.mergedInto, null);
  assert.equal(manifest.mergedAt, null);
});

test("kb metadata round-trips and listKbs exposes it", async () => {
  const root = await tempRoot();
  const dir = join(root, "电气");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "kb.json"), JSON.stringify({
    schemaVersion: 5,
    name: "电气",
    description: "电气一次/二次合并库",
    tags: ["电气", "一次"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    docs: [],
  }), "utf8");

  const manifest = await readManifest(dir);
  assert.equal(manifest.description, "电气一次/二次合并库");
  assert.deepEqual(manifest.tags, ["电气", "一次"]);

  const kbs = await listKbs(root);
  assert.equal(kbs.length, 1);
  assert.equal(kbs[0].description, "电气一次/二次合并库");
  assert.deepEqual(kbs[0].tags, ["电气", "一次"]);
});

test("readManifest creates a v5 empty manifest when missing", async () => {
  const root = await tempRoot();
  const dir = join(root, "空库");
  const manifest = await readManifest(dir);
  assert.equal(manifest.schemaVersion, 5);
  assert.equal(manifest.description, "");
  assert.deepEqual(manifest.tags, []);
  const written = JSON.parse(await readFile(join(dir, "kb.json"), "utf8"));
  assert.equal(written.schemaVersion, 5);
  assert.equal(written.description, "");
});
