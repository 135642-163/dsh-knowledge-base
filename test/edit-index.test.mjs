/**
 * kb_edit 后：edited=true，parts/index.json 重建，检索仍能映射到正确的 part。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { importFileInto } from "../lib/pipeline.js";
import { readManifest } from "../lib/store.js";

test("kb_edit marks edited and rebuilds the parts index", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-edit-index-"));
  try {
    const kbRoot = join(root, "kb-root");
    const kbDir = join(kbRoot, "测试库");
    await mkdir(kbDir, { recursive: true });
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
    await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 500 });
    const exec = {
      agent: { session: { header: { cwd: root } } },
      signal: new AbortController().signal,
    };

    const src = join(root, "book.md");
    await writeFile(src, "# 第一章\n\nAAAA。\n\n# 第二章\n\nBBBB。\n\n# 第三章\n\nCCCC。\n", "utf8");
    const imported = await importFileInto(kbDir, {
      sourcePath: src,
      relKey: "book.md",
      title: "书",
      config: { partMaxChars: 10 },
    });

    await tools.get("kb_edit").execute(
      { kb: "测试库", doc: imported.docId, old_string: "BBBB", new_string: "BEEF" },
      exec
    );

    const manifest = await readManifest(kbDir);
    const doc = manifest.docs.find((d) => d.id === imported.docId);
    assert.equal(doc.edited, true);
    assert.equal(doc.version, 2);

    const index = JSON.parse(
      await readFile(join(kbDir, "markdown", imported.docId, "parts", "index.json"), "utf8")
    );
    assert.ok(index.length >= 3);
    for (let i = 1; i < index.length; i++) {
      assert.ok(index[i].startLine > index[i - 1].endLine);
    }

    const q = await tools.get("kb_query").execute(
      { kb: "测试库", pattern: "BEEF", maxMatches: 5 },
      exec
    );
    assert.equal(q.total, 1);
    assert.equal(q.matches[0].part, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
