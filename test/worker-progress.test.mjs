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

    const progress = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(progress.done, 2);
    assert.equal(progress.total, 2);
    assert.equal(progress.ok, 1);
    assert.equal(progress.fail, 1);
    assert.equal(progress.files.find((f) => f.path === "资料/ok.txt")?.status, "ok");
    const failed = progress.files.find((f) => f.path === "资料/bad.docx");
    assert.equal(failed?.status, "failed");
    assert.ok(failed?.error?.length > 0);

    const leftovers = (await readdir(root)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
