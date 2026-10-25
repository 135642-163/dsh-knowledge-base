/**
 * 0.26 sources：kb_query/kb_read 返回结构化来源、深链与 presentationMeta。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { readManifest, writeManifestAtomic } from "../lib/store.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-sources-"));
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
        child.stdout.on("data", (chunk) => { out = Buffer.concat([out, chunk]); });
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
  const src = join(root, "a.md");
  await writeFile(src, "# 概述\n\n## 5.2.2 电压偏差\n\n电压偏差不应超过限值。\n", "utf8");
  const imported = await tools.get("kb_import").execute(
    { path: src, kb: "测试库", title: "GB/T 12325-2008 电压偏差" },
    exec
  );
  return { root, kbDir: join(kbRoot, "测试库"), tools, exec, docId: imported.imported[0].docId };
}

test("kb_query output carries sources with deepLink and clause", async () => {
  const { root, tools, exec, docId } = await setup();
  try {
    const result = await tools.get("kb_query").execute({ kb: "测试库", pattern: "电压偏差" }, exec);
    assert.ok(result.sources.length >= 1);
    const source = result.sources[0];
    assert.equal(source.kb, "测试库");
    assert.equal(source.docId, docId);
    assert.match(source.deepLink, /^\/kb\/\?kb=/);
    assert.match(source.deepLink, new RegExp(`doc=${docId}`));
    assert.ok(source.snippet.length <= 160);
    const meta = tools.get("kb_query").output.presentationMeta({ pattern: "电压偏差" }, result);
    assert.equal(meta.sources.length, result.sources.length);
    const text = tools.get("kb_query").output.render({ kb: "测试库", pattern: "电压偏差" }, result)[0].text;
    assert.match(text, /来源：/);
    assert.match(text, /电压偏差/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_read sources include page after part index is updated", async () => {
  const { root, kbDir, tools, exec, docId } = await setup();
  try {
    const manifest = await readManifest(kbDir);
    const indexFile = join(kbDir, "markdown", docId, "parts", "index.json");
    const index = JSON.parse(await (await import("node:fs/promises")).readFile(indexFile, "utf8"));
    index[0].pageStart = 3;
    index[0].pageEnd = 4;
    await writeFile(indexFile, JSON.stringify(index, null, 2), "utf8");
    const doc = manifest.docs.find((item) => item.id === docId);
    doc.pages = 10;
    await writeManifestAtomic(kbDir, manifest);

    const read = await tools.get("kb_read").execute({ kb: "测试库", doc: docId, part: 1 }, exec);
    assert.equal(read.sources.length, 1);
    assert.equal(read.sources[0].page, 3);
    assert.equal(read.sources[0].pageEnd, 4);
    assert.match(read.sources[0].deepLink, /page=3/);
    assert.equal(tools.get("kb_read").output.presentationMeta({}, read).sources.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_read virtual documents have empty sources", async () => {
  const { root, tools, exec } = await setup();
  try {
    const read = await tools.get("kb_read").execute({ kb: "测试库", doc: "schema", part: 1 }, exec);
    assert.deepEqual(read.sources, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
