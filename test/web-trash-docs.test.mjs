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

