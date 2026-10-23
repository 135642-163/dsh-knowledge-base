# 知识库工作台 Slice 2 启动 Brief

> 用途：新对话的交接材料，不是设计/计划。  
> 当前版本：`dsh-knowledge-wiki` 0.19.1  
> 当前基线：`d9e10f4 fix(ui): hide standalone navigation controls in embed mode`，`npm test` 186/186

## 1. 已完成状态

- Slice 1：manifest v5、库级简介/标签、新建/重命名/归档/回收站恢复、`/kb/` 工作台、只读/写 API、资料分页、文档弹窗、原件下载。
- Slice 1.5：DSH 侧栏原生「知识库」入口；点击在 DSH 内打开弹窗（iframe `/kb/?embed=1`），×/Esc/遮罩关闭；入口激活底色、字体/高度与 DSH 侧栏按钮一致。
- 客户端构建链：`src/client/index.tsx` + `scripts/build-client.mjs`（esbuild）+ 提交产物 `lib/client.js`；`npm test` 前置 `check:client`。
- 当前安装/profile 的关键约定：
  - package name 为 `dsh-knowledge-wiki`；DSH 0.2.x 要求 profile loader entry 名与 package name 一致。
  - 桌面端窗口是 `dsh-app://app`，不是 HTTP；客户端 bundle id 从 `__DSH_BOOT__.entries` 选择。
  - `/kb/` 服务端路由：`exact /kb`、`prefix /kb/api`、`prefix /kb`。
  - 工作台在弹窗中通过 iframe 加载，`X-Frame-Options: SAMEORIGIN` 同源可用。

## 2. Slice 2 的目标范围（来自 M1 设计 spec）

M1 spec：`docs/superpowers/specs/2026-10-23-kb-workbench-design.md` 的 5.6 / 5.7 / 6 / 7.6 / 7.7 / 7.9 / 9。

- **上传批次 + 导入任务**
  - 工作台「上传资料」弹窗：选目标库、多文件/目录、扩展名与大小校验、跨库重复开关、OCR best/fast、并发 2。
  - 逐文件上传进度；上传完成后启动导入任务；逐文件状态/计数/报告；失败可重试；staging 清理。
  - worker 写 progress JSON；复用 `startImportJob` / `import-worker.mjs`。
- **标准更新**
  - 工作台标准面板：上次检查、缓存、登录状态（不返回 cookie）、待下载/已导入/失败数。
  - 仅检查 / 检查并下载 / 补下载 / 强制全查 / 本轮上限；下载前金币确认。
  - 复用 `runStdCheck`，增加 `onProgress`；任务结果保留 1 小时。
- **范围（scope）**
  - `kbRoot/.scopes.json`，`mode: all|selected`，原子写、TTL 清理、归档/重命名同步。
  - 子会话继承父范围；父范围变化不回溯。
  - `kb_*` 工具硬约束（矩阵见 spec 6.4），范围外 `KB_OUT_OF_SCOPE`，不静默降级。
  - `agent/session-start` 注册系统提示段（order 120）；不支持时降级为工具约束 + inject。
- **胶囊（capsule）**
  - client bundle（复用现有 `src/client` 构建链）；位置优先 `conversation.input.left`，退到 `conversation.session.header.utilities`。
  - 收起态/展开态、搜索、多选、全选/清空、应用/取消、打开工作台。
  - 无 API 时不渲染；加载失败显示 `—` + 重试。

## 3. 建议拆分（供新对话决定）

Slice 2 完整范围较大，建议拆成两个可独立验收的子切片：

- **2A：上传 + 标准检查**
  - 上传批次/导入任务/进度/重试 + 工作台弹窗
  - 标准检查/下载任务/确认 + 工作台面板
  - 只动工作台页面与 API/jobs；不碰工具范围
- **2B：范围 + 胶囊 + 工具硬约束**
  - `.scopes.json`、继承、API、系统提示
  - 工具矩阵逐项接入 + 胶囊 UI
  - 依赖 2A 的工作台 API/任务基础（jobs/上传批次）

这样每个子切片都能独立验收，避免一个计划过长、执行失焦。

## 4. 关键文件（新对话先读）

