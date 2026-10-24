/**
 * .scopes.json 文件层：原子写、串行队列、损坏降级、同步视图、库名同步。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mutateScopes,
  readScopes,
  readScopesSync,
  removeScopeKb,
  renameScopeKb,
  scopeFilePath,
  writeScopes,
} from "../lib/scope-store.js";

async function tmpRoot() {
  return join(await mkdtemp(join(tmpdir(), "kb-scope-store-")), "kb");
}

test("missing file reads as empty", async () => {
  const root = await tmpRoot();
  assert.deepEqual(await readScopes(root), { version: 1, scopes: {} });
  assert.deepEqual(readScopesSync(root), { version: 1, scopes: {} });
});

test("writeScopes is atomic and 0600, no tmp left", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: { s1: { mode: "all", kbs: [] } } });
  const file = scopeFilePath(root);
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
  const names = await readdir(root);
  assert.deepEqual(names.filter((n) => n.endsWith(".tmp")), []);
  assert.equal(JSON.parse(await readFile(file, "utf8")).scopes.s1.mode, "all");
});

test("corrupt json degrades to empty without deleting the file", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: {} });
  await writeFile(scopeFilePath(root), "{oops", "utf8");
  assert.deepEqual(await readScopes(root), { version: 1, scopes: {} });
  assert.deepEqual(readScopesSync(root), { version: 1, scopes: {} });
  assert.equal(await readFile(scopeFilePath(root), "utf8"), "{oops");
});

test("mutateScopes is serialized: 20 concurrent increments all land", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: {} });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      mutateScopes(root, (data) => {
        data.scopes[`s${i}`] = { mode: "all", kbs: [] };
        return true;
      })
    )
  );
  const data = await readScopes(root);
  assert.equal(Object.keys(data.scopes).length, 20);
});

test("mutateScopes skips writing when mutator returns falsy", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: { s1: { mode: "all", kbs: [] } } });
  const before = await stat(scopeFilePath(root));
  await new Promise((r) => setTimeout(r, 15));
  await mutateScopes(root, () => false);
  const after = await stat(scopeFilePath(root));
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("readScopesSync caches by mtime+size and refreshes after write", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: { s1: { mode: "all", kbs: [] } } });
  assert.equal(Object.keys(readScopesSync(root).scopes).length, 1);
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A"] } } });
  assert.deepEqual(readScopesSync(root).scopes.s1.kbs, ["A"]);
});

test("removeScopeKb drops the name from every entry", async () => {
  const root = await tmpRoot();
  await writeScopes(root, {
    scopes: {
      s1: { mode: "selected", kbs: ["A", "B"] },
      s2: { mode: "selected", kbs: ["B"] },
      s3: { mode: "all", kbs: [] },
    },
  });
  await removeScopeKb(root, "B");
  const data = await readScopes(root);
  assert.deepEqual(data.scopes.s1.kbs, ["A"]);
  assert.deepEqual(data.scopes.s2.kbs, []);
  assert.deepEqual(data.scopes.s3.kbs, []);
});

test("renameScopeKb replaces and de-duplicates names", async () => {
  const root = await tmpRoot();
  await writeScopes(root, {
    scopes: {
      s1: { mode: "selected", kbs: ["旧", "B"] },
      s2: { mode: "selected", kbs: ["B", "新"] },
      s3: { mode: "selected", kbs: ["旧", "新"] },
    },
  });
  await renameScopeKb(root, "旧", "新");
  const data = await readScopes(root);
  assert.deepEqual(data.scopes.s1.kbs, ["新", "B"]);
  assert.deepEqual(data.scopes.s2.kbs, ["B", "新"]);
  assert.deepEqual(data.scopes.s3.kbs, ["新"]);
});

test("mutateScopes refuses to overwrite a corrupt file", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: {} });
  const file = scopeFilePath(root);
  await writeFile(file, "{oops", "utf8");
  await assert.rejects(
    () =>
      mutateScopes(root, (data) => {
        data.scopes.s1 = { mode: "all", kbs: [] };
        return true;
      }),
    /unusable/
  );
  assert.deepEqual(await readScopes(root), { version: 1, scopes: {} });
  assert.equal(await readFile(file, "utf8"), "{oops");
});

test("oversized file reads empty and mutateScopes refuses to overwrite", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: {} });
  const file = scopeFilePath(root);
  const big = "x".repeat(1024 * 1024 + 10);
  await writeFile(file, big, "utf8");
  assert.deepEqual(readScopesSync(root), { version: 1, scopes: {} });
  await assert.rejects(() => mutateScopes(root, () => true), /unusable/);
  assert.equal((await stat(file)).size, big.length);
});

test("mutateScopes preserves unknown entry fields", async () => {
  const root = await tmpRoot();
  await writeScopes(root, {
    scopes: {
      s1: {
        mode: "selected",
        kbs: ["A"],
        updatedAt: "2026-01-02T03:04:05.000Z",
        inheritedFrom: "s0",
      },
    },
  });
  await mutateScopes(root, (data) => {
    data.scopes.s2 = { mode: "all", kbs: [] };
    return true;
  });
  const data = await readScopes(root);
  assert.deepEqual(data.scopes.s1, {
    mode: "selected",
    kbs: ["A"],
    updatedAt: "2026-01-02T03:04:05.000Z",
    inheritedFrom: "s0",
  });
});

test("malformed top-level shapes read as empty", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: {} });
  const file = scopeFilePath(root);
  for (const raw of [null, [], "str", 42, { scopes: [] }, { scopes: "x" }]) {
    await writeFile(file, JSON.stringify(raw), "utf8");
    assert.deepEqual(await readScopes(root), { version: 1, scopes: {} });
  }
});

test("readScopesSync refreshes when the file changes out of band", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: { s1: { mode: "all", kbs: [] } } });
  assert.equal(readScopesSync(root).scopes.s1.mode, "all");
  const next = JSON.stringify({
    version: 1,
    scopes: {
      s1: { mode: "selected", kbs: ["A"] },
      s2: { mode: "all", kbs: [] },
    },
  });
  await writeFile(scopeFilePath(root), next, "utf8");
  const data = readScopesSync(root);
  assert.deepEqual(data.scopes.s1.kbs, ["A"]);
  assert.deepEqual(Object.keys(data.scopes).sort(), ["s1", "s2"]);
});

test("writeScopes replaces the file atomically via rename", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: {} });
  const file = scopeFilePath(root);
  const first = await stat(file);
  await writeScopes(root, { scopes: { s1: { mode: "all", kbs: [] } } });
  const second = await stat(file);
  assert.notEqual(second.ino, first.ino);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("readScopesSync returns a frozen view that cannot poison the cache", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A"] } } });
  const view = readScopesSync(root);
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.scopes.s1));
  assert.ok(Object.isFrozen(view.scopes.s1.kbs));
  assert.throws(() => view.scopes.s1.kbs.push("B"), TypeError);
  assert.deepEqual(readScopesSync(root).scopes.s1.kbs, ["A"]);
});
