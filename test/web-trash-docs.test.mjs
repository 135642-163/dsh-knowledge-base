/**
 * 0.24.0 数据治理（任务 1）：全局回收站列举与按库批量彻底删除。
 *  - GET  /kb/api/trash/docs：只扫在用（非归档、非合并）库里的软删除资料；
 *  - POST /kb/api/kbs/:name/docs/purge：confirm=库名，all 或 ids 二选一，只删回收站条目。
 * 全部走 handleApi，写请求带 x-kb-ui + 同源头，与工作台真实请求一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { archiveKb, createKb } from "../lib/kbmeta.js";
import { readManifest, removeDoc, writeManifestAtomic } from "../lib/store.js";

const KB = "标准";
const KB_URL = encodeURIComponent(KB);

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/status", headers = {}, body } = {}) {
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
  return join(await mkdtemp(join(tmpdir(), "kb-trash-docs-")), "kb");
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

/** 给一篇资料铺齐 markdown/历史/原件，用于验证彻底删除的清除范围。 */
async function materialize(dir, id) {
  await mkdir(join(dir, "markdown", id), { recursive: true });
  await writeFile(join(dir, "markdown", id, `${id}.md`), `# ${id}\n\n正文。\n`, "utf8");
  await mkdir(join(dir, "history", id, "v1"), { recursive: true });
  await writeFile(join(dir, "history", id, "v1", `${id}.md`), "# 历史版本\n", "utf8");
  await mkdir(join(dir, "sources"), { recursive: true });
  await writeFile(join(dir, "sources", `${id}.pdf`), "%PDF-1.4\n", "utf8");
}

function purgeUrl(name = KB) {
  return `/kb/api/kbs/${encodeURIComponent(name)}/docs/purge`;
}

function purge(kbRoot, body, { name = KB, opts = {}, headers } = {}) {
  return call({ kbRoot, ...opts }, makeReq({
    method: "POST",
    url: purgeUrl(name),
    body,
    ...(headers ? { headers } : {}),
  }));
}

// ---------------------------------------------------------------------------
// 全局回收站列举
// ---------------------------------------------------------------------------

test("GET /trash/docs lists deleted docs from live non-merged kbs only", async () => {
  const kbRoot = await tempRoot();
  const movedTo = { kb: "目标库", docId: "t1", transferId: "abc123", at: "2026-10-02T00:00:00.000Z" };
  await setupKb(kbRoot, "alpha", [
    deletedDoc("d-old", "旧资料", "2026-10-01T00:00:00.000Z", { sourceFile: "d-old.pdf" }),
    deletedDoc("d-new", "新笔记", "2026-10-03T00:00:00.000Z", {
      type: "note",
      deletedFromStatus: "failed",
      movedTo,
      error: "解析失败：文件损坏",
    }),
    // 旧清单可能只有 status=deleted 没有 deletedAt：仍算已删除，排序排最后。
    deletedDoc("d-bad", "无删除时间", ""),
    doc("d-live", "在用资料"),
  ]);
  await setupKb(kbRoot, "beta", [
    deletedDoc("b1", "乙库资料", "2026-10-02T00:00:00.000Z", { deletedFromStatus: "failed" }),
    doc("b-live", "乙库在用"),
  ]);
  const mergedDir = await setupKb(kbRoot, "merged-src", [
    deletedDoc("m1", "已合并资料", "2026-10-04T00:00:00.000Z"),
  ]);
  const merged = await readManifest(mergedDir);
  merged.mergedInto = "alpha";
  merged.mergedAt = "2026-10-05T00:00:00.000Z";
  await writeManifestAtomic(mergedDir, merged);
  const archivedDir = await setupKb(kbRoot, "archived", [
    deletedDoc("a1", "归档库资料", "2026-10-06T00:00:00.000Z"),
  ]);
  const trashedTo = await archiveKb(kbRoot, "archived");

  // 只读接口：不带 x-kb-ui 也应返回 200。
  const { res, json } = await call(
    { kbRoot },
    makeReq({ url: "/kb/api/trash/docs", headers: { "x-kb-ui": "" } })
  );
  assert.equal(res.status, 200);
  assert.equal(json.total, 4);
  assert.equal(json.truncated, false);
  // deletedAt 倒序；缺失/非法日期排最后。
  assert.deepEqual(json.items.map((item) => item.id), ["d-new", "b1", "d-old", "d-bad"]);
  const baseKeys = ["deleted", "deletedAt", "deletedFromStatus", "error", "id", "kb", "movedTo", "sourceFile", "title", "type"];
  for (const item of json.items) {
    assert.equal(item.deleted, true);
    // 移动行额外带目标副本状态；普通已删除资料保持原投影。
    assert.deepEqual(
      Object.keys(item).sort(),
      item.movedTo
        ? [...baseKeys, "movedToState", "canRestoreSource"].sort()
        : baseKeys
    );
  }
  const newest = json.items[0];
  assert.equal(newest.kb, "alpha");
  assert.equal(newest.title, "新笔记");
  assert.equal(newest.type, "note");
  assert.equal(newest.deletedAt, "2026-10-03T00:00:00.000Z");
  assert.equal(newest.deletedFromStatus, "failed");
  assert.deepEqual(newest.movedTo, movedTo);
  assert.equal(newest.movedToState, "missing");
  assert.equal(newest.canRestoreSource, true);
  assert.equal(newest.sourceFile, "");
  assert.equal(newest.error, "解析失败：文件损坏");

  const oldItem = json.items.find((item) => item.id === "d-old");
  assert.equal(oldItem.sourceFile, "d-old.pdf");
  assert.equal(oldItem.movedTo, null);
  assert.equal(oldItem.movedToState, undefined);
  assert.equal(oldItem.canRestoreSource, undefined);
  assert.equal(oldItem.deletedFromStatus, "ready");
  assert.equal(oldItem.error, "");
  const badItem = json.items.find((item) => item.id === "d-bad");
  assert.equal(badItem.deletedAt, "");
  const betaItem = json.items.find((item) => item.id === "b1");
  assert.equal(betaItem.kb, "beta");
  assert.equal(betaItem.deletedFromStatus, "failed");

  // 归档库、合并库、在用资料都不出现；归档目录仍在（列举绝不移动文件）。
  assert.equal(json.items.some((item) => item.id === "a1"), false);
  assert.equal(json.items.some((item) => item.id === "m1"), false);
  assert.equal(json.items.some((item) => item.id === "d-live" || item.id === "b-live"), false);
  assert.equal(existsSync(join(trashedTo, "kb.json")), true);
  const archivedManifest = JSON.parse(await readFile(join(trashedTo, "kb.json"), "utf8"));
  assert.equal(archivedManifest.docs.some((item) => item.id === "a1"), true);
  assert.equal(existsSync(join(archivedDir, "kb.json")), false);
  assert.equal(JSON.stringify(json).includes(kbRoot), false);
});

