/**
 * 跨库安全移动：预检冲突/上限、成功移动、冲突跳过与改名、批量部分失败、
 * 撤销、崩溃恢复（journal sweep）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKb } from "../lib/kbmeta.js";
import { readManifest, touchDoc, writeManifestAtomic } from "../lib/store.js";
import {
  MAX_MOVE_BYTES,
  discardAttempt,
  moveDocs,
  preflightMove,
  sweepTransfers,
  undoMove,
} from "../lib/transfer.js";

const SRC = "源库";
const TGT = "目标库";

async function makeEnv() {
  const root = await mkdtemp(join(tmpdir(), "kb-transfer-"));
  const kbRoot = join(root, "kb");
  const source = await createKb(kbRoot, { name: SRC });
  const target = await createKb(kbRoot, { name: TGT });
  return { root, kbRoot, sourceDir: source.dir, targetDir: target.dir };
}

/** 直接写清单 + sources/markdown 文件，模拟一篇已经整理好的资料。 */
async function addDoc(kbDir, options = {}) {
  const {
    id,
    title = `文档 ${id}`,
    sourceHash = "",
    status = "ready",
    sourceExt = ".pdf",
    sourceBytes = 16,
    markdown = true,
    parts = true,
    deleted = false,
    extra = {},
  } = options;
  const sourceName = `${id}${sourceExt}`;
  await mkdir(join(kbDir, "sources"), { recursive: true });
  await writeFile(join(kbDir, "sources", sourceName), Buffer.alloc(sourceBytes, 0x61));
  if (markdown) {
    await mkdir(join(kbDir, "markdown", id), { recursive: true });
    await writeFile(join(kbDir, "markdown", id, `${id}.md`), `# ${title}\n\n正文 ${id}\n`, "utf8");
    if (parts) {
      await mkdir(join(kbDir, "markdown", id, "parts"), { recursive: true });
      await writeFile(join(kbDir, "markdown", id, "parts", "0001.md"), `正文 ${id}\n`, "utf8");
    }
  }
  const manifest = await readManifest(kbDir);
  const doc = {
    id,
    title,
    type: "pdf-text",
    status,
    pages: 1,
    chars: 10,
    parts: 1,
    sourceFile: sourceName,
    sourcePath: `/outside/${sourceName}`,
    sourceHash,
    version: 1,
    importedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
  if (deleted) {
    doc.status = "deleted";
    doc.deletedAt = "2026-01-02T00:00:00.000Z";
    doc.deletedFromStatus = status;
  }
  manifest.docs.push(doc);
  await writeManifestAtomic(kbDir, manifest);
  return doc;
}

async function docsOf(kbDir) {
  return (await readManifest(kbDir)).docs ?? [];
}

async function docOf(kbDir, id) {
  return (await docsOf(kbDir)).find((doc) => doc.id === id) ?? null;
}

async function journalsIn(kbRoot) {
  try {
    return (await readdir(join(kbRoot, ".transfers"))).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

async function stagingIn(kbDir) {
  try {
    return await readdir(join(kbDir, ".transfer"));
  } catch {
    return [];
  }
}

async function writeJournalFile(kbRoot, journal) {
  const dir = join(kbRoot, ".transfers");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${journal.transferId}.json`), JSON.stringify(journal, null, 2), "utf8");
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "TransferError");
    assert.equal(error?.code, code);
    return true;
  });
}

function preflight(env, docIds) {
  return preflightMove({ kbRoot: env.kbRoot, sourceKb: SRC, targetKb: TGT, docIds });
}

function move(env, docIds, options = {}) {
  return moveDocs({
    kbRoot: env.kbRoot,
    sourceKb: SRC,
    targetKb: TGT,
    docIds,
    ...options,
  });
}

test("preflight dedupes ids, reports size and conflicts by id/hash/title", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.sourceDir, { id: "id1", title: "同 id 资料" });
    await addDoc(env.targetDir, { id: "id1", title: "目标库同 id" });
    await addDoc(env.sourceDir, { id: "hash1", title: "哈希资料", sourceHash: "abc123" });
    await addDoc(env.targetDir, { id: "t-hash", title: "目标库同内容", sourceHash: "abc123" });
    await addDoc(env.sourceDir, { id: "title1", title: "电压 偏差" });
    await addDoc(env.targetDir, { id: "t-title", title: "  电压  偏差  " });
    await addDoc(env.sourceDir, { id: "clean1", title: "干净资料", sourceBytes: 32 });

    const result = await preflight(env, ["id1", "hash1", "title1", "clean1", "hash1"]);
    assert.equal(result.docs.length, 4, "重复 id 只保留一次");
    assert.deepEqual(
      result.docs.map((doc) => doc.conflict?.kind ?? null),
      ["id", "hash", "title", null]
    );
    assert.equal(result.docs[0].conflict.withTitle, "目标库同 id");
    assert.equal(result.docs[1].conflict.withTitle, "目标库同内容");
    assert.equal(result.docs[2].conflict.withTitle, "  电压  偏差  ");
    assert.equal(result.docs[3].sourceFile, "clean1.pdf");
    assert.equal(result.docs[3].size, 32);
    assert.equal(result.totalBytes, 16 + 16 + 16 + 32);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("preflight rejects bad KBs, non-ready/deleted docs and missing sources", async () => {
  const env = await makeEnv();
  try {
    const same = await preflightMove({
      kbRoot: env.kbRoot,
      sourceKb: SRC,
      targetKb: SRC,
      docIds: ["x"],
    }).catch((error) => error);
    assert.equal(same.code, "TRANSFER_SAME_KB");

    await expectCode(
      preflightMove({ kbRoot: env.kbRoot, sourceKb: SRC, targetKb: "不存在库", docIds: ["x"] }),
      "TRANSFER_KB_NOT_FOUND"
    );

    const missingDoc = await preflight(env, ["nope"]).catch((error) => error);
    assert.equal(missingDoc.code, "TRANSFER_DOC_NOT_FOUND");
    assert.equal(missingDoc.message.includes(env.kbRoot), false);

    await addDoc(env.sourceDir, { id: "failed1", status: "failed" });
    await expectCode(preflight(env, ["failed1"]), "TRANSFER_DOC_NOT_READY");
    await addDoc(env.sourceDir, { id: "import1", status: "importing" });
    await expectCode(preflight(env, ["import1"]), "TRANSFER_DOC_NOT_READY");
    await addDoc(env.sourceDir, { id: "gone1", deleted: true });
    await expectCode(preflight(env, ["gone1"]), "TRANSFER_DOC_DELETED");

    await addDoc(env.sourceDir, { id: "nosource" });
    await rm(join(env.sourceDir, "sources", "nosource.pdf"));
    const noSource = await preflight(env, ["nosource"]).catch((error) => error);
    assert.equal(noSource.code, "TRANSFER_SOURCE_MISSING");
    assert.equal(noSource.message.includes(env.kbRoot), false);

    // 已合并的库不能再作为目标。
    const targetManifest = await readManifest(env.targetDir);
    targetManifest.mergedInto = SRC;
    await writeManifestAtomic(env.targetDir, targetManifest);
    await addDoc(env.sourceDir, { id: "movable" });
    await expectCode(preflight(env, ["movable"]), "TRANSFER_TARGET_MERGED");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("preflight enforces the 50-doc and 500 MB caps", async () => {
  const env = await makeEnv();
  try {
    const ids = [];
    for (let i = 0; i < 51; i += 1) {
      const id = `cap${String(i).padStart(2, "0")}`;
      ids.push(id);
      await addDoc(env.sourceDir, { id, sourceBytes: 8 });
    }
    const tooMany = await preflight(env, ids).catch((error) => error);
    assert.equal(tooMany.code, "TRANSFER_TOO_MANY");
    assert.match(tooMany.message, /最多移动 50 篇/);

    const sparse = await addDoc(env.sourceDir, { id: "huge1", sourceBytes: 8 });
    await truncate(join(env.sourceDir, "sources", sparse.sourceFile), MAX_MOVE_BYTES + 1024);
    const huge = await preflight(env, ["huge1"]).catch((error) => error);
    assert.equal(huge.code, "TRANSFER_TOO_LARGE");
    assert.match(huge.message, /500 MB/);
    assert.equal(huge.message.includes(env.kbRoot), false);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("move copies files, writes target entry, soft-deletes source and keeps files", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.sourceDir, {
      id: "d1",
      title: "电压偏差",
      sourceHash: "hash-d1",
      extra: { history: [{ version: 1, savedAt: "2026-01-01T00:00:00.000Z", reason: "import" }] },
    });
    const result = await move(env, ["d1"]);

    assert.equal(result.moved, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);
    assert.ok(result.transferId, "单篇移动返回 transferId");
    assert.match(result.transferId, /^[0-9a-f]{16}$/);
    const row = result.results[0];
    assert.equal(row.status, "moved");
    assert.equal(row.newId, "d1");
    assert.equal(row.newTitle, "电压偏差");

    const targetDoc = await docOf(env.targetDir, "d1");
    assert.ok(targetDoc, "目标库新增文档");
    assert.equal(targetDoc.status, "ready");
    assert.equal(targetDoc.title, "电压偏差");
    assert.equal(targetDoc.sourceFile, "d1.pdf");
    assert.equal(targetDoc.version, 1, "目标条目从源文档版本开始");
    assert.equal(targetDoc.transferId, result.transferId);
    assert.deepEqual(
      { kb: targetDoc.movedFrom.kb, docId: targetDoc.movedFrom.docId, version: targetDoc.movedFrom.version },
      { kb: SRC, docId: "d1", version: 1 },
      "movedFrom 记录移动时的源文档版本"
    );
    assert.equal(targetDoc.deletedAt, undefined);
    assert.equal(targetDoc.deletedFromStatus, undefined);
    assert.equal(targetDoc.movedTo, undefined);
    // 历史快照没有随移动复制，目标条目不应保留指向空目录的 history。
    assert.equal(targetDoc.history, undefined);
    assert.equal((await docOf(env.sourceDir, "d1")).history.length, 1, "源库历史保留");

    assert.equal(await readFile(join(env.targetDir, "sources", "d1.pdf"), "utf8"), "a".repeat(16));
    assert.match(
      await readFile(join(env.targetDir, "markdown", "d1", "d1.md"), "utf8"),
      /电压偏差/
    );
    assert.match(
      await readFile(join(env.targetDir, "markdown", "d1", "parts", "0001.md"), "utf8"),
      /正文 d1/
    );

    const sourceDoc = await docOf(env.sourceDir, "d1");
    assert.equal(sourceDoc.status, "deleted");
    assert.equal(sourceDoc.deletedFromStatus, "ready");
    assert.ok(sourceDoc.deletedAt);
    assert.equal(sourceDoc.movedTo.kb, TGT);
    assert.equal(sourceDoc.movedTo.docId, "d1");
    assert.equal(sourceDoc.movedTo.transferId, result.transferId);
    // 源库文件保留，撤销/恢复才有内容。
    assert.equal(existsSync(join(env.sourceDir, "sources", "d1.pdf")), true);
    assert.equal(existsSync(join(env.sourceDir, "markdown", "d1", "d1.md")), true);

    const sourceLog = await readFile(join(env.sourceDir, "log.md"), "utf8");
    assert.match(sourceLog, /跨库移动到「目标库」/);
    const targetLog = await readFile(join(env.targetDir, "log.md"), "utf8");
    assert.match(targetLog, /从「源库」移入/);
    const sourceIndex = await readFile(join(env.sourceDir, "index.md"), "utf8");
    assert.equal(sourceIndex.includes("电压偏差"), false, "源库索引不再列出已移出文档");
    const targetIndex = await readFile(join(env.targetDir, "index.md"), "utf8");
    assert.match(targetIndex, /电压偏差/);

    assert.deepEqual(await journalsIn(env.kbRoot), []);
    assert.deepEqual(await stagingIn(env.targetDir), []);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("conflicts are skipped by default and leave both libraries untouched", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.sourceDir, { id: "same", title: "同 id" });
    await addDoc(env.targetDir, { id: "same", title: "目标同 id" });
    await addDoc(env.sourceDir, { id: "hash", title: "同内容", sourceHash: "hh" });
    await addDoc(env.targetDir, { id: "t-hash", title: "目标同内容", sourceHash: "hh" });
    await addDoc(env.sourceDir, { id: "title", title: "同名标题" });
    await addDoc(env.targetDir, { id: "t-title", title: "同名标题" });

    const before = (await docsOf(env.targetDir)).length;
    const result = await move(env, ["same", "hash", "title"]);
    assert.equal(result.moved, 0);
    assert.equal(result.skipped, 3);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.results.map((row) => row.status), ["skipped", "skipped", "skipped"]);
    assert.deepEqual(
      result.results.map((row) => row.conflict?.kind),
      ["id", "hash", "title"]
    );

    assert.equal((await docsOf(env.targetDir)).length, before, "目标清单不变");
    for (const id of ["same", "hash", "title"]) {
      const sourceDoc = await docOf(env.sourceDir, id);
      assert.equal(sourceDoc.status, "ready", `${id} 保持就绪`);
      assert.equal(sourceDoc.movedTo, undefined);
    }
    assert.deepEqual(await journalsIn(env.kbRoot), []);
    assert.deepEqual(await stagingIn(env.targetDir), []);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("rename resolves title and id conflicts while keeping content", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.targetDir, { id: "dup", title: "同名标题" });
    await addDoc(env.sourceDir, { id: "s2", title: "同名标题" });
    await addDoc(env.sourceDir, { id: "dup", title: "另一个标题" });
    await addDoc(env.sourceDir, { id: "s3", title: "同名标题" });

    const result = await move(env, ["s2", "dup", "s3"], { onConflict: "rename" });
    assert.equal(result.moved, 3);
    assert.deepEqual(result.results.map((row) => row.newTitle), [
      "同名标题（副本）",
      "另一个标题",
      "同名标题（副本 2）",
    ]);
    assert.equal(result.results[0].newId, "s2", "标题冲突不换 docId");
    assert.notEqual(result.results[1].newId, "dup", "id 冲突换新 id");
    assert.match(result.results[1].newId, /^[0-9a-f]{12}$/);
    assert.equal(result.results[2].newId, "s3");

    const targetDocs = await docsOf(env.targetDir);
    assert.equal(targetDocs.length, 4);
    assert.equal(targetDocs.filter((doc) => doc.title === "同名标题（副本）").length, 1);
    assert.equal(targetDocs.filter((doc) => doc.title === "同名标题（副本 2）").length, 1);
    const fresh = targetDocs.find((doc) => doc.id === result.results[1].newId);
    assert.ok(fresh);
    assert.equal(fresh.title, "另一个标题");
    assert.deepEqual(
      { kb: fresh.movedFrom.kb, docId: fresh.movedFrom.docId },
      { kb: SRC, docId: "dup" }
    );
    assert.equal(await stat(join(env.targetDir, "sources", fresh.sourceFile)).then((info) => info.size), 16);
    const freshMerged = await readFile(join(env.targetDir, "markdown", fresh.id, `${fresh.id}.md`), "utf8");
    assert.match(freshMerged, /^# 另一个标题/, "新 id 的合并版文件名/首行标题正确");
    assert.match(freshMerged, /正文 dup/);
    const renamedMerged = await readFile(join(env.targetDir, "markdown", "s2", "s2.md"), "utf8");
    assert.match(renamedMerged, /^# 同名标题（副本）/, "改名后合并版 H1 同步");

    for (const id of ["s2", "dup", "s3"]) {
      assert.equal((await docOf(env.sourceDir, id)).status, "deleted");
    }
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("batch continues after a per-doc failure and reports it safely", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.sourceDir, { id: "good1", title: "正常一" });
    await addDoc(env.sourceDir, { id: "bad1", title: "缺正文", markdown: false });
    await addDoc(env.sourceDir, { id: "good2", title: "正常二" });

    const result = await move(env, ["good1", "bad1", "good2"]);
    assert.equal(result.moved, 2);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.results.map((row) => row.status), ["moved", "failed", "moved"]);
    assert.match(result.results[1].error, /正文文件不存在/);
    assert.equal(result.results[1].error.includes(env.root), false, "错误信息不带绝对路径");

    assert.equal((await docOf(env.sourceDir, "good1")).status, "deleted");
    assert.equal((await docOf(env.sourceDir, "good2")).status, "deleted");
    const bad = await docOf(env.sourceDir, "bad1");
    assert.equal(bad.status, "ready");
    assert.equal(bad.movedTo, undefined);
    assert.equal((await docsOf(env.targetDir)).length, 2);
    assert.deepEqual(await journalsIn(env.kbRoot), []);
    assert.deepEqual(await stagingIn(env.targetDir), []);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("batch caps are enforced before any document is touched", async () => {
  const env = await makeEnv();
  try {
    const ids = [];
    for (let i = 0; i < 51; i += 1) {
      const id = `m${String(i).padStart(2, "0")}`;
      ids.push(id);
      await addDoc(env.sourceDir, { id, sourceBytes: 8 });
    }
    await expectCode(move(env, ids), "TRANSFER_TOO_MANY");
    assert.equal((await docsOf(env.targetDir)).length, 0);
    assert.equal((await docOf(env.sourceDir, "m00")).status, "ready");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("undo restores the source and soft-deletes the target copy, keeping both file sets", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.sourceDir, { id: "d1", title: "可撤销" });
    const moved = await move(env, ["d1"]);
    assert.equal(moved.moved, 1);

    const result = await undoMove({
      kbRoot: env.kbRoot,
      sourceKb: SRC,
      targetKb: TGT,
      sourceDocId: "d1",
    });
    assert.equal(result.source.status, "ready");
    assert.equal(result.source.deletedAt, undefined);
    assert.equal(result.source.deletedFromStatus, undefined);
    assert.equal(result.source.movedTo, undefined);
    assert.equal(result.target.status, "deleted");
    assert.equal(result.target.deletedFromStatus, "ready");
    assert.equal(result.target.movedFromUndo, true);
    assert.equal(existsSync(join(env.sourceDir, "sources", "d1.pdf")), true);
    assert.equal(existsSync(join(env.sourceDir, "markdown", "d1", "d1.md")), true);
    assert.equal(existsSync(join(env.targetDir, "sources", "d1.pdf")), true);
    assert.equal(existsSync(join(env.targetDir, "markdown", "d1", "d1.md")), true);
    assert.match(await readFile(join(env.sourceDir, "log.md"), "utf8"), /撤销跨库移动/);
    assert.match(await readFile(join(env.targetDir, "log.md"), "utf8"), /撤销跨库移动/);

    // 源文档已恢复：再撤销一次应拒绝。
    await expectCode(
      undoMove({ kbRoot: env.kbRoot, sourceKb: SRC, targetKb: TGT, sourceDocId: "d1" }),
      "TRANSFER_UNDO_UNAVAILABLE"
    );
    // 未移动过的文档也不能撤销。
    await addDoc(env.sourceDir, { id: "plain", title: "没移动过" });
    await expectCode(
      undoMove({ kbRoot: env.kbRoot, sourceKb: SRC, targetKb: TGT, sourceDocId: "plain" }),
      "TRANSFER_UNDO_UNAVAILABLE"
    );
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("undo accepts a target that started at a source version above 1", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.sourceDir, { id: "v3", title: "第三个版本", extra: { version: 3 } });
    const moved = await move(env, ["v3"]);
    assert.equal(moved.moved, 1);

    const targetDoc = await docOf(env.targetDir, "v3");
    assert.equal(targetDoc.version, 3);
    assert.equal(targetDoc.movedFrom.version, 3);

    const result = await undoMove({ kbRoot: env.kbRoot, sourceKb: SRC, targetKb: TGT, sourceDocId: "v3" });
    assert.equal(result.source.status, "ready");
    assert.equal(result.target.status, "deleted");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("undo refuses when the target copy was edited after the move", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.sourceDir, { id: "d1", title: "目标被修订" });
    await addDoc(env.sourceDir, { id: "d2", title: "目标版本变了" });
    await move(env, ["d1", "d2"]);

    // kb_edit 的写法：真的改正文并递增版本（edited=true）。
    await writeFile(
      join(env.targetDir, "markdown", "d1", "d1.md"),
      "# 目标被修订\n\n目标库里的新正文\n",
      "utf8"
    );
    await touchDoc(env.targetDir, "d1", { edited: true });
    const edited = await docOf(env.targetDir, "d1");
    assert.equal(edited.edited, true);
    assert.equal(edited.version, 2);

    await assert.rejects(
      undoMove({ kbRoot: env.kbRoot, sourceKb: SRC, targetKb: TGT, sourceDocId: "d1" }),
      (error) => {
        assert.equal(error?.code, "TRANSFER_UNDO_UNAVAILABLE");
        assert.match(error.message, /目标副本已被修改，无法撤销移动/);
        return true;
      }
    );
    // 源文档保持已删除，目标副本与两边文件都还在。
    assert.equal((await docOf(env.sourceDir, "d1")).status, "deleted");
    assert.equal(existsSync(join(env.targetDir, "markdown", "d1", "d1.md")), true);
    assert.match(await readFile(join(env.targetDir, "markdown", "d1", "d1.md"), "utf8"), /目标库里的新正文/);

    // 只递增 version（如描述/元数据修订）同样拒绝：目标条目必须仍是移动时的版本。
    await touchDoc(env.targetDir, "d2", { chars: 999 });
    const bumped = await docOf(env.targetDir, "d2");
    assert.notEqual(bumped.edited, true);
    assert.equal(bumped.version, 2);
    await assert.rejects(
      undoMove({ kbRoot: env.kbRoot, sourceKb: SRC, targetKb: TGT, sourceDocId: "d2" }),
      (error) => {
        assert.equal(error?.code, "TRANSFER_UNDO_UNAVAILABLE");
        assert.match(error.message, /目标副本已被修改，无法撤销移动/);
        return true;
      }
    );
    assert.equal((await docOf(env.sourceDir, "d2")).status, "deleted");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("undo refuses when the target copy is not ready or already deleted", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.sourceDir, { id: "d1", title: "目标被改动" });
    await move(env, ["d1"]);

    const manifest = await readManifest(env.targetDir);
    const index = manifest.docs.findIndex((doc) => doc.id === "d1");
    manifest.docs[index] = { ...manifest.docs[index], status: "failed", error: "手工改坏" };
    await writeManifestAtomic(env.targetDir, manifest);
    await expectCode(
      undoMove({ kbRoot: env.kbRoot, sourceKb: SRC, targetKb: TGT, sourceDocId: "d1" }),
      "TRANSFER_UNDO_UNAVAILABLE"
    );

    manifest.docs[index] = { ...manifest.docs[index], status: "deleted", deletedAt: new Date().toISOString() };
    await writeManifestAtomic(env.targetDir, manifest);
    await expectCode(
      undoMove({ kbRoot: env.kbRoot, sourceKb: SRC, targetKb: TGT, sourceDocId: "d1" }),
      "TRANSFER_UNDO_UNAVAILABLE"
    );
    // 源文档保持已删除状态，用户仍可手工恢复。
    const sourceDoc = await docOf(env.sourceDir, "d1");
    assert.equal(sourceDoc.status, "deleted");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("commit-time skip cleanup keeps a pre-existing target doc's files", async () => {
  const env = await makeEnv();
  try {
    const existing = await addDoc(env.targetDir, {
      id: "dup",
      title: "目标库已有",
      sourceBytes: 24,
      markdown: true,
    });
    const targetSource = join(env.targetDir, "sources", "dup.pdf");
    const targetMarkdown = join(env.targetDir, "markdown", "dup", "dup.md");
    const sourceBytes = await readFile(targetSource);
    const markdownBefore = await readFile(targetMarkdown, "utf8");

    // 模拟：源文档 id 与目标既有文档相同，commit 阶段才判出 id 冲突并走 skip。
    const transferId = "aaaaaaaaaaaaaaaa";
    const journal = {
      version: 1,
      transferId,
      sourceKb: SRC,
      targetKb: TGT,
      docId: "dup",
      sourceTitle: "同名来源",
      newId: "dup",
      title: "同名来源",
      sourceFile: "dup.pdf",
      newSourceName: "dup.pdf",
      ext: ".pdf",
      stage: "staged",
      // commit 前（尚未 mount）失败：目标路径属于既有文档，绝不能删。
      mounted: false,
      files: {
        stagedSource: `.transfer/${transferId}/sources/dup.pdf`,
        stagedMarkdown: `.transfer/${transferId}/markdown/dup`,
        targetSource: "sources/dup.pdf",
        targetMarkdown: "markdown/dup",
      },
      at: "2026-01-01T00:00:00.000Z",
    };
    await writeJournalFile(env.kbRoot, journal);
    await mkdir(join(env.targetDir, ".transfer", transferId, "sources"), { recursive: true });
    await writeFile(join(env.targetDir, ".transfer", transferId, "sources", "dup.pdf"), "staged");

    await discardAttempt(env.kbRoot, env.targetDir, journal);
    assert.deepEqual(await readFile(targetSource), sourceBytes, "既有原件未被删除");
    assert.equal(await readFile(targetMarkdown, "utf8"), markdownBefore, "既有正文未被删除");
    assert.equal((await docOf(env.targetDir, "dup")).id, existing.id);
    assert.deepEqual(await journalsIn(env.kbRoot), []);
    assert.deepEqual(await stagingIn(env.targetDir), []);

    // mounted=false 表示文件尚未落位：即使目标清单暂时没有该 id，目标路径上的既有文件也不归本次移动。
    const unownedId = "keepme001";
    const unownedSource = join(env.targetDir, "sources", `${unownedId}.pdf`);
    const unownedMarkdown = join(env.targetDir, "markdown", unownedId, `${unownedId}.md`);
    await writeFile(unownedSource, "pre-existing", "utf8");
    await mkdir(join(env.targetDir, "markdown", unownedId), { recursive: true });
    await writeFile(unownedMarkdown, "# pre-existing", "utf8");
    const unmountedTransferId = "dddddddddddddd01";
    const unmountedJournal = {
      ...journal,
      transferId: unmountedTransferId,
      newId: unownedId,
      newSourceName: `${unownedId}.pdf`,
      mounted: false,
      files: {
        stagedSource: `.transfer/${unmountedTransferId}/sources/${unownedId}.pdf`,
        stagedMarkdown: `.transfer/${unmountedTransferId}/markdown/${unownedId}`,
        targetSource: `sources/${unownedId}.pdf`,
        targetMarkdown: `markdown/${unownedId}`,
      },
    };
    await writeJournalFile(env.kbRoot, unmountedJournal);
    await discardAttempt(env.kbRoot, env.targetDir, unmountedJournal);
    assert.equal(await readFile(unownedSource, "utf8"), "pre-existing", "未落位文件不能被删除");
    assert.equal(await readFile(unownedMarkdown, "utf8"), "# pre-existing", "未落位正文不能被删除");
    assert.deepEqual(await journalsIn(env.kbRoot), []);

    // 即使 journal 误标 mounted，目标清单已有同 id 文档时也必须保留。
    const mountedJournal = { ...journal, transferId: "bbbbbbbbbbbbbbbb", mounted: true };
    await writeJournalFile(env.kbRoot, mountedJournal);
    await discardAttempt(env.kbRoot, env.targetDir, mountedJournal);
    assert.deepEqual(await readFile(targetSource), sourceBytes, "冲突文档的文件仍未被删除");
    assert.equal((await docOf(env.targetDir, "dup")).id, existing.id);
    assert.deepEqual(await journalsIn(env.kbRoot), []);

    // sweep 同样要保留（没有 mounted 标记的旧 journal 也走同一条冲突复核）。
    const sweepJournal = { ...journal, transferId: "cccccccccccccccc", mounted: false };
    await writeJournalFile(env.kbRoot, sweepJournal);
    await sweepTransfers(env.kbRoot);
    assert.deepEqual(await readFile(targetSource), sourceBytes);
    assert.equal(await readFile(targetMarkdown, "utf8"), markdownBefore);
    assert.deepEqual(await journalsIn(env.kbRoot), []);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("discardAttempt removes target files only for its own mounted copies", async () => {
  const env = await makeEnv();
  try {
    const transferId = "dddddddddddddddd";
    const journal = {
      version: 1,
      transferId,
      sourceKb: SRC,
      targetKb: TGT,
      docId: "s1",
      sourceTitle: "自己的副本",
      newId: "fresh001",
      title: "自己的副本",
      sourceFile: "s1.pdf",
      newSourceName: "fresh001.pdf",
      ext: ".pdf",
      stage: "staged",
      mounted: true,
      files: {
        stagedSource: `.transfer/${transferId}/sources/fresh001.pdf`,
        stagedMarkdown: `.transfer/${transferId}/markdown/fresh001`,
        targetSource: "sources/fresh001.pdf",
        targetMarkdown: "markdown/fresh001",
      },
      at: "2026-01-01T00:00:00.000Z",
    };
    await writeJournalFile(env.kbRoot, journal);
    await mkdir(join(env.targetDir, "sources"), { recursive: true });
    await writeFile(join(env.targetDir, "sources", "fresh001.pdf"), "mounted");
    await mkdir(join(env.targetDir, "markdown", "fresh001"), { recursive: true });
    await writeFile(join(env.targetDir, "markdown", "fresh001", "fresh001.md"), "# mounted");

    await discardAttempt(env.kbRoot, env.targetDir, journal);
    assert.equal(existsSync(join(env.targetDir, "sources", "fresh001.pdf")), false);
    assert.equal(existsSync(join(env.targetDir, "markdown", "fresh001")), false);
    assert.deepEqual(await journalsIn(env.kbRoot), []);
    assert.deepEqual(await stagingIn(env.targetDir), []);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("sweep removes orphan staging/files when the target manifest was never committed", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.sourceDir, { id: "s1", title: "待恢复" });
    const transferId = "feedface00112233";
    const newId = "orphan001";
    const journal = {
      version: 1,
      transferId,
      sourceKb: SRC,
      targetKb: TGT,
      docId: "s1",
      sourceTitle: "待恢复",
      newId,
      title: "待恢复",
      sourceFile: "s1.pdf",
      newSourceName: `${newId}.pdf`,
      ext: ".pdf",
      stage: "staged",
      files: {
        stagedSource: `.transfer/${transferId}/sources/${newId}.pdf`,
        stagedMarkdown: `.transfer/${transferId}/markdown/${newId}`,
        targetSource: `sources/${newId}.pdf`,
        targetMarkdown: `markdown/${newId}`,
      },
      at: "2026-01-01T00:00:00.000Z",
    };
    await writeJournalFile(env.kbRoot, journal);
    await mkdir(join(env.targetDir, ".transfer", transferId, "sources"), { recursive: true });
    await writeFile(join(env.targetDir, ".transfer", transferId, "sources", `${newId}.pdf`), "staged");
    await mkdir(join(env.targetDir, ".transfer", transferId, "markdown", newId), { recursive: true });
    await writeFile(join(env.targetDir, ".transfer", transferId, "markdown", newId, `${newId}.md`), "# staged");
    // 模拟崩溃在“文件已移入目标、清单还没写”之间。
    await mkdir(join(env.targetDir, "sources"), { recursive: true });
    await writeFile(join(env.targetDir, "sources", `${newId}.pdf`), "mounted");
    await mkdir(join(env.targetDir, "markdown", newId), { recursive: true });
    await writeFile(join(env.targetDir, "markdown", newId, `${newId}.md`), "# mounted");

    const summary = await sweepTransfers(env.kbRoot);
    assert.equal(summary.scanned, 1);
    assert.equal(summary.cleaned, 1);
    assert.equal(summary.repaired, 0);
    assert.deepEqual(await journalsIn(env.kbRoot), []);
    assert.deepEqual(await stagingIn(env.targetDir), []);
    assert.equal(existsSync(join(env.targetDir, "sources", `${newId}.pdf`)), false);
    assert.equal(existsSync(join(env.targetDir, "markdown", newId)), false);
    assert.equal((await docOf(env.sourceDir, "s1")).status, "ready");
    assert.equal((await docsOf(env.targetDir)).length, 0);

    // sweep 是幂等的：没有 journal 时不再报修复。
    assert.deepEqual(await sweepTransfers(env.kbRoot), {
      scanned: 0,
      repaired: 0,
      cleaned: 0,
      removed: 0,
    });
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("preflight sweeps stale journals before checking conflicts", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.sourceDir, { id: "s1", title: "预检前清理" });
    const transferId = "0badc0de00112233";
    await writeJournalFile(env.kbRoot, {
      transferId,
      sourceKb: SRC,
      targetKb: TGT,
      docId: "s1",
      newId: "stale001",
      stage: "staging",
      files: {
        stagedSource: `.transfer/${transferId}/sources/stale001.pdf`,
        stagedMarkdown: `.transfer/${transferId}/markdown/stale001`,
        targetSource: "sources/stale001.pdf",
        targetMarkdown: "markdown/stale001",
      },
    });
    await mkdir(join(env.targetDir, ".transfer", transferId, "sources"), { recursive: true });

    const result = await preflight(env, ["s1"]);
    assert.equal(result.docs[0].conflict, null);
    assert.deepEqual(await journalsIn(env.kbRoot), []);
    assert.deepEqual(await stagingIn(env.targetDir), []);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("sweep and discard ignore journal paths outside sources/ and markdown/", async () => {
  const env = await makeEnv();
  try {
    await mkdir(join(env.targetDir, "markdownish"), { recursive: true });
    await writeFile(join(env.targetDir, "markdownish", "keep.txt"), "keep", "utf8");
    await mkdir(join(env.targetDir, "markdown"), { recursive: true });
    await writeFile(join(env.targetDir, "markdown", "keep.txt"), "keep", "utf8");
    const manifestBefore = await readFile(join(env.targetDir, "kb.json"), "utf8");

    const transferId = "eeeeeeeeeeeeeeee";
    const unsafeJournal = {
      version: 1,
      transferId,
      sourceKb: SRC,
      targetKb: TGT,
      docId: "s1",
      sourceTitle: "越界路径",
      newId: "evil001",
      title: "越界路径",
      stage: "staged",
      mounted: false,
      files: {
        stagedSource: `.transfer/${transferId}/sources/evil001.pdf`,
        stagedMarkdown: `.transfer/${transferId}/markdown/evil001`,
        // 伪造 journal：指向库清单与普通目录，sweep 不得删除。
        targetSource: "kb.json",
        targetMarkdown: "markdownish",
      },
      at: "2026-01-01T00:00:00.000Z",
    };
    await writeJournalFile(env.kbRoot, unsafeJournal);
    await sweepTransfers(env.kbRoot);
    assert.equal(await readFile(join(env.targetDir, "kb.json"), "utf8"), manifestBefore);
    assert.equal(existsSync(join(env.targetDir, "markdownish", "keep.txt")), true);
    assert.deepEqual(await journalsIn(env.kbRoot), []);

    // discardAttempt 的 mounted 清理同样只能碰 sources/ 与 markdown/。
    const discardJournal = {
      ...unsafeJournal,
      transferId: "ffffffffffffffff",
      mounted: true,
      files: {
        ...unsafeJournal.files,
        targetSource: "kb.json",
        targetMarkdown: "markdown",
      },
    };
    await writeJournalFile(env.kbRoot, discardJournal);
    await discardAttempt(env.kbRoot, env.targetDir, discardJournal);
    assert.equal(await readFile(join(env.targetDir, "kb.json"), "utf8"), manifestBefore);
    assert.equal(await readFile(join(env.targetDir, "markdown", "keep.txt"), "utf8"), "keep");
    assert.deepEqual(await journalsIn(env.kbRoot), []);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("sweep ignores journals with unsafe transfer ids", async () => {
  const env = await makeEnv();
  try {
    const dir = join(env.kbRoot, ".transfers");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "unsafe.json");
    await writeFile(file, JSON.stringify({
      transferId: "../../escape",
      sourceKb: SRC,
      targetKb: TGT,
      docId: "s1",
      newId: "x",
      files: { targetSource: "../../escape.pdf", targetMarkdown: "../../escape" },
    }), "utf8");
    const summary = await sweepTransfers(env.kbRoot);
    assert.equal(summary.scanned, 1);
    assert.equal(summary.removed, 0);
    assert.equal(existsSync(file), true, "可疑 journal 留给人工排查");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("sweep completes a crash after the target commit but before the source delete", async () => {
  const env = await makeEnv();
  try {
    await addDoc(env.sourceDir, { id: "s1", title: "崩溃补齐" });
    const transferId = "c0ffee0011223344";
    await addDoc(env.targetDir, {
      id: "moved001",
      title: "崩溃补齐",
      extra: {
        transferId,
        movedFrom: { kb: SRC, docId: "s1", at: "2026-01-01T00:00:00.000Z" },
      },
    });
    await writeJournalFile(env.kbRoot, {
      version: 1,
      transferId,
      sourceKb: SRC,
      targetKb: TGT,
      docId: "s1",
      sourceTitle: "崩溃补齐",
      newId: "moved001",
      title: "崩溃补齐",
      sourceFile: "s1.pdf",
      newSourceName: "moved001.pdf",
      stage: "target-done",
      files: {
        stagedSource: `.transfer/${transferId}/sources/moved001.pdf`,
        stagedMarkdown: `.transfer/${transferId}/markdown/moved001`,
        targetSource: "sources/moved001.pdf",
        targetMarkdown: "markdown/moved001",
      },
      at: "2026-01-01T00:00:00.000Z",
    });
    await mkdir(join(env.targetDir, ".transfer", transferId, "sources"), { recursive: true });

    const summary = await sweepTransfers(env.kbRoot);
    assert.equal(summary.scanned, 1);
    assert.equal(summary.repaired, 1);
    assert.equal(summary.cleaned, 1);
    assert.equal(summary.removed, 1);

    const sourceDoc = await docOf(env.sourceDir, "s1");
    assert.equal(sourceDoc.status, "deleted");
    assert.equal(sourceDoc.deletedFromStatus, "ready");
    assert.equal(sourceDoc.movedTo.kb, TGT);
    assert.equal(sourceDoc.movedTo.docId, "moved001");
    assert.equal(sourceDoc.movedTo.transferId, transferId);
    assert.equal(existsSync(join(env.sourceDir, "sources", "s1.pdf")), true);
    assert.match(await readFile(join(env.sourceDir, "log.md"), "utf8"), /崩溃恢复/);
    assert.deepEqual(await journalsIn(env.kbRoot), []);
    assert.deepEqual(await stagingIn(env.targetDir), []);

    // 幂等：再跑一次不重复修复/写日志。
    const again = await sweepTransfers(env.kbRoot);
    assert.equal(again.repaired, 0);
    assert.equal(again.scanned, 0);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});
