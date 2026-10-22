/**
 * worker 必须留下逐文件统计，供后台任务判断“完成/部分失败”。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

test("worker writes per-file counts and continues after one failure", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-worker-"));
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
    const argsFile = join(root, "args.json");
    await writeFile(
      argsFile,
      JSON.stringify({
        kbRoot,
        kb: "测试库",
        files: [
          { sourcePath: okPath, relKey: "ok.txt", title: "ok" },
          { sourcePath: badPath, relKey: "bad.docx", title: "bad" },
        ],
        config: { partMaxChars: 2000 },
        reportFile,
      }),
      "utf8"
    );

    const result = await runWorker(argsFile);
    assert.equal(result.exitCode, 0, `unexpected exit: ${result.stderr}`);
    assert.match(result.stdout, /KB:RESULT/);
    assert.match(result.stdout, /KB:FAIL/);

    const report = JSON.parse(await readFile(reportFile, "utf8"));
    assert.equal(report.ok, 1);
    assert.equal(report.fail, 1);
    assert.equal(report.skip, 0);
    assert.equal(report.files.length, 2);
    assert.equal(report.files.find((f) => f.title === "ok")?.status, "ok");
    assert.equal(report.files.find((f) => f.title === "bad")?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
