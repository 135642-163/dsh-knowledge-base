/**
 * 0.25.0 复审修复：回收站删除的锁内复验与“重新导入的已删除资料”状态。
 *  - removeDoc(requireDeleted:true) 在清单锁内复验，预检后被恢复的条目拒绝删除；
 *  - sweepTrash / 本库 purge / 跨库 purge 都传 requireDeleted，并显式跳过 importing；
 *  - markImporting 清掉 deletedAt/deletedFromStatus，导入完成后仍是普通 ready；
 *  - sweepTrash 单轮 500 上限与 deletedAt 的 ISO 日期时间前缀校验。
 * 全部使用临时目录，不依赖本机知识库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi, sweepTrash } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import {
  commitDoc,
  isDeleted,
  markImporting,
  readManifest,
  removeDoc,
  restoreDoc,
  TRASH_REVALIDATION_MESSAGE,
  writeManifestAtomic,
} from "../lib/store.js";

const NOW = Date.parse("2026-10-25T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function isoDaysAgo(days) {
  return new Date(NOW - days * DAY).toISOString();
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/trash/docs", headers = {}, body } = {}) {
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:55929",
      origin: "http://127.0.0.1:55929",
      "x-kb-ui": "1",
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

async function tempRoot() {
  return join(await mkdtemp(join(tmpdir(), "kb-trash-revalidate-")), "kb");
}

function doc(id, title, patch = {}) {
  return { id, title, type: "pdf-text", status: "ready", chars: 10, parts: 1, version: 1, ...patch };
}

function deletedDoc(id, title, deletedAt, patch = {}) {
  return doc(id, title, {
    status: "deleted",
    deletedFromStatus: "ready",
    deletedAt,
    ...patch,
  });
}

async function setupKb(kbRoot, name, docs = []) {
  const { dir } = await createKb(kbRoot, { name });
  if (docs.length > 0) {
    const manifest = await readManifest(dir);
    manifest.docs.push(...docs);
    await writeManifestAtomic(dir, manifest);
  }
  return dir;
}

async function docOf(dir, id) {
  const manifest = await readManifest(dir);
  return (manifest.docs ?? []).find((item) => item.id === id) ?? null;
}

async function materialize(dir, id) {
  await mkdir(join(dir, "markdown", id), { recursive: true });
  await writeFile(join(dir, "markdown", id, `${id}.md`), `# ${id}\n\n正文。\n`, "utf8");
}

/** 把清单里的条目改成“旧清单残留 deletedAt 的 importing 墓碑”。 */
async function forceImportingTombstone(dir, id, deletedAt) {
  const manifest = await readManifest(dir);
  const row = manifest.docs.find((item) => item.id === id);
  row.status = "importing";
  row.deletedAt = deletedAt;
  row.deletedFromStatus = "ready";
  await writeManifestAtomic(dir, manifest);
}

// ---------------------------------------------------------------------------
// store.removeDoc：锁内复验
// ---------------------------------------------------------------------------

test("removeDoc requireDeleted rejects a restored doc and keeps it", async () => {
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [deletedDoc("d1", "待删资料", isoDaysAgo(1))]);
  await materialize(dir, "d1");
  await restoreDoc(dir, "d1");

  await assert.rejects(
    () => removeDoc(dir, "d1", { requireDeleted: true }),
    new RegExp(TRASH_REVALIDATION_MESSAGE)
  );
  const row = await docOf(dir, "d1");
  assert.ok(row);
  assert.equal(row.status, "ready");
  assert.equal(isDeleted(row), false);
  assert.equal(existsSync(join(dir, "markdown", "d1")), true);
});

test("removeDoc keeps the default behavior for kb_remove(soft=false)", async () => {
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [doc("live", "在用资料")]);

  // 默认 requireDeleted=false：kb_remove(soft=false) 仍可删除在用资料。
  await removeDoc(dir, "live");
  assert.equal(await docOf(dir, "live"), null);
});

// ---------------------------------------------------------------------------
// 重新导入：markImporting 清回收站标记，导入完成回到 ready
// ---------------------------------------------------------------------------

