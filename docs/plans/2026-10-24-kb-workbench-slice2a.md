# 知识库工作台 Slice 2A 实施计划（上传与导入任务 + 标准更新面板）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在工作台里完成「浏览器上传资料 → 后台导入 → 逐文件进度/报告/重试」与「标准更新检查/下载 → 金币确认 → 结果表」两条长任务链路，并把工作台任务机制（注册表、进度文件、轮询、1 小时结果保留）建立起来。

**Architecture:** 抽出 `lib/import-job.js` 作为工具路径与工作台路径共用的 worker 启动内核；工作台任务走插件内注册表 `lib/web/jobs.js`（宿主 `jobs` 归属 agent 会话，不能复用）；上传批次落 `<kb>/import-tmp/ui-batches/<id>/`，worker 每文件原子写 `progress.json`；标准检查复用 `runStdCheck` 并新增 `onProgress`。前端仍是零构建 ESM，上传弹窗自管理 DOM/XHR/轮询，标准面板由 `state.std` + 全局重渲染驱动。

**Tech Stack:** Node.js ESM（`node:test`、`node:http` 流式上传）、ClickHouse 无关——纯文件系统、esbuild 只用于已有 client bundle（本切片不改）、浏览器原生 XHR/ESM。

**规格：** `docs/superpowers/specs/2026-10-24-kb-workbench-slice2a-design.md`

---

## 0. 工作目录与准备

**工作目录：** `/Users/littlesun/.dsh/plugins/dsh-knowledge-base`（已安装插件的 git 仓库，`package.json` name 为 `dsh-knowledge-wiki`）。文档仓库（非 git）：`/Users/littlesun/workspace/deepseek/project/知识库`，本计划与 spec 在那边也留一份。

### Task 0: 建分支与基线

**Files:** 无

- [ ] **Step 0.1: 确认干净工作区**

Run:
```bash
cd /Users/littlesun/.dsh/plugins/dsh-knowledge-base
git status --short
git log --oneline -3
```
Expected: 无输出（干净）；HEAD 第一条是 `docs: add Slice 2A design (upload batches + import jobs + std panel)`。

- [ ] **Step 0.2: 建分支**

Run:
```bash
git checkout -b feat/kb-upload-std
```
Expected: `Switched to a new branch 'feat/kb-upload-std'`。

- [ ] **Step 0.3: 跑基线测试**

Run:
```bash
npm test
```
Expected: `tests 186`、`pass 186`、`fail 0`。失败先停下修基线，不要继续。

- [ ] **Step 0.4: 记录基线类型检查**

Run:
```bash
npm run typecheck && npm run check:client
```
Expected: 均退出码 0。

---

## 文件结构

```text
lib/import-job.js          新：prepareImportArgs / createImportWorkerRunner / tempReportFile / refreshKbIndex
lib/web/jobs.js            新：任务注册表（start/get/list/cancelAll）
lib/web/upload.js          新：批次存储、路径校验、流式落盘封装、24h 清扫、批次导入
lib/web/std.js             新：readStdStatus / buildStdEntries / buildStdResult / startStdJob
lib/web/http.js            改：WebError、readRawToFile
lib/web/api.js             改：新路由、mapError、/status
lib/web/server.js          改：构造 jobs/spawn/limits/std 并注入；dispose 时 cancelAll
lib/standards.js           改：runStdCheck 增加 onProgress；新增 createStdImportFn
lib/index.js               改：startImportJob 委托；导入/标准配置注入；2 个新配置项
worker/import-worker.mjs   改：progressFile 原子写
ui/upload-core.js          新：纯函数（校验/队列/标签/汇总）
ui/views/upload.js         新：上传弹窗
ui/views/std.js            新：标准面板 render + 动作
ui/api.js                  改：批次/任务/标准方法 + XHR 上传
ui/app.js                  改：state.std、入口动作、轮询生命周期
ui/views/detail.js         改：标准更新 tab
ui/views/overview.js       改：上传资料 / 标准更新入口
ui/views/modals.js         改：openConfirmModal / openKbPickerModal
ui/style.css               改：dropzone、文件行、进度条、标准表格
ui/icons.js                不改（`upload` 图标已存在，直接复用）
test/import-job.test.mjs   新
test/worker-progress.test.mjs 新
test/web-jobs.test.mjs     新
test/web-upload-batch.test.mjs 新
test/web-upload-import.test.mjs 新
test/web-std.test.mjs      新
test/upload-core.test.mjs  新
test/ui-api.test.mjs       新
test/web-api-read.test.mjs 改：features/limits
package.json / lib/version.js / README.md 改：0.20.0、配置、说明
```

每个任务结束都提交一次；提交信息前缀 `feat:` / `test:` / `docs:` / `chore:` 与仓库历史一致。

---

### Task 1: 抽出 worker 启动内核（行为不变）

**Files:**
- Create: `lib/import-job.js`
- Create: `test/import-job.test.mjs`
- Modify: `lib/index.js:481-565`（`startImportJob`）与 `lib/index.js:443-451`（删除本地 `refreshKbIndex`，改 import）

- [x] **Step 1.0: 让 `npm test` 自动发现新的测试文件**

`package.json` 的 `scripts.test` 目前逐条列出 55 个测试文件；本计划要新增 9 个，逐条维护容易漏。

**实现修正（已批准）**：`node --test test/` 在 Node 26 会把目录当模块路径（MODULE_NOT_FOUND），裸 `node --test` 又会误跑 `dev/*-test.mjs` 探针脚本，带引号 glob 需要 Node ≥22 而 `engines` 是 ≥20。最终方案是新增跨平台 runner 脚本：

```js
// scripts/run-tests.mjs
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let names;
try {
  names = readdirSync(join(root, "test"));
} catch (error) {
  console.error(`cannot read test directory: ${String(error?.message ?? error)}`);
  process.exit(1);
}

const files = names
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("test", name));

if (files.length === 0) {
  console.error("no test files found under test/");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
```

```json
"test": "node scripts/build-client.mjs --check && node scripts/run-tests.mjs"
```

Run: `npm test`
Expected: 仍然 186/186 通过（文件集合不变，只是发现方式变了；`dev/` 不参与）。

- [x] **Step 1.1: 写失败测试**

创建 `test/import-job.test.mjs`：

```js
/**
 * worker 启动内核：工具路径与工作台路径共用参数准备与报告归一化。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImportWorkerRunner, prepareImportArgs } from "../lib/import-job.js";
import { createKb } from "../lib/kbmeta.js";

function fakeSpawn({ exitCode = 0, stderr = "", onRun } = {}) {
  return (spec) => {
    onRun?.(spec);
    return {
      terminate: async () => {},
      done: Promise.resolve({ exitCode, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
      },
    };
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-import-job-"));
  const kbRoot = join(root, "kb");
  const { manifest } = await createKb(kbRoot, { name: "测" });
  return { root, kbRoot, kb: manifest.name, dir: join(kbRoot, manifest.name), reportFile: join(root, "report.json") };
}

test("prepareImportArgs 写 @file 参数并透传 progressFile", async () => {
  const { root, kbRoot, kb, dir } = await setup();
  const argsFile = await prepareImportArgs({
    dir,
    kbRoot,
    kb,
    files: [{ sourcePath: "/tmp/a.pdf", relKey: "a.pdf", title: "a" }],
    config: { ocrModel: "fast" },
    reportFile: join(root, "report.json"),
    progressFile: join(root, "progress.json"),
  });
  const payload = JSON.parse(await readFile(argsFile, "utf8"));
  assert.equal(payload.kbRoot, kbRoot);
  assert.equal(payload.progressFile, join(root, "progress.json"));
  assert.equal(payload.files[0].relKey, "a.pdf");
  assert.ok(argsFile.startsWith(join(dir, "import-tmp")));
});

test("runner 读完报告后归一化状态并清理参数/报告文件", async () => {
  const { kbRoot, kb, dir, reportFile } = await setup();
  await writeFile(reportFile, JSON.stringify({ ok: 1, fail: 0, skip: 0, files: [{ title: "a", status: "ok" }] }));
  const argsFile = await prepareImportArgs({
    dir,
    kbRoot,
    kb,
    files: [{ sourcePath: "/tmp/a.md", relKey: "a.md", title: "a" }],
    config: {},
    reportFile,
  });
  const runner = createImportWorkerRunner({ spawn: fakeSpawn(), dir, argsFile, reportFile, fileCount: 1, kb });
  const outcome = await runner.run().done;
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.report.ok, 1);
  assert.equal(existsSync(argsFile), false);
  assert.equal(existsSync(reportFile), false);
});

test("runner 在进程异常退出时返回 failed 并带已完成计数", async () => {
  const { kbRoot, kb, dir, reportFile } = await setup();
  await writeFile(reportFile, JSON.stringify({ ok: 1, fail: 1, skip: 0, files: [] }));
  const argsFile = await prepareImportArgs({
    dir,
    kbRoot,
    kb,
    files: [{ sourcePath: "/tmp/a.md", relKey: "a.md", title: "a" }],
    config: {},
    reportFile,
  });
  const runner = createImportWorkerRunner({ spawn: fakeSpawn({ exitCode: 3, stderr: "boom" }), dir, argsFile, reportFile, fileCount: 2, kb });
  const outcome = await runner.run().done;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail, /导入进程异常退出 \(3\)/);
  assert.match(outcome.detail, /成功 1，失败 1/);
});
```

- [x] **Step 1.2: 运行测试确认失败**

Run: `node --test test/import-job.test.mjs`
Expected: FAIL，`Cannot find module '../lib/import-job.js'`。

- [x] **Step 1.3: 实现 `lib/import-job.js`**

```js
/**
 * worker 导入任务的公共启动内核。
 * - 工具路径（kb_import / kb_reparse）把 run() 注册到宿主 jobs；
 * - 工作台路径把 run() 交给 lib/web/jobs.js 注册表，并额外传 progressFile。
 * 本模块不依赖 plugin ctx，通道通过 spawn 注入，便于测试。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "./store.js";
import { refreshIndexIfStale } from "./wiki.js";
import { summarizeImportReport } from "./report.js";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKER_PATH = join(pluginRoot, "worker", "import-worker.mjs");

/** 逐文件统计写到系统临时目录，由宿主读取后删除；worker 不依赖宿主内存。 */
export function tempReportFile() {
  return join(tmpdir(), `dsh-kb-import-${randomBytes(6).toString("hex")}.json`);
}

/** 索引是附属产物：写失败不影响主流程（下一次 kb_read/export 会自愈）。 */
export async function refreshKbIndex(dir) {
  try {
    const manifest = await readManifest(dir);
    await refreshIndexIfStale(dir, manifest);
  } catch {
    /* ignore */
  }
}

/**
 * 写 worker 参数文件（Windows 命令行长度/多行 JSON 不可靠，统一走 @file）。
 * progressFile 可选：工作台任务用它提供逐文件进度，工具路径不传。
 */
export async function prepareImportArgs({ dir, kbRoot, kb, files, config, reportFile, progressFile }) {
  const argsFile = join(dir, "import-tmp", `worker-${randomBytes(6).toString("hex")}.json`);
  await mkdir(join(dir, "import-tmp"), { recursive: true });
  await writeFile(
    argsFile,
    JSON.stringify({
      kbRoot,
      kb,
      files,
      config,
      ...(reportFile ? { reportFile } : {}),
      ...(progressFile ? { progressFile } : {}),
    }),
    "utf8"
  );
  return argsFile;
}

/**
 * 返回宿主 jobs / 工作台注册表都能用的 run()。
 * run() 的结果：{ status: "completed"|"failed"|"cancelled", detail, report }。
 */
export function createImportWorkerRunner({ spawn, dir, argsFile, reportFile, fileCount, kb, verb = "导入" }) {
  let cancelled = false;
  return {
    run() {
      const handle = spawn({
        argv: [process.execPath, "--max-old-space-size=8192", WORKER_PATH, "@" + argsFile],
        cwd: dir,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: 2 * 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 3000,
      });
      let cursor = 0;
      const done = handle.done
        .then(async (outcome) => {
          if (cancelled) {
            return { status: "cancelled", detail: `知识库「${kb}」${verb}任务已取消`, report: null };
          }
          // 优先读 worker 的逐文件统计；读不到时从 stdout 的 KB:OK/KB:FAIL 行兜底。
          let report = null;
          try {
            report = JSON.parse(await readFile(reportFile, "utf8"));
          } catch {
            /* 报告文件缺失或损坏时走兜底 */
          }
          if (report === null) {
            const out = handle.collected.stdout?.readFrom(0)?.text ?? "";
            const count = (re) => (out.match(re) ?? []).length;
            const ok = count(/^KB:OK /gm);
            const fail = count(/^KB:FAIL /gm);
            const skip = count(/^KB:SKIP /gm);
            if (ok + fail + skip > 0) report = { ok, fail, skip };
          }
          await rm(reportFile, { force: true }).catch(() => {});
          const summary = summarizeImportReport(report, { fileCount, kb, verb });
          if (outcome.exitCode !== 0) {
            const stderrText = handle.collected.stderr?.readFrom(0)?.text?.trim() ?? "";
            const counts = summary.counts
              ? `（已完成：成功 ${summary.counts.ok}，失败 ${summary.counts.fail}）`
              : "";
            return {
              status: "failed",
              detail: `${verb}进程异常退出 (${outcome.exitCode ?? 0}${outcome.signal ? " " + outcome.signal : ""}): ${stderrText.slice(0, 200)}${counts}`,
              report,
            };
          }
          return { status: summary.status, detail: summary.detail, report };
        })
        .finally(() => {
          rm(argsFile, { force: true }).catch(() => {});
          rm(reportFile, { force: true }).catch(() => {});
          void refreshKbIndex(dir);
        });
      return {
        cancel: () => {
          cancelled = true;
          void handle.terminate();
        },
        done,
        readOutput: () => {
          const chunk = handle.collected.stdout?.readFrom(cursor);
          if (!chunk) return "";
          cursor = chunk.nextOffset;
          return chunk.text;
        },
      };
    },
  };
}
```

- [x] **Step 1.4: 改 `lib/index.js` 使用新内核**

顶部 import 增加：

```js
import { createImportWorkerRunner, prepareImportArgs, refreshKbIndex } from "./import-job.js";
```

把 `lib/index.js` 里 443–451 行的本地 `refreshKbIndex` 函数删掉（改由 import 提供）。把 `startImportJob`（约 481–565 行）整体替换为：

```js
async function startImportJob(
  ctx,
  { kbRoot, kb, dir, files, jobConfig, exec, kind = "kb-import", label, verb = "导入", fileCount = files.length }
) {
  const jobs = ctx.get("jobs");
  if (!jobs) throw new Error("后台任务服务不可用，无法后台导入（请缩小文件规模或分批导入）");
  const reportFile = tempReportFile();
  const argsFile = await prepareImportArgs({ dir, kbRoot, kb, files, config: jobConfig, reportFile });
  const runner = createImportWorkerRunner({
    spawn: (spec) => ctx.subprocess.spawn(spec),
    dir,
    argsFile,
    reportFile,
    fileCount,
    kb,
    verb,
  });
  const jobId = jobs.start({
    kind,
    label: label ?? `${kind} ${kb}: ${files.length} 个文件`,
    ...(exec.agent ? { owner: exec.agent } : {}),
    run: runner.run,
  });
  return { jobId };
}
```

同时把 import 行改为 `import { createImportWorkerRunner, prepareImportArgs, refreshKbIndex, tempReportFile } from "./import-job.js";`（别漏 `tempReportFile`）。

- [x] **Step 1.5: 跑新测试与全套回归**

Run:
```bash
node --test test/import-job.test.mjs
npm test
```
Expected: 新测试 5/5 通过；`npm test` 191/191（186 + 5）。

- [x] **Step 1.6: Commit**

```bash
git add lib/import-job.js test/import-job.test.mjs lib/index.js scripts/run-tests.mjs package.json
git commit -m "refactor(import): extract worker launch core for tool and workbench paths"
```

### Task 1 实现修正记录（2026-10-24，已执行）

代码质量审查后落在 `lib/import-job.js` 的最终契约（后续 Task 5/7 按此实现，不要回退到计划正文里的旧片段）：

1. **测试入口**：`scripts/run-tests.mjs` 枚举 `test/*.test.mjs` 并转发额外 CLI 参数；`npm test` = `node scripts/build-client.mjs --check && node scripts/run-tests.mjs`；`dev/*-test.mjs` 不参与。
2. **runner 结果契约**：`run().done` resolve `{ status, detail, report, cancelled, exitCode, signal }`，`status` 仍是 `completed|failed|cancelled`（工具路径兼容）。工作台任务用 `cancelled !== true && exitCode === 0` 判定 `succeeded`（部分文件失败由 `report.fail` 表达）；进程崩溃/被取消 → `failed`。worker 在「全部文件失败」时以 1 退出（`ok===0 && fail>0`），工作台任务按 `failed` 处理（一个都没导入成功）；只有部分失败时退出 0 → `succeeded`。
3. **清理时序**：`done` 在删除 args 文件与报告文件之后才 resolve（`.finally` 里 await）；`reportFile` 只删一次，`undefined` 不传给 `rm`。
4. **取消语义**：`cancelled` 在 `run()` 内（每次运行独立）；`cancel()` 幂等，`terminate()` 的 rejection 被吞掉。
5. **失败诊断**：stderr 取尾部 200 字符；退出描述用 `exitCode`，无退出码时用 `signal`，不再伪造 0。
6. **异常清理**：`jobs.start` 抛错时删除已写好的 args 文件后重新抛出。
7. 测试补充：cancel、stdout `KB:OK/KB:FAIL/KB:SKIP` 兜底、失败路径 cleanup/report 断言；每个用例 `try/finally` 清理临时目录。

> 未做（记录为已知遗留，不影响 2A）：`refreshKbIndex` 暂留在 `lib/import-job.js`，`lib/index.js` 的 17 处非导入调用仍从该模块 import；若后续继续扩散再抽到中性模块。

---

### Task 2: worker 逐文件进度文件

**Files:**
- Create: `test/worker-progress.test.mjs`
- Modify: `worker/import-worker.mjs:1-114`

- [x] **Step 2.1: 写失败测试**

创建 `test/worker-progress.test.mjs`：

```js
/**
 * 工作台导入进度：worker 每完成一个文件原子写 progress.json。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function runWorker(argsFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(pluginRoot, "worker", "import-worker.mjs"), `@${argsFile}`], {
      cwd: pluginRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

test("worker 写 progress.json：逐文件状态、原子写无残留临时文件", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-worker-progress-"));
  try {
    const kbRoot = join(root, "kb-root");
    const srcDir = join(root, "src");
    await mkdir(kbRoot, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    const okPath = join(srcDir, "ok.txt");
    const badPath = join(srcDir, "bad.docx");
    await writeFile(okPath, "正常文档内容。\n", "utf8");
    await writeFile(badPath, "this is not a docx", "utf8");

    const reportFile = join(root, "report.json");
    const progressFile = join(root, "progress.json");
    const argsFile = join(root, "args.json");
    await writeFile(
      argsFile,
      JSON.stringify({
        kbRoot,
        kb: "测试库",
        files: [
          { sourcePath: okPath, relKey: "ok.txt", title: "ok", sourceFile: "资料/ok.txt" },
          { sourcePath: badPath, relKey: "bad.docx", title: "bad", sourceFile: "资料/bad.docx" },
        ],
        config: { partMaxChars: 2000 },
        reportFile,
        progressFile,
      }),
      "utf8"
    );

    const result = await runWorker(argsFile);
    assert.equal(result.exitCode, 0, `unexpected exit: ${result.stderr}`);

    const progress = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(progress.done, 2);
    assert.equal(progress.total, 2);
    assert.equal(progress.ok, 1);
    assert.equal(progress.fail, 1);
    assert.equal(progress.files.find((f) => f.path === "资料/ok.txt")?.status, "ok");
    const failed = progress.files.find((f) => f.path === "资料/bad.docx");
    assert.equal(failed?.status, "failed");
    assert.ok(failed?.error?.length > 0);

    const leftovers = (await readdir(root)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [x] **Step 2.2: 运行测试确认失败**

Run: `node --test test/worker-progress.test.mjs`
Expected: FAIL，`progress.json` 不存在（`ENOENT`）。

- [x] **Step 2.3: 改 worker**

`worker/import-worker.mjs`：

1. import 行改为：

```js
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
```

2. 解构参数加 `progressFile`：

```js
const { kbRoot, kb, files = [], config = {}, reportFile, progressFile } = args;
```

3. 在 `const jobConfig = ...` 之后加入进度初始化与写函数：

```js
const progressFiles = files.map((f) => ({
  path: String(f.sourceFile ?? f.relKey ?? f.title ?? ""),
  status: "pending",
}));
const progress = { done: 0, total: files.length, ok: 0, fail: 0, skip: 0, current: null, files: progressFiles };

