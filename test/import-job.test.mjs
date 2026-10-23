/**
 * worker 启动内核：工具路径与工作台路径共用参数准备与报告归一化。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImportWorkerRunner, prepareImportArgs } from "../lib/import-job.js";
import { createKb } from "../lib/kbmeta.js";

/**
 * 假 spawn：支持立即/延迟完成（deferred）和可配置 stdout/stderr。
 * deferred 时 terminate() 以 SIGTERM 结束进程，模拟取消落地的时序。
 */
function fakeSpawn({ exitCode = 0, signal = null, stderr = "", stdout = "", deferred = false } = {}) {
  const handles = [];
  const spawn = () => {
    let finish;
    let terminateCalls = 0;
    const handle = {
      done: deferred
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ exitCode, signal }),
      finish: (value = { exitCode, signal }) => finish?.(value),
      get terminateCalls() {
        return terminateCalls;
      },
      terminate: async () => {
        terminateCalls += 1;
        if (deferred) handle.finish({ exitCode: null, signal: "SIGTERM" });
      },
      collected: {
        stdout: {
          readFrom: (offset = 0) => ({ text: stdout.slice(offset), nextOffset: stdout.length, lossy: false }),
        },
        stderr: {
          readFrom: (offset = 0) => ({ text: stderr.slice(offset), nextOffset: stderr.length, lossy: false }),
        },
      },
    };
    handles.push(handle);
    return handle;
  };
  spawn.handles = handles;
  return spawn;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-import-job-"));
  const kbRoot = join(root, "kb");
  const { manifest } = await createKb(kbRoot, { name: "测" });
  return { root, kbRoot, kb: manifest.name, dir: join(kbRoot, manifest.name), reportFile: join(root, "report.json") };
}

function prepareArgs({ kbRoot, kb, dir, reportFile }, { files, config = {} } = {}) {
  return prepareImportArgs({
    dir,
    kbRoot,
    kb,
    files: files ?? [{ sourcePath: "/tmp/a.md", relKey: "a.md", title: "a" }],
    config,
    reportFile,
  });
}

test("prepareImportArgs 写 @file 参数并透传 progressFile", async () => {
  const { root, kbRoot, kb, dir } = await setup();
  try {
    const argsFile = await prepareImportArgs({
      dir,
      kbRoot,
      kb,
      files: [{ sourcePath: "/tmp/a.pdf", relKey: "a.pdf", title: "a" }],
      config: { ocrModel: "fast" },
      reportFile: join(root, "report.json"),
      progressFile: join(root, "progress.json"),
    });
    const payload = JSON.parse(await readFile(argsFile, "utf8"));
    assert.equal(payload.kbRoot, kbRoot);
    assert.equal(payload.progressFile, join(root, "progress.json"));
    assert.equal(payload.files[0].relKey, "a.pdf");
    assert.ok(argsFile.startsWith(join(dir, "import-tmp")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner 读完报告后归一化状态并清理参数/报告文件", async () => {
  const ctx = await setup();
  try {
    await writeFile(ctx.reportFile, JSON.stringify({ ok: 1, fail: 0, skip: 0, files: [{ title: "a", status: "ok" }] }));
    const argsFile = await prepareArgs(ctx);
    const runner = createImportWorkerRunner({
      spawn: fakeSpawn(),
      dir: ctx.dir,
      argsFile,
      reportFile: ctx.reportFile,
      fileCount: 1,
      kb: ctx.kb,
    });
    const outcome = await runner.run().done;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.report.ok, 1);
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.signal, null);
    assert.equal(existsSync(argsFile), false);
    assert.equal(existsSync(ctx.reportFile), false);
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("cancel() 后任务返回 cancelled、只终止一次并清理参数/报告文件", async () => {
  const ctx = await setup();
  try {
    await writeFile(ctx.reportFile, JSON.stringify({ ok: 0, fail: 0, skip: 0, files: [] }));
    const argsFile = await prepareArgs(ctx);
    const spawn = fakeSpawn({ deferred: true });
    const runner = createImportWorkerRunner({
      spawn,
      dir: ctx.dir,
      argsFile,
      reportFile: ctx.reportFile,
      fileCount: 1,
      kb: ctx.kb,
    });
    const task = runner.run();
    task.cancel();
    task.cancel(); // 幂等：重复取消不应再次 terminate
    const outcome = await task.done;
    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.cancelled, true);
    assert.match(outcome.detail, /已取消/);
    assert.equal(outcome.report, null);
    assert.equal(outcome.exitCode, null);
    assert.equal(outcome.signal, null);
    assert.equal(spawn.handles[0].terminateCalls, 1);
    assert.equal(existsSync(argsFile), false);
    assert.equal(existsSync(ctx.reportFile), false);
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("报告文件缺失时从 stdout 的 KB:OK/KB:FAIL/KB:SKIP 行兜底统计", async () => {
  const ctx = await setup();
  try {
    const argsFile = await prepareArgs(ctx);
    const runner = createImportWorkerRunner({
      spawn: fakeSpawn({ stdout: "KB:OK [1/3] a\nKB:FAIL [2/3] b\nKB:SKIP [3/3] c\n" }),
      dir: ctx.dir,
      argsFile,
      reportFile: ctx.reportFile,
      fileCount: 3,
      kb: ctx.kb,
    });
    const outcome = await runner.run().done;
    assert.deepEqual(outcome.report, { ok: 1, fail: 1, skip: 1 });
    // 有失败文件即部分失败：状态沿用 summarizeImportReport 的不变量；
    // exitCode === 0 只说明 worker 进程正常跑完（详见 report.js）。
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.signal, null);
    assert.equal(existsSync(argsFile), false);
    assert.equal(existsSync(ctx.reportFile), false);
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});

test("runner 在进程异常退出时返回 failed 并带已完成计数", async () => {
  const ctx = await setup();
  try {
    await writeFile(ctx.reportFile, JSON.stringify({ ok: 1, fail: 1, skip: 0, files: [] }));
    const argsFile = await prepareArgs(ctx);
    const runner = createImportWorkerRunner({
      spawn: fakeSpawn({ exitCode: 3, stderr: "boom" }),
      dir: ctx.dir,
      argsFile,
      reportFile: ctx.reportFile,
      fileCount: 2,
      kb: ctx.kb,
    });
    const outcome = await runner.run().done;
    assert.equal(outcome.status, "failed");
    assert.match(outcome.detail, /导入进程异常退出 \(3\)/);
    assert.match(outcome.detail, /成功 1，失败 1/);
    assert.ok(outcome.report, "report must be present for failure diagnostics");
    assert.equal(outcome.report.ok, 1);
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.exitCode, 3);
    assert.equal(outcome.signal, null);
    assert.equal(existsSync(argsFile), false);
    assert.equal(existsSync(ctx.reportFile), false);
  } finally {
    await rm(ctx.root, { recursive: true, force: true });
  }
});
