# 知识库工作台 Slice 2A 设计：上传与导入任务 + 标准更新面板

> 状态：已确认（2026-10-24）。依据：`2026-10-23-kb-workbench-design.md`（M1）的 5.6 / 5.7 / 6 / 7.6 / 7.7，以及 `2026-10-24-kb-workbench-slice2-brief.md`。
> 范围：Slice 2 的第一半（2A）。2B（范围 / 胶囊 / 工具硬约束）不在本文，交接见 §14。
> 目标版本：`0.20.0`。基线：`main` @ `3aa7e5e`，`npm test` 186/186。

## 1. 背景与目标

Slice 1 让工作台具备了库管理、资料浏览与原件下载；Slice 1.5 让 DSH 侧栏能打开工作台。但**往知识库里放资料仍然只能靠模型调用 `kb_import`**，标准更新也只能靠 `kb_std_check`。2A 把这两件高频管理操作搬到工作台：

1. 浏览器里选文件/目录 → 逐个上传 → 后台导入 → 逐文件进度与报告 → 失败重试。
2. 标准库的更新检查：看缓存与待下载状态 → 仅检查 / 检查并下载 / 补下载 → 金币确认 → 结果表。

两条链路都是**长任务**，因此 2A 必须同时建立工作台自己的任务机制（进度、轮询、结果保留、页面刷新恢复），这也是 2B 不需要再碰的基础设施。

## 2. 范围与非目标

**做**

- 上传批次 API（创建、上传、查询、丢弃、启动导入）。
- 工作台上传弹窗：多文件、选目录、拖拽文件、客户端校验、并发 2、逐文件进度、导入进度、报告、失败重试。
- 插件内任务注册表 + `GET /kb/api/jobs/:id` 与列表接口；任务结果保留 1 小时。
- worker 进度文件（原子写、逐文件状态）。
- 标准状态读取接口 + 标准检查后台任务（`onProgress`）+ 库详情「标准更新」面板 + 金币确认弹窗。
- 从 `startImportJob` 抽出可复用的 worker 启动内核（行为不变）。
- 2 个配置项、README、版本号 0.20.0。

**不做**

- 合并向导（M1 5.5）、范围 `.scopes.json`、胶囊、`kb_*` 工具范围硬约束（2B）。
- 标准定时器 / 自动下载 / 后台静默检查。
- 服务端 staging 重试（失败重试在客户端重传）。
- 拖拽文件夹递归、资料列表按更新时间排序、任务取消接口。
- `bzCookie` 的 UI 配置入口（仍写 profile 配置）。

## 3. 已确认决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | Slice 2 拆成 2A / 2B，本轮只做 2A | 2B 依赖未验证的宿主 slot 与会话 API；2A 可独立验收 |
| 2 | 工作台任务用**插件内注册表**，不复用宿主 `jobs` | `dsh-jobs` 归属 agent 会话（README：归属限定在 agent 会话内，无 controller 的 agent 无法启动）；HTTP 请求没有会话归属，也不该出现在模型侧 `job_list` |
| 3 | `startImportJob` 抽出启动内核，工具路径仍注册宿主 `jobs` | 进度文件、报告归一化、清理逻辑只维护一份；对外行为不变 |
| 4 | 上传弹窗支持多选 + 选目录 + 拖拽文件，不做拖拽文件夹递归 | 目录递归需 `webkitGetAsEntry` 遍历，浏览器差异大；「选择目录」已覆盖批量整理 |
| 5 | 标准面板放库详情「标准更新」tab，总览加选择库后跳转的快捷入口 | 不新增顶层路由/页面；标准检查本来就是库级操作 |
| 6 | 失败重试 = 客户端用内存里的失败文件开新批次重传 | 不引入批次状态回滚与部分重导入的状态机；staging 仍保留用于排查 |
| 7 | 任务结果保留 1 小时，不落盘 | M1 7.7 的要求；重启后 worker 子进程也不存在，落盘无收益 |

**与 M1 spec 的偏差**（明确记录，避免后续被当成漏项）

1. 不做顶层 `#/std/<name>` 路由；入口改为库详情 tab + 总览快捷入口。
2. 「authOk 上次结果」只来自当前进程 1 小时内完成的标准任务，不新增持久文件；无任务时只显示 `configured`。
3. 「查看新资料（按更新时间排序）」不做；导入完成在弹窗内直接给逐文件结果，另给「刷新并查看资料」跳到资料 tab（沿用按标题排序）。
4. 上传批次位于目标库目录下；库在上传中途被归档/重命名属于未定义行为（与工具路径一致），不在 2A 增加防护。

