# 知识库工作台 Slice 2B 实施计划（会话范围 + 胶囊 + 工具硬约束）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个会话有自己的知识库范围：胶囊选择、`.scopes.json` 持久化、子会话懒继承快照、21 个 `kb_*` 工具硬约束、系统提示按会话注入、`/kb/api/scope` 读写。

**Architecture:** 三层——`lib/scope-store.js` 只做 `.scopes.json` 的文件层（原子写、串行队列、同步只读视图、库名同步）；`lib/scope.js` 做范围语义（校验、继承快照、工具矩阵解析、`ScopeError`）；`lib/scope-view.js` 是无 node 依赖的纯函数（服务端渲染提示、客户端 chip 文案、选择合并），同一份代码被客户端 bundle 打包。工具各自在 `execute` 入口调用 `resolve*` 助手，不在工具体内重写语义；客户端把 Slice 1.5 的弹窗抽成 `WorkbenchModal`，新增 `conversation.input.left` 胶囊。

**Tech Stack:** Node.js ESM、`node:test`、React 18（宿主 external）、esbuild、`node:vm`、WKWebView 验收脚本（`.acceptance/wkflow`）。

**规格：** `docs/superpowers/specs/2026-10-24-kb-workbench-slice2b-design.md`

---

## 0. 工作目录与准备

**工作目录：** `/Users/littlesun/.dsh/plugins/dsh-knowledge-base`（已安装插件的 git 仓库）。文档仓库（非 git）：`/Users/littlesun/workspace/deepseek/project/知识库`。

### Task 0: 建分支与基线

**Files:** 无

- [ ] **Step 0.1: 确认干净工作区**

Run:
```bash
cd /Users/littlesun/.dsh/plugins/dsh-knowledge-base
git status --short
git log --oneline -3
```
Expected: 无输出（干净）；HEAD 第一条是 `db1623d docs(spec): Slice 2B 会话范围 + 胶囊 + 工具硬约束设计`。

- [ ] **Step 0.2: 建分支**

Run:
```bash
git checkout -b feat/kb-scope-capsule
```
Expected: `Switched to a new branch 'feat/kb-scope-capsule'`。

- [ ] **Step 0.3: 跑基线测试**

Run:
```bash
npm test
```
Expected: `tests 312`、`pass 312`、`fail 0`。失败先停下修基线，不要继续。

- [ ] **Step 0.4: 类型与产物检查**

Run:
```bash
npm run typecheck && npm run check:client
```
Expected: 均退出码 0。

---

## 文件结构

```text
lib/scope-store.js          新：.scopes.json 原子读写、串行队列、同步视图、库名同步
lib/scope.js                新：校验、继承快照、工具矩阵解析、ScopeError
lib/scope-view.js           新：纯函数（chipLabel / scopePromptText / selectionPayload）
lib/index.js                改：config 两项、提示段、21 个工具接入、kb_lint 多库
lib/kbmeta.js               改：删除本地 removeScopesReferences，归档时同步范围
lib/store.js                不变（范围同步放在 kb_rename 与 PATCH 两个调用点）
lib/web/api.js              改：GET/PUT /api/scope、features.scope、PATCH 后同步重命名
lib/version.js              改：0.21.0
package.json                改：version 0.21.0
src/client/index.tsx        改：抽 WorkbenchModal、加 KbScopeCapsule
lib/client.js               改：构建产物
test/scope-store.test.mjs   新
test/scope.test.mjs         新
test/scope-view.test.mjs    新
test/scope-prompt.test.mjs  新
test/scope-tools.test.mjs   新
test/scope-api.test.mjs     新
test/scope-client.test.mjs  新
test/scope-sync.test.mjs    新
test/client-entry.test.mjs  改：注册断言加 conversation.input.left
README.md                   改：范围与胶囊、已知限制
```

---

## Task 1: `lib/scope-store.js` 文件层

**Files:**
- Create: `lib/scope-store.js`
- Test: `test/scope-store.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `test/scope-store.test.mjs`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
node --test test/scope-store.test.mjs
```
Expected: FAIL，`Cannot find module '../lib/scope-store.js'`。

- [ ] **Step 3: 实现 `lib/scope-store.js`**

