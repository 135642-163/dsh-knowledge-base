/**
 * 0.15.1 存量摘要回填：kb_describe(all=true, auto=true)
 * - 只回填“没有摘要”的 ready 文档，从合并版正文抽第一段；
 * - 不覆盖模型摘要、不递增内容版本号；
 * - limit 分批，remaining 反映真实剩余。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { readManifest } from "../lib/store.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-describe-auto-"));
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
  const ids = [];
  for (const [name, body] of [
    ["甲.md", "本文介绍电能质量治理的基本流程与常见问题，先测量再治理。"],
    ["乙.md", "本文说明电压暂降的测量方法和统计口径，用于现场评估。"],
  ]) {
    const src = join(root, name);
    await writeFile(src, `# 概述\n\n${body}\n`, "utf8");
    const r = await tools.get("kb_import").execute({ path: src, kb: "测试库", title: name.replace(".md", "") }, exec);
    ids.push(r.imported[0].docId);
  }
  return { root, kbDir: join(kbRoot, "测试库"), tools, exec, ids };
}

test("auto backfill fills missing summaries without bumping versions", async () => {
  const { root, kbDir, tools, exec, ids } = await setup();
  try {
    const [a] = ids;
    await tools.get("kb_describe").execute({ kb: "测试库", doc: a, clear: true }, exec);
    const cleared = await readManifest(kbDir);
    assert.equal(cleared.docs.find((d) => d.id === a).summary, "");

    const r = await tools.get("kb_describe").execute(
      { kb: "测试库", all: true, auto: true, limit: 10 },
      exec
    );
    assert.equal(r.mode, "auto");
    assert.ok(r.updated >= 1);
    const manifest = await readManifest(kbDir);
    const doc = manifest.docs.find((d) => d.id === a);
    assert.match(doc.summary, /电能质量治理/);
    assert.equal(doc.summarySource, "auto");
    assert.equal(doc.version, 1, "metadata-only update must not bump version");
    const log = await readFile(join(kbDir, "log.md"), "utf8");
    assert.match(log, /describe-auto/);
    const index = await readFile(join(kbDir, "index.md"), "utf8");
    assert.match(index, /电能质量治理/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto backfill skips model summaries and honours limit/remaining", async () => {
  const { root, kbDir, tools, exec, ids } = await setup();
  try {
    const [a, b] = ids;
    await tools.get("kb_describe").execute(
      { kb: "测试库", doc: a, summary: "模型写的摘要", tags: ["保留"] },
      exec
    );
    await tools.get("kb_describe").execute({ kb: "测试库", doc: b, clear: true }, exec);

    // 只有 b 是空摘要，a 是模型摘要（不参与回填）
    const first = await tools.get("kb_describe").execute(
      { kb: "测试库", all: true, auto: true, limit: 1 },
      exec
    );
    assert.equal(first.updated, 1);
    assert.equal(first.remaining, 0);

    let manifest = await readManifest(kbDir);
    const docA = manifest.docs.find((d) => d.id === a);
    assert.equal(docA.summary, "模型写的摘要", "model summary must not be overwritten");
    assert.equal(docA.summarySource, "model");
    assert.deepEqual(docA.tags, ["保留"]);

    // 两篇都清空后，验证 limit 与 remaining
    await tools.get("kb_describe").execute({ kb: "测试库", doc: a, clear: true }, exec);
    await tools.get("kb_describe").execute({ kb: "测试库", doc: b, clear: true }, exec);
    const limited = await tools.get("kb_describe").execute(
      { kb: "测试库", all: true, auto: true, limit: 1 },
      exec
    );
    assert.equal(limited.updated, 1);
    assert.equal(limited.remaining, 1);

    const second = await tools.get("kb_describe").execute(
      { kb: "测试库", all: true, auto: true, limit: 1 },
      exec
    );
    assert.equal(second.updated, 1);
    assert.equal(second.remaining, 0);

    manifest = await readManifest(kbDir);
    assert.ok(manifest.docs.every((d) => d.summarySource === "auto" && d.summary.length > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto mode requires the auto flag", async () => {
  const { root, tools, exec } = await setup();
  try {
    await assert.rejects(
      () => tools.get("kb_describe").execute({ kb: "测试库", all: true }, exec),
      /auto=true/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
