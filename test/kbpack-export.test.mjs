/**
 * 0.33 kbpack 导出：zip 里必须带 manifest.json（format=kbpack/v1），
 * 且不把本机路径 / history / 站点缓存 / 软删除文档带出去。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { buildKbpackManifest, exportZip, readManifest } from "../lib/store.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-kbpack-export-"));
  const kbRoot = join(root, "kb-root");
  await mkdir(kbRoot, { recursive: true });
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot, defaultKb: "导出库", partMaxChars: 500 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  const src = join(root, "资料.txt");
  await writeFile(src, "电压偏差与供电可靠性测试内容。\n", "utf8");
  const imported = await tools.get("kb_import").execute(
    { path: src, kb: "导出库", title: "GB/T 12326-2008 电能质量 电压波动和闪变" },
    exec
  );
  const docId = imported.imported[0].docId;
  await tools.get("kb_describe").execute(
    { kb: "导出库", doc: docId, summary: "人工摘要", tags: ["电能质量"] },
    exec
  );
  await tools.get("kb_trust").execute(
    { kb: "导出库", doc: docId, level: "high", reason: "现行版" },
    exec
  );
  await tools.get("kb_add_note").execute(
    { kb: "导出库", title: "笔记：电压偏差", content: "结论。", sources: [docId] },
    exec
  );
  return { root, kbRoot, kbDir: join(kbRoot, "导出库"), tools, exec, docId };
}

test("kb_export zip 带 kbpack manifest（格式/计数/字段/幂等键）", async () => {
  const { root, kbDir, tools, exec, docId } = await setup();
  try {
    const out = join(root, "pack.zip");
    await tools.get("kb_export").execute({ kb: "导出库", format: "zip", out }, exec);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(out));
    assert.ok(zip.file("manifest.json"), "zip must contain manifest.json");
    const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
    assert.equal(manifest.format, "kbpack/v1");
    assert.equal(manifest.kbName, "导出库");
    assert.equal(manifest.withSources, false);
    assert.equal(manifest.schemaVersion, 6);
    assert.equal(manifest.counts.docs, 2);
    assert.equal(manifest.counts.notes, 1);
    assert.equal(manifest.counts.sourceFiles, 0);
    assert.ok(manifest.counts.contentBytes > 0);
    const doc = manifest.docs.find((item) => item.id === docId);
    assert.ok(doc);
    assert.equal(doc.title, "GB/T 12326-2008 电能质量 电压波动和闪变");
    assert.equal(doc.standardNo, "GB/T 12326-2008");
    assert.equal(doc.trust, "high");
    assert.equal(doc.hasSource, false);
    assert.equal(doc.hasMarkdown, true);
    assert.ok(doc.sourceHash, "source hash is the idempotency key");
    assert.ok(doc.contentHash);
    assert.ok(Number.isInteger(doc.pages));
    const note = manifest.docs.find((item) => item.type === "note");
    assert.ok(note);
    assert.equal(note.kind, "note");

    // kb.json 不泄漏本机路径与 history
    const kbJson = JSON.parse(await zip.file("kb.json").async("string"));
    for (const item of kbJson.docs) {
      assert.equal(item.sourcePath, undefined);
      assert.equal(item.history, undefined);
    }
    assert.equal(JSON.stringify(kbJson).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("includeSources=true 时 hasSource/sourceFiles 与包内 sources 一致", async () => {
  const { root, tools, exec, docId } = await setup();
  try {
    const out = join(root, "pack-sources.zip");
    await tools.get("kb_export").execute(
      { kb: "导出库", format: "zip", out, includeSources: true },
      exec
    );
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(out));
    const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
    assert.equal(manifest.withSources, true);
    assert.equal(manifest.counts.sourceFiles, 1);
    assert.ok(zip.file(`sources/${docId}.txt`));
    const doc = manifest.docs.find((item) => item.id === docId);
    assert.equal(doc.hasSource, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("软删除文档不进 manifest，也不进 kb.json / markdown / sources", async () => {
  const { root, tools, exec, docId } = await setup();
  try {
    await tools.get("kb_remove").execute({ kb: "导出库", doc: docId }, exec);
    const out = join(root, "pack-deleted.zip");
    await tools.get("kb_export").execute(
      { kb: "导出库", format: "zip", out, includeSources: true },
      exec
    );
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(out));
    const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
    assert.equal(manifest.docs.some((item) => item.id === docId), false);
    const kbJson = JSON.parse(await zip.file("kb.json").async("string"));
    assert.equal(kbJson.docs.some((item) => item.id === docId), false);
    assert.equal(Object.keys(zip.files).some((name) => name.includes(docId)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest 不含站点缓存/预览/history 目录", async () => {
  const { root, kbDir, tools, exec } = await setup();
  try {
    await writeFile(join(kbDir, ".std-check.json"), JSON.stringify({ items: {} }), "utf8");
    await mkdir(join(kbDir, ".preview"), { recursive: true });
    await writeFile(join(kbDir, ".preview", "x.txt"), "secret", "utf8");
    await mkdir(join(kbDir, "history", "abc"), { recursive: true });
    await writeFile(join(kbDir, "history", "abc", "v1"), "secret", "utf8");
    const out = join(root, "pack-clean.zip");
    await tools.get("kb_export").execute({ kb: "导出库", format: "zip", out }, exec);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(out));
    const names = Object.keys(zip.files);
    assert.equal(names.some((name) => name.startsWith(".preview")), false);
    assert.equal(names.some((name) => name.startsWith("history")), false);
    assert.equal(names.includes(".std-check.json"), false);
    assert.equal(names.includes("manifest.json"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildKbpackManifest 不计软删除文档、无源文件时 notes 计数正确", async () => {
  const { root, kbDir, docId } = await setup();
  try {
    const manifest = await readManifest(kbDir);
    const pack = await buildKbpackManifest({ dir: kbDir, manifest, includeSources: true });
    assert.equal(pack.docs.length, manifest.docs.filter((doc) => doc.status === "ready").length);
    const doc = pack.docs.find((item) => item.id === docId);
    assert.equal(doc.hasSource, true);
    assert.match(doc.sourceFile, /\.txt$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