- 设计/计划：
  - `docs/superpowers/specs/2026-10-23-kb-workbench-design.md`（M1）
  - `docs/superpowers/specs/2026-10-24-kb-workbench-sidebar-entry-design.md`（Slice 1.5，客户端构建/弹窗模式）
  - `docs/superpowers/plans/2026-10-23-kb-workbench-slice1.md`（Slice 1 执行方式）
  - `docs/superpowers/plans/2026-10-24-kb-workbench-sidebar-entry.md`（Slice 1.5 执行方式）
- 服务端：
  - `lib/index.js`（21 个工具）、`lib/store.js`、`lib/pipeline.js`、`lib/standards.js`
  - `lib/web/server.js` / `api.js` / `data.js` / `http.js`
  - `worker/import-worker.mjs`
- 前端：
  - `ui/app.js`、`ui/views/*`、`ui/style.css`、`ui/api.js`
  - `src/client/index.tsx`、`scripts/build-client.mjs`、`lib/client.js`
- 配置/安装：
  - `package.json`、`cordis.patch.yml`、`README.md`
  - `~/.dsh/profiles/desktop/cordis.patch.yml`（安装别名；不要随意改）

## 5. 已知约束与坑

- **包名/loader 名**：`dsh-knowledge-wiki` 必须与 profile 的 `name` 一致；否则 DSH 0.2.x 的 client-modules 会静默跳过客户端插件。
- **桌面端协议**：`dsh-app://app`；不要用 `window.open` 打开 `/kb/`，不要整页导航覆盖 DSH。弹窗用 portal + iframe。
- **客户端 bundle**：esbuild external `react`/`react-dom`；`__ModuleLoader__.load` 的 id 从 `__DSH_BOOT__.entries` 选 `dsh-knowledge-base` / `dsh-knowledge-wiki`；`check:client` 防止产物漂移。
- **安全**：复用 `isTrustedApiRequest` / `assertSameOrigin` / `x-kb-ui`；上传扩展名白名单/大小/路径；`bzCookie` 永不返回；`sources/`、`markdown/` 只读。
- **测试**：用临时 `kbRoot`，不要拿真实库做破坏性试验；真实库根目录 `/Users/littlesun/workspace/knowledge` 只读验收。
- **manifest**：已 v5；新 API 不要退回写死 schemaVersion。
- **桌面端重启**：服务端/客户端 bundle 改动后，DSH 窗口 `Cmd+R` 或重启；客户端 HMR 只在 bundle rev 变化时生效。

## 6. 新对话需要先决定的问题

1. Slice 2 是否按 2A/2B 拆分？先做哪一半？
2. 上传限制：`uiMaxUploadBytes` / `uiMaxBatchFiles` 取多少？是否允许目录上传？是否允许跨库重复？
3. 标准下载确认/金币提示的文案与失败处理；`bzCookie` 未配置时的降级。
4. 胶囊 slot：优先 `conversation.input.left` 还是直接 `conversation.session.header.utilities`？当前桌面端 0.2.1 的 slot 可用性需 spike。
5. 范围存储：sessionId 来源、TTL 默认 30 天、子会话继承；是否需要工作区/项目级范围（M1 spec 只做会话级）。
6. 是否在设置里增加一个「知识库」页（说明 + 打开工作台 + 默认库/范围入口）；这不是 Slice 2 的核心，但可以作为附加入口。
7. 版本号：Slice 2A/2B 分别 bump 到 0.20.x 还是一次 0.20.0？

## 7. 建议的新对话开头

```text
读 docs/superpowers/specs/2026-10-24-kb-workbench-slice2-brief.md
和 docs/superpowers/specs/2026-10-23-kb-workbench-design.md 的 5.6/5.7/6/7.6/7.7，
先按 brainstorming 流程确认 Slice 2 拆分与范围，再写 spec 和 implementation plan。
当前插件仓库：/Users/littlesun/.dsh/plugins/dsh-knowledge-base（main，0.19.1，186 tests）。
```

## 8. 当前验证基线

```text
cd /Users/littlesun/.dsh/plugins/dsh-knowledge-base
npm test          # 186/186
npm run typecheck
npm run check:client
curl http://127.0.0.1:<port>/kb/api/status   # 200, 0.19.1
```

工作台入口：DSH 侧栏底部「知识库」→ 弹窗；关闭 ×/Esc/遮罩。
