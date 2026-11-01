import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKb } from "../lib/kbmeta.js";
import { kbDirPath, readManifest, writeManifestAtomic } from "../lib/store.js";
import { executeMerge, planMerge, sweepMergedSources, undoMerge } from "../lib/merge.js";

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "kb-merge-"));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function addDoc(root, kb, { id, title, hash = id, chars = 100, type = "text" }) {
  const dir = kbDirPath(root, kb);
  const manifest = await readManifest(dir);
  manifest.docs.push({
    id, title, type, status: "ready", sourceHash: hash, chars, parts: 1, version: 1,
    standardNo: title.match(/^(?:GB\/T|GB|DL\/T|Q\/GDW)\s+[0-9.]+-\d{4}/)?.[0] ?? "",
  });
  await writeManifestAtomic(dir, manifest);
  await mkdir(join(dir, "markdown", id), { recursive: true });
  await writeFile(join(dir, "markdown", id, `${id}.md`), `# ${title}\n\n正文\n`, "utf8");
  await mkdir(join(dir, "sources"), { recursive: true });
  await writeFile(join(dir, "sources", `${id}.txt`), `${title}\n`, "utf8");
}

test("plan：id 同内容跳过、同 id 异内容改名、同号同版本跳过、多版本保留", async () => {
  await withRoot(async (root) => {
    await createKb(root, { name: "C" });
    await createKb(root, { name: "A" });
    await addDoc(root, "C", { id: "same", title: "GB/T 12325-2008 电压偏差", hash: "h1" });
    await addDoc(root, "C", { id: "idconflict", title: "其他标准", hash: "h2" });
    await addDoc(root, "C", { id: "dup", title: "GB/T 5000-2020 同名标准", hash: "h3" });
    await addDoc(root, "A", { id: "same", title: "GB/T 12325-2008 电压偏差", hash: "h1" });
    await addDoc(root, "A", { id: "idconflict", title: "其他标准", hash: "different" });
    await addDoc(root, "A", { id: "dupid", title: "GB/T 5000-2020 同名标准", hash: "h4" });
    await addDoc(root, "A", { id: "multi", title: "GB/T 12325-2019 电压偏差", hash: "h5" });

    const plan = await planMerge({ kbRoot: root, sources: ["A"], target: { name: "C" } });
    assert.equal(plan.summary.skipSame, 1);
    assert.equal(plan.summary.rename, 1);
    assert.equal(plan.summary.skipDuplicate, 1);
    assert.equal(plan.summary.move, 1);
    assert.ok(plan.warnings.some((w) => w.code === "MULTI_VERSION"));
  });
});

test("execute：物理移动、源库 mergedInto/purge、journal、快照", async () => {
  await withRoot(async (root) => {
    await createKb(root, { name: "A" });
    await createKb(root, { name: "B" });
    await addDoc(root, "A", { id: "a1", title: "GB/T 1-2020 甲标准" });
    await addDoc(root, "B", { id: "b1", title: "GB/T 2-2020 乙标准" });
    const result = await executeMerge({
      kbRoot: root,
      sources: ["A", "B"],
      target: { name: "C", create: true },
      snapshot: false,
    });
    assert.equal(result.summary.move, 2);
    const c = await readManifest(kbDirPath(root, "C"));
    assert.equal(c.docs.length, 2);
    const a = await readManifest(kbDirPath(root, "A"));
    assert.equal(a.mergedInto, "C");
    assert.ok(a.mergePurgeAfter);
    assert.equal(a.docs.length, 0);
    await stat(join(kbDirPath(root, "A"), "sources", "a1.txt"));
    const journal = await readFile(join(kbDirPath(root, "C"), "snapshots", result.journal), "utf8");
    assert.match(journal, /a1/);
  });
});