## 4. 架构

### 4.1 模块

```text
lib/import-job.js        （新）prepareImportArgs / createImportWorkerRunner
lib/web/jobs.js          （新）任务注册表
lib/web/upload.js        （新）批次存储、原始 body 落盘、路径与限额校验、24h 清扫、批次导入封装
lib/web/std.js           （新）标准状态读取、标准任务封装、结果裁剪
lib/standards.js         （改）runStdCheck 增加可选 onProgress（不改变默认行为）
worker/import-worker.mjs （改）可选 progressFile：每完成一个文件原子写 progress.json
lib/web/api.js           （改）新增路由，只做分发与错误映射
lib/web/http.js          （改）新增 readRawToFile（流式落盘 + 上限）
lib/web/server.js        （改）registerKbWeb 构造服务并注入 handleApi；dispose 时 cancelAll
lib/index.js             （改）startImportJob 委托 lib/import-job.js；新增 2 个配置项
```

### 4.2 依赖注入

`handleApi(req, res, { opts, fence })` 的 `opts` 扩展为显式依赖：

```js
{
  kbRoot, defaultKb,
  limits: { maxUploadBytes, maxBatchFiles, extensions },
  jobs,                    // createJobRegistry() 实例
  spawn,                   // (spec) => ctx.subprocess.spawn(spec)
  std: { configured, baseUrl, rateMs, maxAgeDays, timeoutMs, importConfig },
  stdService,              // createStdService(...)，测试可注入假任务体
}
```

- 生产：`registerKbWeb(ctx, opts)` 里构造 `jobs`、`spawn = ctx.subprocess.spawn`、`stdService`，再传给 `handleApi`。
- 测试：直接用 `handleApi`，传假 `spawn`（写 progress/report 后退出）与真注册表，不需要 HTTP 服务。
- `uiEnabled === false` 时整条链路不注册（现状不变）。

### 4.3 与工具路径的关系

```js
// lib/import-job.js
export async function prepareImportArgs({ dir, kbRoot, kb, files, config, reportFile, progressFile })
  -> argsFile
export function createImportWorkerRunner({ spawn, dir, argsFile, reportFile, fileCount, kb, verb })
  -> { run(): { cancel, done, readOutput } }
```

- `startImportJob`（工具路径）：`jobs.start({ kind, label, owner, run: createImportWorkerRunner(...) })`，返回 `{ jobId }`。**行为与文案不变**，`kb-import-background` / `worker-report` 测试不改断言。
- 工作台路径：同一 runner，由 `lib/web/upload.js` 包装成注册表任务，额外传 `progressFile`，并在 `onSettle` 里终结批次（改状态、清理目录）。
- runner 的 `done` 结果新增可选字段 `report`（worker 原始逐文件报告）；工具路径忽略它，工作台用它填 `job.result.files`。

### 4.4 任务注册表

```js
createJobRegistry({ retentionMs = 3600_000, maxJobs = 200, now = Date.now })
  .start({ kind, kb, label, run, onSettle? }) -> jobId   // 立即执行 run()
  .get(id) -> job | null                                  // 合并 progressFile
  .list({ kb, kind, limit }) -> job[]
  .cancelAll()                                            // 终止所有运行中任务的子进程
```

- `jobId = "<kind>-<base36 计数>-<4 hex>"`，如 `kb-import-3-9f2a`；进程内唯一。
- 状态：`running → succeeded | failed`。逐文件部分失败仍是 `succeeded`（`result.fail > 0` 由 UI 表达），进程级崩溃才 `failed`。
- `progress`：import 每次 `get/list` 读 `progressFile`（小文件，best-effort）；std 由 `onProgress` 更新内存。
- 保留：`start/get/list` 时淘汰已结算超过 1 小时的任务；总数超 `maxJobs` 时淘汰最旧的已结算任务。
- 插件 dispose：`ctx.effect(() => () => jobs.cancelAll())`，避免孤儿 worker。
- **响应净化**：`progressFile`、`batchDir`、绝对路径只存在于任务对象内部；序列化给客户端前统一走 `toPublicJob()`。

## 5. 数据模型

