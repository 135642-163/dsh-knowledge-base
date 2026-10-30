/**
 * 0.31.3 标题统一为「标准号 + 名称」：helper + kb_retitle 的 standardPrefix 批量模式。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { withStandardPrefix } from "../lib/doc-meta.js";
import { createKb } from "../lib/kbmeta.js";
import { readManifest } from "../lib/store.js";

function makeCtx() {
  const tools = new Map();
  return {
    tools,
    ctx: {
      tools: { register(def) { tools.set(def.name, def); } },
      systemPrompt: { section() {} },
      get() { return undefined; },
      logger: { warn() {} },
      subprocess: { spawn() { throw new Error("not used"); } },
    },
  };
}

const exec = {
  agent: { session: { header: { cwd: "/tmp" } } },
  signal: new AbortController().signal,
};

test("withStandardPrefix：补编号、去旧编号、幂等、无标准号不动", () => {
  assert.equal(
    withStandardPrefix("标准编写规则 第10部分：产品标准", "GB/T 20001.10-2014（发布稿）"),
    "GB/T 20001.10-2014 标准编写规则 第10部分：产品标准",
  );
  assert.equal(
    withStandardPrefix("GB 20001.10-2014 标准编写规则 第10部分：产品标准", "GB/T 20001.10-2014"),
    "GB/T 20001.10-2014 标准编写规则 第10部分：产品标准",
  );
  assert.equal(
    withStandardPrefix("GB/T 20001.10-2014 标准编写规则", "GB/T 20001.10-2014"),
    "GB/T 20001.10-2014 标准编写规则",
  );
  assert.equal(withStandardPrefix("DL 860.803-202X", "DL 860.803"), "DL 860.803-202X", "只剩年份时用连字符连接");
  assert.equal(withStandardPrefix("普通资料", ""), "普通资料");
  assert.equal(withStandardPrefix("GB/T 20001.10-2014", "GB/T 20001.10-2014"), "GB/T 20001.10-2014");
});

test("kb_retitle + standardPrefix：批量预览与应用都补上标准号", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-retitle-std-"));
  try {
    const kbRoot = join(root, "kb");
    const { dir } = await createKb(kbRoot, { name: "标准" });
    const manifest = JSON.parse(await readFile(join(dir, "kb.json"), "utf8"));
    manifest.docs.push({
      id: "d0",
      title: "Power quality measurement in power supply systems - Part 1",
      standardNo: "IEC 62586-1-2013",
      type: "pdf-text",
      status: "ready",
      trust: "high",
      pages: 10,
      chars: 100,
      version: 1,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    manifest.docs.push({
      id: "d1",
      title: "标准编写规则 第10部分：产品标准",
      standardNo: "GB/T 20001.10-2014（发布稿）",
      type: "pdf-text",
      status: "ready",
      trust: "high",
      pages: 18,
      chars: 100,
      version: 1,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    await writeFile(join(dir, "kb.json"), JSON.stringify(manifest), "utf8");
    await mkdir(join(dir, "markdown", "d1", "parts"), { recursive: true });
    await writeFile(
      join(dir, "markdown", "d1", "d1.md"),
      "# 标准编写规则 第10部分：产品标准\n\n正文\n",
      "utf8",
    );
    await writeFile(join(dir, "markdown", "d1", "parts", "0000.md"), "正文\n", "utf8");
    await mkdir(join(dir, "markdown", "d0"), { recursive: true });
    await writeFile(join(dir, "markdown", "d0", "d0.md"), "# Power quality measurement\n\n正文\n", "utf8");

    const { ctx, tools } = makeCtx();
    await apply(ctx, { kbRoot, defaultKb: "标准" });
    const retitle = tools.get("kb_retitle");

    const preview = await retitle.execute({ kb: "标准", all: true, standardPrefix: true }, exec);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.changes.length, 1, "英文标题先不动");
    assert.equal(preview.changes[0].docId, "d1");
    assert.equal(preview.changes[0].to, "GB/T 20001.10-2014 标准编写规则 第10部分：产品标准");

    const applied = await retitle.execute({ kb: "标准", all: true, standardPrefix: true, dryRun: false }, exec);
    assert.equal(applied.applied, 1);
    const updated = await readManifest(dir);
    assert.equal(updated.docs.find((doc) => doc.id === "d1").title, "GB/T 20001.10-2014 标准编写规则 第10部分：产品标准");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
