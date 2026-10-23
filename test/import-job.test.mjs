/**
 * worker 启动内核：工具路径与工作台路径共用参数准备与报告归一化。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImportWorkerRunner, prepareImportArgs } from "../lib/import-job.js";
import { createKb } from "../lib/kbmeta.js";

function fakeSpawn({ exitCode = 0, stderr = "", onRun } = {}) {
  return (spec) => {
    onRun?.(spec);
    return {
      terminate: async () => {},
      done: Promise.resolve({ exitCode, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
      },
    };
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-import-job-"));
  const kbRoot = join(root, "kb");
  const { manifest } = await createKb(kbRoot, { name: "测" });
  return { root, kbRoot, kb: manifest.name, dir: join(kbRoot, manifest.name), reportFile: join(root, "report.json") };
}

test("prepareImportArgs 写 @file 参数并透传 progressFile", async () => {
  const { root, kbRoot, kb, dir } = await setup();
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
});

test("runner 读完报告后归一化状态并清理参数/报告文件", async () => {
  const { kbRoot, kb, dir, reportFile } = await setup();
  await writeFile(reportFile, JSON.stringify({ ok: 1, fail: 0, skip: 0, files: [{ title: "a", status: "ok" }] }));
  const argsFile = await prepareImportArgs({
    dir,
    kbRoot,
    kb,
    files: [{ sourcePath: "/tmp/a.md", relKey: "a.md", title: "a" }],
    config: {},
    reportFile,
  });
  const runner = createImportWorkerRunner({ spawn: fakeSpawn(), dir, argsFile, reportFile, fileCount: 1, kb });
  const outcome = await runner.run().done;
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.report.ok, 1);
  assert.equal(existsSync(argsFile), false);
  assert.equal(existsSync(reportFile), false);
});

test("runner 在进程异常退出时返回 failed 并带已完成计数", async () => {
  const { kbRoot, kb, dir, reportFile } = await setup();
  await writeFile(reportFile, JSON.stringify({ ok: 1, fail: 1, skip: 0, files: [] }));
  const argsFile = await prepareImportArgs({
    dir,
    kbRoot,
    kb,
    files: [{ sourcePath: "/tmp/a.md", relKey: "a.md", title: "a" }],
    config: {},
    reportFile,
  });
  const runner = createImportWorkerRunner({ spawn: fakeSpawn({ exitCode: 3, stderr: "boom" }), dir, argsFile, reportFile, fileCount: 2, kb });
  const outcome = await runner.run().done;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail, /导入进程异常退出 \(3\)/);
  assert.match(outcome.detail, /成功 1，失败 1/);
});