### 5.1 上传批次

```text
<kb>/import-tmp/ui-batches/<batchId>/
  batch.json
  progress.json
  <relativePath>...
```

`batchId = "b-" + 12 hex`（校验 `^b-[0-9a-f]{12}$`）。

`batch.json`：

```json
{
  "version": 1,
  "batchId": "b-3f9a1c2b7e40",
  "kb": "标准",
  "createdAt": "2026-10-24T01:00:00.000Z",
  "updatedAt": "2026-10-24T01:02:00.000Z",
  "status": "open | importing | done | failed",
  "files": [ { "path": "电气资料/GB∕T 1234.pdf", "size": 1234567 } ]
}
```

- 原子写：先写 `batch.json.tmp` 再 `rename` 覆盖（Windows 上 rename 覆盖不可靠时先 `rm`，与 `store.js` 现有做法一致）；同一批次内的更新走进程内串行队列（上传并发 2 不会丢文件条目）。
- 覆盖同名文件时先 `rm` 再 `rename`（Windows 兼容），文件数不变。
- `status` 迁移：`open → importing`（启动导入）→ `done`（结算且 `fail===0`）或 `failed`（结算但有失败 / 进程级失败）。
  - `done`：**立即删除整个批次目录**（文件已拷入 `sources/`），任务结果只存在于注册表的 `job.result`。
  - `failed`：保留目录与 `progress.json` 供排查，24 小时清扫兜底。
  - 「客户端并发 2」只是浏览器侧限流，服务端接受任意并发 PUT（批次内更新靠串行队列保证一致）。

### 5.2 进度文件

```json
{
  "done": 2, "total": 5, "ok": 2, "fail": 0, "skip": 0,
  "current": "电气资料/3.pdf",
  "files": [
    { "path": "电气资料/1.pdf", "status": "ok" },
    { "path": "电气资料/2.pdf", "status": "failed", "error": "…" },
    { "path": "电气资料/4.pdf", "status": "pending" }
  ],
  "updatedAt": "2026-10-24T01:03:00.000Z"
}
```

- 字段是 M1 7.4 的 `{done,total,ok,fail,skip,current}` 之上加 `files[]`：否则「逐文件状态」只能等任务结束才有。
- 启动导入时由服务端写一次初始进度（查重后保留的文件，全部 `pending`）；worker 启动后再写一次，每完成一个文件写一次；`error` 截断 200 字；`path` 一律批次内相对路径。
- 原子写：先写 `progress.json.tmp` 再 `rename` 覆盖（Windows 上先 `rm`），读方读不到时回退到上一次已知进度，不报错。

### 5.3 任务对象

```json
{
  "id": "kb-import-3-9f2a",
  "kind": "kb-import | kb-std",
  "kb": "标准",
  "label": "导入 标准: 5 个文件",
  "status": "running",
  "detail": "",
  "startedAt": "…",
  "finishedAt": null,
  "progress": { "kind": "import", "done": 2, "total": 5, "ok": 2, "fail": 0, "skip": 0, "current": "…", "files": [ … ] },
  "result": null
}
```

`result` 按 kind：

- import：`{ fileCount, ok, fail, skip, files: [{ title, status, error? }], duplicates: [{ kb, title, reason }], similar: [{ kb, title }] }`。
- std：见 5.4。

### 5.4 标准状态与结果

`GET /kb/api/kbs/:name/std` 的 `cache` 从 `.std-check.json` 只读推导：

```json
{
  "kb": "标准",
  "configured": true,
  "cache": { "exists": true, "items": 1240, "lastCheckAt": "…", "ageDays": 3.2, "ttlDays": 7, "valid": true },
  "pending": { "update": 2, "released": 1, "downloadable": 3 },
  "activeJobId": null,
  "lastJob": { "id": "kb-std-…", "status": "succeeded", "finishedAt": "…", "summary": { "updates": 2, "downloaded": 1, "imported": 1, "failed": 0 } }
}
```

- `lastCheckAt = max(items[].checkedAt)`；`items = Object.keys(cache.items).length`。
- `pending.update/released`：`status` 匹配且无 `downloadedAt`；`downloadable = update + released`。
- 任何响应（含错误）都不含 cookie 值。

`job.result`（std，裁剪后）：