async function writeProgress() {
  if (!progressFile) return;
  const tmp = `${progressFile}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ ...progress, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    await rm(progressFile, { force: true }).catch(() => {});
    await rename(tmp, progressFile);
  } catch {
    /* 进度文件是附属产物，失败不影响导入 */
  }
}
await writeProgress();
```

4. 在 `for (let i = 0; i < files.length; i++) {` 循环体开头（`const label = ...` 之后）加：

```js
  progress.current = progressFiles[i].path;
  await writeProgress();
```

5. 三个分支更新进度：

skip 分支（`skip += 1; results.push(...); process.stdout.write(...)` 之后、`continue;` 之前）加：

```js
      progress.skip += 1;
      progressFiles[i].status = "skipped";
      await writeProgress();
```

成功分支（`results.push({ title: f.title, docId..., parts: ... });` 之后）加：

```js
    progress.done += 1;
    progress.ok += 1;
    progressFiles[i].status = "ok";
    await writeProgress();
```

失败分支（`results.push({ title: f.title, status: "failed", error: message.slice(0, 500) });` 之后）加：

```js
    progress.done += 1;
    progress.fail += 1;
    progressFiles[i].status = "failed";
    progressFiles[i].error = message.slice(0, 200);
    await writeProgress();
```

- [x] **Step 2.4: 跑测试**

Run:
```bash
node --test test/worker-progress.test.mjs test/worker-report.test.mjs
```
Expected: 两个文件全通过。

- [x] **Step 2.5: Commit**

```bash
git add worker/import-worker.mjs test/worker-progress.test.mjs lib/progress.js
git commit -m "feat(worker): write per-file progress for workbench imports"
```

### Task 2 实现修正记录（2026-10-24，已执行）

代码质量审查后，Task 2 的最终契约（Task 5/11 按此实现）：

1. **计数器单一来源**：worker 不再保留局部 `ok/fail/skip`；`KB:RESULT`/`KB:DONE`、报告 summary、退出码都读 `progress.*`。`done === ok + fail + skip`（跳过也计入 `done`，否则 UI 的 `done/total` 进度条永远走不满）。
2. **共享原子写模块** `lib/progress.js`：`createProgress(files)` 与 `writeProgressFile(file, progress)`（唯一 tmp 后缀 `<file>.<8hex>.tmp` → `rename` 覆盖，不再先 `rm`；失败时清理 tmp 后抛出）。worker 用 best-effort 包装：首次失败向 stderr 打一行 `worker: 进度文件写入失败（忽略）: …`，其余吞掉，导入不受影响。Task 5 的 `lib/web/upload.js` 必须 import 这两个函数，不要复制。
3. **收尾清空 `current`**：循环结束后 `progress.current = null` 再写一次，消费者用 job 状态而不是 `current` 判断结束。
4. **worker 头部注释**记录真实 args 契约（`sourcePath/sourceFile/relKey/title/docId?`、`reportFile?`、`progressFile?`）。
5. 测试 3 条（覆盖 4 种行为）：混合失败（含 stdout/report 断言）、skip（用 `markImporting` 预置 importing 行复现）、进度写失败仍 best-effort。

---

### Task 3: 工作台任务注册表

**Files:**
- Create: `lib/web/jobs.js`
- Create: `test/web-jobs.test.mjs`

- [x] **Step 3.1: 写失败测试**

创建 `test/web-jobs.test.mjs`：

```js
/**
 * 工作台任务注册表：进程内 Map，进度可来自 progress 文件，结果保留 1 小时。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobRegistry } from "../lib/web/jobs.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("start/get 暴露运行态与结算结果，且不泄露内部字段", async () => {
  const jobs = createJobRegistry();
  const gate = deferred();
  const id = jobs.start({
    kind: "kb-import",
    kb: "标准",
    label: "导入 标准",
    run: async () => {
      await gate.promise;
      return { status: "succeeded", detail: "完成", result: { ok: 1, fail: 0 } };
    },
  });
  assert.match(id, /^kb-import-/);

  let job = await jobs.get(id);
  assert.equal(job.status, "running");
  assert.equal(job.result, null);
  assert.deepEqual(Object.keys(job).sort(), [
    "detail", "finishedAt", "id", "kb", "kind", "label", "progress", "result", "startedAt", "status",
  ]);

  gate.resolve();
  await tick();
  job = await jobs.get(id);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.ok, 1);
  assert.ok(job.finishedAt);
});

test("import 进度从 progress 文件合并", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-jobs-"));
  const progressFile = join(root, "progress.json");
  await writeFile(progressFile, JSON.stringify({ done: 1, total: 2, ok: 1, fail: 0, skip: 0, current: "b.pdf", files: [] }), "utf8");
  const jobs = createJobRegistry();
  const id = jobs.start({
    kind: "kb-import",
    kb: "标准",
    label: "导入",
    run: async (job) => {
      job.setProgressFile(progressFile);
      return { status: "succeeded", detail: "完成", result: {} };
    },
  });
  await tick();
  const job = await jobs.get(id);
  assert.equal(job.progress.done, 1);
  assert.equal(job.progress.current, "b.pdf");
});

test("list 按 kb/kind 过滤并按开始时间倒序", async () => {
  let clock = 1000;
  const jobs = createJobRegistry({ now: () => clock });
  const a = jobs.start({ kind: "kb-import", kb: "A", label: "a", run: async () => ({ status: "succeeded" }) });
  clock += 10;
  const b = jobs.start({ kind: "kb-std", kb: "A", label: "b", run: async () => ({ status: "succeeded" }) });
  clock += 10;
  const c = jobs.start({ kind: "kb-import", kb: "B", label: "c", run: async () => ({ status: "succeeded" }) });
  await tick();
  assert.deepEqual((await jobs.list({ kb: "A" })).map((job) => job.id), [b, a]);
  assert.deepEqual((await jobs.list({ kind: "kb-import" })).map((job) => job.id), [c, a]);
  assert.equal((await jobs.list({ limit: 1 })).length, 1);
});

test("已结算任务超过保留期后被清理", async () => {
  let clock = 1000;
  const jobs = createJobRegistry({ retentionMs: 1000, now: () => clock });
  const id = jobs.start({ kind: "kb-import", kb: "A", label: "a", run: async () => ({ status: "succeeded" }) });
  await tick();
  assert.ok(await jobs.get(id));
  clock += 1001;
  assert.equal(await jobs.get(id), null);
});

test("超过 maxJobs 时淘汰最旧的已结算任务", async () => {
  const jobs = createJobRegistry({ maxJobs: 2 });
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    ids.push(jobs.start({ kind: "kb-import", kb: "A", label: String(i), run: async () => ({ status: "succeeded" }) }));
    await tick();
  }
  const kept = (await jobs.list({ limit: 50 })).map((job) => job.id);
  assert.equal(kept.length, 2);
  assert.equal(kept.includes(ids[0]), false);
  assert.equal(kept.includes(ids[2]), true);
});

test("cancelAll 取消运行中的 handle", async () => {
  const jobs = createJobRegistry();
  let cancelled = false;
  const gate = deferred();
  jobs.start({
    kind: "kb-import",
    kb: "A",
    label: "a",
    run: async (job) => {
      job.setHandle({ cancel: () => { cancelled = true; gate.resolve(); } });
      await gate.promise;
      return { status: "succeeded" };
    },
  });
  await tick();
  jobs.cancelAll();
  assert.equal(cancelled, true);
});
```

- [x] **Step 3.2: 运行测试确认失败**

Run: `node --test test/web-jobs.test.mjs`
Expected: FAIL，`Cannot find module '../lib/web/jobs.js'`。

- [x] **Step 3.3: 实现 `lib/web/jobs.js`**

```js
/**
 * 工作台后台任务注册表（进程内 Map）。
 * 不复用宿主 jobs：宿主 jobs 归属 agent 会话，HTTP 工作台没有会话归属。
 * - start() 立即返回 id；run(ctx) 在任务结束时 resolve { status, detail, result }；
 * - import 任务的 progress 从 progressFile 读，std 任务由 setProgress 推；
 * - 已结算任务保留 1 小时；对外投影不含 progressFile/handle 等内部字段。
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_RETENTION_MS = 3600_000;
const DEFAULT_MAX_JOBS = 200;
const RUNNING = "running";

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

export function createJobRegistry({ retentionMs = DEFAULT_RETENTION_MS, maxJobs = DEFAULT_MAX_JOBS, now = Date.now } = {}) {
  const records = new Map();
  let counter = 0;

  function prune() {
    const cutoff = now() - retentionMs;
    for (const [id, rec] of records) {
      if (rec.status !== RUNNING && rec.finishedAt !== null && rec.finishedAt < cutoff) records.delete(id);
    }
    if (records.size <= maxJobs) return;
    const settled = [...records.values()]
      .filter((rec) => rec.status !== RUNNING)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const rec of settled) {
      if (records.size <= maxJobs) break;
      records.delete(rec.id);
    }
  }

  function toPublic(rec, progress) {
    return {
      id: rec.id,
      kind: rec.kind,
      kb: rec.kb,
      label: rec.label,
      status: rec.status,
      detail: rec.detail,
      startedAt: iso(rec.startedAt),
      finishedAt: iso(rec.finishedAt),
      progress: progress ?? rec.progress,
      result: rec.result,
    };
  }

  async function readProgress(rec) {
    if (!rec.progressFile) return rec.progress;
    try {
      const parsed = JSON.parse(await readFile(rec.progressFile, "utf8"));
      return { kind: "import", ...parsed };
    } catch {
      return rec.progress;
    }
  }

  async function get(id) {
    prune();
    const rec = records.get(String(id ?? ""));
    if (!rec) return null;
    return toPublic(rec, await readProgress(rec));
  }

  async function list({ kb, kind, limit = 20 } = {}) {
    prune();
    const max = Math.max(1, Math.min(50, Math.round(Number(limit) || 20)));
    return [...records.values()]
      .filter((rec) => (kb === undefined || rec.kb === kb) && (kind === undefined || rec.kind === kind))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, max)
      .map((rec) => toPublic(rec));
  }

  function start({ kind, kb, label, run, onSettle }) {
    prune();
    counter += 1;
    const id = `${kind}-${counter.toString(36)}-${randomBytes(2).toString("hex")}`;
    const rec = {
      id,
      kind,
      kb,
      label,
      status: RUNNING,
      detail: "",
      startedAt: now(),
      finishedAt: null,
      progress: null,
      result: null,
      progressFile: null,
      handle: null,
      onSettle,
    };
    records.set(id, rec);
    const ctx = {
      id,
      setProgressFile(file) { rec.progressFile = String(file); },
      setProgress(progress) { rec.progress = progress; },
      setHandle(handle) { rec.handle = handle; },
    };
    Promise.resolve()
      .then(() => run(ctx))
      .then(async (outcome) => {
        const final = outcome ?? {};
        rec.status = final.status === "failed" ? "failed" : "succeeded";
        rec.detail = String(final.detail ?? "");
        rec.result = final.result ?? null;
        rec.progress = null;
        rec.finishedAt = now();
        try {
          await onSettle?.(rec);
        } catch (error) {
          rec.detail = `${rec.detail}${rec.detail ? "；" : ""}收尾失败：${String(error?.message ?? error)}`;
        }
      })
      .catch((error) => {
        rec.status = "failed";
        rec.detail = String(error?.message ?? error);
        rec.finishedAt = now();
      });
    return id;
  }

  function cancelAll() {
    for (const rec of records.values()) {
      if (rec.status === RUNNING) rec.handle?.cancel?.();
    }
  }

  return { start, get, list, cancelAll };
}
```

- [x] **Step 3.4: 跑测试**

Run: `node --test test/web-jobs.test.mjs`
Expected: 6/6 通过。

- [x] **Step 3.5: Commit**

```bash
git add lib/web/jobs.js test/web-jobs.test.mjs
git commit -m "feat(web): add in-plugin job registry for workbench tasks"
```

### Task 3 实现修正记录（2026-10-24，已执行）

代码质量审查后，注册表的最终契约（Task 5/6/7 按此实现）：

1. **结算单一入口** `finish(rec, outcome)`：正常完成与 `run` 拒绝走同一条路径。outcome 归一化：`succeeded|completed → succeeded`；`failed|cancelled → failed`；其他（null/非对象/未知 status/误传 runner handle）→ `failed`，detail 追加 `run() 未返回有效结果（status=…）`。
2. **`onSettle` 契约**：`onSettle({ id, kind, kb, status, detail, result })` 在**每个**终态（成功/失败/取消/拒绝）恰好调用一次，且在任务对外可见为终态**之前** await；hook 抛错把 `；收尾失败：<msg>` 追加到 detail，不改变 status。Task 5 的批次落盘/清理必须写在这里，不能只写在成功分支。
3. **`list` 合并进度**：`list` 是 async，running 的 import 任务会读 `progressFile`；settle 后进度快照进内部缓存，`get` 返回该快照，`list` 对已结算任务返回 `progress: null`。
4. **进度读取加固**：只接受普通对象，`{ ...parsed, kind: "import" }` 覆盖文件里的 kind，读/解析失败回退上次缓存。
5. **取消**：`cancelAll` 单个 handle 抛错不影响其他任务；无 handle 的 running 记录置 `cancelRequested`，`setHandle` 时立即取消；新增 `hasRunning({ kb, kind })` 供 Task 7 使用（不要再用 `list(limit:50)` 扫描）。
6. **结算后清内部引用**：`handle`、`onSettle`、`progressFile`、`cancelRequested` 清空；`result` 保留。
7. **净化责任**：注册表只做顶层 key 白名单；`detail`/`result` 由调用方负责组成“可下发”的内容。Task 5 必须把批次绝对路径从 `detail` 与 `files[].error` 里替换掉（见 Task 5 Step 5.3 的 `redactPaths`）。

---

### Task 4: 上传批次存储 + 批次 API
**Files:**
- Modify: `lib/web/http.js`（新增 `WebError`、`readRawToFile`）
- Create: `lib/web/upload.js`
- Modify: `lib/web/api.js`（路由、`/status`、`mapError`）
- Create: `test/web-upload-batch.test.mjs`
- Modify: `test/web-api-read.test.mjs`（features/limits）

- [x] **Step 4.1: 写失败测试**

创建 `test/web-upload-batch.test.mjs`：

```js
/**
 * 上传批次：创建、raw PUT 落盘、路径/类型/限额校验、丢弃、24h 清扫。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { createJobRegistry } from "../lib/web/jobs.js";

const LIMITS = { maxUploadBytes: 1024, maxBatchFiles: 2, extensions: [".md", ".pdf"] };

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

async function* bodyOf(body) {
  if (body !== undefined) yield Buffer.isBuffer(body) ? body : Buffer.from(String(body));
}

function makeReq({ method = "GET", url = "/kb/api/status", headers = {}, body } = {}) {
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
      yield* bodyOf(body);
    },
  };
}

async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

async function setup(limits = LIMITS) {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-upload-")), "kb");
  await createKb(kbRoot, { name: "标准" });
  const opts = { kbRoot, limits, jobs: createJobRegistry() };
  return { kbRoot, opts };
}

async function createBatch(opts) {
  const { json } = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", body: JSON.stringify({ kb: "标准" }) }));
  assert.ok(json?.batch?.id, JSON.stringify(json));
  return json.batch.id;
}

test("POST /upload-batches 创建批次目录并回 limits", async () => {
  const { kbRoot, opts } = await setup();
  const { res, json } = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", body: JSON.stringify({ kb: "标准" }) }));
  assert.equal(res.status, 201);
  assert.match(json.batch.id, /^b-[0-9a-f]{12}$/);
  assert.equal(json.batch.status, "open");
  assert.equal(json.limits.maxBytes, 1024);
  assert.ok(existsSync(join(kbRoot, "标准", "import-tmp", "ui-batches", json.batch.id, "batch.json")));
});

test("POST /upload-batches 对不存在的库返回 404，create:true 时建库", async () => {
  const { opts } = await setup();
  const missing = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", body: JSON.stringify({ kb: "新库" }) }));
  assert.equal(missing.res.status, 404);
  const created = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", body: JSON.stringify({ kb: "新库", create: true }) }));
  assert.equal(created.res.status, 201);
});

test("PUT 落盘保留目录结构并更新 batch.json", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts);
  const url = `/kb/api/upload-batches/${id}/files?path=${encodeURIComponent("电气/说明.md")}`;
  const { res, json } = await call(opts, makeReq({ method: "PUT", url, body: "# 说明\n" }));
  assert.equal(res.status, 200);
  assert.equal(json.path, "电气/说明.md");
  assert.ok(json.size > 0);
  const stored = await readFile(join(kbRoot, "标准", "import-tmp", "ui-batches", id, "电气", "说明.md"), "utf8");
  assert.equal(stored, "# 说明\n");
  const batch = JSON.parse(await readFile(join(kbRoot, "标准", "import-tmp", "ui-batches", id, "batch.json"), "utf8"));
  assert.deepEqual(batch.files.map((f) => f.path), ["电气/说明.md"]);
});

test("PUT 拒绝路径穿越、反斜杠、非法扩展名、超限与超文件数", async () => {
  const { opts } = await setup();
  const id = await createBatch(opts);
  const put = (p, body = "x") =>
    call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=${encodeURIComponent(p)}`, body }));

  assert.equal((await put("../evil.md")).res.status, 400);
  assert.equal((await put("电气\\evil.md")).res.status, 400);
  assert.equal((await put(".hidden")).json.error.code, "UNSUPPORTED_TYPE");
  const big = "a".repeat(2048);
  const tooLarge = await put("big.md", big);
  assert.equal(tooLarge.res.status, 413);
  assert.equal(tooLarge.json.error.code, "UPLOAD_TOO_LARGE");

  assert.equal((await put("a.md")).res.status, 200);
  assert.equal((await put("b.md")).res.status, 200);
  const third = await put("c.md");
  assert.equal(third.res.status, 413);
  assert.equal(third.json.error.code, "BATCH_TOO_MANY_FILES");
});

test("GET/DELETE 批次；锁定状态拒绝写入与删除", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts);
  await call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=a.md`, body: "x" }));
  const got = await call(opts, makeReq({ method: "GET", url: `/kb/api/upload-batches/${id}` }));
  assert.equal(got.res.status, 200);
  assert.equal(got.json.batch.files.length, 1);

  // 手动锁定批次，模拟导入已启动
  const batchPath = join(kbRoot, "标准", "import-tmp", "ui-batches", id, "batch.json");
  const batch = JSON.parse(await readFile(batchPath, "utf8"));
  batch.status = "importing";
  await writeFile(batchPath, JSON.stringify(batch), "utf8");
  const locked = await call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=b.md`, body: "x" }));
  assert.equal(locked.res.status, 409);
  assert.equal((await call(opts, makeReq({ method: "DELETE", url: `/kb/api/upload-batches/${id}` }))).res.status, 409);
});

test("批次 id 非法返回 400，不存在返回 404", async () => {
  const { opts } = await setup();
  assert.equal((await call(opts, makeReq({ method: "GET", url: "/kb/api/upload-batches/nope" }))).res.status, 400);
  assert.equal((await call(opts, makeReq({ method: "GET", url: "/kb/api/upload-batches/b-000000000000" }))).res.status, 404);
});

test("创建新批次时清扫 24 小时前的旧批次", async () => {
  const { kbRoot, opts } = await setup();
  const oldId = await createBatch(opts);
  const oldDir = join(kbRoot, "标准", "import-tmp", "ui-batches", oldId);
  const batchPath = join(oldDir, "batch.json");
  const batch = JSON.parse(await readFile(batchPath, "utf8"));
  batch.createdAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  await writeFile(batchPath, JSON.stringify(batch), "utf8");
  await createBatch(opts);
  assert.equal(existsSync(oldDir), false);
});

