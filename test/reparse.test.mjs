/**
 * 0.4.0 kb_reparse：从库内 sources/ 重解析，保留原 sourcePath/title，版本 +1。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { readManifest } from "../lib/store.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-reparse-"));
  const kbRoot = join(root, "kb-root");
  await mkdir(kbRoot, { recursive: true });
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 2000 });
  const exec = {
    agent: { session: { header: { cwd: root } } },
    signal: new AbortController().signal,
  };
  return { root, kbRoot, tools, exec };
}

test("kb_reparse reuses the stored source and preserves metadata", async () => {
  const { root, kbRoot, tools, exec } = await setup();
  try {
    const src = join(root, "原始文件.txt");
    await writeFile(src, "第一版正文。\n", "utf8");
    const imported = await tools.get("kb_import").execute(
      { path: src, kb: "测试库", title: "原始文件" },
      exec
    );
    const docId = imported.imported[0].docId;
    const before = (await readManifest(join(kbRoot, "测试库"))).docs.find((d) => d.id === docId);
    assert.equal(before.sourcePath, src);

    // 原始外部文件删掉，证明重解析用的是 sources/ 里的副本
    await rm(src, { force: true });

    const reparsed = await tools.get("kb_reparse").execute(
      { kb: "测试库", doc: docId },
      exec
    );
    assert.equal(reparsed.inline, true);
    assert.equal(reparsed.results.length, 1);
    assert.equal(reparsed.results[0].error, undefined);
    assert.equal(reparsed.results[0].docId, docId);

    const after = (await readManifest(join(kbRoot, "测试库"))).docs.find((d) => d.id === docId);
    assert.equal(after.version, 2);
    assert.equal(after.sourcePath, src, "the original external path must be preserved");
    assert.equal(after.sourceFile, "原始文件.txt");
    assert.equal(after.title, "原始文件");
    const rendered = tools.get("kb_reparse").output.render({ kb: "测试库", doc: docId }, reparsed)[0].text;
    assert.match(rendered, /已重解析 1 个文档/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_reparse requires a target and rejects notes", async () => {
  const { root, tools, exec } = await setup();
  try {
    await assert.rejects(
      () => tools.get("kb_reparse").execute({ kb: "测试库" }, exec),
      /请指定 doc/
    );
    const note = await tools.get("kb_add_note").execute(
      { kb: "测试库", title: "笔记", content: "## 一\n\n内容" },
      exec
    );
    await assert.rejects(
      () => tools.get("kb_reparse").execute({ kb: "测试库", doc: note.docId }, exec),
      /笔记没有原始文件/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
