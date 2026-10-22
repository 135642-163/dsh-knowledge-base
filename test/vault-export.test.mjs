/**
 * 0.15.0 Obsidian Vault 导出：
 * - index.md 双链、wiki/topics|sources、schema.md、meta 结构；
 * - 笔记带 frontmatter 与「依据来源」双链；
 * - includeSources=true 时带 raw/ 原始文件，false 时不带。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-vault-"));
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
  await writeFile(src, "# 概述\n\n交流无间隙金属氧化物避雷器。\n", "utf8");
  const imported = await tools.get("kb_import").execute(
    { path: src, kb: "测试库", title: "GB/T 11032-2020 避雷器" },
    exec
  );
  const docId = imported.imported[0].docId;
  await tools.get("kb_add_note").execute(
    {
      kb: "测试库",
      title: "避雷器试验要点",
      content: "## 要点\n\n先做绝缘试验。",
      kind: "topic",
      sources: [`${docId}#p1`],
    },
    exec
  );
  return { root, tools, exec, docId };
}

test("vault export builds an Obsidian-friendly structure with links", async () => {
  const { root, tools, exec } = await setup();
  try {
    const out = join(root, "vault.zip");
    const r = await tools.get("kb_export").execute(
      { kb: "测试库", format: "vault", out, includeSources: true },
      exec
    );
    assert.equal(r.format, "vault");
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(out));
    const names = Object.keys(zip.files);
    assert.ok(names.includes("index.md"));
    assert.ok(names.includes("schema.md"));
    assert.ok(names.includes("README.md"));
    const noteName = names.find((n) => n.startsWith("wiki/topics/") && n.endsWith(".md"));
    assert.ok(noteName, "note page under wiki/topics/");
    const note = await zip.file(noteName).async("string");
    assert.match(note, /kind: topic/);
    assert.match(note, /## 依据来源/);
    assert.match(note, /\[\[GB T 11032-2020 避雷器\]\]/);
    const sourceName = names.find((n) => n.startsWith("wiki/sources/") && n.endsWith(".md"));
    assert.ok(sourceName, "source summary page");
    const source = await zip.file(sourceName).async("string");
    assert.match(source, /doc_id:/);
    assert.match(source, /## 被引用/);
    assert.ok(names.some((n) => n.startsWith("raw/")), "includeSources must add raw/");
    const index = await zip.file("index.md").async("string");
    assert.match(index, /\[\[避雷器试验要点\]\]/);
    assert.match(index, /## 编译页/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vault export omits raw/ unless includeSources is true", async () => {
  const { root, tools, exec } = await setup();
  try {
    const out = join(root, "vault-small.zip");
    await tools.get("kb_export").execute({ kb: "测试库", format: "vault", out }, exec);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(out));
    const names = Object.keys(zip.files);
    assert.equal(names.some((n) => n.startsWith("raw/")), false);
    assert.ok(names.some((n) => n.startsWith("wiki/sources/")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