test("缺 x-kb-ui 或跨源时返回 403", async () => {
  const { opts } = await setup();
  const noHeader = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", headers: { "x-kb-ui": "" }, body: JSON.stringify({ kb: "标准" }) }));
  assert.equal(noHeader.res.status, 403);
  const cross = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", headers: { origin: "http://evil.example" }, body: JSON.stringify({ kb: "标准" }) }));
  assert.equal(cross.res.status, 403);
});
```

把 `test/web-api-read.test.mjs` 的 status 用例整体替换为：

```js
test("GET /status returns feature flags", async () => {
  const { kbRoot } = await setup();
  const limits = { maxUploadBytes: 1000, maxBatchFiles: 10, extensions: [".md"] };
  const { res, json } = await call({ kbRoot, limits }, makeReq({ url: "/kb/api/status" }));
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.features.merge, false);
  assert.equal(json.features.upload, true);
  assert.equal(json.features.std, true);
  assert.equal(json.limits.maxUploadBytes, 1000);
  assert.deepEqual(json.limits.extensions, [".md"]);
});
```

- [x] **Step 4.2: 运行测试确认失败**

Run: `node --test test/web-upload-batch.test.mjs`
Expected: FAIL（路由 404 `NOT_FOUND`、`readRawToFile` 不存在）。

- [x] **Step 4.3: 在 `lib/web/http.js` 增加 `WebError` 与 `readRawToFile`**

顶部 import 改为：

```js
import { createReadStream, createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { extname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
```

在 `sendJson` 之前加入：

```js
/** 带 HTTP 状态与机器码的业务错误；api.js 统一映射成 { error: { code, message } }。 */
export class WebError extends Error {
  constructor(code, status, message, details) {
    super(message);
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}
```

在文件末尾加入：

```js
/**
 * 把请求体流式写到 dest（不缓冲整个文件），超过 maxBytes 时中断并清理临时文件。
 * dest 必须以 "wx" 打开（调用方用随机临时名，避免 clobber）。
 * 用 stream/promises.pipeline 统一处理背压、错误与关闭，超限时销毁整条管线。
 */
export async function readRawToFile(source, dest, { maxBytes = 0 } = {}) {
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (maxBytes > 0 && size > maxBytes) {
        callback(new WebError("UPLOAD_TOO_LARGE", 413, `文件超过上限 ${maxBytes} 字节`, { maxBytes }));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, limiter, createWriteStream(dest, { flags: "wx" }));
    return { size };
  } catch (error) {
    await rm(dest, { force: true }).catch(() => {});
    throw error;
  }
}
```

- [x] **Step 4.4: 实现 `lib/web/upload.js`（本任务只含批次部分）**

```js
/**
 * 上传批次：目录布局 <kb>/import-tmp/ui-batches/<batchId>/，
 * batch.json 原子写 + 批次内串行队列；PUT 走流式落盘与逐段路径校验。
 * 导入（importBatch）在 Task 5 追加。
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { SUPPORTED_EXTS } from "../parsers.js";
import { WebError, readRawToFile } from "./http.js";

export const BATCH_SUBDIR = "ui-batches";
const BATCH_ID_RE = /^b-[0-9a-f]{12}$/;
const MAX_REL_PATH = 400;
const OLD_BATCH_MS = 24 * 3600 * 1000;

const batchQueues = new Map();

/** 同批次写入串行化：并发 2 的上传不会丢 batch.json 里的文件条目。 */
export function withBatchLock(key, task) {
  const prev = batchQueues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  const guarded = next.catch(() => {});
  batchQueues.set(key, guarded);
  guarded.finally(() => {
    if (batchQueues.get(key) === guarded) batchQueues.delete(key);
  });
  return next;
}

export function uiBatchesRoot(kbDir) {
  return join(kbDir, "import-tmp", BATCH_SUBDIR);
}

export function batchDirFor(kbDir, batchId) {
  return join(uiBatchesRoot(kbDir), batchId);
}

function assertBatchId(batchId) {
  if (!BATCH_ID_RE.test(String(batchId ?? ""))) {
    throw new WebError("BATCH_INVALID", 400, "上传批次 id 非法");
  }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rm(path, { force: true }).catch(() => {});
  await rename(tmp, path);
}

export function validateRelPath(raw) {
  const value = String(raw ?? "").normalize("NFC");
  if (value === "" || value.length > MAX_REL_PATH) {
    throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径为空或过长");
  }
  if (value.includes("\\") || isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径不能是绝对路径或包含反斜杠");
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径包含控制字符");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径包含非法片段");
  }
  return parts.join("/");
}

export function assertSupportedType(relPath) {
  const ext = extname(relPath).toLowerCase();
  if (!SUPPORTED_EXTS.includes(ext)) {
    throw new WebError("UNSUPPORTED_TYPE", 415, `不支持的文件类型 "${ext || "无扩展名"}"`, { extensions: SUPPORTED_EXTS });
  }
  return ext;
}

function resolveBatchPath(batchDir, relPath) {
  const abs = resolve(batchDir, relPath);
  if (abs !== batchDir && !abs.startsWith(batchDir + sep)) {
    throw new WebError("UPLOAD_PATH_INVALID", 400, "上传路径越界");
  }
  return abs;
}

export async function createUploadBatch({ kbDir, kb, now = Date.now() }) {
  const batchId = `b-${randomBytes(6).toString("hex")}`;
  const dir = batchDirFor(kbDir, batchId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date(now).toISOString();
  const batch = { version: 1, batchId, kb, createdAt: stamp, updatedAt: stamp, status: "open", files: [] };
  await writeJsonAtomic(join(dir, "batch.json"), batch);
  return { batch, dir };
}

export async function readBatch(kbDir, batchId) {
  assertBatchId(batchId);
  const path = join(batchDirFor(kbDir, batchId), "batch.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new WebError("BATCH_NOT_FOUND", 404, "上传批次不存在");
    throw new WebError("BATCH_INVALID", 400, "批次元数据损坏");
  }
}

async function writeBatch(kbDir, batchId, batch) {
  const path = join(batchDirFor(kbDir, batchId), "batch.json");
  await writeJsonAtomic(path, batch);
  return batch;
}

/** 按 id 找到批次所属的知识库目录（URL 不带 kb）。 */
export async function findBatchKbDir(kbRoot, batchId) {
  assertBatchId(batchId);
  const entries = await readdir(kbRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const kbDir = join(kbRoot, entry.name);
    if (existsSync(join(batchDirFor(kbDir, batchId), "batch.json"))) return kbDir;
  }
  throw new WebError("BATCH_NOT_FOUND", 404, "上传批次不存在");
}

export async function addBatchFile({ kbDir, batchId, relPath, source, limits = {} }) {
  return withBatchLock(batchId, async () => {
    const batch = await readBatch(kbDir, batchId);
    if (batch.status !== "open") throw new WebError("BATCH_LOCKED", 409, "批次已锁定，不能继续上传");
    const rel = validateRelPath(relPath);
    assertSupportedType(rel);
    const exists = batch.files.some((file) => file.path === rel);
    if (!exists && batch.files.length + 1 > limits.maxBatchFiles) {
      throw new WebError("BATCH_TOO_MANY_FILES", 413, `单批最多 ${limits.maxBatchFiles} 个文件`, {
        maxFiles: limits.maxBatchFiles,
      });
    }
    const dir = batchDirFor(kbDir, batchId);
    const target = resolveBatchPath(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(dir, `.upload-${randomBytes(6).toString("hex")}.part`);
    const { size } = await readRawToFile(source, tmp, { maxBytes: limits.maxUploadBytes });
    await rm(target, { force: true }).catch(() => {});
    await rename(tmp, target);
    if (exists) {
      batch.files = batch.files.map((file) => (file.path === rel ? { path: rel, size } : file));
    } else {
      batch.files.push({ path: rel, size });
    }
    batch.updatedAt = new Date().toISOString();
    await writeBatch(kbDir, batchId, batch);
    return { path: rel, size };
  });
}

export async function removeUploadBatch(kbDir, batchId) {
  assertBatchId(batchId);
  await rm(batchDirFor(kbDir, batchId), { recursive: true, force: true });
}

export async function discardOpenBatch(kbDir, batchId) {
  return withBatchLock(batchId, async () => {
    const batch = await readBatch(kbDir, batchId);
    if (batch.status !== "open") throw new WebError("BATCH_LOCKED", 409, "批次已开始导入，不能丢弃");
    await removeUploadBatch(kbDir, batchId);
    return { ok: true };
  });
}

export function publicBatch(batch, limits = {}) {
  return {
    id: batch.batchId,
    kb: batch.kb,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    files: batch.files,
    limits: { maxBytes: limits.maxUploadBytes, maxFiles: limits.maxBatchFiles, extensions: limits.extensions },
  };
}

export async function sweepOldBatches({ kbDir, maxAgeMs = OLD_BATCH_MS, now = Date.now() }) {
  const root = uiBatchesRoot(kbDir);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !BATCH_ID_RE.test(entry.name)) continue;
    const dir = join(root, entry.name);
    let createdAt = 0;
    try {
      const batch = JSON.parse(await readFile(join(dir, "batch.json"), "utf8"));
      createdAt = Date.parse(batch.createdAt) || 0;
    } catch {
      /* 元数据损坏时用目录 mtime 兜底 */
    }
    if (createdAt === 0) {
      createdAt = (await stat(dir).catch(() => ({ mtimeMs: now }))).mtimeMs;
    }
    if (now - createdAt > maxAgeMs) {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
```

- [x] **Step 4.5: 在 `lib/web/api.js` 接上批次路由**

顶部 import 改为：

```js
import { WebError } from "./http.js";
import { createKb } from "../kbmeta.js";
import {
  addBatchFile,
  createUploadBatch,
  discardOpenBatch,
  findBatchKbDir,
  publicBatch,
  readBatch,
  sweepOldBatches,
} from "./upload.js";
```

把 `import { archiveKb, createKb, listTrash, ... } from "../kbmeta.js";` 合并成一行（`createKb` 只 import 一次）。

把文件顶部 `class KbError ...` 改为：

```js
const KbError = WebError;
```

`mapError` 第一行改为：

```js
  if (error instanceof WebError) return error;
```

catch 分支的 `sendError` 调用补 details：

```js
    return sendError(res, status, code, String(error?.message ?? error), error?.details);
```

`/status` 分支替换为：

```js
    if (method === "GET" && segments.length === 1 && segments[0] === "status") {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        kbRoot: opts.kbRoot,
        features: { ui: true, merge: false, std: true, upload: true, jobs: true },
        limits: opts.limits ?? null,
      });
    }
```

在 `/kbs` POST 之前插入批次路由：

```js
    if (segments.length === 1 && segments[0] === "upload-batches" && method === "POST") {
      const body = await readJsonBody(req);
      const kb = sanitizeKbName(body?.kb);
      const dir = kbDirPath(opts.kbRoot, kb);
      if (!existsSync(join(dir, "kb.json"))) {
        if (body?.create !== true) throw new KbError("KB_NOT_FOUND", 404, `知识库不存在: ${kb}`);
        await createKb(opts.kbRoot, { name: kb });
      }
      await sweepOldBatches({ kbDir: dir }).catch(() => {});
      const { batch } = await createUploadBatch({ kbDir: dir, kb });
      return sendJson(res, 201, { batch: publicBatch(batch, opts.limits), limits: opts.limits });
    }

    if (segments[0] === "upload-batches" && segments.length === 3 && segments[2] === "files" && method === "PUT") {
      const kbDir = await findBatchKbDir(opts.kbRoot, segments[1]);
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const relPath = url.searchParams.get("path") ?? "";
      const result = await addBatchFile({ kbDir, batchId: segments[1], relPath, source: req, limits: opts.limits });
      return sendJson(res, 200, result);
    }

    if (segments[0] === "upload-batches" && segments.length === 2 && method === "GET") {
      const kbDir = await findBatchKbDir(opts.kbRoot, segments[1]);
      const batch = await readBatch(kbDir, segments[1]);
      return sendJson(res, 200, { batch: publicBatch(batch, opts.limits), limits: opts.limits });
    }

    if (segments[0] === "upload-batches" && segments.length === 2 && method === "DELETE") {
      const kbDir = await findBatchKbDir(opts.kbRoot, segments[1]);
      return sendJson(res, 200, await discardOpenBatch(kbDir, segments[1]));
    }
```

- [x] **Step 4.6: 跑测试**

Run:
```bash
node --test test/web-upload-batch.test.mjs test/web-api-read.test.mjs
```
Expected: 全通过（若 `web-api-read` 的 limits 断言因 opts 构造未改而失败，按 Step 4.1 备注补齐）。

- [x] **Step 4.7: Commit**

```bash
git add lib/web/http.js lib/web/upload.js lib/web/api.js test/web-upload-batch.test.mjs test/web-api-read.test.mjs
git commit -m "feat(web): upload batches with streamed raw PUT and path/limit guards"
```

### Task 4 实现修正记录（2026-10-24，已执行）

代码质量审查后，批次存储/API 的最终契约（Task 5/11 按此实现）：

1. **PUT 不长时间持锁**：校验 → 在无锁状态把 body 流式写入批次目录内的唯一 `.part` → 进 `withBatchLock` 重新校验状态/文件数/大小写重复 → `mkdir` 父目录 → `rm`+`rename` → 更新 `batch.json`；`finally` 永远删除临时文件。失败路径不得残留 `.part` 或空目录。
2. **错误契约**：`WebError` 之外的异常统一 `console.error` 后用 `500 UPLOAD_FAILED / 上传写入失败` 返回，响应里不带 Node errno/绝对路径。`readJsonBody`/`assertSameOrigin`/`requireUiHeader` 也改为抛 `WebError`（保持 400/403 code）。
3. **路径组件**：每个 segment 的 UTF-8 字节数 ≤255；拒绝以 `.`/空格结尾的组件与仅大小写不同的重复路径（400 `UPLOAD_PATH_INVALID`）。完全相同的路径仍按“原位覆盖”处理。
4. **限额**：`normalizeLimits(opts.limits)` = 2 GiB / 1000 / `SUPPORTED_EXTS`；`/status` 返回 raw 形态（`maxUploadBytes/maxBatchFiles/extensions`），批次响应返回 `publicBatch` 的归一化形态（`maxBytes/maxFiles/extensions`）。
5. **清扫**：`withBatchLock` 内按状态判龄——`open` 取 `max(createdAt, updatedAt, batch.json mtime)`；`failed` 取 `max(updatedAt, mtime)`；`importing` 仅当 `batch.json` 与 `progress.json` 都超过 24h（崩溃遗留）才删；未知元数据回退目录 mtime。
6. **导入锁**：`markBatchImporting(kbDir, batchId, { expectedFiles })` 在锁内校验 `open`/非空/文件快照，返回 409 `BATCH_LOCKED`、400 `BATCH_EMPTY`、409 `BATCH_CHANGED`。Task 5 的 import 必须调用它，不能自己写 `batch.status = "importing"`。

---

### Task 5: 批次导入 API（查重、锁定、进度、清理）

**Files:**
- Modify: `lib/web/upload.js`（新增 `importBatch`、`writeProgressFile`、`buildImportFiles`）
- Modify: `lib/web/api.js`（POST import 路由）
- Create: `test/web-upload-import.test.mjs`

- [x] **Step 5.1: 写失败测试**

创建 `test/web-upload-import.test.mjs`：

```js
/**
 * 批次导入：查重过滤、批次锁定、任务结算、成功删批次/失败保留。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { createJobRegistry } from "../lib/web/jobs.js";
import { importFileInto } from "../lib/pipeline.js";

const LIMITS = { maxUploadBytes: 1024 * 1024, maxBatchFiles: 10, extensions: [".md"] };

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/status", headers = {}, body } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1", ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(String(body));
    },
  };
}

async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

function fakeWorkerSpawn({ exitCode = 0, report = { ok: 1, fail: 0, skip: 0, files: [{ title: "a", status: "ok" }] } } = {}) {
  return (spec) => {
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    (async () => {
      const raw = spec.argv[spec.argv.length - 1];
      const argsFile = raw.startsWith("@") ? raw.slice(1) : null;
      const args = argsFile ? JSON.parse(await readFile(argsFile, "utf8")) : {};
      if (args.progressFile) {
        await writeFile(
          args.progressFile,
          JSON.stringify({ done: 1, total: 1, ok: 1, fail: 0, skip: 0, current: "a.md", files: [{ path: "a.md", status: "ok" }] }),
          "utf8"
        );
      }
      if (args.reportFile) await writeFile(args.reportFile, JSON.stringify(report), "utf8");
      resolveDone({ exitCode, signal: null });
    })();
    return {
      terminate: async () => resolveDone({ exitCode: 0, signal: "SIGTERM" }),
      done,
      collected: {
        stdout: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
      },
    };
  };
}

async function setup({ spawn = fakeWorkerSpawn(), limits = LIMITS } = {}) {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-import-api-")), "kb");
  await createKb(kbRoot, { name: "标准" });
  const opts = {
    kbRoot,
    limits,
    jobs: createJobRegistry(),
    spawn,
    importConfig: () => ({ partMaxChars: 2000 }),
  };
  return { kbRoot, opts };
}

async function createBatch(opts, files) {
  const created = await call(opts, makeReq({ method: "POST", url: "/kb/api/upload-batches", body: JSON.stringify({ kb: "标准" }) }));
  const id = created.json.batch.id;
  for (const [path, content] of Object.entries(files)) {
    await call(opts, makeReq({ method: "PUT", url: `/kb/api/upload-batches/${id}/files?path=${encodeURIComponent(path)}`, body: content }));
  }
  return id;
}

async function waitJob(opts, jobId) {
  for (let i = 0; i < 100; i += 1) {
    const job = await opts.jobs.get(jobId);
    if (job && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not settle");
}

async function waitFor(check, { attempts = 100, delay = 10 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("waitFor timeout");
}

test("成功导入：任务 succeeded、result 带逐文件、批次目录删除", async () => {
  const { kbRoot, opts } = await setup();
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches");
  const id = await createBatch(opts, { "电气/a.md": "# a\n内容\n" });
  const { res, json } = await call(opts, makeReq({
    method: "POST",
    url: `/kb/api/upload-batches/${id}/import`,
    body: JSON.stringify({ ocrModel: "best" }),
  }));
  assert.equal(res.status, 202);
  assert.ok(json.jobId);
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.fail, 0);
  assert.equal(job.result.files[0].status, "ok");
  await waitFor(() => (existsSync(join(dir, id)) ? null : true));
  assert.equal(existsSync(join(dir, id)), false);
});

test("部分失败：任务 succeeded 但 result.fail>0，批次目录保留且状态 failed", async () => {
  const { kbRoot, opts } = await setup({
    spawn: fakeWorkerSpawn({ exitCode: 0, report: { ok: 1, fail: 1, skip: 0, files: [{ title: "a", status: "ok" }, { title: "b", status: "failed", error: "坏文件" }] } }),
  });
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches");
  const id = await createBatch(opts, { "a.md": "# a\n", "b.md": "# b\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "succeeded");
  assert.equal(job.result.fail, 1);
  const batch = await waitFor(async () => {
    try {
      const parsed = JSON.parse(await readFile(join(dir, id, "batch.json"), "utf8"));
      return parsed.status === "failed" ? parsed : null;
    } catch {
      return null;
    }
  });
  assert.equal(batch.status, "failed");
  assert.ok(existsSync(join(dir, id, "progress.json")));
});

test("进程级失败：任务 failed、批次保留", async () => {
  const { kbRoot, opts } = await setup({ spawn: fakeWorkerSpawn({ exitCode: 3 }) });
  const dir = join(kbRoot, "标准", "import-tmp", "ui-batches");
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "failed");
  assert.match(job.detail, /进程异常退出/);
  const batch = await waitFor(async () => {
    try {
      const parsed = JSON.parse(await readFile(join(dir, id, "batch.json"), "utf8"));
      return parsed.status === "failed" ? parsed : null;
    } catch {
      return null;
    }
  });
  assert.equal(batch.status, "failed");
});

test("启动进程失败时任务 failed 且响应里没有绝对路径", async () => {
  const { kbRoot, opts } = await setup();
  opts.spawn = () => { throw new Error(`spawn 失败：${kbRoot}/标准/import-tmp/x.json 不存在`); };
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const { json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const job = await waitJob(opts, json.jobId);
  assert.equal(job.status, "failed");
  assert.match(job.detail, /启动导入进程失败/);
  assert.equal(job.detail.includes(kbRoot), false);
  assert.equal(JSON.stringify(job.result).includes(kbRoot), false);
});

test("全部重复：jobId 为 null、批次保持 open", async () => {
  const { kbRoot, opts } = await setup();
  const src = join(await mkdtemp(join(tmpdir(), "kb-dup-")), "a.md");
  await writeFile(src, "# a\n内容\n", "utf8");
  await importFileInto(join(kbRoot, "标准"), { sourcePath: src, relKey: "a.md", title: "a", config: { partMaxChars: 2000 } });

  const id = await createBatch(opts, { "a.md": "# a\n内容\n" });
  const { res, json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  assert.equal(res.status, 200);
  assert.equal(json.jobId, null);
  assert.equal(json.status, "empty");
  assert.ok(json.duplicates.length >= 1);
  const batch = await call(opts, makeReq({ method: "GET", url: `/kb/api/upload-batches/${id}` }));
  assert.equal(batch.json.batch.status, "open");
});

test("已导入过的批次再次 import 返回 409", async () => {
  const { kbRoot, opts } = await setup();
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const batchPath = join(kbRoot, "标准", "import-tmp", "ui-batches", id, "batch.json");
  const batch = JSON.parse(await readFile(batchPath, "utf8"));
  batch.status = "importing";
  await writeFile(batchPath, JSON.stringify(batch), "utf8");
  const { res, json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  assert.equal(res.status, 409);
  assert.equal(json.error.code, "BATCH_LOCKED");
});

test("并发 import：一个 202、一个 409（批次锁）", async () => {
  const { opts } = await setup();
  const id = await createBatch(opts, { "a.md": "# a\n" });
  const request = () => call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  const [first, second] = await Promise.all([request(), request()]);
  const statuses = [first.res.status, second.res.status].sort();
  assert.deepEqual(statuses, [202, 409]);
  const failed = first.res.status === 409 ? first : second;
  assert.equal(failed.json.error.code, "BATCH_LOCKED");
});

test("空批次 import 返回 400 BATCH_EMPTY", async () => {
  const { opts } = await setup();
  const id = await createBatch(opts, {});
  const { res, json } = await call(opts, makeReq({ method: "POST", url: `/kb/api/upload-batches/${id}/import`, body: "{}" }));
  assert.equal(res.status, 400);
  assert.equal(json.error.code, "BATCH_EMPTY");
});
```

- [x] **Step 5.2: 运行测试确认失败**

Run: `node --test test/web-upload-import.test.mjs`
Expected: FAIL（POST import 路由不存在 → 404）。

- [x] **Step 5.3: 在 `lib/web/upload.js` 追加导入实现**

在文件末尾追加（`import` 区补 `basename`、`extname` 已 import；再补 `createImportWorkerRunner`、`prepareImportArgs`、`tempReportFile`、`scanDuplicates`、`tmpdir`）：

```js
import { tmpdir } from "node:os";
import { createImportWorkerRunner, prepareImportArgs, tempReportFile } from "../import-job.js";
import { createProgress, writeProgressFile } from "../progress.js";
import { scanDuplicates } from "../dedup.js";
```

追加函数：

```js
/** 把内部绝对路径从面向客户端文本里替换掉（注册表只做 key 白名单，内容净化由调用方负责）。 */
export function redactPaths(text, prefixes = []) {
  let out = String(text ?? "");
  for (const prefix of prefixes) {
    if (!prefix) continue;
    out = out.split(String(prefix)).join("<path>");
  }
  return out;
}

export function buildImportFiles(kbDir, batch) {
  const dir = batchDirFor(kbDir, batch.batchId);
  return batch.files.map((file) => {
    const rel = file.path.normalize("NFC");
    return {
      sourcePath: join(dir, rel),
      relKey: rel,
      title: basename(rel, extname(rel)),
      sourceFile: rel,
      storedSourcePath: "",
    };
  });
}

/**
 * 启动批次导入：查重 → 锁定批次 → 写初始进度 → 注册任务。
 * 全部文件都重复时返回 { jobId: null } 且批次保持 open。
 */
export async function importBatch({
  jobs,
  spawn,
  kbRoot,
  kb,
  kbDir,
  batchId,
  body,
  importConfig,
  dedup = scanDuplicates,
}) {
  const batch = await readBatch(kbDir, batchId);
  if (batch.status !== "open") throw new WebError("BATCH_LOCKED", 409, "批次已开始导入");
  if (batch.files.length === 0) throw new WebError("BATCH_EMPTY", 400, "批次里没有文件");

  const allFiles = buildImportFiles(kbDir, batch);
  const scanned = await dedup({
    root: kbRoot,
    targetKb: kb,
    files: allFiles,
    allowCrossKb: body?.allowCrossDuplicates === true,
  });
  const kept = scanned.kept;
  const duplicates = scanned.duplicates ?? [];
  const similar = scanned.similar ?? [];
  if (kept.length === 0) return { jobId: null, status: "empty", duplicates, similar };

  // 锁定 open → importing：与 PUT/DELETE 互斥；expectedFiles 防止 dedup 期间又上传了新文件。
  // 只让 markBatchImporting 的 WebError 透传；非 WebError（如 batch.json 写失败）交给 api 层净化成 500。
  await markBatchImporting(kbDir, batchId, { expectedFiles: batch.files });

  const dir = batchDirFor(kbDir, batchId);
  const progressFile = join(dir, "progress.json");
  const config = importConfig({ ocrModel: body?.ocrModel === "fast" ? "fast" : "best" });
  await writeProgressFile(progressFile, createProgress(kept)).catch(() => {});

  const reportFile = tempReportFile();
  const argsFile = await prepareImportArgs({ dir: kbDir, kbRoot, kb, files: kept, config, reportFile, progressFile });
  const jobId = jobs.start({
    kind: "kb-import",
    kb,
    label: `导入 ${kb}: ${kept.length} 个文件`,
    run: async (job) => {
      job.setProgressFile(progressFile);
      // 内容净化：注册表只做 key 白名单，绝对路径由这里统一替换（kbDir 覆盖 batchDir/argsFile）。
      const redactPrefixes = [kbDir, kbRoot, tmpdir()];
      const failedResult = (detail, report) => ({
        status: "failed",
        detail: redactPaths(detail, redactPrefixes),
        result: {
          fileCount: kept.length,
          ok: report?.ok ?? 0,
          fail: report?.fail ?? 0,
          skip: report?.skip ?? 0,
          files: (report?.files ?? []).map((file) => ({
            title: file.title,
            status: file.status,
            ...(file.error ? { error: redactPaths(file.error, redactPrefixes) } : {}),
          })),
          duplicates,
          similar,
        },
      });
      let handle;
      try {
        const runner = createImportWorkerRunner({ spawn, dir: kbDir, argsFile, reportFile, fileCount: kept.length, kb });
        handle = runner.run();
      } catch (error) {
        return failedResult(`启动导入进程失败：${String(error?.message ?? error)}`, null);
      }
      job.setHandle(handle);
      let outcome;
      try {
        outcome = await handle.done;
      } catch (error) {
        return failedResult(`导入任务异常：${String(error?.message ?? error)}`, null);
      }
      const report = outcome.report ?? { ok: 0, fail: 0, skip: 0, files: [] };
      // 工作台任务状态只看 worker 是否跑完：逐文件部分失败仍是 succeeded（由 result.fail 表达），
      // 进程崩溃/被取消/全部文件失败（worker 退出码 1）才是 failed。契约见 Task 1 修正记录。
      const crashed = outcome.cancelled === true || (outcome.exitCode ?? 1) !== 0;
      return {
        status: crashed ? "failed" : "succeeded",
        detail: redactPaths(outcome.detail, redactPrefixes),
        result: {
          fileCount: kept.length,
          ok: report.ok ?? 0,
          fail: report.fail ?? 0,
          skip: report.skip ?? 0,
          files: (report.files ?? []).map((file) => ({
            title: file.title,
            status: file.status,
            ...(file.error ? { error: redactPaths(file.error, redactPrefixes) } : {}),
          })),
          duplicates,
          similar,
        },
      };
    },
    onSettle: async ({ status, result }) => {
      const fail = result?.fail ?? 0;
      try {
        if (status === "succeeded" && fail === 0) {
          await removeUploadBatch(kbDir, batchId);
        } else {
          batch.status = "failed";
          batch.updatedAt = new Date().toISOString();
          await writeBatch(kbDir, batchId, batch).catch(() => {});
        }
      } catch (error) {
        // 抛出的消息会进入 job.detail；先净化再抛，避免把批次绝对路径带给客户端。
        throw new Error(redactPaths(String(error?.message ?? error), [kbDir, kbRoot, tmpdir()]));
      }
    },
  });
  return { jobId, files: kept.length, duplicates, similar };
}
```

- [x] **Step 5.4: 在 `lib/web/api.js` 加 import 路由**

import 增加 `importBatch`；在 DELETE 路由之后插入：

```js
    if (segments[0] === "upload-batches" && segments.length === 3 && segments[2] === "import" && method === "POST") {
      const body = await readJsonBody(req);
      const kbDir = await findBatchKbDir(opts.kbRoot, segments[1]);
      const batch = await readBatch(kbDir, segments[1]);
      const result = await importBatch({
        jobs: opts.jobs,
        spawn: opts.spawn,
        kbRoot: opts.kbRoot,
        kb: batch.kb,
        kbDir,
        batchId: segments[1],
        body,
        importConfig: opts.importConfig ?? (() => ({})),
      });
      return sendJson(res, result.jobId ? 202 : 200, result);
    }
```

- [x] **Step 5.5: 跑测试**

Run: `node --test test/web-upload-import.test.mjs test/web-upload-batch.test.mjs`
Expected: 全通过。

- [x] **Step 5.6: Commit**

```bash
git add lib/web/upload.js lib/web/api.js test/web-upload-import.test.mjs
git commit -m "feat(web): import uploaded batches as workbench jobs with dedup and cleanup"
```

### Task 5 实现修正记录（2026-10-24，已执行）

1. **全部重复测试修正**：`lib/dedup.js` 对同一 `relKey` 视为原位更新、且标题核心匹配有 6 字符下限，计划原测试（`a.md` + 标题 `a`）无法触发 duplicates。最终用例：先把 `旧/电气设备安装说明.md`（标题 `电气设备安装说明`）导入库，再上传 `电气设备安装说明.md`；断言 `jobId === null`、`status === "empty"`、`duplicates.length >= 1`、批次仍 `open`。
2. **duplicates/similar 下发形状**：新增内部 `publicMatches()`，把 dedup 的 `{title, sourcePath, scope, matched}` 映射为 `{ title, scope, matched }`，避免 `sourcePath`（批次绝对路径）进入 HTTP 响应与 `job.result`。
3. **导入锁与快照**：`markBatchImporting(kbDir, batchId, { expectedFiles: batch.files })`；`markBatchImporting` 之后的启动阶段整体 try/catch：失败时删 args 文件、在批次锁内 `markBatchFailed`（`failed`+`updatedAt`），再抛出。锁前错误（BATCH_LOCKED/BATCH_CHANGED）不改批次。
4. **KB 名以目录为准**：`kbName = basename(kbDir)` 用于 dedup `targetKb`、`job.kb`、label、worker args 与 runner；API 不再传 `kb`，避免改名后导入落到旧名下。
5. **初始进度 best-effort**：`writeProgressFile(progressFile, createProgress(kept)).catch(() => {})`，位于 `<batchDir>/progress.json`（与 sweep 的 importing 判龄约定一致）。
6. **run/onSettle**：`runner.run()`/`handle.done`/report 缺失各自 try/catch 返回净化后的失败 outcome；`result.files[]` 恒为 `{path,title,status,error?}`（kept 顺序，失败路径按 kept 合成），`path` 是批次内相对路径，供 Task 11 重试匹配。`onSettle({status,result})` 仅当 `succeeded && fail===0 && skip===0` 删批次；否则 `markBatchFailed`，抛错先 `redactPaths`（前缀含 `kbDir/kbRoot/PLUGIN_ROOT/tmpdir`）。
7. **进度错误净化**：worker 写 `progress.files[].error` 前把 `sourcePath` 换成相对路径、去掉 `kbDir`/`pluginRoot`，截 200 字。
8. 测试 15 条（成功、部分失败含真实路径净化、进程级失败、spawn 失败、报告缺失、skip 保留、全部重复、已锁定 409、并发 202/409、BATCH_CHANGED、全部失败 exit 1、空批次、初始进度、改名落点、KB 名权威），并断言响应/job JSON/progress 不含绝对路径。

---

### Task 6: 任务查询 API

**Files:**
- Modify: `lib/web/api.js`
- Extend: `test/web-jobs.test.mjs`（HTTP 层两条用例）

> **Task 6 约束（来自 Task 5 复审）**：`GET /jobs` 列表必须**省略 `result`**（最多 50 条、单条 result 可达 1000 文件），只返回 `id/kind/kb/label/status/detail/startedAt/finishedAt/progress`；`GET /jobs/:id` 才返回完整 `result`。

- [x] **Step 6.1: 追加失败测试**

在 `test/web-jobs.test.mjs` 顶部 import 区补：

```js
import { handleApi } from "../lib/web/api.js";
```

在文件末尾追加（自带 HTTP 测试 helper，避免跨文件引用）：

```js
function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/status", headers = {}, body } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1", ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(String(body));
    },
  };
}

