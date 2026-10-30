/**
 * 0.15.0 库级快照：
 * - 创建 zip 到知识库 snapshots/，包含 kb.json / schema.md / markdown/；
 * - 默认不含 sources，includeSources=true 时包含；
 * - list=true 返回已有快照；解析失败不会阻塞主流程。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-snapshot-"));
  const kbRoot = join(root, "kb-root");
  await mkdir(kbRoot, { recursive: true });
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 500 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  const src = join(root, "资料.md");
  await writeFile(src, "# 概述\n\n快照测试内容。\n", "utf8");
  const imported = await tools.get("kb_import").execute(
    { path: src, kb: "测试库", title: "快照资料" },
    exec
  );
  return { root, kbDir: join(kbRoot, "测试库"), tools, exec, docId: imported.imported[0].docId };
}

test("kb_snapshot creates a zip with manifest and derived markdown", async () => {
  const { root, kbDir, tools, exec, docId } = await setup();
  try {
    const r = await tools.get("kb_snapshot").execute(
      { kb: "测试库", label: "before-edit" },
      exec
    );
    assert.equal(r.created, true);
    assert.ok(r.bytes > 0);
    await access(r.path);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(r.path));
    assert.ok(zip.file("meta.json"));
    assert.ok(zip.file("kb.json"));
    assert.ok(zip.file("schema.md"));
    assert.ok(zip.file(`markdown/${docId}/${docId}.md`));
    assert.equal(Object.keys(zip.files).some((n) => n.startsWith("sources/")), false);
    const meta = JSON.parse(await zip.file("meta.json").async("string"));
    assert.equal(meta.label, "before-edit");
    assert.equal(meta.docs, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_snapshot 输出只包含 output schema 声明过的字段（宿主会拒绝多余字段）", async () => {
  const { root, tools, exec } = await setup();
  try {
    const tool = tools.get("kb_snapshot");
    const declared = new Set(Object.keys(tool.output.schema.properties));
    const created = await tool.execute({ kb: "测试库", label: "schema-check" }, exec);
    for (const key of Object.keys(created)) {
      assert.ok(declared.has(key), `创建快照的返回值多出未声明字段: ${key}`);
    }
    assert.equal(created.includeSources, false);
    const listed = await tool.execute({ kb: "测试库", list: true }, exec);
    for (const key of Object.keys(listed)) {
      assert.ok(declared.has(key), `列快照的返回值多出未声明字段: ${key}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_snapshot list=true returns existing snapshots", async () => {
  const { root, tools, exec } = await setup();
  try {
    await tools.get("kb_snapshot").execute({ kb: "测试库", label: "one" }, exec);
    const list = await tools.get("kb_snapshot").execute({ kb: "测试库", list: true }, exec);
    assert.equal(list.created, false);
    assert.equal(list.snapshots.length, 1);
    assert.equal(list.snapshots[0].label, "one");
    const text = tools.get("kb_snapshot").output.render({ kb: "测试库" }, list)[0].text;
    assert.match(text, /快照/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("includeSources=true adds original files to the snapshot", async () => {
  const { root, tools, exec } = await setup();
  try {
    const r = await tools.get("kb_snapshot").execute(
      { kb: "测试库", label: "full", includeSources: true },
      exec
    );
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(r.path));
    assert.ok(Object.keys(zip.files).some((n) => n.startsWith("sources/")));
    assert.ok(r.bytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
