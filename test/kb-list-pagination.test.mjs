/**
 * 0.4.1 kb_list 分页/过滤：948 文档的库不能一次全量输出。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { PARSER_VERSION } from "../lib/version.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-list-page-"));
  const kbRoot = join(root, "kb-root");
  const kbDir = join(kbRoot, "测试库");
  await mkdir(kbDir, { recursive: true });
  const docs = [];
  for (let i = 1; i <= 60; i++) {
    const n = String(i).padStart(2, "0");
    let title = `文档${n}`;
    if (i <= 3) title = `电缆资料${n}`;
    const status = i <= 50 ? "ready" : i <= 55 ? "failed" : "importing";
    docs.push({
      id: `d${n}`,
      title,
      type: "text",
      status,
      chars: 10,
      parts: 1,
      pages: 0,
      version: 1,
      parserVersion: PARSER_VERSION,
      contentSource: "text",
      updatedAt: new Date().toISOString(),
    });
  }
  docs[0].corruptedPages = [2, 3];
  docs[0].lowConfidencePages = [5];
  docs[0].ocrConfidence = 72.5;
  await writeFile(
    join(kbDir, "kb.json"),
    JSON.stringify(
      { schemaVersion: 2, name: "测试库", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), docs },
      null,
      2
    ),
    "utf8"
  );
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot, defaultKb: "测试库" });
  const exec = {
    agent: { session: { header: { cwd: root } } },
    signal: new AbortController().signal,
  };
  return { root, tools, exec };
}

test("kb_list defaults to 50 docs with total and hasMore", async () => {
  const { root, tools, exec } = await setup();
  try {
    const r = await tools.get("kb_list").execute({ kb: "测试库" }, exec);
    assert.equal(r.docs.length, 50);
    assert.equal(r.total, 60);
    assert.equal(r.totalAll, 60);
    assert.equal(r.offset, 0);
    assert.equal(r.limit, 50);
    assert.equal(r.hasMore, true);
    const text = tools.get("kb_list").output.render({ kb: "测试库" }, r)[0].text;
    assert.match(text, /共 60 个文档/);
    assert.match(text, /还有 10 个/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_list honours offset/limit and filters", async () => {
  const { root, tools, exec } = await setup();
  try {
    const page = await tools.get("kb_list").execute({ kb: "测试库", limit: 2, offset: 2 }, exec);
    assert.equal(page.docs.length, 2);
    assert.equal(page.offset, 2);
    assert.equal(page.hasMore, true);

    const byQuery = await tools.get("kb_list").execute({ kb: "测试库", query: "电缆" }, exec);
    assert.equal(byQuery.total, 3);
    assert.equal(byQuery.docs.length, 3);
    assert.ok(byQuery.docs.every((d) => d.title.includes("电缆")));

    const byStatus = await tools.get("kb_list").execute({ kb: "测试库", status: "failed" }, exec);
    assert.equal(byStatus.total, 5);
    assert.ok(byStatus.docs.every((d) => d.status === "failed"));

    const all = await tools.get("kb_list").execute({ kb: "测试库", limit: 500 }, exec);
    assert.equal(all.docs.length, 60);
    assert.equal(all.hasMore, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty filtered list does not claim there are no knowledge bases", async () => {
  const { root, tools, exec } = await setup();
  try {
    const r = await tools.get("kb_list").execute({ kb: "测试库", query: "不存在的标题" }, exec);
    assert.equal(r.total, 0);
    assert.equal(r.totalAll, 60);
    const text = tools.get("kb_list").output.render({ kb: "测试库" }, r)[0].text;
    assert.doesNotMatch(text, /还没有任何知识库/);
    assert.match(text, /没有匹配的文档/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_list without kb still lists knowledge bases", async () => {
  const { root, tools, exec } = await setup();
  try {
    const r = await tools.get("kb_list").execute({}, exec);
    assert.equal(r.kbs.length, 1);
    assert.equal(r.kbs[0].name, "测试库");
    assert.equal(r.docs.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("kb_list surfaces OCR quality counts", async () => {
  const { root, tools, exec } = await setup();
  try {
    const r = await tools.get("kb_list").execute({ kb: "测试库", query: "电缆资料01" }, exec);
    const text = tools.get("kb_list").output.render({ kb: "测试库" }, r)[0].text;
    assert.match(text, /文字层损坏 2页/);
    assert.match(text, /OCR低置信 1页/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
