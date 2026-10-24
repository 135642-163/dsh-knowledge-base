/**
 * 21 个工具的范围矩阵（表驱动）。setup 里的导入/建库都用无 session 的 exec（fail-open）。
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
  const root = await mkdtemp(join(tmpdir(), "kb-scope-tools-"));
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
  await apply(ctx, { kbRoot, defaultKb: "default", partMaxChars: 500 });
  const unscoped = { agent: { session: { header: { cwd: root } } }, signal: SIGNAL };
  const scoped = (sessionId, parentSession) => ({
    agent: { session: { id: sessionId, header: { cwd: root, parentSession } } },
    signal: SIGNAL,
  });
  async function importDoc(fileName, text, kb, title) {
    const path = join(root, fileName);
    await writeFile(path, text, "utf8");
    const result = await tools.get("kb_import").execute({ path, kb, title }, unscoped);
    return result.imported?.[0];
  }
  const scope = (sessionId, kbs) =>
    writeScopes(kbRoot, {
      scopes: { [sessionId]: { mode: "selected", kbs, updatedAt: new Date().toISOString() } },
    });
  const all = (sessionId) =>
    writeScopes(kbRoot, { scopes: { [sessionId]: { mode: "all", kbs: [], updatedAt: new Date().toISOString() } } });
  return { root, kbRoot, tools, unscoped, scoped, importDoc, scope, all };
}

test("kb_list in all mode lists every kb and reports scope", async () => {
  const { tools, scoped, importDoc } = await setup();
  await importDoc("a.md", "# A\n\n甲资料。\n", "甲库", "甲文档");
  await importDoc("b.md", "# B\n\n乙资料。\n", "乙库", "乙文档");
  const result = await tools.get("kb_list").execute({}, scoped("s1"));
  assert.deepEqual(result.kbs.map((kb) => kb.name).sort(), ["乙库", "甲库"]);
  assert.deepEqual(result.scope, { mode: "all", kbs: [] });
});

test("kb_list in selected mode hides other kbs", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# A\n\n甲资料。\n", "甲库", "甲文档");
  await importDoc("b.md", "# B\n\n乙资料。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  const result = await tools.get("kb_list").execute({}, scoped("s1"));
  assert.deepEqual(result.kbs.map((kb) => kb.name), ["甲库"]);
  assert.deepEqual(result.scope, { mode: "selected", kbs: ["甲库"] });
});

test("kb_list rejects an explicit out-of-scope kb", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# A\n\n甲资料。\n", "甲库", "甲文档");
  await importDoc("b.md", "# B\n\n乙资料。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  await assert.rejects(
    () => tools.get("kb_list").execute({ kb: "乙库" }, scoped("s1")),
    (error) => error.code === "KB_OUT_OF_SCOPE" && error.message.includes("乙库")
  );
});

test("kb_query rejects an explicit out-of-scope kb", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# A\n\n继电保护甲。\n", "甲库", "甲文档");
  await importDoc("b.md", "# B\n\n继电保护乙。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  await assert.rejects(
    () => tools.get("kb_query").execute({ pattern: "继电保护", kb: "乙库" }, scoped("s1")),
    (error) => error.code === "KB_OUT_OF_SCOPE"
  );
});

test("kb_query omitted in selected mode searches only the scope", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# A\n\n继电保护甲。\n", "甲库", "甲文档");
  await importDoc("b.md", "# B\n\n继电保护乙。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  const result = await tools.get("kb_query").execute({ pattern: "继电保护" }, scoped("s1"));
  assert.deepEqual([...result.searchedKbs].sort(), ["乙库", "甲库"]);
  assert.deepEqual(result.scope, { mode: "selected", kbs: ["甲库", "乙库"] });
});

test("kb_query * in selected mode only searches scope kbs", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# A\n\n继电保护甲。\n", "甲库", "甲文档");
  await importDoc("b.md", "# B\n\n继电保护乙。\n", "乙库", "乙文档");
  await scope("s1", ["乙库"]);
  const result = await tools.get("kb_query").execute({ pattern: "继电保护", kb: "*" }, scoped("s1"));
  assert.deepEqual(result.searchedKbs, ["乙库"]);
  assert.ok(result.matches.every((match) => match.kb === "乙库"));
});

test("kb_query omitted in all mode keeps defaultKb behavior", async () => {
  const { tools, scoped, importDoc } = await setup();
  await importDoc("a.md", "# A\n\n继电保护甲。\n", "default", "默认库文档");
  const result = await tools.get("kb_query").execute({ pattern: "继电保护" }, scoped("s1"));
  assert.equal(result.kb, "default");
  assert.deepEqual(result.searchedKbs, undefined);
});

test("kb_query rejects doc together with cross-kb search", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# A\n\n甲。\n", "甲库", "甲文档");
  await importDoc("b.md", "# B\n\n乙。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  await assert.rejects(
    () => tools.get("kb_query").execute({ pattern: "甲", doc: "甲文档" }, scoped("s1")),
    /doc 只能用于单个知识库/
  );
});
