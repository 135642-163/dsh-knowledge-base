/**
 * 21 个工具的范围矩阵（表驱动）。setup 里的导入/建库都用无 session 的 exec（fail-open）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { apply } from "../lib/index.js";
import { KB_DISABLED, KB_DISABLED_MESSAGE } from "../lib/scope.js";
import { writeScopes } from "../lib/scope-store.js";
import { sanitizeKbName } from "../lib/store.js";

const SIGNAL = new AbortController().signal;

async function setup(config = {}) {
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
  await apply(ctx, { kbRoot, defaultKb: "default", partMaxChars: 500, scopeTtlDays: 30, ...config });
  const unscoped = { agent: { session: { header: { cwd: root } } }, signal: SIGNAL };
  const scoped = (sessionId, parentSession) => ({
    agent: { session: { id: sessionId, header: { cwd: root, parentSession } } },
    signal: SIGNAL,
  });
  async function importDoc(fileName, text, kb, title, options = {}) {
    const path = join(root, fileName);
    await writeFile(path, text, "utf8");
    const result = await tools.get("kb_import").execute({ path, kb, title, ...options }, unscoped);
    return result.imported?.[0];
  }
  const scope = (sessionId, kbs) =>
    writeScopes(kbRoot, {
      scopes: { [sessionId]: { mode: "selected", kbs, updatedAt: new Date().toISOString() } },
    });
  const all = (sessionId) =>
    writeScopes(kbRoot, { scopes: { [sessionId]: { mode: "all", kbs: [], updatedAt: new Date().toISOString() } } });
  const none = (sessionId) =>
    writeScopes(kbRoot, { scopes: { [sessionId]: { mode: "none", kbs: [], updatedAt: new Date().toISOString() } } });
  return { root, kbRoot, tools, unscoped, scoped, importDoc, scope, all, none };
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

test("kb_query and kb_list accept an explicit in-scope kb", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# A\n\n继电保护甲。\n", "甲库", "甲文档");
  await importDoc("b.md", "# B\n\n继电保护乙。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  const query = await tools.get("kb_query").execute({ pattern: "继电保护", kb: "甲库" }, scoped("s1"));
  assert.equal(query.kb, "甲库");
  assert.equal(query.searchedKbs, undefined);
  assert.deepEqual(query.scope, { mode: "selected", kbs: ["甲库"] });
  assert.ok(query.matches.every((match) => match.title === "甲文档"));
  const list = await tools.get("kb_list").execute({ kb: "甲库" }, scoped("s1"));
  assert.deepEqual(list.docs.map((doc) => doc.title), ["甲文档"]);
  assert.deepEqual(list.scope, { mode: "selected", kbs: ["甲库"] });
});

test("tools inherit scope from the parent session", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# A\n\n甲资料。\n", "甲库", "甲文档");
  await importDoc("b.md", "# B\n\n乙资料。\n", "乙库", "乙文档");
  await scope("parent", ["甲库"]);
  const result = await tools.get("kb_list").execute({}, scoped("child", "parent"));
  assert.deepEqual(result.kbs.map((kb) => kb.name), ["甲库"]);
  assert.deepEqual(result.scope, { mode: "selected", kbs: ["甲库"] });
});

test("kb_list fails open when .scopes.json is corrupt", async () => {
  const { tools, scoped, importDoc, kbRoot } = await setup();
  await importDoc("a.md", "# A\n\n甲资料。\n", "甲库", "甲文档");
  await writeFile(join(kbRoot, ".scopes.json"), "{broken", "utf8");
  const result = await tools.get("kb_list").execute({}, scoped("s1"));
  assert.deepEqual(result.kbs.map((kb) => kb.name), ["甲库"]);
  assert.deepEqual(result.scope, { mode: "all", kbs: [] });
});

test("kb_query and kb_list key scope by directory, not manifest name", async () => {
  const { tools, scoped, importDoc, scope, kbRoot } = await setup();
  await importDoc("a.md", "# A\n\n继电保护甲。\n", "甲库", "甲文档");
  await importDoc("b.md", "# B\n\n继电保护AAA。\n", "AAA", "AAA文档");
  const realDir = join(kbRoot, "甲库");
  const fakeDir = join(kbRoot, "AAA");
  const realManifest = JSON.parse(await readFile(join(realDir, "kb.json"), "utf8"));
  const fakeManifest = JSON.parse(await readFile(join(fakeDir, "kb.json"), "utf8"));
  // 目录名与 manifest.name 互换：甲库/ 的清单名叫 AAA，AAA/ 的清单名叫 甲库
  await writeFile(join(realDir, "kb.json"), JSON.stringify({ ...realManifest, name: "AAA" }), "utf8");
  await writeFile(join(fakeDir, "kb.json"), JSON.stringify({ ...fakeManifest, name: "甲库" }), "utf8");
  await scope("s1", ["甲库"]);

  // (i) 省略 kb 的 selected 检索只搜目录「甲库」，不应命中 AAA/ 的内容
  const scopedQuery = await tools.get("kb_query").execute({ pattern: "继电保护" }, scoped("s1"));
  assert.deepEqual(scopedQuery.searchedKbs, ["甲库"]);
  assert.ok(scopedQuery.matches.every((match) => match.title === "甲文档"));
  assert.ok(scopedQuery.matches.every((match) => !match.line.includes("AAA")));

  // kb_list selected 同样按目录名过滤
  const list = await tools.get("kb_list").execute({}, scoped("s1"));
  assert.deepEqual(list.kbs.map((kb) => kb.dir), ["甲库"]);

  // (ii) all 模式 kb="*" 按条目搜索（清单名不同，各搜各的目录）
  const allStar = await tools.get("kb_query").execute({ pattern: "继电保护", kb: "*" }, scoped("s3"));
  assert.deepEqual([...allStar.searchedKbs].sort(), ["AAA", "甲库"]);
  const titles = new Set(allStar.matches.map((match) => match.title));
  assert.ok(titles.has("甲文档"));
  assert.ok(titles.has("AAA文档"));

  // (iii) 两个目录清单同名时，kb="*" 必须分别搜索两个目录
  await writeFile(join(realDir, "kb.json"), JSON.stringify({ ...realManifest, name: "甲库" }), "utf8");
  await writeFile(join(fakeDir, "kb.json"), JSON.stringify({ ...fakeManifest, name: "甲库" }), "utf8");
  const duplicateStar = await tools.get("kb_query").execute({ pattern: "继电保护", kb: "*" }, scoped("s4"));
  assert.deepEqual(duplicateStar.searchedKbs, ["甲库", "甲库"]);
  const duplicateTitles = new Set(duplicateStar.matches.map((match) => match.title));
  assert.ok(duplicateTitles.has("甲文档"));
  assert.ok(duplicateTitles.has("AAA文档"));
});

test("kb_query routes doc to a single scoped kb and rejects multi-kb doc search", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# A\n\n继电保护甲。\n", "甲库", "甲文档");
  await importDoc("b.md", "# B\n\n继电保护乙。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  const single = await tools.get("kb_query").execute({ pattern: "继电保护", doc: "甲文档" }, scoped("s1"));
  assert.equal(single.kb, "甲库");
  assert.deepEqual(single.matches.map((match) => match.title), ["甲文档"]);
  assert.deepEqual(single.scope, { mode: "selected", kbs: ["甲库"] });

  await scope("s2", ["甲库", "乙库"]);
  await assert.rejects(
    () => tools.get("kb_query").execute({ pattern: "继电保护", doc: "甲文档" }, scoped("s2")),
    (error) => error.code === "KB_REQUIRED" && /doc 只能用于单个知识库/.test(error.message)
  );
  await assert.rejects(
    () => tools.get("kb_query").execute({ pattern: "继电保护", doc: "甲文档", kb: "*" }, scoped("s2")),
    (error) => error.code === "KB_REQUIRED" && /doc 只能用于单个知识库/.test(error.message)
  );
});

test("kb_list explains an unavailable scoped kb", async () => {
  const { tools, scoped, importDoc, scope, kbRoot } = await setup();
  await importDoc("a.md", "# A\n\n甲资料。\n", "甲库", "甲文档");
  await writeFile(join(kbRoot, "甲库", "kb.json"), "{broken", "utf8");
  await scope("s1", ["甲库"]);
  const result = await tools.get("kb_list").execute({}, scoped("s1"));
  assert.deepEqual(result.kbs, []);
  assert.deepEqual(result.scope, { mode: "selected", kbs: ["甲库"] });
  const text = tools.get("kb_list").output.render({}, result)[0].text;
  assert.match(text, /本会话范围/);
  assert.match(text, /不可用/);
  assert.doesNotMatch(text, /还没有任何知识库/);
});

test("doc tools: selected single kb resolves without kb argument", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  const doc = await importDoc("a.md", "# 甲\n\n继电保护技术条件正文。\n", "甲库", "继电保护技术条件");
  await scope("s1", ["甲库"]);
  const read = await tools.get("kb_read").execute({ doc: doc.docId }, scoped("s1"));
  assert.equal(read.kb, "甲库");
});

test("doc tools: multi-kb scope resolves a unique title across kbs", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n继电保护技术条件正文。\n", "甲库", "继电保护技术条件");
  const doc = await importDoc("b.md", "# 乙\n\n变压器验收规范正文。\n", "乙库", "变压器验收规范");
  await scope("s1", ["甲库", "乙库"]);
  const read = await tools.get("kb_read").execute({ doc: "变压器" }, scoped("s1"));
  assert.equal(read.kb, "乙库");
  assert.equal(read.docId, doc.docId);
});

test("doc tools: unique id prefix resolves to the resolver's document", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  const doc = await importDoc("a.md", "# 甲\n\n继电保护技术条件正文。\n", "甲库", "继电保护技术条件");
  await importDoc("b.md", "# 乙\n\n变压器验收规范正文。\n", "乙库", "变压器验收规范");
  await scope("s1", ["甲库", "乙库"]);
  // 跨库只命中唯一 id 前缀；调用方应复用解析器返回的 doc，而不是再解析一次产生分歧。
  const prefix = doc.docId.slice(0, 8);
  const history = await tools.get("kb_history").execute({ doc: prefix }, scoped("s1"));
  assert.equal(history.kb, "甲库");
  assert.equal(history.docId, doc.docId);
  const read = await tools.get("kb_read").execute({ doc: prefix }, scoped("s1"));
  assert.equal(read.kb, "甲库");
  assert.equal(read.docId, doc.docId);
});

test("doc tools: duplicate titles across kbs report candidates", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n交接试验规程正文。\n", "甲库", "交接试验规程");
  await importDoc("b.md", "# 乙\n\n交接试验规程正文。\n", "乙库", "交接试验规程", { allowCrossDuplicates: true });
  await scope("s1", ["甲库", "乙库"]);
  await assert.rejects(
    () => tools.get("kb_read").execute({ doc: "交接试验" }, scoped("s1")),
    (error) => error.code === "KB_AMBIGUOUS" && error.message.includes("甲库/") && error.message.includes("乙库/") && error.message.includes("请指定 kb")
  );
});

test("doc tools: explicit out-of-scope kb is rejected", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  const doc = await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  await assert.rejects(
    () => tools.get("kb_read").execute({ kb: "乙库", doc: doc.docId }, scoped("s1")),
    (error) => error.code === "KB_OUT_OF_SCOPE"
  );
});

test("doc tools: edit and describe cross-kb by unique title", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\nAAAA 旧内容。\n", "甲库", "甲文档");
  const doc = await importDoc("b.md", "# 乙\n\nBBBB 旧内容。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  const edit = await tools.get("kb_edit").execute(
    { doc: "乙文档", old_string: "BBBB", new_string: "BEEF" },
    scoped("s1")
  );
  assert.equal(edit.kb, "乙库");
  const described = await tools.get("kb_describe").execute(
    { doc: doc.docId, summary: "乙库文档摘要" },
    scoped("s1")
  );
  assert.equal(described.kb, "乙库");
});

test("doc tools: virtual docs require an explicit kb when scope has several", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  await assert.rejects(
    () => tools.get("kb_read").execute({ doc: "schema" }, scoped("s1")),
    (error) => error.code === "KB_REQUIRED"
  );
  const allowed = await tools.get("kb_read").execute({ kb: "甲库", doc: "schema" }, scoped("s1"));
  assert.equal(allowed.kb, "甲库");
});

test("kb_remove: doc-level cross-kb works, removeKb requires explicit kb", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  const doc = await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  const removed = await tools.get("kb_remove").execute({ doc: "甲文档" }, scoped("s1"));
  assert.equal(removed.kb, "甲库");
  await assert.rejects(
    () => tools.get("kb_remove").execute({ removeKb: true, confirm: "甲库" }, scoped("s1")),
    (error) => error.code === "KB_REQUIRED"
  );
});

test("doc tools: describe batch mode needs an explicit kb in multi-kb scope", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  await assert.rejects(
    () => tools.get("kb_describe").execute({ all: true, auto: true }, scoped("s1")),
    (error) => error.code === "KB_REQUIRED"
  );
});

test("doc tools: describe batch mode uses the only scoped kb", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n继电保护技术条件正文。\n", "甲库", "甲文档");
  await scope("s1", ["甲库"]);
  const result = await tools.get("kb_describe").execute({ all: true, auto: true }, scoped("s1"));
  assert.equal(result.kb, "甲库");
  assert.equal(result.mode, "auto");
});

test("doc tools: restore resolves a soft-deleted doc across kbs without kb", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  const doc = await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  const removed = await tools.get("kb_remove").execute({ kb: "甲库", doc: doc.docId }, scoped("s1"));
  assert.equal(removed.soft, true);
  await scope("s1", ["甲库", "乙库"]);
  const restored = await tools.get("kb_restore").execute({ doc: doc.docId }, scoped("s1"));
  assert.equal(restored.kb, "甲库");
  assert.equal(restored.docId, doc.docId);
  const live = await tools.get("kb_read").execute({ doc: doc.docId }, scoped("s1"));
  assert.equal(live.kb, "甲库");
  assert.equal(live.docId, doc.docId);
});

test("doc tools: history resolves a soft-deleted doc across kbs without kb", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  const doc = await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await tools.get("kb_edit").execute(
    { kb: "甲库", doc: doc.docId, old_string: "正文", new_string: "正文修订" },
    scoped("s1")
  );
  await tools.get("kb_remove").execute({ kb: "甲库", doc: doc.docId }, scoped("s1"));
  await scope("s1", ["甲库", "乙库"]);
  const history = await tools.get("kb_history").execute({ doc: doc.docId }, scoped("s1"));
  assert.equal(history.kb, "甲库");
  assert.equal(history.docId, doc.docId);
  assert.ok(history.history.length >= 1);
});

test("doc tools: permanent remove resolves a soft-deleted doc across kbs without kb", async () => {
  const { tools, scoped, importDoc, scope, kbRoot } = await setup();
  const doc = await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await tools.get("kb_remove").execute({ kb: "甲库", doc: doc.docId }, scoped("s1"));
  await scope("s1", ["甲库", "乙库"]);
  const removed = await tools.get("kb_remove").execute({ doc: doc.docId, soft: false }, scoped("s1"));
  assert.equal(removed.kb, "甲库");
  assert.equal(removed.soft, false);
  const manifest = JSON.parse(await readFile(join(kbRoot, "甲库", "kb.json"), "utf8"));
  assert.equal(manifest.docs.some((item) => item.id === doc.docId), false);
});

test("kb_remove: whole-kb delete requires explicit matching confirm", async () => {
  const { tools, scoped, importDoc, scope, kbRoot } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  await assert.rejects(
    () => tools.get("kb_remove").execute({}, scoped("s1")),
    /未指定 doc 时删除整个知识库需要显式传 removeKb=true/
  );
  await assert.rejects(
    () => tools.get("kb_remove").execute({ kb: "甲库", removeKb: true, confirm: "乙库" }, scoped("s1")),
    /不可恢复.*confirm="甲库"/
  );
  const removed = await tools.get("kb_remove").execute(
    { kb: "甲库", removeKb: true, confirm: "甲库" },
    scoped("s1")
  );
  assert.equal(removed.kb, "甲库");
  assert.equal(removed.soft, false);
  assert.match(removed.removed, /已删除整个知识库「甲库」/);
  const dirs = await readdir(kbRoot);
  assert.equal(dirs.includes("甲库"), false);
  assert.equal(dirs.includes("乙库"), true);
});

test("doc tools: kb_view resolves the single scoped kb before attachment lookup", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  const doc = await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await scope("s1", ["甲库"]);
  await assert.rejects(
    () => tools.get("kb_view").execute({ doc: doc.docId }, scoped("s1")),
    (error) => /附件|图片/.test(error.message) && !/范围/.test(error.message)
  );
});

test("doc tools: keep/trust/retitle batch modes require kb in multi-kb scope", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  const doc = await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  for (const [tool, args] of [
    ["kb_keep", { docs: [doc.docId], note: "保留" }],
    ["kb_trust", { all: true, level: "high", dryRun: true }],
    ["kb_retitle", { all: true }],
  ]) {
    await assert.rejects(
      () => tools.get(tool).execute(args, scoped("s1")),
      (error) => error.code === "KB_REQUIRED",
      `${tool} should ask for kb in multi-kb scope`
    );
  }
  const kept = await tools.get("kb_keep").execute(
    { kb: "甲库", docs: [doc.docId], note: "保留" },
    scoped("s1")
  );
  assert.equal(kept.kb, "甲库");
  const trusted = await tools.get("kb_trust").execute(
    { kb: "甲库", all: true, level: "high", dryRun: true },
    scoped("s1")
  );
  assert.equal(trusted.kb, "甲库");
  const retitled = await tools.get("kb_retitle").execute({ kb: "甲库", all: true }, scoped("s1"));
  assert.equal(retitled.kb, "甲库");
});

test("single-kb tools: import uses the only scope kb", async () => {
  const { tools, scoped, importDoc, scope, root } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await scope("s1", ["甲库"]);
  await mkdir(join(root, "in"), { recursive: true });
  const path = join(root, "in", "c.md");
  await writeFile(path, "# C\n\n丙资料。\n", "utf8");
  const result = await tools.get("kb_import").execute({ path }, scoped("s1"));
  assert.equal(result.kb, "甲库");
});

test("single-kb tools: import with multi-kb scope asks for kb", async () => {
  const { tools, scoped, importDoc, scope, root } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  const path = join(root, "in", "d.md");
  await mkdir(join(root, "in"), { recursive: true });
  await writeFile(path, "# D\n\n丁资料。\n", "utf8");
  await assert.rejects(
    () => tools.get("kb_import").execute({ path }, scoped("s1")),
    (error) => error.code === "KB_REQUIRED"
  );
});

test("single-kb tools: explicit out-of-scope import is rejected", async () => {
  const { tools, scoped, importDoc, scope, root } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  const path = join(root, "e.md");
  await writeFile(path, "# E\n\n戊资料。\n", "utf8");
  await assert.rejects(
    () => tools.get("kb_import").execute({ path, kb: "乙库" }, scoped("s1")),
    (error) => error.code === "KB_OUT_OF_SCOPE"
  );
});

test("single-kb tools: add_note and edit_batch follow the same policy", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\nAAAA 旧内容。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  await assert.rejects(
    () => tools.get("kb_add_note").execute({ title: "笔记", content: "内容" }, scoped("s1")),
    (error) => error.code === "KB_REQUIRED"
  );
  await assert.rejects(
    () => tools.get("kb_edit_batch").execute({ edits: [{ doc: "甲文档", old_string: "AAAA", new_string: "BBBB" }] }, scoped("s1")),
    (error) => error.code === "KB_REQUIRED"
  );
  const batch = await tools.get("kb_edit_batch").execute(
    { kb: "甲库", edits: [{ doc: "甲文档", old_string: "AAAA", new_string: "BBBB" }] },
    scoped("s1")
  );
  assert.equal(batch.kb, "甲库");
});

test("single-kb tools: snapshot and export honour the scope", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  const snap = await tools.get("kb_snapshot").execute({}, scoped("s1"));
  assert.equal(snap.kb, "甲库");
  const exported = await tools.get("kb_export").execute({ format: "md" }, scoped("s1"));
  assert.equal(exported.kb, "甲库");
});

test("single-kb dedup: out-of-scope kbs neither block nor annotate imports", async () => {
  const { tools, scoped, importDoc, scope, root } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "GB/T 1234-2020 范围外查重");
  await scope("s1", ["甲库"]);
  await mkdir(join(root, "in"), { recursive: true });
  const path = join(root, "in", "dup.md");
  await writeFile(path, "# 范围外查重\n\n同一标题的新文件。\n", "utf8");
  const result = await tools.get("kb_import").execute(
    { path, title: "GB/T 1234-2020 范围外查重" },
    scoped("s1")
  );
  assert.equal(result.kb, "甲库");
  assert.equal(result.files, 1);
  assert.equal(result.imported.length, 1);
  assert.deepEqual(result.duplicates, []);
});

test("single-kb dedup: all mode still scans every kb", async () => {
  const { tools, unscoped, importDoc, root } = await setup();
  await importDoc("a.md", "# 乙\n\n正文。\n", "乙库", "GB/T 1234-2020 范围外查重");
  const path = join(root, "blocked.md");
  await writeFile(path, "# 范围外查重\n\n同一标题的另一个文件。\n", "utf8");
  const result = await tools.get("kb_import").execute(
    { path, kb: "甲库", title: "GB/T 1234-2020 范围外查重" },
    unscoped
  );
  assert.equal(result.files, 0);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].scope, "cross-kb");
  assert.equal(result.duplicates[0].matched[0].kb, "乙库");
});

test("single-kb tools: reparse in multi-kb scope asks for kb", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  await assert.rejects(
    () => tools.get("kb_reparse").execute({ all: true }, scoped("s1")),
    (error) => error.code === "KB_REQUIRED"
  );
});

test("single-kb tools: export honours the scope in every format", async () => {
  const { tools, scoped, importDoc, scope, kbRoot } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  const exportsDir = join(kbRoot, "甲库", "exports");
  assert.ok(tools.get("kb_export").output.schema.required.includes("kb"), "kb is part of the export output contract");
  for (const format of ["md", "jsonl", "zip", "vault"]) {
    const exported = await tools.get("kb_export").execute({ format }, scoped("s1"));
    assert.equal(exported.kb, "甲库", format);
    assert.equal(dirname(exported.path), exportsDir, format);
  }
});

test("single-kb tools: add_note writes to the only scoped kb", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  const note = await tools.get("kb_add_note").execute(
    { title: "范围笔记", content: "## 要点\n\n范围内容。" },
    scoped("s1")
  );
  assert.equal(note.kb, "甲库");
  assert.equal(note.updated, false);
});

test("single-kb tools: tool use renews a stale own scope instead of expiring", async () => {
  const { tools, scoped, importDoc, kbRoot } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("d.md", "# 默认\n\n正文。\n", "default", "默认文档");
  await writeScopes(kbRoot, {
    scopes: {
      s1: {
        mode: "selected",
        kbs: ["甲库"],
        updatedAt: new Date(Date.now() - 40 * 86400000).toISOString(),
      },
    },
  });
  const snap = await tools.get("kb_snapshot").execute({}, scoped("s1"));
  assert.equal(snap.kb, "甲库");
  const data = JSON.parse(await readFile(join(kbRoot, ".scopes.json"), "utf8"));
  assert.ok(Date.now() - Date.parse(data.scopes.s1.updatedAt) < 60000, "tool use must renew updatedAt");
});

test("single-kb tools: scopeTtlDays controls a stale inherited parent entry", async () => {
  const { tools, scoped, importDoc, kbRoot } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("d.md", "# 默认\n\n正文。\n", "default", "默认文档");
  await writeScopes(kbRoot, {
    scopes: {
      parent: {
        mode: "selected",
        kbs: ["甲库"],
        updatedAt: new Date(Date.now() - 40 * 86400000).toISOString(),
      },
    },
  });
  const snap = await tools.get("kb_snapshot").execute({}, scoped("child", "parent"));
  assert.equal(snap.kb, "default");

  // 真正钉住 ttlDays 透传：scopeTtlDays=0 表示不过期。若没有把 scopeTtlDays 传给解析器，
  // resolveScope 会退回自己的 30 天默认值并剔掉 40 天前的父条目，结果落到 default。
  const noExpiry = await setup({ scopeTtlDays: 0 });
  await noExpiry.importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await noExpiry.importDoc("d.md", "# 默认\n\n正文。\n", "default", "默认文档");
  await writeScopes(noExpiry.kbRoot, {
    scopes: {
      parent: {
        mode: "selected",
        kbs: ["甲库"],
        updatedAt: new Date(Date.now() - 40 * 86400000).toISOString(),
      },
    },
  });
  const kept = await noExpiry.tools.get("kb_snapshot").execute({}, noExpiry.scoped("child", "parent"));
  assert.equal(kept.kb, "甲库");
});

test("scope names: single-kb resolution sanitizes hand-edited scope entries", async () => {
  const { tools, scoped, importDoc, kbRoot } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "../evil", "恶意库文档");
  await writeScopes(kbRoot, {
    scopes: {
      s1: { mode: "selected", kbs: ["../evil"], updatedAt: new Date().toISOString() },
    },
  });
  const sanitized = sanitizeKbName("../evil");
  assert.notEqual(sanitized, "../evil");
  const snap = await tools.get("kb_snapshot").execute({}, scoped("s1"));
  assert.equal(snap.kb, sanitized);
});

test("scope names: doc resolution sanitizes hand-edited scope entries", async () => {
  const { tools, scoped, importDoc, kbRoot } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "../evil", "恶意库文档");
  await writeScopes(kbRoot, {
    scopes: {
      s1: { mode: "selected", kbs: ["../evil"], updatedAt: new Date().toISOString() },
    },
  });
  const read = await tools.get("kb_read").execute({ doc: "schema" }, scoped("s1"));
  assert.equal(read.kb, sanitizeKbName("../evil"));
});

test("scope names: multi-kb resolution sanitizes names at the normalize root", async () => {
  const { tools, scoped, importDoc, kbRoot } = await setup();
  await importDoc("evil.md", "# 恶意\n\n正文。\n", "../evil", "恶意库唯一文档");
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("evil-shared.md", "# 共用\n\n正文。\n", "../evil", "共用标题");
  await importDoc("a-shared.md", "# 共用\n\n正文。\n", "甲库", "共用标题", { allowCrossDuplicates: true });
  await writeScopes(kbRoot, {
    scopes: {
      s1: { mode: "selected", kbs: ["../evil", "甲库"], updatedAt: new Date().toISOString() },
    },
  });
  const sanitized = sanitizeKbName("../evil");
  assert.equal(sanitized, ".. evil");
  const read = await tools.get("kb_read").execute({ doc: "恶意库唯一文档" }, scoped("s1"));
  assert.equal(read.kb, sanitized);
  assert.notEqual(read.kb, "../evil");
  await assert.rejects(
    () => tools.get("kb_read").execute({ doc: "共用标题" }, scoped("s1")),
    (error) => {
      assert.equal(error.code, "KB_AMBIGUOUS");
      assert.ok(error.message.includes(sanitized), "candidates use sanitized dir names");
      assert.ok(!error.message.includes("../"), "candidates never expose raw traversal names");
      return true;
    }
  );
});

test("kb_lint: selected multi-kb scope lints each kb and groups results", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  const result = await tools.get("kb_lint").execute({}, scoped("s1"));
  assert.equal(result.kb, "scope");
  assert.deepEqual(result.kbs.map((row) => row.kb), ["甲库", "乙库"]);
  const text = tools.get("kb_lint").output.render({}, result)[0].text;
  assert.match(text, /知识库「甲库」体检/);
  assert.match(text, /知识库「乙库」体检/);
});

test("kb_lint: one corrupt kb does not abort the scoped multi-kb report", async () => {
  const { tools, scoped, importDoc, scope, kbRoot } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await writeFile(join(kbRoot, "乙库", "kb.json"), "{broken", "utf8");
  await scope("s1", ["甲库", "乙库"]);
  const result = await tools.get("kb_lint").execute({}, scoped("s1"));
  assert.equal(result.kb, "scope");
  const byKb = Object.fromEntries(result.kbs.map((row) => [row.kb, row]));
  assert.equal(byKb["甲库"].counts.docs, 1);
  assert.match(String(byKb["乙库"].error), /读取知识库清单失败/);
  const text = tools.get("kb_lint").output.render({}, result)[0].text;
  assert.match(text, /知识库「甲库」体检/);
  assert.match(text, /知识库「乙库」体检失败：读取知识库清单失败/);
});

test("kb_lint: scopeLintMaxKbs cap is reported, never silent", async () => {
  const { tools, scoped, importDoc, scope } = await setup({ scopeLintMaxKbs: 1 });
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  const result = await tools.get("kb_lint").execute({}, scoped("s1"));
  assert.equal(result.kb, "scope");
  assert.deepEqual(result.kbs.map((row) => row.kb), ["甲库"]);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.omittedKbs, ["乙库"]);
  assert.match(tools.get("kb_lint").output.render({}, result)[0].text, /scopeLintMaxKbs/);
});

test("kb_lint: explicit out-of-scope kb is rejected", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  await assert.rejects(
    () => tools.get("kb_lint").execute({ kb: "乙库" }, scoped("s1")),
    (error) => error.code === "KB_OUT_OF_SCOPE"
  );
});

test("kb_std_check: default kb is 标准 even in all mode", async () => {
  const { tools, scoped, kbRoot } = await setup();
  // runStdCheck 依赖 kb.json，空库也要有清单（否则会抛「知识库清单不存在」）；
  // 空清单没有任何标准号，检查不会发起网络请求。
  await mkdir(join(kbRoot, "标准"), { recursive: true });
  await writeFile(join(kbRoot, "标准", "kb.json"), JSON.stringify({ schemaVersion: 5, name: "标准", docs: [] }), "utf8");
  const result = await tools.get("kb_std_check").execute({ action: "check" }, scoped("s1"));
  assert.equal(result.kb, "标准");
});

test("kb_std_check: selected scope without 标准 is out of scope", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await scope("s1", ["甲库"]);
  await assert.rejects(
    () => tools.get("kb_std_check").execute({ action: "check" }, scoped("s1")),
    (error) => error.code === "KB_OUT_OF_SCOPE"
  );
});

test("kb_std_check: explicit out-of-scope kb is rejected", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  await assert.rejects(
    () => tools.get("kb_std_check").execute({ kb: "乙库", action: "check" }, scoped("s1")),
    (error) => error.code === "KB_OUT_OF_SCOPE"
  );
});

test("kb_std_check: missing library fails friendly without leaking the kb root", async () => {
  const { tools, scoped, kbRoot } = await setup();
  await assert.rejects(
    () => tools.get("kb_std_check").execute({ action: "check" }, scoped("s1")),
    (error) => {
      assert.match(error.message, /知识库「标准」不存在/);
      assert.ok(error.message.includes("标准"));
      assert.equal(error.message.includes(kbRoot), false);
      assert.equal(error.message.includes("kb.json"), true);
      return true;
    }
  );
  // 缺库时不应顺手 mkdir 出一个空目录
  await assert.rejects(() => readdir(join(kbRoot, "标准")), /ENOENT/);
});

test("kb_rename: requires explicit kb and rejects out-of-scope targets", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库"]);
  await assert.rejects(() => tools.get("kb_rename").execute({ newName: "甲库2" }, scoped("s1")), (error) => error.code === "KB_REQUIRED");
  await assert.rejects(
    () => tools.get("kb_rename").execute({ kb: "乙库", newName: "乙库2" }, scoped("s1")),
    (error) => error.code === "KB_OUT_OF_SCOPE"
  );
  const renamed = await tools.get("kb_rename").execute({ kb: "甲库", newName: "甲库2" }, scoped("s1"));
  assert.equal(renamed.kb, "甲库2");
});

test("none mode disables all 23 kb_* tools with KB_DISABLED", async () => {
  const { tools, scoped, importDoc, none, root } = await setup();
  const doc = await importDoc("a.md", "# 甲\n\n继电保护技术条件正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n乙库正文。\n", "乙库", "乙文档");
  const path = join(root, "locked.md");
  await writeFile(path, "# 锁定\n\n未启用时不应导入。\n", "utf8");
  await none("s1");
  assert.equal(tools.size, 23, "expected the full kb_* tool matrix");

  const cases = [
    ["kb_list", {}],
    ["kb_import", { path }],
    ["kb_reparse", { all: true }],
    ["kb_query", { pattern: "正文" }],
    ["kb_read", { doc: doc.docId }],
    ["kb_view", { doc: doc.docId }],
    ["kb_edit", { doc: doc.docId, old_string: "正文", new_string: "修订" }],
    ["kb_describe", { doc: doc.docId, summary: "摘要" }],
    ["kb_retitle", { all: true }],
    ["kb_lint", {}],
    ["kb_trust", { all: true, level: "high" }],
    ["kb_keep", { docs: [doc.docId], note: "保留" }],
    ["kb_edit_batch", { edits: [{ doc: doc.docId, old_string: "正文", new_string: "修订" }] }],
    ["kb_snapshot", {}],
    ["kb_snapshot_restore", {}],
    ["kb_add_note", { title: "笔记", content: "内容" }],
    ["kb_remove", {}],
    ["kb_restore", { doc: doc.docId }],
    ["kb_history", { doc: doc.docId }],
    ["kb_export", { format: "md" }],
    ["kb_import_package", { path }],
    ["kb_rename", {}],
    ["kb_std_check", { action: "check" }],
  ];
  const covered = new Set(cases.map(([name]) => name));
  assert.deepEqual([...tools.keys()].filter((name) => !covered.has(name)), [], "tool matrix case missing");
  for (const [name, args] of cases) {
    await assert.rejects(
      () => tools.get(name).execute(args, scoped("s1")),
      (error) => error.code === KB_DISABLED && error.message === KB_DISABLED_MESSAGE,
      `${name} must reject with KB_DISABLED`
    );
  }

  // 参数校验不能先于范围门：缺 kb/doc 的调用也必须是 KB_DISABLED，
  // 而不是 KB_REQUIRED / 参数错误（否则等于泄露了知识库处于启用状态）。
  for (const [name, args] of [
    ["kb_remove", {}],
    ["kb_remove", { removeKb: true }],
    ["kb_rename", {}],
  ]) {
    await assert.rejects(
      () => tools.get(name).execute(args, scoped("s1")),
      (error) => error.code === KB_DISABLED && error.message === KB_DISABLED_MESSAGE,
      `${name}(${JSON.stringify(args)}) must reject with KB_DISABLED`
    );
  }

  // 整库删除是同一个 tool 的另一个分支，也必须先拒绝。
  await assert.rejects(
    () => tools.get("kb_remove").execute({ kb: "甲库", removeKb: true, confirm: "甲库" }, scoped("s1")),
    (error) => error.code === KB_DISABLED && error.message === KB_DISABLED_MESSAGE
  );

  // 拒绝发生在任何读/写之前：库还在，文件没有导入。
  const manifests = await Promise.all(
    ["甲库", "乙库"].map(async (name) => JSON.parse(await readFile(join(join(root, "kb"), name, "kb.json"), "utf8")))
  );
  assert.deepEqual(manifests.map((manifest) => manifest.name), ["甲库", "乙库"]);
  assert.equal(manifests[0].docs.length, 1);
  assert.equal(manifests[1].docs.length, 1);
});
