/**
 * 系统提示段：仅 selected 注入；文件损坏/无会话/异常都不抛错。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { apply } from "../lib/index.js";
import { writeScopes } from "../lib/scope-store.js";

async function makeKb(root, name) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "kb.json"), JSON.stringify({ schemaVersion: 5, name, docs: [] }), "utf8");
}

async function setup({ config = {}, scopes } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kb-scope-prompt-"));
  const kbRoot = join(root, "kb");
  await makeKb(kbRoot, "标准");
  await makeKb(kbRoot, "变电试验");
  if (scopes) await writeScopes(kbRoot, { scopes });
  let section;
  const ctx = {
    tools: { register() {} },
    systemPrompt: { section(def) { section = def; } },
    get() { return undefined; },
    subprocess: {
      spawn({ argv, cwd }) {
        const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = Buffer.alloc(0);
        child.stdout.on("data", (d) => { out = Buffer.concat([out, d]); });
        const done = new Promise((resolve) => child.on("close", (code) => resolve({ exitCode: code })));
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
  await apply(ctx, { kbRoot, defaultKb: "标准", partMaxChars: 500, ...config });
  return { kbRoot, section };
}

async function textFor(section, sessionId, parentSession) {
  return section.text({
    agent: sessionId === undefined ? {} : { session: { id: sessionId, header: { cwd: "/tmp", parentSession } } },
  });
}

test("section is registered at order 120 with a function text", async () => {
  const { section } = await setup();
  assert.equal(section.name, "kb:scope");
  assert.equal(section.order, 120);
  assert.equal(typeof section.text, "function");
});

test("all mode injects nothing", async () => {
  const { section } = await setup();
  assert.equal(await textFor(section, "s1"), "");
});

test("selected mode injects one line with kb names", async () => {
  const { section } = await setup({
    scopes: { s1: { mode: "selected", kbs: ["标准", "变电试验"], updatedAt: new Date().toISOString() } },
  });
  const text = await textFor(section, "s1");
  assert.match(text, /本会话用户选定：标准、变电试验/);
});

test("child session shows parent scope without a snapshot", async () => {
  const { kbRoot, section } = await setup({
    scopes: { parent: { mode: "selected", kbs: ["标准"], updatedAt: new Date().toISOString() } },
  });
  const text = await textFor(section, "child", "parent");
  assert.match(text, /标准/);
  const { readScopes } = await import("../lib/scope-store.js");
  assert.equal((await readScopes(kbRoot)).scopes.child, undefined);
});

test("no session id injects nothing", async () => {
  const { section } = await setup({
    scopes: { s1: { mode: "selected", kbs: ["标准"], updatedAt: new Date().toISOString() } },
  });
  assert.equal(await textFor(section, undefined), "");
});

test("corrupt scopes file degrades to empty without throwing", async () => {
  const { kbRoot, section } = await setup();
  await writeFile(join(kbRoot, ".scopes.json"), "{broken", "utf8");
  assert.equal(await textFor(section, "s1"), "");
});

test("scope changes are visible on the next assembly (mtime cache refresh)", async () => {
  const { kbRoot, section } = await setup({ scopes: {} });
  assert.equal(await textFor(section, "s1"), "");
  await writeFile(
    join(kbRoot, ".scopes.json"),
    JSON.stringify({ version: 1, scopes: { s1: { mode: "selected", kbs: ["标准"], updatedAt: new Date().toISOString() } } }),
    "utf8"
  );
  const text = await textFor(section, "s1");
  assert.match(text, /标准/);
});

test("expired scope entries are not injected", async () => {
  const stale = new Date(Date.now() - 40 * 86400000).toISOString();
  const { section } = await setup({
    scopes: { s1: { mode: "selected", kbs: ["标准"], updatedAt: stale } },
  });
  assert.equal(await textFor(section, "s1"), "");
});

test("missing session context never throws and injects nothing", async () => {
  const { section } = await setup({
    scopes: { s1: { mode: "selected", kbs: ["标准"], updatedAt: new Date().toISOString() } },
  });
  assert.equal(await section.text(undefined), "");
  assert.equal(await section.text({ agent: {} }), "");
});

test("selected scope with poisoned kb name cannot inject prompt refs", async () => {
  const { section } = await setup({
    scopes: { s1: { mode: "selected", kbs: ["{{cwd}}"], updatedAt: new Date().toISOString() } },
  });
  const text = await textFor(section, "s1");
  assert.notEqual(text, "");
  assert.doesNotMatch(text, /\{\{|\}\}/);
  assert.match(text, /｛｛cwd｝｝/);
});
