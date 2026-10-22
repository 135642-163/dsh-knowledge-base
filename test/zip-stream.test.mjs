/**
 * P0-5：zip 导出必须流式写盘，不能把整包先生成 Buffer。
 * 测试通过“禁止 generateAsync”来防止回归到缓冲实现。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFileInto } from "../lib/pipeline.js";
import { exportZip, readManifest } from "../lib/store.js";

test("zip export streams instead of buffering the whole archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-zip-stream-"));
  try {
    const kbDir = join(root, "kb");
    await mkdir(kbDir, { recursive: true });
    const src = join(root, "资料.txt");
    await writeFile(src, "流式导出测试内容。\n", "utf8");
    await importFileInto(kbDir, {
      sourcePath: src,
      relKey: "资料.txt",
      title: "资料",
      config: { partMaxChars: 2000 },
    });
    const manifest = await readManifest(kbDir);
    const out = join(root, "export.zip");

    const { default: JSZip } = await import("jszip");
    const original = JSZip.prototype.generateAsync;
    JSZip.prototype.generateAsync = () => {
      throw new Error("exportZip must not call generateAsync: it buffers the whole archive");
    };
    let result;
    try {
      result = await exportZip(kbDir, manifest, out, true);
    } finally {
      JSZip.prototype.generateAsync = original;
    }

    assert.ok(result.bytes > 0);
    const info = await stat(out);
    assert.equal(result.bytes, info.size, "reported bytes must match the file on disk");

    const zip = await JSZip.loadAsync(await readFile(out));
    assert.ok(zip.file("kb.json"));
    const sourceEntry = zip.file(`sources/${manifest.docs[0].id}.txt`);
    assert.ok(sourceEntry, "includeSources must place the original file in the zip");
    assert.match(await sourceEntry.async("string"), /流式导出测试内容/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
