/**
 * 0.14.0 标题清洗与 kb_retitle：
 * - cleanTitle 去掉站点域名、GB_T、序号前缀、span 残留；
 * - 单篇改名会重建合并版 H1、保留历史、版本号+1；
 * - 批量清洗默认 dryRun=true，确认后 dryRun=false 才应用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { cleanTitle } from "../lib/titles.js";
import { readManifest } from "../lib/store.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-retitle-"));
  const kbRoot = join(root, "kb-root");
  await mkdir(kbRoot, { recursive: true });
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 500 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  return { root, kbRoot, kbDir: join(kbRoot, "测试库"), tools, exec };
}

test("cleanTitle removes scrape noise without damaging real titles", () => {
  assert.equal(
    cleanTitle("GB_T 15543-1995 电能质量  三相电压允许不平衡度(标准网-www.biaozhun.org)"),
    "GB/T 15543-1995 电能质量 三相电压允许不平衡度"
  );
  assert.equal(cleanTitle("GBT 156-2017 标准电压_www.upbz.net"), "GB/T 156-2017 标准电压");
  assert.equal(cleanTitle("1. 电能质量管理办法（暂行） 2023年发改委令第8号"), "电能质量管理办法（暂行） 2023年发改委令第8号");
  assert.equal(cleanTitle("QGDW 10650.6-2019_报批稿"), "Q/GDW 10650.6-2019 报批稿");
  assert.equal(
    cleanTitle("DL_T 1368-2014[电能质量_span style=_color_ red;__标准源__span_校准规范]"),
    "DL/T 1368-2014 电能质量标准源校准规范"
  );
  // 不该动的：年份开头的标题、正文里的括号
  assert.equal(cleanTitle("2018 500kV XLPE 海底电缆线路参数"), "2018 500kV XLPE 海底电缆线路参数");
  assert.equal(cleanTitle("电能质量管理办法（暂行）"), "电能质量管理办法（暂行）");
});

test("kb_retitle cleans one document, rebuilds the merged title and keeps history", async () => {
  const { root, kbDir, tools, exec } = await setup();
  try {
    const src = join(root, "资料.md");
    await writeFile(src, "# 概述\n\n电能质量治理流程。\n", "utf8");
    const imported = await tools.get("kb_import").execute(
      { path: src, kb: "测试库", title: "1. 电能质量资料_www.upbz.net" },
      exec
    );
    const docId = imported.imported[0].docId;

    const preview = await tools.get("kb_retitle").execute({ kb: "测试库", doc: docId }, exec);
    assert.equal(preview.dryRun, false);
    assert.equal(preview.applied, 1);
    assert.equal(preview.changes[0].to, "电能质量资料");

    const manifest = await readManifest(kbDir);
    const doc = manifest.docs.find((d) => d.id === docId);
    assert.equal(doc.title, "电能质量资料");
    assert.equal(doc.version, 2);
    assert.equal(doc.history.length, 1);
    assert.equal(doc.history[0].reason, "retitle");

    const merged = await readFile(join(kbDir, "markdown", docId, `${docId}.md`), "utf8");
    assert.match(merged, /^# 电能质量资料\n/);
    const log = await readFile(join(kbDir, "log.md"), "utf8");
    assert.match(log, /retitle/);

    const read = await tools.get("kb_read").execute({ kb: "测试库", doc: docId, part: 1 }, exec);
    assert.equal(read.title, "电能质量资料");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bulk retitle defaults to dry-run and only applies when asked", async () => {
  const { root, kbDir, tools, exec } = await setup();
  try {
    for (const [name, title] of [
      ["a.md", "GB_T 11032-2020 电压_www.upbz.net"],
      ["b.md", "2. 供电营业规则"],
    ]) {
      const src = join(root, name);
      await writeFile(src, "# 内容\n\n测试正文。\n", "utf8");
      await tools.get("kb_import").execute({ path: src, kb: "测试库", title }, exec);
    }
    const preview = await tools.get("kb_retitle").execute(
      { kb: "测试库", all: true },
      exec
    );
    assert.equal(preview.dryRun, true);
    assert.equal(preview.applied, 0);
    assert.equal(preview.total, 2);
    let manifest = await readManifest(kbDir);
    assert.ok(manifest.docs.some((d) => d.title === "GB_T 11032-2020 电压_www.upbz.net"));

    const applied = await tools.get("kb_retitle").execute(
      { kb: "测试库", all: true, dryRun: false },
      exec
    );
    assert.equal(applied.dryRun, false);
    assert.equal(applied.applied, 2);
    manifest = await readManifest(kbDir);
    assert.ok(manifest.docs.some((d) => d.title === "GB/T 11032-2020 电压"));
    assert.ok(manifest.docs.some((d) => d.title === "供电营业规则"));
    assert.equal(manifest.docs.every((d) => d.status === "ready" && d.version >= 2), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_retitle requires doc or all", async () => {
  const { root, tools, exec } = await setup();
  try {
    await assert.rejects(() => tools.get("kb_retitle").execute({ kb: "测试库" }, exec), /doc.*all/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
