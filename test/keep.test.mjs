/**
 * 0.18.0「已核对保留」：
 * - kb_keep 标记/清除，只改元数据；
 * - kb_lint 对整组已标记的重复不再报，计数进 dedupKeptGroups；
 * - kb_list/kb_read 显示标记。
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
  const root = await mkdtemp(join(tmpdir(), "kb-keep-"));
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
  const ids = [];
  const first = join(root, "a.md");
  await writeFile(first, "# 正文\n\n继电保护通用技术条件。\n", "utf8");
  const r1 = await tools.get("kb_import").execute(
    { path: first, kb: "测试库", title: "DL/T 478-2013 继电保护通用技术条件" },
    exec
  );
  ids.push(r1.imported[0].docId);
  // 同库同号/同年会被查重跳过；先以占位编号导入，再改标题成同号文档。
  const second = join(root, "b.md");
  await writeFile(second, "# 正文\n\n继电保护装置检验规程。\n", "utf8");
  const r2 = await tools.get("kb_import").execute(
    { path: second, kb: "测试库", title: "GB/T 9999-2013 临时占位" },
    exec
  );
  const secondId = r2.imported[0].docId;
  await tools.get("kb_retitle").execute(
    { kb: "测试库", doc: secondId, title: "DL/T 478-2013 继电保护装置检验规程" },
    exec
  );
  ids.push(secondId);
  return { root, kbDir: join(kbRoot, "测试库"), tools, exec, ids };
}

test("kb_keep marks a reviewed duplicate group and lint stops reporting it", async () => {
  const { root, kbDir, tools, exec, ids } = await setup();
  try {
    let manifest = await readManifest(kbDir);
    let report = lintManifest(manifest, { kbName: "测试库", hasSchema: true, now: Date.now() });
    assert.equal(report.counts.sameNumberDuplicateGroups, 1);

    const preview = await tools.get("kb_keep").execute(
      { kb: "测试库", docs: ids, note: "扫描版 + OCR 版，均保留", dryRun: true },
      exec
    );
    assert.equal(preview.updated, 0);
    assert.equal(preview.dryRun, true);

    const applied = await tools.get("kb_keep").execute(
      { kb: "测试库", docs: ids, note: "扫描版 + OCR 版，均保留" },
      exec
    );
    assert.equal(applied.updated, 2);
    manifest = await readManifest(kbDir);
    for (const id of ids) {
      const doc = manifest.docs.find((d) => d.id === id);
      assert.equal(doc.dedupKeep, true);
      assert.equal(doc.dedupNote, "扫描版 + OCR 版，均保留");
    }
    report = lintManifest(manifest, { kbName: "测试库", hasSchema: true, now: Date.now() });
    assert.equal(report.counts.sameNumberDuplicateGroups, 0);
    assert.equal(report.counts.dedupKeptGroups, 1);

    const list = await tools.get("kb_list").execute({ kb: "测试库" }, exec);
    assert.match(tools.get("kb_list").output.render({ kb: "测试库" }, list)[0].text, /\[已核对保留\]/);
    const read = await tools.get("kb_read").execute({ kb: "测试库", doc: ids[0], part: 1 }, exec);
    assert.equal(read.dedupKeep, true);
    assert.match(tools.get("kb_read").output.render({}, read)[0].text, /已核对保留/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kb_keep clear restores lint reporting", async () => {
  const { root, kbDir, tools, exec, ids } = await setup();
  try {
    await tools.get("kb_keep").execute({ kb: "测试库", docs: ids, note: "保留" }, exec);
    await tools.get("kb_keep").execute({ kb: "测试库", docs: ids, clear: true }, exec);
    const manifest = await readManifest(kbDir);
    for (const id of ids) assert.equal(manifest.docs.find((d) => d.id === id).dedupKeep, false);
    const report = lintManifest(manifest, { kbName: "测试库", hasSchema: true, now: Date.now() });
    assert.equal(report.counts.sameNumberDuplicateGroups, 1);
    assert.equal(report.counts.dedupKeptGroups, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
