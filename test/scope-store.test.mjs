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
    },
  });
  await renameScopeKb(root, "旧", "新");
  const data = await readScopes(root);
  assert.deepEqual(data.scopes.s1.kbs, ["新", "B"]);
  assert.deepEqual(data.scopes.s2.kbs, ["B", "新"]);
});