async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

test("GET /jobs/:id 返回任务，未知 id 404", async () => {
  const jobs = createJobRegistry();
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-jobs-api-")), "kb");
  const opts = { kbRoot, jobs, limits: { maxUploadBytes: 1024, maxBatchFiles: 10, extensions: [".md"] } };
  const id = jobs.start({ kind: "kb-import", kb: "A", label: "a", run: async () => ({ status: "succeeded", result: { ok: 0 } }) });
  await new Promise((resolve) => setImmediate(resolve));
  const ok = await call(opts, makeReq({ method: "GET", url: `/kb/api/jobs/${id}` }));
  assert.equal(ok.res.status, 200);
  assert.equal(ok.json.job.status, "succeeded");
  assert.equal(ok.json.job.progress, null);
  const missing = await call(opts, makeReq({ method: "GET", url: "/kb/api/jobs/kb-import-nope" }));
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error.code, "JOB_NOT_FOUND");
});

test("GET /jobs 支持 kb/kind/limit 过滤", async () => {
  const jobs = createJobRegistry();
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-jobs-api2-")), "kb");
  const opts = { kbRoot, jobs, limits: { maxUploadBytes: 1024, maxBatchFiles: 10, extensions: [".md"] } };
  jobs.start({ kind: "kb-import", kb: "A", label: "a", run: async () => ({ status: "succeeded" }) });
  jobs.start({ kind: "kb-std", kb: "B", label: "b", run: async () => ({ status: "succeeded" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const byKb = await call(opts, makeReq({ method: "GET", url: "/kb/api/jobs?kb=A" }));
  assert.equal(byKb.json.jobs.length, 1);
  const byKind = await call(opts, makeReq({ method: "GET", url: "/kb/api/jobs?kind=kb-std" }));
  assert.equal(byKind.json.jobs.length, 1);
  assert.equal(byKind.json.jobs[0].kb, "B");
});
```

- [x] **Step 6.2: 运行确认失败**

Run: `node --test test/web-jobs.test.mjs`
Expected: 新增两条 FAIL（404 NOT_FOUND）。

- [x] **Step 6.3: 实现路由**

在 `lib/web/api.js` 批次路由之后加：

```js
    if (segments.length === 1 && segments[0] === "jobs" && method === "GET") {
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const limit = url.searchParams.get("limit") ?? undefined;
      const jobs = await opts.jobs.list({
        ...(url.searchParams.get("kb") ? { kb: url.searchParams.get("kb") } : {}),
        ...(url.searchParams.get("kind") ? { kind: url.searchParams.get("kind") } : {}),
        ...(limit ? { limit } : {}),
      });
      return sendJson(res, 200, { jobs });
    }

    if (segments[0] === "jobs" && segments.length === 2 && method === "GET") {
      const job = await opts.jobs.get(segments[1]);
      if (!job) throw new KbError("JOB_NOT_FOUND", 404, "任务不存在或已过期");
      return sendJson(res, 200, { job });
    }
```

- [x] **Step 6.4: 跑测试**

Run: `node --test test/web-jobs.test.mjs`
Expected: 8/8 通过。

- [x] **Step 6.5: Commit**

```bash
git add lib/web/api.js test/web-jobs.test.mjs
git commit -m "feat(web): expose workbench job status endpoints"
```

### Task 6 实现修正记录（2026-10-24，已执行）

1. `GET /jobs` 列表在 API 边界用 `listJobRow()` 去掉 `result`（保留 9 个字段），`GET /jobs/:id` 返回完整 job（含 `result`）。不要在注册表内部裁剪：Task 7 的 `lastJob.summary` 依赖 `result.counts`。
2. kb/kind/limit 原样转发给注册表（注册表负责 [1,50]/默认 20；`limit=0` 表示默认 20）。
3. 测试在 `test/web-jobs.test.mjs` 增至 18 条（含列表精确 key 集合、`result` 缺失、详情含 result、404、limit=0）。
4. 已知边界：`opts.jobs` 在 Task 8 才注入；Task 6 之后单独部署时 `/jobs` 会返回 500，Task 8 完成后恢复。

---

### Task 7: 标准检查 onProgress + 标准服务/API

**Files:**
- Modify: `lib/standards.js`（`onProgress`、`createStdImportFn`）
- Modify: `lib/index.js`（`kb_std_check` 改用 `createStdImportFn`）
- Create: `lib/web/std.js`
- Modify: `lib/web/api.js`
- Create: `test/web-std.test.mjs`

- [x] **Step 7.1: 写失败测试**

创建 `test/web-std.test.mjs`：

```js
/**
 * 标准更新：状态推导、结果裁剪、任务校验（无 cookie / 并发 / 非法 action）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { createJobRegistry } from "../lib/web/jobs.js";
import { buildStdEntries, buildStdResult, readStdStatus } from "../lib/web/std.js";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/status", headers = {}, body } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1", ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

async function setup({ configured = true, runStdCheck } = {}) {
  const kbRoot = join(await mkdtemp(join(tmpdir(), "kb-std-")), "kb");
  await createKb(kbRoot, { name: "标准" });
  const jobs = createJobRegistry();
  const opts = {
    kbRoot,
    jobs,
    limits: { maxUploadBytes: 1024, maxBatchFiles: 10, extensions: [".md"] },
    std: {
      configured,
      baseUrl: "https://example.invalid",
      cookie: configured ? "secret-cookie" : "",
      rateMs: 1,
      maxAgeDays: 7,
      importConfig: {},
      ...(runStdCheck ? { runStdCheck } : {}),
    },
  };
  return { kbRoot, opts, jobs };
}

async function waitFor(check, { attempts = 100, delay = 10 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("waitFor timeout");
}

function fakeReport() {
  return {
    totalDocs: 3,
    stdGroups: 2,
    checked: 2,
    fresh: 0,
    deferred: 0,
    updates: [{ key: "k1", number: "GB/T 111", siteNo: "GB/T 111", siteTitle: "新版", siteYear: "2024", docs: [{ year: "2015" }] }],
    draftsReleased: [],
    currents: [{ key: "k2", number: "GB/T 222", siteNo: "GB/T 222", siteTitle: "现行" }],
    notFound: [],
    newerInKb: [],
    downloaded: [{ stdNo: "GB/T 111", file: "GB_T 111.pdf", bytes: 10 }],
    downloadFailed: [],
    authOk: true,
  };
}

test("readStdStatus 推导 lastCheckAt/pending/valid 且不含 cookie", async () => {
  const kbDir = await mkdtemp(join(tmpdir(), "kb-std-cache-"));
  const now = Date.parse("2026-10-24T00:00:00.000Z");
  await writeFile(
    join(kbDir, ".std-check.json"),
    JSON.stringify({
      items: {
        k1: { status: "update", checkedAt: now - 3 * 86400000, siteNo: "GB/T 1" },
        k2: { status: "released", checkedAt: now - 2 * 86400000, siteNo: "GB/T 2" },
        k3: { status: "update", checkedAt: now - 10 * 86400000, downloadedAt: "2026-10-14T00:00:00.000Z" },
        k4: { status: "current", checkedAt: now - 9 * 86400000 },
      },
    }),
    "utf8"
  );
  const status = await readStdStatus({ kbDir, kb: "标准", configured: true, ttlDays: 7, now });
  assert.equal(status.cache.items, 4);
  assert.equal(status.pending.update, 1);
  assert.equal(status.pending.released, 1);
  assert.equal(status.pending.downloadable, 2);
  assert.equal(status.cache.valid, true);
  assert.ok(status.cache.ageDays >= 2.9);
  assert.equal(JSON.stringify(status).includes("cookie"), false);
});

test("buildStdEntries 映射状态、合并下载/导入结果并按上限截断", () => {
  const report = fakeReport();
  const imported = [{ stdNo: "GB/T 111", file: "GB_T 111.pdf", docId: "abc", title: "新版" }];
  const entries = buildStdEntries(report, imported);
  assert.equal(entries.find((e) => e.number === "GB/T 111")?.status, "imported");
  assert.equal(entries.find((e) => e.number === "GB/T 222")?.status, "current");

  const many = { ...fakeReport(), currents: Array.from({ length: 300 }, (_, i) => ({ siteNo: `GB/T ${i}`, siteTitle: "" })) };
  const result = buildStdResult({ report: many, imported: [] });
  assert.equal(result.entries.length, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.counts.currents, 300);
});

test("GET /kbs/:name/std 返回状态与 activeJobId", async () => {
  const { opts } = await setup();
  const { res, json } = await call(opts, makeReq({ method: "GET", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std" }));
  assert.equal(res.status, 200);
  assert.equal(json.kb, "标准");
  assert.equal(json.configured, true);
  assert.equal(json.activeJobId, null);
  assert.equal(json.lastJob, null);
  assert.equal(JSON.stringify(json).includes("secret-cookie"), false);
});

test("std-check 校验 action 与 cookie", async () => {
  const { opts } = await setup({
    configured: false,
    runStdCheck: async ({ onProgress }) => {
      onProgress({ phase: "check", done: 1, total: 1 });
      return { report: fakeReport(), cache: { items: {} } };
    },
  });
  const bad = await call(opts, makeReq({ method: "POST", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std-check", body: { action: "nope" } }));
  assert.equal(bad.res.status, 400);
  assert.equal(bad.json.error.code, "STD_ACTION_INVALID");

  const noCookie = await call(opts, makeReq({ method: "POST", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std-check", body: { action: "check-download" } }));
  assert.equal(noCookie.res.status, 400);
  assert.equal(noCookie.json.error.code, "STD_NO_COOKIE");

  const check = await call(opts, makeReq({ method: "POST", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std-check", body: { action: "check" } }));
  assert.equal(check.res.status, 202);
  assert.ok(check.json.jobId);
});

test("同一库已有运行中标准任务时 409；完成后结果可读", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { opts } = await setup({
    runStdCheck: async ({ onProgress }) => {
      onProgress({ phase: "check", done: 1, total: 1 });
      await gate;
      return { report: fakeReport(), cache: { items: {} } };
    },
  });
  const first = await call(opts, makeReq({ method: "POST", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std-check", body: { action: "check" } }));
  assert.equal(first.res.status, 202);
  const second = await call(opts, makeReq({ method: "POST", url: "/kb/api/kbs/%E6%A0%87%E5%87%86/std-check", body: { action: "check" } }));
  assert.equal(second.res.status, 409);
  assert.equal(second.json.error.code, "STD_JOB_RUNNING");
  release();
  const settled = await waitFor(async () => {
    const job = await opts.jobs.get(first.json.jobId);
    return job && job.status !== "running" ? job : null;
  });
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.result.counts.currents, 1);
  assert.equal(settled.result.entries.length, 2);
});
```

- [x] **Step 7.2: 运行确认失败**

Run: `node --test test/web-std.test.mjs`
Expected: FAIL（`lib/web/std.js` 不存在）。

- [x] **Step 7.3: 给 `runStdCheck` 加 `onProgress`**

`lib/standards.js`：

1. 函数签名解构加 `onProgress`：

```js
export async function runStdCheck(opts) {
  const {
    kbDir, baseUrl = DEFAULT_BASE, cookie = "", rateMs = 1200,
    maxAgeDays = 7, force = false, limit = 0, action = "check-download", dryRun = false,
    onProgress,
  } = opts;
  const emit = typeof onProgress === "function" ? onProgress : () => {};
```

2. `const { groups, totalDocs } = await collectKbStandards(kbDir);` 之后加：

```js
  emit({ phase: "collect", done: 0, total: groups.length, current: "", checked: 0 });
```

3. check 循环里两个 `done++; report.checked++;` 之后各加一次（成功与 catch 路径各一处，代码相同）：

```js
    emit({
      phase: "check",
      done,
      total: pending.length,
      current: String(g.number ?? g.key ?? ""),
      checked: report.checked,
      updates: report.updates.length,
      downloaded: report.downloaded.length,
      failed: report.downloadFailed.length,
    });
```

4. 下载阶段循环 `for (const t of targets) {` 之后加局部计数：

```js
    let downloadDone = 0;
    const downloadTotal = targets.length;
```

并在循环体末尾（`continue` 分支与正常分支都要走到）——最稳的做法是循环内每个分支结束前都执行同一个 `reportDownload()`；为降低改动面，改为在 `for` 循环体起始处先 `downloadDone += 1`，然后每个 `continue`/`break` 之前调用：

```js
    const reportDownload = () => emit({
      phase: "download",
      done: downloadDone,
      total: downloadTotal,
      current: String(it.siteNo ?? it.number ?? ""),
      downloaded: report.downloaded.length,
      failed: report.downloadFailed.length,
    });
```

实现时把 `continue;` 改为 `{ reportDownload(); continue; }`，正常下载成功后加 `reportDownload();`，`break;` 前加 `reportDownload();`。`downloadDone` 在循环体开头递增。

- [x] **Step 7.4: 在 `lib/standards.js` 增加 `createStdImportFn`**

在 `importDownloaded` 之前加入：

```js
/**
 * 构造 importDownloaded 用的导入函数：
 * 已存在的来源文件跳过；导入前上报进度（工作台任务用）。
 */
export function createStdImportFn({ kbDir, existing = new Set(), config = {}, onProgress } = {}) {
  return async (filePath, title) => {
    const fileName = basename(filePath);
    if (existing.has(fileName)) return { docId: null, skipped: true };
    existing.add(fileName);
    onProgress?.(fileName, title);
    return importFileInto(kbDir, {
      sourcePath: filePath,
      relKey: `std-download/${fileName}`,
      stableKey: true,
      title,
      config,
    });
  };
}
```

顶部 import 增加：

```js
import { importFileInto } from "./pipeline.js";
```

- [x] **Step 7.5: `kb_std_check` 改用 `createStdImportFn`**

`lib/index.js` 的 standards import 增加 `createStdImportFn`：

```js
import { runStdCheck, importDownloaded, renderStdReport, createStdImportFn } from "./standards.js";
```

把 `kb_std_check` 里的 `imported = await importDownloaded(dir, cache, async (filePath, title) => { ... }, {});` 整段替换为：

```js
        const existing = new Set(
          (manifest.docs ?? [])
            .filter((d) => !isDeleted(d))
            .map((d) => d.sourceFile ?? "")
            .filter(Boolean)
        );
        imported = await importDownloaded(
          dir,
          cache,
          createStdImportFn({
            kbDir: dir,
            existing,
            config: {
              ocrLang, ocrWorkers, ocrDpi, ocrEngine, pdfColumnReorder, ocrNativeBin, ocrPythonBin,
              ebookConvertBin, partMaxChars,
              langPath: DEFAULT_TESSDATA,
            },
          }),
          {}
        );
```

- [x] **Step 7.6: 实现 `lib/web/std.js`**

```js
/**
 * 标准更新工作台服务：状态推导、结果裁剪、任务封装。
 * 只读 .std-check.json；bzCookie 永不出现在任何返回值里。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runStdCheck, importDownloaded, createStdImportFn } from "../standards.js";
import { refreshKbIndex } from "../import-job.js";
import { readManifest, isDeleted } from "../store.js";
import { WebError } from "./http.js";

export const STD_ENTRY_LIMIT = 200;

const STATUS_ORDER = { imported: 0, downloaded: 1, update: 2, released: 3, failed: 4, notfound: 5, newer: 6, current: 7 };

export async function readStdStatus({ kbDir, kb, configured, ttlDays = 7, now = Date.now() }) {
  let cache = null;
  try {
    cache = JSON.parse(await readFile(join(kbDir, ".std-check.json"), "utf8"));
  } catch {
    cache = null;
  }
  const items = cache?.items && typeof cache.items === "object" ? cache.items : {};
  const values = Object.values(items);
  let lastCheckAt = 0;
  for (const item of values) lastCheckAt = Math.max(lastCheckAt, Number(item?.checkedAt) || 0);
  const pending = values.filter(
    (item) => (item?.status === "update" || item?.status === "released") && !item?.downloadedAt
  );
  const update = pending.filter((item) => item.status === "update").length;
  const released = pending.filter((item) => item.status === "released").length;
  const ageDays = lastCheckAt > 0 ? (now - lastCheckAt) / 86400000 : null;
  return {
    kb,
    configured: Boolean(configured),
    cache: {
      exists: cache !== null,
      items: values.length,
      lastCheckAt: lastCheckAt > 0 ? new Date(lastCheckAt).toISOString() : null,
      ageDays: ageDays === null ? null : Math.round(ageDays * 10) / 10,
      ttlDays,
      valid: ageDays !== null && ageDays <= ttlDays,
    },
    pending: { update, released, downloadable: update + released },
  };
}

function collectStdEntries(report, imported = []) {
  const importedByNo = new Map();
  for (const item of imported) {
    if (item?.docId) importedByNo.set(String(item.stdNo ?? ""), item);
  }
  const downloadedByNo = new Map((report.downloaded ?? []).map((item) => [String(item.stdNo ?? ""), item]));
  const failedByNo = new Map((report.downloadFailed ?? []).map((item) => [String(item.stdNo ?? item.aid ?? ""), item]));

  const entries = [];
  const push = (entry) => entries.push(entry);

  for (const item of report.updates ?? []) {
    const number = String(item.siteNo ?? item.number ?? "");
    const failed = failedByNo.get(number);
    const status = importedByNo.has(number)
      ? "imported"
      : failed
        ? "failed"
        : downloadedByNo.has(number)
          ? "downloaded"
          : "update";
    push({
      number,
      title: String(item.siteTitle ?? ""),
      status,
      fromYear: String(item.docs?.map((d) => d.year).filter(Boolean).sort().reverse()[0] ?? ""),
      toYear: String(item.siteYear ?? ""),
      ...(failed ? { message: String(failed.reason ?? "") } : {}),
    });
  }
  for (const item of report.draftsReleased ?? []) {
    const number = String(item.siteNo ?? item.number ?? "");
    push({
      number,
      title: String(item.siteTitle ?? ""),
      status: importedByNo.has(number) ? "imported" : downloadedByNo.has(number) ? "downloaded" : "released",
      fromYear: "草案",
      toYear: String(item.siteYear ?? ""),
    });
  }
  for (const item of report.downloadFailed ?? []) {
    push({ number: String(item.stdNo ?? ""), title: "", status: "failed", message: String(item.reason ?? "") });
  }
  for (const item of report.notFound ?? []) {
    push({ number: String(item.siteNo ?? item.number ?? ""), title: "", status: "notfound" });
  }
  for (const item of report.newerInKb ?? []) {
    push({ number: String(item.siteNo ?? item.number ?? ""), title: String(item.siteTitle ?? ""), status: "newer" });
  }
  for (const item of report.currents ?? []) {
    push({ number: String(item.siteNo ?? item.number ?? ""), title: String(item.siteTitle ?? ""), status: "current" });
  }

  entries.sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99));
  return entries;
}

/** 对外：截断后的条目列表。 */
export function buildStdEntries(report, imported = []) {
  return collectStdEntries(report, imported).slice(0, STD_ENTRY_LIMIT);
}

export function buildStdResult({ report, imported = [], importError = "", hint = "" }) {
  const all = collectStdEntries(report, imported);
  const entries = all.slice(0, STD_ENTRY_LIMIT);
  return {
    counts: {
      totalDocs: report.totalDocs ?? 0,
      stdGroups: report.stdGroups ?? 0,
      checked: report.checked ?? 0,
      fresh: report.fresh ?? 0,
      deferred: report.deferred ?? 0,
      updates: (report.updates ?? []).length,
      draftsReleased: (report.draftsReleased ?? []).length,
      currents: (report.currents ?? []).length,
      notFound: (report.notFound ?? []).length,
      newerInKb: (report.newerInKb ?? []).length,
      downloaded: (report.downloaded ?? []).length,
      downloadFailed: (report.downloadFailed ?? []).length,
      imported: imported.filter((item) => item?.docId).length,
      authOk: report.authOk ?? null,
    },
    entries,
    truncated: all.length > STD_ENTRY_LIMIT,
    hint: importError ? `${hint}导入失败：${importError}`.trim() : hint,
  };
}

export async function startStdJob({
  kb,
  kbDir,
  body,
  jobs,
  stdOpts,
  importConfig,
  runStdCheckImpl = runStdCheck,
  importDownloadedImpl = importDownloaded,
}) {
  const action =
    body?.action === "check" ? "check"
      : body?.action === "download" ? "download"
        : body?.action === "check-download" ? "check-download"
          : null;
  if (action === null) throw new WebError("STD_ACTION_INVALID", 400, "action 只能是 check / check-download / download");
  const dryRun = body?.dryRun === true;
  const wantsDownload = action !== "check" && !dryRun;
  if (wantsDownload && !stdOpts.configured) {
    throw new WebError("STD_NO_COOKIE", 400, "未配置 bzCookie，无法下载；可先只做检查");
  }
  if (await jobs.hasRunning({ kb, kind: "kb-std" })) {
    throw new WebError("STD_JOB_RUNNING", 409, "该库已有标准更新任务在运行");
  }

  const force = body?.force === true;
  const limit = Math.max(0, Math.round(Number(body?.limit) || 0));
  const jobId = jobs.start({
    kind: "kb-std",
    kb,
    label: action === "check" ? `标准检查 ${kb}` : `标准检查并下载 ${kb}`,
    run: async (job) => {
      const progress = { kind: "std", phase: "collect", done: 0, total: 0, current: "", checked: 0, updates: 0, downloaded: 0, imported: 0, failed: 0 };
      const emit = (event) => {
        Object.assign(progress, event);
        job.setProgress({ ...progress, kind: "std" });
      };
      const { report, cache } = await runStdCheckImpl({
        kbDir,
        baseUrl: stdOpts.baseUrl,
        cookie: stdOpts.cookie,
        rateMs: stdOpts.rateMs,
        maxAgeDays: stdOpts.maxAgeDays,
        force,
        limit,
        action,
        dryRun,
        onProgress: emit,
      });
      let imported = [];
      let importError = "";
      if (wantsDownload && (report.downloaded ?? []).length > 0) {
        const manifest = await readManifest(kbDir);
        const existing = new Set(
          (manifest.docs ?? []).filter((doc) => !isDeleted(doc)).map((doc) => doc.sourceFile ?? "").filter(Boolean)
        );
        const pending = Object.values(cache.items ?? {}).filter((item) => item.downloadedFile && !item.importedDocId);
        let done = 0;
        const importFile = createStdImportFn({
          kbDir,
          existing,
          config: importConfig,
          onProgress: (file, title) => {
            done += 1;
            emit({ phase: "import", done, total: pending.length, current: String(title ?? file), imported: done });
          },
        });
        try {
          imported = await importDownloadedImpl(kbDir, cache, importFile, {});
        } catch (error) {
          importError = String(error?.message ?? error);
        }
      }
      await refreshKbIndex(kbDir).catch(() => {});
      const result = buildStdResult({ report, imported, importError });
      return {
        status: "succeeded",
        detail: `检查 ${result.counts.checked} 组，更新 ${result.counts.updates}，下载 ${result.counts.downloaded}，导入 ${result.counts.imported}`,
        result,
      };
    },
  });
  return { jobId };
}
```

- [x] **Step 7.7: 在 `lib/web/api.js` 加标准路由**

import 增加：

```js
import { readStdStatus, startStdJob } from "./std.js";
```

在 `/kbs/:name/docs` 路由之前插入（注意用 `ensureKb` 校验库存在）：

```js
    if (segments[0] === "kbs" && segments.length === 3 && segments[2] === "std" && method === "GET") {
      const { name, dir } = ensureKb(opts, segments[1]);
      const status = await readStdStatus({ kbDir: dir, kb: name, configured: opts.std?.configured === true, ttlDays: opts.std?.maxAgeDays ?? 7 });
      const related = await opts.jobs.list({ kb: name, kind: "kb-std", limit: 10 });
      const active = related.find((job) => job.status === "running") ?? null;
      const last = related.find((job) => job.status !== "running") ?? null;
      return sendJson(res, 200, {
        ...status,
        activeJobId: active?.id ?? null,
        lastJob: last
          ? { id: last.id, status: last.status, finishedAt: last.finishedAt, summary: last.result?.counts ?? null }
          : null,
      });
    }

    if (segments[0] === "kbs" && segments.length === 3 && segments[2] === "std-check" && method === "POST") {
      const body = await readJsonBody(req);
      const { name, dir } = ensureKb(opts, segments[1]);
      const result = await startStdJob({
        kb: name,
        kbDir: dir,
        body,
        jobs: opts.jobs,
        stdOpts: opts.std ?? {},
        importConfig: opts.std?.importConfig ?? {},
        ...(opts.std?.runStdCheck ? { runStdCheckImpl: opts.std.runStdCheck } : {}),
      });
      return sendJson(res, 202, result);
    }
```

> `ensureKb` 已存在且返回 `{ name, dir }`。

- [x] **Step 7.8: 跑测试与既有标准测试**

Run:
```bash
node --test test/web-std.test.mjs test/worker-report.test.mjs
npm test
```
Expected: 新测试全通过；`npm test` 全绿（之前 189 + 本任务用例）。

- [x] **Step 7.9: Commit**

```bash
git add lib/standards.js lib/web/std.js lib/web/api.js lib/index.js test/web-std.test.mjs
git commit -m "feat(web): std check panel API with progress events and trimmed results"
```

### Task 7 实现修正记录（2026-10-24，已执行）

1. **并发竞态**：成功路径 `jobs.hasRunning(...)`（同步）后立刻 `jobs.start(...)`，不 await；仅 409 分支 await `jobs.list` 取 `details.jobId`。并发 POST 恰好一个 202、一个 409。
2. **结果映射**：失败草稿按 `failed` + title/message；`downloadFailed` 独立回退按 `stdNo ?? aid ?? number` 去重；新增 `importFailed` 状态与 `counts.importFailed`，并 append 到 `hint`。
3. **路径净化**：`lib/web/redact.js` 共享 `redactPaths`；std 任务前缀 `[kbDir, kbRoot, PLUGIN_ROOT, tmpdir()]`，entry message/hint/importError/detail 全部净化并截 300 字；run 体抛错先净化再抛。
4. **进度**：`createStdImportFn` 对每个文件回调 `{skipped}`；std 导入阶段 `done=processed`、`imported=processed-skipped`，并带 `processed/skipped`；skip 也不会让进度条卡住。
5. **hint**：`deferred>0` 的 limit 顺延提示 + 导入失败提示（用「；」拼接）。
6. **测试 15 条**：并发、`details.jobId`、失败更新/草稿去重、importFailed、净化、skip 进度、deferred hint、lastCheckAt 判别、参数转发、check-download 编排、activeJobId/lastJob、dryRun 绕过 cookie。
7. **已定契约**：`importDownloaded` 整体抛错 → 任务 succeeded + hint（逐文件错误才是 importFailed）；`failed`/`importFailed` 共用 STATUS_ORDER 4。

---

### Task 8: 服务装配（registerKbWeb）、配置项、`/status`

**Files:**
- Modify: `lib/index.js`（配置 schema、apply、registerKbWeb 调用）
- Modify: `lib/web/server.js`
- Modify: `test/web-server.test.mjs`（装配测试）

> **Task 8 附加约束（来自 Task 3/4/7 复审）**：
> 1. 抽一个共享的 import config 构造器，供 `lib/index.js`（工具路径）与 `lib/web/std.js` 复用，避免 OCR/langPath 三份漂移。
> 2. `lib/store.js` 的 `sweepStaging` 显式跳过 `import-tmp/ui-batches`（批次生命周期由 `sweepOldBatches` 负责，否则重启会误删失败保留批次）。
> 3. `normalizeLimits` 对 `maxUploadBytes <= 0`/`maxBatchFiles <= 0` 回退默认值，不要出现 1 字节上限。
> 4. 装配测试除 `/status`/`/jobs` 外，加一条 `GET /kbs/:name/std` 200 冒烟（防 Task 7 路由漏接 `opts.std`）。
> 5. `opts.std` 由 index.js 传入：`{configured, baseUrl, cookie, rateMs, maxAgeDays, importConfig}`（不会传 `runStdCheck`/`importDownloadedImpl` 测试 seam）。

- [x] **Step 8.1: 写失败测试**

在 `test/web-server.test.mjs` 末尾追加（该文件已 import `registerKbWeb`；若无则补）：

```js
function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; },
  };
}

function makeReq({ method = "GET", url = "/kb/api/status", headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1", ...headers },
    async *[Symbol.asyncIterator]() {},
  };
}

test("registerKbWeb 注入 jobs/limits 并注册任务清单与 dispose", async () => {
  const registered = [];
  const effects = [];
  const ctx = {
    inject(names, fn) {
      fn({
        webServer: { register(route) { registered.push(route); return () => {}; } },
        effect(fn, label) { effects.push(label); },
        get: () => undefined,
      });
    },
    subprocess: { spawn: () => { throw new Error("unused"); } },
  };
  registerKbWeb(ctx, {
    kbRoot: "/tmp/kb-unused",
    limits: { maxUploadBytes: 1024, maxBatchFiles: 2, extensions: [".md"] },
    std: { configured: false, baseUrl: "https://example.invalid", rateMs: 1, maxAgeDays: 7, importConfig: {} },
    importConfig: () => ({}),
  });

  const route = registered.find((item) => item.path === "/kb/api");
  assert.ok(route, "应注册 /kb/api 路由");

  const statusRes = makeRes();
  await route.handler(makeReq({ method: "GET", url: "/kb/api/status" }), statusRes);
  const status = JSON.parse(statusRes.body);
  assert.equal(status.features.upload, true);
  assert.equal(status.features.std, true);
  assert.equal(status.limits.maxUploadBytes, 1024);

  const jobRes = makeRes();
  await route.handler(makeReq({ method: "GET", url: "/kb/api/jobs/kb-import-nope" }), jobRes);
  assert.equal(jobRes.status, 404);
  assert.equal(JSON.parse(jobRes.body).error.code, "JOB_NOT_FOUND");

  assert.ok(effects.includes("kb-web: jobs-dispose"));
});
```

- [x] **Step 8.2: 运行确认失败**

Run: `node --test test/web-server.test.mjs`
Expected: FAIL——`/kb/api/jobs/kb-import-nope` 在未注入 `opts.jobs` 时抛 `TypeError`，返回 500；且 `effects` 里没有 `kb-web: jobs-dispose`。

- [x] **Step 8.3: 在 `lib/index.js` 增加配置并注入服务**

1. `Config` 增加：

```js
  uiMaxUploadBytes: z.number().default(2147483648).description("工作台上传单文件上限（字节，默认 2 GiB）"),
  uiMaxBatchFiles: z.number().default(1000).description("工作台上传单批次文件数上限（默认 1000）"),
```

2. `apply` 里夹取：

```js
  const uiMaxUploadBytes = Math.min(16 * 1024 ** 3, Math.max(1024 * 1024, Math.round(Number(cfg.uiMaxUploadBytes) || 2147483648)));
  const uiMaxBatchFiles = Math.min(5000, Math.max(1, Math.round(Number(cfg.uiMaxBatchFiles) || 1000)));
```

3. `apply` 里、`registerKbWeb` 调用之前定义：

```js
  const buildImportConfig = (options = {}) => ({
    ocrLang,
    ocrWorkers,
    ocrDpi,
    ocrEngine,
    pdfColumnReorder,
    autoDownloadModels,
    ocrNativeBin,
    ocrPythonBin,
    ebookConvertBin,
    partMaxChars,
    langPath: options.ocrModel === "fast" ? FAST_TESSDATA : DEFAULT_TESSDATA,
  });
```

4. `registerKbWeb` 调用改为：

```js
      registerKbWeb(ctx, {
        kbRoot,
        defaultKb,
        uiEnabled,
        version: VERSION,
        limits: { maxUploadBytes: uiMaxUploadBytes, maxBatchFiles: uiMaxBatchFiles, extensions: SUPPORTED_EXTS },
        importConfig: buildImportConfig,
        std: {
          configured: bzCookie !== "",
          baseUrl: bzBaseUrl,
          cookie: bzCookie,
          rateMs: stdRateMs,
          maxAgeDays: stdMaxAgeDays,
          importConfig: {
            ocrLang, ocrWorkers, ocrDpi, ocrEngine, pdfColumnReorder, autoDownloadModels,
            ocrNativeBin, ocrPythonBin, ebookConvertBin, partMaxChars,
            langPath: DEFAULT_TESSDATA,
          },
        },
      });
```

5. index.js 顶部 parsers 的 import 改为：

```js
import { sectionsFromMarkdown, SUPPORTED_EXTS } from "./parsers.js";
```

- [x] **Step 8.4: 改 `lib/web/server.js` 装配**

import 增加：

```js
import { createJobRegistry } from "./jobs.js";
```

`registerKbWeb` 里 `ctx.inject(["webServer"], (sctx) => {` 之后加：

```js
    const jobs = createJobRegistry();
    const runtimeOpts = {
      ...opts,
      jobs,
      spawn: (spec) => ctx.subprocess.spawn(spec),
      importConfig: opts.importConfig ?? (() => ({})),
    };
```

`handleApi` 调用改为：

```js
      handler: (req, res) => handleApi(req, res, { ctx: sctx, opts: runtimeOpts, fence }),
```

并在注册完路由后（`add({kind:"prefix", path:"/kb", ...}, "kb-web: /kb");` 之后）加：

```js
    try {
      sctx.effect?.(() => () => jobs.cancelAll(), "kb-web: jobs-dispose");
    } catch {
      /* effect 不可用时任务随进程退出 */
    }
```

- [x] **Step 8.5: 跑测试**

Run:
```bash
node --test test/web-server.test.mjs test/web-api-read.test.mjs test/web-upload-batch.test.mjs
npm test
```
Expected: 全通过。

- [x] **Step 8.6: Commit**

```bash
git add lib/index.js lib/web/server.js lib/store.js lib/web/upload.js test/web-server.test.mjs
git commit -m "feat(web): wire job registry, upload limits and std config into the workbench server"
```

### Task 8 实现修正记录（2026-10-24，已执行）

1. **配置**：`uiMaxUploadBytes`（2 GiB，1 MiB–16 GiB）、`uiMaxBatchFiles`（1000，1–5000）；`normalizeLimits` 对 `<=0/NaN/Infinity` 回退默认值。
2. **共享 import config**：`buildImportConfig` 是 `kb_import` / `kb_reparse` / `kb_std_check` 与 web upload/std 的唯一基准；工具路径只覆盖每次调用的 `ocrLang`/force 标志。`kb_std_check` 因此也开始遵守 `autoDownloadModels:false`（有意修复的漂移）。
3. **装配**：`registerKbWeb` 收到 `limits`、`importConfig`、`std {configured,baseUrl,cookie,rateMs,maxAgeDays,importConfig}`；server 每个 webServer mount 创建一个 registry、`spawn` 委托 `ctx.subprocess.spawn`、dispose 注册 `kb-web: jobs-dispose → jobs.cancelAll()`。
4. **清扫**：`sweepStaging` 跳过 `import-tmp/ui-batches`（批次生命周期归 `sweepOldBatches`，目前只在创建新批次时触发；无新上传的库会保留残留超过 24h，是已知限制）。
5. **测试 264**：装配测试（/status limits、/jobs 404、GET std configured:true + ttlDays:2、dispose 可执行）、normalizeLimits 回退、sweepStaging 父目录老化判别。

---

### Task 9: `ui/upload-core.js` 纯函数

**Files:**
- Create: `ui/upload-core.js`
- Create: `test/upload-core.test.mjs`

- [x] **Step 9.1: 写失败测试**

创建 `test/upload-core.test.mjs`：

```js
/**
 * 上传弹窗的纯函数：文件分类、相对路径、并发队列、状态标签、结果汇总。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyFiles, createQueue, formatBytes, relPathFor, statusLabel, summarizeResults } from "../ui/upload-core.js";

const LIMITS = { maxBytes: 10, maxFiles: 2, extensions: [".md", ".pdf"] };

test("relPathFor 优先 webkitRelativePath 并做 NFC 归一", () => {
  assert.equal(relPathFor({ name: "a.md" }), "a.md");
  assert.equal(relPathFor({ name: "a.md", webkitRelativePath: "资料/a.md" }), "资料/a.md");
});

test("classifyFiles 拒绝非法扩展名/超大小/超数量并给出原因", () => {
  const files = [
    { name: "a.md", size: 5 },
    { name: "b.exe", size: 5 },
    { name: "c.pdf", size: 50 },
    { name: "d.pdf", size: 5 },
  ];
  const { accepted, rejected } = classifyFiles(files, { ...LIMITS, maxFiles: 1 });
  assert.deepEqual(accepted.map((item) => item.path), ["a.md"]);
  assert.equal(rejected.length, 3);
  assert.match(rejected.find((item) => item.path === "b.exe").reason, /不支持/);
  assert.match(rejected.find((item) => item.path === "c.pdf").reason, /上限/);
  assert.match(rejected.find((item) => item.path === "d.pdf").reason, /文件数/);
});

test("createQueue 并发不超过上限且全部完成", async () => {
  const queue = createQueue(2);
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 5 }, (_, i) => queue.run(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return i;
  }));
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test("statusLabel 与 summarizeResults", () => {
  assert.equal(statusLabel("pending"), "等待");
  assert.equal(statusLabel("ok"), "成功");
  const summary = summarizeResults({ ok: 1, fail: 1, skip: 1, files: [{ status: "ok" }, { status: "failed" }, { status: "skipped" }] });
  assert.equal(summary.total, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
});

test("formatBytes 人类可读", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(2 * 1024 ** 3), "2.0 GB");
});
```

- [x] **Step 9.2: 运行确认失败**

Run: `node --test test/upload-core.test.mjs`
Expected: FAIL，`Cannot find module '../ui/upload-core.js'`。

- [x] **Step 9.3: 实现 `ui/upload-core.js`**

```js
/**
 * 上传弹窗的纯逻辑（不碰 DOM），供工作台与 node:test 共用。
 */

export function relPathFor(file) {
  const relative = String(file?.webkitRelativePath ?? "");
  if (relative !== "") return relative.normalize("NFC");
  return String(file?.name ?? "").normalize("NFC");
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function extOf(path) {
  const name = String(path ?? "").split("/").pop().toLowerCase();
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}

export function classifyFiles(entries, limits = {}) {
  const maxBytes = Number(limits.maxBytes) || 0;
  const maxFiles = Number(limits.maxFiles) || 0;
  const extensions = Array.isArray(limits.extensions) ? limits.extensions.map((ext) => ext.toLowerCase()) : [];
  const accepted = [];
  const rejected = [];

  for (const entry of entries) {
    const file = entry?.file ?? entry;
    const path = relPathFor(file);
    const size = Number(entry?.size ?? file?.size ?? 0);
    const ext = extOf(path);
    let reason = "";
    if (extensions.length > 0 && !extensions.includes(ext)) {
      reason = `不支持的文件类型（${ext || "无扩展名"}）`;
    } else if (maxBytes > 0 && size > maxBytes) {
      reason = `超过单文件上限 ${formatBytes(maxBytes)}`;
    }
    if (reason) rejected.push({ path, size, reason });
    else accepted.push({ file, path, size });
  }

  if (maxFiles > 0 && accepted.length > maxFiles) {
    for (const item of accepted.splice(maxFiles)) {
      rejected.push({ path: item.path, size: item.size, reason: `超过单批文件数上限 ${maxFiles}` });
    }
  }
  return { accepted, rejected };
}

/** 固定并发队列：download/upload 都按 FIFO 取任务。 */
export function createQueue(concurrency = 2) {
  const limit = Math.max(1, Math.round(Number(concurrency) || 1));
  let active = 0;
  const waiting = [];

  const run = (job) => {
    active += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        const next = waiting.shift();
        if (next) run(next);
      });
  };

  return {
    run(task) {
      return new Promise((resolve, reject) => {
        const job = { task, resolve, reject };
        if (active < limit) run(job);
        else waiting.push(job);
      });
    },
    get active() { return active; },
    get pending() { return waiting.length; },
  };
}

const STATUS_LABELS = {
  pending: "等待",
  uploading: "上传中",
  uploaded: "已上传",
  failed: "失败",
  rejected: "已跳过",
  ok: "成功",
  skipped: "跳过",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? "");
}

export function summarizeResults(result) {
  const files = Array.isArray(result?.files) ? result.files : [];
  const ok = Number(result?.ok) || 0;
  const fail = Number(result?.fail) || 0;
  const skip = Number(result?.skip) || 0;
  return { total: ok + fail + skip, ok, failed: fail, skipped: skip, files };
}
```

- [x] **Step 9.4: 跑测试**

Run: `node --test test/upload-core.test.mjs`
Expected: 5/5 通过。

- [x] **Step 9.5: Commit**

```bash
git add ui/upload-core.js test/upload-core.test.mjs
git commit -m "feat(ui): add pure upload helpers (validation, queue, labels)"
```

### Task 9 实现修正记录（2026-10-24，已执行）

1. **`extOf` 与服务端对齐**：先取 basename，再 `index > 0`——dotfile（`.md`/`.gitignore`）与无扩展名（`v1.2/README`）返回 `""`，点号目录不再误判；大写扩展仍小写化。
2. **测试 9 条**（计划 5 条 + 4 条补强）：真实 NFD→NFC（name 与 webkitRelativePath）、extOf 直测、classifyFiles 的 dotfile/无扩展名拒绝、createQueue 的 FIFO 启动顺序与“拒绝后继续排空”。
3. 队列计数器在 job promise settle 后的微任务里更新；测试用 mactrotask flush 后断言 `active/pending === 0`（实现未改）。

---

### Task 10: `ui/api.js` 批次/任务/标准方法 + XHR 上传

**Files:**
- Modify: `ui/api.js`
- Create: `test/ui-api.test.mjs`

- [x] **Step 10.1: 写失败测试**

创建 `test/ui-api.test.mjs`：

```js
/**
 * 工作台 API 客户端：JSON 方法映射、XHR 上传的 URL/请求头/进度/错误。
 */
import test from "node:test";
import assert from "node:assert/strict";

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  return { ok: true, status: 200, json: async () => ({ ok: true, jobId: "kb-import-1" }) };
};

