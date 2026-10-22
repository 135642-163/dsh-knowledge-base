/**
 * 后台 worker 的重解析路径：files 里的 docId/sourceFile/storedSourcePath/forceReparse
 * 必须被透传，且保留原始 sourcePath。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importFileInto } from "../lib/pipeline.js";
import { readManifest } from "../lib/store.js";

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

test("worker reparse preserves source metadata", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-worker-reparse-"));
  try {
    const kbRoot = join(root, "kb-root");
    const kb = "测试库";
    const kbDir = join(kbRoot, kb);
    await mkdir(kbDir, { recursive: true });
    const src = join(root, "原始文件.txt");
    await writeFile(src, "第一版正文。\n", "utf8");

    const imported = await importFileInto(kbDir, {
      sourcePath: src,
      relKey: "原始文件.txt",
      title: "原始文件",
      config: { partMaxChars: 2000 },
    });
    const before = (await readManifest(kbDir)).docs.find((d) => d.id === imported.docId);
    assert.equal(before.sourcePath, src);
    await rm(src, { force: true });

    const reportFile = join(root, "report.json");
    const argsFile = join(root, "args.json");
    await writeFile(
      argsFile,
      JSON.stringify({
        kbRoot,
        kb,
        files: [
          {
            sourcePath: join(kbDir, "sources", `${before.id}.txt`),
            relKey: before.sourceFile,
            title: before.title,
            docId: before.id,
            sourceFile: before.sourceFile,
            storedSourcePath: before.sourcePath,
            forceReparse: true,
          },
        ],
        config: { partMaxChars: 2000, forceReparse: true },
        reportFile,
      }),
      "utf8"
    );

    const result = await runWorker(argsFile);
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    assert.equal(report.ok, 1);
    assert.equal(report.fail, 0);

    const after = (await readManifest(kbDir)).docs.find((d) => d.id === before.id);
    assert.equal(after.version, 2);
    assert.equal(after.sourcePath, src, "original sourcePath must survive a background reparse");
    assert.equal(after.sourceFile, "原始文件.txt");
    assert.equal(after.title, "原始文件");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
