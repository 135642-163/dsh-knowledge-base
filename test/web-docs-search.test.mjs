/**
 * 工作台资料列表搜索：query 同时匹配标题、摘要与标签（不区分大小写）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKb } from "../lib/kbmeta.js";
import { listDocs } from "../lib/web/data.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-docs-search-"));
  const kbRoot = join(root, "kb");
  await createKb(kbRoot, { name: "资料" });
  const dir = join(kbRoot, "资料");
  const manifest = JSON.parse(await readFile(join(dir, "kb.json"), "utf8"));
  manifest.docs.push(
    {
      id: "d-oil",
      title: "绝缘油试验规程",
      type: "pdf-text",
      status: "ready",
      trust: "high",
      pages: 12,
      chars: 1200,
      summary: "变压器油质检测方法",
      tags: ["油务"],
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      id: "d-relay",
      title: "DL/T 478-2013 继电保护通用技术条件",
      type: "pdf-text",
      status: "ready",
      trust: "high",
      pages: 30,
      chars: 3000,
      summary: "继电保护装置通用要求",
      tags: ["继电保护"],
      updatedAt: "2026-10-02T00:00:00.000Z",
    },
    {
      id: "d-gas",
      title: "SF6 断路器检修导则",
      type: "text",
      status: "ready",
      trust: "medium",
      pages: 5,
      chars: 500,
      summary: "Gas Insulation Switchgear maintenance",
      tags: ["GIS"],
      updatedAt: "2026-10-03T00:00:00.000Z",
    },
  );
  await writeFile(join(dir, "kb.json"), JSON.stringify(manifest), "utf8");
  return { root, kbRoot };
}

async function query(kbRoot, params) {
  const result = await listDocs(kbRoot, "资料", params);
  return { ...result, ids: result.docs.map((doc) => doc.id).sort() };
}

test("query 命中摘要与标签，也能命中标题", async (t) => {
  const { root, kbRoot } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));

  const bySummary = await query(kbRoot, { query: "油质" });
  assert.deepEqual(bySummary.ids, ["d-oil"]);
  assert.equal(bySummary.total, 1);

  const byTag = await query(kbRoot, { query: "油务" });
  assert.deepEqual(byTag.ids, ["d-oil"]);

  const byTitle = await query(kbRoot, { query: "绝缘油" });
  assert.deepEqual(byTitle.ids, ["d-oil"]);

  const relay = await query(kbRoot, { query: "继电保护" });
  assert.deepEqual(relay.ids, ["d-relay"]);
});

test("query 不区分大小写", async (t) => {
  const { root, kbRoot } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));

  const summary = await query(kbRoot, { query: "insulation" });
  assert.deepEqual(summary.ids, ["d-gas"]);
  const tag = await query(kbRoot, { query: "gis" });
  assert.deepEqual(tag.ids, ["d-gas"]);
});

test("标题不匹配、摘要和标签也不匹配时不返回该文档", async (t) => {
  const { root, kbRoot } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));

  const oil = await query(kbRoot, { query: "油质" });
  assert.ok(!oil.ids.includes("d-relay"));
  assert.ok(!oil.ids.includes("d-gas"));

  const missing = await query(kbRoot, { query: "完全不存在的关键词" });
  assert.equal(missing.total, 0);
  assert.deepEqual(missing.docs, []);
});

test("搜索与状态/可信度/类型过滤、排序和分页共存", async (t) => {
  const { root, kbRoot } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));

  const high = await query(kbRoot, { query: "继电", trust: "high" });
  assert.deepEqual(high.ids, ["d-relay"]);
  const medium = await query(kbRoot, { query: "g", trust: "medium" });
  assert.deepEqual(medium.ids, ["d-gas"]);
  assert.equal(medium.docs[0].title, "SF6 断路器检修导则");

  const textOnly = await query(kbRoot, { query: "绝缘", type: "text" });
  assert.equal(textOnly.total, 0);
  const readyAll = await query(kbRoot, { query: "绝缘", status: "ready" });
  assert.deepEqual(readyAll.ids, ["d-oil"]);

  const page = await query(kbRoot, { offset: 1, limit: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.offset, 1);
  assert.equal(page.limit, 1);
  assert.equal(page.docs.length, 1);

  const clamped = await query(kbRoot, { offset: -5, limit: 9999 });
  assert.equal(clamped.offset, 0);
  assert.equal(clamped.limit, 200);
  assert.equal(clamped.docs.length, 3);
});
