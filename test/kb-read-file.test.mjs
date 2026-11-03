/**
 * 0.40 读取本机文件 ≠ 导入：kb_read_file 只返回临时文本，不建库、不写盘。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-read-file-"));
  const kbRoot = join(root, "kb");
  const tools = new Map();
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
  };
  await apply(ctx, { kbRoot, defaultKb: "默认库", partMaxChars: 500 });
  const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
  return { root, kbRoot, tools, exec };
}

test("kb_read_file 返回临时文本且不创建知识库", async (t) => {
  const { root, kbRoot, tools, exec } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "sample.md");
  await writeFile(file, "# 本地标题\n\n这段内容只应被读取，不应进入知识库。\n", "utf8");
  const result = await tools.get("kb_read_file").execute({ path: file }, exec);
  assert.equal(result.readOnly, true);
  assert.equal(result.file, "sample.md");
  assert.match(result.text, /只应被读取/);
  assert.doesNotMatch(result.text, /知识库文档/);
  assert.match(tools.get("kb_read_file").output.render({}, result)[0].text, /只读预览，未导入知识库/);

  const entries = await readdir(kbRoot);
  assert.deepEqual(entries.filter((name) => !name.startsWith(".")), [], "不应创建任何知识库目录");
});

test("kb_read_file 支持截断与目录/类型校验", async (t) => {
  const { root, tools, exec } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "long.txt");
  await writeFile(file, "0123456789".repeat(600), "utf8");
  const short = await tools.get("kb_read_file").execute({ path: file, maxChars: 600 }, exec);
  assert.equal(short.truncated, true);
  assert.equal(short.text.length, 600);

  const dir = join(root, "folder");
  await mkdir(dir, { recursive: true });
  await assert.rejects(() => tools.get("kb_read_file").execute({ path: dir }, exec), /只读取单个文件/);

  const unsupported = join(root, "a.exe");
  await writeFile(unsupported, "x", "utf8");
  await assert.rejects(() => tools.get("kb_read_file").execute({ path: unsupported }, exec), /不支持的文件类型/);
});
