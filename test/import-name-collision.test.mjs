/**
 * 同名不同文件保护：单文件导入时 relKey 都是 basename，不能因此互相覆盖。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFileInto } from "../lib/pipeline.js";
import { readManifest } from "../lib/store.js";

test("same basename from different directories does not overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-collision-"));
  try {
    const kbDir = join(root, "kb");
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    await mkdir(kbDir, { recursive: true });
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = join(dirA, "通知.txt");
    const fileB = join(dirB, "通知.txt");
    await writeFile(fileA, "这是 A 目录的通知内容。\n", "utf8");
    await writeFile(fileB, "这是 B 目录的通知内容。\n", "utf8");

    const first = await importFileInto(kbDir, {
      sourcePath: fileA,
      relKey: "通知.txt",
      title: "通知A",
      config: { partMaxChars: 4000 },
    });
    const second = await importFileInto(kbDir, {
      sourcePath: fileB,
      relKey: "通知.txt",
      title: "通知B",
      config: { partMaxChars: 4000 },
    });

    assert.notEqual(second.docId, first.docId, "different files must get different doc ids");
    const manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.length, 2);
    const mergedA = await readFile(join(kbDir, "markdown", first.docId, `${first.docId}.md`), "utf8");
    const mergedB = await readFile(join(kbDir, "markdown", second.docId, `${second.docId}.md`), "utf8");
    assert.match(mergedA, /A 目录的通知内容/);
    assert.match(mergedB, /B 目录的通知内容/);

    // 同一路径重复导入仍然是原位更新，不新增文档
    const again = await importFileInto(kbDir, {
      sourcePath: fileA,
      relKey: "通知.txt",
      title: "通知A",
      config: { partMaxChars: 4000 },
    });
    assert.equal(again.docId, first.docId);
    const after = await readManifest(kbDir);
    assert.equal(after.docs.length, 2);
    assert.equal(after.docs.find((d) => d.id === first.docId)?.version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic relKey keeps updating in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-collision-synthetic-"));
  try {
    const kbDir = join(root, "kb");
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    await mkdir(kbDir, { recursive: true });
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = join(dirA, "标准.txt");
    const fileB = join(dirB, "标准.txt");
    await writeFile(fileA, "第一版内容。\n", "utf8");
    await writeFile(fileB, "第二版内容。\n", "utf8");

    // kb_std_check 这类调用方用稳定的合成 key；下载到临时目录后路径会变，
    // 但仍应原位更新，而不是因为 sourcePath 变化另建文档。
    const first = await importFileInto(kbDir, {
      sourcePath: fileA,
      relKey: "std-download/标准.txt",
      stableKey: true,
      title: "标准",
      config: { partMaxChars: 4000 },
    });
    const second = await importFileInto(kbDir, {
      sourcePath: fileB,
      relKey: "std-download/标准.txt",
      stableKey: true,
      title: "标准",
      config: { partMaxChars: 4000 },
    });
    assert.equal(second.docId, first.docId);
    const manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.length, 1);
    assert.equal(manifest.docs[0].version, 2);
    const merged = await readFile(join(kbDir, "markdown", first.docId, `${first.docId}.md`), "utf8");
    assert.match(merged, /第二版内容/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same nested relative path from different roots does not overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-collision-nested-"));
  try {
    const kbDir = join(root, "kb");
    const dirA = join(root, "a", "docs");
    const dirB = join(root, "b", "docs");
    await mkdir(kbDir, { recursive: true });
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = join(dirA, "规范.txt");
    const fileB = join(dirB, "规范.txt");
    await writeFile(fileA, "根目录 A 的规范。\n", "utf8");
    await writeFile(fileB, "根目录 B 的规范。\n", "utf8");

    const first = await importFileInto(kbDir, {
      sourcePath: fileA,
      relKey: "docs/规范.txt",
      title: "规范A",
      config: { partMaxChars: 4000 },
    });
    const second = await importFileInto(kbDir, {
      sourcePath: fileB,
      relKey: "docs/规范.txt",
      title: "规范B",
      config: { partMaxChars: 4000 },
    });
    assert.notEqual(second.docId, first.docId);
    const manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