test("GET /trash/docs reports target state for live, deleted, missing, archived and merged targets", async () => {
  const kbRoot = await tempRoot();
  const { dir: targetDir } = await createKb(kbRoot, { name: "目标库" });
  const targetManifest = await readManifest(targetDir);
  targetManifest.docs.push(
    doc("t-live", "目标在用"),
    deletedDoc("t-deleted", "目标已删除", "2026-10-03T00:00:00.000Z")
  );
  await writeManifestAtomic(targetDir, targetManifest);

  const archivedTargetDir = await setupKb(kbRoot, "归档目标", [doc("a1", "归档目标资料")]);
  await archiveKb(kbRoot, "归档目标");
  const mergedTargetDir = await setupKb(kbRoot, "合并目标", [doc("m1", "合并目标资料")]);
  const merged = await readManifest(mergedTargetDir);
  merged.mergedInto = "目标库";
  merged.mergedAt = "2026-10-05T00:00:00.000Z";
  await writeManifestAtomic(mergedTargetDir, merged);

  const movedTo = (kb, docId) => ({ kb, docId, transferId: "abc123", at: "2026-10-02T00:00:00.000Z" });
  await setupKb(kbRoot, "alpha", [
    deletedDoc("mv-live", "目标在用", "2026-10-06T00:00:00.000Z", { movedTo: movedTo("目标库", "t-live") }),
    deletedDoc("mv-deleted", "目标已删除", "2026-10-05T00:00:00.000Z", { movedTo: movedTo("目标库", "t-deleted") }),
    deletedDoc("mv-missing", "目标副本不存在", "2026-10-04T00:00:00.000Z", { movedTo: movedTo("目标库", "t-gone") }),
    deletedDoc("mv-archived", "目标库已归档", "2026-10-03T00:00:00.000Z", { movedTo: movedTo("归档目标", "a1") }),
    deletedDoc("mv-merged", "目标库已合并", "2026-10-02T00:00:00.000Z", { movedTo: movedTo("合并目标", "m1") }),
    deletedDoc("plain", "普通删除", "2026-10-01T00:00:00.000Z")
  ]);

  const { res, json } = await call({ kbRoot }, makeReq({ url: "/kb/api/trash/docs" }));
  assert.equal(res.status, 200);
  const byId = new Map(json.items.map((item) => [item.id, item]));

  assert.equal(byId.get("mv-live").movedToState, "live");
  assert.equal(byId.get("mv-live").canRestoreSource, false);
  for (const [id, state] of [
    ["mv-deleted", "deleted"],
    ["mv-missing", "missing"],
    ["mv-archived", "missing"],
    ["mv-merged", "missing"],
  ]) {
    assert.equal(byId.get(id).movedToState, state, id);
    assert.equal(byId.get(id).canRestoreSource, true, id);
  }
  assert.equal(byId.get("plain").movedTo, null);
  assert.equal(byId.get("plain").movedToState, undefined);
  assert.equal(byId.get("plain").canRestoreSource, undefined);
  // 只读列举不会搬回归档库/改写目标清单。
  assert.equal(existsSync(join(archivedTargetDir, "kb.json")), false);
  assert.equal(existsSync(join(kbRoot, ".trash")), true);
  assert.equal(JSON.stringify(json).includes(kbRoot), false);
});