```js
/**
 * .scopes.json 的文件层：原子读写、串行队列、同步只读视图、库名同步。
 * 只做“文件 ↔ 纯数据”；范围语义（校验/继承/工具矩阵）在 lib/scope.js。
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expandRoot } from "./store.js";

export const SCOPE_FILE = ".scopes.json";
const MAX_BYTES = 1024 * 1024;

const queues = new Map();
let syncCache = { path: "", mtimeMs: -1, size: -1, data: null };

function empty() {
  return { version: 1, scopes: {} };
}

export function scopeFilePath(root) {
  return join(expandRoot(root), SCOPE_FILE);
}

function normalizeData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty();
  const scopes = raw.scopes && typeof raw.scopes === "object" && !Array.isArray(raw.scopes) ? raw.scopes : {};
  const clean = {};
  for (const [sessionId, entry] of Object.entries(scopes)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    clean[sessionId] = entry;
  }
  return { version: 1, scopes: clean };
}

export async function readScopes(root) {
  try {
    const text = await readFile(scopeFilePath(root), "utf8");
    return normalizeData(JSON.parse(text));
  } catch {
    return empty();
  }
}

export async function writeScopes(root, data) {
  const path = scopeFilePath(root);
  await mkdir(expandRoot(root), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(
      tmp,
      `${JSON.stringify({ version: 1, scopes: data.scopes ?? {} }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  syncCache = { path: "", mtimeMs: -1, size: -1, data: null };
}

function enqueue(root, task) {
  const key = scopeFilePath(root);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  queues.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/** 串行 read-modify-write；mutator 返回 truthy 才写盘。 */
export async function mutateScopes(root, mutator) {
  return enqueue(root, async () => {
    const data = await readScopes(root);
    const changed = await mutator(data);
    if (changed) await writeScopes(root, data);
    return data;
  });
}

/** 同步只读视图（系统提示用）：mtime+size 缓存；损坏/超限返回空。 */
export function readScopesSync(root) {
  try {
    const path = scopeFilePath(root);
    const info = statSync(path);
    if (info.size > MAX_BYTES) return empty();
    if (syncCache.path === path && syncCache.mtimeMs === info.mtimeMs && syncCache.size === info.size) {
      return syncCache.data;
    }
    const data = normalizeData(JSON.parse(readFileSync(path, "utf8")));
    syncCache = { path, mtimeMs: info.mtimeMs, size: info.size, data };
    return data;
  } catch {
    return empty();
  }
}

/** 从所有条目里摘掉一个库名（归档/彻底删除时用）。 */
export async function removeScopeKb(root, name) {
  return mutateScopes(root, (data) => {
    let changed = false;
    for (const entry of Object.values(data.scopes)) {
      if (!Array.isArray(entry.kbs)) continue;
      const next = entry.kbs.filter((kb) => kb !== name);
      if (next.length !== entry.kbs.length) {
        entry.kbs = next;
        changed = true;
      }
    }
    return changed;
  });
}

/** 重命名时替换所有条目里的库名并去重。 */
export async function renameScopeKb(root, oldName, newName) {
  if (oldName === newName) return;
  return mutateScopes(root, (data) => {
    let changed = false;
    for (const entry of Object.values(data.scopes)) {
      if (!Array.isArray(entry.kbs)) continue;
      const next = [...new Set(entry.kbs.map((kb) => (kb === oldName ? newName : kb)))];
      if (next.length !== entry.kbs.length || next.some((kb, index) => kb !== entry.kbs[index])) {
        entry.kbs = next;
        changed = true;
      }
    }
    return changed;
  });
}

export async function scopesFileInfo(root) {
  try {
    return await stat(scopeFilePath(root));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
node --test test/scope-store.test.mjs
```
Expected: `pass 8`、`fail 0`。

- [ ] **Step 5: 提交**

```bash
git add lib/scope-store.js test/scope-store.test.mjs
git commit -m "feat(scope): add .scopes.json file layer with atomic serialized writes"
```

---

## Task 2: `lib/scope.js` 范围语义

**Files:**
- Create: `lib/scope.js`
- Test: `test/scope.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `test/scope.test.mjs`：

```js
/**
 * 范围语义：校验、懒继承快照、清理、工具矩阵解析、ScopeError。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScopeError,
  normalizeSessionId,
  resolveDocTarget,
  resolveScope,
  resolveSingleKb,
  setScope,
  scopeForSessionSync,
} from "../lib/scope.js";
import { readScopes, writeScopes } from "../lib/scope-store.js";

async function tmpRoot() {
  return join(await mkdtemp(join(tmpdir(), "kb-scope-")), "kb");
}

async function makeKb(root, name, docs = []) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "kb.json"),
    JSON.stringify({ schemaVersion: 5, name, docs: docs.map((d, i) => ({ id: d.id ?? `d${i}`, title: d.title, status: "ready", type: "source" })) }),
    "utf8"
  );
  return dir;
}

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

test("selected with empty kbs reads as all", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: [], updatedAt: new Date().toISOString() } } });
  const scope = await resolveScope(root, { sessionId: "s1" });
  assert.equal(scope.mode, "all");
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

test("resolveScope degrades to read-only when the snapshot write fails", async () => {
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

test("expired entries are pruned", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A"], updatedAt: old } } });
  const scope = await resolveScope(root, { sessionId: "s1", ttlDays: 30 });
  assert.equal(scope.mode, "all");
  const data = await readScopes(root);
  assert.equal(data.scopes.s1, undefined);
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

test("all mode clears kbs", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await setScope(root, { sessionId: "s1", mode: "selected", kbs: ["A"] });
  const saved = await setScope(root, { sessionId: "s1", mode: "all", kbs: ["A"] });
  assert.equal(saved.mode, "all");
  assert.deepEqual(saved.kbs, []);
});

test("setScope reports SCOPE_WRITE_FAILED when the file cannot be written", async () => {
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

test("resolveDocTarget: virtual docs use single policy, never cross-kb", async () => {
  const root = await tmpRoot();
  await makeKb(root, "A");
  await makeKb(root, "B");
  await writeScopes(root, { scopes: { s1: { mode: "selected", kbs: ["A", "B"], updatedAt: new Date().toISOString() } } });
  const config = { kbRoot: root, defaultKb: "default" };
  await assert.rejects(
    () => resolveDocTarget(execFor("s1"), undefined, "schema", config),
    (e) => e.code === "KB_REQUIRED"
  );
});

test("scopeForSessionSync resolves child via parent without writing", async () => {
  const root = await tmpRoot();
  await writeScopes(root, { scopes: { parent: { mode: "selected", kbs: ["A"], updatedAt: new Date().toISOString() } } });
  const scope = scopeForSessionSync(root, "child", "parent");
  assert.deepEqual(scope.kbs, ["A"]);
  assert.equal(scope.inheritedFrom, "parent");
  assert.equal((await readScopes(root)).scopes.child, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
node --test test/scope.test.mjs
```
Expected: FAIL，`Cannot find module '../lib/scope.js'`。

- [ ] **Step 3: 实现 `lib/scope.js`**

```js
/**
 * 会话知识库范围语义：校验、懒继承快照、清理、21 工具矩阵解析。
 * 文件 I/O 在 lib/scope-store.js；这里只处理纯数据与工具调用契约。
 */
import { kbDirPath, listKbs, readManifest, sanitizeKbName } from "./store.js";
import { listTrash } from "./kbmeta.js";
import { mutateScopes, readScopes, readScopesSync } from "./scope-store.js";

export const OUT_OF_SCOPE = "KB_OUT_OF_SCOPE";
export const KB_REQUIRED = "KB_REQUIRED";
export const MAX_SCOPE_KBS = 50;
const MAX_SESSION_ID = 200;
const VIRTUAL_DOCS = new Set(["schema", "index", "log"]);
const ALL_SCOPE = Object.freeze({ mode: "all", kbs: [], inheritedFrom: null, stored: false });

export class ScopeError extends Error {
  constructor(message, code = OUT_OF_SCOPE, details) {
    super(message);
    this.name = "ScopeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_SESSION_ID) return null;
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function normalizeScope(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const mode = entry.mode === "selected" ? "selected" : "all";
  const kbs = Array.isArray(entry.kbs)
    ? [...new Set(entry.kbs.map((kb) => (typeof kb === "string" ? kb.trim() : "")).filter(Boolean))]
    : [];
  if (mode === "all" || kbs.length === 0) return { mode: "all", kbs: [], inheritedFrom: null };
  return {
    mode: "selected",
    kbs,
    inheritedFrom: typeof entry.inheritedFrom === "string" && entry.inheritedFrom !== "" ? entry.inheritedFrom : null,
  };
}

/** 从已解析的条目表里解析某个会话的生效范围（不查磁盘、不写盘）。 */
export function lookupScope(scopes, sessionId, parentSession = null) {
  if (!sessionId) return { ...ALL_SCOPE };
  const own = normalizeScope(scopes[sessionId]);
  if (own) return { ...own, stored: true };
  if (parentSession) {
    const parent = normalizeScope(scopes[parentSession]);
    if (parent) return { ...parent, inheritedFrom: parentSession, stored: false };
  }
  return { ...ALL_SCOPE };
}

export function scopeForSessionSync(root, sessionId, parentSession) {
  const data = readScopesSync(root);
  return lookupScope(data.scopes, normalizeSessionId(sessionId), normalizeSessionId(parentSession));
}

async function availableKbNames(root) {
  const entries = await listKbs(root).catch(() => []);
  return new Set(entries.filter((kb) => kb.mergedInto == null).map((kb) => kb.name));
}

function prune(data, { now, ttlMs, available }) {
  let changed = false;
  for (const [sessionId, entry] of Object.entries(data.scopes)) {
    const updatedAt = Date.parse(String(entry?.updatedAt ?? ""));
    if (ttlMs > 0 && Number.isFinite(updatedAt) && now - updatedAt > ttlMs) {
      delete data.scopes[sessionId];
      changed = true;
      continue;
    }
    if (!Array.isArray(entry?.kbs)) continue;
    const next = entry.kbs.filter((kb) => typeof kb === "string" && available.has(kb));
    if (next.length !== entry.kbs.length) {
      entry.kbs = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * 解析会话范围：清理过期/失效条目；子会话无条目时按父条目落一份快照（snapshot=true）。
 * snapshot=false 供 GET 使用：显示父范围但不写子条目。
 */
export async function resolveScope(root, { sessionId, parentSession, ttlDays = 30, snapshot = true } = {}) {
  const session = normalizeSessionId(sessionId);
  if (!session) return { ...ALL_SCOPE };
  const available = await availableKbNames(root);
  const ttlMs = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 86400000 : 0;
  const now = Date.now();
  const parent = normalizeSessionId(parentSession);
  let result = null;
  try {
    await mutateScopes(root, (data) => {
      let changed = prune(data, { now, ttlMs, available });
      const own = normalizeScope(data.scopes[session]);
      if (own) {
        result = { ...own, stored: true };
        return changed;
      }
      if (snapshot && parent) {
        const parentScope = normalizeScope(data.scopes[parent]);
        if (parentScope) {
          data.scopes[session] = {
            mode: parentScope.mode,
            kbs: [...parentScope.kbs],
            updatedAt: new Date(now).toISOString(),
            inheritedFrom: parent,
          };
          result = { ...parentScope, inheritedFrom: parent, stored: true };
          return true;
        }
      }
      if (!snapshot && parent) {
        const parentScope = normalizeScope(data.scopes[parent]);
        if (parentScope) result = { ...parentScope, inheritedFrom: parent, stored: false };
      }
      return changed;
    });
  } catch (error) {
    // 只读磁盘/权限不足：退化为只读解析，不阻塞工具调用（M1 §6.5 的降级策略）
    console.warn("[kb-scope] 范围快照写入失败，按只读解析临时生效：", String(error?.message ?? error));
    const data = await readScopes(root).catch(() => ({ scopes: {} }));
    result = lookupScope(data.scopes, session, parent);
  }
  return result ?? { ...ALL_SCOPE };
}

async function archivedKbNames(root) {
  const entries = await listTrash(root).catch(() => []);
  return new Set(entries.map((entry) => entry.name));
}

/** 写入一个会话的显式范围（胶囊 PUT）。 */
export async function setScope(root, { sessionId, mode, kbs }) {
  const session = normalizeSessionId(sessionId);
  if (!session) throw new ScopeError("会话标识无效（session 必须是 1–200 字符、无控制字符）", "SCOPE_INVALID");
  if (mode !== "all" && mode !== "selected") {
    throw new ScopeError("范围模式无效（mode 必须是 all 或 selected）", "SCOPE_INVALID");
  }
  let wanted;
  try {
    wanted = mode === "all" ? [] : [...new Set((Array.isArray(kbs) ? kbs : []).map((kb) => sanitizeKbName(kb)))];
  } catch (error) {
    throw new ScopeError(`知识库名称无效: ${String(error?.message ?? error)}`, "SCOPE_INVALID");
  }
  if (wanted.length > MAX_SCOPE_KBS) throw new ScopeError(`一次最多选择 ${MAX_SCOPE_KBS} 个知识库`, "SCOPE_INVALID");
  const live = await availableKbNames(root);
  const archived = new Set();
  for (const name of wanted) {
    if (live.has(name)) continue;
    if (archived.size === 0) {
      for (const archivedName of await archivedKbNames(root)) archived.add(archivedName);
    }
    if (archived.has(name)) throw new ScopeError(`知识库已归档: ${name}`, "KB_ARCHIVED");
    throw new ScopeError(`知识库不存在: ${name}`, "KB_NOT_FOUND");
  }
  const effective = mode === "selected" && wanted.length > 0 ? "selected" : "all";
  try {
    await mutateScopes(root, (data) => {
      data.scopes[session] = {
        mode: effective,
        kbs: effective === "selected" ? wanted : [],
        updatedAt: new Date().toISOString(),
        inheritedFrom: null,
      };
      return true;
    });
  } catch (error) {
    throw new ScopeError("范围保存失败，请重试", "SCOPE_WRITE_FAILED", { cause: String(error?.message ?? error) });
  }
  return { mode: effective, kbs: effective === "selected" ? wanted : [], inheritedFrom: null, stored: true };
}

function outOfScopeMessage(scope, requested) {
  return `本会话的知识库范围是「${scope.kbs.join("、")}」，不包含「${requested}」。\n如需使用，请在输入框旁的知识库选择器里调整范围。`;
}

export function assertInScope(scope, name) {
  if (scope.mode !== "selected") return name;
  if (scope.kbs.includes(name)) return name;
  throw new ScopeError(outOfScopeMessage(scope, name), OUT_OF_SCOPE, { scope: [...scope.kbs], requested: name });
}

export async function resolveExecScope(exec, { kbRoot, ttlDays }) {
  const session = exec?.agent?.session;
  return resolveScope(kbRoot, {
    sessionId: session?.id,
    parentSession: session?.header?.parentSession,
    ttlDays,
  });
}

/**
 * 解析出唯一目标库（doc/single/std/kbAdmin 之外的策略）。
 * policy: "single"（默认）| "std"（默认库为「标准」）
 */
export async function resolveSingleKb(exec, requestedKb, { kbRoot, defaultKb, ttlDays }, { policy = "single" } = {}) {
  const scope = await resolveExecScope(exec, { kbRoot, ttlDays });
  const hasRequest = typeof requestedKb === "string" && requestedKb.trim() !== "";
  if (hasRequest) {
    const kb = sanitizeKbName(requestedKb);
    return { scope, kb: assertInScope(scope, kb) };
  }
  const fallback = policy === "std" ? "标准" : defaultKb;
  if (scope.mode !== "selected") return { scope, kb: sanitizeKbName(fallback) };
  if (policy === "std") return { scope, kb: assertInScope(scope, "标准") };
  if (scope.kbs.length === 0) return { scope, kb: sanitizeKbName(defaultKb) };
  if (scope.kbs.length === 1) return { scope, kb: scope.kbs[0] };
  throw new ScopeError(
    `本会话范围有 ${scope.kbs.length} 个知识库，请用 kb 参数指定一个：${scope.kbs.join("、")}`,
    KB_REQUIRED,
    { scope: [...scope.kbs] }
  );
}

/** 单库内按 resolveDoc 的优先级挑候选（跨库解析复用）。 */
function rankDocMatches(manifest, ref) {
  const text = String(ref ?? "").trim();
  const docs = (manifest.docs ?? []).filter((doc) => doc.deletedAt === undefined || doc.deletedAt === null);
  const byId = docs.filter((doc) => doc.id === text);
  if (byId.length === 1) return { exact: true, matches: byId };
  const byPrefix = docs.filter((doc) => doc.id.startsWith(text));
  if (byPrefix.length > 0) return { exact: false, matches: byPrefix };
  const lower = text.toLowerCase();
  const byTitle = docs.filter((doc) => String(doc.title ?? "").toLowerCase() === lower);
  if (byTitle.length > 0) return { exact: true, matches: byTitle };
  return { exact: false, matches: docs.filter((doc) => String(doc.title ?? "").toLowerCase().includes(lower)) };
}

/**
 * doc 类工具的入口：显式 kb 必须在范围内；省略时 selected 且多库 → 跨库解析。
 * 返回 { scope, kb, doc? }。doc 只在跨库解析出唯一命中时给出，其余交给工具自己 resolveDoc。
 */
export async function resolveDocTarget(exec, requestedKb, docRef, { kbRoot, defaultKb, ttlDays }) {
  const scope = await resolveExecScope(exec, { kbRoot, ttlDays });
  const hasRequest = typeof requestedKb === "string" && requestedKb.trim() !== "";
  if (hasRequest) {
    const kb = sanitizeKbName(requestedKb);
    return { scope, kb: assertInScope(scope, kb) };
  }
  const virtual = VIRTUAL_DOCS.has(String(docRef ?? "").trim().toLowerCase());
  if (scope.mode !== "selected") return { scope, kb: sanitizeKbName(defaultKb) };
  if (virtual || scope.kbs.length <= 1) {
    if (scope.kbs.length === 1) return { scope, kb: scope.kbs[0] };
    if (scope.kbs.length === 0) return { scope, kb: sanitizeKbName(defaultKb) };
    throw new ScopeError(
      `本会话范围有 ${scope.kbs.length} 个知识库；「${docRef}」是库级维护文件（schema/index/log），请用 kb 参数指定一个：${scope.kbs.join("、")}`,
      KB_REQUIRED,
      { scope: [...scope.kbs] }
    );
  }
  const exactHits = [];
  const fuzzyHits = [];
  for (const kb of scope.kbs) {
    const manifest = await readManifest(kbDirPath(kbRoot, kb));
    const { exact, matches } = rankDocMatches(manifest, docRef);
    for (const doc of matches) (exact ? exactHits : fuzzyHits).push({ kb, doc });
  }
  const hits = exactHits.length > 0 ? exactHits : fuzzyHits;
  if (hits.length === 1) return { scope, kb: hits[0].kb, doc: hits[0].doc };
  if (hits.length === 0) {
    throw new ScopeError(
      `本会话范围（${scope.kbs.join("、")}）里没有找到「${docRef}」（用 kb_list 查看文档列表）`,
      "KB_NOT_FOUND",
      { scope: [...scope.kbs], requested: docRef }
    );
  }
  const candidates = hits.slice(0, 6).map((hit) => `${hit.kb}/${hit.doc.id}（${hit.doc.title}）`).join("，");
  throw new ScopeError(
    `「${docRef}」在本会话范围内命中多个文档，请指定 kb 或用更精确的标题/id：${candidates}${hits.length > 6 ? " …" : ""}`,
    "KB_AMBIGUOUS",
    { scope: [...scope.kbs], requested: docRef, matches: hits.slice(0, 6).map((hit) => ({ kb: hit.kb, docId: hit.doc.id, title: hit.doc.title })) }
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
node --test test/scope.test.mjs
```
Expected: `pass 22`、`fail 0`。

- [ ] **Step 5: 提交**

```bash
git add lib/scope.js test/scope.test.mjs
git commit -m "feat(scope): resolution semantics with lazy inheritance snapshot"
```

---

## Task 3: `lib/scope-view.js` 纯函数

**Files:**
- Create: `lib/scope-view.js`
- Test: `test/scope-view.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `test/scope-view.test.mjs`：

```js
/**
 * 范围纯函数：chip 文案、提示文本、选择合并。服务端与客户端共用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chipLabel, isAllSelection, scopePromptText, selectionPayload } from "../lib/scope-view.js";

test("chipLabel covers all/selected/loading/failed", () => {
  assert.equal(chipLabel({ mode: "all", kbs: [] }), "知识库：全部");
  assert.equal(chipLabel({ mode: "selected", kbs: ["A", "B"] }), "知识库：2 个");
  assert.equal(chipLabel({ mode: "selected", kbs: [] }), "知识库：全部");
  assert.equal(chipLabel(null), "知识库：…");
  assert.equal(chipLabel({ mode: "all", kbs: [] }, { failed: true }), "知识库：—");
  assert.equal(chipLabel(null, { loading: true }), "知识库：…");
});

test("scopePromptText is empty for all mode", () => {
  assert.equal(scopePromptText({ mode: "all", kbs: [] }), "");
  assert.equal(scopePromptText(null), "");
});

test("scopePromptText lists selected kbs and tells how to switch", () => {
  const text = scopePromptText({ mode: "selected", kbs: ["标准", "变电试验"] });
  assert.match(text, /^\[知识库范围\] 本会话用户选定：标准、变电试验。/);
  assert.match(text, /在输入框旁的知识库选择器里调整范围/);
});

test("scopePromptText truncates beyond 20 names", () => {
  const kbs = Array.from({ length: 23 }, (_, i) => `库${i + 1}`);
  const text = scopePromptText({ mode: "selected", kbs });
  assert.match(text, /库20。?.*等 23 个/);
  assert.doesNotMatch(text, /库21/);
});

test("selectionPayload collapses all/empty to mode all", () => {
  assert.deepEqual(selectionPayload("all", ["A"]), { mode: "all", kbs: [] });
  assert.deepEqual(selectionPayload("selected", []), { mode: "all", kbs: [] });
  assert.deepEqual(selectionPayload("selected", ["B", "A"], ["A", "B"]), { mode: "selected", kbs: ["A", "B"] });
});

test("isAllSelection ignores order and duplicates", () => {
  assert.equal(isAllSelection(["A", "B"], ["B", "A"]), true);
  assert.equal(isAllSelection(["A"], ["A", "B"]), false);
  assert.equal(isAllSelection([], []), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
node --test test/scope-view.test.mjs
```
Expected: FAIL，`Cannot find module '../lib/scope-view.js'`。

- [ ] **Step 3: 实现 `lib/scope-view.js`**

```js
/**
 * 范围的展示/选择纯函数：无 node 依赖，服务端提示与客户端胶囊共用。
 */

export function chipLabel(scope, { loading = false, failed = false } = {}) {
  if (failed) return "知识库：—";
  if (loading || !scope) return "知识库：…";
  if (scope.mode === "selected" && Array.isArray(scope.kbs) && scope.kbs.length > 0) {
    return `知识库：${scope.kbs.length} 个`;
  }
  return "知识库：全部";
}

/** 系统提示里的一段范围说明；all 模式返回空串（不注入）。 */
export function scopePromptText(scope) {
  if (!scope || scope.mode !== "selected" || !Array.isArray(scope.kbs) || scope.kbs.length === 0) return "";
  const names = scope.kbs.slice(0, 20).join("、");
  const suffix = scope.kbs.length > 20 ? ` 等 ${scope.kbs.length} 个` : "";
  return `[知识库范围] 本会话用户选定：${names}${suffix}。kb_* 工具只能访问这些库；范围外资料不要读取或检索。用户要求其他库时，提示其使用输入框旁的知识库选择器切换。`;
}

/** 胶囊“应用”提交：全选/清空都折叠成 mode=all；否则按选中顺序输出。 */
export function selectionPayload(mode, kbs, order = []) {
  const picked = Array.isArray(kbs) ? [...new Set(kbs)] : [];
  if (mode === "all" || picked.length === 0) return { mode: "all", kbs: [] };
  const rank = new Map(order.map((name, index) => [name, index]));
  picked.sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
  return { mode: "selected", kbs: picked };
}

export function isAllSelection(kbs, allNames) {
  const picked = new Set(Array.isArray(kbs) ? kbs : []);
  const names = Array.isArray(allNames) ? allNames : [];
  if (picked.size !== names.length) return false;
  return names.every((name) => picked.has(name));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
node --test test/scope-view.test.mjs
```
Expected: `pass 6`、`fail 0`。

- [ ] **Step 5: 提交**

```bash
git add lib/scope-view.js test/scope-view.test.mjs
git commit -m "feat(scope): shared pure view helpers for prompt and capsule"
```

---

## Task 4: 配置项与系统提示段

**Files:**
- Modify: `lib/index.js:46`（imports）、`lib/index.js:131-158`（Config）、`lib/index.js:191-212`（cfg）、`lib/index.js:266-278`（提示段之后）
- Test: `test/scope-prompt.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `test/scope-prompt.test.mjs`：

```js
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
  const { kbRoot, section } = await setup();
  assert.equal(await textFor(section, "s1"), "");
  await writeScopes(kbRoot, { scopes: { s1: { mode: "selected", kbs: ["标准"], updatedAt: new Date().toISOString() } } });
  const text = await textFor(section, "s1");
  assert.match(text, /标准/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
node --test test/scope-prompt.test.mjs
```
Expected: FAIL，`section.name` 是 `undefined`（未注册 `kb:scope`）。

- [ ] **Step 3: 改 `lib/index.js`**

3a. 在 import 区（`import { registerKbWeb } ...` 附近）加入：

```js
import { scopeForSessionSync } from "./scope.js";
import { scopePromptText } from "./scope-view.js";
```

3b. `Config` 对象末尾（`uiMaxBatchFiles` 之后）加入：

```js
  scopeTtlDays: z.number().default(30).description("会话范围条目过期天数；0 = 不过期"),
  scopeLintMaxKbs: z.number().default(20).description("kb_lint 在 selected 模式下最多检查多少个库"),
```

3c. `apply` 的 cfg 解析区（`uiMaxBatchFiles` 之后）加入：

```js
  const scopeTtlDays = Math.min(3650, Math.max(0, Math.round(Number(cfg.scopeTtlDays ?? 30))));
  const scopeLintMaxKbs = Math.min(50, Math.max(1, Math.round(Number(cfg.scopeLintMaxKbs) || 20)));
```

3d. 在现有 `ctx.systemPrompt.section({...})` 调用之后、`const registered = [];` 之前加入：

```js
  ctx.systemPrompt.section({
    name: "kb:scope",
    order: 120,
    text: (context) => {
      try {
        const session = context?.agent?.session;
        if (session?.id === undefined) return "";
        const scope = scopeForSessionSync(kbRoot, session.id, session.header?.parentSession);
        return scopePromptText(scope);
      } catch {
        return "";
      }
    },
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
node --test test/scope-prompt.test.mjs
npm test
```
Expected: 新文件 `pass 7`；`npm test` 全绿（312 + 7）。

- [ ] **Step 5: 提交**

```bash
git add lib/index.js test/scope-prompt.test.mjs
git commit -m "feat(scope): dynamic system prompt section for selected kbs"
```

## Task 5: `kb_list` / `kb_query` 接入范围

**Files:**
- Modify: `lib/index.js`（`registerKbList` 345-429、`registerKbQuery` 951-1078、注册表 283-303）
- Test: `test/scope-tools.test.mjs`（与 Task 6-8 共用）

- [ ] **Step 1: 写失败测试**

创建 `test/scope-tools.test.mjs`（Task 6-8 会继续往里加用例）：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
node --test test/scope-tools.test.mjs
```
Expected: FAIL（`result.scope` undefined / 未抛 `KB_OUT_OF_SCOPE`）。

- [ ] **Step 3: 改 `lib/index.js`**

3a. import 行（Task 4 已加 `resolveDocTarget` 等）改为：

```js
import { assertInScope, resolveDocTarget, resolveExecScope, resolveSingleKb, scopeForSessionSync } from "./scope.js";
```

3b. `registerKbList` 签名与注册调用：

```js
function registerKbList(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
```

```js
      () => registerKbList(ctx, { kbRoot, defaultKb, scopeTtlDays }),
```

3c. `registerKbList` 的 `async execute(args) {` 改为 `async execute(args, exec) {`，并在第一行插入：

```js
      const scope = await resolveExecScope(exec, { kbRoot, ttlDays: scopeTtlDays });
      const scopeField = { mode: scope.mode, kbs: [...scope.kbs] };
```

3d. 同函数里 `if (args.kb !== undefined) {` 分支，`const kb = sanitizeKbName(args.kb);` 之后插入：

```js
        assertInScope(scope, kb);
```

并把该分支的 return 对象末尾补 `scope: scopeField`：

```js
        return {
          kb,
          kbs: [],
          docs: page,
          total,
          totalAll,
          offset,
          limit,
          hasMore: offset + page.length < total,
          schema: { exists: schema.exists, chars: schema.chars },
          scope: scopeField,
        };
```

3e. 同函数末尾的 `return { kbs: await listKbs(kbRoot), docs: [] };` 改为：

```js
      const entries = await listKbs(kbRoot);
      const visible = scope.mode === "selected" ? entries.filter((kb) => scope.kbs.includes(kb.name)) : entries;
      return { kbs: visible, docs: [], scope: scopeField };
```

3f. `output.schema.properties` 里加（`schema: { type: "object", additionalProperties: true },` 之后）：

```js
          scope: { type: "object", additionalProperties: true },
```

3g. `registerKbQuery` 签名与注册调用：

```js
function registerKbQuery(ctx, { kbRoot, defaultKb, queryMaxMatches, queryLineBytes, scopeTtlDays }) {
```

```js
      () => registerKbQuery(ctx, { kbRoot, defaultKb, queryMaxMatches, queryLineBytes, scopeTtlDays }),
```

3h. `registerKbQuery` 的 `async execute(args, exec) {` 之后、`const pattern = ...` 之前插入 scope 与跨库搜索闭包，并把原 `if (args.kb === "*") { ... }` 整段替换为按范围分派的版本。替换后的开头到单库分支之前应为：

```js
    async execute(args, exec) {
      const pattern = String(args.pattern);
      const effectivePattern = expandStdQuery(pattern) ?? pattern;
      const expandedPattern = effectivePattern !== pattern ? effectivePattern : undefined;
      const maxMatches = Math.min(500, Math.max(1, Math.round(Number(args.maxMatches) || queryMaxMatches)));
      const scope = await resolveExecScope(exec, { kbRoot, ttlDays: scopeTtlDays });
      const scopeField = { mode: scope.mode, kbs: [...scope.kbs] };

      const star = args.kb === "*";
      const explicit = !star && typeof args.kb === "string" && args.kb.trim() !== "";
      const crossKb = star || (scope.mode === "selected" && !explicit);
      if (crossKb && args.doc !== undefined) {
        throw new Error("doc 只能用于单个知识库；跨库检索请去掉 doc 参数，或用 kb 指定一个库");
      }
      if (crossKb) {
        const entries = await listKbs(kbRoot);
        const dirFor = (name) => entries.find((kb) => kb.name === name)?.dir ?? name;
        const names = star
          ? (scope.mode === "selected" ? scope.kbs : entries.map((kb) => kb.name))
          : scope.kbs;
        const searchedKbs = [];
        const combined = [];
        let total = 0;
        let lossy = false;
        for (const name of names) {
          const dir = kbDirPath(kbRoot, dirFor(name));
          const manifest = await readManifest(dir);
          const result = await searchKb(ctx, exec, dir, manifest, {
            pattern: effectivePattern,
            maxMatches: Math.max(20, Math.min(200, maxMatches * 2)),
            lineBytes: queryLineBytes,
          });
          total += result.total;
          lossy = lossy || result.lossy === true;
          searchedKbs.push(name);
          for (const match of result.matches) combined.push({ ...match, kb: name });
        }
        const ranked = rankMatches(combined, { pattern: effectivePattern, maxMatches, perDocMax: 5 });
        return {
          kb: "*",
          pattern,
          ...(expandedPattern ? { expandedPattern } : {}),
          total,
          truncated: total > ranked.length || lossy,
          lossy,
          matches: ranked,
          searchedKbs,
          scope: scopeField,
          ...(lossy ? { note: "部分知识库结果超出缓冲上限，已保留缓冲区内的匹配" } : {}),
        };
      }

      const kb = sanitizeKbName(args.kb ?? defaultKb);
      assertInScope(scope, kb);
```

3i. `registerKbQuery` 末尾单库分支的 return 补 `scope: scopeField`：

```js
      return { kb, ...result, pattern, ...(expandedPattern ? { expandedPattern } : {}), scope: scopeField };
```

3j. `registerKbQuery` 的 output schema 加：

```js
          scope: { type: "object", additionalProperties: true },
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
node --test test/scope-tools.test.mjs
npm test
```
Expected: Task 5 的 8 个用例通过；`npm test` 全绿。

- [ ] **Step 5: 提交**

```bash
git add lib/index.js test/scope-tools.test.mjs
git commit -m "feat(scope): enforce scope in kb_list and kb_query"
```

---

## Task 6: doc 组工具（10 个）接入

**Files:**
- Modify: `lib/index.js`（`registerKbRead` 1121-1420、`registerKbView` 1421-1632、`registerKbEdit` 1633-1800、`registerKbDescribe` 2060-2231、`registerKbKeep` 2232-2335、`registerKbTrust` 2336-2486、`registerKbRetitle` 2487-2616、`registerKbRestore` 2936-3005、`registerKbHistory` 3006-3067、`registerKbRemove` 2857-2935）
- Test: `test/scope-tools.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试**

在 `test/scope-tools.test.mjs` 末尾追加：

```js
test("doc tools: selected single kb resolves without kb argument", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  const doc = await importDoc("a.md", "# 甲\n\n继电保护技术条件正文。\n", "甲库", "继电保护技术条件");
  await scope("s1", ["甲库"]);
  const read = await tools.get("kb_read").execute({ doc: doc.docId }, scoped("s1"));
  assert.equal(read.kb, "甲库");
  const view = await tools.get("kb_read").execute({ doc: "继电", part: "outline" }, scoped("s1"));
  assert.equal(view.docId, doc.docId);
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

test("doc tools: duplicate titles across kbs report candidates", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n交接试验规程正文。\n", "甲库", "交接试验规程");
  await importDoc("b.md", "# 乙\n\n交接试验规程正文。\n", "乙库", "交接试验规程");
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
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
node --test test/scope-tools.test.mjs
```
Expected: 新增用例 FAIL（`error.code` undefined，工具仍落到 `defaultKb`）。

- [ ] **Step 3: 改 10 个工具**

对下列每个工具，按同一模式改三处：

| 工具 | register 函数起始行 | 注册调用行 |
|---|---|---|
| `kb_read` | 1121 | 287 |
| `kb_view` | 1421 | 288 |
| `kb_edit` | 1633 | 289 |
| `kb_describe` | 2060 | 290 |
| `kb_retitle` | 2487 | 291 |
| `kb_trust` | 2336 | 293 |
| `kb_keep` | 2232 | 294 |
| `kb_restore` | 2936 | 299 |
| `kb_history` | 3006 | 300 |
| `kb_remove` | 2857 | 298 |

模式（以 `kb_read` 为例）：

1）签名加 `scopeTtlDays`：
```js
function registerKbRead(ctx, { kbRoot, defaultKb, readMaxChars, partMaxChars, scopeTtlDays }) {
```
2）注册调用加参数：
```js
      () => registerKbRead(ctx, { kbRoot, defaultKb, readMaxChars, partMaxChars, scopeTtlDays }),
```
3）`async execute(args) {` → `async execute(args, exec) {`，并把
```js
      const kb = sanitizeKbName(args.kb ?? defaultKb);
```
替换为
```js
      const { kb } = await resolveDocTarget(exec, args.kb, args.doc, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
```

`kb_view` / `kb_edit` / `kb_describe` / `kb_retitle` / `kb_trust` / `kb_keep` / `kb_restore` / `kb_history` 同模式（这些工具本来就有 `const kb = sanitizeKbName(args.kb ?? defaultKb);` 一行）。

`kb_remove` 特殊（同一个 `const kb` 同时服务文档级与整库删除）：把 execute 开头改为：

```js
    async execute(args, exec) {
      if (args.doc === undefined && args.removeKb === true) {
        if (typeof args.kb !== "string" || args.kb.trim() === "") {
          throw new ScopeError("删除整个知识库必须显式指定 kb", "KB_REQUIRED");
        }
        const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays }, { policy: "kbAdmin" });
        const confirm = String(args.confirm ?? "").trim();
        if (confirm !== kb) {
          throw new Error(`删除整个知识库「${kb}」不可恢复。请确认后重试：同时传 removeKb=true 和 confirm="${kb}"（逐字一致）`);
        }
        await removeKbDir(kbRoot, kb);
        return { kb, removed: `已删除整个知识库「${kb}」`, soft: false };
      }
      const { kb } = await resolveDocTarget(exec, args.kb, args.doc, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      if (args.doc !== undefined) {
        const dir = kbDirPath(kbRoot, kb);
        const manifest = await readManifest(dir);
        const soft = args.soft !== false;
        // 原有文档级删除分支（软删/永久删 + appendLog + refreshKbIndex）保持原样，不要改动。
      }
      throw new Error("未指定 doc 时删除整个知识库需要显式传 removeKb=true 且 confirm 等于知识库名称");
    },
```

注意：删除原来 execute 开头两行（`const kb = ...` 与紧随的文档级 `if`），并把原 `if (args.removeKb === true) { ... }` 整段删除（其逻辑已移到上面的整库分支）。文档级删除的中间代码原样保留。

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
node --test test/scope-tools.test.mjs
npm test
```
Expected: 新增 7 个用例通过；`npm test` 全绿。

- [ ] **Step 5: 提交**

```bash
git add lib/index.js test/scope-tools.test.mjs
git commit -m "feat(scope): enforce scope across doc-level kb tools with cross-kb resolution"
```

---

## Task 7: 单库组工具（6 个）接入

**Files:**
- Modify: `lib/index.js`（`registerKbImport` 539-767、`registerKbReparse` 768-950、`registerKbEditBatch` 1801-2059、`registerKbAddNote` 2686-2856、`registerKbSnapshot` 3068-3131、`registerKbExport` 3132-3240）
- Test: `test/scope-tools.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试**

```js
test("single-kb tools: import uses the only scope kb", async () => {
  const { tools, scoped, scope, root } = await setup();
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
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
node --test test/scope-tools.test.mjs
```
Expected: 新增用例 FAIL。

- [ ] **Step 3: 改 6 个工具**

对每个工具：签名加 `scopeTtlDays`、注册调用加参数、`execute(args)` 补 `exec`、把 `const kb = sanitizeKbName(args.kb ?? defaultKb);` 替换为：

```js
      const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
```

工具与注册调用行：

| 工具 | register 函数起始行 | 注册调用行 |
|---|---|---|
| `kb_import` | 539 | 284 |
| `kb_reparse` | 768 | 285 |
| `kb_edit_batch` | 1801 | 295 |
| `kb_add_note` | 2686 | 297 |
| `kb_snapshot` | 3068 | 296 |
| `kb_export` | 3132 | 301 |

注意：
- `kb_import` / `kb_reparse` 的 execute 已是 `(args, exec)`，只替换 kb 解析那一行。
- `kb_export` 的 execute 已是 `(args, exec)`。
- `kb_snapshot` / `kb_add_note` / `kb_edit_batch` 需要把 `execute(args)` 改成 `execute(args, exec)`。
- 保持 `kb_edit_batch` 仍是单库事务（不要改成跨库）。

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
node --test test/scope-tools.test.mjs
npm test
```
Expected: 新增 5 个用例通过；`npm test` 全绿。

- [ ] **Step 5: 提交**

```bash
git add lib/index.js test/scope-tools.test.mjs
git commit -m "feat(scope): enforce scope in single-kb tools"
```

---

## Task 8: `kb_lint` 多库 + `kb_std_check` + 库级管理

**Files:**
- Modify: `lib/index.js`（`registerKbLint` 2617-2685、`renderKbLint`、`registerKbStdCheck` 3270-3382、`registerKbRename` 3241-3269）
- Test: `test/scope-tools.test.mjs`（追加）

- [ ] **Step 1: 追加失败测试**

```js
test("kb_lint: selected multi-kb scope lints each kb and groups results", async () => {
  const { tools, scoped, importDoc, scope } = await setup();
  await importDoc("a.md", "# 甲\n\n正文。\n", "甲库", "甲文档");
  await importDoc("b.md", "# 乙\n\n正文。\n", "乙库", "乙文档");
  await scope("s1", ["甲库", "乙库"]);
  const result = await tools.get("kb_lint").execute({}, scoped("s1"));
  assert.equal(result.kb, "scope");
  assert.deepEqual(result.kbs.map((row) => row.kb), ["甲库", "乙库"]);
  assert.match(tools.get("kb_lint").render({}, result)[0].text, /甲库/);
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
  const { tools, scoped } = await setup();
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
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
node --test test/scope-tools.test.mjs
```
Expected: 新增用例 FAIL。

- [ ] **Step 3: 改 `lib/index.js`**

3a. `registerKbLint` 签名与注册调用：

```js
function registerKbLint(ctx, { kbRoot, defaultKb, scopeTtlDays, scopeLintMaxKbs }) {
```
```js
      () => registerKbLint(ctx, { kbRoot, defaultKb, scopeTtlDays, scopeLintMaxKbs }),
```

3b. `registerKbLint` 的 output schema 加：

```js
          kbs: { type: "array", items: { type: "object", additionalProperties: true } },
```

3c. `registerKbLint` 的 execute 替换为：

```js
    async execute(args, exec) {
      const scope = await resolveExecScope(exec, { kbRoot, ttlDays: scopeTtlDays });
      const maxItems = Math.min(200, Math.max(1, Math.round(Number(args.maxItems) || 20)));
      const staleDays = Math.min(3650, Math.max(0, Math.round(Number(args.staleDays) ?? 90)));
      const lintOne = async (kb) => {
        const dir = kbDirPath(kbRoot, kb);
        const manifest = await readManifest(dir);
        const schema = await readSchema(dir);
        return { kb, ...lintManifest(manifest, { kbName: kb, hasSchema: schema.exists, staleDays, maxItems }) };
      };
      const requested = typeof args.kb === "string" && args.kb.trim() !== "";
      if (requested) {
        const kb = sanitizeKbName(args.kb);
        assertInScope(scope, kb);
        return lintOne(kb);
      }
      if (scope.mode === "selected") {
        const names = scope.kbs.slice(0, scopeLintMaxKbs);
        const results = [];
        for (const name of names) results.push(await lintOne(name));
        if (results.length === 1) return results[0];
        return { kb: "scope", kbs: results };
      }
      return lintOne(sanitizeKbName(defaultKb));
    },
```

3d. `renderKbLint` 开头加多库分支：

```js
function renderKbLint(value) {
  if (Array.isArray(value.kbs) && value.kbs.length > 1) {
    return value.kbs.map((entry) => renderKbLint(entry)).join("\n\n");
  }
```
（保留原有函数体不变。）

3e. `registerKbStdCheck` 签名与注册调用加 `scopeTtlDays`：

```js
  const {
    kbRoot, defaultKb, scopeTtlDays, bzBaseUrl, bzCookie, stdRateMs, stdMaxAgeDays, stdTimeoutMs, buildImportConfig,
  } = opts;
```
```js
      () => registerKbStdCheck(ctx, { kbRoot, defaultKb, scopeTtlDays, bzBaseUrl, bzCookie, stdRateMs, stdMaxAgeDays, stdTimeoutMs, buildImportConfig }),
```

3f. `registerKbStdCheck` 的 execute 里把：

```js
      const kb = sanitizeKbName(args.kb ?? defaultKb);
```
替换为：
```js
      const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays }, { policy: "std" });
```

3g. `registerKbRename` 签名、注册调用、execute：

```js
function registerKbRename(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
```
```js
      () => registerKbRename(ctx, { kbRoot, defaultKb, scopeTtlDays }),
```
```js
    async execute(args, exec) {
      if (typeof args.kb !== "string" || args.kb.trim() === "") {
        throw new ScopeError("重命名必须显式指定 kb", "KB_REQUIRED");
      }
      const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays }, { policy: "kbAdmin" });
      const dir = await renameKb(kbRoot, kb, args.newName);
      return { kb: sanitizeKbName(args.newName), dir };
    },
```

3h. import 行补 `ScopeError`：

```js
import { ScopeError, assertInScope, resolveDocTarget, resolveExecScope, resolveSingleKb, scopeForSessionSync } from "./scope.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
node --test test/scope-tools.test.mjs
npm test
```
Expected: 新增 6 个用例通过；`npm test` 全绿（注意 `kb_std_check` 默认库变化不影响现有用例——现有测试没有覆盖无 kb 的 std_check）。

- [ ] **Step 5: 提交**

```bash
git add lib/index.js test/scope-tools.test.mjs
git commit -m "feat(scope): lint across scoped kbs, std check and kb admin honour scope"
```

## Task 9: `/kb/api/scope` 读写 API

**Files:**
- Modify: `lib/web/api.js`（imports 1-30、`mapError` 31-46、status 85-94、kbs 之后新增 scope 路由）
- Test: `test/scope-api.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `test/scope-api.test.mjs`：

```js
/**
 * GET/PUT /kb/api/scope：校验、鉴权、归档判定、features.scope。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/scope", headers = {}, body } = {}) {
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:55929",
      origin: "http://127.0.0.1:55929",
      "x-kb-ui": "1",
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

async function call(kbRoot, req) {
  const res = makeRes();
  await handleApi(req, res, { opts: { kbRoot }, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

async function setup() {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-scope-api-")), "kb");
  for (const name of ["甲库", "乙库"]) {
    const { res } = await call(kbRoot, makeReq({ method: "POST", url: "/kb/api/kbs", body: { name } }));
    assert.equal(res.status, 201);
  }
  return kbRoot;
}

test("status advertises features.scope", async () => {
  const kbRoot = await setup();
  const { res, json } = await call(kbRoot, makeReq({ url: "/kb/api/status" }));
  assert.equal(res.status, 200);
  assert.equal(json.features.scope, true);
});

test("GET returns all mode for a fresh session", async () => {
  const kbRoot = await setup();
  const { res, json } = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=s1" }));
  assert.equal(res.status, 200);
  assert.deepEqual(json.scope, { mode: "all", kbs: [], inheritedFrom: null });
  assert.deepEqual(json.resolved, []);
});

test("GET validates the session parameter", async () => {
  const kbRoot = await setup();
  const missing = await call(kbRoot, makeReq({ url: "/kb/api/scope" }));
  assert.equal(missing.res.status, 400);
  assert.equal(missing.json.error.code, "SCOPE_INVALID");
  const tooLong = await call(kbRoot, makeReq({ url: `/kb/api/scope?session=${"a".repeat(201)}` }));
  assert.equal(tooLong.res.status, 400);
});

test("PUT saves a selected scope and GET reflects it with resolved counts", async () => {
  const kbRoot = await setup();
  const put = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "selected", kbs: ["甲库"] },
  }));
  assert.equal(put.res.status, 200);
  assert.deepEqual(put.json.scope.kbs, ["甲库"]);
  assert.deepEqual(put.json.resolved.map((row) => row.name), ["甲库"]);
  assert.equal(put.json.resolved[0].docs, 0);
  assert.equal(put.json.resolved[0].empty, true);
  assert.ok(put.json.updatedAt);

  const get = await call(kbRoot, makeReq({ url: "/kb/api/scope?session=s1" }));
  assert.deepEqual(get.json.scope.kbs, ["甲库"]);
  assert.ok(get.json.updatedAt);
});

test("PUT mode=all clears kbs", async () => {
  const kbRoot = await setup();
  await call(kbRoot, makeReq({ method: "PUT", body: { session: "s1", mode: "selected", kbs: ["甲库"] } }));
  const put = await call(kbRoot, makeReq({ method: "PUT", body: { session: "s1", mode: "all", kbs: ["甲库"] } }));
  assert.equal(put.res.status, 200);
  assert.deepEqual(put.json.scope, { mode: "all", kbs: [], inheritedFrom: null });
});

test("PUT rejects an invalid mode", async () => {
  const kbRoot = await setup();
  const { res, json } = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "weird", kbs: [] },
  }));
  assert.equal(res.status, 400);
  assert.equal(json.error.code, "SCOPE_INVALID");
});

test("PUT reports missing and archived kbs distinctly", async () => {
  const kbRoot = await setup();
  const missing = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "selected", kbs: ["不存在"] },
  }));
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error.code, "KB_NOT_FOUND");

  await call(kbRoot, makeReq({ method: "POST", url: "/kb/api/kbs/%E4%B9%99%E5%BA%93/archive", body: { confirm: "乙库" } }));
  const archived = await call(kbRoot, makeReq({
    method: "PUT",
    body: { session: "s1", mode: "selected", kbs: ["乙库"] },
  }));
  assert.equal(archived.res.status, 409);
  assert.equal(archived.json.error.code, "KB_ARCHIVED");
});

test("PUT requires the x-kb-ui header", async () => {
  const kbRoot = await setup();
  const { res } = await call(kbRoot, makeReq({
    method: "PUT",
    headers: { "x-kb-ui": "" },
    body: { session: "s1", mode: "all", kbs: [] },
  }));
  assert.equal(res.status, 403);
});

test("PUT rejects a cross-origin request", async () => {
  const kbRoot = await setup();
  const { res } = await call(kbRoot, makeReq({
    method: "PUT",
    headers: { origin: "http://evil.example" },
    body: { session: "s1", mode: "all", kbs: [] },
  }));
  assert.equal(res.status, 403);
});

test("PUT reports SCOPE_WRITE_FAILED when the scopes file cannot be written", async () => {
  const kbRoot = await setup();
  await chmod(kbRoot, 0o555);
  try {
    const { res, json } = await call(kbRoot, makeReq({
      method: "PUT",
      body: { session: "s1", mode: "all", kbs: [] },
    }));
    assert.equal(res.status, 500);
    assert.equal(json.error.code, "SCOPE_WRITE_FAILED");
  } finally {
    await chmod(kbRoot, 0o755);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
node --test test/scope-api.test.mjs
```
Expected: FAIL（`features.scope` undefined / scope 路由 404）。

- [ ] **Step 3: 改 `lib/web/api.js`**

3a. imports 加入：

```js
import { normalizeSessionId, resolveScope, setScope } from "../scope.js";
import { readScopes } from "../scope-store.js";
```

3b. `mapError` 开头（`if (error instanceof WebError) return error;` 之后）加：

```js
  if (error?.name === "ScopeError") {
    const status = error.code === "KB_NOT_FOUND"
      ? 404
      : error.code === "KB_ARCHIVED"
        ? 409
        : error.code === "SCOPE_WRITE_FAILED"
          ? 500
          : 400;
    return new KbError(error.code, status, error.message, error.details);
  }
```

3c. status features 加 `scope: true`：

```js
        features: { ui: true, merge: false, std: true, upload: true, jobs: true, scope: true },
```

3d. 在 `mapError` 之后、`ensureKb` 之前加公共响应构造器：

```js
async function scopeResponse(opts, scope, sessionId) {
  const live = await listKbs(opts.kbRoot);
  const byName = new Map();
  for (const kb of live) {
    if (kb.mergedInto == null) byName.set(kb.name, kb);
  }
  const resolved = scope.mode === "selected"
    ? scope.kbs
        .filter((name) => byName.has(name))
        .map((name) => {
          const kb = byName.get(name);
          const docs = kb.docs ?? 0;
          return { name, docs, empty: docs === 0 };
        })
    : [];
  const data = await readScopes(opts.kbRoot);
  return {
    scope: { mode: scope.mode, kbs: [...scope.kbs], inheritedFrom: scope.inheritedFrom ?? null },
    resolved,
    updatedAt: data.scopes[sessionId]?.updatedAt ?? null,
  };
}
```

3e. 在 status 路由块之后加 GET/PUT 路由：

```js
    if (segments.length === 1 && segments[0] === "scope" && method === "GET") {
      const sessionId = url.searchParams.get("session") ?? "";
      if (normalizeSessionId(sessionId) === null) {
        throw new KbError("SCOPE_INVALID", 400, "session 必须是 1–200 字符、无控制字符");
      }
      const scope = await resolveScope(opts.kbRoot, {
        sessionId,
        snapshot: false,
        ttlDays: opts.scope?.ttlDays,
      });
      return sendJson(res, 200, await scopeResponse(opts, scope, sessionId));
    }

    if (segments.length === 1 && segments[0] === "scope" && method === "PUT") {
      const body = await readJsonBody(req);
      const scope = await setScope(opts.kbRoot, {
        sessionId: body?.session,
        mode: body?.mode,
        kbs: body?.kbs,
      });
      return sendJson(res, 200, await scopeResponse(opts, scope, String(body?.session ?? "").trim()));
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
node --test test/scope-api.test.mjs
npm test
```
Expected: 新文件 `pass 10`；`npm test` 全绿。

- [ ] **Step 5: 提交**

```bash
git add lib/web/api.js test/scope-api.test.mjs
git commit -m "feat(scope): GET/PUT /api/scope and features.scope"
```

---

## Task 10: 重命名/归档同步 `.scopes.json`

**Files:**
- Modify: `lib/index.js`（`kb_rename` execute，3238-3268）
- Modify: `lib/web/api.js`（PATCH 257-282）
- Modify: `lib/kbmeta.js`（删除本地 `removeScopesReferences`，`archiveKb` 82-93、`purgeKb` 285-305）
- Test: `test/scope-sync.test.mjs`

- [ ] **Step 1: 写失败测试**

创建 `test/scope-sync.test.mjs`（同时覆盖工具与 HTTP 两个调用点）：

```js
/**
 * 库改名/归档/彻底删除时同步 .scopes.json（工具与 HTTP 两个调用点都要覆盖）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { handleApi } from "../lib/web/api.js";
import { archiveKb, listTrash, purgeKb } from "../lib/kbmeta.js";
import { readScopes, writeScopes } from "../lib/scope-store.js";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method, url, body } = {}) {
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:55929",
      origin: "http://127.0.0.1:55929",
      "x-kb-ui": "1",
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

async function call(kbRoot, req) {
  const res = makeRes();
  await handleApi(req, res, { opts: { kbRoot }, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-scope-sync-"));
  const kbRoot = join(root, "kb");
  for (const name of ["甲库", "乙库"]) {
    const dir = join(kbRoot, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "kb.json"), JSON.stringify({ schemaVersion: 5, name, docs: [] }), "utf8");
  }
  const tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    systemPrompt: { section() {} },
    get() { return undefined; },
    subprocess: {
      spawn({ argv, cwd }) {
        const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
        const done = new Promise((resolve) => child.on("close", (exitCode) => resolve({ exitCode })));
        return {
          done,
          collected: {
            stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
          },
          terminate: () => child.kill(),
        };
      },
    },
  };
  await apply(ctx, { kbRoot, defaultKb: "甲库" });
  const exec = { agent: { session: { id: "s1", header: { cwd: root } } }, signal: new AbortController().signal };
  await writeScopes(kbRoot, {
    scopes: {
      s1: { mode: "selected", kbs: ["甲库", "乙库"], updatedAt: new Date().toISOString() },
    },
  });
  return { root, kbRoot, tools, exec };
}

test("kb_rename tool syncs the new name into scopes", async () => {
  const { kbRoot, tools, exec } = await setup();
  const result = await tools.get("kb_rename").execute({ kb: "甲库", newName: "甲库2" }, exec);
  assert.equal(result.kb, "甲库2");
  const data = await readScopes(kbRoot);
  assert.deepEqual(data.scopes.s1.kbs, ["甲库2", "乙库"]);
});

test("PATCH /kbs/:name rename syncs scopes", async () => {
  const { kbRoot } = await setup();
  const { res } = await call(kbRoot, makeReq({
    method: "PATCH",
    url: "/kb/api/kbs/%E7%94%B2%E5%BA%93",
    body: { name: "甲库3" },
  }));
  assert.equal(res.status, 200);
  const data = await readScopes(kbRoot);
  assert.deepEqual(data.scopes.s1.kbs, ["甲库3", "乙库"]);
});

test("archiveKb removes the name from scopes", async () => {
  const { kbRoot } = await setup();
  await archiveKb(kbRoot, "乙库");
  const data = await readScopes(kbRoot);
  assert.deepEqual(data.scopes.s1.kbs, ["甲库"]);
});

test("purgeKb removes the name from scopes", async () => {
  const { kbRoot } = await setup();
  await archiveKb(kbRoot, "乙库");
  const [entry] = await listTrash(kbRoot);
  await purgeKb(kbRoot, entry.dir);
  const data = await readScopes(kbRoot);
  assert.deepEqual(data.scopes.s1.kbs, ["甲库"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
node --test test/scope-sync.test.mjs
```
Expected: 归档/删除用例 FAIL（scopes 里仍有「乙库」）。

- [ ] **Step 3: 改三个文件**

3a. `lib/kbmeta.js`：删除本地 `removeScopesReferences`（第 220-253 行整段），import 区加：

```js
import { removeScopeKb } from "./scope-store.js";
```

`archiveKb` 的 `await rename(dir, target);` 之后加：

```js
  await removeScopeKb(root, name).catch(() => {});
```

`purgeKb` 里的 `await removeScopesReferences(base, name).catch(() => {});` 改为：

```js
  await removeScopeKb(base, name).catch(() => {});
```

3b. `lib/index.js`：import 区加 `renameScopeKb`：

```js
import { renameScopeKb } from "./scope-store.js";
```

`kb_rename` 的 execute 里，`const dir = await renameKb(kbRoot, kb, args.newName);` 之后加：

```js
      const next = sanitizeKbName(args.newName);
      await renameScopeKb(kbRoot, kb, next).catch(() => {});
```

并把 return 改为使用 `next`：

```js
      return { kb: next, dir };
```

3c. `lib/web/api.js`：import 区加 `renameScopeKb`：

```js
import { renameScopeKb } from "../scope-store.js";
```

PATCH 分支里 `await renameKb(opts.kbRoot, current, next);` 之后加：

```js
          await renameScopeKb(opts.kbRoot, current, next).catch(() => {});
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
node --test test/scope-sync.test.mjs
npm test
```
Expected: 新文件 `pass 4`；`npm test` 全绿。

- [ ] **Step 5: 提交**

```bash
git add lib/index.js lib/web/api.js lib/kbmeta.js test/scope-sync.test.mjs
git commit -m "feat(scope): sync .scopes.json on rename, archive and purge"
```

---

## Task 11: 客户端——抽 `WorkbenchModal` + 胶囊

**Files:**
- Modify: `src/client/index.tsx`（整文件重写）
- Modify: `lib/scope-view.d.ts`（新建类型声明）
- Modify: `tsconfig.json`（include 加入 d.ts）
- Build: `lib/client.js`

- [ ] **Step 1: 写类型声明 `lib/scope-view.d.ts`**

```ts
export function chipLabel(
  scope: { mode: string; kbs: string[] } | null,
  options?: { loading?: boolean; failed?: boolean }
): string;
export function scopePromptText(scope: { mode: string; kbs: string[] } | null): string;
export function selectionPayload(mode: string, kbs: string[], order?: string[]): { mode: string; kbs: string[] };
export function isAllSelection(kbs: string[], allNames: string[]): boolean;
```

- [ ] **Step 2: `tsconfig.json` 的 include 改为**

```json
  "include": ["src/client/**/*.tsx", "lib/scope-view.d.ts"]
```

- [ ] **Step 3: 重写 `src/client/index.tsx`**

完整文件内容：

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ComponentType } from "react";
import { chipLabel, isAllSelection, selectionPayload } from "../../lib/scope-view.js";

export const inject = ["slots"];

type KbProps = { wide?: boolean };
type Scope = { mode: "all" | "selected"; kbs: string[]; inheritedFrom?: string | null };
type KbSummary = {
  name: string;
  description?: string;
  docs?: number;
  mergedInto?: string | null;
};
type ScopeSlotProps = { sessionId?: string };
type SlotDeclaration = { name: string; id: string; order?: number };
type SlotContext = {
  slots: {
    inject(name: string, callback: () => void): void;
    register(declaration: SlotDeclaration, component: ComponentType<any>): void;
  };
};

const API = "/kb/api";
const CSS_ID = "dsh-knowledge-wiki/sidebar-entry.css";
const CSS = `
.dsh-kb-entry { box-sizing: border-box; display: flex; flex: 1 1 0; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 36px; margin: 8px 2px 0; padding: 7px 8px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; text-align: left; text-decoration: none; cursor: pointer; }
.dsh-kb-entry:hover, .dsh-kb-entry-active { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-kb-entry:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe)); outline-offset: -2px; }
.dsh-kb-entry svg { flex: none; }
.dsh-kb-entry-collapsed { flex: 0 0 auto; width: 36px; height: 36px; min-height: 36px; justify-content: center; margin: 8px 0 0; padding: 0; }
.dsh-kb-entry-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-kb-modal-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 24px; background: rgba(0, 0, 0, 0.55); }
.dsh-kb-modal { display: flex; flex-direction: column; width: min(1180px, 100%); height: min(860px, 100%); overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff)); color: var(--dsw-alias-label-primary, #111); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.4); }
.dsh-kb-modal-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 44px; padding: 0 10px 0 16px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); font-size: 14px; font-weight: 600; }
.dsh-kb-modal-close { width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #666); font-size: 20px; line-height: 1; cursor: pointer; }
.dsh-kb-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary, #111); }
.dsh-kb-modal-frame { flex: 1; width: 100%; border: 0; background: #fff; }
.dsh-kb-scope-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 190px; height: 24px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #666); font: inherit; font-size: 12px; line-height: 24px; cursor: pointer; }
.dsh-kb-scope-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary, #111); }
.dsh-kb-scope-chip-active { color: var(--dsw-alias-state-business-primary, #4d6bfe); }
.dsh-kb-scope-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-kb-scope-panel { position: fixed; z-index: 1200; display: flex; flex-direction: column; width: 320px; max-height: 420px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #111); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35); }
.dsh-kb-scope-head { padding: 10px 12px 6px; font-size: 13px; font-weight: 600; }
.dsh-kb-scope-search { height: 28px; margin: 0 12px 8px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 12px; }
.dsh-kb-scope-list { flex: 1; overflow: auto; padding: 0 6px 6px; }
.dsh-kb-scope-row { display: flex; align-items: center; gap: 8px; padding: 6px; border-radius: 8px; font-size: 12px; cursor: pointer; }
.dsh-kb-scope-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-kb-scope-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-kb-scope-meta { flex: none; color: var(--dsw-alias-label-tertiary, #999); font-size: 11px; }
.dsh-kb-scope-empty { padding: 18px 12px; text-align: center; color: var(--dsw-alias-label-secondary, #666); font-size: 12px; }
.dsh-kb-scope-actions { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); font-size: 12px; }
.dsh-kb-scope-actions button { padding: 5px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, #111); font: inherit; font-size: 12px; cursor: pointer; }
.dsh-kb-scope-actions button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-kb-scope-primary { background: var(--dsw-alias-state-business-primary, #4d6bfe) !important; color: #fff !important; }
.dsh-kb-scope-primary:disabled { opacity: 0.5; cursor: default; }
.dsh-kb-scope-link { margin-left: auto; color: var(--dsw-alias-label-secondary, #666) !important; }
.dsh-kb-scope-toast { position: fixed; z-index: 1300; padding: 6px 12px; border-radius: 999px; background: rgba(0, 0, 0, 0.78); color: #fff; font-size: 12px; }
`;

function ensureCss() {
  if (typeof document === "undefined") return;
  const selector = `style[data-plugin-css="${CSS_ID}"]`;
  if (document.querySelector(selector) !== null) return;
  const style = document.createElement("style");
  style.dataset.pluginCss = CSS_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function DatabaseIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

function WorkbenchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="dsh-kb-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dsh-kb-modal" role="dialog" aria-modal="true" aria-label="知识库工作台">
        <div className="dsh-kb-modal-head">
          <span>知识库工作台</span>
          <button type="button" className="dsh-kb-modal-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <iframe className="dsh-kb-modal-frame" src="/kb/?embed=1" title="知识库工作台" />
      </div>
    </div>,
    document.body
  );
}

/** 侧栏入口 + 工作台弹窗。 */
export function KbWorkbenchAction({ wide = false }: KbProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`dsh-kb-entry${wide ? "" : " dsh-kb-entry-collapsed"}${open ? " dsh-kb-entry-active" : ""}`}
        title="知识库工作台"
        aria-label="知识库工作台"
        aria-pressed={open}
        onClick={() => setOpen(true)}
      >
        <DatabaseIcon />
        {wide ? <span className="dsh-kb-entry-label">知识库</span> : null}
      </button>
      <WorkbenchModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

type Phase = "loading" | "ready" | "failed" | "hidden";

export function KbScopeCapsule({ sessionId }: ScopeSlotProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [scope, setScope] = useState<Scope | null>(null);
  const [kbs, setKbs] = useState<KbSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);

  const closePanel = useCallback(() => setOpen(false), []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!sessionId) {
        setPhase("hidden");
        return;
      }
      setPhase("loading");
      let status;
      try {
        status = await getJson<{ features?: { scope?: boolean } }>("/status");
      } catch {
        // 没有工作台/没有 webServer：静默不渲染
        if (!cancelled) setPhase("hidden");
        return;
      }
      if (cancelled) return;
      if (status.features?.scope !== true) {
        setPhase("hidden");
        return;
      }
      try {
        const [scopeResponse, kbsResponse] = await Promise.all([
          getJson<{ scope: Scope }>(`/scope?session=${encodeURIComponent(sessionId)}`),
          getJson<{ kbs: KbSummary[] }>("/kbs"),
        ]);
        if (cancelled) return;
        setScope(scopeResponse.scope);
        setKbs((kbsResponse.kbs ?? []).filter((kb) => kb.mergedInto == null));
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("failed");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, retry]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function place() {
      const rect = chipRef.current?.getBoundingClientRect();
      if (!rect) {
        setPosition(null);
        return;
      }
      const width = 320;
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
      const top = Math.max(8, rect.top - 8 - 420);
      setPosition({ top, left });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const names = kbs.map((kb) => kb.name);
  const label = chipLabel(scope, { loading: phase === "loading", failed: phase === "failed" });
  const active = phase === "ready" && scope?.mode === "selected";
  const filtered = query.trim() === ""
    ? kbs
    : kbs.filter((kb) => `${kb.name} ${kb.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));

  if (phase === "hidden") return null;

  async function refreshPanel() {
    if (!sessionId) return;
    try {
      const [scopeResponse, kbsResponse] = await Promise.all([
        getJson<{ scope: Scope }>(`/scope?session=${encodeURIComponent(sessionId)}`),
        getJson<{ kbs: KbSummary[] }>("/kbs"),
      ]);
      setScope(scopeResponse.scope);
      setKbs((kbsResponse.kbs ?? []).filter((kb) => kb.mergedInto == null));
    } catch {
      /* 保留当前展示；点“应用”时服务端会再次校验 */
    }
  }

  function toggleOpen() {
    if (phase === "failed") {
      setRetry((value) => value + 1);
      return;
    }
    if (phase !== "ready") return;
    setDraft(scope?.mode === "selected" ? [...(scope.kbs ?? [])] : [...names]);
    setQuery("");
    setOpen(true);
    void refreshPanel();
  }

  async function applySelection() {
    if (!sessionId) return;
    const payload = isAllSelection(draft, names)
      ? { mode: "all", kbs: [] as string[] }
      : selectionPayload("selected", draft, names);
    setSaving(true);
    try {
      const response = await fetch(`${API}/scope`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-kb-ui": "1" },
        body: JSON.stringify({ session: sessionId, ...payload }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { scope: Scope };
      setScope(body.scope);
      setOpen(false);
      setToast(body.scope.mode === "selected" ? `已限定为 ${body.scope.kbs.length} 个知识库` : "已改为全部知识库");
    } catch {
      setToast("范围保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  const panel = open && phase === "ready" ? createPortal(
    <div
      className="dsh-kb-scope-panel"
      role="dialog"
      aria-label="选择本会话知识库"
      style={position ? { top: position.top, left: position.left } : { top: 80, left: 8 }}
    >
      <div className="dsh-kb-scope-head">本会话使用哪些知识库？</div>
      <input
        className="dsh-kb-scope-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索知识库"
        aria-label="搜索知识库"
        autoFocus
      />
      <div className="dsh-kb-scope-list">
        {filtered.length === 0 ? (
          <div className="dsh-kb-scope-empty">
            <div>{kbs.length === 0 ? "暂无知识库" : "没有匹配的知识库"}</div>
            {kbs.length === 0 ? (
              <button
                type="button"
                className="dsh-kb-scope-link"
                onClick={() => { setOpen(false); setWorkbenchOpen(true); }}
              >
                去工作台新建
              </button>
            ) : null}
          </div>
        ) : (
          filtered.map((kb) => (
            <label key={kb.name} className="dsh-kb-scope-row">
              <input
                type="checkbox"
                checked={draft.includes(kb.name)}
                onChange={() => setDraft((current) => (
                  current.includes(kb.name) ? current.filter((name) => name !== kb.name) : [...current, kb.name]
                ))}
              />
              <span className="dsh-kb-scope-name">{kb.name}</span>
              <span className="dsh-kb-scope-meta">{(kb.docs ?? 0) === 0 ? "空库" : `${kb.docs} 篇`}</span>
            </label>
          ))
        )}
      </div>
      <div className="dsh-kb-scope-actions">
        <button type="button" onClick={() => setDraft([...names])}>全选</button>
        <button type="button" onClick={() => setDraft([])}>清空</button>
        <button type="button" onClick={() => setOpen(false)}>取消</button>
        <button type="button" className="dsh-kb-scope-primary" disabled={saving} onClick={() => void applySelection()}>
          应用
        </button>
        <button type="button" className="dsh-kb-scope-link" onClick={() => { setOpen(false); setWorkbenchOpen(true); }}>
          打开知识库工作台
        </button>
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`dsh-kb-scope-chip${active ? " dsh-kb-scope-chip-active" : ""}`}
        aria-expanded={open}
        aria-label={label}
        title={phase === "failed" ? "知识库：点击重试" : label}
        onClick={toggleOpen}
      >
        <DatabaseIcon size={14} />
        <span className="dsh-kb-scope-label">{label}</span>
      </button>
      {panel}
      {toast && typeof document !== "undefined"
        ? createPortal(<div className="dsh-kb-scope-toast">{toast}</div>, document.body)
        : null}
      <WorkbenchModal open={workbenchOpen} onClose={() => setWorkbenchOpen(false)} />
    </>
  );
}

export function apply(ctx: SlotContext) {
  ensureCss();
  ctx.slots.inject("sidebar.footer.action", () => {
    ctx.slots.register({ name: "sidebar.footer.action", id: "kb-workbench", order: 10 }, KbWorkbenchAction);
  });
  ctx.slots.inject("conversation.input.left", () => {
    ctx.slots.register({ name: "conversation.input.left", id: "kb-scope", order: 20 }, KbScopeCapsule);
  });
}
```

- [ ] **Step 4: 构建产物并跑类型检查**

Run:
```bash
npm run build:client
npm run typecheck
npm run check:client
```
Expected: `wrote …/lib/client.js`；typecheck 退出码 0；`client bundle is up to date`。

- [ ] **Step 5: 提交**

```bash
git add src/client/index.tsx lib/scope-view.d.ts tsconfig.json lib/client.js
git commit -m "feat(client): scope capsule in composer with reusable workbench modal"
```

---

## Task 12: 客户端单元测试（VM）

**Files:**
- Modify: `test/client-entry.test.mjs`（注册断言、render 辅助）
- Create: `test/scope-client.test.mjs`

> 说明：`test/client-entry.test.mjs` 现有的 React stub 不用改——它只渲染侧栏组件（内部只有一个 `useState`，共享 `state.open` 正是这些用例依赖的行为）。胶囊用独立测试文件里的 hook-index stub，互不干扰。

- [ ] **Step 1: 更新注册断言**

`test("apply registers sidebar.footer.action with kb-workbench")` 改名为 `apply registers sidebar and composer slots`，断言改为：

```js
  const { mod } = loadClient();
  const calls = { inject: [], register: [] };
  const ctx = {
    slots: {
      inject(name, callback) { calls.inject.push(name); callback(); },
      register(decl, component) { calls.register.push({ decl, component }); },
    },
  };
  mod.apply(ctx);
  assert.deepEqual(calls.inject, ["sidebar.footer.action", "conversation.input.left"]);
  assert.deepEqual(calls.register.map((row) => [row.decl.name, row.decl.id, row.decl.order]), [
    ["sidebar.footer.action", "kb-workbench", 10],
    ["conversation.input.left", "kb-scope", 20],
  ]);
  assert.equal(typeof calls.register[0].component, "function");
  assert.equal(typeof calls.register[1].component, "function");
```

`renderAction` 辅助改为按 slot 名取组件（否则最后注册的胶囊会覆盖侧栏组件）：

```js
function componentFor(mod, name) {
  let component;
  mod.apply({
    slots: {
      inject(_name, callback) { callback(); },
      register(decl, value) { if (decl.name === name) component = value; },
    },
  });
  return component;
}

function renderAction(mod, wide = true) {
  return componentFor(mod, "sidebar.footer.action")({ wide });
}
```

- [ ] **Step 2: 新建 `test/scope-client.test.mjs`**

```js
/**
 * 胶囊：VM 里渲染初始态 + 纯函数（lib/scope-view.js）。
 * 这个文件的 React stub 用 hook 下标隔离各个 useState（胶囊有十几个状态）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { chipLabel, isAllSelection, selectionPayload } from "../lib/scope-view.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await readFile(join(root, "lib/client.js"), "utf8");
const Fragment = Symbol.for("react.fragment");

function loadCapsule() {
  let entry;
  const hooks = [];
  const state = { hooks, refs: [], effects: [], setters: [] };
  const context = {
    window: { __ModuleLoader__: { load(value) { entry = value; } } },
    document: undefined,
    console,
  };
  vm.runInNewContext(bundle, context, { filename: "lib/client.js" });
  const mod = entry.factory((id) => {
    if (id === "react") {
      return {
        createElement: (type, props, key) => ({ type, props: props ?? {}, key: key ?? null }),
        Fragment,
        useState(initial) {
          const index = hooks.length;
          if (hooks[index] === undefined) hooks[index] = initial;
          const setter = (next) => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; };
          state.setters.push(setter);
          return [hooks[index], setter];
        },
        useEffect(effect) { state.effects.push(effect); },
        useRef(initial) { if (state.refs.length === 0) state.refs.push({ current: initial }); return state.refs[0]; },
        useCallback(fn) { return fn; },
      };
    }
    if (id === "react/jsx-runtime") {
      return {
        jsx: (type, props) => ({ type, props: props ?? {} }),
        jsxs: (type, props) => ({ type, props: props ?? {} }),
        Fragment,
      };
    }
    if (id === "react-dom") {
      return { createPortal: (node) => ({ portal: node }) };
    }
    throw new Error(`unexpected require: ${id}`);
  });
  let component;
  mod.apply({
    slots: {
      inject(_name, callback) { callback(); },
      register(decl, value) { if (decl.name === "conversation.input.left") component = value; },
    },
  });
  return { mod, component, state };
}

test("capsule renders a loading chip before data arrives", () => {
  const { component } = loadCapsule();
  const tree = component({ sessionId: "s1" });
  const children = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children];
  const chip = children[0];
  assert.equal(chip.type, "button");
  assert.match(String(chip.props.className), /dsh-kb-scope-chip/);
  assert.equal(chip.props["aria-label"], "知识库：…");
});

test("chipLabel / selectionPayload / isAllSelection are shared with the bundle", () => {
  assert.equal(chipLabel({ mode: "selected", kbs: ["A"] }), "知识库：1 个");
  assert.deepEqual(selectionPayload("selected", ["B", "A"], ["A", "B"]), { mode: "selected", kbs: ["A", "B"] });
  assert.equal(isAllSelection(["A", "B"], ["B", "A"]), true);
});
```

- [ ] **Step 3: 跑测试**

Run:
```bash
npm test
```
Expected: `npm test` 全绿（client-entry 的注册断言已更新，新增 `scope-client.test.mjs` 通过）；`check:client` 通过。

- [ ] **Step 4: 提交**

```bash
git add test/client-entry.test.mjs test/scope-client.test.mjs
git commit -m "test(client): cover scope capsule registration and shared view helpers"
```

## Task 13: 真实宿主验收（胶囊 + API + 降级）

**Files:**
- Create: `/tmp/kb-2b-accept/flow.js`（临时验收脚本，不提交）
- Modify: `~/.dsh/profiles/web/cordis.patch.yml`（临时，结束还原）

- [ ] **Step 1: 备份 profile patch 并准备临时库根**

Run:
```bash
mkdir -p /tmp/kb-2b-accept
cp ~/.dsh/profiles/web/cordis.patch.yml /tmp/kb-2b-accept/web-patch.bak
rm -rf /tmp/kb-2b-accept/kb-root
mkdir -p /tmp/kb-2b-accept/kb-root
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'

# TEMP 2B ACCEPTANCE (remove after verification)
- id: knowledge-base
  config:
    kbRoot: /tmp/kb-2b-accept/kb-root
EOF
tail -6 ~/.dsh/profiles/web/cordis.patch.yml
```
Expected: 末尾出现 `id: knowledge-base` 与 `kbRoot: /tmp/kb-2b-accept/kb-root`。

- [ ] **Step 2: 起临时宿主并造两个库**

Run:
```bash
dsh --profile web --port 55940 --no-open > /tmp/kb-2b-accept/host.log 2>&1 &
sleep 6
curl -s http://127.0.0.1:55940/kb/api/status | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["kbRoot"]=="/tmp/kb-2b-accept/kb-root", d["kbRoot"]; assert d["features"].get("scope") is True, d["features"]; print("status ok", d["kbRoot"])'
for name in 验收甲库 验收乙库; do
  curl -s -X POST http://127.0.0.1:55940/kb/api/kbs \
    -H 'content-type: application/json' -H 'x-kb-ui: 1' \
    -H 'origin: http://127.0.0.1:55940' \
    -d "{\"name\":\"$name\"}" | head -c 200; echo
done
```
Expected: `"features":{...,"scope":true}`；两次 `201`，`kb.name` 为 `验收甲库` / `验收乙库`。

- [ ] **Step 3: 写验收 flow**

创建 `/tmp/kb-2b-accept/flow.js`：

```js
void (async function () {
  const flow = (window.__flow = { done: false, error: null, log: [] });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (line) => flow.log.push(line);

  async function waitFor(label, fn, timeout = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try {
        const value = fn();
        if (value) return value;
      } catch {}
      await sleep(100);
    }
    throw new Error(`timeout: ${label}`);
  }
  const snap = async (name) => {
    try { window.webkit.messageHandlers.snap.postMessage(name); } catch {}
    await sleep(800);
  };
  const chip = () => document.querySelector(".dsh-kb-scope-chip");
  const chipLabel = () => chip()?.getAttribute("aria-label") ?? "";
  const click = (element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const rowFor = (name) => Array.from(document.querySelectorAll(".dsh-kb-scope-row"))
    .find((row) => row.textContent.includes(name));

  try {
    await waitFor("capsule chip", chip);
    log(`chip-initial: ${chipLabel()}`);
    if (chipLabel() !== "知识库：全部") throw new Error(`expected 全部, got ${chipLabel()}`);
    await snap("2b-chip-all");

    click(chip());
    await waitFor("panel", () => document.querySelector(".dsh-kb-scope-panel"));
    log(`rows: ${document.querySelectorAll(".dsh-kb-scope-row").length}`);
    const row = rowFor("验收甲库");
    if (!row) throw new Error("验收甲库 row missing");
    click(row.querySelector("input[type=checkbox]"));
    await sleep(150);
    click(document.querySelector(".dsh-kb-scope-primary"));
    await waitFor("applied", () => chipLabel() === "知识库：1 个");
    log(`chip-after-apply: ${chipLabel()}`);
    await snap("2b-chip-selected");

    click(chip());
    await waitFor("panel again", () => document.querySelector(".dsh-kb-scope-panel"));
    await sleep(400);
    const checkedRow = rowFor("验收甲库");
    const checked = checkedRow?.querySelector("input[type=checkbox]")?.checked === true;
    log(`panel-reopen-checked: ${checked}`);
    if (!checked) throw new Error("reopened panel lost the saved selection");
    const link = Array.from(document.querySelectorAll(".dsh-kb-scope-actions button"))
      .find((button) => (button.textContent || "").includes("打开知识库工作台"));
    if (!link) throw new Error("workbench link missing");
    click(link);
    await waitFor("workbench iframe", () => document.querySelector(".dsh-kb-modal-frame"));
    log("workbench-modal: opened");
    await snap("2b-workbench-modal");
    click(document.querySelector(".dsh-kb-modal-close"));
    await waitFor("workbench closed", () => !document.querySelector(".dsh-kb-modal-frame"));
    log("workbench-modal: closed");
  } catch (error) {
    flow.error = String(error && error.message ? error.message : error);
    await snap("2b-error");
  }
  flow.done = true;
})();
```

- [ ] **Step 4: 跑 WKWebView 验收**

Run:
```bash
cd /Users/littlesun/workspace/deepseek/project/知识库/.acceptance
./wkflow http://127.0.0.1:55940/ /tmp/kb-2b-accept 2>&1 | tail -8
python3 - <<'EOF'
import json
data = json.load(open('/tmp/kb-2b-accept/.scopes.json'))
print(json.dumps(data, ensure_ascii=False, indent=2))
assert len(data['scopes']) == 1, data
entry = next(iter(data['scopes'].values()))
assert entry['mode'] == 'selected', entry
assert entry['kbs'] == ['验收甲库'], entry
print('scopes-file: ok')
EOF
```
Expected: `FLOW_DONE` 且 log 含 `chip-initial: 知识库：全部`、`chip-after-apply: 知识库：1 个`、`panel-reopen-checked: true`、`workbench-modal: opened/closed`；`.scopes.json` 断言通过。

- [ ] **Step 5: 失败注入（写盘失败）**

Run:
```bash
chmod 0444 /tmp/kb-2b-accept/kb-root/.scopes.json
chmod 0555 /tmp/kb-2b-accept/kb-root
cat > /tmp/kb-2b-accept/flow.js <<'EOF'
void (async function () {
  const flow = (window.__flow = { done: false, error: null, log: [] });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (line) => flow.log.push(line);
  async function waitFor(label, fn, timeout = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try { const value = fn(); if (value) return value; } catch {}
      await sleep(100);
    }
    throw new Error(`timeout: ${label}`);
  }
  const snap = async (name) => {
    try { window.webkit.messageHandlers.snap.postMessage(name); } catch {}
    await sleep(800);
  };
  const chip = () => document.querySelector(".dsh-kb-scope-chip");
  const click = (element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  try {
    await waitFor("chip", chip);
    click(chip());
    await waitFor("panel", () => document.querySelector(".dsh-kb-scope-panel"));
    const row = Array.from(document.querySelectorAll(".dsh-kb-scope-row"))
      .find((node) => node.textContent.includes("验收乙库"));
    click(row.querySelector("input[type=checkbox]"));
    await sleep(150);
    click(document.querySelector(".dsh-kb-scope-primary"));
    await waitFor("toast", () => document.querySelector(".dsh-kb-scope-toast"));
    log(`toast: ${document.querySelector(".dsh-kb-scope-toast").textContent}`);
    log(`chip-still: ${chip().getAttribute("aria-label")}`);
    log(`panel-open: ${Boolean(document.querySelector(".dsh-kb-scope-panel"))}`);
    await snap("2b-write-failed");
  } catch (error) {
    flow.error = String(error && error.message ? error.message : error);
  }
  flow.done = true;
})();
EOF
cd /Users/littlesun/workspace/deepseek/project/知识库/.acceptance
./wkflow http://127.0.0.1:55940/ /tmp/kb-2b-accept 2>&1 | tail -6
chmod 0755 /tmp/kb-2b-accept/kb-root
chmod 0644 /tmp/kb-2b-accept/kb-root/.scopes.json
```
Expected: log 含 `toast: 范围保存失败，请重试`、`chip-still: 知识库：1 个`、`panel-open: true`。

- [ ] **Step 6: 清理临时宿主与 profile**

Run:
```bash
pkill -f "dsh --profile web --port 55940" || true
sleep 1
cp /tmp/kb-2b-accept/web-patch.bak ~/.dsh/profiles/web/cordis.patch.yml
grep -c "TEMP 2B ACCEPTANCE" ~/.dsh/profiles/web/cordis.patch.yml || true
rm -rf /tmp/kb-2b-accept/kb-root
```
Expected: `pkill` 后端口不可访问；grep 输出 `0`；临时库根删除。

- [ ] **Step 7: 用户桌面端验收（阻塞项，需用户操作）**

请用户重启 DSH 桌面端（或 `Cmd+R`）后确认：

1. 输入框工具行出现 `知识库：全部` 胶囊。
2. 点开 → 勾选一个库 → 应用 → chip 变 `知识库：N 个`，重启 DSH 后保持。
3. 一轮对话里让模型 `kb_list`：只列出范围内库。
4. 范围内 `kb_query` 搜不到范围外内容；显式指定范围外库得到 `KB_OUT_OF_SCOPE` 文案。
5. `subagent` 子会话继承父范围（父选定后派一个只读子任务，看它的 `kb_list`）。

Expected: 五项全部符合；任一项不符先修再继续。

- [ ] **Step 8: 提交验收记录**

在 spec 末尾追加（`docs/superpowers/specs/2026-10-24-kb-workbench-slice2b-design.md`）：

```markdown
## 20. 2B 验收记录（YYYY-MM-DD，0.21.0）

- [x] `npm test`：记录实际总数（形如 `397/397` pass、`0 fail`，含 `check:client`、`check-ui`）。
- [x] `npm run typecheck`、`npm run check:client` 通过。
- [x] 真实宿主（临时 `dsh --profile web` + 临时 kbRoot + WKWebView）：胶囊初始「全部」→ 勾选 1 库 → 「1 个」→ 刷新保持 → 「打开知识库工作台」弹窗开关。
- [x] 写盘失败注入：toast「范围保存失败，请重试」，chip 不变，面板保留。
- [x] 桌面端用户验收：胶囊可见、范围生效、子代理继承。
- 截图：`.acceptance/screenshot-2b-chip-all.png`、`screenshot-2b-chip-selected.png`、`screenshot-2b-workbench-modal.png`、`screenshot-2b-write-failed.png`（若验收目录保留）。
```

Run:
```bash
git add docs/specs/2026-10-24-kb-workbench-slice2b-design.md
git commit -m "docs(spec): record Slice 2B acceptance"
```

---

## Task 14: README、版本 0.21.0、终检

**Files:**
- Modify: `README.md`
- Modify: `package.json`（version）
- Modify: `lib/version.js`（VERSION）

- [ ] **Step 1: 升版本**

`package.json`：`"version": "0.20.4"` → `"version": "0.21.0"`。
`lib/version.js`：`export const VERSION = "0.20.4";` → `export const VERSION = "0.21.0";`。

Run:
```bash
grep -n '"version"' package.json | head -1
grep -n 'VERSION =' lib/version.js
```
Expected: 两处都是 `0.21.0`。

- [ ] **Step 2: README 新增章节**

在 `## 侧栏入口（0.19.1）` 之前插入：

```markdown
## 会话知识库范围与胶囊（0.21.0）

输入框左侧的工具行新增「知识库」胶囊：可以为**当前会话**选定可用知识库，选定后：

- 21 个 `kb_*` 工具按范围执行；范围外显式指定库会返回 `KB_OUT_OF_SCOPE` 并提示如何切换。
- 省略 `kb` 的 doc 类工具会在范围内跨库解析：唯一命中直接用，多库命中列出候选（kb/docId/标题）。
- `kb_lint` 在范围有多库时逐库体检并按库分组（默认最多 20 个，`scopeLintMaxKbs`）。
- 系统提示只在「限定」模式注入一行范围说明；「全部」不注入。
- 子会话（subagent/fork）首次使用范围时继承父会话范围并落快照，父范围后续变化不回溯。

存储：`<kbRoot>/.scopes.json`（`0600`、原子写、进程内串行队列）。条目默认 30 天过期（`scopeTtlDays`，0 = 不过期），读取时自动剔除已删除/已归档/已合并的库名。

接口：`GET /kb/api/scope?session=<id>`、`PUT /kb/api/scope`（`x-kb-ui: 1` + 同源）；`/kb/api/status` 的 `features.scope` 表示可用。没有 `webServer` 或旧版服务端时胶囊不渲染，工具与提示照常。

**已知限制**：

- 范围是产品约束，**不是权限边界**：工作台 HTTP API/UI 不受范围影响；`session` 由客户端提供，不做身份认证。
- `kb_edit_batch` / `kb_add_note` 是单库操作：范围有多个库且未指定 `kb` 时报「请指定 kb」，不做跨库事务。
- 范围切换会改变 system prompt 前缀一次（换回相同范围后前缀恢复）。
- 胶囊只注册在 `conversation.input.left`（首页/无会话头部也有）；`conversation.session.header.utilities` 未接入。
- 无 session 身份的调用（非常规宿主路径、测试）不限制范围（fail-open）。
```

- [ ] **Step 3: 更新已知限制段落**

把 `### 实现偏差 / 已知限制（0.20.4）` 改为 `### 实现偏差 / 已知限制（0.21.0）`，并在列表末尾追加：

```markdown
- 范围只约束 `kb_*` 工具；工作台 API 与 UI 不受范围影响（范围不是权限边界）。
- `kb_edit_batch` / `kb_add_note` 为单库策略，范围多库时必须显式 `kb`。
```

- [ ] **Step 4: 终检**

Run:
```bash
npm test
npm run typecheck
npm run check:client
node scripts/check-ui.mjs
git status --short
```
Expected: `tests` 全绿、0 fail；typecheck / check:client / check-ui 退出码 0；`git status` 只有本任务改的 3 个文件（README/package.json/lib/version.js）。

- [ ] **Step 5: 提交**

```bash
git add README.md package.json lib/version.js
git commit -m "chore: release 0.21.0 with session knowledge-base scope"
```

- [ ] **Step 6: 同步文档到文档仓库并 ff-merge 回 main**

Run:
```bash
cp docs/specs/2026-10-24-kb-workbench-slice2b-design.md \
   /Users/littlesun/workspace/deepseek/project/知识库/docs/superpowers/specs/2026-10-24-kb-workbench-slice2b-design.md
cp docs/plans/2026-10-24-kb-workbench-slice2b.md \
   /Users/littlesun/workspace/deepseek/project/知识库/docs/superpowers/plans/2026-10-24-kb-workbench-slice2b.md
git checkout main
git merge --ff-only feat/kb-scope-capsule
git log --oneline -3
```
Expected: `--ff-only` 成功；HEAD 为 `chore: release 0.21.0 …`，其后还有 `chore: sync package-lock version to 0.21.0`（`990349c`），以及本次收尾提交 `fix: address final review follow-ups`。

---

## 收尾检查（执行者自检）

- [x] 21 个工具全部走 `resolveExecScope` / `resolveSingleKb` / `resolveDocTarget`；`grep -n "args.kb ?? defaultKb" lib/index.js` 应只剩 1 处（`kb_query` 的单库分支，`all` 模式的现状路径）。
- [x] `grep -n "removeScopesReferences" lib/*.js` 无输出（已迁移到 `scope-store.js`）。
- [x] `grep -n "scope" lib/web/api.js | grep features` 显示 `scope: true`。
- [x] `docs/specs/2026-10-24-kb-workbench-slice2b-design.md` 末尾有验收记录。
- [x] `npm test`、`npm run typecheck`、`npm run check:client`、`node scripts/check-ui.mjs` 全绿。
- [x] `git status --short` 干净；main 已 ff 到 `feat/kb-scope-capsule`。

---

## 实施记录（偏差与追加）

以下是实施过程中经用户确认的偏差与追加（相对本计划原文）：

- **scope 文件层加固**：`lib/scope.js` 与 `lib/scope-store.js` 分两层落地；损坏/超限的 `.scopes.json` 不再被静默覆盖——读按 `all`，写抛 `SCOPE_UNUSABLE` 并转成可读的 `SCOPE_WRITE_FAILED`；同步视图改为 mtime+size 缓存 + 冻结视图，不实现计划里的 `scopesFileInfo`。
- **导入查重限定范围**：`scanDuplicates` 增加 `kbNames` 白名单，`kb_import` 只与范围内库比对，范围外库不再误报跨库重合；`null` = 扫描全部。
- **范围库名净化**：`.scopes.json` 里的库名统一 `sanitizeKbName`（落盘/提示/缓存路径都走净化后的名字），无法落盘或保留的条目在 prune 时摘掉，兼顾路径安全与提示注入。
- **GET 父会话解析**：`GET /kb/api/scope` 通过 `ctx.get("agents")` 读 live agent 的 `parentSession`，继承范围无需落快照即可见；`updatedAt` 只在请求会话有自己条目时返回。
- **5xx 脱敏（双重拦截）**：`mapError` 对 `ScopeError` 的 `status >= 500` 剥离 `details`；并在 `sendError` 集中对 `status >= 500` 丢弃 `details`（任何调用点都不会把内部路径/库名回传浏览器），4xx 的业务 `details`（如 `jobId`）照常返回。
- **软删除文档解析**：`resolveDocTarget` 增加 `includeDeleted`，供 `kb_restore` / `kb_history` / `kb_remove(soft=false)` 跨库解析软删除文档。
- **`kb_lint` 逐库隔离**：每个库单独 try/catch（失败条目 `{kb, error}` 不拖垮整轮），超出 `scopeLintMaxKbs` 时返回 `truncated` + `omittedKbs`；输出 schema 增加可选 `error`。
- **`kb_std_check` 友好报错**：目标库缺 `kb.json` 时提示「不存在或缺少 kb.json，请先创建该库」，不再抛底层 ENOENT。
- **`kb_export` 输出加 `kb`**：输出 schema 增加 `kb` 字段（additive），与其它工具一致。
- **胶囊面板位置与无障碍修正**：面板改为空间自适应（默认上方、贴近视口顶部时下方，动态 max-height）；toast portal 到 body、底部居中、`role="status"`；`aria-expanded` 仅在面板挂载时为 true；全部模式预勾选全部库；会话切换作废旧请求。
- **Task 12 改为 effect-running harness**：用可执行 React effect 的 VM 桩替代计划里的非 effect stub，覆盖面板定位、勾选/应用、失败回滚与会话切换竞态（40 个用例）。
- **修正计划中的实现笔误**：Task 3 的 `scope-view` 说明/导出措辞按实现校正；Task 5 的 import 语句去掉未使用的 `MAX_SCOPE_KBS`；Task 8 的 lint 渲染断言改用 `output.render`；Task 9 在 GET 路由内用局部 `new URL(...)` 解析（计划依赖了未声明的 `url`/`URL`）；Task 8 的 `kb_std_check` 测试改为显式造库，避免依赖临时库根里的既有库。
- **purge 复用名保护**：`purgeKb` 只在库目录确已不存在（`existsSync` 为假）时才 `removeScopeKb`，避免刚被同名新库复用的范围引用被误删。
- **`kb_query` all 模式跨库容错**：逐库读取改用 `tryReadManifest`，某库 `kb.json` 损坏/缺失时跳过该库，而不是让整轮查询报错。
- **配置钳制**：`scopeTtlDays` 钳制 0–3650（默认 30），`scopeLintMaxKbs` 钳制 1–`MAX_SCOPE_KBS`（50，默认 20）。
- **`lib/scope-view.d.ts` + tsconfig**：为 `lib/scope-view.js` 补 TypeScript 声明并加入 `tsconfig.json` 的 `include`，让 `npm run typecheck` 覆盖范围纯函数。
- **`kb_list` 范围不可用文案**：范围内库全部不可用（已归档/删除/manifest 损坏）时返回「本会话范围（…）内的知识库当前不可用…」，而不是空列表。
- **TTL / 空范围 fail-open 告警**：README 明示条目超 `scopeTtlDays`（默认 30 天）会静默过期退回「全部」（`scopeTtlDays: 0` 关闭）、范围内所有库被删除/归档/合并后 `selected` 变空按设计退回「全部」、库身份以目录名为准、子会话父 agent 不在线时胶囊暂显「全部」但首次 `kb_*` 调用仍按父范围落快照。
- **0600 测试平台守卫**：Windows 与 root 下 `0600` 语义不成立，`writeScopes` 的 0600 用例加 `skip` 守卫（与其它 chmod 用例一致）。
- **`kb_lint` 的 `staleDays` NaN 修复**：原写法 `Number(args.staleDays) ?? 90` 对缺省参数得到 NaN（NaN 不是 nullish），改为 `Number(args.staleDays ?? 90)`。
- **验收结果**：`npm test` 500/500（新增 188 例：scope-store 17、scope 37、scope-tools 52、scope-prompt 10、scope-api 19、scope-sync 6、scope-view 7、scope-client 40）；真实宿主验收与截图见 spec §20。

