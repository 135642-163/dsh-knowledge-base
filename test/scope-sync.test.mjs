/**
 * 库改名/归档/彻底删除时同步 .scopes.json（工具与 HTTP 两个调用点都要覆盖）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { handleApi } from "../lib/web/api.js";
import { archiveKb, listTrash, purgeKb } from "../lib/kbmeta.js";
import { readScopes, writeScopes } from "../lib/scope-store.js";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method, url, body } = {}) {
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:55929",
      origin: "http://127.0.0.1:55929",
      "x-kb-ui": "1",
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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-scope-sync-"));
  const kbRoot = join(root, "kb");
  for (const name of ["甲库", "乙库"]) {
    const dir = join(kbRoot, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "kb.json"), JSON.stringify({ schemaVersion: 5, name, docs: [] }), "utf8");
  }
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot, defaultKb: "甲库" });
  const exec = { agent: { session: { id: "s1", header: { cwd: root } } }, signal: new AbortController().signal };
  await writeScopes(kbRoot, {
    scopes: {
      s1: { mode: "selected", kbs: ["甲库", "乙库"], updatedAt: new Date().toISOString() },
    },
  });
  return { root, kbRoot, tools, exec };
}

test("kb_rename tool syncs the new name into scopes", async () => {
  const { kbRoot, tools, exec } = await setup();
  const result = await tools.get("kb_rename").execute({ kb: "甲库", newName: "甲库2" }, exec);
  assert.equal(result.kb, "甲库2");
  const data = await readScopes(kbRoot);
  assert.deepEqual(data.scopes.s1.kbs, ["甲库2", "乙库"]);
});

test("PATCH /kbs/:name rename syncs scopes", async () => {
  const { kbRoot } = await setup();
  const { res } = await call(kbRoot, makeReq({
    method: "PATCH",
    url: "/kb/api/kbs/%E7%94%B2%E5%BA%93",
    body: { name: "甲库3" },
  }));
  assert.equal(res.status, 200);
  const data = await readScopes(kbRoot);
  assert.deepEqual(data.scopes.s1.kbs, ["甲库3", "乙库"]);
});

test("archiveKb removes the name from scopes", async () => {
  const { kbRoot } = await setup();
  await archiveKb(kbRoot, "乙库");
  const data = await readScopes(kbRoot);
  assert.deepEqual(data.scopes.s1.kbs, ["甲库"]);
});

test("purgeKb removes the name from scopes", async () => {
  const { kbRoot } = await setup();
  await archiveKb(kbRoot, "乙库");
  const [entry] = await listTrash(kbRoot);
  await purgeKb(kbRoot, entry.dir);
  const data = await readScopes(kbRoot);
  assert.deepEqual(data.scopes.s1.kbs, ["甲库"]);
});

test("purgeKb removes an archived name when no live library owns it", async () => {
  const { kbRoot } = await setup();
  await archiveKb(kbRoot, "乙库");
  await writeScopes(kbRoot, {
    scopes: {
      s1: { mode: "selected", kbs: ["甲库"], updatedAt: new Date().toISOString() },
      s2: { mode: "selected", kbs: ["乙库"], updatedAt: new Date().toISOString() },
    },
  });
  const [entry] = await listTrash(kbRoot);
  await purgeKb(kbRoot, entry.dir);
  const data = await readScopes(kbRoot);
  assert.deepEqual(data.scopes.s2.kbs, []);
});

test("purgeKb removes both the manifest name and the original directory name", async () => {
  const { kbRoot } = await setup();
  const dir = join(kbRoot, "目录名");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "kb.json"), JSON.stringify({ schemaVersion: 5, name: "显示名", docs: [] }), "utf8");
  const trashedTo = await archiveKb(kbRoot, "目录名");
  assert.match(trashedTo, /目录名-\d{4}(?:-\d{2}){5}(?:-\d+)?$/);
  // 清理归档时写入了两个别名：旧范围可能同时引用清单名与目录名。
  await writeScopes(kbRoot, {
    scopes: {
      s9: { mode: "selected", kbs: ["目录名", "显示名"], updatedAt: new Date().toISOString() },
    },
  });
  const [entry] = (await listTrash(kbRoot)).filter((item) => item.dir.startsWith("目录名-"));
  await purgeKb(kbRoot, entry.dir);
  const data = await readScopes(kbRoot);
  assert.deepEqual(data.scopes.s9.kbs, []);
});

test("purgeKb keeps a name reused by a live library", async () => {
  const { kbRoot } = await setup();
  await archiveKb(kbRoot, "乙库");
  const liveDir = join(kbRoot, "乙库");
  await mkdir(liveDir, { recursive: true });
  await writeFile(join(liveDir, "kb.json"), JSON.stringify({ schemaVersion: 5, name: "乙库", docs: [] }), "utf8");
  await writeScopes(kbRoot, {
    scopes: {
      s1: { mode: "selected", kbs: ["乙库"], updatedAt: new Date().toISOString() },
    },
  });
  const [entry] = await listTrash(kbRoot);
  await purgeKb(kbRoot, entry.dir);
  const data = await readScopes(kbRoot);
  assert.deepEqual(data.scopes.s1.kbs, ["乙库"]);
});
