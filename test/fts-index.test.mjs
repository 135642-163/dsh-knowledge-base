import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFtsIndex, searchFtsIndex, tokenizeForFts } from "../lib/fts-index.js";

const hasSqlite = await import("node:sqlite").then(() => true).catch(() => false);

test("tokenizeForFts 切出中文二元组/标准号", () => {
  const tokens = tokenizeForFts("GB/T 19963.2-2024 风电场电压偏差");
  assert.match(tokens, /19963/);
  assert.match(tokens, /风电/);
  assert.match(tokens, /电压/);
  assert.match(tokens, /偏差/);
});

test("FTS5 建索引与 BM25 查询", { skip: !hasSqlite }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kb-fts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "markdown", "d1"), { recursive: true });
  await writeFile(join(root, "markdown", "d1", "d1.md"), [
    "# 风电场接入",
    "### 第 1 页",
    "5.2.2 风电场应满足电压偏差要求。",
    "5.2.3 谐波限值应满足要求。",
  ].join("\n"), "utf8");
  const manifest = { docs: [{ id: "d1", title: "风电场接入", type: "pdf-text", status: "ready", version: 1 }] };
  const built = await buildFtsIndex(root, manifest, { force: true });
  assert.equal(built.ok, true);
  assert.ok(built.clauses >= 2);
  const result = await searchFtsIndex(root, "电压偏差", { limit: 10 });
  assert.equal(result.ok, true);
  assert.ok(result.matches.length >= 1);
  assert.equal(result.matches[0].docId, "d1");
  assert.match(String(result.matches[0].text), /电压偏差/);
});

test("FTS5 增量构建只重建变动文档", { skip: !hasSqlite }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kb-fts-inc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "markdown", "d1"), { recursive: true });
  await mkdir(join(root, "markdown", "d2"), { recursive: true });
  await writeFile(join(root, "markdown", "d1", "d1.md"), "# A\n5.1 电压偏差\n", "utf8");
  await writeFile(join(root, "markdown", "d2", "d2.md"), "# B\n5.1 谐波电流\n", "utf8");
  const manifest = { docs: [
    { id: "d1", title: "A", status: "ready", version: 1, updatedAt: "2026-10-25T00:00:00Z" },
    { id: "d2", title: "B", status: "ready", version: 1, updatedAt: "2026-10-25T00:00:00Z" },
  ] };
  await buildFtsIndex(root, manifest, { force: true, stamp: "s1" });
  const inc = await buildFtsIndex(root, manifest, { stamp: "s2" });
  assert.equal(inc.mode, "incremental");
  assert.equal(inc.added, 0);
  assert.equal(inc.changed, 0);
  // d2 删除，d1 改正文/版本，再新增 d3
  await rm(join(root, "markdown", "d2"), { recursive: true, force: true });
  await writeFile(join(root, "markdown", "d1", "d1.md"), "# A\n5.1 电压暂降\n", "utf8");
  await mkdir(join(root, "markdown", "d3"), { recursive: true });
  await writeFile(join(root, "markdown", "d3", "d3.md"), "# C\n5.1 闪变\n", "utf8");
  const next = { docs: [
    { id: "d1", title: "A", status: "ready", version: 2, updatedAt: "2026-10-25T01:00:00Z" },
    { id: "d3", title: "C", status: "ready", version: 1, updatedAt: "2026-10-25T01:00:00Z" },
  ] };
  const changed = await buildFtsIndex(root, next, { stamp: "s3" });
  assert.equal(changed.mode, "incremental");
  assert.equal(changed.changed, 1);
  assert.equal(changed.added, 1);
  assert.equal(changed.removed, 1);
  const old = await searchFtsIndex(root, "谐波电流", { limit: 10 });
  assert.equal(old.matches.length, 0, "removed doc must not remain in FTS");
  const fresh = await searchFtsIndex(root, "电压暂降", { limit: 10 });
  assert.ok(fresh.matches.some((row) => row.docId === "d1"));
});
