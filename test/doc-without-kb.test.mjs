/**
 * 0.37：kb_query / kb_reparse 只给 doc、不给 kb 时，按会话范围解析唯一文档。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { writeScopes } from "../lib/scope-store.js";

const SIGNAL = new AbortController().signal;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-doc-nokb-"));
  const kbRoot = join(root, "kb");
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
  await apply(ctx, { kbRoot, defaultKb: "default", partMaxChars: 500, scopeTtlDays: 30 });
  const unscoped = { agent: { session: { header: { cwd: root } } }, signal: SIGNAL };
  const scoped = (sessionId) => ({ agent: { session: { id: sessionId, header: { cwd: root } } }, signal: SIGNAL });
  async function importDoc(fileName, text, kb, title) {
    const path = join(root, fileName);
    await writeFile(path, text, "utf8");
    const result = await tools.get("kb_import").execute({ path, kb, title }, unscoped);
    return result.imported?.[0];
  }
  const select = (sessionId, kbs) =>
    writeScopes(kbRoot, { scopes: { [sessionId]: { mode: "selected", kbs, updatedAt: new Date().toISOString() } } });
  return { root, tools, unscoped, scoped, importDoc, select };
}

test("kb_query 只给 doc 不给 kb：全部 / 多库已选范围都能解析唯一文档", async () => {
  const { tools, scoped, importDoc, select } = await setup();
  await importDoc("a.md", "# 甲文档\n\n甲资料正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙文档\n\n乙资料正文。\n", "乙库", "乙文档");

  const allMode = await tools.get("kb_query").execute({ pattern: "甲资料", doc: "甲文档" }, scoped("s1"));
  assert.equal(allMode.kb, "甲库");

  await select("s1", ["甲库", "乙库"]);
  const selected = await tools.get("kb_query").execute({ pattern: "乙资料", doc: "乙文档" }, scoped("s1"));
  assert.equal(selected.kb, "乙库");
});

test("kb_query 只给 doc 不给 kb：多个库同名文档时报歧义", async () => {
  const { tools, scoped, importDoc, select } = await setup();
  await importDoc("a.md", "# 同名文档\n\n甲库正文。\n", "甲库", "同名文档");
  await importDoc("b.md", "# 同名文档\n\n乙库正文。\n", "乙库", "同名文档");
  await select("s1", ["甲库", "乙库"]);
  await assert.rejects(
    tools.get("kb_query").execute({ pattern: "正文", doc: "同名文档" }, scoped("s1")),
    (error) => error.code === "KB_AMBIGUOUS"
  );
});

test("kb_reparse 只给 doc 不给 kb 时同样按范围解析", async () => {
  const { tools, scoped, importDoc } = await setup();
  await importDoc("a.md", "# 甲文档\n\n甲资料正文。\n", "甲库", "甲文档");
  const result = await tools.get("kb_reparse").execute({ doc: "甲文档" }, scoped("s1"));
  assert.equal(result.kb, "甲库");
  assert.ok(result.docs >= 1);
});