```json
{
  "counts": { "totalDocs": 0, "stdGroups": 0, "checked": 0, "fresh": 0, "deferred": 0,
              "updates": 0, "draftsReleased": 0, "currents": 0, "notFound": 0, "newerInKb": 0,
              "downloaded": 0, "downloadFailed": 0, "imported": 0, "authOk": null },
  "entries": [ { "number": "GB/T 1234", "title": "…", "status": "current | update | released | downloaded | imported | failed | notfound | newer",
                 "fromYear": "2015", "toYear": "2024", "message": "" } ],
  "truncated": false,
  "hint": ""
}
```

- `entries` 上限 200 条（`currents` 可能有 900+ 条），按「有变化 → 失败 → 未找到 → 已是最新」排序后截断，`truncated` 标记。
- `failed` 保留站点原文到 `message`；UI 映射「认证失败 / 金币不足 / 下载失败」。
- `hint` 复用工具路径的提示：`limit` 顺延未查完、`bzCookie` 缺失等。
- 已下载未导入的条目会在下次任务重新走导入（`importDownloaded` 的 `importedDocId` 只存在内存，2A 不改变这个现状）。

## 6. HTTP API

全部挂在现有 `/kb/api` 前缀下；所有非 GET 请求沿用 `x-kb-ui: 1` + 同源校验 + 信任围栏。

### 6.1 上传批次

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/upload-batches` | `{kb, create?}` | 201 `{batch, limits}` |
| PUT | `/upload-batches/:id/files?path=<rel>` | raw body | 200 `{path, size}` |
| GET | `/upload-batches/:id` | — | 200 `{batch, limits}` |
| DELETE | `/upload-batches/:id` | — | 200 `{ok: true}` |
| POST | `/upload-batches/:id/import` | `{allowCrossDuplicates?, ocrModel?}` | 202 `{jobId, files, duplicates, similar}` 或 200 `{jobId: null, status: "empty", duplicates, similar}` |

**batch 投影**：`{id, kb, status, createdAt, updatedAt, files: [{path,size}], limits: {maxBytes,maxFiles,extensions}}`。

**创建**：`kb` 经 `sanitizeKbName`；不存在时，`create === true` 才 `createKb`（空简介），否则 404。`create === true` 且库已存在按现有库处理（幂等，不报 `KB_EXISTS`）。创建前清扫该库 `ui-batches/` 下超过 24 小时的批次（best-effort）。

**DELETE**：仅 `status === "open"` 可丢弃（删整个批次目录）；`importing`/`done`/`failed` → 409 `BATCH_LOCKED`。

**PUT 校验顺序**

1. 批次存在（404 `BATCH_NOT_FOUND`）、`status === "open"`（409 `BATCH_LOCKED`）、id 合法（400 `BATCH_INVALID`）。
2. `path` 合法（`UPLOAD_PATH_INVALID` 400）：非空、≤400 字符、NFC、`/` 分隔、无 `\`、无控制字符、无绝对路径/盘符、无 `.`/`..` 段；`resolve(batchDir, rel)` 必须以 `batchDir + sep` 开头。
3. 扩展名在 `SUPPORTED_EXTS` 内（415 `UNSUPPORTED_TYPE`，`details.extensions` 返回白名单）。
4. 文件数 `batch.files.length + 1 <= maxBatchFiles`（413 `BATCH_TOO_MANY_FILES`）。
5. 流式写 `<batchDir>/.upload-<hex>.part`；累计超 `maxUploadBytes` 立刻停止读取、删除临时文件、413 `UPLOAD_TOO_LARGE`（`details.maxBytes`）。
6. `mkdir -p` 父目录 → 覆盖前 `rm` → `rename` → 更新 `batch.json`（串行队列）。

**import 流程**

1. 批次存在、`open`、`files.length > 0`（否则 400 `BATCH_EMPTY`）。
2. 构造 worker 输入：

```js
{
  sourcePath: join(batchDir, rel),        // 绝对路径，仅服务端
  relKey: rel.normalize("NFC"),           // 保留大小写；docId 由 docIdFor 内部 NFC+小写归一
  title: basename(rel, extname(rel)),
  sourceFile: rel.normalize("NFC"),       // 保留原始大小写，用于展示
  storedSourcePath: "",
}
```

> 已核对：`docIdFor` 内部已做 `\\→/`、NFC、小写归一（`lib/store.js:57`），因此此处无需再小写；`storedSourcePath: ""` 不影响原件保留——`commitDoc` 用 `sourcePath` 把文件拷进 `sources/`（`lib/pipeline.js:356` / `lib/store.js:462`）。

3. `scanDuplicates({ root, targetKb, files, allowCrossKb: allowCrossDuplicates })`：同库重合跳过；跨库重合默认跳过；仅标题前缀相似照常导入并回报 `similar`。
4. 若 `kept.length === 0`：返回 `{jobId: null, status: "empty", duplicates, similar}`，批次保持 `open`。
5. 写初始 `progress.json`，`batch.status = "importing"`，`jobs.start(...)`；`onSettle` 里：`fail === 0` → 删批次目录；否则保留并写 `status = "failed"`（进程级失败同样）。
6. 成功返回 202 `{jobId, files: kept.length, duplicates, similar}`。

### 6.2 任务

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/jobs/:id` | 200 `{job}` / 404 `JOB_NOT_FOUND` |
| GET | `/jobs?kb=&kind=&limit=20` | 200 `{jobs:[…]}`（新的在前，`limit` 夹取 1–50） |

