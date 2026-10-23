/**
 * 工作台导入进度：worker 每完成一个文件原子写 progress.json。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markImporting } from "../lib/store.js";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function runWorker(argsFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(pluginRoot, "worker", "import-worker.mjs"), `@${argsFile}`], {
      cwd: pluginRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

test("worker 写 progress.json：逐文件状态、原子写无残留临时文件", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-worker-progress-"));
  try {
    const kbRoot = join(root, "kb-root");
    const srcDir = join(root, "src");
    await mkdir(kbRoot, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    const okPath = join(srcDir, "ok.txt");
    const badPath = join(srcDir, "bad.docx");
    await writeFile(okPath, "正常文档内容。\n", "utf8");
    await writeFile(badPath, "this is not a docx", "utf8");

    const reportFile = join(root, "report.json");
    const progressFile = join(root, "progress.json");
    const argsFile = join(root, "args.json");
    await writeFile(
      argsFile,
      JSON.stringify({
        kbRoot,
        kb: "测试库",
        files: [
          { sourcePath: okPath, relKey: "ok.txt", title: "ok", sourceFile: "资料/ok.txt" },
          { sourcePath: badPath, relKey: "bad.docx", title: "bad", sourceFile: "资料/bad.docx" },
        ],
        config: { partMaxChars: 2000 },
        reportFile,
        progressFile,
      }),
      "utf8"
    );

    const result = await runWorker(argsFile);
    assert.equal(result.exitCode, 0, `unexpected exit: ${result.stderr}`);
    assert.match(result.stdout, /KB:RESULT/);

    const progress = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(progress.done, 2);
    assert.equal(progress.total, 2);
    assert.equal(progress.ok, 1);
    assert.equal(progress.fail, 1);
    assert.equal(progress.skip, 0);
    assert.equal(progress.done, progress.ok + progress.fail + progress.skip);
    assert.equal(progress.current, null, "current must be cleared once the batch is done");
    assert.ok(Number.isFinite(Date.parse(progress.updatedAt)), "progress.updatedAt must be an ISO timestamp");
    assert.equal(progress.files.find((f) => f.path === "资料/ok.txt")?.status, "ok");
    const failed = progress.files.find((f) => f.path === "资料/bad.docx");
    assert.equal(failed?.status, "failed");
    assert.ok(failed?.error?.length > 0);

    const report = JSON.parse(await readFile(reportFile, "utf8"));
    assert.equal(report.ok, 1);
    assert.equal(report.fail, 1);
    assert.equal(report.skip, 0);
    assert.equal(report.files.length, 2);

    const leftovers = (await readdir(root)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker 跳过正在导入的同一文档时 progress.done 也会前进", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-worker-progress-skip-"));
  try {
    const kb = "测试库";
    const kbRoot = join(root, "kb-root");
    const kbDir = join(kbRoot, kb);
    const srcDir = join(root, "src");
    await mkdir(kbRoot, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    const srcPath = join(srcDir, "dup.txt");
    await writeFile(srcPath, "正常文档内容。\n", "utf8");

    const files = [{ sourcePath: srcPath, relKey: "dup.txt", title: "dup", sourceFile: "资料/dup.txt" }];
    const firstReport = join(root, "report-1.json");
    const firstArgs = join(root, "args-1.json");
    await writeFile(
      firstArgs,
      JSON.stringify({ kbRoot, kb, files, config: { partMaxChars: 2000 }, reportFile: firstReport }),
      "utf8"
    );
    const first = await runWorker(firstArgs);
    assert.equal(first.exitCode, 0, `unexpected exit: ${first.stderr}`);
    const firstRun = JSON.parse(await readFile(firstReport, "utf8"));
    assert.equal(firstRun.ok, 1);
    const docId = firstRun.files[0].docId;
    assert.ok(docId, "the first import must report a docId");

    // 跳过条件（lib/store.js markImporting）：清单里同一 docId 已是 status=importing，
    // 且 heartbeatAt/updatedAt 在 30 分钟活跃窗口内 -> 返回 false，pipeline 返回 { skipped: true }。
    assert.equal(await markImporting(kbDir, { id: docId }), true);

    const progressFile = join(root, "progress.json");
    const reportFile = join(root, "report-2.json");
    const argsFile = join(root, "args-2.json");
    await writeFile(
      argsFile,
      JSON.stringify({ kbRoot, kb, files, config: { partMaxChars: 2000 }, reportFile, progressFile }),
      "utf8"
    );
    const second = await runWorker(argsFile);
    assert.equal(second.exitCode, 0, `unexpected exit: ${second.stderr}`);
    assert.match(second.stdout, /KB:SKIP/);

    const progress = JSON.parse(await readFile(progressFile, "utf8"));
    assert.deepEqual(
      { done: progress.done, total: progress.total, ok: progress.ok, fail: progress.fail, skip: progress.skip },
      { done: 1, total: 1, ok: 0, fail: 0, skip: 1 }
    );
    assert.equal(progress.files[0].path, "资料/dup.txt");
    assert.equal(progress.files[0].status, "skipped");
    assert.equal(progress.current, null);

    const report = JSON.parse(await readFile(reportFile, "utf8"));
    assert.deepEqual({ ok: report.ok, fail: report.fail, skip: report.skip }, { ok: 0, fail: 0, skip: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("进度文件写失败不改变导入结果，且只告警一次", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-worker-progress-fail-"));
  try {
    const kbRoot = join(root, "kb-root");
    const srcDir = join(root, "src");
    await mkdir(kbRoot, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    const okPath = join(srcDir, "ok.txt");
    await writeFile(okPath, "正常文档内容。\n", "utf8");
    // 让 progressFile 的父目录是个普通文件：写临时文件会以 ENOTDIR 失败。
    const blocker = join(root, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const progressFile = join(blocker, "progress.json");
    const reportFile = join(root, "report.json");
    const argsFile = join(root, "args.json");
    await writeFile(
      argsFile,
      JSON.stringify({
        kbRoot,
        kb: "测试库",
        files: [{ sourcePath: okPath, relKey: "ok.txt", title: "ok", sourceFile: "资料/ok.txt" }],
        config: { partMaxChars: 2000 },
        reportFile,
        progressFile,
      }),
      "utf8"
    );

    const result = await runWorker(argsFile);
    assert.equal(result.exitCode, 0, `unexpected exit: ${result.stderr}`);
    assert.match(result.stdout, /KB:RESULT/);
    assert.match(result.stdout, /KB:DONE/);

    const report = JSON.parse(await readFile(reportFile, "utf8"));
    assert.equal(report.ok, 1);
    assert.equal(report.fail, 0);

    const warnings = result.stderr.split("\n").filter((line) => line.includes("进度文件写入失败"));
    assert.equal(warnings.length, 1, `expected exactly one warning, got: ${result.stderr}`);
    assert.match(warnings[0], /^worker: 进度文件写入失败（忽略）: /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker 进度里的错误文本净化绝对路径", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-worker-progress-redact-"));
  try {
    const kbRoot = join(root, "kb-root");
    const kb = "测试库";
    const kbDir = join(kbRoot, kb);
    await mkdir(kbDir, { recursive: true });
    // 源文件不存在 → ENOENT 错误消息里带绝对 sourcePath，正好验证净化。
    const sourcePath = join(kbDir, "资料", "缺失.md");
    const progressFile = join(root, "progress.json");
    const reportFile = join(root, "report.json");
    const argsFile = join(root, "args.json");
    await writeFile(
      argsFile,
      JSON.stringify({
        kbRoot,
        kb,
        files: [{ sourcePath, relKey: "资料/缺失.md", title: "缺失", sourceFile: "资料/缺失.md" }],
        config: { partMaxChars: 2000 },
        reportFile,
        progressFile,
      }),
      "utf8"
    );

    const result = await runWorker(argsFile);
    assert.equal(result.exitCode, 1, `unexpected exit: ${result.stderr}`);
    const progress = JSON.parse(await readFile(progressFile, "utf8"));
    const failed = progress.files.find((file) => file.path === "资料/缺失.md");
    assert.equal(failed?.status, "failed");
    assert.ok(failed?.error?.length > 0);
    assert.equal(failed.error.includes(sourcePath), false);
    assert.equal(failed.error.includes(kbDir), false);
    assert.equal(failed.error.includes(pluginRoot), false);
    assert.ok(failed.error.includes("资料/缺失.md"), failed.error);
    assert.ok(failed.error.length <= 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