test("markImporting clears deleted fields and import completion returns ready", async () => {
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [
    deletedDoc("d1", "重新导入的资料", isoDaysAgo(10), { deletedFromStatus: "failed" }),
  ]);
  await materialize(dir, "d1");

  assert.equal(await markImporting(dir, { id: "d1", title: "重新导入的资料", type: "text" }), true);
  const importing = await docOf(dir, "d1");
  assert.equal(importing.status, "importing");
  assert.equal(isDeleted(importing), false);
  assert.equal(importing.deletedAt, undefined);
  assert.equal(importing.deletedFromStatus, undefined);

  // 导入完成：commitDoc 写回 ready，回收站字段不应复活。
  const stagedDir = join(dir, "staged-d1");
  await mkdir(join(stagedDir, "parts"), { recursive: true });
  await writeFile(join(stagedDir, "parts", "0001.md"), "# 重新导入的资料\n\n新正文。\n", "utf8");
  await commitDoc(dir, {
    docId: "d1",
    stagedDir,
    title: "重新导入的资料",
    type: "text",
    pages: 1,
    chars: 8,
    parts: 1,
    outline: [],
    contentSource: "text",
  });
  const ready = await docOf(dir, "d1");
  assert.equal(ready.status, "ready");
  assert.equal(isDeleted(ready), false);
  assert.equal(ready.deletedAt, undefined);
  assert.equal(ready.deletedFromStatus, undefined);
  assert.equal(existsSync(join(dir, "markdown", "d1")), true);
});

test("sweep and purges explicitly skip importing tombstones with stale deletedAt", async () => {
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [deletedDoc("d1", "导入中的资料", isoDaysAgo(90))]);
  await materialize(dir, "d1");
  await forceImportingTombstone(dir, "d1", isoDaysAgo(90));

  // sweep：显式跳过 importing，不按过期删除，也不计入 skipped。
  const swept = await sweepTrash(kbRoot, { days: 30, now: NOW });
  assert.deepEqual(swept, { purged: 0, skipped: 0, capped: false, byKb: {} });
  assert.equal((await docOf(dir, "d1")).status, "importing");

  // 本库 purge(all)：导入中条目不在候选内。
  const purgeAll = await call({ kbRoot }, makeReq({
    method: "POST",
    url: "/kb/api/kbs/%E7%94%B2%E5%BA%93/docs/purge",
    body: { all: true, confirm: "甲库" },
  }));
  assert.equal(purgeAll.res.status, 409);
  assert.equal(purgeAll.json.error.code, "NO_DELETED_DOCS");
  assert.equal((await docOf(dir, "d1")).status, "importing");

  // 本库 purge(ids)：显式选导入中条目同样拒绝。
  const purgeIds = await call({ kbRoot }, makeReq({
    method: "POST",
    url: "/kb/api/kbs/%E7%94%B2%E5%BA%93/docs/purge",
    body: { ids: ["d1"], confirm: "甲库" },
  }));
  assert.equal(purgeIds.res.status, 409);
  assert.equal(purgeIds.json.error.code, "DOC_NOT_DELETED");

  // 跨库 purge：预检同样拒绝。
  const cross = await call({ kbRoot }, makeReq({
    method: "POST",
    url: "/kb/api/trash/docs/purge",
    body: { items: [{ kb: "甲库", id: "d1" }], confirm: "彻底删除 1 篇" },
  }));
  assert.equal(cross.res.status, 409);
  assert.equal(cross.json.error.code, "DOC_NOT_DELETED");
  assert.equal((await docOf(dir, "d1")).status, "importing");
});

// ---------------------------------------------------------------------------
// sweep：锁内复验、500 上限、ISO 前缀校验
// ---------------------------------------------------------------------------

test("sweep revalidates under the lock: a doc restored mid-run survives", async () => {
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [deletedDoc("d1", "刚被恢复", isoDaysAgo(90))]);
  await materialize(dir, "d1");

  const result = await sweepTrash(kbRoot, {
    days: 30,
    now: NOW,
    removeDocImpl: async (kbDir, docId, options) => {
      assert.equal(options?.requireDeleted, true);
      await restoreDoc(kbDir, docId);
      return removeDoc(kbDir, docId, options);
    },
  });
  // 复验失败按单篇跳过，不会把恢复后的资料删掉。
  assert.deepEqual(result, { purged: 0, skipped: 1, capped: false, byKb: {} });
  const row = await docOf(dir, "d1");
  assert.equal(row.status, "ready");
  assert.equal(existsSync(join(dir, "markdown", "d1")), true);
});

