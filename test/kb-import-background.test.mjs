/**
 * 工具级：后台导入部分失败时，任务状态不能是 completed。
 * 走真实的 kb_import → worker → 任务 done 路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

function makeContext() {
  const tools = new Map();
  let started = null;
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get(name) {
      if (name === "jobs") {
        return {
          start(options) {
            started = options;
            return "job-bg-1";
          },
        };
      }
      return undefined;
    },
    subprocess: {
      spawn({ argv, cwd }) {
        const child = spawn(argv[0], argv.slice(1), {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        child.stdout.on("data", (chunk) => {
          stdout = Buffer.concat([stdout, chunk]);
        });
        child.stderr.on("data", (chunk) => {
          stderr = Buffer.concat([stderr, chunk]);
        });
        const done = new Promise((resolve) => {
          child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
        });
        return {
          done,
          collected: {
            stdout: {
              readFrom: (offset) => ({
                text: stdout.subarray(offset).toString("utf8"),
                nextOffset: stdout.length,
                lossy: false,
              }),
            },
            stderr: {
              readFrom: () => ({
                text: stderr.toString("utf8"),
                nextOffset: stderr.length,
                lossy: false,
              }),
            },
          },
          terminate: () => child.kill(),
        };
      },
    },
  };
  return { ctx, tools, getStarted: () => started };
}

test("background import with one failure ends as failed", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-bg-import-"));
  try {
    const kbRoot = join(root, "kb-root");
    const srcDir = join(root, "src");
    await mkdir(kbRoot, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "ok.txt"), "正常文档内容。\n", "utf8");
    await writeFile(join(srcDir, "bad.docx"), "this is not a docx", "utf8");

    const { ctx, tools, getStarted } = makeContext();
    await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 2000 });

    const exec = {
      agent: { session: { header: { cwd: root } } },
      signal: new AbortController().signal,
    };
    const result = await tools.get("kb_import").execute(
      { path: srcDir, kb: "测试库", runInBackground: true },
      exec
    );
    assert.equal(result.inline, false);
    assert.equal(result.jobId, "job-bg-1");

    const started = getStarted();
    assert.ok(started, "jobs.start must be called");
    const task = started.run();
    const done = await task.done;
    assert.equal(done.status, "failed");
    assert.match(done.detail, /部分失败/);
    assert.match(done.detail, /成功 1/);
    assert.match(done.detail, /失败 1/);

    const listed = await tools.get("kb_list").execute({ kb: "测试库" }, exec);
    assert.equal(listed.docs.length, 2);
    assert.equal(listed.docs.filter((d) => d.status === "ready").length, 1);
    assert.equal(listed.docs.filter((d) => d.status === "failed").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
