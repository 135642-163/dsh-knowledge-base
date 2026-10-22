/**
 * 0.13.0 Wiki 编译层：schema / index / log 三个虚拟文档 + kb_describe 编目。
 * - 建库导入后自动生成 schema.md / index.md / log.md；
 * - kb_read 支持 doc="schema" / "index" / "log"；
 * - kb_describe 写摘要/标签，重解析不覆盖模型摘要；
 * - index.md 随清单刷新，导出带上索引与 frontmatter。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-wiki-layer-"));
  const kbRoot = join(root, "kb-root");
  await mkdir(kbRoot, { recursive: true });
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 300, readMaxChars: 20000 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  const src = join(root, "资料.md");
  await writeFile(
    src,
    "# 概述\n\n本资料说明电能质量治理的基本流程与常见问题。\n\n# 方法\n\n先测量再治理。\n",
    "utf8"
  );
  const imported = await tools.get("kb_import").execute(
    { path: src, kb: "测试库", title: "电能质量资料" },
    exec
  );
  return { root, kbRoot, kbDir: join(kbRoot, "测试库"), tools, exec, docId: imported.imported[0].docId };
}

test("import creates schema.md / index.md / log.md", async () => {
  const { root, kbDir } = await setup();
  try {
    for (const file of ["schema.md", "index.md", "log.md"]) {
      await access(join(kbDir, file));
    }
    const schema = await readFile(join(kbDir, "schema.md"), "utf8");
    assert.match(schema, /# schema\.md/);
    assert.match(schema, /三类操作/);
    const index = await readFile(join(kbDir, "index.md"), "utf8");
    assert.match(index, /电能质量资料/);
    assert.match(index, /本资料说明电能质量治理/);
    const log = await readFile(join(kbDir, "log.md"), "utf8");
    assert.match(log, /ingest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_read serves virtual schema/index/log documents", async () => {
  const { root, tools, exec } = await setup();
  try {
    const index = await tools.get("kb_read").execute({ kb: "测试库", doc: "index" }, exec);
    assert.equal(index.virtual, true);
    assert.equal(index.docId, "index");
    assert.match(index.text, /电能质量资料/);
    assert.match(index.text, /本资料说明电能质量治理/);

    const schema = await tools.get("kb_read").execute({ kb: "测试库", doc: "schema", part: 1 }, exec);
    assert.match(schema.text, /# schema\.md/);
    const outline = await tools.get("kb_read").execute(
      { kb: "测试库", doc: "schema", part: "outline" },
      exec
    );
    assert.ok(outline.outline.length >= 3);
    assert.ok(outline.outline.some((item) => item.title.includes("三类操作")));

    const log = await tools.get("kb_read").execute({ kb: "测试库", doc: "log" }, exec);
    assert.match(log.text, /# 操作日志/);
    assert.match(log.text, /电能质量资料/);
    assert.match(log.text, /ingest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_edit can revise schema but not index/log", async () => {
  const { root, tools, exec, kbRoot } = await setup();
  try {
    const edited = await tools.get("kb_edit").execute(
      { kb: "测试库", doc: "schema", old_string: "## 页面规范", new_string: "## 页面规范（本库）" },
      exec
    );
    assert.equal(edited.replaced, 1);
    const schemaText = await readFile(join(kbRoot, "测试库", "schema.md"), "utf8");
    assert.match(schemaText, /## 页面规范（本库）/);

    await assert.rejects(
      () => tools.get("kb_edit").execute({ kb: "测试库", doc: "index", old_string: "a", new_string: "b" }, exec),
      /自动维护/
    );
    await assert.rejects(
      () => tools.get("kb_edit").execute({ kb: "测试库", doc: "log", old_string: "a", new_string: "b" }, exec),
      /自动维护/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_describe stores a model summary that survives reparse", async () => {
  const { root, tools, exec, docId } = await setup();
  try {
    const described = await tools.get("kb_describe").execute(
      { kb: "测试库", doc: docId, summary: "电能质量治理流程综述", tags: ["电能质量", "治理"] },
      exec
    );
    assert.equal(described.summary, "电能质量治理流程综述");
    assert.deepEqual(described.tags, ["电能质量", "治理"]);

    const listed = await tools.get("kb_list").execute({ kb: "测试库" }, exec);
    assert.equal(listed.docs[0].summary, "电能质量治理流程综述");
    assert.deepEqual(listed.docs[0].tags, ["电能质量", "治理"]);
    assert.match(listed.docs[0].summarySource, /model/);
    const text = tools.get("kb_list").output.render({ kb: "测试库" }, listed)[0].text;
    assert.match(text, /电能质量治理流程综述/);
    assert.match(text, /维护规范 schema\.md/);

    // 重解析是“auto”摘要：不能覆盖人工/模型编目
    await tools.get("kb_reparse").execute({ kb: "测试库", doc: docId }, exec);
    const again = await tools.get("kb_list").execute({ kb: "测试库" }, exec);
    assert.equal(again.docs[0].summary, "电能质量治理流程综述");
    assert.equal(again.docs[0].summarySource, "model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_list supports kind filter and index refreshes after mutations", async () => {
  const { root, tools, exec, kbDir } = await setup();
  try {
    await tools.get("kb_add_note").execute(
      { kb: "测试库", title: "治理要点", content: "先测量后治理。", kind: "topic" },
      exec
    );
    const notes = await tools.get("kb_list").execute({ kb: "测试库", kind: "note" }, exec);
    assert.equal(notes.total, 1);
    assert.equal(notes.docs[0].type, "note");
    const sources = await tools.get("kb_list").execute({ kb: "测试库", kind: "source" }, exec);
    assert.equal(sources.total, 1);
    assert.notEqual(sources.docs[0].type, "note");

    const index = await readFile(join(kbDir, "index.md"), "utf8");
    assert.match(index, /## 编译页（笔记）/);
    assert.match(index, /治理要点/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zip export includes the compiled-layer views", async () => {
  const { root, tools, exec } = await setup();
  try {
    const out = join(root, "export.zip");
    await tools.get("kb_export").execute({ kb: "测试库", format: "zip", out }, exec);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(out));
    assert.ok(zip.file("index.md"), "zip must contain index.md");
    assert.ok(zip.file("schema.md"), "zip must contain schema.md");
    assert.ok(zip.file("log.md"), "zip must contain log.md");
    const index = await zip.file("index.md").async("string");
    assert.match(index, /电能质量资料/);
    const log = await zip.file("log.md").async("string");
    assert.match(log, /ingest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply scaffolds pre-existing knowledge bases", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-wiki-scaffold-"));
  try {
    const kbRoot = join(root, "kb-root");
    const kbDir = join(kbRoot, "旧库");
    await mkdir(kbDir, { recursive: true });
    await writeFile(
      join(kbDir, "kb.json"),
      JSON.stringify(
        {
          schemaVersion: 2,
          name: "旧库",
          docs: [
            {
              id: "olddoc000001",
              title: "旧资料",
              type: "text",
              status: "ready",
              chars: 10,
              parts: 1,
              pages: 0,
              version: 1,
              outline: [],
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );
    const tools = new Map();
    const ctx = {
      tools: { register(def) { tools.set(def.name, def); } },
      systemPrompt: { section() {} },
      get() { return undefined; },
    };
    await apply(ctx, { kbRoot, defaultKb: "旧库", partMaxChars: 300 });
    for (const file of ["schema.md", "log.md", "index.md"]) {
      await access(join(kbDir, file));
    }
    const index = await readFile(join(kbDir, "index.md"), "utf8");
    assert.match(index, /旧资料/);
    const log = await readFile(join(kbDir, "log.md"), "utf8");
    assert.match(log, /暂无记录/);
    const manifest = JSON.parse(await readFile(join(kbDir, "kb.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 2, "lazy migration: a read-only startup must not rewrite kb.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