- `job.progress`：import 合并 progress 文件；std 用内存。
- 结算后 `result` 可读，最长 1 小时。

### 6.3 标准更新

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/kbs/:name/std` | — | 200 标准状态（5.4） |
| POST | `/kbs/:name/std-check` | `{action, force?, limit?, dryRun?}` | 202 `{jobId}` |

- `name` 不存在 → 404 `KB_NOT_FOUND`。
- `action` 不合法 → 400 `STD_ACTION_INVALID`。
- 下载类 action（`check-download`/`download`）且未配置 cookie 且非 `dryRun` → 400 `STD_NO_COOKIE`。
- 同库已有 running 的 `kb-std` 任务 → 409 `STD_JOB_RUNNING`（`details.jobId`）。
- 任务体：`runStdCheck({ kbDir, baseUrl, cookie, rateMs, maxAgeDays, force, limit, action, dryRun, onProgress })`；下载类且非 dryRun 时接 `importDownloaded(dir, cache, importFn, config)`，`importFn` 内每篇上报一次进度；结束后 best-effort `refreshIndexIfStale`，与 worker 导入路径一致。
- `onProgress(event)` 事件：`{phase: "collect"|"check"|"download"|"import", done, total, current, checked, updates, downloaded, imported, failed}`。`runStdCheck` 内埋点：collect 开始、check 每完成一组、download 每成功/失败一条；`import` 阶段由 web 层包住 `importFile` 上报。

### 6.4 status

`GET /kb/api/status` 的 `features` 变为 `{ui:true, upload:true, std:true, jobs:true, merge:false, scope:false}`，并新增：

```json
{ "limits": { "maxUploadBytes": 2147483648, "maxBatchFiles": 1000, "extensions": [".docx", "…"] } }
```

## 7. 前端设计

工作台前端保持「无构建、浏览器直接加载」（`ui/index.html` + ESM），不引入依赖。

### 7.1 文件

```text
ui/views/upload.js   （新）上传弹窗：选择、XHR 上传、导入轮询、报告、重试
ui/views/std.js      （新）标准面板：renderStdPanel(state, kb, ctx) + handleStdAction(...)
ui/upload-core.js    （新）纯函数：classifyFiles / relPathFor / createQueue / statusLabel / summarizeResults
ui/api.js            （改）startBatch/putFile/getBatch/deleteBatch/importBatch/job/jobs/stdStatus/stdCheck
ui/app.js            （改）state.std、入口动作、路由切换时的加载与轮询清理
ui/views/detail.js   （改）新增「标准更新」tab
ui/views/overview.js （改）头部「上传资料」「标准更新」入口
ui/views/modals.js   （改）新增 openConfirmModal（可要求勾选）
ui/style.css         （改）dropzone / 文件行 / 进度条 / 标准表格与状态徽标
ui/icons.js          （改）upload / refresh / check / alert 图标
```

`ui/upload-core.js` 不碰 DOM，供 `node:test` 直接覆盖：文件分类与拒绝原因、`webkitRelativePath` 取值、并发 2 的队列、状态标签、结果汇总。

### 7.2 入口

- 总览头部：`上传资料`（弹窗内可选库）、`标准更新`（先弹小选择框选库 → `#/kb/<name>/std`；无库时提示先新建）。
- 库详情头部：`上传资料`（库固定）。
- 库详情 tab：`标准更新`（所有库都有——检查本身是库级操作）。
- 新建库成功后：自动打开上传弹窗（目标=新库），覆盖 M1 的「新建后立即上传」。

