/**
 * 工作台任务注册表：进程内 Map，进度可来自 progress 文件，结果保留 1 小时。
 * 覆盖结算契约（onSettle 恰好一次、先于终态可见）、进度缓存、取消与 hasRunning。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  try {
    const progressFile = join(root, "progress.json");
    await writeFile(progressFile, JSON.stringify({ done: 1, total: 2, ok: 1, fail: 0, skip: 0, current: "b.pdf", files: [] }), "utf8");
    const jobs = createJobRegistry();
    const gate = deferred();
    const id = jobs.start({
      kind: "kb-import",
      kb: "标准",
      label: "导入",
      run: async (job) => {
        job.setProgressFile(progressFile);
        await gate.promise;
        return { status: "succeeded", detail: "完成", result: {} };
      },
    });
    await tick();
    let job = await jobs.get(id);
    assert.equal(job.status, "running");
    assert.equal(job.progress.done, 1);
    assert.equal(job.progress.current, "b.pdf");

    gate.resolve();
    await tick();
    job = await jobs.get(id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.progress.done, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  await tick();
});

test("run 抛错 → failed，onSettle 仍收到一次 failed", async () => {
  const jobs = createJobRegistry();
  let calls = 0;
  let seen = null;
  const id = jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "a",
    run: async () => { throw new Error("boom"); },
    onSettle: (view) => {
      calls += 1;
      seen = view;
    },
  });
  await tick();
  const job = await jobs.get(id);
  assert.equal(job.status, "failed");
  assert.equal(job.detail, "boom");
  assert.ok(job.finishedAt);
  assert.equal(calls, 1);
  assert.equal(seen.status, "failed");
  assert.equal(seen.detail, "boom");
  assert.equal(seen.result, null);
});

test("run 返回 cancelled → 任务失败", async () => {
  const jobs = createJobRegistry();
  const id = jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "a",
    run: async () => ({ status: "cancelled", detail: "已取消" }),
  });
  await tick();
  const job = await jobs.get(id);
  assert.equal(job.status, "failed");
  assert.equal(job.detail, "已取消");
});

test("run 返回 completed → 任务成功", async () => {
  const jobs = createJobRegistry();
  const id = jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "a",
    run: async () => ({ status: "completed", detail: "完成", result: { ok: 2 } }),
  });
  await tick();
  const job = await jobs.get(id);
  assert.equal(job.status, "succeeded");
  assert.equal(job.detail, "完成");
  assert.deepEqual(job.result, { ok: 2 });
});

test("run 返回非结果对象（runner handle）→ failed 且标注无效结果", async () => {
  const jobs = createJobRegistry();
  const runner = { done: Promise.resolve(), cancel() {} };
  let settleStatus = null;
  const id = jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "a",
    run: async () => runner,
    onSettle: (view) => { settleStatus = view.status; },
  });
  await tick();
  const job = await jobs.get(id);
  assert.equal(job.status, "failed");
  assert.match(job.detail, /run\(\) 未返回有效结果/);
  assert.equal(settleStatus, "failed");
});

test("onSettle 抛错不改变状态，detail 记录收尾失败", async () => {
  const jobs = createJobRegistry();
  let calls = 0;
  const id = jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "a",
    run: async () => ({ status: "succeeded", detail: "完成", result: { ok: 1 } }),
    onSettle: async () => {
      calls += 1;
      throw new Error("hook-boom");
    },
  });
  await tick();
  const job = await jobs.get(id);
  assert.equal(calls, 1);
  assert.equal(job.status, "succeeded");
  assert.match(job.detail, /完成；收尾失败：hook-boom/);
  assert.deepEqual(job.result, { ok: 1 });
});

test("onSettle 在任务对 get 可见为已结算之前调用", async () => {
  const jobs = createJobRegistry();
  const gate = deferred();
  let hookStatus = null;
  let hookFinished = false;
  const id = jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "a",
    run: async () => ({ status: "succeeded", detail: "完成" }),
    onSettle: async (view) => {
      hookStatus = view.status;
      await gate.promise;
      hookFinished = true;
    },
  });
  await tick();
  assert.equal(hookStatus, "succeeded");
  assert.equal(hookFinished, false);
  assert.equal((await jobs.get(id)).status, "running");

  gate.resolve();
  await tick();
  assert.equal(hookFinished, true);
  assert.equal((await jobs.get(id)).status, "succeeded");
});

test("list 合并运行中 import 任务的 progress 且 kind 不可被文件伪造", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-jobs-"));
  try {
    const progressFile = join(root, "progress.json");
    await writeFile(progressFile, JSON.stringify({ kind: "kb-std", done: 1, total: 3, current: "a.pdf" }), "utf8");
    const jobs = createJobRegistry();
    const gate = deferred();
    const id = jobs.start({
      kind: "kb-import",
      kb: "A",
      label: "a",
      run: async (job) => {
        job.setProgressFile(progressFile);
        await gate.promise;
        return { status: "succeeded" };
      },
    });
    await tick();
    const running = await jobs.list({ kb: "A" });
    assert.equal(running.length, 1);
    assert.equal(running[0].id, id);
    assert.equal(running[0].status, "running");
    assert.equal(running[0].progress.done, 1);
    assert.equal(running[0].progress.current, "a.pdf");
    assert.equal(running[0].progress.kind, "import");

    await writeFile(progressFile, JSON.stringify([1, 2]), "utf8");
    const cached = await jobs.list({ kb: "A" });
    assert.equal(cached[0].progress.done, 1);

    gate.resolve();
    await tick();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelAll 单个 handle 抛错不影响其他任务", async () => {
  const jobs = createJobRegistry();
  const gate = deferred();
  let secondCancelled = false;
  jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "a",
    run: async (job) => {
      job.setHandle({ cancel: () => { throw new Error("boom"); } });
      await gate.promise;
      return { status: "succeeded" };
    },
  });
  jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "b",
    run: async (job) => {
      job.setHandle({ cancel: () => { secondCancelled = true; gate.resolve(); } });
      await gate.promise;
      return { status: "succeeded" };
    },
  });
  await tick();
  jobs.cancelAll();
  assert.equal(secondCancelled, true);
  await tick();
});

test("cancelAll 在 setHandle 之前请求时，挂载后立即取消", async () => {
  const jobs = createJobRegistry();
  const gate = deferred();
  let cancelled = false;
  jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "a",
    run: async (job) => {
      await gate.promise;
      job.setHandle({ cancel: () => { cancelled = true; } });
      return { status: "succeeded" };
    },
  });
  await tick();
  jobs.cancelAll();
  assert.equal(cancelled, false);

  gate.resolve();
  await tick();
  assert.equal(cancelled, true);
});

test("hasRunning 按 kb/kind 过滤运行中任务", async () => {
  const jobs = createJobRegistry();
  const gate = deferred();
  const id = jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "a",
    run: async () => {
      await gate.promise;
      return { status: "succeeded" };
    },
  });
  await tick();
  assert.equal(jobs.hasRunning(), true);
  assert.equal(jobs.hasRunning({ kb: "A" }), true);
  assert.equal(jobs.hasRunning({ kb: "A", kind: "kb-import" }), true);
  assert.equal(jobs.hasRunning({ kb: "B" }), false);
  assert.equal(jobs.hasRunning({ kind: "kb-std" }), false);

  gate.resolve();
  await tick();
  assert.equal(jobs.hasRunning(), false);
  assert.ok(await jobs.get(id));
});
