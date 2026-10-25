/**
 * 0.9.0 软删除/恢复：文件保留、默认列表可见但标记、检索/精读/导出排除。
 * 0.23.0：失败文档也能软删除/恢复，并保留失败原因。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { apply } from "../lib/index.js";
import { readManifest, restoreDoc, restoreDocVersion, snapshotDocVersion, writeManifestAtomic } from "../lib/store.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-soft-delete-"));
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot: join(root, "kb"), defaultKb: "软删除测试", partMaxChars: 500 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  return { root, tools, exec };
}

test("soft delete can be restored and is excluded from query/read/export", async () => {
  const { root, tools, exec } = await setup();
  try {
    const add = await tools.get("kb_add_note").execute(
      { kb: "软删除测试", title: "待删文档", content: "电压偏差与供电可靠性。\n\n第二段内容。" },
      exec
    );
    const removed = await tools.get("kb_remove").execute({ kb: "软删除测试", doc: add.docId }, exec);
    assert.equal(removed.soft, true);
    assert.match(removed.removed, /软删除/);

    const listed = await tools.get("kb_list").execute({ kb: "软删除测试" }, exec);
    const row = listed.docs.find((d) => d.id === add.docId);
    assert.equal(row.status, "deleted");
    assert.equal(row.deleted, true);
    assert.match(
      tools.get("kb_list").output.render({ kb: "软删除测试" }, listed)[0].text,
      /\[已删除\]/
    );
    const deletedList = await tools.get("kb_list").execute(
      { kb: "软删除测试", status: "deleted" },
      exec
    );
    assert.equal(deletedList.docs.length, 1);

    await assert.rejects(
      () => tools.get("kb_read").execute({ kb: "软删除测试", doc: add.docId, part: 1 }, exec),
      /已软删除.*kb_restore|kb_restore.*恢复/
    );
    const out = join(root, "export.md");
    await tools.get("kb_export").execute({ kb: "软删除测试", format: "md", out }, exec);
    const exported = await readFile(out, "utf8");
    assert.doesNotMatch(exported, /待删文档/);
    assert.doesNotMatch(exported, /电压偏差与供电可靠性/);
    const zipOut = join(root, "export.zip");
    await tools.get("kb_export").execute({ kb: "软删除测试", format: "zip", out: zipOut }, exec);
    const zip = await JSZip.loadAsync(await readFile(zipOut));
    assert.equal(
      Object.keys(zip.files).some((name) => name.includes(add.docId)),
      false
    );

    const restored = await tools.get("kb_restore").execute({ kb: "软删除测试", doc: add.docId }, exec);
    assert.equal(restored.docId, add.docId);
    const read = await tools.get("kb_read").execute({ kb: "软删除测试", doc: add.docId, part: 1 }, exec);
    assert.match(read.text, /电压偏差与供电可靠性/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("soft=false permanently removes the document", async () => {
  const { root, tools, exec } = await setup();
  try {
    const add = await tools.get("kb_add_note").execute(
      { kb: "软删除测试", title: "永久删除", content: "这段内容应彻底消失。" },
      exec
    );
    const removed = await tools.get("kb_remove").execute(
      { kb: "软删除测试", doc: add.docId, soft: false },
      exec
    );
    assert.equal(removed.soft, false);
    assert.match(removed.removed, /永久删除/);
    const listed = await tools.get("kb_list").execute({ kb: "软删除测试" }, exec);
    assert.equal(listed.docs.some((d) => d.id === add.docId), false);
    await assert.rejects(
      () => tools.get("kb_restore").execute({ kb: "软删除测试", doc: add.docId }, exec),
      /没有找到|已软删除/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed documents can be soft-deleted and restored with the error preserved", async () => {
  const { root, tools, exec } = await setup();
  try {
    const add = await tools.get("kb_add_note").execute(
      { kb: "软删除测试", title: "失败文档", content: "这段内容暂时解析失败。" },
      exec
    );
    const dir = join(root, "kb", "软删除测试");
    const manifest = await readManifest(dir);
    const doc = manifest.docs.find((item) => item.id === add.docId);
    doc.status = "failed";
    doc.error = "解析失败：测试用错误";
    doc.errorAt = "2026-10-01T00:00:00.000Z";
    await writeManifestAtomic(dir, manifest);

    // kb_remove 默认软删除：失败文档不再被 store 拒绝。
    const removed = await tools.get("kb_remove").execute({ kb: "软删除测试", doc: add.docId }, exec);
    assert.equal(removed.soft, true);
    const deleted = (await readManifest(dir)).docs.find((item) => item.id === add.docId);
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.deletedFromStatus, "failed");
    assert.equal(deleted.error, "解析失败：测试用错误");
    assert.ok(deleted.deletedAt);

    const restored = await tools.get("kb_restore").execute({ kb: "软删除测试", doc: add.docId }, exec);
    assert.equal(restored.docId, add.docId);
    const after = (await readManifest(dir)).docs.find((item) => item.id === add.docId);
    assert.equal(after.status, "failed");
    assert.equal(after.error, "解析失败：测试用错误");
    assert.equal(after.deletedAt, undefined);
    assert.equal(after.deletedFromStatus, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restoreDoc refuses a source doc moved to another kb and keeps its tombstone", async () => {
  const { root, tools, exec } = await setup();
  try {
    const add = await tools.get("kb_add_note").execute(
      { kb: "软删除测试", title: "已移走", content: "目标库已有副本。" },
      exec
    );
    const dir = join(root, "kb", "软删除测试");
    await tools.get("kb_remove").execute({ kb: "软删除测试", doc: add.docId }, exec);
    const manifest = await readManifest(dir);
    const doc = manifest.docs.find((item) => item.id === add.docId);
    doc.movedTo = {
      kb: "目标库",
      docId: "target-doc",
      transferId: "abcdef12",
      at: "2026-10-02T00:00:00.000Z",
    };
    await writeManifestAtomic(dir, manifest);
    const deletedAt = doc.deletedAt;

    // 普通恢复会与目标库副本并存；必须提示改用撤销移动。
    await assert.rejects(
      () => restoreDoc(dir, add.docId),
      /文档已跨库移动，请使用撤销移动/
    );
    const refused = (await readManifest(dir)).docs.find((item) => item.id === add.docId);
    assert.equal(refused.status, "deleted");
    assert.equal(refused.deletedAt, deletedAt);
    assert.deepEqual(refused.movedTo, doc.movedTo);

    // kb_restore 工具同样把 store 的错误透出，不会偷偷恢复。
    await assert.rejects(
      () => tools.get("kb_restore").execute({ kb: "软删除测试", doc: add.docId }, exec),
      /文档已跨库移动，请使用撤销移动/
    );
    const afterTool = (await readManifest(dir)).docs.find((item) => item.id === add.docId);
    assert.equal(afterTool.status, "deleted");
    assert.deepEqual(afterTool.movedTo, doc.movedTo);

    // kb_restore(version=N) 走 restoreDocVersion，同样不能绕过移动墓碑。
    const snapshot = await snapshotDocVersion(dir, { ...afterTool, version: 1 }, "test");
    assert.ok(snapshot);
    await assert.rejects(
      () => restoreDocVersion(dir, add.docId, 1),
      /文档已跨库移动，请使用撤销移动/
    );
    const afterVersion = (await readManifest(dir)).docs.find((item) => item.id === add.docId);
    assert.equal(afterVersion.status, "deleted");
    assert.equal(afterVersion.deletedAt, deletedAt);
    assert.deepEqual(afterVersion.movedTo, doc.movedTo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
