/**
 * 0.16.0 可信度标签：
 * - kb_trust 单篇/批量/stage 过滤；批量默认 dryRun；
 * - kb_list 过滤与标注、kb_read 头部、kb_query 排序与低可信提醒；
 * - 清单 v4 迁移默认 unknown。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { readManifest } from "../lib/store.js";
import { lintManifest } from "../lib/lint.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-trust-"));
  const kbRoot = join(root, "kb-root");
  await mkdir(kbRoot, { recursive: true });
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
    subprocess: {
      spawn({ argv, cwd }) {
        const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = Buffer.alloc(0);
        child.stdout.on("data", (d) => { out = Buffer.concat([out, d]); });
        const done = new Promise((resolve) => child.on("close", (exitCode, signal) => resolve({ exitCode, signal })));
        return {
          done,
          collected: {
            stdout: { readFrom: (off) => ({ text: out.subarray(off).toString("utf8"), nextOffset: out.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
          },
          terminate: () => child.kill(),
        };
      },
    },
  };
  await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 500 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  const ids = {};
  for (const [key, file, title, body] of [
    ["published", "a.md", "GB/T 12325-2008 电压偏差", "供电电压偏差的标准正文。"],
    ["draft", "b.md", "GB/T 12325-2025 电压偏差（征求意见稿）", "征求意见稿的电压偏差条文。"],
  ]) {
    const src = join(root, file);
    await writeFile(src, `# 概述\n\n${body}\n`, "utf8");
    const r = await tools.get("kb_import").execute({ path: src, kb: "测试库", title }, exec);
    ids[key] = r.imported[0].docId;
  }
  return { root, kbDir: join(kbRoot, "测试库"), tools, exec, ids };
}

test("kb_trust labels a doc and surfaces it in list/read", async () => {
  const { root, kbDir, tools, exec, ids } = await setup();
  try {
    const r = await tools.get("kb_trust").execute(
      { kb: "测试库", doc: ids.published, level: "high", reason: "现行发布标准" },
      exec
    );
    assert.equal(r.updated, 1);
    const manifest = await readManifest(kbDir);
    const doc = manifest.docs.find((d) => d.id === ids.published);
    assert.equal(doc.trust, "high");
    assert.equal(doc.trustReason, "现行发布标准");

    const list = await tools.get("kb_list").execute({ kb: "测试库", trust: "high" }, exec);
    assert.equal(list.total, 1);
    assert.match(tools.get("kb_list").output.render({ kb: "测试库" }, list)[0].text, /\[可信度:高\]/);

    const read = await tools.get("kb_read").execute({ kb: "测试库", doc: ids.published, part: 1 }, exec);
    assert.equal(read.trust, "high");
    assert.match(tools.get("kb_read").output.render({}, read)[0].text, /可信度:高/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bulk trust defaults to dry-run and supports stage filters", async () => {
  const { root, kbDir, tools, exec } = await setup();
  try {
    const preview = await tools.get("kb_trust").execute(
      { kb: "测试库", all: true, stage: "draft", level: "low", reason: "征求意见稿" },
      exec
    );
    assert.equal(preview.dryRun, true);
    assert.equal(preview.total, 1);
    assert.equal(preview.updated, 0);
    let manifest = await readManifest(kbDir);
    assert.ok(manifest.docs.every((d) => d.trust === "unknown"));

    const applied = await tools.get("kb_trust").execute(
      { kb: "测试库", all: true, stage: "draft", level: "low", reason: "征求意见稿", dryRun: false },
      exec
    );
    assert.equal(applied.updated, 1);
    manifest = await readManifest(kbDir);
    const drafts = manifest.docs.filter((d) => d.trust === "low");
    assert.equal(drafts.length, 1);
    assert.match(drafts[0].title, /征求意见稿/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("query labels trust, ranks high above low and warns about low trust", async () => {
  const { root, tools, exec, ids } = await setup();
  try {
    await tools.get("kb_trust").execute(
      { kb: "测试库", doc: ids.published, level: "high", reason: "现行" },
      exec
    );
    await tools.get("kb_trust").execute(
      { kb: "测试库", doc: ids.draft, level: "low", reason: "征求意见稿" },
      exec
    );
    const r = await tools.get("kb_query").execute({ kb: "测试库", pattern: "电压偏差" }, exec);
    assert.ok(r.matches.length >= 2);
    assert.equal(r.matches[0].docId, ids.published, "high trust should rank first");
    assert.equal(r.matches[0].trust, "high");
    const text = tools.get("kb_query").output.render({ kb: "测试库" }, r)[0].text;
    assert.match(text, /\[可信度:高\]/);
    assert.match(text, /低可信度/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown clears trust and lint reports untagged docs", async () => {
  const { root, kbDir, tools, exec, ids } = await setup();
  try {
    await tools.get("kb_trust").execute(
      { kb: "测试库", doc: ids.published, level: "high", reason: "现行" },
      exec
    );
    await tools.get("kb_trust").execute(
      { kb: "测试库", doc: ids.published, level: "unknown", dryRun: false },
      exec
    );
    const manifest = await readManifest(kbDir);
    const doc = manifest.docs.find((d) => d.id === ids.published);
    assert.equal(doc.trust, "unknown");
    assert.equal(doc.trustReason, "");

    const report = lintManifest(manifest, { kbName: "测试库", hasSchema: true, now: Date.now() });
    assert.equal(report.counts.trustUnknown, 2);
    assert.ok(report.groups.some((g) => g.code === "trust-unknown"));
    assert.ok(report.suggestions.some((s) => s.action === "kb_trust"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