test("sweep caps one run at 500 removals and keeps byKb correct", async () => {
  const kbRoot = await tempRoot();
  const docs = Array.from({ length: 501 }, (_, index) =>
    deletedDoc(`d${index}`, `旧资料 ${index}`, isoDaysAgo(100)));
  const dir = await setupKb(kbRoot, "甲库", docs);

  const result = await sweepTrash(kbRoot, { days: 30, now: NOW });
  assert.deepEqual(result, { purged: 500, skipped: 0, capped: true, byKb: { 甲库: 500 } });
  const manifest = await readManifest(dir);
  assert.equal(manifest.docs.length, 1);
  assert.equal(manifest.docs[0].id, "d500");
});

test("sweep only trusts deletedAt with an ISO date-time prefix", async () => {
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [
    deletedDoc("dateOnly", "日期-only", "2026-08-01"),
    deletedDoc("numeric", "数字时间戳", NOW - 90 * DAY),
    deletedDoc("good", "合法 ISO", isoDaysAgo(90)),
  ]);

  const result = await sweepTrash(kbRoot, { days: 30, now: NOW });
  assert.deepEqual(result, { purged: 1, skipped: 2, capped: false, byKb: { 甲库: 1 } });
  assert.ok(await docOf(dir, "dateOnly"));
  assert.ok(await docOf(dir, "numeric"));
  assert.equal(await docOf(dir, "good"), null);
});

// ---------------------------------------------------------------------------
// 本库 / 跨库 purge：预检后被恢复的条目不能被删
// ---------------------------------------------------------------------------

test("per-kb purge continues when a target is restored before removeDoc", async () => {
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, "甲库", [
    deletedDoc("d1", "第一篇", isoDaysAgo(1)),
    deletedDoc("d2", "第二篇", isoDaysAgo(2)),
  ]);
  await materialize(dir, "d1");
  await materialize(dir, "d2");

  const result = await call({ kbRoot, removeDocImpl: async (kbDir, docId, options) => {
    if (docId === "d1") await restoreDoc(kbDir, docId);
    return removeDoc(kbDir, docId, options);
  } }, makeReq({
    method: "POST",
    url: "/kb/api/kbs/%E7%94%B2%E5%BA%93/docs/purge",
    body: { all: true, confirm: "甲库" },
  }));

  assert.equal(result.res.status, 200);
  assert.equal(result.json.purged, 1);
  assert.deepEqual(result.json.failed, [
    { id: "d1", title: "第一篇", error: "彻底删除失败：文档已不在回收站" },
  ]);
  const restored = await docOf(dir, "d1");
  assert.equal(restored.status, "ready");
  assert.equal(existsSync(join(dir, "markdown", "d1")), true);
  assert.equal(await docOf(dir, "d2"), null);
});

test("cross-kb purge does not delete a doc restored after prevalidation", async () => {
  const kbRoot = await tempRoot();
  const alpha = await setupKb(kbRoot, "甲库", [deletedDoc("a1", "甲一", isoDaysAgo(1))]);
  const beta = await setupKb(kbRoot, "乙库", [deletedDoc("b1", "乙一", isoDaysAgo(2))]);
  await materialize(alpha, "a1");
  await materialize(beta, "b1");

  const result = await call({ kbRoot, removeDocImpl: async (kbDir, docId, options) => {
    if (docId === "a1") await restoreDoc(kbDir, docId);
    return removeDoc(kbDir, docId, options);
  } }, makeReq({
    method: "POST",
    url: "/kb/api/trash/docs/purge",
    body: {
      items: [{ kb: "甲库", id: "a1" }, { kb: "乙库", id: "b1" }],
      confirm: "彻底删除 2 篇",
    },
  }));

  assert.equal(result.res.status, 200);
  assert.equal(result.json.purged, 1);
  assert.deepEqual(result.json.byKb, { 乙库: 1 });
  assert.deepEqual(result.json.failed, [
    { kb: "甲库", id: "a1", title: "甲一", error: "彻底删除失败：文档已不在回收站" },
  ]);
  const restored = await docOf(alpha, "a1");
  assert.equal(restored.status, "ready");
  assert.equal(existsSync(join(alpha, "markdown", "a1")), true);
  assert.equal(await docOf(beta, "b1"), null);
});
