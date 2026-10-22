/**
 * 0.11.0 版本历史：编辑/覆盖前快照，kb_history 列表，kb_restore(version) 恢复。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-history-"));
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot: join(root, "kb"), defaultKb: "历史测试", partMaxChars: 500 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  return { root, tools, exec };
}

test("edit snapshots the old version and can restore it", async () => {
  const { root, tools, exec } = await setup();
  try {
    const add = await tools.get("kb_add_note").execute(
      { kb: "历史测试", title: "版本笔记", content: "旧内容。\n\n保持不变。" },
      exec
    );
    const edit = await tools.get("kb_edit").execute(
      { kb: "历史测试", doc: add.docId, old_string: "旧内容", new_string: "新内容" },
      exec
    );
    assert.equal(edit.replaced, 1);
    const v2 = await tools.get("kb_read").execute({ kb: "历史测试", doc: add.docId, part: 1 }, exec);
    assert.match(v2.text, /新内容/);
    assert.doesNotMatch(v2.text, /旧内容/);

    const history = await tools.get("kb_history").execute(
      { kb: "历史测试", doc: add.docId },
      exec
    );
    assert.equal(history.currentVersion, 2);
    assert.equal(history.history.length, 1);
    assert.equal(history.history[0].version, 1);
    assert.match(
      tools.get("kb_history").output.render({}, history)[0].text,
      /v1 .*edit/
    );

    const restored = await tools.get("kb_restore").execute(
      { kb: "历史测试", doc: add.docId, version: 1 },
      exec
    );
    assert.equal(restored.fromVersion, 1);
    assert.equal(restored.version, 3);
    const old = await tools.get("kb_read").execute({ kb: "历史测试", doc: add.docId, part: 1 }, exec);
    assert.match(old.text, /旧内容/);
    assert.doesNotMatch(old.text, /新内容/);

    const after = await tools.get("kb_history").execute(
      { kb: "历史测试", doc: add.docId },
      exec
    );
    assert.equal(after.currentVersion, 3);
    assert.deepEqual(
      after.history.map((h) => h.version),
      [1, 2]
    );

    const listed = await tools.get("kb_list").execute({ kb: "历史测试" }, exec);
    assert.equal(listed.docs.find((d) => d.id === add.docId).historyCount, 2);

    await assert.rejects(
      () =>
        tools.get("kb_restore").execute(
          { kb: "历史测试", doc: add.docId, version: 99 },
          exec
        ),
      /历史版本不存在/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("re-import snapshots the previous version", async () => {
  const { root, tools, exec } = await setup();
  try {
    const src = join(root, "资料.txt");
    await writeFile(src, "第一版内容。\n", "utf8");
    const first = await tools.get("kb_import").execute(
      { path: src, kb: "历史测试", title: "资料" },
      exec
    );
    const docId = first.imported[0].docId;
    await writeFile(src, "第二版内容。\n", "utf8");
    const second = await tools.get("kb_import").execute(
      { path: src, kb: "历史测试", title: "资料" },
      exec
    );
    assert.equal(second.imported[0].docId, docId);
    const history = await tools.get("kb_history").execute(
      { kb: "历史测试", doc: docId },
      exec
    );
    assert.equal(history.history.length, 1);
    assert.equal(history.history[0].version, 1);
    assert.match(
      (await tools.get("kb_read").execute({ kb: "历史测试", doc: docId, part: 1 }, exec)).text,
      /第二版内容/
    );
    await tools.get("kb_restore").execute(
      { kb: "历史测试", doc: docId, version: 1 },
      exec
    );
    assert.match(
      (await tools.get("kb_read").execute({ kb: "历史测试", doc: docId, part: 1 }, exec)).text,
      /第一版内容/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
