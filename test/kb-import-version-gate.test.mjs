import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

test("同号不同年份导入先暂停，allowSameNumber 后入库", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-version-gate-"));
  try {
    const kbRoot = join(root, "kb-root");
    await mkdir(kbRoot, { recursive: true });
    const tools = new Map();
    const ctx = {
      tools: { register(def) { tools.set(def.name, def); } },
      systemPrompt: { section() {} },
      get() { return undefined; },
    };
    await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 2000 });
    const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };

    const oldPath = join(root, "old.txt");
    await writeFile(oldPath, "2008 版正文。\n", "utf8");
    const first = await tools.get("kb_import").execute(
      { path: oldPath, kb: "测试库", title: "GB/T 12325-2008 电能质量 供电电压偏差" },
      exec
    );
    assert.equal(first.imported.length, 1);

    const newPath = join(root, "new.txt");
    await writeFile(newPath, "2019 版正文。\n", "utf8");
    const blocked = await tools.get("kb_import").execute(
      { path: newPath, kb: "测试库", title: "GB/T 12325-2019 电能质量 供电电压偏差" },
      exec
    );
    assert.equal(blocked.imported.length, 0);
    assert.equal(blocked.versionConflicts.length, 1);
    assert.equal(blocked.versionConflicts[0].reason, "different-year");
    assert.equal(blocked.versionConfirmed, false);
    const rendered = tools.get("kb_import").output.render({}, blocked)[0].text;
    assert.match(rendered, /版本检查/);
    assert.match(rendered, /已暂停/);

    let manifest = JSON.parse(await readFile(join(kbRoot, "测试库", "kb.json"), "utf8"));
    assert.equal(manifest.docs.filter((d) => d.status !== "deleted").length, 1, "blocked file must not be written");

    const allowed = await tools.get("kb_import").execute(
      { path: newPath, kb: "测试库", title: "GB/T 12325-2019 电能质量 供电电压偏差", allowSameNumber: true },
      exec
    );
    assert.equal(allowed.imported.length, 1);
    assert.equal(allowed.versionConfirmed, true);
    manifest = JSON.parse(await readFile(join(kbRoot, "测试库", "kb.json"), "utf8"));
    assert.equal(manifest.docs.filter((d) => d.status !== "deleted").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