### 7.3 上传弹窗

状态机：

```text
select → uploading(并发 2) → starting → importing(1s 轮询) → done | error
```

- **select**
  - 目标库下拉（从入口带入时锁定）；`选择文件`（multiple）、`选择目录`（`webkitdirectory`）、拖拽区（只收文件；拖到文件夹时提示「请用选择目录」）。
  - 客户端校验（`limits` 来自 `GET /api/status`，失败时降级为只做服务端校验）：扩展名、单文件大小、文件数；被拒文件单独列出原因，不阻塞其他文件。
  - 选项：`允许跨库重复`（默认关）、OCR 模型 `best`（默认）/`fast`。
  - 提示：「单文件 ≤ X，最多 N 个文件」。
- **uploading**
  - 每文件一行：名称、大小、进度条（`xhr.upload.onprogress`）、状态；整体计数与总字节。
  - 上传失败的文件标记失败并继续；全部结束后自动 `POST import`。
- **importing**
  - 总进度条 + `done/total · 成功/失败/跳过` + 当前文件名；逐文件状态取 `job.progress.files[]`。
  - 轮询 1 秒；`document.hidden` 时暂停（`visibilitychange` 恢复立即拉一次）。
- **done**
  - 逐文件结果表（含失败原因）、重复清单（库名 + 标题 + 原因）、低置信相似提示；`truncated` 时折叠提示。
  - 按钮：`重试失败项`（用内存里的失败 `File` 对象 → 新批次重传 → 新导入任务）、`刷新并查看资料`（`loadKbs()` + 跳 `#/kb/<name>/docs`）、`关闭`。
- **error**：错误码 + 文案；批次保留时可重新发起。
- **关闭行为**
  - 上传中：中止进行中的 XHR，`DELETE /upload-batches/:id` 丢弃批次。
  - 导入中：不取消任务；写 `localStorage["kb.upload.job.<kb>"] = jobId`；下次打开弹窗时用 `GET /jobs?kb=<kb>&kind=kb-import&limit=1` 恢复横幅「上次导入仍在进行/已完成」。
  - Esc 只在非运行态关闭。
- 所有库名/文件名走 `escapeHtml`；同一弹窗内不重渲染外层页面，避免打断上传。

### 7.4 标准面板

- **摘要**：登录状态徽标（已配置/未配置；未配置时给 profile `cordis.patch.yml` 填 `bzCookie` 的指引）、上次检查时间、缓存（`ageDays`/`ttlDays`，有效/已过期）、待下载（有新版 N / 草案转正 M）、可补下载 N。
- **控件**：`仅检查`、`检查并下载`、`补下载`（`pending.downloadable === 0` 时禁用）、`强制全查`复选框、`本轮上限`数字（0=不限）、`开始`。
- **确认弹窗**（下载类动作）：文案「每个标准约 6 金币（VIP 免金币），本轮最多 N 个；下载会消耗金币。」+ 必须勾选「我已知晓」才能确认。
- **运行中**：阶段标签（收集/检查/下载/导入）+ `done/total` + 当前标准号；1 秒轮询；已有 running 任务时按钮禁用。
- **结果**：摘要行 + 表格（标准号 / 标题 / 状态 / 说明）；状态映射 `current→已是最新`、`update→有新版`、`released→草案转正`、`downloaded→下载成功`、`imported→导入成功`、`failed→认证失败/金币不足/下载失败`、`notfound→未找到`、`newer→库内已有更新`；`authOk === false` 时顶部横幅；`truncated` 时提示完整报告用 `kb_std_check`。
- **完成后**：刷新库统计（`loadKbs()`）并重新拉 `GET std` 更新缓存/待下载摘要。
- **生命周期**：`state.std = { kb, loading, error, status, job, timer }`；进入 `std` tab 时加载；路由变化/离开时 `clearTimeout`；`window.visibilitychange` 暂停/恢复轮询。

## 8. 安全

