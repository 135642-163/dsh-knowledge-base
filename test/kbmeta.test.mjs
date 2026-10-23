/**
 * 库级元数据：createKb / updateKbMeta / archiveKb。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createKb, updateKbMeta, archiveKb, listTrash, restoreKb } from "../lib/kbmeta.js";
import { readManifest, listKbs, writeManifestAtomic } from "../lib/store.js";

async function root() {
  return mkdtemp(join(tmpdir(), "kb-meta-"));
}

test("createKb creates dir, manifest, schema/index/log", async () => {
  const kbRoot = await root();
  const { dir, manifest } = await createKb(kbRoot, {
    name: "电气",
    description: "电气一次/二次",
    tags: ["电气", "一次", "一次"],
  });
  assert.equal(manifest.name, "电气");
  assert.equal(manifest.description, "电气一次/二次");
  assert.deepEqual(manifest.tags, ["电气", "一次"]);
  assert.equal((await readManifest(dir)).description, "电气一次/二次");
  for (const file of ["kb.json", "schema.md", "index.md", "log.md"]) {
    await access(join(dir, file));
  }
  const kbs = await listKbs(kbRoot);
  assert.equal(kbs.length, 1);
  assert.equal(kbs[0].name, "电气");
});

test("createKb rejects duplicate and case-insensitive duplicate", async () => {
  const kbRoot = await root();
  await createKb(kbRoot, { name: "Grid" });
  await assert.rejects(() => createKb(kbRoot, { name: "Grid" }), /已存在/);
  await assert.rejects(() => createKb(kbRoot, { name: "grid" }), /已存在/);
});

test("updateKbMeta writes description and tags", async () => {
  const kbRoot = await root();
  await createKb(kbRoot, { name: "标准" });
  const { manifest } = await updateKbMeta(kbRoot, "标准", {
    description: "现行标准、规程",
    tags: ["标准", " 规程 ", ""],
  });
  assert.equal(manifest.description, "现行标准、规程");
  assert.deepEqual(manifest.tags, ["标准", "规程"]);
});

test("archiveKb moves the directory into .trash and hides it from listKbs", async () => {
  const kbRoot = await root();
  await createKb(kbRoot, { name: "空库" });
  const trashedTo = await archiveKb(kbRoot, "空库");
  await access(trashedTo);
  await assert.rejects(() => access(join(kbRoot, "空库")));
  assert.deepEqual(await listKbs(kbRoot), []);
  assert.ok((await readdir(join(kbRoot, ".trash"))).length >= 1);
  await assert.rejects(() => readFile(join(kbRoot, "空库", "kb.json"), "utf8"));
});

test("non-empty kb archives, appears in trash and restores with its docs", async () => {
  const kbRoot = await root();
  const { dir } = await createKb(kbRoot, { name: "资料库" });
  const manifest = await readManifest(dir);
  manifest.docs.push({ id: "d1", title: "一份资料", type: "text", status: "ready", chars: 12 });
  await writeManifestAtomic(dir, manifest);

  const trashedTo = await archiveKb(kbRoot, "资料库");
  const items = await listTrash(kbRoot);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "资料库");
  assert.equal(items[0].docs, 1);
  assert.equal(items[0].restorable, true);

  const restored = await restoreKb(kbRoot, basename(trashedTo));
  assert.equal(restored.manifest.name, "资料库");
  assert.equal((await readManifest(restored.dir)).docs.length, 1);
  assert.deepEqual((await listKbs(kbRoot)).map((kb) => kb.name), ["资料库"]);
  assert.deepEqual(await listTrash(kbRoot), []);
});

test("restoreKb rejects an occupied name and supports restoring under a new name", async () => {
  const kbRoot = await root();
  await createKb(kbRoot, { name: "冲突" });
  const trashedTo = await archiveKb(kbRoot, "冲突");
  const dirName = basename(trashedTo);
  await createKb(kbRoot, { name: "冲突" });

  await assert.rejects(() => restoreKb(kbRoot, dirName), /已存在/);

  const restored = await restoreKb(kbRoot, dirName, { name: "冲突恢复" });
  assert.equal(restored.manifest.name, "冲突恢复");
  assert.equal((await readManifest(restored.dir)).name, "冲突恢复");
  assert.match(await readFile(join(restored.dir, "schema.md"), "utf8"), /冲突恢复/);
});
