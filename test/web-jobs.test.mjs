/**
 * 工作台任务注册表：进程内 Map，进度可来自 progress 文件，结果保留 1 小时。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobRegistry } from "../lib/web/jobs.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("start/get 暴露运行态与结算结果，且不泄露内部字段", async () => {
  const jobs = createJobRegistry();
  const gate = deferred();
  const id = jobs.start({
    kind: "kb-import",
    kb: "标准",
    label: "导入 标准",
    run: async () => {
      await gate.promise;
      return { status: "succeeded", detail: "完成", result: { ok: 1, fail: 0 } };
    },
  });
  assert.match(id, /^kb-import-/);

  let job = await jobs.get(id);
  assert.equal(job.status, "running");
  assert.equal(job.result, null);
  assert.deepEqual(Object.keys(job).sort(), [
    "detail", "finishedAt", "id", "kb", "kind", "label", "progress", "result", "startedAt", "status",
  ]);

  gate.resolve();
  await tick();
  job = await jobs.get(id);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.ok, 1);
  assert.ok(job.finishedAt);
});

test("import 进度从 progress 文件合并", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-jobs-"));
  const progressFile = join(root, "progress.json");
  await writeFile(progressFile, JSON.stringify({ done: 1, total: 2, ok: 1, fail: 0, skip: 0, current: "b.pdf", files: [] }), "utf8");
  const jobs = createJobRegistry();
  const id = jobs.start({
    kind: "kb-import",
    kb: "标准",
    label: "导入",
    run: async (job) => {
      job.setProgressFile(progressFile);
      return { status: "succeeded", detail: "完成", result: {} };
    },
  });
  await tick();
  const job = await jobs.get(id);
  assert.equal(job.progress.done, 1);
  assert.equal(job.progress.current, "b.pdf");
});

test("list 按 kb/kind 过滤并按开始时间倒序", async () => {
  let clock = 1000;
  const jobs = createJobRegistry({ now: () => clock });
  const a = jobs.start({ kind: "kb-import", kb: "A", label: "a", run: async () => ({ status: "succeeded" }) });
  clock += 10;
  const b = jobs.start({ kind: "kb-std", kb: "A", label: "b", run: async () => ({ status: "succeeded" }) });
  clock += 10;
  const c = jobs.start({ kind: "kb-import", kb: "B", label: "c", run: async () => ({ status: "succeeded" }) });
  await tick();
  assert.deepEqual((await jobs.list({ kb: "A" })).map((job) => job.id), [b, a]);
  assert.deepEqual((await jobs.list({ kind: "kb-import" })).map((job) => job.id), [c, a]);
  assert.equal((await jobs.list({ limit: 1 })).length, 1);
});

test("已结算任务超过保留期后被清理", async () => {
  let clock = 1000;
  const jobs = createJobRegistry({ retentionMs: 1000, now: () => clock });
  const id = jobs.start({ kind: "kb-import", kb: "A", label: "a", run: async () => ({ status: "succeeded" }) });
  await tick();
  assert.ok(await jobs.get(id));
  clock += 1001;
  assert.equal(await jobs.get(id), null);
});

test("超过 maxJobs 时淘汰最旧的已结算任务", async () => {
  const jobs = createJobRegistry({ maxJobs: 2 });
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    ids.push(jobs.start({ kind: "kb-import", kb: "A", label: String(i), run: async () => ({ status: "succeeded" }) }));
    await tick();
  }
  const kept = (await jobs.list({ limit: 50 })).map((job) => job.id);
  assert.equal(kept.length, 2);
  assert.equal(kept.includes(ids[0]), false);
  assert.equal(kept.includes(ids[2]), true);
});

test("cancelAll 取消运行中的 handle", async () => {
  const jobs = createJobRegistry();
  let cancelled = false;
  const gate = deferred();
  jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "a",
    run: async (job) => {
      job.setHandle({ cancel: () => { cancelled = true; gate.resolve(); } });
      await gate.promise;
      return { status: "succeeded" };
    },
  });
  await tick();
  jobs.cancelAll();
  assert.equal(cancelled, true);
});
