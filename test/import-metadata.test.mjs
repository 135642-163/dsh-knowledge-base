/**
 * 导入元数据：人工/模型摘要不被重导入降级；markSkipped 不留下 importing 占位。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFileInto } from "../lib/pipeline.js";
import {
  markImporting, markSkipped, readManifest, updateDocMetaLocked, withManifestLock,
} from "../lib/store.js";

const CONFIG = { partMaxChars: 4000 };

test("reimport preserves manual summary and manual trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-import-meta-"));
  try {
    const kbDir = join(root, "kb");
    const src = join(root, "a.txt");
    await writeFile(src, "第一版正文。\n", "utf8");
    const first = await importFileInto(kbDir, {
      sourcePath: src, relKey: "a.txt", title: "资料甲", config: CONFIG,
    });
    const docId = first.docId;
    await withManifestLock(kbDir, async () => {
      const manifest = await readManifest(kbDir);
      await updateDocMetaLocked(kbDir, manifest, docId, {
        summary: "人工摘要", summarySource: "manual",
        trust: "high", trustReason: "人工确认", trustSource: "manual",
      });
    });

    await writeFile(src, "第二版正文，已经变化。\n", "utf8");
    await importFileInto(kbDir, {
      sourcePath: src, relKey: "a.txt", title: "资料甲", config: CONFIG,
    });
    const manifest = await readManifest(kbDir);
    const doc = manifest.docs.find((item) => item.id === docId);
    assert.equal(doc.version, 2);
    assert.equal(doc.summary, "人工摘要");
    assert.equal(doc.summarySource, "manual");
    assert.equal(doc.trust, "high");
    assert.equal(doc.trustSource, "manual");
    assert.equal(doc.trustReason, "人工确认");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markSkipped removes a brand-new importing placeholder", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-import-skip-new-"));
  try {
    const kbDir = join(root, "kb");
    await mkdir(kbDir, { recursive: true });
    await markImporting(kbDir, { id: "newdoc", title: "新资料", type: "text", contentSource: "text" });
    let manifest = await readManifest(kbDir);
    assert.equal(manifest.docs[0].status, "importing");
    assert.equal(manifest.docs[0].importingFrom.new, true);
    await markSkipped(kbDir, "newdoc");
    manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markSkipped restores an existing ready document and its fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-import-skip-existing-"));
  try {
    const kbDir = join(root, "kb");
    const src = join(root, "a.txt");
    await writeFile(src, "正文。\n", "utf8");
    const first = await importFileInto(kbDir, {
      sourcePath: src, relKey: "a.txt", title: "资料乙", config: CONFIG,
    });
    await markImporting(kbDir, { id: first.docId, title: "资料乙", type: "text" });
    await markSkipped(kbDir, first.docId);
    const manifest = await readManifest(kbDir);
    const doc = manifest.docs.find((item) => item.id === first.docId);
    assert.equal(doc.status, "ready");
    assert.equal(doc.importingFrom, undefined);
    assert.equal(doc.version, 1);
    assert.equal(doc.title, "资料乙");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { buildDedupIndexFromRoot } from "../lib/dedup-index.js";

test("content cover standard overrides filename GB vs GB/T and skips duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-import-content-"));
  try {
    const kbRoot = join(root, "kb-root");
    const kbDir = join(kbRoot, "kb");
    const body = "5.1 总则。\n".repeat(200);
    const src1 = join(root, "GB 19963.2-2024.txt");
    await writeFile(src1, `GB/T 19963.2-2024\n风电场接入电力系统技术规定 第2部分：海上风电\n${body}`, "utf8");
    const first = await importFileInto(kbDir, {
      sourcePath: src1, relKey: "GB 19963.2-2024.txt", title: "GB 19963.2-2024", config: CONFIG,
    });
    assert.equal(first.skipped, undefined);
    let manifest = await readManifest(kbDir);
    const doc = manifest.docs.find((item) => item.id === first.docId);
    assert.equal(doc.standardSource, "content");
    assert.equal(doc.standardNo, "GB/T 19963.2-2024");
    assert.equal(doc.filenameStandardNo, "GB 19963.2-2024");
    assert.equal(doc.contentIntegrity, "full");
    assert.match(doc.textHash, /^[0-9a-f]{64}$/);

    const src2 = join(root, "GB_T 19963.2-2024 风电场.txt");
    await writeFile(src2, `GB/T 19963.2-2024\n风电场接入电力系统技术规定 第2部分：海上风电\n${body}`, "utf8");
    const index = await buildDedupIndexFromRoot({ root: kbRoot, targetKb: "kb" });
    const second = await importFileInto(kbDir, {
      sourcePath: src2, relKey: "GB_T 19963.2-2024 风电场.txt",
      title: "GB/T 19963.2-2024 风电场", config: CONFIG, dedupIndex: index,
    });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, "duplicate");
    manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same number different stage is imported when content has no stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-import-stage-"));
  try {
    const kbRoot = join(root, "kb-root");
    const kbDir = join(kbRoot, "kb");
    const body = "5.1 总则。\n".repeat(200);
    const published = join(root, "GB_T 1-2020.txt");
    await writeFile(published, `GB/T 1-2020\n标准化工作导则\n${body}`, "utf8");
    await importFileInto(kbDir, {
      sourcePath: published, relKey: "GB_T 1-2020.txt", title: "GB/T 1-2020", config: CONFIG,
    });
    const draft = join(root, "GB_T 1-2020 报批稿.txt");
    await writeFile(draft, `GB/T 1-2020\n标准化工作导则（报批稿）\n${body}`, "utf8");
    const index = await buildDedupIndexFromRoot({ root: kbRoot, targetKb: "kb" });
    const result = await importFileInto(kbDir, {
      sourcePath: draft, relKey: "GB_T 1-2020 报批稿.txt", title: "GB/T 1-2020 报批稿",
      config: CONFIG, dedupIndex: index,
    });
    assert.equal(result.skipped, undefined);
    const manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.length, 2);
    const draftDoc = manifest.docs.find((item) => item.title.includes("报批稿"));
    assert.equal(draftDoc.stage, "draft");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full new file replaces a cover-only duplicate instead of being skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-import-integrity-"));
  try {
    const kbRoot = join(root, "kb-root");
    const kbDir = join(kbRoot, "kb");
    const cover = join(root, "GB_T 2-2020 封面.txt");
    await writeFile(cover, "GB/T 2-2020\n标准封面\n", "utf8");
    const first = await importFileInto(kbDir, {
      sourcePath: cover, relKey: "GB_T 2-2020 封面.txt", title: "GB/T 2-2020", config: CONFIG,
    });
    let manifest = await readManifest(kbDir);
    // 纯文本没有“封面/正文”区分，这里直接写入一个 cover-only 旧文档来验证矩阵。
    await withManifestLock(kbDir, async () => {
      const fresh = await readManifest(kbDir);
      await updateDocMetaLocked(kbDir, fresh, first.docId, { contentIntegrity: "cover-only", chars: 10 });
    });
    manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.find((item) => item.id === first.docId).contentIntegrity, "cover-only");

    const full = join(root, "GB_T 2-2020 完整.txt");
    await writeFile(full, `GB/T 2-2020\n标准完整版\n${"5.1 正文。\n".repeat(200)}`, "utf8");
    const index = await buildDedupIndexFromRoot({ root: kbRoot, targetKb: "kb" });
    const second = await importFileInto(kbDir, {
      sourcePath: full, relKey: "GB_T 2-2020 完整.txt", title: "GB/T 2-2020 完整版",
      config: CONFIG, dedupIndex: index,
    });
    assert.equal(second.skipped, undefined);
    manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.length, 2);
    assert.ok(second.warnings.some((warning) => /残缺版本/.test(warning)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
