/**
 * 范围语义：校验、懒继承快照、清理、工具矩阵解析、ScopeError。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KB_DISABLED,
  KB_DISABLED_MESSAGE,
  ScopeError,
  normalizeSessionId,
  resolveDocTarget,
  resolveExecScope,
  resolveScope,
  resolveSingleKb,
  setScope,
  scopeForSessionSync,
} from "../lib/scope.js";
import { readScopes, scopeFilePath, writeScopes } from "../lib/scope-store.js";
import { archiveKb } from "../lib/kbmeta.js";

async function tmpRoot() {
  return join(await mkdtemp(join(tmpdir(), "kb-scope-")), "kb");
}

async function makeKb(root, name, docs = []) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "kb.json"),
    JSON.stringify({
      schemaVersion: 5,
      name,
      docs: docs.map((d, i) => ({
        id: d.id ?? `d${i}`,
        title: d.title,
        status: d.status ?? "ready",
        type: d.type ?? "source",
        ...(d.deletedAt !== undefined ? { deletedAt: d.deletedAt } : {}),
      })),
    }),
    "utf8"
  );
  return dir;
}

const CHMOD_GUARD = {
  skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0),
};

function execFor(sessionId, parentSession) {
  return { agent: { session: { id: sessionId, header: { cwd: "/tmp", parentSession } } } };
}

test("normalizeSessionId rejects empty, long and control chars", () => {
  assert.equal(normalizeSessionId("session-1"), "session-1");
  assert.equal(normalizeSessionId("  session-1  "), "session-1");
  assert.equal(normalizeSessionId(""), null);
  assert.equal(normalizeSessionId("a".repeat(201)), null);
  assert.equal(normalizeSessionId("a\u0001b"), null);
  assert.equal(normalizeSessionId(42), null);
});

test("no session id resolves to all", async () => {
  const root = await tmpRoot();
  const scope = await resolveScope(root, {});
  assert.deepEqual({ mode: scope.mode, kbs: scope.kbs }, { mode: "all", kbs: [] });
});

test("explicit all stays all; explicit none stays none and clears stray kbs", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  const now = new Date().toISOString();
  await writeScopes(root, {
    scopes: {
      all: { mode: "all", kbs: ["A"], updatedAt: now },
      none: { mode: "none", kbs: ["A"], updatedAt: now },
    },
  });
  const all = await resolveScope(root, { sessionId: "all" });
  assert.deepEqual({ mode: all.mode, kbs: all.kbs }, { mode: "all", kbs: [] });
  const none = await resolveScope(root, { sessionId: "none" });
  assert.deepEqual({ mode: none.mode, kbs: none.kbs }, { mode: "none", kbs: [] });
  const data = await readScopes(root);
  assert.equal(data.scopes.all.mode, "all");
  assert.equal(data.scopes.none.mode, "none");
  assert.deepEqual(data.scopes.none.kbs, []);
});

test("resolveExecScope reports none without touching any kb", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await writeScopes(root, { scopes: { s1: { mode: "none", kbs: [], updatedAt: new Date().toISOString() } } });
  const scope = await resolveExecScope(execFor("s1"), { kbRoot: root, ttlDays: 30 });
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.kbs, []);
});

test("unknown stored modes fail closed to none", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await writeScopes(root, {
    scopes: { s1: { mode: "typo", kbs: ["A"], updatedAt: new Date().toISOString() } },
  });
  const scope = await resolveScope(root, { sessionId: "s1" });
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.kbs, []);
});

test("explicit entry is returned and stale kb names are pruned", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await writeScopes(root, {
    scopes: { s1: { mode: "selected", kbs: ["A", "已删除"], updatedAt: new Date().toISOString() } },
  });
  const scope = await resolveScope(root, { sessionId: "s1" });
  assert.deepEqual(scope.kbs, ["A"]);
  const data = await readScopes(root);
  assert.deepEqual(data.scopes.s1.kbs, ["A"]);
});

test("prune keeps a corrupt-manifest kb name and leaves the scopes file untouched", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await makeKb(root, "B");
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A", "B"], updatedAt: new Date().toISOString() } } });
  const file = scopeFilePath(root);
  const before = await readFile(file, "utf8");
  await writeFile(join(root, "B", "kb.json"), "{broken", "utf8");
  const scope = await resolveScope(root, { sessionId: "s1" });
  assert.deepEqual(scope.kbs, ["A", "B"]);
  assert.equal(await readFile(file, "utf8"), before);
});

test("prune drops a stored name whose directory is gone and rewrites the entry as none", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["已删除"], updatedAt: new Date().toISOString() } } });
  const scope = await resolveScope(root, { sessionId: "s1" });
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.kbs, []);
  const data = await readScopes(root);
  assert.equal(data.scopes.s1.mode, "none", "empty selected must not stay on disk as selected");
  assert.deepEqual(data.scopes.s1.kbs, []);
});

test("poison scope names are pruned and child snapshots still persist", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await writeScopes(root, {
    scopes: { s1: { mode: "selected", kbs: ["///", "A"], updatedAt: new Date().toISOString() } },
  });
  const scope = await resolveScope(root, { sessionId: "child", parentSession: "s1" });
  assert.deepEqual(scope.kbs, ["A"]);
  assert.equal(scope.inheritedFrom, "s1");
  assert.equal(scope.stored, true);
  const data = await readScopes(root);
  assert.deepEqual(data.scopes.s1.kbs, ["A"]);
  assert.deepEqual(data.scopes.child.kbs, ["A"]);
});

test("legacy selected with empty kbs now reads as none, never all", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: [], updatedAt: new Date().toISOString() } } });
  const scope = await resolveScope(root, { sessionId: "s1" });
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.kbs, []);
  const data = await readScopes(root);
  assert.equal(data.scopes.s1.mode, "none", "tool-path prune should persist the downgrade");
});

test("child inherits parent scope as a snapshot and parent changes do not follow", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await makeKb(root, "B");
  await writeScopes(root, {
    scopes: { parent: { mode: "selected", kbs: ["A"], updatedAt: new Date().toISOString() } },
  });
  const childScope = await resolveScope(root, { sessionId: "child", parentSession: "parent" });
  assert.deepEqual(childScope.kbs, ["A"]);
  assert.equal(childScope.inheritedFrom, "parent");
  let data = await readScopes(root);
  assert.equal(data.scopes.child.inheritedFrom, "parent");
  assert.deepEqual(data.scopes.child.kbs, ["A"]);

  await writeScopes(root, {
    scopes: {
      parent: { mode: "selected", kbs: ["B"], updatedAt: new Date().toISOString() },
      child: data.scopes.child,
    },
  });
  const again = await resolveScope(root, { sessionId: "child", parentSession: "parent" });
  assert.deepEqual(again.kbs, ["A"], "child snapshot must not follow later parent changes");
});

test("no child entry and no parent entry stays all without writing", async () => {
  const root = await tmpRoot();
  await resolveScope(root, { sessionId: "child", parentSession: "parent" });
  const data = await readScopes(root);
  assert.equal(data.scopes.child, undefined);
});

test("a parent none scope snapshots as none, not all", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await writeScopes(root, {
    scopes: { parent: { mode: "none", kbs: [], updatedAt: new Date().toISOString() } },
  });
  const child = await resolveScope(root, { sessionId: "child", parentSession: "parent" });
  assert.equal(child.mode, "none");
  assert.deepEqual(child.kbs, []);
  assert.equal(child.inheritedFrom, "parent");
  const data = await readScopes(root);
  assert.equal(data.scopes.child.mode, "none");
  assert.deepEqual(data.scopes.child.kbs, []);
});

test("read-only resolve (GET) shows parent scope without writing a snapshot", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await writeScopes(root, { scopes: { parent: { mode: "selected", kbs: ["A"], updatedAt: new Date().toISOString() } } });
  const scope = await resolveScope(root, { sessionId: "child", parentSession: "parent", snapshot: false });
  assert.deepEqual(scope.kbs, ["A"]);
  assert.equal(scope.stored, false);
  const data = await readScopes(root);
  assert.equal(data.scopes.child, undefined);
});

test("resolveScope degrades to read-only when the snapshot write fails", CHMOD_GUARD, async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await writeScopes(root, { scopes: { parent: { mode: "selected", kbs: ["A"], updatedAt: new Date().toISOString() } } });
  await chmod(root, 0o555);
  try {
    const child = await resolveScope(root, { sessionId: "child", parentSession: "parent" });
    assert.deepEqual(child.kbs, ["A"]);
    assert.equal(child.stored, false);
    const data = await readScopes(root);
    assert.equal(data.scopes.child, undefined);
  } finally {
    await chmod(root, 0o755);
  }
});

test("write-failure warning fires once per kbRoot", CHMOD_GUARD, async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await writeScopes(root, { scopes: { parent: { mode: "selected", kbs: ["A"], updatedAt: new Date().toISOString() } } });
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args);
  };
  await chmod(root, 0o555);
  try {
    await resolveScope(root, { sessionId: "child", parentSession: "parent" });
    await resolveScope(root, { sessionId: "child", parentSession: "parent" });
  } finally {
    console.warn = originalWarn;
    await chmod(root, 0o755);
  }
  assert.equal(warnings.length, 1);
});

test("tool use renews a stale own entry before pruning", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A"], updatedAt: old } } });
  const scope = await resolveScope(root, { sessionId: "s1", ttlDays: 30 });
  assert.equal(scope.mode, "selected");
  assert.deepEqual(scope.kbs, ["A"]);
  const data = await readScopes(root);
  assert.notEqual(data.scopes.s1.updatedAt, old);
  assert.ok(Date.now() - Date.parse(data.scopes.s1.updatedAt) < 60000, "updatedAt should be refreshed");
});

test("GET-style resolve does not renew and prunes an expired entry", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A"], updatedAt: old } } });
  const scope = await resolveScope(root, { sessionId: "s1", ttlDays: 30, snapshot: false });
  assert.equal(scope.mode, "all");
  const data = await readScopes(root);
  assert.equal(data.scopes.s1, undefined);
});

test("GET keeps an expired none entry instead of silently re-enabling all", async () => {
  const root = await tmpRoot();
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  await writeScopes(root, { scopes: { s1: { mode: "none", kbs: [], updatedAt: old } } });
  const scope = await resolveScope(root, { sessionId: "s1", ttlDays: 30, snapshot: false });
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.kbs, []);
  const data = await readScopes(root);
  assert.equal(data.scopes.s1.mode, "none", "an explicit none must not be expired into all");
  assert.equal(data.scopes.s1.updatedAt, old, "GET must not renew");
});

test("tool resolve keeps an expired none entry in none", async () => {
  const root = await tmpRoot();
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  await writeScopes(root, { scopes: { s1: { mode: "none", kbs: [], updatedAt: old } } });
  const scope = await resolveScope(root, { sessionId: "s1", ttlDays: 30 });
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.kbs, []);
  const data = await readScopes(root);
  assert.equal(data.scopes.s1.mode, "none");
  assert.notEqual(data.scopes.s1.updatedAt, old, "tool use may still renew the retained entry");
});

test("expired selected still expires while an expired none stays", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  await writeScopes(root, {
    scopes: {
      off: { mode: "none", kbs: [], updatedAt: old },
      on: { mode: "selected", kbs: ["A"], updatedAt: old },
    },
  });
  const off = await resolveScope(root, { sessionId: "off", ttlDays: 30, snapshot: false });
  const on = await resolveScope(root, { sessionId: "on", ttlDays: 30, snapshot: false });
  assert.equal(off.mode, "none");
  assert.equal(on.mode, "all", "expired selected entries keep today's TTL behavior");
  const data = await readScopes(root);
  assert.equal(data.scopes.off.mode, "none");
  assert.equal(data.scopes.on, undefined);
});

test("a recently renewed entry is not rewritten by tool use", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await writeScopes(root, {
    scopes: { s1: { mode: "selected", kbs: ["A"], updatedAt: new Date(Date.now() - 3600000).toISOString() } },
  });
  const file = scopeFilePath(root);
  const before = await stat(file);
  const scope = await resolveScope(root, { sessionId: "s1", ttlDays: 30 });
  assert.deepEqual(scope.kbs, ["A"]);
  const after = await stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs, "1h-old entry must not be rewritten");
});

test("ttlDays 0 disables expiry", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A"], updatedAt: old } } });
  const scope = await resolveScope(root, { sessionId: "s1", ttlDays: 0 });
  assert.deepEqual(scope.kbs, ["A"]);
});

test("setScope validates mode, kbs existence and archived kbs", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await assert.rejects(() => setScope(root, { sessionId: "", mode: "all", kbs: [] }), (e) => e.code === "SCOPE_INVALID");
  await assert.rejects(() => setScope(root, { sessionId: "s1", mode: "weird", kbs: [] }), (e) => e.code === "SCOPE_INVALID");
  await assert.rejects(() => setScope(root, { sessionId: "s1", mode: "selected", kbs: ["不存在"] }), (e) => e.code === "KB_NOT_FOUND");
  await assert.rejects(() => setScope(root, { sessionId: "s1", mode: "selected", kbs: [""] }), (e) => e.code === "SCOPE_INVALID");
  const saved = await setScope(root, { sessionId: "s1", mode: "selected", kbs: ["A", "A"] });
  assert.deepEqual(saved.kbs, ["A"]);
});

test("setScope rejects non-array kbs and non-string items", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await assert.rejects(
    () => setScope(root, { sessionId: "s1", mode: "selected", kbs: "A" }),
    (e) => e.code === "SCOPE_INVALID" && e.message === "kbs 必须是数组"
  );
  await assert.rejects(
    () => setScope(root, { sessionId: "s1", mode: "selected", kbs: [42] }),
    (e) => e.code === "SCOPE_INVALID" && e.message === "知识库名称必须是字符串"
  );
  const data = await readScopes(root);
  assert.deepEqual(Object.keys(data.scopes), []);
});

test("setScope validates kb selection strictly", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await mkdir(join(root, "空目录"), { recursive: true });
  await mkdir(join(root, ".trash"), { recursive: true });
  const saved = await setScope(root, { sessionId: "s1", mode: "selected", kbs: ["A"] });
  assert.equal(saved.mode, "selected");
  assert.deepEqual(saved.kbs, ["A"]);
  await assert.rejects(
    () => setScope(root, { sessionId: "s2", mode: "selected", kbs: ["空目录"] }),
    (e) => e.code === "KB_NOT_FOUND"
  );
  await assert.rejects(
    () => setScope(root, { sessionId: "s3", mode: "selected", kbs: [".trash"] }),
    (e) => e.code === "KB_NOT_FOUND"
  );
  const data = await readScopes(root);
  assert.deepEqual(Object.keys(data.scopes), ["s1"]);
  assert.deepEqual(data.scopes.s1.kbs, ["A"]);
});

test("all mode clears kbs", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await setScope(root, { sessionId: "s1", mode: "selected", kbs: ["A"] });
  const saved = await setScope(root, { sessionId: "s1", mode: "all", kbs: ["A"] });
  assert.equal(saved.mode, "all");
  assert.deepEqual(saved.kbs, []);
});

test("setScope stores none with empty kbs and ignores the requested names", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await setScope(root, { sessionId: "s1", mode: "selected", kbs: ["A"] });
  const saved = await setScope(root, { sessionId: "s1", mode: "none", kbs: ["A", "已删除"] });
  assert.equal(saved.mode, "none");
  assert.deepEqual(saved.kbs, []);
  const data = await readScopes(root);
  assert.equal(data.scopes.s1.mode, "none");
  assert.deepEqual(data.scopes.s1.kbs, []);
  assert.equal(data.scopes.s1.inheritedFrom, null);
});

test("setScope collapses an empty selected selection to none", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await setScope(root, { sessionId: "s1", mode: "selected", kbs: ["A"] });
  const saved = await setScope(root, { sessionId: "s1", mode: "selected", kbs: [] });
  assert.equal(saved.mode, "none");
  assert.deepEqual(saved.kbs, []);
  const data = await readScopes(root);
  assert.equal(data.scopes.s1.mode, "none");
  assert.deepEqual(data.scopes.s1.kbs, []);
});

test("setScope none still validates the request shape", async () => {
  const root = await tmpRoot();
  await assert.rejects(
    () => setScope(root, { sessionId: "s1", mode: "none", kbs: "A" }),
    (e) => e.code === "SCOPE_INVALID" && e.message === "kbs 必须是数组"
  );
  await assert.rejects(
    () => setScope(root, { sessionId: "s1", mode: "none", kbs: [42] }),
    (e) => e.code === "SCOPE_INVALID" && e.message === "知识库名称必须是字符串"
  );
  const saved = await setScope(root, { sessionId: "s1", mode: "none" });
  assert.deepEqual(saved, { mode: "none", kbs: [], inheritedFrom: null, stored: true });
});

test("setScope rejects reserved session ids without writing them", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await setScope(root, { sessionId: "s1", mode: "all", kbs: [] });
  await assert.rejects(
    () => setScope(root, { sessionId: "__proto__", mode: "all", kbs: [] }),
    (e) => e.code === "SCOPE_INVALID"
  );
  const data = await readScopes(root);
  assert.equal(Object.hasOwn(data.scopes, "__proto__"), false);
  assert.deepEqual(Object.keys(data.scopes), ["s1"]);
  const raw = JSON.parse(await readFile(scopeFilePath(root), "utf8"));
  assert.equal(Object.hasOwn(raw.scopes, "__proto__"), false);
});

test("setScope rejects a merged kb as archived", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  const manifest = JSON.parse(await readFile(join(root, "A", "kb.json"), "utf8"));
  manifest.mergedInto = "other";
  await writeFile(join(root, "A", "kb.json"), JSON.stringify(manifest), "utf8");
  await assert.rejects(
    () => setScope(root, { sessionId: "s1", mode: "selected", kbs: ["A"] }),
    (e) => e.code === "KB_ARCHIVED"
  );
});

test("setScope rejects an archived kb as archived", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await archiveKb(root, "A");
  await assert.rejects(
    () => setScope(root, { sessionId: "s1", mode: "selected", kbs: ["A"] }),
    (e) => e.code === "KB_ARCHIVED"
  );
});

test("setScope reports SCOPE_WRITE_FAILED when the file cannot be written", CHMOD_GUARD, async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await chmod(root, 0o555);
  try {
    await assert.rejects(
      () => setScope(root, { sessionId: "s1", mode: "selected", kbs: ["A"] }),
      (error) => error.code === "SCOPE_WRITE_FAILED"
    );
  } finally {
    await chmod(root, 0o755);
  }
});

test("setScope explains a corrupt .scopes.json and leaves it untouched", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  const file = scopeFilePath(root);
  await writeFile(file, "{broken", "utf8");
  await assert.rejects(
    () => setScope(root, { sessionId: "s1", mode: "selected", kbs: ["A"] }),
    (error) =>
      error instanceof ScopeError
      && error.code === "SCOPE_WRITE_FAILED"
      && /\.scopes\.json/.test(error.message)
  );
  assert.equal(await readFile(file, "utf8"), "{broken");
});

test("resolveSingleKb: explicit out of scope throws the M1 message", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await makeKb(root, "B");
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A"], updatedAt: new Date().toISOString() } } });
  const config = { kbRoot: root, defaultKb: "default" };
  await assert.rejects(
    () => resolveSingleKb(execFor("s1"), "B", config),
    (error) => error instanceof ScopeError && error.code === "KB_OUT_OF_SCOPE" && error.message.includes("不包含「B」")
  );
  const ok = await resolveSingleKb(execFor("s1"), "A", config);
  assert.equal(ok.kb, "A");
});

test("resolveSingleKb: omitted picks the only scope kb, multi-kb asks for kb", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await makeKb(root, "B");
  const config = { kbRoot: root, defaultKb: "default" };
  await writeScopes(root, { scopes: { one: { mode: "selected", kbs: ["A"], updatedAt: new Date().toISOString() } } });
  assert.equal((await resolveSingleKb(execFor("one"), undefined, config)).kb, "A");

  await writeScopes(root, { scopes: { two: { mode: "selected", kbs: ["A", "B"], updatedAt: new Date().toISOString() } } });
  await assert.rejects(() => resolveSingleKb(execFor("two"), undefined, config), (e) => e.code === "KB_REQUIRED");
});

test("resolveSingleKb: all mode keeps defaultKb and std defaults to 标准", async () => {
  const root = await tmpRoot();
  const config = { kbRoot: root, defaultKb: "default" };
  assert.equal((await resolveSingleKb(execFor("x"), undefined, config)).kb, "default");
  assert.equal((await resolveSingleKb(execFor("x"), undefined, config, { policy: "std" })).kb, "标准");
});

test("resolveSingleKb: selected scope without 标准 blocks std", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A"], updatedAt: new Date().toISOString() } } });
  const config = { kbRoot: root, defaultKb: "default" };
  await assert.rejects(
    () => resolveSingleKb(execFor("s1"), undefined, config, { policy: "std" }),
    (e) => e.code === "KB_OUT_OF_SCOPE"
  );
});

test("resolveSingleKb rejects unknown policies", async () => {
  const root = await tmpRoot();
  await assert.rejects(
    () => resolveSingleKb(execFor("x"), undefined, { kbRoot: root, defaultKb: "default" }, { policy: "bogus" }),
    (error) => error instanceof TypeError && /unknown scope policy/.test(error.message)
  );
});

test("resolveSingleKb and resolveDocTarget reject none mode with KB_DISABLED", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await writeScopes(root, { scopes: { s1: { mode: "none", kbs: [], updatedAt: new Date().toISOString() } } });
  const config = { kbRoot: root, defaultKb: "default" };
  for (const run of [
    () => resolveSingleKb(execFor("s1"), undefined, config),
    () => resolveSingleKb(execFor("s1"), "A", config),
    () => resolveSingleKb(execFor("s1"), "A", config, { policy: "kbAdmin" }),
    () => resolveDocTarget(execFor("s1"), undefined, "A", config),
    () => resolveDocTarget(execFor("s1"), "A", "A", config),
  ]) {
    await assert.rejects(run, (error) =>
      error instanceof ScopeError
      && error.code === KB_DISABLED
      && error.message === KB_DISABLED_MESSAGE);
  }
});

test("resolveDocTarget: single scope kb wins, multi-kb resolves uniquely by title", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A", [{ id: "a1", title: "继电保护技术条件" }]);
  await makeKb(root, "B", [{ id: "b1", title: "变压器验收规范" }]);
  const config = { kbRoot: root, defaultKb: "default" };
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A"], updatedAt: new Date().toISOString() } } });
  const one = await resolveDocTarget(execFor("s1"), undefined, "继电", config);
  assert.equal(one.kb, "A");

  await writeScopes(root, { scopes: { s2: { mode: "selected", kbs: ["A", "B"], updatedAt: new Date().toISOString() } } });
  const unique = await resolveDocTarget(execFor("s2"), undefined, "变压器", config);
  assert.equal(unique.kb, "B");
  assert.equal(unique.doc.id, "b1");
});

test("resolveDocTarget: duplicate titles across kbs report candidates", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A", [{ id: "a1", title: "交接试验规程" }]);
  await makeKb(root, "B", [{ id: "b1", title: "交接试验规程" }]);
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A", "B"], updatedAt: new Date().toISOString() } } });
  const config = { kbRoot: root, defaultKb: "default" };
  await assert.rejects(
    () => resolveDocTarget(execFor("s1"), undefined, "交接试验", config),
    (error) =>
      error instanceof ScopeError
      && error.message.includes("A/a1")
      && error.message.includes("B/b1")
      && error.message.includes("请指定 kb")
  );
});

test("resolveDocTarget: zero hits mention the scope", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A", [{ id: "a1", title: "甲" }]);
  await makeKb(root, "B", [{ id: "b1", title: "乙" }]);
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A", "B"], updatedAt: new Date().toISOString() } } });
  const config = { kbRoot: root, defaultKb: "default" };
  await assert.rejects(
    () => resolveDocTarget(execFor("s1"), undefined, "不存在的文档", config),
    (error) => error.message.includes("A、B")
  );
});

test("resolveDocTarget ignores soft-deleted docs in cross-kb resolution", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A", [{ id: "a1", title: "已删除文档", status: "deleted" }]);
  await makeKb(root, "B", [{ id: "b1", title: "其他文档" }]);
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A", "B"], updatedAt: new Date().toISOString() } } });
  const config = { kbRoot: root, defaultKb: "default" };
  await assert.rejects(
    () => resolveDocTarget(execFor("s1"), undefined, "已删除", config),
    (error) => error.code === "KB_NOT_FOUND" && error.message.includes("A、B")
  );
});

test("resolveDocTarget: virtual docs and aliases use single policy, never cross-kb", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await makeKb(root, "B");
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A", "B"], updatedAt: new Date().toISOString() } } });
  const config = { kbRoot: root, defaultKb: "default" };
  for (const ref of ["schema", "schema.md"]) {
    await assert.rejects(
      () => resolveDocTarget(execFor("s1"), undefined, ref, config),
      (e) => e.code === "KB_REQUIRED"
    );
  }
});

test("resolveDocTarget rejects an empty document reference", async () => {
  const root = await tmpRoot();
  const config = { kbRoot: root, defaultKb: "default" };
  await assert.rejects(
    () => resolveDocTarget(execFor("x"), undefined, "  ", config),
    (error) => error.message === "请提供文档名称或 id"
  );
});

test("resolveDocTarget never creates missing kbs or manifests while scanning", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A", [{ id: "a1", title: "甲" }]);
  await mkdir(join(root, "无清单"), { recursive: true });
  await writeScopes(root, {
    scopes: { s1: { mode: "selected", kbs: ["A", "不存在", "无清单"], updatedAt: new Date().toISOString() } },
  });
  const config = { kbRoot: root, defaultKb: "default" };
  const target = await resolveDocTarget(execFor("s1"), undefined, "甲", config);
  assert.equal(target.kb, "A");
  assert.deepEqual((await readScopes(root)).scopes.s1.kbs, ["A", "无清单"]);
  await assert.rejects(() => access(join(root, "不存在")), { code: "ENOENT" });
  await assert.rejects(() => access(join(root, "无清单", "kb.json")), { code: "ENOENT" });
});

test("scopeForSessionSync resolves child via parent without writing", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: { parent: { mode: "selected", kbs: ["A"], updatedAt: new Date().toISOString() } } });
  const scope = scopeForSessionSync(root, "child", "parent");
  assert.deepEqual(scope.kbs, ["A"]);
  assert.equal(scope.inheritedFrom, "parent");
  assert.equal((await readScopes(root)).scopes.child, undefined);
});

test("scopeForSessionSync hides entries older than ttlDays", async () => {
  const root = await tmpRoot();
  const stale = new Date(Date.now() - 40 * 86400000).toISOString();
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A"], updatedAt: stale } } });
  const expired = scopeForSessionSync(root, "s1", null, 30);
  assert.equal(expired.mode, "all");
  assert.deepEqual(expired.kbs, []);
  const kept = scopeForSessionSync(root, "s1", null, 0);
  assert.equal(kept.mode, "selected");
  assert.deepEqual(kept.kbs, ["A"]);
});

test("scopeForSessionSync keeps an expired none entry (no silent all)", async () => {
  const root = await tmpRoot();
  const stale = new Date(Date.now() - 40 * 86400000).toISOString();
  await writeScopes(root, { scopes: { s1: { mode: "none", kbs: [], updatedAt: stale } } });
  const scope = scopeForSessionSync(root, "s1", null, 30);
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.kbs, []);
});