test("GET /trash/docs caps at 500 items and flags truncation", async () => {
  const kbRoot = await tempRoot();
  const docs = [];
  for (let i = 0; i < 500; i += 1) {
    docs.push(deletedDoc(
      `c${String(i).padStart(3, "0")}`,
      `资料${i}`,
      new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    ));
  }
  const dir = await setupKb(kbRoot, "cap", docs);

  const exact = await call({ kbRoot }, makeReq({ url: "/kb/api/trash/docs" }));
  assert.equal(exact.res.status, 200);
  assert.equal(exact.json.total, 500);
  assert.equal(exact.json.items.length, 500);
  assert.equal(exact.json.truncated, false);

  const manifest = await readManifest(dir);
  manifest.docs.push(deletedDoc("c500", "最新资料", "2026-01-01T00:20:00.000Z"));
  await writeManifestAtomic(dir, manifest);
  const over = await call({ kbRoot }, makeReq({ url: "/kb/api/trash/docs" }));
  assert.equal(over.res.status, 200);
  assert.equal(over.json.total, 501);
  assert.equal(over.json.items.length, 500);
  assert.equal(over.json.truncated, true);
  assert.equal(over.json.items[0].id, "c500");
  assert.equal(over.json.items.at(-1).id, "c001");
});

// ---------------------------------------------------------------------------
// 批量彻底删除
// ---------------------------------------------------------------------------

async function purgeSetup() {
  const kbRoot = await tempRoot();
  const dir = await setupKb(kbRoot, KB, [
    deletedDoc("pd1", "第一篇", "2026-10-01T00:00:00.000Z", { sourceFile: "pd1.pdf" }),
    deletedDoc("pd2", "第二篇", "2026-10-02T00:00:00.000Z", { deletedFromStatus: "failed" }),
    doc("pl1", "在用资料"),
  ]);
  await materialize(dir, "pd1");
  await materialize(dir, "pd2");
  await materialize(dir, "pl1");
  return { kbRoot, dir };
}