class FakeXhr {
  constructor() {
    globalThis.__lastXhr = this;
    this.upload = {};
    this.headers = {};
    this.status = 200;
    this.response = { path: "a.md", size: 3 };
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  addEventListener() {}
  send(body) {
    this.body = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    setTimeout(() => this.onload?.(), 0);
  }
}
globalThis.XMLHttpRequest = FakeXhr;

const { api } = await import("../ui/api.js");

test("批次与任务方法打到正确路径", async () => {
  calls.length = 0;
  await api.createBatch({ kb: "标准", create: true });
  assert.equal(calls[0].url, "/kb/api/upload-batches");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["x-kb-ui"], "1");

  await api.job("kb-import-1");
  assert.equal(calls[1].url, "/kb/api/jobs/kb-import-1");

  await api.jobs({ kb: "标准", kind: "kb-import", limit: 1 });
  assert.match(calls[2].url, /^\/kb\/api\/jobs\?/);
  assert.match(calls[2].url, /kb=%E6%A0%87%E5%87%86/);
});

test("uploadFile 用 PUT + 编码后的 path + 进度回调", async () => {
  const progress = [];
  const result = await api.uploadFile("b-0123456789ab", { file: new Blob(["abc"]), path: "资料/a.md" }, {
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(result, { path: "a.md", size: 3 });
  const xhr = globalThis.__lastXhr;
  assert.equal(xhr.method, "PUT");
  assert.match(xhr.url, /^\/kb\/api\/upload-batches\/b-0123456789ab\/files\?path=/);
  assert.match(xhr.url, /%E8%B5%84%E6%96%99%2Fa\.md/);
  assert.equal(xhr.headers["x-kb-ui"], "1");
  assert.deepEqual(progress, [0.5]);
});

test("错误响应映射成 ApiError", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 413,
    json: async () => ({ error: { code: "UPLOAD_TOO_LARGE", message: "太大" } }),
  });
  await assert.rejects(() => api.stdStatus("标准"), (error) => {
    assert.equal(error.code, "UPLOAD_TOO_LARGE");
    assert.equal(error.status, 413);
    return true;
  });
});
```

> 注意：第三个用例替换了全局 fetch（后续不再调用 fetch），所以它必须是该文件最后一个用例（node:test 顺序执行）。fake XHR 通过构造函数把实例挂到 `globalThis.__lastXhr`，测试读它，避免在实现里留测试专用字段。

- [x] **Step 10.2: 运行确认失败**

Run: `node --test test/ui-api.test.mjs`
Expected: FAIL（`api.createBatch` 不是函数）。

- [x] **Step 10.3: 实现 `ui/api.js` 扩展**

在 `request` 之后加一个 XHR 上传函数：

```js
function uploadFile(batchId, item, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${BASE}/upload-batches/${encodeURIComponent(batchId)}/files?path=${encodeURIComponent(item.path)}`);
    xhr.setRequestHeader("x-kb-ui", "1");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.responseType = "json";
    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
      };
    }
    xhr.onload = () => {
      const payload = xhr.response ?? null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      reject(new ApiError(xhr.status, payload?.error?.code ?? "HTTP_ERROR", payload?.error?.message ?? `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, "NETWORK_ERROR", "上传失败（网络错误）"));
    xhr.onabort = () => reject(new ApiError(0, "ABORTED", "上传已取消"));
    if (signal?.aborted) {
      reject(new ApiError(0, "ABORTED", "上传已取消"));
      return;
    }
    if (signal) signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(item.file);
  });
}
```

`api` 对象追加：

```js
  createBatch: (body) => request("POST", "/upload-batches", body),
  batch: (id) => request("GET", `/upload-batches/${encodeURIComponent(id)}`),
  deleteBatch: (id) => request("DELETE", `/upload-batches/${encodeURIComponent(id)}`),
  importBatch: (id, body) => request("POST", `/upload-batches/${encodeURIComponent(id)}/import`, body),
  uploadFile,
  job: async (id) => (await request("GET", `/jobs/${encodeURIComponent(id)}`)).job,
  jobs: async (params = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    return (await request("GET", `/jobs?${query.toString()}`)).jobs;
  },
  stdStatus: (name) => request("GET", `/kbs/${encodeURIComponent(name)}/std`),
  stdCheck: (name, body) => request("POST", `/kbs/${encodeURIComponent(name)}/std-check`, body),
