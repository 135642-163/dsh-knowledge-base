/**
 * 0.33 kbpack 导入：校验 / 幂等 / 冲突重映射 / 同名库三选一 / 人工字段保护。
 * 全部在临时 kbRoot 里跑，不碰真实库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { apply } from "../lib/index.js";
import { readManifest, writeManifestAtomic } from "../lib/store.js";

async function makeRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const kbRoot = join(root, "kb-root");
  await mkdir(kbRoot, { recursive: true });
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot, defaultKb: "默认库", partMaxChars: 500 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  return { root, kbRoot, tools, exec };
}

async function seedFile(root, name, content) {
  const file = join(root, name);
  await writeFile(file, content, "utf8");
  return file;
}

async function exportPack(tools, exec, root, kb) {
  const out = join(root, `pack-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
  await tools.get("kb_export").execute({ kb, format: "zip", out, includeSources: true }, exec);
  return out;
}

test("包导入 roundtrip：篇数/正文/摘要/标签/可信度/检索", async () => {
  const source = await makeRoot("kb-pack-src-");
  const target = await makeRoot("kb-pack-dst-");
  try {
    const src = await seedFile(source.root, "资料.txt", "电压偏差与供电可靠性测试内容。\n");
    const imported = await source.tools.get("kb_import").execute(
      { path: src, kb: "来源库", title: "GB/T 12326-2008 电能质量 电压波动和闪变" },
      source.exec
    );
    const docId = imported.imported[0].docId;
    await source.tools.get("kb_describe").execute(
      { kb: "来源库", doc: docId, summary: "人工摘要", tags: ["电能质量"] },
      source.exec
    );
    await source.tools.get("kb_trust").execute(
      { kb: "来源库", doc: docId, level: "high", reason: "现行版" },
      source.exec
    );
    const pack = await exportPack(source.tools, source.exec, source.root, "来源库");

    const result = await target.tools.get("kb_import_package").execute(
      { path: pack, kb: "目标库" },
      target.exec
    );
    assert.equal(result.ok, true);
    assert.equal(result.created, 1);
    assert.equal(result.kb, "目标库");
    const listed = await target.tools.get("kb_list").execute({ kb: "目标库" }, target.exec);
    assert.equal(listed.total, 1);
    const doc = listed.docs[0];
    assert.equal(doc.id, docId);
    assert.equal(doc.title, "GB/T 12326-2008 电能质量 电压波动和闪变");
    assert.equal(doc.summary, "人工摘要");
    assert.deepEqual(doc.tags, ["电能质量"]);
    assert.equal(doc.trust, "high");
    const query = await target.tools.get("kb_query").execute(
      { kb: "目标库", pattern: "供电可靠性" },
      target.exec
    );
    assert.ok((query.matches ?? []).length > 0, "imported markdown must be searchable");
    const log = await readFile(join(target.kbRoot, "目标库", "log.md"), "utf8");
    assert.match(log, /import-package/);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test("重复导入同一个包：幂等跳过，不新增文档", async () => {
  const source = await makeRoot("kb-pack-idem-src-");
  const target = await makeRoot("kb-pack-idem-dst-");
  try {
    const src = await seedFile(source.root, "资料.txt", "幂等测试正文。\n");
    await source.tools.get("kb_import").execute({ path: src, kb: "来源库", title: "幂等资料" }, source.exec);
    const pack = await exportPack(source.tools, source.exec, source.root, "来源库");
    const first = await target.tools.get("kb_import_package").execute({ path: pack, kb: "目标库" }, target.exec);
    assert.equal(first.created, 1);
    const second = await target.tools.get("kb_import_package").execute({ path: pack, kb: "目标库", mode: "merge" }, target.exec);
    assert.equal(second.created, 0);
    assert.equal(second.skipIdentical, 1);
    const listed = await target.tools.get("kb_list").execute({ kb: "目标库" }, target.exec);
    assert.equal(listed.total, 1);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test("同名库且未给 mode：不写入，返回 merge/rename/replace 三选一", async () => {
  const source = await makeRoot("kb-pack-choice-src-");
  const target = await makeRoot("kb-pack-choice-dst-");
  try {
    const src = await seedFile(source.root, "资料.txt", "选择模式测试。\n");
    await source.tools.get("kb_import").execute({ path: src, kb: "同名库" }, source.exec);
    const pack = await exportPack(source.tools, source.exec, source.root, "同名库");
    await target.tools.get("kb_import").execute(
      { path: await seedFile(target.root, "本地.txt", "本地已有内容。\n"), kb: "同名库" },
      target.exec
    );
    const before = (await readManifest(join(target.kbRoot, "同名库"))).docs.length;
    const result = await target.tools.get("kb_import_package").execute({ path: pack }, target.exec);
    assert.equal(result.needsChoice, true);
    assert.deepEqual(result.choices.map((item) => item.mode), ["merge", "rename", "replace"]);
    const after = (await readManifest(join(target.kbRoot, "同名库"))).docs.length;
    assert.equal(after, before, "needsChoice must not write anything");
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test("rename：另存为新库，原库不动，冲突自动加后缀", async () => {
  const source = await makeRoot("kb-pack-rename-src-");
  const target = await makeRoot("kb-pack-rename-dst-");
  try {
    const src = await seedFile(source.root, "资料.txt", "另存测试。\n");
    await source.tools.get("kb_import").execute({ path: src, kb: "包库" }, source.exec);
    const pack = await exportPack(source.tools, source.exec, source.root, "包库");
    await target.tools.get("kb_import").execute(
      { path: await seedFile(target.root, "本地.txt", "本地内容。\n"), kb: "包库" },
      target.exec
    );
    const result = await target.tools.get("kb_import_package").execute(
      { path: pack, kb: "包库", mode: "rename" },
      target.exec
    );
    assert.equal(result.ok, true);
    assert.match(result.kb, /^包库/);
    assert.notEqual(result.kb, "包库");
    const original = await target.tools.get("kb_list").execute({ kb: "包库" }, target.exec);
    assert.equal(original.total, 1);
    const copy = await target.tools.get("kb_list").execute({ kb: result.kb }, target.exec);
    assert.equal(copy.total, 1);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test("merge 同 id 不同内容：另分配 docId 保留两份并提示", async () => {
  const source = await makeRoot("kb-pack-conflict-src-");
  const target = await makeRoot("kb-pack-conflict-dst-");
  try {
    const srcA = await seedFile(source.root, "同名.txt", "来源库版本 A。\n");
    const imported = await source.tools.get("kb_import").execute(
      { path: srcA, kb: "来源库", title: "冲突资料" },
      source.exec
    );
    const oldId = imported.imported[0].docId;
    const pack = await exportPack(source.tools, source.exec, source.root, "来源库");
    const srcB = await seedFile(target.root, "同名.txt", "目标库版本 B，内容不同。\n");
    const local = await target.tools.get("kb_import").execute(
      { path: srcB, kb: "目标库", title: "冲突资料" },
      target.exec
    );
    assert.equal(local.imported[0].docId, oldId, "same relKey must produce same docId");
    const result = await target.tools.get("kb_import_package").execute({ path: pack, kb: "目标库", mode: "merge" }, target.exec);
    assert.equal(result.remapped, 1);
    const listed = await target.tools.get("kb_list").execute({ kb: "目标库" }, target.exec);
    assert.equal(listed.total, 2, "both versions must be kept");
    const ids = listed.docs.map((doc) => doc.id).sort();
    assert.equal(ids.includes(oldId), true);
    assert.equal(ids.length, 2);
    assert.ok(result.warnings.some((warning) => warning.includes("id 冲突")));
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test("replace：覆盖同 id 文档，旧版进 history；无 confirm 拒绝", async () => {
  const source = await makeRoot("kb-pack-replace-src-");
  const target = await makeRoot("kb-pack-replace-dst-");
  try {
    const srcA = await seedFile(source.root, "同名.txt", "包内新版正文。\n");
    await source.tools.get("kb_import").execute({ path: srcA, kb: "来源库", title: "替换资料" }, source.exec);
    const pack = await exportPack(source.tools, source.exec, source.root, "来源库");
    const srcB = await seedFile(target.root, "同名.txt", "目标库旧版正文。\n");
    const local = await target.tools.get("kb_import").execute(
      { path: srcB, kb: "目标库", title: "替换资料" },
      target.exec
    );
    const docId = local.imported[0].docId;
    await assert.rejects(
      () => target.tools.get("kb_import_package").execute(
        { path: pack, kb: "目标库", mode: "replace" },
        target.exec
      ),
      (error) => error.code === "KBPACK_CONFIRM_REQUIRED"
    );
    const result = await target.tools.get("kb_import_package").execute(
      { path: pack, kb: "目标库", mode: "replace", confirm: "replace" },
      target.exec
    );
    assert.equal(result.replaced, 1);
    const manifest = await readManifest(join(target.kbRoot, "目标库"));
    const doc = manifest.docs.find((item) => item.id === docId);
    assert.equal(doc.version, 2);
    assert.equal(doc.history.length, 1);
    const read = await target.tools.get("kb_read").execute({ kb: "目标库", doc: docId }, target.exec);
    assert.match(read.text, /包内新版正文/);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test("replace 不覆盖 manual 标题/摘要/可信度/标准号", async () => {
  const source = await makeRoot("kb-pack-manual-src-");
  const target = await makeRoot("kb-pack-manual-dst-");
  try {
    const srcA = await seedFile(source.root, "同名.txt", "包里正文。\n");
    await source.tools.get("kb_import").execute(
      { path: srcA, kb: "来源库", title: "包内标题 GB/T 1111-2020" },
      source.exec
    );
    const pack = await exportPack(source.tools, source.exec, source.root, "来源库");
    const srcB = await seedFile(target.root, "同名.txt", "本地正文。\n");
    const local = await target.tools.get("kb_import").execute(
      { path: srcB, kb: "目标库", title: "本地标题" },
      target.exec
    );
    const docId = local.imported[0].docId;
    await target.tools.get("kb_describe").execute(
      { kb: "目标库", doc: docId, summary: "人工摘要" },
      target.exec
    );
    await target.tools.get("kb_trust").execute(
      { kb: "目标库", doc: docId, level: "low", reason: "人工判定" },
      target.exec
    );
    await target.tools.get("kb_retitle").execute(
      { kb: "目标库", doc: docId, title: "人工标题" },
      target.exec
    );
    // 模拟工作台人工改标准号（standardSource=manual）
    {
      const manual = await readManifest(join(target.kbRoot, "目标库"));
      const row = manual.docs.find((item) => item.id === docId);
      row.standardNo = "GB/T 9999-2020";
      row.standardSource = "manual";
      await writeManifestAtomic(join(target.kbRoot, "目标库"), manual);
    }
    await target.tools.get("kb_import_package").execute(
      { path: pack, kb: "目标库", mode: "replace", confirm: "replace" },
      target.exec
    );
    const manifest = await readManifest(join(target.kbRoot, "目标库"));
    const doc = manifest.docs.find((item) => item.id === docId);
    assert.equal(doc.title, "人工标题");
    assert.equal(doc.titleSource, "manual");
    assert.equal(doc.summary, "人工摘要");
    assert.equal(doc.summarySource, "model");
    assert.equal(doc.trust, "low");
    assert.equal(doc.trustSource, "manual");
    assert.equal(doc.standardNo, "GB/T 9999-2020");
    assert.equal(doc.standardSource, "manual");
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test("同标准号不同 id：走现有 dedup 默认跳过并报告", async () => {
  const source = await makeRoot("kb-pack-dedup-src-");
  const target = await makeRoot("kb-pack-dedup-dst-");
  try {
    const src = await seedFile(source.root, "A.txt", "来源库标准正文。\n");
    await source.tools.get("kb_import").execute(
      { path: src, kb: "来源库", title: "GB/T 12326-2008 电压波动和闪变" },
      source.exec
    );
    const pack = await exportPack(source.tools, source.exec, source.root, "来源库");
    // 目标库用不同文件名导入同一标准号 → docId 不同，触发同号查重
    const local = await target.tools.get("kb_import").execute(
      { path: await seedFile(target.root, "B.txt", "目标库标准正文。\n"), kb: "目标库", title: "GB/T 12326-2008 电压波动和闪变" },
      target.exec
    );
    assert.ok(local.imported[0].docId);
    const result = await target.tools.get("kb_import_package").execute({ path: pack, kb: "目标库", mode: "merge" }, target.exec);
    assert.equal(result.created, 0);
    assert.equal(result.skipDuplicate, 1);
    assert.equal(result.duplicates.length, 1);
    const listed = await target.tools.get("kb_list").execute({ kb: "目标库" }, target.exec);
    assert.equal(listed.total, 1);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test("笔记 sources 引用随 id 重映射改写", async () => {
  const source = await makeRoot("kb-pack-note-src-");
  const target = await makeRoot("kb-pack-note-dst-");
  try {
    const src = await seedFile(source.root, "同名.txt", "来源库正文 A。\n");
    const imported = await source.tools.get("kb_import").execute(
      { path: src, kb: "来源库", title: "被引用资料" },
      source.exec
    );
    const oldId = imported.imported[0].docId;
    await source.tools.get("kb_add_note").execute(
      { kb: "来源库", title: "引用笔记", content: "见资料。", sources: [`${oldId}#p1`] },
      source.exec
    );
    const pack = await exportPack(source.tools, source.exec, source.root, "来源库");
    const srcB = await seedFile(target.root, "同名.txt", "目标库正文 B，不同。\n");
    await target.tools.get("kb_import").execute(
      { path: srcB, kb: "目标库", title: "被引用资料" },
      target.exec
    );
    const result = await target.tools.get("kb_import_package").execute({ path: pack, kb: "目标库", mode: "merge" }, target.exec);
    assert.equal(result.remapped, 1);
    const manifest = await readManifest(join(target.kbRoot, "目标库"));
    const note = manifest.docs.find((doc) => doc.title === "引用笔记");
    assert.ok(note);
    assert.notEqual(note.sources[0].split("#")[0], oldId, "note source must follow the remapped docId");
    assert.match(note.sources[0], /^[0-9a-f]+#p1$/);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test("kb_import 收到 .zip 自动路由到包导入", async () => {
  const source = await makeRoot("kb-pack-route-src-");
  const target = await makeRoot("kb-pack-route-dst-");
  try {
    const src = await seedFile(source.root, "资料.txt", "自动路由测试。\n");
    await source.tools.get("kb_import").execute({ path: src, kb: "来源库" }, source.exec);
    const pack = await exportPack(source.tools, source.exec, source.root, "来源库");
    const result = await target.tools.get("kb_import").execute(
      { path: pack, kb: "目标库" },
      target.exec
    );
    assert.ok(result.package, "kb_import must expose package result");
    assert.equal(result.package.created, 1);
    assert.equal(result.files, 1);
  } finally {
    await rm(source.root, { recursive: true, force: true });
    await rm(target.root, { recursive: true, force: true });
  }
});

test("标题尾随空格在包导入后逐字保留（导出→导入不改写）", async () => {
  const target = await makeRoot("kb-pack-title-space-");
  try {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({
      format: "kbpack/v1",
      schemaVersion: 6,
      kbName: "空格库",
      withSources: false,
      docs: [{
        id: "abcdef123456",
        title: "标题带尾随空格 ",
        type: "text",
        stage: "unknown",
        sourceHash: "",
        textHash: "t",
        contentHash: "t",
        chars: 2,
        pages: 0,
        parts: 1,
        trust: "unknown",
        sourceFile: "",
        hasSource: false,
        hasMarkdown: true,
      }],
    }));
    zip.file("markdown/abcdef123456/abcdef123456.md", "# 标题带尾随空格 \n\n正文。\n");
    const pack = join(target.root, "space.zip");
    await writeFile(pack, await zip.generateAsync({ type: "nodebuffer" }));
    await target.tools.get("kb_import_package").execute({ path: pack, kb: "空格库" }, target.exec);
    const manifest = await readManifest(join(target.kbRoot, "空格库"));
    assert.equal(manifest.docs[0].title, "标题带尾随空格 ");
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});
