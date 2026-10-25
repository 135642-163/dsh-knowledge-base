/**
 * 0.13.0 笔记升级为 Wiki 页：
 * - kind / tags / sources 落清单，来源可反查（原文页显示“被引用”）；
 * - 同标题再写 = 更新同一篇（版本+1、保留来源与历史），不再产生「续」「修订版」；
 * - 导出 md 时笔记带 YAML frontmatter。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { readManifest } from "../lib/store.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-note-wiki-"));
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
  await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 500 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  const src = join(root, "资料.md");
  await writeFile(src, "# 概述\n\n电能质量治理的基本流程。\n\n# 方法\n\n先测量再治理。\n", "utf8");
  const imported = await tools.get("kb_import").execute(
    { path: src, kb: "测试库", title: "电能质量资料" },
    exec
  );
  return { root, kbRoot, kbDir: join(kbRoot, "测试库"), tools, exec, docId: imported.imported[0].docId };
}

test("note stores kind/tags/sources and backlinks resolve both ways", async () => {
  const { root, tools, exec, kbDir, docId } = await setup();
  try {
    const note = await tools.get("kb_add_note").execute(
      {
        kb: "测试库",
        title: "电能质量治理要点",
        content: "## 要点\n\n先测量后治理。依据 [[电能质量资料]]。",
        kind: "topic",
        tags: ["治理", "电能质量"],
        sources: [`${docId}#p2`],
      },
      exec
    );
    assert.equal(note.updated, false);
    assert.equal(note.kind, "topic");
    assert.deepEqual(note.tags, ["治理", "电能质量"]);
    assert.deepEqual(note.sources, [`${docId}#p2`]);

    const manifest = await readManifest(kbDir);
    const doc = manifest.docs.find((d) => d.id === note.docId);
    assert.equal(doc.type, "note");
    assert.equal(doc.kind, "topic");
    assert.deepEqual(doc.tags, ["治理", "电能质量"]);
    assert.deepEqual(doc.sources, [`${docId}#p2`]);
    assert.deepEqual(doc.linksOut, [docId]);

    const noteRead = await tools.get("kb_read").execute({ kb: "测试库", doc: note.docId, part: 1 }, exec);
    assert.equal(noteRead.noteSources.length, 1);
    assert.equal(noteRead.noteSources[0].title, "电能质量资料");
    assert.equal(noteRead.noteSources[0].page, 2);
    assert.equal(noteRead.sources.length, 1);
    assert.equal(noteRead.sources[0].docId, note.docId);
    const noteText = tools.get("kb_read").output.render({}, noteRead)[0].text;
    assert.match(noteText, /依据来源：电能质量资料（第 2 页）/);

    const sourceRead = await tools.get("kb_read").execute({ kb: "测试库", doc: docId, part: 1 }, exec);
    assert.equal(sourceRead.backlinks.length, 1);
    assert.equal(sourceRead.backlinks[0].title, "电能质量治理要点");
    const sourceText = tools.get("kb_read").output.render({}, sourceRead)[0].text;
    assert.match(sourceText, /被引用：电能质量治理要点/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same title updates the note instead of creating a new page", async () => {
  const { root, tools, exec, kbDir, docId } = await setup();
  try {
    const first = await tools.get("kb_add_note").execute(
      {
        kb: "测试库",
        title: "治理要点",
        content: "旧结论：先测量后治理。",
        kind: "topic",
        tags: ["治理"],
        sources: [`${docId}#p1`],
      },
      exec
    );
    const second = await tools.get("kb_add_note").execute(
      { kb: "测试库", title: "治理要点", content: "新结论：先测量、再治理、后评估。" },
      exec
    );
    assert.equal(second.docId, first.docId, "same title must reuse the note");
    assert.equal(second.updated, true);

    const manifest = await readManifest(kbDir);
    const notes = manifest.docs.filter((d) => d.type === "note");
    assert.equal(notes.length, 1);
    const doc = notes[0];
    assert.equal(doc.version, 2);
    assert.equal(doc.kind, "topic", "omitted kind must keep the old one");
    assert.deepEqual(doc.tags, ["治理"], "omitted tags must keep the old ones");
    assert.deepEqual(doc.sources, [`${docId}#p1`], "omitted sources must keep the old ones");
    assert.equal(doc.history.length, 1);
    assert.equal(doc.history[0].version, 1);

    const read = await tools.get("kb_read").execute({ kb: "测试库", doc: first.docId, part: 1 }, exec);
    assert.match(read.text, /先测量、再治理、后评估/);
    assert.doesNotMatch(read.text, /旧结论/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unresolved sources are kept with a warning; invalid kind is rejected", async () => {
  const { root, tools, exec } = await setup();
  try {
    const note = await tools.get("kb_add_note").execute(
      {
        kb: "测试库",
        title: "待核实结论",
        content: "这条结论还没有找到出处。",
        sources: ["不存在的文档#p3"],
      },
      exec
    );
    assert.ok(note.warnings.length >= 1);
    assert.match(note.warnings[0], /未在库内找到/);
    assert.deepEqual(note.sources, ["不存在的文档#p3"]);

    await assert.rejects(
      () =>
        tools.get("kb_add_note").execute(
          { kb: "测试库", title: "坏类型", content: "x", kind: "unknown" },
          exec
        ),
      /kind 取值无效/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markdown export adds frontmatter for notes and summaries in the TOC", async () => {
  const { root, tools, exec, docId } = await setup();
  try {
    await tools.get("kb_describe").execute(
      { kb: "测试库", doc: docId, summary: "电能质量资料摘要", tags: ["资料"] },
      exec
    );
    await tools.get("kb_add_note").execute(
      {
        kb: "测试库",
        title: "治理要点",
        content: "先测量后治理。",
        kind: "concept",
        tags: ["治理"],
        sources: [`${docId}#p1`],
      },
      exec
    );
    const out = join(root, "export.md");
    await tools.get("kb_export").execute({ kb: "测试库", format: "md", out }, exec);
    const text = await readFile(out, "utf8");
    assert.match(text, /电能质量资料摘要/, "TOC should include the model summary");
    assert.match(text, /^---\ntitle: 治理要点/m);
    assert.match(text, /kind: concept/);
    assert.match(text, /tags: \[治理\]/);
    assert.match(text, new RegExp(`sources: \\[${docId}#p1\\]`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_query marks notes as compiled pages", async () => {
  const { root, tools, exec } = await setup();
  try {
    await tools.get("kb_add_note").execute(
      { kb: "测试库", title: "检索标注笔记", content: "独特词条甲乙丙只出现在这里。", kind: "topic" },
      exec
    );
    const result = await tools.get("kb_query").execute(
      { kb: "测试库", pattern: "独特词条甲乙丙" },
      exec
    );
    assert.ok(result.matches.length >= 1);
    assert.equal(result.matches[0].type, "note");
    assert.equal(result.matches[0].kind, "topic");
    const text = tools.get("kb_query").output.render({ kb: "测试库" }, result)[0].text;
    assert.match(text, /\[笔记·专题页\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
