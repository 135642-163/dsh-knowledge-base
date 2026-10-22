/**
 * 工具级：标题相似的文件必须照常导入，并在结果与渲染里提示确认。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

test("similar title is imported and surfaced to the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-similar-"));
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

    const exec = {
      agent: { session: { header: { cwd: root } } },
      signal: new AbortController().signal,
    };
    await tools.get("kb_add_note").execute(
      {
        kb: "测试库",
        title: "电能质量评估技术导则",
        content: "## 一\n\n这是已有导则。",
      },
      exec
    );

    const src = join(root, "电能质量评估技术导则（试行）.txt");
    await writeFile(src, "试行版正文。\n", "utf8");
    const args = { path: src, kb: "测试库", title: "电能质量评估技术导则（试行）" };
    const r = await tools.get("kb_import").execute(args, exec);

    assert.equal(r.similar?.length, 1);
    assert.equal(r.similar[0].title, "电能质量评估技术导则（试行）");
    assert.equal(r.imported.length, 1, "similar file must still be imported");
    const rendered = tools.get("kb_import").output.render(args, r)[0].text;
    assert.match(rendered, /相似/);
    assert.match(rendered, /已照常导入/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