- **信任围栏**：沿用 `isTrustedApiRequest`（loopback + `webRuntime.trustedHosts`）。
- **CSRF**：所有非 GET 需要 `x-kb-ui: 1` 且 `Origin`/`Sec-Fetch-Site` 同源；上传 PUT 同样适用。
- **路径**：`path` 逐段校验 + `resolve` 前缀校验；批次 id 正则；`sanitizeKbName` 处理库名；最终路径必须落在 `<kb>/import-tmp/ui-batches/<batchId>/` 内。
- **上传内容**：扩展名白名单；流式落盘；超限即断；不执行、不解析上传内容（解析发生在 worker 里，与工具路径同一套 parsers）。
- **信息暴露**：响应里只有批次内相对路径；`progressFile`、`batchDir`、绝对路径、`bzCookie` 永不出现；错误消息不回显磁盘绝对路径（沿用 `mapError`）。
- **资源**：单批次 1 个导入任务；单库 1 个标准任务；批次目录 24 小时清理；任务对象最多 200 条、已结算保留 1 小时。
- **CSP/头**：不变（`nosniff`、`SAMEORIGIN`、现有 CSP）。XHR 同源不受 CSP 限制。

## 9. 错误码

| code | HTTP | 场景 |
|---|---|---|
| `BATCH_NOT_FOUND` | 404 | 批次不存在 |
| `BATCH_INVALID` | 400 | 批次 id 非法 |
| `BATCH_LOCKED` | 409 | 批次不在 `open` 状态 |
| `BATCH_EMPTY` | 400 | 导入时批次没有文件 |
| `UPLOAD_PATH_INVALID` | 400 | `path` 非法 |
| `UPLOAD_TOO_LARGE` | 413 | 单文件超 `uiMaxUploadBytes` |
| `BATCH_TOO_MANY_FILES` | 413 | 超 `uiMaxBatchFiles` |
| `UNSUPPORTED_TYPE` | 415 | 扩展名不在白名单 |
| `JOB_NOT_FOUND` | 404 | 任务不存在/已过期 |
| `STD_ACTION_INVALID` | 400 | action 不合法 |
| `STD_NO_COOKIE` | 400 | 未配置 bzCookie 却要下载 |
| `STD_JOB_RUNNING` | 409 | 同库标准任务进行中 |
| `FORBIDDEN` | 403 | 围栏/`x-kb-ui`/跨源 |

沿用 `KB_NOT_FOUND` / `KB_EXISTS` / `KB_NAME_INVALID`；`mapError` 增加上述映射。

## 10. 配置

| 键 | 默认 | 夹取 | 说明 |
|---|---|---|---|
| `uiMaxUploadBytes` | `2147483648`（2 GiB） | 1 MiB–16 GiB | 单文件上限 |
| `uiMaxBatchFiles` | `1000` | 1–5000 | 单批次文件数上限 |

`extensions` 直接取 `SUPPORTED_EXTS`，不单独配置。

## 11. 测试计划

### 11.1 自动化（`node:test`，目标新增约 30 个用例）

| 文件 | 覆盖 |
|---|---|
| `test/web-upload-batch.test.mjs` | 创建（404 / `create:true`）、嵌套路径落盘、`..`/绝对路径/反斜杠/控制字符/非法扩展名/超限/超文件数拒绝、锁定 409、DELETE、24h 清扫 |
| `test/web-upload-import.test.mjs` | 假 spawn 写 progress/report：成功删批次、部分失败保留、全重复 `jobId:null` 且批次仍 `open`、进程崩溃 `failed`、重复 import 409 |
| `test/web-jobs.test.mjs` | start/settle/get/list 顺序与过滤、1h 保留裁剪、`maxJobs` 淘汰、progress 合并、`toPublicJob` 不含内部路径、`cancelAll` |
| `test/worker-progress.test.mjs` | 真 worker + `progressFile`：原子写无残留临时文件、`done/ok/files[]` 正确、失败文件带 `error` |
| `test/import-job.test.mjs` | `prepareImportArgs` 透传 `progressFile`、runner 的 done/cancel/报告兜底与 args 清理 |
| `test/web-std.test.mjs` | `readStdStatus` 计数与 TTL、无 cookie 泄露、action 校验、无 cookie 下载 400、并发 409、`buildStdEntries` 状态映射与 200 条截断、`onProgress` 阶段序列（注入假 `runStdCheck`） |
| `test/upload-core.test.mjs` | 文件分类/拒绝原因、相对路径、并发队列、状态标签、结果汇总 |
| `test/web-api-read.test.mjs`（扩展） | `/status` 的 `features` 与 `limits`、新路由缺 `x-kb-ui`/跨源 403 |

