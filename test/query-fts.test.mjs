import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchKb } from "../lib/query.js";

const hasSqlite = await import("node:sqlite").then(() => true).catch(() => false);

test("searchKb 纯文本查询走 FTS5 条款并保留页码", { skip: !hasSqlite }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kb-query-fts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "markdown", "d1"), { recursive: true });
  await writeFile(join(root, "markdown", "d1", "d1.md"), [
    "# 风电场接入",
    "### 第 1 页",
    "5.2.2 风电场应满足电压偏差要求。",
  ].join("\n"), "utf8");
  const manifest = { docs: [{ id: "d1", title: "风电场接入", type: "pdf-text", status: "ready", version: 1, trust: "high" }] };
  const result = await searchKb({}, {}, root, manifest, { pattern: "电压偏差", ftsPattern: "电压偏差", maxMatches: 10 });
  assert.ok(result.matches.length >= 1);
  assert.equal(result.matches[0].docId, "d1");
  assert.equal(result.matches[0].pageStart, 1);
  assert.match(result.matches[0].line, /电压偏差/);
});