```

- [ ] **Step 10.4: 跑测试（用 fake XHR 挂 `globalThis.__lastXhr` 的写法）**

Run: `node --test test/ui-api.test.mjs`
Expected: 3/3 通过。

- [x] **Step 10.5: Commit**

```bash
git add ui/api.js test/ui-api.test.mjs
git commit -m "feat(ui): add upload, job and std API client methods"
```

### Task 10 实现修正记录（2026-10-24，已执行）

1. `uploadFile` 的所有 settle 路径（成功/HTTP 错/网络错/abort/预中止）统一走 `settle()`：移除共享 AbortController 上的 abort listener、清空 `onload/onerror/onabort`，`finished` 防重复 settle；预中止在 `send` 前直接 reject。
2. 客户端方法路径/封装：`job` 解包 `.job`、`jobs` 解包 `.jobs`；`stdStatus` 直返；`stdCheck` POST 带 body；其余与路由对齐。
3. 测试 8 条：路径表、上传 URL/头/进度、预中止、运行中 abort（listener 归零、handler 清空、stale onload 被吞）、网络错误、job/jobs 解包、错误映射。

---

### Task 11: 上传弹窗

**Files:**
- Create: `ui/views/upload.js`
- Modify: `ui/app.js`（入口动作、新建后立即上传）
- Modify: `ui/views/overview.js`（上传资料按钮）
- Modify: `ui/views/detail.js`（上传资料按钮）
- Modify: `ui/views/modals.js`（`openConfirmModal`）
- Modify: `ui/style.css`
- （不动 `ui/icons.js`：`icons.upload` 已存在）

> **Task 11 约束（来自 Task 5 复审）**：
> 1. 重试匹配用 `job.result.files[].path`（批次内相对路径），不要用 title/basename。
> 2. `similar` 列表必须在报告里显示（低置信相似文件照常导入了，不能静默）。
> 3. `skip > 0` 的批次会被保留但不属于 `failed`；报告里要把 skipped 行标为可重试（或明确说明“文档正在导入中，稍后重试”）。

- [ ] **Step 11.1: 写 DOM 无关的失败测试**

上传弹窗本体不便在 node 里测；把状态机里可测的一段抽到 `ui/upload-core.js`（Task 9 已含标签/队列）。本任务补一个测试保证 `escapeHtml`/状态流转的纯部分：

把 `test/upload-core.test.mjs` 顶部的 import 行改为：

```js
import { classifyFiles, createQueue, formatBytes, nextPhase, relPathFor, statusLabel, summarizeResults } from "../ui/upload-core.js";
```

在文件末尾追加：

```js
test("nextPhase 覆盖上传/导入状态机", () => {
  assert.equal(nextPhase("select", "start"), "uploading");
  assert.equal(nextPhase("uploading", "uploaded"), "starting");
  assert.equal(nextPhase("starting", "started"), "importing");
  assert.equal(nextPhase("importing", "settled"), "done");
  assert.equal(nextPhase("importing", "failed"), "error");
  assert.equal(nextPhase("uploading", "unexpected"), "uploading");
});
```

- [ ] **Step 11.2: 运行确认失败**

Run: `node --test test/upload-core.test.mjs`
Expected: FAIL，`nextPhase` 未导出。

- [ ] **Step 11.3: 在 `ui/upload-core.js` 增加 `nextPhase`**

```js
const TRANSITIONS = {
  select: { start: "uploading" },
  uploading: { uploaded: "starting" },
  starting: { started: "importing", failed: "error" },
  importing: { settled: "done", failed: "error" },
};

