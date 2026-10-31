/**
 * 流式 ZIP 读取：STORE / DEFLATE / 中文名 / 符号链接 / 截断与损坏。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { openZipReader } from "../lib/zip-reader.js";

async function buildZip(files) {
  const zip = new JSZip();
  for (const [name, content, options] of files) zip.file(name, content, options);
  return await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

test("读取 DEFLATE 文本与 STORE 二进制，并解压到磁盘", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-zip-reader-"));
  try {
    const binary = Buffer.from([0, 1, 2, 3, 254, 255]);
    const buffer = await buildZip([
      ["markdown/中文/中文.md", "# 标题\n\n正文。\n"],
      ["sources/中文.bin", binary, { compression: "STORE" }],
      ["manifest.json", JSON.stringify({ ok: true })],
    ]);
    const zipPath = join(root, "p.zip");
    await writeFile(zipPath, buffer);
    const reader = await openZipReader(zipPath);
    assert.equal(reader.list().filter((entry) => !entry.isDirectory).length, 3);
    assert.equal(await reader.readText("markdown/中文/中文.md"), "# 标题\n\n正文。\n");
    assert.deepEqual([...await reader.readEntryBuffer("sources/中文.bin")], [...binary]);
    assert.equal(JSON.parse(await reader.readText("manifest.json")).ok, true);
    const dest = join(root, "out", "中文.bin");
    await reader.extractEntry("sources/中文.bin", dest);
    assert.deepEqual([...await readFile(dest)], [...binary]);
    const destMd = join(root, "out", "中文.md");
    await reader.extractEntry("markdown/中文/中文.md", destMd);
    assert.equal(await readFile(destMd, "utf8"), "# 标题\n\n正文。\n");
    assert.equal(reader.entries.get("markdown/中文/中文.md").isSymlink, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("符号链接条目可识别，加密/损坏包报错", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-zip-reader-"));
  try {
    const symlink = await buildZip([["link", "target", { unixPermissions: 0o120777 }]]);
    const symlinkPath = join(root, "symlink.zip");
    await writeFile(symlinkPath, symlink);
    const reader = await openZipReader(symlinkPath);
    assert.equal(reader.entries.get("link").isSymlink, true);

    const badPath = join(root, "bad.zip");
    await writeFile(badPath, "not a zip");
    await assert.rejects(() => openZipReader(badPath), (error) => error.code === "ZIP_INVALID");

    const truncatedPath = join(root, "truncated.zip");
    await writeFile(truncatedPath, symlink.subarray(0, symlink.length - 10));
    await assert.rejects(() => openZipReader(truncatedPath), (error) => error.code === "ZIP_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("条目缺失报 ZIP_ENTRY_NOT_FOUND", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-zip-reader-"));
  try {
    const buffer = await buildZip([["a.txt", "a"]]);
    const file = join(root, "a.zip");
    await writeFile(file, buffer);
    const reader = await openZipReader(file);
    await assert.rejects(() => reader.readText("b.txt"), (error) => error.code === "ZIP_ENTRY_NOT_FOUND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
