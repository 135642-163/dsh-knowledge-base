import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchKb } from "../lib/query.js";

const hasSqlite = await import("node:sqlite").then(() => true).catch(() => false);

/** 真实 ripgrep 的 ctx.subprocess 薄封装：验证“主号查询真的走了 rg”而不是 FTS。 */
function realSubprocess() {
  const calls = [];
  const ctx = {
    subprocess: {
      spawn(options) {
        calls.push(options);
        const child = spawnChild(options.argv[0], options.argv.slice(1), {
          cwd: options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const done = new Promise((resolve) => {
          child.on("error", () => resolve({ exitCode: 127, signal: null }));
          child.on("close", (code, signal) => resolve({ exitCode: code, signal }));
        });
        return {
          done,
          collected: {
            stdout: { readFrom: () => ({ text: stdout, lossy: false, nextOffset: stdout.length }) },
            stderr: { readFrom: () => ({ text: stderr, lossy: false, nextOffset: stderr.length }) },
          },
        };
      },
    },
  };
  return { ctx, calls };
}

test("searchKb 纯文本查询走 FTS5 条款并保留页码", { skip: !hasSqlite }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kb-query-fts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "markdown", "d1"), { recursive: true });
  await writeFile(join(root, "markdown", "d1", "d1.md"), [
    "# 风电场接入",
    "### 第 1 页",
    "5.2.2 风电场应满足电压偏差要求。",
  ].join("\n"), "utf8");
  const manifest = { docs: [{ id: "d1", title: "风电场接入", type: "pdf-text", status: "ready", version: 1, trust: "high" }] };
  const result = await searchKb({}, {}, root, manifest, { pattern: "电压偏差", ftsPattern: "电压偏差", maxMatches: 10 });
  assert.ok(result.matches.length >= 1);
  assert.equal(result.matches[0].docId, "d1");
  assert.equal(result.matches[0].pageStart, 1);
  assert.match(result.matches[0].line, /电压偏差/);
});

test("标准号查询走 ripgrep，GB 与 GB/T 不互相命中", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kb-query-std-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = [
    ["d1", "GB 1234-2020 电能质量 电压偏差", "GB 1234-2020"],
    ["d2", "GB/T 1234-2020 电能质量 谐波", "GB/T 1234-2020"],
  ];
  for (const [id, title, standard] of docs) {
    await mkdir(join(root, "markdown", id), { recursive: true });
    await writeFile(join(root, "markdown", id, `${id}.md`), [
      `# ${title}`,
      "### 第 1 页",
      "1 范围",
      standard,
      "本文件规定了限值。",
    ].join("\n"), "utf8");
  }
  const manifest = {
    docs: docs.map(([id, title]) => ({ id, title, type: "pdf-text", status: "ready", version: 1, trust: "high" })),
  };
  const exec = { signal: { aborted: false } };
  const gbt = realSubprocess();
  const onlyGbt = await searchKb(gbt.ctx, exec, root, manifest, { pattern: "GB/T 1234", maxMatches: 10 });
  assert.equal(gbt.calls.length, 1, "标准号查询应调用 ripgrep，而不是 FTS");
  assert.deepEqual([...new Set(onlyGbt.matches.map((m) => m.docId))], ["d2"]);
  const gb = realSubprocess();
  const onlyGb = await searchKb(gb.ctx, exec, root, manifest, { pattern: "GB 1234", maxMatches: 10 });
  assert.equal(gb.calls.length, 1);
  assert.deepEqual([...new Set(onlyGb.matches.map((m) => m.docId))], ["d1"]);
});
