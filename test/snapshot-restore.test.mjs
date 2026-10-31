/**
 * 0.33 kb_snapshot_restore：预演 / 恢复 / 自动留档 / 隔离 / 安全校验。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { apply } from "../lib/index.js";
import { readManifest, SCHEMA_VERSION } from "../lib/store.js";
import { restoreKbSnapshot } from "../lib/snapshot-restore.js";

async function setup(prefix = "kb-snapshot-restore-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
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
  return { root, kbRoot, kbDir: join(kbRoot, "测试库"), tools, exec };
}

async function seed(tools, exec, root, name, content, title = "资料") {
  const file = join(root, name);
  await writeFile(file, content, "utf8");
  const result = await tools.get("kb_import").execute({ path: file, kb: "测试库", title }, exec);
  return result.imported[0].docId;
}

test("预演不改写；恢复回到快照状态；移除文档进 trash-restore", async () => {
  const { root, kbDir, tools, exec } = await setup();
  try {
    const docId = await seed(tools, exec, root, "a.txt", "原始正文。\n");
    const snap = await tools.get("kb_snapshot").execute({ kb: "测试库", label: "s1" }, exec);
    assert.equal(snap.created, true);

    await tools.get("kb_edit").execute(
      { kb: "测试库", doc: docId, old_string: "原始正文", new_string: "修改后的正文" },
      exec
    );
    const added = await seed(tools, exec, root, "b.txt", "快照之后新增。\n", "新增资料");
    let listed = await tools.get("kb_list").execute({ kb: "测试库" }, exec);
    assert.equal(listed.total, 2);
    assert.match((await tools.get("kb_read").execute({ kb: "测试库", doc: docId }, exec)).text, /修改后的正文/);

    const dry = await tools.get("kb_snapshot_restore").execute(
      { kb: "测试库", snapshot: "s1", dryRun: true },
      exec
    );
    assert.equal(dry.dryRun, true);
    // 快照之后新增的文档会被移除（不是“新增”）；快照里没有的文档才叫 added
    assert.equal(dry.counts.removed, 1);
    assert.equal(dry.counts.changed, 1);
    // 预演不写入
    listed = await tools.get("kb_list").execute({ kb: "测试库" }, exec);
    assert.equal(listed.total, 2);
    assert.match((await tools.get("kb_read").execute({ kb: "测试库", doc: docId }, exec)).text, /修改后的正文/);

    const restored = await tools.get("kb_snapshot_restore").execute(
      { kb: "测试库", snapshot: "s1", dryRun: false },
      exec
    );
    assert.equal(restored.dryRun, false);
    assert.equal(restored.restored.markdown, 1);
    assert.equal(restored.quarantined.docs, 1);
    assert.ok(restored.preRestoreSnapshot?.name, "before-restore snapshot must be created");
    assert.match((await tools.get("kb_read").execute({ kb: "测试库", doc: docId }, exec)).text, /原始正文/);
    listed = await tools.get("kb_list").execute({ kb: "测试库" }, exec);
    assert.equal(listed.total, 1, "doc added after snapshot must be gone");
    assert.equal(listed.docs.some((doc) => doc.id === added), false);
    await assert.rejects(
      () => access(join(kbDir, "markdown", added)),
      { code: "ENOENT" },
      "removed markdown must be moved out of markdown/"
    );
    const trash = await readdir(join(kbDir, "trash-restore"));
    assert.ok(trash.length > 0);
    const log = await readFile(join(kbDir, "log.md"), "utf8");
    assert.match(log, /snapshot-restore/);
    const snapshots = await tools.get("kb_snapshot_restore").execute({ kb: "测试库", list: true }, exec);
    assert.ok(snapshots.snapshots.some((item) => item.label.startsWith("before-restore")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("真实恢复必须显式 dryRun=false，默认只预演", async () => {
  const { root, tools, exec } = await setup();
  try {
    await seed(tools, exec, root, "a.txt", "正文。\n");
    await tools.get("kb_snapshot").execute({ kb: "测试库", label: "s1" }, exec);
    const result = await tools.get("kb_snapshot_restore").execute({ kb: "测试库", snapshot: "s1" }, exec);
    assert.equal(result.dryRun, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("快照版本高于插件：拒绝恢复", async () => {
  const { root, kbDir, tools, exec } = await setup();
  try {
    await seed(tools, exec, root, "a.txt", "正文。\n");
    await tools.get("kb_snapshot").execute({ kb: "测试库", label: "bad-version" }, exec);
    const dir = join(kbDir, "snapshots");
    const name = (await readdir(dir)).find((item) => item.endsWith(".zip"));
    const zip = await JSZip.loadAsync(await readFile(join(dir, name)));
    const manifest = JSON.parse(await zip.file("kb.json").async("string"));
    manifest.schemaVersion = SCHEMA_VERSION + 1;
    zip.file("kb.json", JSON.stringify(manifest));
    await writeFile(join(dir, name), await zip.generateAsync({ type: "nodebuffer" }));
    await assert.rejects(
      () => tools.get("kb_snapshot_restore").execute(
        { kb: "测试库", snapshot: name, dryRun: false },
        exec
      ),
      (error) => error.code === "SNAPSHOT_VERSION_TOO_NEW"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("快照内含路径穿越：拒绝", async () => {
  const { root, kbDir, tools, exec } = await setup();
  try {
    await seed(tools, exec, root, "a.txt", "正文。\n");
    await tools.get("kb_snapshot").execute({ kb: "测试库", label: "traversal" }, exec);
    const dir = join(kbDir, "snapshots");
    const name = (await readdir(dir)).find((item) => item.endsWith(".zip"));
    const zip = await JSZip.loadAsync(await readFile(join(dir, name)));
    zip.file("markdown/../../evil.md", "evil");
    await writeFile(join(dir, name), await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
    await assert.rejects(
      () => tools.get("kb_snapshot_restore").execute({ kb: "测试库", snapshot: name }, exec),
      (error) => error.code === "KBPACK_UNSAFE_PATH"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("快照库名与目标库不一致：拒绝", async () => {
  const { root, kbRoot, tools, exec } = await setup();
  try {
    await seed(tools, exec, root, "a.txt", "正文。\n");
    await tools.get("kb_snapshot").execute({ kb: "测试库", label: "s1" }, exec);
    const file = join(root, "other.txt");
    await writeFile(file, "另一库正文。\n");
    await tools.get("kb_import").execute({ path: file, kb: "另一库" }, exec);
    const dir = join(kbRoot, "测试库", "snapshots");
    const name = (await readdir(dir)).find((item) => item.endsWith(".zip"));
    const source = join(dir, name);
    const targetDir = join(kbRoot, "另一库", "snapshots");
    await mkdir(targetDir, { recursive: true });
    const { copyFile } = await import("node:fs/promises");
    await copyFile(source, join(targetDir, name));
    await assert.rejects(
      () => tools.get("kb_snapshot_restore").execute({ kb: "另一库", snapshot: name, dryRun: false }, exec),
      (error) => error.code === "SNAPSHOT_KB_MISMATCH"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("includeSources=true 时恢复原件；未包含时只恢复 markdown", async () => {
  const { root, kbDir, tools, exec } = await setup();
  try {
    const docId = await seed(tools, exec, root, "a.txt", "原始正文。\n");
    await tools.get("kb_snapshot").execute({ kb: "测试库", label: "with-sources", includeSources: true }, exec);
    const snapshots = await readdir(join(kbDir, "snapshots"));
    const name = snapshots.find((item) => item.endsWith(".zip"));
    // 破坏当前原件与正文，确认恢复真的写回
    const sourceFile = (await readdir(join(kbDir, "sources"))).find((item) => item.startsWith(docId));
    await writeFile(join(kbDir, "sources", sourceFile), "被破坏的原件", "utf8");
    const result = await tools.get("kb_snapshot_restore").execute(
      { kb: "测试库", snapshot: name, dryRun: false, includeSources: true },
      exec
    );
    assert.equal(result.restored.sources, 1);
    assert.equal(await readFile(join(kbDir, "sources", sourceFile), "utf8"), "原始正文。\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latest=true 与 snapshot 唯一子串选择", async () => {
  const { root, tools, exec } = await setup();
  try {
    await seed(tools, exec, root, "a.txt", "正文。\n");
    await tools.get("kb_snapshot").execute({ kb: "测试库", label: "first" }, exec);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await tools.get("kb_snapshot").execute({ kb: "测试库", label: "second" }, exec);
    const latest = await tools.get("kb_snapshot_restore").execute(
      { kb: "测试库", latest: true, dryRun: true },
      exec
    );
    assert.match(latest.snapshot.name, /second/);
    const byPart = await tools.get("kb_snapshot_restore").execute(
      { kb: "测试库", snapshot: "first", dryRun: true },
      exec
    );
    assert.match(byPart.snapshot.name, /first/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forceStream：流式读取快照并恢复 markdown/sources", async () => {
  const { root, kbDir, tools, exec } = await setup();
  try {
    const docId = await seed(tools, exec, root, "a.txt", "流式快照正文。\n");
    await tools.get("kb_snapshot").execute({ kb: "测试库", label: "stream", includeSources: true }, exec);
    const names = await readdir(join(kbDir, "snapshots"));
    const snapshotPath = join(kbDir, "snapshots", names.find((name) => name.endsWith(".zip")));
    const sourceFile = (await readdir(join(kbDir, "sources"))).find((name) => name.startsWith(docId));
    await writeFile(join(kbDir, "sources", sourceFile), "被破坏", "utf8");
    const result = await restoreKbSnapshot({
      kbDir,
      snapshotPath,
      dryRun: false,
      includeSources: true,
      forceStream: true,
    });
    assert.equal(result.restored.markdown, 1);
    assert.equal(result.restored.sources, 1);
    assert.equal(await readFile(join(kbDir, "sources", sourceFile), "utf8"), "流式快照正文。\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
