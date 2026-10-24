/**
 * 回收站彻底删除：DELETE /kb/api/trash/:dir。
 * 只允许删除 .trash 下的一级归档目录，并拒绝路径穿越。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { archiveKb, createKb } from "../lib/kbmeta.js";
import { readManifest, writeManifestAtomic } from "../lib/store.js";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/trash", headers = {}, body } = {}) {
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

async function call(kbRoot, req) {
  const res = makeRes();
  await handleApi(req, res, { opts: { kbRoot }, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

async function tempRoot() {
  return join(await mkdtemp(join(tmpdir(), "kb-api-trash-")), "kb");
}

test("DELETE /trash/:dir removes an archived kb and reports its counts", async () => {
  const kbRoot = await tempRoot();
  const { dir } = await createKb(kbRoot, { name: "待删除" });
  const manifest = await readManifest(dir);
  manifest.docs.push(
    { id: "d1", title: "资料", type: "text", status: "ready", chars: 12 },
    { id: "n1", title: "笔记", type: "note", status: "ready" },
    { id: "n2", title: "旧笔记", type: "note", status: "deleted", deletedAt: new Date().toISOString() },
  );
  await writeManifestAtomic(dir, manifest);
  const trashedTo = await archiveKb(kbRoot, "待删除");
  const dirName = basename(trashedTo);
  await writeFile(join(kbRoot, ".scopes.json"), JSON.stringify({
    version: 1,
    scopes: {
      s1: { mode: "selected", kbs: ["待删除", "保留"] },
      s2: { mode: "selected", kbs: ["保留"] },
    },
  }));

  const { res, json } = await call(kbRoot, makeReq({
    method: "DELETE",
    url: `/kb/api/trash/${encodeURIComponent(dirName)}`,
  }));
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.name, "待删除");
  assert.equal(json.dir, dirName);
  assert.equal(json.docs, 2);
  assert.equal(json.notes, 1);
  assert.match(json.purgedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(existsSync(trashedTo), false);

  const scopes = JSON.parse(await readFile(join(kbRoot, ".scopes.json"), "utf8"));
  assert.deepEqual(scopes.scopes.s1.kbs, ["保留"]);
  assert.deepEqual(scopes.scopes.s2.kbs, ["保留"]);
  assert.deepEqual((await call(kbRoot, makeReq({ url: "/kb/api/trash" }))).json.items, []);
});

test("DELETE /trash rejects traversal and encoded path separators", async () => {
  const kbRoot = await tempRoot();
  await mkdir(join(kbRoot, ".trash"), { recursive: true });
  await writeFile(join(kbRoot, "sentinel.txt"), "keep", "utf8");

  const urls = [
    `/kb/api/trash/${encodeURIComponent("../escape")}`,
    `/kb/api/trash/${encodeURIComponent("..\\escape")}`,
    "/kb/api/trash/%2e%2e",
  ];
  for (const url of urls) {
    const { res, json } = await call(kbRoot, makeReq({ method: "DELETE", url }));
    assert.ok(res.status === 400 || res.status === 404, `${url} got ${res.status}`);
    assert.match(json?.error?.code ?? "", /^(TRASH_(INVALID|NOT_FOUND)|NOT_FOUND)$/);
  }

  assert.equal(await readFile(join(kbRoot, "sentinel.txt"), "utf8"), "keep");
  assert.deepEqual(await readdir(join(kbRoot, ".trash")), []);
});

test("DELETE /trash returns TRASH_NOT_FOUND for a missing archive", async () => {
  const kbRoot = await tempRoot();
  const { res, json } = await call(kbRoot, makeReq({
    method: "DELETE",
    url: "/kb/api/trash/missing-20260101-000000",
  }));
  assert.equal(res.status, 404);
  assert.equal(json.error.code, "TRASH_NOT_FOUND");
});

test("DELETE /trash does not purge a live kb", async () => {
  const kbRoot = await tempRoot();
  await createKb(kbRoot, { name: "live" });
  const { res } = await call(kbRoot, makeReq({
    method: "DELETE",
    url: "/kb/api/trash/live",
  }));
  assert.equal(res.status, 404);
  assert.equal(existsSync(join(kbRoot, "live", "kb.json")), true);
});

test("DELETE /trash removes a non-restorable archive and tolerates bad scopes", async () => {
  const kbRoot = await tempRoot();
  const dirName = "损坏-20260101-000000";
  const archived = join(kbRoot, ".trash", dirName);
  await mkdir(archived, { recursive: true });
  await writeFile(join(kbRoot, ".scopes.json"), "{not json", "utf8");

  const { res, json } = await call(kbRoot, makeReq({
    method: "DELETE",
    url: `/kb/api/trash/${encodeURIComponent(dirName)}`,
  }));
  assert.equal(res.status, 200);
  assert.equal(json.name, dirName);
  assert.equal(json.docs, 0);
  assert.equal(json.notes, 0);
  assert.equal(existsSync(archived), false);
  assert.equal(await readFile(join(kbRoot, ".scopes.json"), "utf8"), "{not json");
});
