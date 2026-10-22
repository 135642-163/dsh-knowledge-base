/**
 * 0.15.0 批量事务编辑：
 * - 先全量校验再写入；任一条失败整批不改；
 * - 全部成功才更新清单（版本号一次性+1）；
 * - dryRun 只校验；同一文档重复出现被拒绝。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { readManifest } from "../lib/store.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-edit-batch-"));
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
  for (const [name, text] of [["a.md", "AAAA 第一段。"], ["b.md", "BBBB 第二段。"]]) {
    const src = join(root, name);
    await writeFile(src, `# 标题\n\n${text}\n`, "utf8");
    const r = await tools.get("kb_import").execute({ path: src, kb: "测试库", title: name.replace(".md", "") }, exec);
    ids.push(r.imported[0].docId);
  }
  return { root, kbDir: join(kbRoot, "测试库"), tools, exec, ids };
}

test("batch edit validates first, applies atomically and bumps versions once", async () => {
  const { root, kbDir, tools, exec, ids } = await setup();
  try {
    const [a, b] = ids;
    const dry = await tools.get("kb_edit_batch").execute(
      {
        kb: "测试库",
        dryRun: true,
        edits: [
          { doc: a, old_string: "AAAA", new_string: "A2" },
          { doc: b, old_string: "BBBB", new_string: "B2" },
        ],
      },
      exec
    );
    assert.equal(dry.dryRun, true);
    assert.equal(dry.applied, 0);
    assert.equal(dry.results.length, 2);
    let manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.find((d) => d.id === a).version, 1);

    const applied = await tools.get("kb_edit_batch").execute(
      {
        kb: "测试库",
        edits: [
          { doc: a, old_string: "AAAA", new_string: "A2" },
          { doc: b, old_string: "BBBB", new_string: "B2" },
        ],
      },
      exec
    );
    assert.equal(applied.applied, 2);
    manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.find((d) => d.id === a).version, 2);
    assert.equal(manifest.docs.find((d) => d.id === b).version, 2);
    const mergedA = await readFile(join(kbDir, "markdown", a, `${a}.md`), "utf8");
    assert.match(mergedA, /A2/);
    const log = await readFile(join(kbDir, "log.md"), "utf8");
    assert.equal((log.match(/edit-batch/g) ?? []).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a single bad edit aborts the whole batch", async () => {
  const { root, kbDir, tools, exec, ids } = await setup();
  try {
    const [a, b] = ids;
    await assert.rejects(
      () =>
        tools.get("kb_edit_batch").execute(
          {
            kb: "测试库",
            edits: [
              { doc: a, old_string: "AAAA", new_string: "A3" },
              { doc: b, old_string: "NOT-THERE", new_string: "x" },
            ],
          },
          exec
        ),
      /找不到/
    );
    const manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.find((d) => d.id === a).version, 1, "no doc may be bumped");
    const mergedA = await readFile(join(kbDir, "markdown", a, `${a}.md`), "utf8");
    assert.match(mergedA, /AAAA/, "first doc must be untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same document cannot appear twice in one batch", async () => {
  const { root, tools, exec, ids } = await setup();
  try {
    await assert.rejects(
      () =>
        tools.get("kb_edit_batch").execute(
          {
            kb: "测试库",
            edits: [
              { doc: ids[0], old_string: "AAAA", new_string: "x" },
              { doc: ids[0], old_string: "第一段", new_string: "y" },
            ],
          },
          exec
        ),
      /只能出现一次/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