export function nextPhase(phase, event) {
  return TRANSITIONS[phase]?.[event] ?? phase;
}
```

- [ ] **Step 11.4: 实现 `ui/views/upload.js`**

```js
import { api, ApiError } from "../api.js";
import { classifyFiles, createQueue, formatBytes, nextPhase, relPathFor, statusLabel, summarizeResults } from "../upload-core.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

const DIRECTORY_HINT = "暂不支持拖拽文件夹，请用「选择目录」";

export function openUploadModal({ kbs = [], kb = "", onFinished } = {}) {
  const node = document.createElement("div");
  node.className = "overlay";
  node.innerHTML = `<div class="modal modal-wide" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(node);
  const modal = node.querySelector(".modal");

  const state = {
    phase: "select",
    limits: null,
    kb: kb || kbs[0]?.name || "",
    files: [],
    rejected: [],
    batchId: null,
    jobId: null,
    job: null,
    error: "",
    timer: null,
    abort: null,
    closed: false,
    importStarted: false,
  };

  const resumeKey = `kb.upload.job.${state.kb}`;
  function remember(jobId) {
    try { localStorage.setItem(resumeKey, jobId); } catch { /* 隐私模式下忽略 */ }
  }
  function forget() {
    try { localStorage.removeItem(resumeKey); } catch { /* ignore */ }
  }

  function close() {
    state.closed = true;
    stopPolling();
    state.abort?.abort();
    if (state.batchId && !state.importStarted) {
      api.deleteBatch(state.batchId).catch(() => {});
    }
    if (state.jobId && state.phase !== "done") remember(state.jobId);
    node.remove();
    onFinished?.();
  }

  function stopPolling() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function render() {
    modal.innerHTML = state.phase === "select" ? selectHtml() : progressHtml();
    bind();
  }

  function selectHtml() {
    const limits = state.limits;
    const hint = limits
      ? `单文件 ≤ ${formatBytes(limits.maxBytes)}，最多 ${limits.maxFiles} 个文件`
      : "读取上传限制中…";
    return `
      <div class="modal-form">
        <h2>上传资料</h2>
        <label class="field"><span>目标库</span>
          <select id="upload-kb" ${kb ? "disabled" : ""}>
            ${kbs.map((item) => `<option value="${escapeHtml(item.name)}" ${item.name === state.kb ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
          </select>
        </label>
        <div class="dropzone" id="upload-drop">
          <p>把文件拖到这里</p>
          <div class="dropzone-actions">
            <button type="button" class="btn" data-pick="files">选择文件</button>
            <button type="button" class="btn" data-pick="dir">选择目录</button>
          </div>
          <p class="muted">${hint}</p>
        </div>
        <div class="uplist">
          ${state.files.map((item) => `<div class="uprow"><span class="upname">${escapeHtml(item.path)}</span><span class="muted">${formatBytes(item.size)}</span></div>`).join("")}
          ${state.rejected.map((item) => `<div class="uprow rejected"><span class="upname">${escapeHtml(item.path)}</span><span class="badge warn">${escapeHtml(item.reason)}</span></div>`).join("")}
        </div>
        <div class="form-row">
          <label class="check"><input type="checkbox" id="upload-dup" /> 允许跨库重复</label>
          <label class="check"><input type="radio" name="ocr" value="best" checked /> best</label>
          <label class="check"><input type="radio" name="ocr" value="fast" /> fast</label>
        </div>
        <p class="form-error" ${state.error ? "" : "hidden"}>${escapeHtml(state.error)}</p>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>取消</button>
          <button type="button" class="btn primary" data-start ${state.files.length === 0 ? "disabled" : ""}>开始上传</button>
        </div>
      </div>`;
  }

  function progressHtml() {
    const done = state.job?.progress ?? null;
    const phaseText = {
      uploading: "上传中",
      starting: "正在启动导入",
      importing: "导入中",
      done: "导入完成",
      error: "出错",
    }[state.phase] ?? state.phase;
    const summary = state.phase === "done" ? summarizeResults(state.job?.result) : null;
    return `
      <div class="modal-form">
        <h2>${escapeHtml(phaseText)} · ${escapeHtml(state.kb)}</h2>
        ${state.error ? `<p class="form-error">${escapeHtml(state.error)}</p>` : ""}
        ${state.phase === "uploading" ? `<div class="uplist">${state.files.map((item) => `
          <div class="uprow">
            <span class="upname">${escapeHtml(item.path)}</span>
            <span class="upbar"><i style="width:${Math.round((item.percent ?? 0) * 100)}%"></i></span>
            <span class="muted">${statusLabel(item.status)}</span>
          </div>`).join("")}</div>` : ""}
        ${state.phase === "importing" && done ? `
          <div class="progress-line"><strong>${done.done ?? 0}/${done.total ?? 0}</strong>
            <span class="muted">成功 ${done.ok ?? 0} · 失败 ${done.fail ?? 0} · 跳过 ${done.skip ?? 0}</span></div>
          <p class="muted">${escapeHtml(done.current ?? "")}</p>
          <div class="uplist">${(done.files ?? []).map((item) => `
            <div class="uprow"><span class="upname">${escapeHtml(item.path)}</span><span class="muted">${statusLabel(item.status)}</span></div>`).join("")}</div>` : ""}
        ${state.phase === "done" && summary ? `
          <div class="progress-line"><strong>成功 ${summary.ok} · 失败 ${summary.failed} · 跳过 ${summary.skipped}</strong></div>
          <div class="uplist">${summary.files.map((item) => `
            <div class="uprow"><span class="upname">${escapeHtml(item.title ?? "")}</span>
              <span class="muted">${statusLabel(item.status)}${item.error ? `：${escapeHtml(item.error)}` : ""}</span></div>`).join("")}</div>
          ${state.files.some((item) => item.status === "failed") ? `<p class="form-error">${state.files.filter((item) => item.status === "failed").length} 个文件上传失败，可用「重试失败项」重新上传。</p>` : ""}
          ${(state.job?.result?.duplicates ?? []).length > 0 ? `<p class="muted">重合跳过 ${state.job.result.duplicates.length} 个：${state.job.result.duplicates.map((item) => escapeHtml(item.title)).join("、")}</p>` : ""}
        ` : ""}
        <div class="modal-actions">
          ${state.phase === "done" ? `<button type="button" class="btn" data-action="again">重试失败项</button>
            <button type="button" class="btn" data-action="view">刷新并查看资料</button>
            <button type="button" class="btn primary" data-close>关闭</button>` : ""}
          ${state.phase === "error" ? `<button type="button" class="btn" data-close>关闭</button>` : ""}
        </div>
      </div>`;
  }

  function bind() {
    modal.querySelector("[data-close]")?.addEventListener("click", close);
    modal.querySelector("#upload-kb")?.addEventListener("change", (event) => { state.kb = event.target.value; });
    modal.querySelector("[data-pick='files']")?.addEventListener("click", () => pick({ directory: false }));
    modal.querySelector("[data-pick='dir']")?.addEventListener("click", () => pick({ directory: true }));
    modal.querySelector("[data-start]")?.addEventListener("click", () => { void startUpload(); });
    modal.querySelector("[data-action='again']")?.addEventListener("click", () => retryFailed());
    modal.querySelector("[data-action='view']")?.addEventListener("click", () => { close(); window.location.hash = `#/kb/${encodeURIComponent(state.kb)}/docs`; });

    const dropzone = modal.querySelector("#upload-drop");
    if (dropzone) {
      dropzone.addEventListener("dragover", (event) => { event.preventDefault(); });
      dropzone.addEventListener("drop", (event) => {
        event.preventDefault();
        const items = Array.from(event.dataTransfer?.items ?? []);
        const hasDirectory = items.some((item) => {
          const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
          return entry?.isDirectory === true;
        });
        if (hasDirectory) {
          state.error = DIRECTORY_HINT;
          render();
          return;
        }
        addFiles(Array.from(event.dataTransfer?.files ?? []));
      });
    }
  }

  function pick({ directory }) {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    if (directory) input.webkitdirectory = true;
    input.onchange = () => {
      addFiles(Array.from(input.files ?? []));
      input.remove();
    };
    modal.appendChild(input);
    input.click();
  }

  function addFiles(files) {
    const limits = state.limits ?? { maxBytes: 0, maxFiles: 0, extensions: [] };
    const { accepted, rejected } = classifyFiles(files, limits);
    state.files.push(...accepted.map((item) => ({ ...item, status: "pending", percent: 0 })));
    state.rejected.push(...rejected);
    if (limits.maxFiles > 0 && state.files.length > limits.maxFiles) {
      const overflow = state.files.splice(limits.maxFiles);
      for (const item of overflow) state.rejected.push({ path: item.path, size: item.size, reason: `超过单批文件数上限 ${limits.maxFiles}` });
    }
    render();
  }

  async function startUpload() {
    state.error = "";
    state.phase = nextPhase(state.phase, "start");
    render();
    try {
      if (!state.batchId) {
        const created = await api.createBatch({ kb: state.kb });
        state.batchId = created.batch.id;
        state.limits = created.limits;
      }
      const allowCrossDuplicates = Boolean(modal.querySelector("#upload-dup")?.checked);
      const ocrModel = modal.querySelector("input[name='ocr']:checked")?.value ?? "best";
      const queue = createQueue(2);
      state.abort = new AbortController();
      let lastPaint = 0;
      const paintProgress = () => {
        const now = Date.now();
        if (now - lastPaint < 200) return;
        lastPaint = now;
        render();
      };
      await Promise.all(state.files.map((item) => queue.run(async () => {
        if (state.closed) return;
        if (item.status === "uploaded") return;
        item.status = "uploading";
        render();
        try {
          await api.uploadFile(state.batchId, { file: item.file, path: item.path }, {
            onProgress: (value) => { item.percent = value; paintProgress(); },
            signal: state.abort?.signal,
          });
          item.status = "uploaded";
          item.percent = 1;
        } catch (error) {
          item.status = "failed";
          item.error = error instanceof ApiError ? error.message : String(error?.message ?? error);
        }
        render();
      })));
      if (state.closed) return;
      const failedUploads = state.files.filter((item) => item.status !== "uploaded");
      if (failedUploads.length === state.files.length) {
        state.phase = "error";
        state.error = "全部文件上传失败";
        render();
        return;
      }
      state.phase = nextPhase(state.phase, "uploaded");
      render();
      state.importStarted = true;
      const imported = await api.importBatch(state.batchId, { allowCrossDuplicates, ocrModel });
      if (!imported.jobId) {
        state.phase = "done";
        state.job = { result: { ok: 0, fail: 0, skip: 0, files: [], duplicates: imported.duplicates ?? [] } };
        render();
        return;
      }
      state.jobId = imported.jobId;
      remember(state.jobId);
      state.phase = nextPhase(state.phase, "started");
      render();
      void pollJob();
    } catch (error) {
      state.phase = "error";
      state.error = error instanceof ApiError ? error.message : String(error?.message ?? error);
      render();
    }
  }

  async function pollJob() {
    stopPolling();
    try {
      const job = await api.job(state.jobId);
      state.job = job;
      if (job.status === "running") {
        state.timer = setTimeout(() => { void pollJob(); }, 1000);
        render();
      } else if (job.status === "failed") {
        state.phase = nextPhase(state.phase, "failed");
        state.error = job.detail || "导入任务失败";
        forget();
        render();
        onFinished?.();
      } else {
        state.phase = nextPhase(state.phase, "settled");
        forget();
        render();
        onFinished?.();
      }
    } catch (error) {
      state.phase = "error";
      state.error = error instanceof ApiError ? error.message : String(error?.message ?? error);
      render();
    }
  }

  function retryFailed() {
    const importFailed = new Set(
      (state.job?.result?.files ?? []).filter((item) => item.status === "failed").map((item) => String(item.path ?? ""))
    );
    const failed = state.files.filter((item) => item.status === "failed" || importFailed.has(item.path));
    if (failed.length === 0) {
      state.error = "没有可重试的失败文件";
      render();
      return;
    }
    stopPolling();
    state.batchId = null;
    state.jobId = null;
    state.job = null;
    state.phase = "select";
    state.abort = null;
    state.closed = false;
    state.importStarted = false;
    state.files = failed.map((item) => ({ ...item, status: "pending", percent: 0, error: "" }));
    state.rejected = [];
    render();
  }

  api.status().then((status) => {
    const limits = status.limits ?? null;
    state.limits = limits
      ? { maxBytes: limits.maxUploadBytes ?? 0, maxFiles: limits.maxBatchFiles ?? 0, extensions: limits.extensions ?? [] }
      : null;
    render();
  }).catch(() => {
    state.limits = { maxBytes: 0, maxFiles: 1000, extensions: [] };
    render();
  });

  node.addEventListener("mousedown", (event) => {
    if (event.target === node && state.phase === "select") close();
  });
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.phase === "select") close();
  });

  // 页面刷新/重开后恢复最近一次导入任务（结果保留 1 小时）
  let resumeId = null;
  try { resumeId = localStorage.getItem(resumeKey); } catch { resumeId = null; }
  if (resumeId) {
    api.job(resumeId).then((job) => {
      state.jobId = job.id;
      state.job = job;
      state.phase = job.status === "running" ? "importing" : job.status === "failed" ? "error" : "done";
      state.error = job.status === "failed" ? (job.detail || "导入任务失败") : "";
      if (job.status === "running") pollJob();
      else forget();
      render();
    }).catch(() => { forget(); });
  }
  render();
}
```

> 实现要点：拖拽只接受文件（`showDirectoryPicker` 不做）；`state.abort` 在关闭弹窗时中止上传；关闭时若批次处于 `open` 会 `DELETE` 丢弃批次，已启动导入的任务不取消（下次打开用 localStorage 里的 jobId 恢复进度）。

- [ ] **Step 11.5: 在 `ui/app.js` 接入口**

import 增加：

```js
import { openUploadModal } from "./views/upload.js";
```

`bind()` 里加分支：

```js
    } else if (action === "upload") {
      if (state.kbs.length === 0) { showToast("还没有知识库，先新建一个"); return; }
      openUploadModal({
        kbs: state.kbs,
        kb: target.dataset.kb ?? "",
        onFinished: async () => { await loadKbs(); },
      });
```

`create-kb` 分支的 `onCreated` 改为：

```js
        onCreated: async (name) => {
          await loadKbs();
          window.location.hash = hrefForKb(name);
          openUploadModal({ kbs: state.kbs, kb: name, onFinished: async () => { await loadKbs(); } });
        },
```

- [ ] **Step 11.6: 在总览与库详情加入口**

`ui/views/overview.js` 的 `overview-head` 里的 `filters` 之前插入：

```html
        <div class="head-actions">
          <button class="btn" data-action="upload">上传资料</button>
        </div>
```

`ui/views/detail.js` 的 `detail-actions` 里、归档按钮之前插入：

```html
          <button class="btn primary" data-action="upload" data-kb="${escapeAttr(kb.name)}">${icons.upload}<span>上传资料</span></button>
```

（`icons` 已在 renderDetail 的 ctx 里，核对传入。）

- [ ] **Step 11.7: 补 `ui/style.css`**

```css
.head-actions { display: flex; gap: 8px; }
.modal.modal-wide { width: min(720px, 92vw); }
.dropzone { border: 1px dashed var(--line); border-radius: var(--radius); padding: 18px; text-align: center; display: grid; gap: 8px; }
.dropzone-actions { display: flex; gap: 8px; justify-content: center; }
.uplist { display: grid; gap: 4px; max-height: 260px; overflow: auto; margin-top: 10px; }
.uprow { display: grid; grid-template-columns: minmax(0, 1fr) 120px 90px; gap: 10px; align-items: center; font-size: 13px; }
.upname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.upbar { display: block; height: 6px; background: var(--panel-2); border-radius: 999px; overflow: hidden; }
.upbar i { display: block; height: 100%; background: var(--accent); }
.uprow.rejected { color: var(--danger); }
.progress-line { display: flex; gap: 10px; align-items: baseline; margin: 10px 0 4px; }
.form-row { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
.check { display: inline-flex; gap: 6px; align-items: center; }
```

- [ ] **Step 11.8: 跑测试 + 手工冒烟**

Run:
```bash
node --test test/upload-core.test.mjs
npm test
```
Expected: 全通过。然后在 DSH 桌面端 `Cmd+R` 后打开工作台，手工验收（见 Task 14）。

- [ ] **Step 11.9: Commit**

```bash
git add ui/views/upload.js ui/app.js ui/views/overview.js ui/views/detail.js ui/views/modals.js ui/style.css test/upload-core.test.mjs
git commit -m "feat(ui): add upload modal with per-file progress, retry and job recovery"
```

---

### Task 12: 标准更新面板

**Files:**
- Create: `ui/views/std.js`
- Modify: `ui/views/detail.js`（tab）
- Modify: `ui/views/overview.js`（标准更新入口）
- Modify: `ui/views/modals.js`（`openConfirmModal`、`openKbPickerModal`）
- Modify: `ui/app.js`（`state.std`、加载、动作、轮询清理）
- Modify: `ui/style.css`

- [ ] **Step 12.1: 写失败测试（渲染纯函数）**

`ui/views/std.js` 的 `renderStdPanel` 依赖 DOM-free 字符串拼接，可在 node 里测。创建 `test/std-view.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { renderStdPanel } from "../ui/views/std.js";

const status = {
  kb: "标准",
  configured: true,
  cache: { exists: true, items: 10, lastCheckAt: "2026-10-24T00:00:00.000Z", ageDays: 1.2, ttlDays: 7, valid: true },
  pending: { update: 2, released: 1, downloadable: 3 },
  activeJobId: null,
  lastJob: null,
};

test("标准面板显示缓存/待下载/按钮状态", () => {
  const html = renderStdPanel({ std: { kb: "标准", loading: false, error: "", status, job: null } }, "标准", { escapeHtml: (v) => String(v) });
  assert.match(html, /已配置/);
  assert.match(html, /有新版 2/);
  assert.match(html, /草案转正 1/);
  assert.match(html, /data-action="std-run"/);
  assert.match(html, /data-action="std-download"/);
});

test("未配置 cookie 时下载按钮禁用", () => {
  const html = renderStdPanel(
    { std: { kb: "标准", loading: false, error: "", status: { ...status, configured: false }, job: null } },
    "标准",
    { escapeHtml: (v) => String(v) }
  );
  assert.match(html, /data-action="std-download"[^>]*disabled/);
  assert.match(html, /bzCookie/);
});
```

- [ ] **Step 12.2: 运行确认失败**

Run: `node --test test/std-view.test.mjs`
Expected: FAIL（`ui/views/std.js` 不存在）。

- [ ] **Step 12.3: 实现 `ui/views/std.js`**

```js
/** 标准更新面板：纯渲染 + 动作分发（轮询由 app.js 的 state.std.timer 管理）。 */

const STATUS_LABELS = {
  imported: "导入成功",
  downloaded: "下载成功",
  update: "有新版",
  released: "草案转正",
  failed: "失败",
  importFailed: "导入失败",
  notfound: "未找到",
  newer: "库内已有更新",
  current: "已是最新",
};

export function stdStatusLabel(status, message = "") {
  if (status !== "failed") return STATUS_LABELS[status] ?? status;
  if (/金币/.test(message)) return "金币不足";
  if (/认证|登录|cookie/i.test(message)) return "认证失败";
  return "下载失败";
}

export function renderStdPanel(state, kb, { escapeHtml }) {
  const std = state.std ?? { loading: true };
  if (std.loading && !std.status) return `<div class="state">加载中…</div>`;
  if (std.error) return `<div class="state error">${escapeHtml(std.error)}<button class="btn" data-action="std-reload">重试</button></div>`;
  const status = std.status ?? {};
  const cache = status.cache ?? {};
  const pending = status.pending ?? {};
  const running = status.activeJobId != null || std.job?.status === "running";
  const job = std.job ?? null;
  const progress = job?.progress;
  const result = job?.result;
  return `
    <section class="std-panel">
      <div class="panel">
        <h3>更新状态</h3>
        <div class="kv"><span>登录状态</span><strong>${status.configured ? "已配置" : "未配置（在 profile 的 cordis.patch.yml 填 bzCookie）"}</strong></div>
        <div class="kv"><span>上次检查</span><strong>${cache.lastCheckAt ? escapeHtml(new Date(cache.lastCheckAt).toLocaleString("zh-CN")) : "从未检查"}</strong></div>
        <div class="kv"><span>缓存</span><strong>${cache.exists ? `${cache.items} 条 · ${cache.ageDays ?? "?"} 天前 · ${cache.valid ? "有效" : "已过期"}` : "无缓存"}</strong></div>
        <div class="kv"><span>待下载</span><strong>有新版 ${pending.update ?? 0} · 草案转正 ${pending.released ?? 0}</strong></div>
      </div>
      <div class="panel wide">
        <h3>运行</h3>
        <div class="form-row">
          <button class="btn" data-action="std-run" data-mode="check" ${running ? "disabled" : ""}>仅检查</button>
          <button class="btn primary" data-action="std-download" data-mode="check-download" ${running || !status.configured ? "disabled" : ""}>检查并下载</button>
          <button class="btn" data-action="std-download" data-mode="download" ${running || !status.configured || (pending.downloadable ?? 0) === 0 ? "disabled" : ""}>补下载</button>
          <label class="check"><input type="checkbox" id="std-force" /> 强制全查</label>
          <label class="check">本轮上限 <input id="std-limit" type="number" min="0" step="1" value="0" style="width:70px" /></label>
        </div>
        ${running ? `<div class="progress-line"><strong>${escapeHtml(progress?.phase ?? "准备中")}</strong>
          <span class="muted">${progress?.done ?? 0}/${progress?.total ?? 0} · ${escapeHtml(progress?.current ?? "")}</span></div>` : ""}
        ${std.error ? `<p class="form-error">${escapeHtml(std.error)}</p>` : ""}
        ${result ? stdResultHtml(result, { escapeHtml }) : ""}
        ${status.lastJob && !result ? `<p class="muted">上次任务：${escapeHtml(status.lastJob.status)} · ${escapeHtml(status.lastJob.finishedAt ?? "")}</p>` : ""}
      </div>
    </section>`;
}

function stdResultHtml(result, { escapeHtml }) {
  const counts = result.counts ?? {};
  const entries = result.entries ?? [];
  return `
    <div class="progress-line">
      <strong>检查 ${counts.checked ?? 0} 组 · 更新 ${counts.updates ?? 0} · 下载 ${counts.downloaded ?? 0} · 导入 ${counts.imported ?? 0} · 失败 ${counts.downloadFailed ?? 0}</strong>
    </div>
    ${counts.authOk === false ? `<p class="form-error">登录态失效：请更新 bzCookie 后重试。</p>` : ""}
    ${entries.length === 0 ? `<p class="muted">没有结果</p>` : `
      <table class="table">
        <thead><tr><th>标准号</th><th>标题</th><th>状态</th><th>说明</th></tr></thead>
        <tbody>
          ${entries.map((entry) => `<tr>
            <td>${escapeHtml(entry.number)}</td>
            <td>${escapeHtml(entry.title ?? "")}</td>
            <td>${escapeHtml(stdStatusLabel(entry.status, entry.message))}</td>
            <td class="muted">${escapeHtml(entry.message ?? (entry.fromYear ? `${entry.fromYear} → ${entry.toYear}` : ""))}</td>
          </tr>`).join("")}
        </tbody>
      </table>`}
    ${result.truncated ? `<p class="muted">仅显示前 200 条；完整报告用 kb_std_check 查看。</p>` : ""}
    ${result.hint ? `<p class="muted">${escapeHtml(result.hint)}</p>` : ""}`;
}
```

- [ ] **Step 12.4: `ui/views/modals.js` 增加确认框与库选择框**

```js
export function openConfirmModal({ title, body, confirmText = "确认", requireCheckbox = false, onConfirm }) {
  const node = overlay(`
    <form class="modal-form">
      <h2>${escapeHtml(title)}</h2>
      <p class="muted">${escapeHtml(body)}</p>
      ${requireCheckbox ? `<label class="check"><input type="checkbox" name="ack" /> 我已知晓</label>` : ""}
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn primary">${escapeHtml(confirmText)}</button>
      </div>
    </form>
  `);
  const form = node.querySelector("form");
  const error = node.querySelector(".form-error");
  form.onsubmit = (event) => {
    event.preventDefault();
    if (requireCheckbox && !form.querySelector("[name=ack]")?.checked) {
      error.textContent = "请先勾选「我已知晓」";
      error.hidden = false;
      return;
    }
    node.remove();
    onConfirm?.();
  };
}

export function openKbPickerModal({ kbs, onPick }) {
  const node = overlay(`
    <div class="modal-form">
      <h2>选择知识库</h2>
      <div class="uplist">
        ${kbs.map((kb) => `<button type="button" class="btn" data-kb="${escapeAttr(kb.name)}">${escapeHtml(kb.name)} <span class="muted">${kb.docs.ready + kb.docs.importing + kb.docs.failed} 篇</span></button>`).join("")}
      </div>
      <div class="modal-actions"><button type="button" class="btn" data-close>取消</button></div>
    </div>
  `);
  node.querySelectorAll("[data-kb]").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.dataset.kb;
      node.remove();
      onPick?.(name);
    });
  });
}
```

- [ ] **Step 12.5: `ui/views/detail.js` 增加 tab 与面板**

顶部 import：

```js
import { renderStdPanel } from "./std.js";
```

`tabs` 部分在「日志」之后加：

```js
        ${tabLink(kb.name, "std", "标准更新", tab)}
