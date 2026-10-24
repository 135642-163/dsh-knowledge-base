/**
 * P0-7：崩溃后的锁回收，以及 import-tmp 里陈旧临时文件的清理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaging, withManifestLock } from "../lib/store.js";

const OLD = new Date(Date.now() - 60 * 60 * 1000);
const DEAD_PID = 2_147_483_646;

test("a dead owner's lock is reclaimed quickly", { timeout: 5_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-lock-dead-"));
  try {
    const lockDir = join(dir, ".lock");
    await mkdir(lockDir);
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: DEAD_PID, startedAt: OLD.toISOString() }),
      "utf8"
    );
    let ran = false;
    const started = Date.now();
    await withManifestLock(
      dir,
      async () => {
        ran = true;
      },
      { timeoutMs: 1_000 }
    );
    assert.equal(ran, true);
    assert.ok(Date.now() - started < 1_500, "dead lock should not wait for the 20s timeout");
    await assert.rejects(access(lockDir), "lock must be released after the operation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live owner's lock is not stolen", { timeout: 5_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-lock-live-"));
  try {
    const lockDir = join(dir, ".lock");
    await mkdir(lockDir);
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: OLD.toISOString() }),
      "utf8"
    );
    const started = Date.now();
    await assert.rejects(
      () =>
        withManifestLock(dir, async () => {}, { timeoutMs: 250 }),
      /正被另一个导入任务修改/
    );
    assert.ok(Date.now() - started < 1_500, "live lock should honour the short timeout");
    await access(lockDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a legacy stale lock without an owner is reclaimed", { timeout: 5_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-lock-legacy-"));
  try {
    const lockDir = join(dir, ".lock");
    await mkdir(lockDir);
    await utimes(lockDir, OLD, OLD);
    let ran = false;
    await withManifestLock(
      dir,
      async () => {
        ran = true;
      },
      { timeoutMs: 1_000 }
    );
    assert.equal(ran, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweepStaging removes stale temp files and keeps recent ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-sweep-"));
  try {
    const tmp = join(dir, "import-tmp");
    await mkdir(tmp, { recursive: true });
    const oldFile = join(tmp, "source-old.tmp");
    const newFile = join(tmp, "source-new.tmp");
    await writeFile(oldFile, "old", "utf8");
    await writeFile(newFile, "new", "utf8");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await utimes(oldFile, twoDaysAgo, twoDaysAgo);

    await sweepStaging(dir);

    await assert.rejects(access(oldFile), "stale temp file should be removed");
    await access(newFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweepStaging keeps ui-batches while removing other stale temp files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-sweep-batches-"));
  try {
    const tmp = join(dir, "import-tmp");
    const batchesRoot = join(tmp, "ui-batches");
    const batchDir = join(batchesRoot, "b-000000000000");
    await mkdir(batchDir, { recursive: true });
    const staleFile = join(tmp, "worker-old.json");
    await writeFile(staleFile, "{}", "utf8");
    const orphanPart = join(batchDir, ".upload-deadbeef.part");
    await writeFile(orphanPart, "partial", "utf8");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await utimes(staleFile, twoDaysAgo, twoDaysAgo);
    await utimes(orphanPart, twoDaysAgo, twoDaysAgo);
    await utimes(batchDir, twoDaysAgo, twoDaysAgo);
    // sweepStaging 只看 import-tmp 顶层条目的 mtime，必须把 ui-batches 本身也做旧，
    // 否则顶层目录仍是新的，旧实现也会“通过”，测试没有区分力。
    await utimes(batchesRoot, twoDaysAgo, twoDaysAgo);

    await sweepStaging(dir);

    await assert.rejects(access(staleFile), "stale temp file should be removed");
    // ui-batches 批次目录由 sweepOldBatches 负责，不能被 sweepStaging 删掉
    await access(batchesRoot);
    await access(batchDir);
    // 中断上传留下的 .part 会被清掉，但批次目录本身保留。
    await assert.rejects(access(orphanPart), "orphan .part should be removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
