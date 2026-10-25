/**
 * 旧库资料身份回填：dry-run 不写、sourceHash/标准号/正文完整性/textHash/trust/retitle。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBackfill, planBackfill } from "../lib/backfill.js";
import { createKb } from "../lib/kbmeta.js";
import { readManifest } from "../lib/store.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-backfill-"));
  const kbRoot = join(root, "kb");
  const { dir } = await createKb(kbRoot, { name: "标准" });
  const body = "5.1 总则。\n".repeat(300);
  await mkdir(join(dir, "sources"), { recursive: true });
  await writeFile(join(dir, "sources", "d1.pdf"), "%PDF-1.4\nGB/T 19963.2-2024\n", "utf8");
  await mkdir(join(dir, "markdown", "d1", "parts"), { recursive: true });
  await writeFile(join(dir, "markdown", "d1", "parts", "0001.md"), `<!-- doc: d1 | 部分 1/1 -->\n# 封面\n\nGB/T 19963.2-2024\n风电场接入电力系统技术规定 第2部分：海上风电\n${body}`, "utf8");
  await writeFile(join(dir, "markdown", "d1", "parts", "index.json"), JSON.stringify([{ part: 1, startLine: 1, endLine: 20, pageStart: 1, pageEnd: 17 }]), "utf8");
  await writeFile(join(dir, "markdown", "d1", "d1.md"), `# GB 19963.2-2024\n\nGB/T 19963.2-2024\n风电场接入电力系统技术规定 第2部分：海上风电\n${body}`, "utf8");
  const manifest = await readManifest(dir);
  manifest.docs.push({
    id: "d1", title: "GB/T19963.2-2024 风电场接入电力系统技术规定 第2部分：海上风电", sourceFile: "GB/T19963.2-2024.pdf",
    type: "pdf-scanned", status: "ready", version: 1, chars: body.length, parts: 1,
    trust: "unknown", summarySource: "auto",
  });
  await writeFile(join(dir, "kb.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { root, dir };
}

test("dry-run 不写盘，apply 回填 hash/标准号/正文/textHash", async () => {
  const { root, dir } = await setup();
  try {
    const plan = await planBackfill(dir, { hash: true, std: true, content: true, text: true, trust: true, retitle: true });
    assert.equal(plan.counts.scanned, 1);
    assert.equal(plan.changes.length, 1);
    const change = plan.changes[0];
    assert.match(change.patch.sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(change.patch.standardNo, "GB/T 19963.2-2024");
    assert.equal(change.patch.standardSource, "content");
    assert.equal(change.patch.filenameStandardNo, "GB/T 19963.2-2024");
    assert.equal(change.patch.contentIntegrity, "full");
    assert.match(change.patch.textHash, /^[0-9a-f]{64}$/);
    assert.equal(change.patch.trust, "medium");
    assert.equal(change.patch.title, "GB/T 19963.2-2024 风电场接入电力系统技术规定 第2部分：海上风电");

    let manifest = await readManifest(dir);
    assert.equal(manifest.docs[0].sourceHash, "");
    assert.equal(manifest.docs[0].standardNo, "");

    const applied = await applyBackfill(dir, plan);
    assert.equal(applied.applied, 1);
    assert.equal(applied.retitled, 1);
    manifest = await readManifest(dir);
    const doc = manifest.docs[0];
    assert.equal(doc.standardNo, "GB/T 19963.2-2024");
    assert.equal(doc.standardSource, "content");
    assert.equal(doc.contentIntegrity, "full");
    assert.match(doc.sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(doc.version, 2);
    assert.ok(doc.history.some((item) => item.reason === "retitle-backfill"));
    const merged = await readFile(join(dir, "markdown", "d1", "d1.md"), "utf8");
    assert.match(merged, /^# GB\/T 19963\.2-2024 /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retitle 不作用于非标准/正文不完整文档", async () => {
  const { root, dir } = await setup();
  try {
    const manifest = await readManifest(dir);
    manifest.docs[0].contentIntegrity = "cover-only";
    await writeFile(join(dir, "kb.json"), JSON.stringify(manifest, null, 2), "utf8");
    const plan = await planBackfill(dir, { std: true, retitle: true });
    assert.equal(plan.counts.retitle, 0);
    assert.equal(plan.changes.some((change) => change.retitle), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("缺失原件时 sourceHash 计入 skipped", async () => {
  const { root, dir } = await setup();
  try {
    await rm(join(dir, "sources", "d1.pdf"));
    const plan = await planBackfill(dir, { hash: true });
    assert.equal(plan.counts.hash, 0);
    assert.equal(plan.skipped.length, 1);
    assert.match(plan.skipped[0].reason, /原件缺失/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
