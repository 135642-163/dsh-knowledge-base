import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKb, updateKbMeta } from "../lib/kbmeta.js";
import { importFileInto } from "../lib/pipeline.js";
import { planMerge } from "../lib/merge.js";
import {
  kbDirPath, listKbs, readManifest, removeDoc, updateDocMetaLocked,
  withManifestLock, writeManifestAtomic,
} from "../lib/store.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-readonly-"));
  await createKb(root, { name: "只读库" });
  const file = join(root, "a.txt");
  await writeFile(file, "只读测试正文。\n", "utf8");
  await importFileInto(kbDirPath(root, "只读库"), {
    sourcePath: file, relKey: "a.txt", title: "只读测试资料",
    config: { partMaxChars: 500 },
  });
  const dir = kbDirPath(root, "只读库");
  const manifest = await readManifest(dir);
  manifest.readOnly = true;
  await writeManifestAtomic(dir, manifest);
  return { root, dir };
}

test("readOnly：查询/读取可用，写入被拒绝；可关闭只读", async () => {
  const { root, dir } = await setup();
  try {
    const listed = await listKbs(root);
    assert.equal(listed.find((kb) => kb.name === "只读库")?.readOnly, true);
    assert.equal((await readManifest(dir)).readOnly, true);

    const manifest = await readManifest(dir);
    await assert.rejects(
      () => importFileInto(dir, { sourcePath: join(root, "a.txt"), relKey: "b.txt", title: "新资料", config: { partMaxChars: 500 } }),
      (error) => error.code === "KB_READONLY"
    );
    await assert.rejects(
      () => updateDocMetaLocked(dir, manifest, manifest.docs[0].id, { summary: "改摘要" }),
      (error) => error.code === "KB_READONLY"
    );
    await assert.rejects(
      () => removeDoc(dir, manifest.docs[0].id),
      (error) => error.code === "KB_READONLY"
    );
    await assert.rejects(
      () => updateKbMeta(root, "只读库", { description: "改简介" }),
      /只读/
    );
    const off = await updateKbMeta(root, "只读库", { readOnly: false });
    assert.equal(off.manifest.readOnly, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readOnly：合并源/目标都拒绝", async () => {
  const { root } = await setup();
  try {
    await createKb(root, { name: "目标库" });
    await assert.rejects(
      () => planMerge({ kbRoot: root, sources: ["只读库"], target: { name: "目标库" } }),
      (error) => error.code === "KB_READONLY"
    );
    const targetDir = kbDirPath(root, "目标库");
    const target = await readManifest(targetDir);
    target.readOnly = true;
    await writeManifestAtomic(targetDir, target);
    await assert.rejects(
      () => planMerge({ kbRoot: root, sources: ["只读库"], target: { name: "目标库" } }),
      (error) => error.code === "KB_READONLY"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
