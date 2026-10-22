/**
 * 0.4.0 内容指纹与管线版本：
 * - 导入记录 sha256 / parserVersion / contentSource；
 * - 同一文件、同一管线再次导入直接跳过，不重跑 OCR；
 * - 内容变化或 forceReparse 时正常重解析。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFileInto } from "../lib/pipeline.js";
import { readManifest } from "../lib/store.js";
import { PARSER_VERSION } from "../lib/version.js";

const CONFIG = { partMaxChars: 4000 };

test("import records hash, parser version and content source", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-hash-"));
  try {
    const kbDir = join(root, "kb");
    const src = join(root, "a.txt");
    await writeFile(src, "第一版内容。\n", "utf8");

    await importFileInto(kbDir, {
      sourcePath: src,
      relKey: "a.txt",
      title: "A",
      config: CONFIG,
    });

    const manifest = await readManifest(kbDir);
    const doc = manifest.docs[0];
    assert.match(doc.sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(doc.parserVersion, PARSER_VERSION);
    assert.equal(doc.contentSource, "text");
    assert.equal(doc.edited, false);
    assert.equal(doc.ocrPages, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged re-import is skipped, changed content is reparsed", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-hash-skip-"));
  try {
    const kbDir = join(root, "kb");
    const src = join(root, "a.txt");
    await writeFile(src, "第一版内容。\n", "utf8");
    const input = { sourcePath: src, relKey: "a.txt", title: "A", config: CONFIG };

    await importFileInto(kbDir, input);
    const same = await importFileInto(kbDir, input);
    assert.equal(same.skippedUnchanged, true);
    let manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.length, 1);
    assert.equal(manifest.docs[0].version, 1);

    await writeFile(src, "第二版内容，已经变化。\n", "utf8");
    const changed = await importFileInto(kbDir, input);
    assert.notEqual(changed.skippedUnchanged, true);
    manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.length, 1);
    assert.equal(manifest.docs[0].version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forceReparse reparses an unchanged file", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-hash-force-"));
  try {
    const kbDir = join(root, "kb");
    const src = join(root, "a.txt");
    await writeFile(src, "内容不变。\n", "utf8");
    const input = { sourcePath: src, relKey: "a.txt", title: "A", config: CONFIG };

    await importFileInto(kbDir, input);
    const forced = await importFileInto(kbDir, {
      ...input,
      config: { ...CONFIG, forceReparse: true },
    });
    assert.notEqual(forced.skippedUnchanged, true);
    const manifest = await readManifest(kbDir);
    assert.equal(manifest.docs[0].version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a title change is not skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-hash-title-"));
  try {
    const kbDir = join(root, "kb");
    const src = join(root, "a.txt");
    await writeFile(src, "内容不变。\n", "utf8");
    await importFileInto(kbDir, { sourcePath: src, relKey: "a.txt", title: "旧标题", config: CONFIG });
    const renamed = await importFileInto(kbDir, {
      sourcePath: src,
      relKey: "a.txt",
      title: "新标题",
      config: CONFIG,
    });
    assert.notEqual(renamed.skippedUnchanged, true);
    const manifest = await readManifest(kbDir);
    assert.equal(manifest.docs[0].title, "新标题");
    assert.equal(manifest.docs[0].version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
