/**
 * GET /kb/api/search：参数校验、目标库解析、FTS/ripgrep 双路径、过滤与分页。
 * 全部使用临时 kbRoot，不碰真实知识库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb, archiveKb } from "../lib/kbmeta.js";
import { readManifest } from "../lib/store.js";

const hasSqlite = await import("node:sqlite").then(() => true).catch(() => false);

const KB = "标准";
const KB2 = "电能质量";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/search" } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929" },
    on() {}, off() {},
  };
}

async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

/** 真实 ripgrep 的 ctx.subprocess 薄封装（标准号查询会走到这里）。 */
function realSpawn() {
  const calls = [];
  const spawn = (options) => {
    calls.push(options);
    const child = spawnChild(options.argv[0], options.argv.slice(1), {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve) => {
      child.on("error", () => resolve({ exitCode: 127, signal: null }));
      child.on("close", (code, signal) => resolve({ exitCode: code, signal }));
    });
    return {
      done,
      collected: {
        stdout: { readFrom: () => ({ text: stdout, lossy: false, nextOffset: stdout.length }) },
        stderr: { readFrom: () => ({ text: stderr, lossy: false, nextOffset: stderr.length }) },
      },
    };
  };
  return { spawn, calls };
}

async function writeDoc(dir, id, title, body) {
  const target = join(dir, "markdown", id);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, `${id}.md`), `# ${title}\n${body}\n`, "utf8");
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-web-search-"));
  const kbRoot = join(root, "kb");
  const { dir } = await createKb(kbRoot, { name: KB });
  const { dir: dir2 } = await createKb(kbRoot, { name: KB2 });

  const manifest = await readManifest(dir);
  manifest.docs.push(
    {
      id: "d1", title: "风电场接入电力系统技术规定", type: "pdf-text", status: "ready", version: 1,
      pages: 10, chars: 100, standardNo: "GB/T 19963-2011", tags: ["新能源", "并网"], trust: "high",
      updatedAt: "2026-10-20T00:00:00.000Z",
    },
    {
      id: "d2", title: "电能质量 电压偏差", type: "pdf-text", status: "ready", version: 1,
      pages: 8, chars: 100, standardNo: "GB 12325-2008", tags: ["电能质量"], trust: "medium",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    {
      id: "d3", title: "已删除的电压偏差资料", type: "text", status: "deleted", version: 1,
      pages: 1, chars: 10, tags: ["新能源"], trust: "unknown", deletedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "d4", title: "光伏发电系统接入配电网", type: "docx", status: "ready", version: 1,
      pages: 3, chars: 50, standardNo: "GB/T 29319-2012", tags: ["新能源"], trust: "low",
      updatedAt: "",
    },
    {
      id: "s1", title: "GB 1234-2020 电能质量 电压偏差", type: "pdf-text", status: "ready", version: 1,
      pages: 2, chars: 60, standardNo: "GB 1234-2020", tags: ["检索"], trust: "medium",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    {
      id: "s2", title: "GB/T 1234-2020 电能质量 谐波", type: "pdf-text", status: "ready", version: 1,
      pages: 2, chars: 60, standardNo: "GB/T 1234-2020", tags: ["检索"], trust: "high",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  );
  await writeFile(join(dir, "kb.json"), JSON.stringify(manifest), "utf8");
  await writeDoc(dir, "d1", "风电场接入电力系统技术规定", "### 第 1 页\n5.2.2 风电场应满足电压偏差要求。\n### 第 3 页\n6.1 电压偏差限值为 7%。");
  await writeDoc(dir, "d2", "电能质量 电压偏差", "### 第 1 页\n5.1 电压偏差的允许值。");
  await writeDoc(dir, "d3", "已删除的电压偏差资料", "### 第 1 页\n电压偏差不应出现在结果里。");
  await writeDoc(dir, "d4", "光伏发电系统接入配电网", "### 第 1 页\n5.1 光伏发电系统的电压偏差。");
  await writeDoc(dir, "s1", "GB 1234-2020 电能质量 电压偏差", "### 第 1 页\n1 范围\nGB 1234-2020\n本文件规定了限值。");
  await writeDoc(dir, "s2", "GB/T 1234-2020 电能质量 谐波", "### 第 1 页\n1 范围\nGB/T 1234-2020\n本文件规定了限值。");

  const manifest2 = await readManifest(dir2);
  manifest2.docs.push({
    id: "x1", title: "电压暂降测试导则", type: "pdf-text", status: "ready", version: 1,
    pages: 5, chars: 50, standardNo: "Q/GDW 1000-2020", tags: [], trust: "medium",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  await writeFile(join(dir2, "kb.json"), JSON.stringify(manifest2), "utf8");
  await writeDoc(dir2, "x1", "电压暂降测试导则", "### 第 1 页\n4.1 电压暂降的测量方法。");

  return { root, kbRoot, dir, dir2 };
}

function searchUrl(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  return `/kb/api/search?${query.toString()}`;
}

async function withSetup(fn) {
  const env = await setup();
  try {
    return await fn(env);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
}

function optsOf(env, extra = {}) {
  return { kbRoot: env.kbRoot, defaultKb: KB, jobs: null, ...extra };
}

// ---------------------------------------------------------------------------
// 基本结果
// ---------------------------------------------------------------------------

test("返回文档级结果、深链与 terms", { skip: !hasSqlite }, async () => withSetup(async (env) => {
  const rg = realSpawn();
  const { res, json } = await call(optsOf(env, { spawn: rg.spawn }), makeReq({ url: searchUrl({ q: "电压偏差" }) }));
  assert.equal(res.status, 200);
  assert.equal(json.q, "电压偏差");
  assert.ok(json.terms.includes("电压"), json.terms);
  assert.equal(json.engine, "fts");
  assert.equal(json.estimated, false);
  assert.ok(json.total >= 3, `total=${json.total}`);
  const ids = json.results.map((item) => item.docId);
  assert.equal(new Set(ids).size, ids.length, "同一文档只能出现一次");
  const d1 = json.results.find((item) => item.docId === "d1");
  assert.ok(d1, ids.join(","));
  assert.equal(d1.kb, KB);
  assert.equal(d1.standardNo, "GB/T 19963-2011");
  assert.equal(d1.trust, "high");
  assert.equal(d1.type, "pdf-text");
  assert.deepEqual(d1.tags, ["新能源", "并网"]);
  // best hit 取引擎序第一条：d1 两条命中（5.2.2 第 1 页 / 6.1 第 3 页）哪条排前由 bm25 决定。
  assert.ok([1, 3].includes(d1.page), `page=${d1.page}`);
  assert.equal(d1.clause, d1.page === 3 ? "6.1" : "5.2.2");
  assert.ok(d1.snippet.includes("电压偏差"), d1.snippet);
  assert.equal(d1.deepLink, `/kb/?kb=${encodeURIComponent(KB)}&doc=d1&page=${d1.page}&clause=${d1.clause}`);
  assert.ok(d1.hits >= 2, `hits=${d1.hits}`);
  assert.ok(!JSON.stringify(json).includes(env.kbRoot), "响应不能包含绝对路径");
}));

test("已删除资料不进入结果", { skip: !hasSqlite }, async () => withSetup(async (env) => {
  const rg = realSpawn();
  const { json } = await call(optsOf(env, { spawn: rg.spawn }), makeReq({ url: searchUrl({ q: "电压偏差" }) }));
  assert.ok(!json.results.some((item) => item.docId === "d3"));
}));

// ---------------------------------------------------------------------------
// 标准号（GB ≠ GB/T）
// ---------------------------------------------------------------------------

test("标准号查询走 ripgrep：GB/T 与 GB 不互相命中", async () => withSetup(async (env) => {
  const rg = realSpawn();
  const opts = optsOf(env, { spawn: rg.spawn });
  const gbt = await call(opts, makeReq({ url: searchUrl({ q: "GB/T 1234" }) }));
  assert.equal(gbt.res.status, 200);
  assert.equal(gbt.json.engine, "rg");
  assert.deepEqual(gbt.json.results.map((item) => item.docId), ["s2"]);
  assert.ok(gbt.json.results[0].deepLink.includes("doc=s2"));
  const gb = await call(opts, makeReq({ url: searchUrl({ q: "GB 1234" }) }));
  assert.deepEqual(gb.json.results.map((item) => item.docId), ["s1"]);
}));

test("需要 ripgrep 但没有 subprocess 时回 503", async () => withSetup(async (env) => {
  const { res, json } = await call(optsOf(env), makeReq({ url: searchUrl({ q: "GB/T 1234" }) }));
  assert.equal(res.status, 503);
  assert.equal(json.error.code, "SEARCH_UNAVAILABLE");
}));

test("FTS 能命中时不需要 subprocess", { skip: !hasSqlite }, async () => withSetup(async (env) => {
  const { res, json } = await call(optsOf(env), makeReq({ url: searchUrl({ q: "电压偏差" }) }));
  assert.equal(res.status, 200);
  assert.equal(json.engine, "fts");
  assert.ok(json.results.length >= 1);
}));

// ---------------------------------------------------------------------------
// 过滤、facets、分页
// ---------------------------------------------------------------------------

test("tag/type/trust 过滤与 facets（facets 反映过滤前）", { skip: !hasSqlite }, async () => withSetup(async (env) => {
  const rg = realSpawn();
  const opts = optsOf(env, { spawn: rg.spawn });
  const byTag = await call(opts, makeReq({ url: searchUrl({ q: "电压偏差", tag: "新能源" }) }));
  assert.deepEqual(byTag.json.results.map((item) => item.docId).sort(), ["d1", "d4"]);
  const byType = await call(opts, makeReq({ url: searchUrl({ q: "电压偏差", type: "docx" }) }));
  assert.deepEqual(byType.json.results.map((item) => item.docId), ["d4"]);
  assert.equal(byType.json.facets.types.some((item) => item.name === "pdf-text"), true, "facets 应含被过滤掉的类型");
  const byTrust = await call(opts, makeReq({ url: searchUrl({ q: "电压偏差", trust: "high" }) }));
  assert.deepEqual(byTrust.json.results.map((item) => item.docId), ["d1"]);
  assert.equal(byTrust.json.facets.trust.some((item) => item.name === "medium"), true);
}));

test("分页：total 是过滤后文档数，offset/limit 夹取", { skip: !hasSqlite }, async () => withSetup(async (env) => {
  const rg = realSpawn();
  const opts = optsOf(env, { spawn: rg.spawn });
  const first = await call(opts, makeReq({ url: searchUrl({ q: "电压偏差", limit: 2 }) }));
  assert.equal(first.json.limit, 2);
  assert.equal(first.json.results.length, 2);
  const second = await call(opts, makeReq({ url: searchUrl({ q: "电压偏差", limit: 2, offset: 2 }) }));
  assert.equal(second.json.offset, 2);
  const idsA = first.json.results.map((item) => item.docId);
  const idsB = second.json.results.map((item) => item.docId);
  assert.ok(idsA.every((id) => !idsB.includes(id)), `${idsA} / ${idsB}`);
  assert.equal(first.json.total, second.json.total);
  const clamped = await call(opts, makeReq({ url: searchUrl({ q: "电压偏差", limit: 999, offset: -5 }) }));
  assert.equal(clamped.json.limit, 50);
  assert.equal(clamped.json.offset, 0);
}));

// ---------------------------------------------------------------------------
// 跨库
// ---------------------------------------------------------------------------

test("kb=* 检索全部库；kb 指定单库", { skip: !hasSqlite }, async () => withSetup(async (env) => {
  const rg = realSpawn();
  const opts = optsOf(env, { spawn: rg.spawn });
  const all = await call(opts, makeReq({ url: searchUrl({ q: "电压", kb: "*" }) }));
  assert.equal(all.res.status, 200);
  assert.deepEqual([...all.json.kbs].sort(), [KB, KB2].sort());
  const ids = all.json.results.map((item) => `${item.kb}/${item.docId}`);
  assert.ok(ids.includes(`${KB2}/x1`), ids.join(","));
  assert.ok(ids.includes(`${KB}/d2`), ids.join(","));
  const single = await call(opts, makeReq({ url: searchUrl({ q: "电压", kb: KB2 }) }));
  assert.deepEqual(single.json.kbs, [KB2]);
  assert.ok(single.json.results.every((item) => item.kb === KB2));
}));

test("kb=all 与空 kb 等价于全部库", { skip: !hasSqlite }, async () => withSetup(async (env) => {
  const rg = realSpawn();
  const opts = optsOf(env, { spawn: rg.spawn });
  const byAll = await call(opts, makeReq({ url: searchUrl({ q: "电压", kb: "all" }) }));
  const byEmpty = await call(opts, makeReq({ url: searchUrl({ q: "电压" }) }));
  assert.deepEqual([...byAll.json.kbs].sort(), [...byEmpty.json.kbs].sort());
  const archivedRoot = await mkdtemp(join(tmpdir(), "kb-web-search-arch-"));
  try {
    const kbRoot = join(archivedRoot, "kb");
    await createKb(kbRoot, { name: "归档库" });
    await archiveKb(kbRoot, "归档库");
    const { json } = await call({ kbRoot, defaultKb: KB, jobs: null, spawn: rg.spawn }, makeReq({ url: searchUrl({ q: "电压" }) }));
    assert.equal(json.results.length, 0);
    assert.deepEqual(json.kbs, []);
    assert.equal(json.engine, "none");
  } finally {
    await rm(archivedRoot, { recursive: true, force: true });
  }
}));

// ---------------------------------------------------------------------------
// 参数错误
// ---------------------------------------------------------------------------

test("参数校验：空词/超长/非法 trust/未知库", async () => withSetup(async (env) => {
  const rg = realSpawn();
  const opts = optsOf(env, { spawn: rg.spawn });
  const empty = await call(opts, makeReq({ url: searchUrl({}) }));
  assert.equal(empty.res.status, 400);
  assert.equal(empty.json.error.code, "SEARCH_EMPTY");
  const blank = await call(opts, makeReq({ url: searchUrl({ q: "   " }) }));
  assert.equal(blank.res.status, 400);
  const tooLong = await call(opts, makeReq({ url: searchUrl({ q: "电".repeat(201) }) }));
  assert.equal(tooLong.res.status, 400);
  assert.equal(tooLong.json.error.code, "INVALID_ARGS");
  const badTrust = await call(opts, makeReq({ url: searchUrl({ q: "电压", trust: "HIGH" }) }));
  assert.equal(badTrust.res.status, 400);
  assert.equal(badTrust.json.error.code, "INVALID_ARGS");
  const missingKb = await call(opts, makeReq({ url: searchUrl({ q: "电压", kb: "不存在的库" }) }));
  assert.equal(missingKb.res.status, 404);
  assert.equal(missingKb.json.error.code, "KB_NOT_FOUND");
}));

test("单库检索失败不阻断其他库（note 记录库名、不带路径）", async () => withSetup(async (env) => {
  const rg = realSpawn();
  // 让「电能质量」库的 ripgrep 启动失败，验证其他库照常返回。
  const spawn = (options) => {
    if (String(options.cwd ?? "").endsWith(KB2)) throw new Error("模拟检索进程不可用");
    return rg.spawn(options);
  };
  const { res, json } = await call(optsOf(env, { spawn }), makeReq({ url: searchUrl({ q: "GB/T 1234", kb: "*" }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(json.results.map((item) => item.docId), ["s2"]);
  assert.ok(json.note.includes(`${KB2} 检索失败`), json.note);
  assert.ok(!json.note.includes(env.kbRoot), "note 不能带绝对路径");
  assert.deepEqual([...json.kbs].sort(), [KB, KB2].sort());
}));