```

tab 内容区加：

```js
      ${tab === "std" ? renderStdPanel(state, kb.name, { escapeHtml }) : ""}
```

> `escapeHtml` 是本文件已有的局部函数，直接传。

- [ ] **Step 12.6: `ui/views/overview.js` 加「标准更新」入口**

`head-actions` 里加：

```html
          <button class="btn" data-action="std-open">标准更新</button>
```

- [ ] **Step 12.7: `ui/app.js` 接 state.std 与动作**

1. import 改为：

```js
import { openConfirmModal, openCreateModal, openDocModal, openKbPickerModal, openRestoreModal } from "./views/modals.js";
```

2. `state` 加：

```js
  std: { kb: "", loading: false, error: "", status: null, job: null, timer: null },
```

3. 加函数：

```js
async function loadStd(name) {
  const sameKb = state.std.kb === name && state.std.status;
  state.std = {
    ...state.std,
    kb: name,
    loading: true,
    error: "",
    ...(sameKb ? {} : { status: null, job: null }),
  };
  render();
  try {
    const status = await api.stdStatus(name);
    state.std.status = status;
    if (status.activeJobId) {
      state.std.job = await api.job(status.activeJobId);
      pollStd(name);
    } else if (status.lastJob) {
      state.std.job = await api.job(status.lastJob.id).catch(() => null);
    }
  } catch (error) {
    state.std.error = error instanceof ApiError ? error.message : String(error?.message ?? error);
  } finally {
    state.std.loading = false;
    render();
  }
}

function clearStdTimer() {
  if (state.std.timer) clearTimeout(state.std.timer);
  state.std.timer = null;
}

async function pollStd(name) {
  clearStdTimer();
  try {
    const job = state.std.job;
    if (!job || job.status !== "running") return;
    const next = await api.job(job.id);
    state.std.job = next;
    render();
    if (next.status === "running") {
      state.std.timer = setTimeout(() => { void pollStd(name); }, 1000);
    } else {
      await loadKbs();
      const status = await api.stdStatus(name);
      state.std.status = status;
      render();
    }
  } catch {
    /* 轮询失败下一轮再试 */
  }
}

async function startStd(mode) {
  const name = state.std.kb;
  const force = Boolean(app.querySelector("#std-force")?.checked);
  const limit = Math.max(0, Number(app.querySelector("#std-limit")?.value) || 0);
  try {
    const result = await api.stdCheck(name, { action: mode, force, limit });
    state.std.job = await api.job(result.jobId);
    pollStd(name);
  } catch (error) {
    state.std.error = error instanceof ApiError ? error.message : String(error?.message ?? error);
    render();
  }
}
```

4. `loadDetail` 里加载 std：把

```js
    const detail = await api.kb(name);
    state.detail = detail;
```

改为

```js
    const detail = await api.kb(name);
    state.detail = detail;
    if (tab === "std") {
      await loadStd(name);
    }
```

> `loadStd` 自己会 render；它发生在 `finally { state.detailLoading = false; render(); }` 之前，所以先显示面板加载态、detail 加载完成后再补上概览数据，不会死循环。

5. `render()` 的 detail 分支已是 `renderDetail(state, current, ...)`，它内部会读 `state.std`。

6. `bind()` 增加：

```js
    } else if (action === "std-open") {
      if (state.kbs.length === 0) { showToast("还没有知识库，先新建一个"); return; }
      openKbPickerModal({
        kbs: state.kbs,
        onPick: (name) => { window.location.hash = hrefForKb(name, "std"); },
      });
    } else if (action === "std-reload") {
      const current = route();
      await loadStd(current.name);
    } else if (action === "std-run") {
      await startStd(target.dataset.mode ?? "check");
    } else if (action === "std-download") {
      const mode = target.dataset.mode ?? "check-download";
      const limitText = app.querySelector("#std-limit")?.value ?? "0";
      openConfirmModal({
        title: mode === "download" ? "补下载更新" : "检查并下载更新",
        body: `每个标准约 6 金币（VIP 免金币），本轮最多 ${Number(limitText) > 0 ? `${limitText} 个` : "不限"}；下载会消耗金币。`,
        confirmText: "开始下载",
        requireCheckbox: true,
        onConfirm: () => { void startStd(mode); },
      });
    }
```

7. `window.addEventListener("hashchange")` 回调和 `boot()` 里加 `clearStdTimer()`（离开 std tab 时停轮询）：

```js
  window.addEventListener("hashchange", () => {
    clearStdTimer();
    ...
  });
```

- [ ] **Step 12.8: 补样式**

```css
.std-panel { display: grid; gap: 14px; }
.std-panel .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; }
.std-panel .panel.wide { grid-column: 1 / -1; }
```

（若 `panel`/`panel-grid` 已有样式，复用即可，别重复定义冲突选择器。）

- [ ] **Step 12.9: 跑测试**

Run:
```bash
node --test test/std-view.test.mjs test/ui-router.test.mjs
npm test
```
Expected: 全通过。

- [ ] **Step 12.10: Commit**

```bash
git add ui/views/std.js ui/views/detail.js ui/views/overview.js ui/views/modals.js ui/app.js ui/style.css test/std-view.test.mjs
git commit -m "feat(ui): add std update panel with coin confirmation and job polling"
```

---

### Task 13: 版本号、README、文档同步

**Files:**
- Modify: `package.json`、`package-lock.json`（用 npm 命令）
- Modify: `lib/version.js`
- Modify: `README.md`
- Copy: spec/plan 到插件仓库 `docs/`

- [ ] **Step 13.1: 升版本**

Run:
```bash
npm version 0.20.0 --no-git-tag-version
```
Expected: `package.json` 与 `package-lock.json` 的 `version` 都是 `0.20.0`。

- [ ] **Step 13.2: 改 `lib/version.js`**

```js
export const VERSION = "0.20.0";
```

- [ ] **Step 13.3: README 配置表加两行**

在 `importTimeoutMs` 之后加：

```markdown
| `uiMaxUploadBytes` | `2147483648`（2 GiB） | 工作台上传单文件上限（字节，1 MiB–16 GiB） |
| `uiMaxBatchFiles` | `1000` | 工作台上传单批次文件数上限（1–5000） |
```

- [ ] **Step 13.4: README 工作台章节补功能说明**

在 `/kb/` 工作台说明段落之后加：

```markdown
工作台支持直接在浏览器里上传资料：选文件/选目录/拖拽文件 → 逐个上传（并发 2）→ 后台导入，逐文件进度与报告可见，失败可重试；批次临时目录在导入成功后删除、失败保留 24 小时供排查。

「标准更新」面板（库详情 tab）：读取 `.std-check.json` 的检查时间、缓存有效期与待下载数；支持仅检查 / 检查并下载 / 补下载 / 强制全查 / 本轮上限；下载前必须勾选金币确认；`bzCookie` 只在状态里显示“已配置/未配置”，不会回传。
```

- [ ] **Step 13.5: 同步文档**

Run:
```bash
cp /Users/littlesun/workspace/deepseek/project/知识库/docs/superpowers/specs/2026-10-24-kb-workbench-slice2a-design.md docs/specs/
mkdir -p docs/plans
cp /Users/littlesun/workspace/deepseek/project/知识库/docs/superpowers/plans/2026-10-24-kb-workbench-slice2a.md docs/plans/
```

> 两份文件必须与 workspace 的 `docs/superpowers/{specs,plans}/` 内容一致；提交前用 `diff` 核对。

- [ ] **Step 13.6: 跑全套**

Run:
```bash
npm test && npm run typecheck && npm run check:client
```
Expected: 全绿。

- [ ] **Step 13.7: Commit**

```bash
git add package.json package-lock.json lib/version.js README.md docs
git commit -m "chore: bump to 0.20.0 and document workbench upload/std"
```

---

### Task 14: 手工验收与验收记录

**Files:**
- Modify: `docs/specs/2026-10-24-kb-workbench-slice2a-design.md`（追加验收记录）与 plan 副本

- [ ] **Step 14.1: 启动 / 重启 DSH 并确认工作台可用**

Run（在桌面端）：
```bash
curl -s http://127.0.0.1:51565/kb/api/status
```
Expected: `200`，`version: "0.20.0"`，`features.upload === true`、`features.std === true`，`limits` 合理。桌面端 `Cmd+R` 后侧栏「知识库」→ 弹窗 → `/kb/?embed=1` 正常。

- [ ] **Step 14.2: 上传验收（临时库）**

在建临时库 `kb-test-slice2` 后手工执行：

1. 上传 3 个文件（含 1 个嵌套目录）+ 1 个 `.exe`（应被客户端拒绝并显示原因）。
2. 观察逐文件上传进度 → 自动开始导入 → 逐文件状态与当前文件名。
3. 导入完成后确认：库统计刷新、资料页出现新文档、文档弹窗能下载原件。
4. 同名文件再传一次 → 文档版本 +1（在资料页/`kb_list` 验证）。
5. 构造 1 个损坏 `.docx` 制造失败 → 批次目录保留、`batch.json.status === "failed"`、报告显示失败原因。
6. 关闭弹窗后重新打开 → 直接恢复到该任务进度/结果（若任务还在 1 小时内）。
7. 页面刷新 → 重新打开上传弹窗仍能恢复。

- [ ] **Step 14.3: 标准面板验收（不花金币）**

在「标准」库的「标准更新」tab：

1. 显示登录状态、上次检查、缓存、待下载数。
2. 点「仅检查」，`limit` 填 `2`，确认任务运行、阶段与计数更新、结果表出现。
3. 点「检查并下载」→ 确认框出现，未勾选时无法确认；**不勾选**，取消。
4. 若 `bzCookie` 未配置：下载类按钮禁用且提示配置位置。
5. 任务完成后结果在 1 小时内可回看（切走再切回）。

- [ ] **Step 14.4: 组装验收记录**

把结果追加到 spec 末尾：

```markdown
## 15. 2A 验收记录（2026-10-24）

- [x] `/kb/api/status` 0.20.0、features.upload/std = true
- [x] 上传 3 文件 + 嵌套目录 + 非法扩展名拒绝；逐文件进度；导入报告；原件可下载
- [x] 同名再上传 → 版本 +1
- [x] 损坏文件 → 批次保留、status=failed、失败原因可见
- [x] 弹窗重开/页面刷新 → 任务恢复
- [x] 标准面板：仅检查（limit=2）→ 结果表；下载确认框需勾选；未配置 cookie 时按钮禁用
- [x] `npm test`（全部通过 / 0 fail）、`npm run typecheck`、`npm run check:client`
```

- [ ] **Step 14.5: Commit**

```bash
git add docs
git commit -m "docs: record Slice 2A manual acceptance"
```

---

### Task 15: 合并回 main

- [ ] **Step 15.1: 全量验证**

Run:
```bash
npm test && npm run typecheck && npm run check:client
git log --oneline feat/kb-upload-std ^main
```
Expected: 全绿；提交列表与计划任务一一对应。

- [ ] **Step 15.2: 合并**

Run:
```bash
git checkout main
git merge --ff-only feat/kb-upload-std
```
Expected: fast-forward 成功。（若 main 有新提交，用 `git rebase main` 后再合并，不要产生 merge commit。）

- [ ] **Step 15.3: 安装到本机**

Run（插件目录就是 profile 引用的已安装目录，不需要重装；服务端代码在 DSH 重启后生效）：
```bash
cd /Users/littlesun/.dsh/plugins/dsh-knowledge-base
git status --short
git log --oneline -1
```
Expected: 工作区干净；HEAD 是合并后的提交。然后在 DSH 桌面端退出并重开（或按 DSH 的插件重载方式），访问 `http://127.0.0.1:51565/kb/api/status` 确认 `0.20.0`；不要改 profile 里的 `name` 别名。

---

## 验证清单（每个任务结束前跑一遍）

```bash
node --test test/import-job.test.mjs   # 换成当前任务对应的测试文件
npm test
npm run typecheck
npm run check:client
```

## 风险与注意事项

1. **不要动 `package.json` 的 name**：必须保持 `dsh-knowledge-wiki`，profile loader entry 名与之绑定。
2. **上传流式落盘**：不要用 `readJsonBody` 或 `Buffer.concat` 收文件；超过上限必须及时销毁写流并删除临时文件。
3. **路径校验双重**：`validateRelPath` + `resolve` 前缀校验，缺一不可；`findBatchKbDir` 只认 `b-` + 12 hex。
4. **批次状态机**：`open → importing → done/failed`；`done` 删目录、`failed` 保留；`import` 只能从 `open` 进入。
5. **进度文件是附属产物**：写失败不能让导入失败；读失败回退上一次已知进度。
6. **标准任务串行**：同库只允许一个 `kb-std` 任务；`bzCookie` 不进任何响应/日志/错误消息。
7. **旧测试不改断言**：`kb_import`/`kb_std_check` 的行为与文案必须保持不变（`kb-import-background`、`worker-report` 是护栏）。
8. **UI 全量重渲染**：`state.std` 更新后调用 `render()`；上传弹窗自己管 DOM，不要在工作台上传过程中调用 `render()`。
9. **同源/CSRF**：所有新写接口自动走现有 `requireUiHeader` + `assertSameOrigin`；XHR 必须带 `x-kb-ui: 1`。
10. **磁盘**：成功批次立即删；失败批次 24h 清扫；`import-tmp/std-download` 保留现状。

## 与 spec 的偏差记录（实现时如发生，写回 spec）

- 无。若实现中发现 `conversation.*`/宿主 API 无关的约束变化，只更新本计划的“风险”与 spec 的偏差章节，不要静默扩大范围。
