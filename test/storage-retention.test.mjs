import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneExports, pruneSnapshots } from "../lib/storage-retention.js";

async function makeFiles(dir, names, bytes = 10) {
  await mkdir(dir, { recursive: true });
  for (const name of names) await writeFile(join(dir, name), "x".repeat(bytes));
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "kb-retention-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("快照保留最近 N 份，同时删除 .zip.json sidecar", async () => {
  await withDir(async (dir) => {
    const snapshots = join(dir, "snapshots");
    const names = ["2026-01-01-a.zip", "2026-01-02-b.zip", "2026-01-03-c.zip"];
    await makeFiles(snapshots, names);
    for (const name of names) await writeFile(join(snapshots, `${name}.json`), "{}");
    await writeFile(join(snapshots, "notes.txt"), "keep me");
    const r = await pruneSnapshots(dir, { keep: 2 });
    assert.deepEqual(r.deleted, ["2026-01-01-a.zip"]);
    assert.equal(r.kept, 2);
    const left = await readdir(snapshots);
    assert.ok(!left.includes("2026-01-01-a.zip"));
    assert.ok(!left.includes("2026-01-01-a.zip.json"));
    assert.ok(left.includes("2026-01-02-b.zip.json"));
    assert.ok(left.includes("notes.txt"));
  });
});

test("导出只清理已知扩展名，dry-run 不删除", async () => {
  await withDir(async (dir) => {
    const exports = join(dir, "exports");
    await makeFiles(exports, ["a.md", "b.jsonl", "c.zip", "d.txt"]);
    const dry = await pruneExports(dir, { keep: 1, dryRun: true });
    assert.equal(dry.deleted.length, 2);
    assert.equal((await readdir(exports)).length, 4);
    const applied = await pruneExports(dir, { keep: 1 });
    assert.equal(applied.deleted.length, 2);
    const left = await readdir(exports);
    assert.equal(left.length, 2, "a.md/c.zip 之外的 c? keep newest c.zip + d.txt");
    assert.ok(left.includes("d.txt"));
    assert.ok(left.includes("c.zip"));
  });
});

test("keep=0 表示不限制", async () => {
  await withDir(async (dir) => {
    await makeFiles(join(dir, "snapshots"), ["a.zip", "b.zip"]);
    const r = await pruneSnapshots(dir, { keep: 0 });
    assert.equal(r.deleted.length, 0);
    assert.equal((await readdir(join(dir, "snapshots"))).length, 2);
  });
});
