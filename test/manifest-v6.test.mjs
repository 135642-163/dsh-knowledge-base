/**
 * manifest v6：资料身份元数据（标题/标准号/完整性/哈希/trustSource）惰性归一。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, SCHEMA_VERSION } from "../lib/store.js";

test("SCHEMA_VERSION is 6", () => {
  assert.equal(SCHEMA_VERSION, 6);
});

test("v5 manifest lazily gains v6 metadata fields without rewriting the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-manifest-v6-"));
  try {
    const dir = join(root, "标准");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "kb.json"), JSON.stringify({
      schemaVersion: 5,
      name: "标准",
      docs: [
        { id: "d1", title: "DL/T 587-2025 继电保护", status: "ready", version: 2, sourceHash: "abc", trust: "high", summarySource: "manual" },
        { id: "d2", title: "普通资料", status: "ready", version: 1, trust: "unknown" },
      ],
    }), "utf8");

    const manifest = await readManifest(dir);
    assert.equal(manifest.schemaVersion, 6);
    const [d1, d2] = manifest.docs;
    assert.equal(d1.rawTitle, d1.title);
    assert.equal(d1.canonicalTitle, d1.title);
    assert.equal(d1.standardNo, "");
    assert.equal(d1.standardSource, "none");
    assert.equal(d1.contentIntegrity, "unknown");
    assert.equal(d1.summarySource, "manual");
    assert.equal(d1.trustSource, "manual");
    assert.equal(d2.trustSource, "unknown");
    assert.equal(d1.textHash, "");
    assert.equal(d1.metadataUpdatedAt, "");

    // 只读迁移不落盘：v5 文件保持原样，下一次写入才会备份并升级。
    const raw = JSON.parse(await readFile(join(dir, "kb.json"), "utf8"));
    assert.equal(raw.schemaVersion, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v6 fields round-trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-manifest-v6-rt-"));
  try {
    const dir = join(root, "库");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "kb.json"), JSON.stringify({
      schemaVersion: 6,
      name: "库",
      docs: [{
        id: "d1", title: "GB/T 19963.2-2024 风电场", status: "ready", version: 1,
        rawTitle: "GB_T 19963.2-2024 风电场",
        canonicalTitle: "GB/T 19963.2-2024 风电场",
        standardNo: "GB/T 19963.2-2024", standardPrefix: "GB/T", standardNumber: "19963.2",
        standardBase: "19963", standardYear: 2024, standardPart: "2",
        standardSource: "content", filenameStandardNo: "GB 19963.2-2024",
        contentTitle: "风电场接入电力系统技术规定 第2部分：海上风电",
        contentIntegrity: "full", bodyChars: 18000, clauseCount: 42,
        textHash: "f".repeat(64), textHashAlgo: "sha256-norm-v1",
        stage: "published", stageLabel: "发布稿",
        trust: "medium", trustReason: "已发布标准，尚未核实现行/废止", trustSource: "heuristic",
        summarySource: "manual", metadataUpdatedAt: "2026-10-25T00:00:00.000Z",
      }],
    }), "utf8");
    const manifest = await readManifest(dir);
    const doc = manifest.docs[0];
    assert.equal(doc.standardNo, "GB/T 19963.2-2024");
    assert.equal(doc.standardPart, "2");
    assert.equal(doc.standardSource, "content");
    assert.equal(doc.contentIntegrity, "full");
    assert.equal(doc.textHashAlgo, "sha256-norm-v1");
    assert.equal(doc.trustSource, "heuristic");
    assert.equal(doc.summarySource, "manual");
    assert.equal(doc.metadataUpdatedAt, "2026-10-25T00:00:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