test("purge requires the kb name as confirmation", async () => {
  const { kbRoot, dir } = await purgeSetup();
  const bodies = [
    { ids: ["pd1"] },
    { ids: ["pd1"], confirm: "" },
    { ids: ["pd1"], confirm: "别的库" },
  ];
  for (const body of bodies) {
    const { res, json } = await purge(kbRoot, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(json.error.code, "CONFIRM_REQUIRED");
    assert.match(json.error.message, /彻底删除需要输入库名：标准/);
  }
  assert.ok(await docOf(dir, "pd1"));
  assert.ok(await docOf(dir, "pd2"));
});

test("purge rejects ambiguous all/ids arguments", async () => {
  const { kbRoot, dir } = await purgeSetup();
  const bodies = [
    { confirm: KB },
    { confirm: KB, ids: [] },
    { confirm: KB, ids: [], all: false },
    { confirm: KB, ids: ["pd1"], all: true },
    { confirm: KB, all: "yes", ids: [] },
  ];
  for (const body of bodies) {
    const { res, json } = await purge(kbRoot, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(json.error.code, "INVALID_ARGS");
  }
  assert.ok(await docOf(dir, "pd1"));
});

test("purge ids only accepts deleted docs of this kb", async () => {
  const { kbRoot, dir } = await purgeSetup();
  const otherDir = await setupKb(kbRoot, "别的库", [
    deletedDoc("x1", "别库资料", "2026-10-02T00:00:00.000Z"),
  ]);

  // 在用资料：即使列在 ids 里也拒绝，且这次请求不会删掉同批的已删资料。
  const live = await purge(kbRoot, { confirm: KB, ids: ["pd1", "pl1"] });
  assert.equal(live.res.status, 409);
  assert.equal(live.json.error.code, "DOC_NOT_DELETED");
  assert.match(live.json.error.message, /在用资料（pl1）/);
  assert.deepEqual(live.json.error.details, { id: "pl1", title: "在用资料" });
  assert.ok(await docOf(dir, "pd1"));
  assert.ok(await docOf(dir, "pl1"));
  assert.equal(existsSync(join(dir, "markdown", "pd1")), true);

  const missing = await purge(kbRoot, { confirm: KB, ids: ["nope"] });
  assert.equal(missing.res.status, 409);
  assert.equal(missing.json.error.code, "DOC_NOT_DELETED");

  // 跨库：别的库的已删资料不能从本库删掉。
  const cross = await purge(kbRoot, { confirm: KB, ids: ["x1"] });
  assert.equal(cross.res.status, 409);
  assert.equal(cross.json.error.code, "DOC_NOT_DELETED");
  assert.ok(await docOf(otherDir, "x1"));
});

test("purge ids removes artifacts, dedupes ids, logs and refreshes the index", async () => {
  const { kbRoot, dir } = await purgeSetup();

  const { res, json } = await purge(kbRoot, { confirm: `  ${KB}  `, ids: ["pd1", "pd1"] });
  assert.equal(res.status, 200);
  assert.deepEqual(json, { kb: KB, purged: 1, failed: [] });

  assert.equal(await docOf(dir, "pd1"), null);
  assert.equal(existsSync(join(dir, "markdown", "pd1")), false);
  assert.equal(existsSync(join(dir, "history", "pd1")), false);
  const sources = await readdir(join(dir, "sources"));
  assert.equal(sources.some((name) => name.startsWith("pd1")), false);
  // 只删选中的条目：其余已删/在用资料与产物不受影响。
  assert.equal((await docOf(dir, "pd2")).status, "deleted");
  assert.ok(await docOf(dir, "pl1"));
  assert.equal(existsSync(join(dir, "markdown", "pd2")), true);
  assert.equal(sources.includes("pd2.pdf"), true);

  const log = await readFile(join(dir, "log.md"), "utf8");
  assert.match(log, /remove\s+第一篇（pd1）\s+彻底删除/);
  assert.equal(log.includes("第二篇"), false);

  const index = await readFile(join(dir, "index.md"), "utf8");
  assert.match(index, /共 2 篇/);
  assert.equal(index.includes("第一篇"), false);
  assert.equal(JSON.stringify(json).includes(kbRoot), false);
});

test("purge all empties the recycle bin and reports an empty one", async () => {
  const { kbRoot, dir } = await purgeSetup();

  const first = await purge(kbRoot, { confirm: KB, all: true });
  assert.equal(first.res.status, 200);
  assert.deepEqual(first.json, { kb: KB, purged: 2, failed: [] });
  assert.equal(await docOf(dir, "pd1"), null);
  assert.equal(await docOf(dir, "pd2"), null);
  assert.ok(await docOf(dir, "pl1"));
  assert.equal(existsSync(join(dir, "markdown", "pl1")), true);
  const sources = await readdir(join(dir, "sources"));
  assert.deepEqual(sources, ["pl1.pdf"]);

  const again = await purge(kbRoot, { confirm: KB, all: true });
  assert.equal(again.res.status, 409);
  assert.equal(again.json.error.code, "NO_DELETED_DOCS");
  assert.equal(again.json.error.message, "没有已删除的资料");
  assert.ok(await docOf(dir, "pl1"));
});

test("purge reports partial failures without paths and keeps going", async () => {
  const { kbRoot, dir } = await purgeSetup();
  const attempted = [];
  const removeDocImpl = async (kbDir, docId) => {
    attempted.push(docId);
    if (docId === "pd2") {
      throw new Error(`EACCES: permission denied, rmdir '${join(kbDir, "markdown", docId)}'`);
    }
    return removeDoc(kbDir, docId);
  };

  const { res, json } = await purge(
    kbRoot,
    { confirm: KB, all: true },
    { opts: { removeDocImpl } }
  );
  assert.equal(res.status, 200);
  assert.equal(json.kb, KB);
  assert.equal(json.purged, 1);
  assert.deepEqual(json.failed, [{ id: "pd2", title: "第二篇", error: "彻底删除失败" }]);
  assert.deepEqual(attempted, ["pd1", "pd2"]);
  assert.equal(await docOf(dir, "pd1"), null);
  assert.equal((await docOf(dir, "pd2")).status, "deleted");
  assert.equal(existsSync(join(dir, "markdown", "pd2")), true);
  // 失败原因里的绝对路径不能跨 API 边界。
  assert.equal(JSON.stringify(json).includes(kbRoot), false);
  assert.equal(JSON.stringify(json).includes("EACCES"), false);

  const log = await readFile(join(dir, "log.md"), "utf8");
  assert.match(log, /remove\s+第一篇（pd1）\s+彻底删除/);
  assert.equal(log.includes("第二篇"), false);
  const index = await readFile(join(dir, "index.md"), "utf8");
  assert.match(index, /共 2 篇/);
});

test("purge rejects archived and traversing kb names, and wrong methods", async () => {
  const { kbRoot } = await purgeSetup();
  const archivedDir = await setupKb(kbRoot, "归档库", [
    deletedDoc("a1", "归档资料", "2026-10-02T00:00:00.000Z"),
  ]);
  const trashedTo = await archiveKb(kbRoot, "归档库");

  const archived = await purge(kbRoot, { confirm: "归档库", all: true }, { name: "归档库" });
  assert.equal(archived.res.status, 404);
  assert.equal(archived.json.error.code, "KB_NOT_FOUND");
  assert.equal(existsSync(join(trashedTo, "kb.json")), true);
  const archivedManifest = JSON.parse(await readFile(join(trashedTo, "kb.json"), "utf8"));
  assert.equal(archivedManifest.docs.some((item) => item.id === "a1"), true);
  assert.equal(existsSync(join(archivedDir, "kb.json")), false);

  for (const raw of ["../escape", "..\\escape", "..%2Fescape"]) {
    const { res, json } = await purge(kbRoot, { confirm: raw, all: true }, { name: raw });
    assert.equal(res.status, 404, raw);
    assert.equal(json.error.code, "KB_NOT_FOUND", raw);
  }

  const get = await call(
    { kbRoot },
    makeReq({ url: purgeUrl() })
  );
  assert.equal(get.res.status, 404);
  assert.ok(["NOT_FOUND", "DOC_NOT_FOUND"].includes(get.json.error.code));

  const postList = await call(
    { kbRoot },
    makeReq({ method: "POST", url: "/kb/api/trash/docs", body: { confirm: KB, all: true } })
  );
  assert.equal(postList.res.status, 404);
  assert.equal(postList.json.error.code, "NOT_FOUND");
});

test("purge and trash listing enforce UI header and same-origin on writes", async () => {
  const { kbRoot } = await purgeSetup();
  const body = { confirm: KB, all: true };

  const noHeader = await purge(kbRoot, body, { headers: { "x-kb-ui": "" } });
  assert.equal(noHeader.res.status, 403);
  assert.equal(noHeader.json.error.code, "FORBIDDEN");

  const crossOrigin = await purge(kbRoot, body, {
    headers: { origin: "http://evil.example", host: "127.0.0.1:55929" },
  });
  assert.equal(crossOrigin.res.status, 403);

  const crossSite = await purge(kbRoot, body, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.res.status, 403);

  // GET 列举不需要 UI 头（前面已覆盖 200）；fence 拒绝仍生效。
  const res = makeRes();
  await handleApi(
    makeReq({ url: "/kb/api/trash/docs", headers: { "x-kb-ui": "" } }),
    res,
    { opts: { kbRoot }, fence: () => false }
  );
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// 跨库批量彻底删除
// ---------------------------------------------------------------------------

const CROSS_PURGE_URL = "/kb/api/trash/docs/purge";

async function crossSetup() {
  const kbRoot = await tempRoot();
  const alpha = await setupKb(kbRoot, "甲库", [
    deletedDoc("a1", "甲一", "2026-10-01T00:00:00.000Z", { sourceFile: "a1.pdf" }),
    deletedDoc("a2", "甲二", "2026-10-02T00:00:00.000Z"),
    doc("a-live", "甲在用"),
  ]);
  const beta = await setupKb(kbRoot, "乙库", [
    deletedDoc("b1", "乙一", "2026-10-03T00:00:00.000Z", { sourceFile: "b1.pdf" }),
    deletedDoc("b2", "乙二", "2026-10-04T00:00:00.000Z"),
    doc("b-live", "乙在用"),
  ]);
  await materialize(alpha, "a1");
  await materialize(beta, "b1");
  return { kbRoot, alpha, beta };
}

function crossPurge(kbRoot, body, { opts = {}, headers } = {}) {
  return call({ kbRoot, ...opts }, makeReq({
    method: "POST",
    url: CROSS_PURGE_URL,
    body,
    ...(headers ? { headers } : {}),
  }));
}

test("cross-kb purge requires the exact 彻底删除 N 篇 phrase", async () => {
  const { kbRoot, alpha, beta } = await crossSetup();
  const item = { kb: "甲库", id: "a1" };
  const bodies = [
    { items: [item] },
    { items: [item], confirm: "" },
    // 旧版按库名确认不再适用。
    { items: [item], confirm: "甲库" },
    // 篇数不符（少一篇 / 多一篇 / 缺空格）。
    { items: [item], confirm: "彻底删除 0 篇" },
    { items: [item], confirm: "彻底删除 2 篇" },
    { items: [item], confirm: "彻底删除 1篇" },
  ];
  for (const body of bodies) {
    const { res, json } = await crossPurge(kbRoot, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(json.error.code, "CONFIRM_REQUIRED", JSON.stringify(body));
    assert.equal(json.error.message, "请输入「彻底删除 1 篇」以确认");
  }
  assert.ok(await docOf(alpha, "a1"));
  assert.ok(await docOf(beta, "b1"));
  assert.equal(existsSync(join(alpha, "markdown", "a1")), true);
});

test("cross-kb purge removes docs in multiple kbs, logs once each and refreshes indexes", async () => {
  const { kbRoot, alpha, beta } = await crossSetup();
  const { res, json } = await crossPurge(kbRoot, {
    items: [
      { kb: "甲库", id: "a1" },
      { kb: "乙库", id: "b1" },
    ],
    confirm: "彻底删除 2 篇",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(json, { purged: 2, failed: [], byKb: { 甲库: 1, 乙库: 1 } });

  assert.equal(await docOf(alpha, "a1"), null);
  assert.equal(await docOf(beta, "b1"), null);
  assert.equal(existsSync(join(alpha, "markdown", "a1")), false);
  assert.equal(existsSync(join(beta, "markdown", "b1")), false);
  // 未选中的同批条目（含在用资料）保持原状。
  assert.equal((await docOf(alpha, "a2")).status, "deleted");
  assert.ok(await docOf(alpha, "a-live"));
  assert.equal((await docOf(beta, "b2")).status, "deleted");
  assert.ok(await docOf(beta, "b-live"));

  const alphaLog = await readFile(join(alpha, "log.md"), "utf8");
  assert.match(alphaLog, /remove\s+甲一（a1）\s+彻底删除（跨库批量）/);
  assert.equal(alphaLog.includes("甲二"), false);
  const betaLog = await readFile(join(beta, "log.md"), "utf8");
  assert.match(betaLog, /remove\s+乙一（b1）\s+彻底删除（跨库批量）/);
  assert.equal(betaLog.includes("乙二"), false);

  const alphaIndex = await readFile(join(alpha, "index.md"), "utf8");
  assert.match(alphaIndex, /共 2 篇/);
  assert.equal(alphaIndex.includes("甲一"), false);
  const betaIndex = await readFile(join(beta, "index.md"), "utf8");
  assert.match(betaIndex, /共 2 篇/);
  assert.equal(JSON.stringify(json).includes(kbRoot), false);
});

test("cross-kb purge dedupes by kb+id but treats the same id in another kb as distinct", async () => {
  const kbRoot = await tempRoot();
  const alpha = await setupKb(kbRoot, "甲库", [
    deletedDoc("same", "甲同", "2026-10-01T00:00:00.000Z"),
  ]);
  const beta = await setupKb(kbRoot, "乙库", [
    deletedDoc("same", "乙同", "2026-10-01T00:00:00.000Z"),
  ]);

  const { res, json } = await crossPurge(kbRoot, {
    items: [
      { kb: "甲库", id: "same" },
      { kb: "甲库", id: "same" },
      { kb: "乙库", id: "same" },
    ],
    confirm: "彻底删除 2 篇",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(json, { purged: 2, failed: [], byKb: { 甲库: 1, 乙库: 1 } });
  assert.equal(await docOf(alpha, "same"), null);
  assert.equal(await docOf(beta, "same"), null);

  const alphaLog = await readFile(join(alpha, "log.md"), "utf8");
  assert.equal((alphaLog.match(/甲同（same）/g) ?? []).length, 1);
  const betaLog = await readFile(join(beta, "log.md"), "utf8");
  assert.equal((betaLog.match(/乙同（same）/g) ?? []).length, 1);
});

test("cross-kb purge prevalidates every item and deletes nothing on a live doc", async () => {
  const { kbRoot, alpha, beta } = await crossSetup();
  // 第一条合法、第二条是在用资料：整批拒绝，合法条目也不能被提前删掉。
  const { res, json } = await crossPurge(kbRoot, {
    items: [
      { kb: "甲库", id: "a1" },
      { kb: "乙库", id: "b-live" },
    ],
    confirm: "彻底删除 2 篇",
  });
  assert.equal(res.status, 409);
  assert.equal(json.error.code, "DOC_NOT_DELETED");
  assert.match(json.error.message, /乙在用/);
  assert.deepEqual(json.error.details, { kb: "乙库", id: "b-live", title: "乙在用" });
  assert.ok(await docOf(alpha, "a1"));
  assert.ok(await docOf(beta, "b-live"));
  assert.equal(existsSync(join(alpha, "markdown", "a1")), true);
  assert.equal(JSON.stringify(json).includes(kbRoot), false);
});

test("cross-kb purge rejects unknown and archived kbs without deleting anything", async () => {
  const { kbRoot, alpha } = await crossSetup();

  const unknown = await crossPurge(kbRoot, {
    items: [
      { kb: "甲库", id: "a1" },
      { kb: "查无此库", id: "z" },
    ],
    confirm: "彻底删除 2 篇",
  });
  assert.equal(unknown.res.status, 409);
  assert.equal(unknown.json.error.code, "KB_NOT_FOUND");
  assert.deepEqual(unknown.json.error.details, { kb: "查无此库", id: "z", title: "" });
  assert.ok(await docOf(alpha, "a1"));

  const archivedDir = await setupKb(kbRoot, "归档库", [
    deletedDoc("z1", "归档资料", "2026-10-02T00:00:00.000Z"),
  ]);
  const trashedTo = await archiveKb(kbRoot, "归档库");
  const archived = await crossPurge(kbRoot, {
    items: [{ kb: "归档库", id: "z1" }],
    confirm: "彻底删除 1 篇",
  });
  assert.equal(archived.res.status, 409);
  assert.equal(archived.json.error.code, "KB_NOT_FOUND");
  assert.equal(existsSync(join(archivedDir, "kb.json")), false);
  const archivedManifest = JSON.parse(await readFile(join(trashedTo, "kb.json"), "utf8"));
  assert.equal(archivedManifest.docs.some((item) => item.id === "z1"), true);
});

test("cross-kb purge rejects empty, malformed and oversized item lists", async () => {
  const { kbRoot, alpha } = await crossSetup();
  const bodies = [
    {},
    { items: [], confirm: "彻底删除 0 篇" },
    { items: "nope", confirm: "彻底删除 1 篇" },
    { items: [null], confirm: "彻底删除 1 篇" },
    { items: [{ kb: "甲库", id: "  " }], confirm: "彻底删除 1 篇" },
    { items: [{ kb: "", id: "a1" }], confirm: "彻底删除 1 篇" },
  ];
  for (const body of bodies) {
    const { res, json } = await crossPurge(kbRoot, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(json.error.code, "INVALID_ARGS", JSON.stringify(body));
  }

  const items = Array.from({ length: 501 }, (_, index) => ({ kb: "甲库", id: `n${index}` }));
  const over = await crossPurge(kbRoot, { items, confirm: "彻底删除 501 篇" });
  assert.equal(over.res.status, 400);
  assert.equal(over.json.error.code, "INVALID_ARGS");
  assert.ok(await docOf(alpha, "a1"));
});

test("cross-kb purge reports partial failures without paths and keeps going", async () => {
  const { kbRoot, alpha, beta } = await crossSetup();
  const attempted = [];
  const removeDocImpl = async (kbDir, docId) => {
    attempted.push(docId);
    if (docId === "b1") {
      throw new Error(`EACCES: permission denied, rmdir '${join(kbDir, "markdown", docId)}'`);
    }
    return removeDoc(kbDir, docId);
  };

  const { res, json } = await crossPurge(
    kbRoot,
    {
      items: [
        { kb: "甲库", id: "a1" },
        { kb: "乙库", id: "b1" },
      ],
      confirm: "彻底删除 2 篇",
    },
    { opts: { removeDocImpl } }
  );
  assert.equal(res.status, 200);
  assert.deepEqual(json, {
    purged: 1,
    failed: [{ kb: "乙库", id: "b1", title: "乙一", error: "彻底删除失败" }],
    byKb: { 甲库: 1 },
  });
  assert.deepEqual(attempted, ["a1", "b1"]);
  assert.equal(await docOf(alpha, "a1"), null);
  assert.equal((await docOf(beta, "b1")).status, "deleted");
  assert.equal(existsSync(join(beta, "markdown", "b1")), true);

  const alphaLog = await readFile(join(alpha, "log.md"), "utf8");
  assert.match(alphaLog, /甲一（a1）\s+彻底删除（跨库批量）/);
  const betaLog = await readFile(join(beta, "log.md"), "utf8");
  assert.equal(betaLog.includes("乙一"), false);
  // 失败原因固定文案：errno 与绝对路径不能跨 API 边界。
  assert.equal(JSON.stringify(json).includes(kbRoot), false);
  assert.equal(JSON.stringify(json).includes("EACCES"), false);
});

test("cross-kb purge enforces UI header and same-origin on writes", async () => {
  const { kbRoot, alpha } = await crossSetup();
  const body = { items: [{ kb: "甲库", id: "a1" }], confirm: "彻底删除 1 篇" };

  const noHeader = await crossPurge(kbRoot, body, { headers: { "x-kb-ui": "" } });
  assert.equal(noHeader.res.status, 403);
  assert.equal(noHeader.json.error.code, "FORBIDDEN");

  const crossOrigin = await crossPurge(kbRoot, body, {
    headers: { origin: "http://evil.example", host: "127.0.0.1:55929" },
  });
  assert.equal(crossOrigin.res.status, 403);

  const crossSite = await crossPurge(kbRoot, body, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.res.status, 403);
  assert.ok(await docOf(alpha, "a1"));
});

// ---------------------------------------------------------------------------
// 已删除资料搜索与排序
// ---------------------------------------------------------------------------

/** 构造 GET /trash/docs?... 的 URL（只保留有值的参数）。 */
function docsUrl(params = {}) {
  const url = new URL("http://dsh.internal/kb/api/trash/docs");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

async function listDocs(kbRoot, params) {
  return call({ kbRoot }, makeReq({ url: docsUrl(params) }));
}

test("GET /trash/docs query filters kb/title/type/sourceFile case-insensitively", async () => {
  const kbRoot = await tempRoot();
  await setupKb(kbRoot, "alpha", [
    deletedDoc("q1", "Annual REPORT", "2026-10-01T00:00:00.000Z", {
      type: "pdf-text",
      sourceFile: "annual.PDF",
    }),
    deletedDoc("q2", "会议纪要", "2026-10-02T00:00:00.000Z", { type: "note" }),
  ]);
  await setupKb(kbRoot, "beta", [
    deletedDoc("q3", "Beta Doc", "2026-10-03T00:00:00.000Z", {
      type: "docx",
      sourceFile: "beta.docx",
    }),
  ]);

  const ids = (json) => json.items.map((item) => item.id);
  const kb = await listDocs(kbRoot, { query: "alpha" });
  assert.equal(kb.res.status, 200);
  assert.deepEqual(ids(kb.json), ["q2", "q1"]);
  assert.equal(kb.json.total, 2);
  assert.equal(kb.json.query, "alpha");
  assert.equal(kb.json.sort, "deleted_desc");

  const title = await listDocs(kbRoot, { query: "REPORT" });
  assert.deepEqual(ids(title.json), ["q1"]);
  const type = await listDocs(kbRoot, { query: "NOTE" });
  assert.deepEqual(ids(type.json), ["q2"]);
  const source = await listDocs(kbRoot, { query: "BETA.DOCX" });
  assert.deepEqual(ids(source.json), ["q3"]);
  // 首尾空白被裁剪，响应回显归一化后的 query。
  const padded = await listDocs(kbRoot, { query: "  beta  " });
  assert.deepEqual(ids(padded.json), ["q3"]);
  assert.equal(padded.json.query, "beta");

  const none = await listDocs(kbRoot, { query: "不存在的关键字" });
  assert.deepEqual(none.json.items, []);
  assert.equal(none.json.total, 0);
  assert.equal(none.json.truncated, false);

  const all = await listDocs(kbRoot, {});
  assert.equal(all.json.total, 3);
  assert.equal(all.json.query, "");
  assert.equal(all.json.sort, "deleted_desc");
});

test("GET /trash/docs sorts deletedAt/title/kb with stable tie-breaks and invalid dates last", async () => {
  const kbRoot = await tempRoot();
  const same = "2026-10-02T00:00:00.000Z";
  await setupKb(kbRoot, "alpha", [
    deletedDoc("a-old", "Same", "2026-10-01T00:00:00.000Z"),
    deletedDoc("a-same", "Same", same),
    deletedDoc("a-bad", "Alpha", ""),
    deletedDoc("a-new", "Zeta", "2026-10-03T00:00:00.000Z"),
  ]);
  await setupKb(kbRoot, "beta", [
    deletedDoc("b-same", "Same", same),
    deletedDoc("b-mid", "Beta", "2026-10-02T12:00:00.000Z"),
  ]);

  const order = async (sort) => {
    const { json } = await listDocs(kbRoot, sort === undefined ? {} : { sort });
    return { ids: json.items.map((item) => `${item.kb}/${item.id}`), sort: json.sort };
  };

  // 倒序：新→旧；同刻按 库名+id；非法日期最后。
  const desc = await order("deleted_desc");
  assert.deepEqual(desc.ids, [
    "alpha/a-new",
    "beta/b-mid",
    "alpha/a-same",
    "beta/b-same",
    "alpha/a-old",
    "alpha/a-bad",
  ]);
  assert.equal(desc.sort, "deleted_desc");

  // 升序：旧→新；非法日期同样最后，不因方向反转插到最前。
  const asc = await order("deleted_asc");
  assert.deepEqual(asc.ids, [
    "alpha/a-old",
    "alpha/a-same",
    "beta/b-same",
    "beta/b-mid",
    "alpha/a-new",
    "alpha/a-bad",
  ]);

  // 标题排序：主列区分大小写无关的自然顺序，同标题按 库名+id 升序兜底。
  const titleAsc = await order("title_asc");
  assert.deepEqual(titleAsc.ids, [
    "alpha/a-bad",
    "beta/b-mid",
    "alpha/a-old",
    "alpha/a-same",
    "beta/b-same",
    "alpha/a-new",
  ]);
  const titleDesc = await order("title_desc");
  assert.deepEqual(titleDesc.ids, [
    "alpha/a-new",
    "alpha/a-old",
    "alpha/a-same",
    "beta/b-same",
    "beta/b-mid",
    "alpha/a-bad",
  ]);

  // 库名排序：同库内再按 id 升序兜底。
  const kbAsc = await order("kb_asc");
  assert.deepEqual(kbAsc.ids, [
    "alpha/a-bad",
    "alpha/a-new",
    "alpha/a-old",
    "alpha/a-same",
    "beta/b-mid",
    "beta/b-same",
  ]);
  const kbDesc = await order("kb_desc");
  assert.deepEqual(kbDesc.ids, [
    "beta/b-mid",
    "beta/b-same",
    "alpha/a-bad",
    "alpha/a-new",
    "alpha/a-old",
    "alpha/a-same",
  ]);

  // 未知 sort 回落默认 deleted_desc，并在响应里回显解析后的值。
  const unknown = await order("updated_desc");
  assert.deepEqual(unknown.ids, desc.ids);
  assert.equal(unknown.sort, "deleted_desc");
  const empty = await order(undefined);
  assert.deepEqual(empty.ids, desc.ids);
  assert.equal(empty.sort, "deleted_desc");
});

test("GET /trash/docs computes total/truncated after query filtering, then caps", async () => {
  const kbRoot = await tempRoot();
  const docs = [];
  for (let i = 0; i < 510; i += 1) {
    const title = i < 505 ? `匹配资料${i}` : `其他资料${i}`;
    docs.push(deletedDoc(`m${String(i).padStart(3, "0")}`, title, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));
  }
  await setupKb(kbRoot, "filter", docs);

  const many = await listDocs(kbRoot, { query: "匹配" });
  assert.equal(many.res.status, 200);
  assert.equal(many.json.total, 505);
  assert.equal(many.json.items.length, 500);
  assert.equal(many.json.truncated, true);
  // 过滤后仍按 deletedAt 倒序，再截断：最新命中的资料在首位，而不是先截断再过滤。
  assert.equal(many.json.items[0].id, "m504");
  assert.equal(many.json.items.at(-1).id, "m005");

  const few = await listDocs(kbRoot, { query: "其他" });
  assert.equal(few.json.total, 5);
  assert.equal(few.json.items.length, 5);
  assert.equal(few.json.truncated, false);
  assert.deepEqual(
    few.json.items.map((item) => item.id),
    ["m509", "m508", "m507", "m506", "m505"]
  );

  const none = await listDocs(kbRoot, { query: "无命中" });
  assert.equal(none.json.total, 0);
  assert.equal(none.json.truncated, false);
});