test("execute：部分合并时源库不标 mergedInto，跳过文档仍可见", async () => {
  await withRoot(async (root) => {
    await createKb(root, { name: "C" });
    await createKb(root, { name: "A" });
    await addDoc(root, "C", { id: "c1", title: "GB/T 1-2020 甲标准", hash: "h1" });
    await addDoc(root, "A", { id: "a1", title: "GB/T 1-2020 甲标准", hash: "h2" });
    await addDoc(root, "A", { id: "a2", title: "GB/T 2-2020 乙标准", hash: "h3" });
    const result = await executeMerge({
      kbRoot: root,
      sources: ["A"],
      target: { name: "C" },
      snapshot: false,
    });
    assert.equal(result.summary.move, 1);
    assert.equal(result.summary.skipDuplicate, 1);
    const a = await readManifest(kbDirPath(root, "A"));
    assert.equal(a.mergedInto, null);
    assert.equal(a.docs.length, 1);
    assert.equal(a.docs[0].id, "a1");
  });
});

test("sweepMergedSources：到期后删大目录，保留墓碑清单", async () => {
  await withRoot(async (root) => {
    await createKb(root, { name: "A" });
    await addDoc(root, "A", { id: "a1", title: "GB/T 1-2020 甲标准" });
    const aDir = kbDirPath(root, "A");
    const manifest = await readManifest(aDir);
    manifest.docs = [];
    manifest.mergedInto = "C";
    manifest.mergedAt = "2026-01-01T00:00:00.000Z";
    manifest.mergePurgeAfter = "2026-01-02T00:00:00.000Z";
    await writeManifestAtomic(aDir, manifest);
    const r = await sweepMergedSources({ kbRoot: root, now: Date.parse("2026-01-03T00:00:00.000Z") });
    assert.equal(r.purged.length, 1);
    await assert.rejects(() => stat(join(aDir, "sources")), { code: "ENOENT" });
    const after = await readManifest(aDir);
    assert.ok(after.mergePurgedAt);
    await stat(join(aDir, "kb.json"));
  });
});

test("undoMerge：按 journal 把目标文档移回源库并清 mergedInto", async () => {
  await withRoot(async (root) => {
    await createKb(root, { name: "A" });
    await createKb(root, { name: "B" });
    await addDoc(root, "A", { id: "a1", title: "GB/T 1-2020 甲标准" });
    await addDoc(root, "B", { id: "b1", title: "GB/T 2-2020 乙标准" });
    const merged = await executeMerge({
      kbRoot: root,
      sources: ["A", "B"],
      target: { name: "C", create: true },
      snapshot: false,
    });
    const undone = await undoMerge({ kbRoot: root, target: "C", journal: merged.journal });
    assert.equal(undone.moved, 2);
    const c = await readManifest(kbDirPath(root, "C"));
    assert.equal(c.docs.length, 0);
    const a = await readManifest(kbDirPath(root, "A"));
    const b = await readManifest(kbDirPath(root, "B"));
    assert.equal(a.docs.length, 1);
    assert.equal(b.docs.length, 1);
    assert.equal(a.mergedInto, null);
    assert.equal(a.mergePurgeAfter, null);
    await stat(join(kbDirPath(root, "A"), "sources", "a1.txt"));
    const journal = JSON.parse(await readFile(join(kbDirPath(root, "C"), "snapshots", undone.journal), "utf8"));
    assert.equal(journal.status, "undone");
  });
});

test("undoMerge：部分合并也能移回，保留源库原有跳过文档", async () => {
  await withRoot(async (root) => {
    await createKb(root, { name: "C" });
    await createKb(root, { name: "A" });
    await addDoc(root, "C", { id: "c1", title: "GB/T 1-2020 甲标准", hash: "h1" });
    await addDoc(root, "A", { id: "a1", title: "GB/T 1-2020 甲标准", hash: "h2" });
    await addDoc(root, "A", { id: "a2", title: "GB/T 2-2020 乙标准", hash: "h3" });
    const merged = await executeMerge({ kbRoot: root, sources: ["A"], target: { name: "C" }, snapshot: false });
    const undone = await undoMerge({ kbRoot: root, target: "C", journal: merged.journal });
    assert.equal(undone.moved, 1);
    const a = await readManifest(kbDirPath(root, "A"));
    assert.equal(a.docs.length, 2);
    assert.equal(a.mergedInto, null);
    const c = await readManifest(kbDirPath(root, "C"));
    assert.equal(c.docs.length, 1);
    assert.equal(c.docs[0].id, "c1");
  });
});
