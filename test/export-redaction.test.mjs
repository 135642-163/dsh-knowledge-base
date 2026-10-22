/**
 * 导出包隐私：清单里的本机绝对路径（sourcePath）不能随 zip 交给其他模型/用户。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFileInto } from "../lib/pipeline.js";
import { exportZip, readManifest } from "../lib/store.js";

test("zip export strips local source paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-export-"));
  try {
    const kbDir = join(root, "kb");
    await mkdir(kbDir, { recursive: true });
    const src = join(root, "资料.txt");
    await writeFile(src, "导出测试内容。\n", "utf8");
    await importFileInto(kbDir, {
      sourcePath: src,
      relKey: "资料.txt",
      title: "资料",
      config: { partMaxChars: 2000 },
    });
    const manifest = await readManifest(kbDir);
    assert.equal(typeof manifest.docs[0].sourcePath, "string", "manifest should keep the local path");
    // 模拟一个失败条目：它的 error 可能带本机路径，导出时应整条略过
    manifest.docs.push({
      id: "failed000001",
      title: "坏文件",
      type: "pdf",
      status: "failed",
      pages: 0,
      chars: 0,
      parts: 0,
      version: 0,
      error: `读取失败: ${join(root, "secret", "坏文件.pdf")}`,
      updatedAt: new Date().toISOString(),
    });
    await writeFile(join(kbDir, "kb.json"), JSON.stringify(manifest, null, 2), "utf8");

    const out = join(root, "export.zip");
    await exportZip(kbDir, manifest, out, false);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(out));
    const exported = JSON.parse(await zip.file("kb.json").async("string"));
    assert.equal(exported.docs.length, 1, "failed docs must not be exported");
    assert.equal(exported.docs[0].sourcePath, undefined, "exported manifest must not contain local paths");
    assert.equal(exported.docs[0].sourceFile, "资料.txt");
    assert.equal(JSON.stringify(exported).includes(root), false, "no local root path in exported manifest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
