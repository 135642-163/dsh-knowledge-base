/**
 * 0.4.1 跨库检索：kb="*" 搜索全部知识库，结果带 kb 字段并按标题命中排序。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

test("kb_query with kb=* searches every knowledge base", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-cross-"));
  try {
    const kbRoot = join(root, "kb-root");
    await mkdir(kbRoot, { recursive: true });
    const tools = new Map();
    const ctx = {
      tools: { register(def) { tools.set(def.name, def); } },
      systemPrompt: { section() {} },
      get() { return undefined; },
      subprocess: {
        spawn({ argv, cwd }) {
          const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
          let out = Buffer.alloc(0);
          child.stdout.on("data", (d) => { out = Buffer.concat([out, d]); });
          const done = new Promise((resolve) =>
            child.on("close", (exitCode, signal) => resolve({ exitCode, signal }))
          );
          return {
            done,
            collected: {
              stdout: { readFrom: (off) => ({ text: out.subarray(off).toString("utf8"), nextOffset: out.length, lossy: false }) },
              stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
            },
            terminate: () => child.kill(),
          };
        },
      },
    };
    await apply(ctx, { kbRoot, defaultKb: "库A" });
    const exec = {
      agent: { session: { header: { cwd: root } } },
      signal: new AbortController().signal,
    };

    await tools.get("kb_add_note").execute(
      { kb: "库A", title: "电压偏差分析", content: "## 一\n\n电压偏差分析正文。" },
      exec
    );
    await tools.get("kb_add_note").execute(
      { kb: "库B", title: "无关文档", content: "## 一\n\n这里也提到电压偏差。" },
      exec
    );
    // 空知识库没有 markdown 目录：跨库检索必须跳过它，而不是让 rg 以退出码 2 失败
    const emptyDir = join(kbRoot, "空库");
    await mkdir(emptyDir, { recursive: true });
    await writeFile(
      join(emptyDir, "kb.json"),
      JSON.stringify({ schemaVersion: 2, name: "空库", docs: [] }),
      "utf8"
    );

    const r = await tools.get("kb_query").execute(
      { kb: "*", pattern: "电压偏差", maxMatches: 10 },
      exec
    );
    assert.equal(r.kb, "*");
    assert.deepEqual(new Set(r.searchedKbs), new Set(["库A", "库B", "空库"]));
    assert.ok(r.matches.some((m) => m.kb === "库A"));
    assert.ok(r.matches.some((m) => m.kb === "库B"));
    assert.equal(r.matches[0].kb, "库A", "title hit should rank first across KBs");
    const text = tools.get("kb_query").output.render({ kb: "*", pattern: "电压偏差" }, r)[0].text;
    assert.match(text, /库A/);
    assert.match(text, /库B/);

    await assert.rejects(
      () => tools.get("kb_query").execute({ kb: "*", doc: "电压偏差分析", pattern: "电压" }, exec),
      /doc 只能用于单个知识库/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