### 11.2 手动/浏览器验收

- 临时库 `kb-test-slice2`（真实 `kbRoot` 下，验完归档）：上传 5 个文件（含嵌套目录、1 个非法扩展名、1 个故意失败文件）→ 逐文件进度 → 部分失败保留批次 → 重试失败项。
- 同名再上传 → 文档版本 +1（原位更新）；不同目录同名 → 不互相覆盖。
- 页面刷新后从「上传资料」恢复最近任务。
- 标准面板（真实 `标准` 库）：`仅检查` 不下载；`强制全查` 配小 `limit`；下载确认框只到勾选为止，不实际确认；未配置 cookie 时下载按钮禁用。
- DSH 桌面端：`Cmd+R` 后侧栏入口 → 弹窗 → `/kb/?embed=1` 下上传与标准面板正常。
- `npm test`、`npm run typecheck`、`npm run check:client` 全绿。

## 12. 验收标准

1. 工作台上传多文件/整目录到指定库，逐文件上传进度可见；上传完成自动开始导入，进度与逐文件状态（等待/导入中/成功/失败/跳过）可见。
2. 导入完成后显示逐文件报告与统计，库统计刷新；原件可从资料页下载。
3. 目录上传保留相对路径；同一文件再次上传为原位更新（版本 +1）；不同路径的同名文件不互相覆盖。
4. 非法扩展名、超限、路径穿越在客户端与服务端都被拒绝且不中断批次；跨库重复默认跳过并在报告中列出，开关打开后照常导入。
5. 导入进程级失败时任务标记 `failed`、批次目录保留、错误可见；24 小时后清理；成功批次立即删除。
6. 标准面板能读到缓存与待下载状态，`仅检查`/`检查并下载`/`补下载`/`强制全查`/`本轮上限` 生效；未配置 `bzCookie` 时下载类动作被拒（400 且 UI 禁用）；金币确认必须勾选才能发起。
7. 标准任务结果表状态正确，结果 1 小时内可回看，任何响应不返回 cookie。
8. 所有变更接口缺 `x-kb-ui` 或跨源时 403；上传文件不被执行；响应不含绝对路径。
9. `npm test` 旧 186 全绿 + 新增用例全绿；`typecheck`、`check:client` 通过；README 记录新配置与工作台新能力。
10. 版本号 `0.20.0`；本 spec 与实施计划各留一份在 `docs/`。

## 13. 实施顺序（计划再细化）

1. `lib/import-job.js` 抽取 + 工具路径回归（不改行为）。
2. worker progressFile + 进度测试。
3. `lib/web/jobs.js` 注册表 + 测试。
4. `lib/web/upload.js` + `readRawToFile` + 批次 API + 测试。
5. 导入 API（查重、锁定、settle 清理）+ 测试。
6. `lib/standards.js` `onProgress` + `lib/web/std.js` + 标准 API + 测试。
7. `ui/upload-core.js` + 测试。
8. `ui/views/upload.js` + api.js + app.js 接线 + 浏览器验收。
9. `ui/views/std.js` + detail/overview 入口 + 浏览器验收。
10. 配置、README、版本号、`/status`、全套回归与手工验收。

## 14. 2B 交接（不在本切片实现）

实现 2B 前先做宿主 spike，结论写回 spec：

1. `conversation.input.left` slot 是否真实存在、props 是否带 `sessionId`（当前只在一个客户端 bundle 里见过字符串；`conversation.session.header.utilities` 有 open-in-app / schedule 在用，是退路）。
2. `agent/session-start` 事件是否存在、`ctx.systemPrompt.section` 的 `text` 能否按会话动态求值（当前插件只注册静态段）。
3. 父会话 id 在会话元数据里的字段名（`session.meta.parentSession` 待验证）。
4. 工具矩阵逐项接入的公共入口：现有 21 个 `kb_*` 工具各自解析 `kb`，需要一个共享的 `resolveScopeKb`/`assertInScope`，避免 21 处散改。

2B 的 `.scopes.json`、API（`GET/PUT /kb/api/scope`）、胶囊 UI、`KB_OUT_OF_SCOPE` 语义按 M1 6.1–6.6 执行；本切片预留的 `/status.features.scope=false` 在 2B 打开。
