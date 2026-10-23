# 知识库工作台（Knowledge Workbench）设计

> 状态：Draft，待用户评审  
> 日期：2026-10-23  
> 目标版本：`dsh-knowledge-base` 0.19.0（M1）  
> 关联插件：`~/.dsh/plugins/dsh-knowledge-base`（当前 v0.18.0，21 个 `kb_*` 工具）  
> 数据根：`/Users/littlesun/workspace/knowledge`

## 0. 已确认的决策

| 决策 | 结论 |
|---|---|
| 界面落点 | **独立工作台 `/kb/` + 对话输入框旁的知识库胶囊**；工作台可独立打开，后续可 iframe 进会话，不在 M1 做 |
| 合并语义 | **物理合并**：移动文档、合并前快照、源库保留为空库/标记 `mergedInto`、同 id 冲突自动改名 |
| 标准更新 | **一键检查 + 下载**；M1 不做定时任务，不自动下载 |
| 会话范围 | **硬约束**：工具只能访问选定库，范围外报错；子代理/子会话继承父会话范围 |

## 1. 背景与问题

`dsh-knowledge-base` 已经把"资料 → 可检索知识库"做得比较完整：原始文件、markdown 分块、合并版、笔记、摘要、可信度、lint、导出都有。但所有入口都是 `kb_*` 工具，用户必须通过对话让模型去调用，存在三个问题：

1. **不可见**：不知道有哪些库、每个库有什么、多少文件、哪些是空库、哪些库有导入失败或待处理项。
2. **不好管**：新建空库、合并库、改库简介、批量上传、检查标准更新，都缺少直接入口；只能靠对话描述。
3. **不会用**：每次对话都要让模型"记住"用哪些库；跨库检索和多库限定没有产品化，容易答非所问或读到范围外资料。

本机现状：9 个知识库目录，其中 7 个有内容、约 1590 篇有效文档；`default` 与 `kb= 标准` 是空库。`标准` 库 935 篇有效文档、约 4.3 万页、约 8000 万字，是最需要"看得见、管得住"的库。

DSH Web 侧已经具备实现条件：

- 服务端插件可通过 `ctx.webServer.register({ kind, path, handler })` 注册 HTTP 路由（`dsh-better-sidebar` 的 `/sidebar/api` 是现成例子）。
- 客户端插件可通过 `dsh.client` 声明 web bundle，注册到 `conversation.input.left`、`conversation.input.right`、`conversation.session.header.utilities`、`settings.section` 等插槽。
- 工具执行上下文可拿到 `exec.agent.sessionId`；`Agent.ctx` 是 agent 级 Cordis 上下文，可用于注册动态系统提示段。
- `dsh-jobs` 提供后台任务注册与状态查询，适合导入/OCR/标准检查/合并。

## 2. 目标与非目标

### 2.1 目标（M1）

1. **看得见**：工作台总览展示全部知识库的名称、简介、文档数、笔记数、页数、字数、类型/可信度分布、最近更新、状态；可下钻到资料列表。
2. **管得住**：新建空库、编辑库简介/标签、重命名、归档与取消归档（非空库也可归档）、合并库、上传资料、检查标准更新。
3. **用得上**：对话输入框旁的胶囊可选择 1..N 个知识库，作为本会话范围；`kb_*` 工具硬约束在该范围内；子代理/子会话继承范围。
4. **不破坏**：现有工具、数据、测试全部保持兼容；不要求重新导入。
5. **安全可回退**：合并前快照 + 移动日志；归档进 `.trash/`，回收站可恢复；危险操作二次确认。

### 2.2 非目标（M1 明确不做）

- 文档级编辑（改标题、可信度、删除、恢复、重解析）——M2。
- 定时自动检查标准更新——M2（M1 只做一键）。
- 任务模板、批量派任务、工作流编排——M2。
- 把工作台 iframe 进会话标签页——M2。
- 导出 zip/md 的 UI 入口——M2（工具 `kb_export` 仍可用）。
- 回收站的自动过期清理、彻底删除、批量恢复——M2（M1 只做“列出 + 单个恢复”）。
- 多用户、登录、权限、远程访问——M1 只服务本机/受信主机。
- LLM 自动写库简介——M1 用启发式建议 + 手写。
- 合并时自动改写笔记中的 `docId` 引用——M1 只提示，不改写。
- 全文检索 UI——M1 资料列表只做标题/标签/类型过滤；全文检索仍走 `kb_query`。

## 3. 用户与关键场景

**用户**：本机知识库维护者（单用户），经常导入标准/教材/试验资料，并在对话里按主题检索。

| 场景 | 期望 |
|---|---|
| 打开工作台 | 一眼看到 9 个库的规模、空库、失败项、最近更新 |
| 新建"电气"库 | 输入名称/简介，立即出现在列表；可继续上传 |
| 合并"电气一次"+"电气二次" | 预览会移动多少篇、有没有冲突；确认后源库变空并标记已合并 |
| 上传一批标准 PDF | 拖入文件/目录，看到逐文件进度、成功/失败/跳过原因 |
| 检查标准更新 | 看到"上次检查时间"；点检查，列出有更新的标准；确认金币后下载导入 |
| 在对话里只用"标准"库 | 输入框旁选"标准"，问问题时工具不会读到别的库；范围外会明确提示 |
| 派任务给子代理 | 子代理自动继承同样的知识库范围，不会偷偷看全库 |
| 清理空库 | 把 `default`、`kb= 标准` 归档到 `.trash/`，列表变干净 |
| 误归档一个库 | 在“回收站”看到它，点恢复；原库名被占用时可以改名恢复 |

## 4. 总体方案

### 4.1 形态

```text
DSH Web（127.0.0.1:55929）
├─ 对话输入框  [知识库：标准、变电试验 ▾]   ← 客户端胶囊
│     ├─ 选 1..N → PUT /kb/api/scope（按 sessionId 存）
│     └─ 工具执行：exec.agent.sessionId → 范围 → 硬约束
│     └─ 系统提示：agent 级动态段写明本会话范围
│
└─ /kb/  知识库工作台（插件 webServer 提供静态页）
      ├─ 总览 / 库详情 / 资料 / 笔记 / 日志 / 设置
      ├─ 新建 / 合并 / 上传 / 标准更新
      └─ /kb/api/* 共用后端；长任务走 ctx.jobs + 进度轮询
```

- **工作台 = 管理面**：不依赖当前会话，可独立打开、收藏；后续可 `iframe` 嵌入，不改前端。
- **胶囊 = 使用面**：只负责"本会话用哪些库"，不做管理；底部提供"打开工作台"。
- 两者共用 `/kb/api/*`，避免两套逻辑。

### 4.2 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| 服务端路由 | `lib/web/server.js` | 挂载 `/kb/`、`/kb/api/*`、静态资源、信任围栏 |
| API 处理器 | `lib/web/api.js` | 库/文档/上传/合并/标准/任务/范围 |
| 范围存储 | `lib/web/scope.js` | `.scopes.json` 读写、校验、继承、清理 |
| 合并逻辑 | `lib/merge.js` | 预览、移动、冲突、日志、回滚 |
| 库元数据 | `lib/kbmeta.js` | 简介/标签、创建、归档、重命名辅助 |
| 任务进度 | `lib/web/jobs.js` | 包装 `ctx.jobs`，维护进度 Map |
| HTTP 工具 | `lib/web/http.js` | JSON 响应、body 读取、错误映射、静态文件 |
| 工作台前端 | `ui/` | 原生 ES modules + CSS/SVG，无构建 |
| 客户端胶囊 | `lib/client.js` | 手写 CJS factory，注册输入框插槽 |
| 工具范围层 | `lib/scope.js` | 每个 `kb_*` 工具解析/校验范围 |

### 4.3 数据流

**管理流**：浏览器 → `/kb/api/*` → `store.js`/`merge.js`/`pipeline.js` → 清单/文件/`ctx.jobs` → 轮询 `/kb/api/jobs/:id`。

**对话流**：胶囊 → `PUT /kb/api/scope` → `.scopes.json`；工具执行 → `exec.agent.sessionId` → 范围 → 允许/拒绝；系统提示在每次组装时读取范围。

**上传流**：浏览器分批 → `/kb/api/upload-batches/*` → `import-tmp/ui-batches/<id>/` → `POST import` → worker 导入 → 进度文件/内存进度 → UI 轮询。

**合并流**：预览（只读）→ 确认 → 后台任务 → 快照 + 移动 + 清单 + index/log + 移动日志 → 结果。

## 5. 工作台

### 5.1 路由与信息架构

使用 hash 路由，服务端只需要把 `/kb/` 的 `index.html` 返回，不要求 history fallback：

| Hash | 页面 |
|---|---|
| `#/` | 总览（卡片网格） |
| `#/kb/<name>/overview` | 库概览 |
| `#/kb/<name>/docs` | 资料列表 |
| `#/kb/<name>/notes` | 笔记列表 |
| `#/kb/<name>/log` | 操作日志 |
| `#/kb/<name>/settings` | 库设置 |
| `#/new` | 新建库弹窗（也可直接在总览打开） |
| `#/merge?sources=a,b` | 合并向导 |
| `#/std/<name>` | 标准更新面板 |

未知 hash 回退到 `#/`。

### 5.2 总览

**顶部工具栏**

- 标题"知识库工作台"。
- 过滤器：`全部` / `有内容` / `空库` / `最近更新`。
- 搜索框：按名称/简介/标签即时过滤（前端过滤，数据已全量在内存）。
- 主按钮：`+ 新建知识库`。
- 次按钮：`刷新`。

**汇总条**

- 知识库数、有效文档数、笔记数、总页数、总字数、空库数。
- 有效文档数 = 各库 `ready + importing + failed` 之和（不含软删除）；页数/字数同口径。
- 格式：`9 个库 · 1590 篇有效文档 · 11 篇笔记 · 21.2 万页 · 2.69 亿字`（数字按实际计算）。

**库卡片**

每张卡片：

- 名称 + 彩色圆点（按名称 hash 取固定色，仅视觉区分）。
- 简介（最多两行，空则显示"未填写简介"）。
- 统计：`935 篇 · 4.3 万页 · 8000 万字`；笔记数；导入失败数（如有，红点）。
- 类型分布：横向堆叠条（PDF 文字版 / PDF 扫描版 / PDF 混合 / Word / PPT / 文本 / Markdown / 笔记 / 电子书）。
- 可信度分布：high/medium/low/unknown 小条。
- 状态徽标：`空库`、`有失败`、`待体检`（M2 才做体检）、`已合并至 X`、`标准更新 N`。
- 最近更新时间。
- 多选框（用于合并/归档）。

**多选操作条**（选中 ≥1 时出现）

- `合并…`（需 ≥1 个源；目标可为现有库或新建）。
- `归档`（危险色；任何库都可归档，必须二次确认；非空库也可归档）。
- `清除选择`。

> 工作台多选只用于合并/归档；本会话的对话范围在输入框胶囊里选择，避免两处状态互相干扰。

**空态**

- 没有任何库：大卡片"新建知识库"+"上传第一批资料"。
- 过滤后为空：提示"没有匹配的知识库"。

### 5.3 库详情

顶部：返回、库名、状态徽标、`上传资料`、`合并…`、更多菜单（重命名/归档/打开目录提示）。

**概览页**

- 简介与标签：内联编辑，`保存`/`取消`；`从资料生成建议`（启发式，不调用模型：取前 3 个高频标签、主要类型、前 3 个标题片段拼成一句，用户可改）。
- 统计卡：文档、笔记、页数、字数、类型数、可信度分布。
- 组成图：类型堆叠条 + 可信度条 + OCR 比例（`pdf-scanned`/`pdf-mixed` 占比）。
- 健康摘要：失败文档、导入中、软删除、无 schema、最近 lint（M1 只显示 manifest 可得的项）。
- 最近 5 篇文档（标题/类型/更新时间）。
- 标准库额外显示：上次检查时间、待下载数、`检查标准更新` 按钮。M1 只对名称为 `标准` 的库显示；其它库 M2 按标准号识别。

**资料页**

- 服务端分页，默认 50/页。
- 过滤：搜索（标题子串）、类型组、可信度、状态（ready/importing/failed/deleted）。
- 排序：标题、更新时间、页数。
- 列：标题、类型、页数、字数、状态、可信度、摘要（截断）、标签。
- 行点击：右侧抽屉显示 docId、类型、页数、字数、来源文件、摘要、标签、OCR 置信度/低置信页、警告；`下载原件`（`GET .../source`）。
- M1 不提供编辑/删除按钮。

**笔记页**

- 过滤 `type=note` 的 ready 文档；列：标题、kind、摘要、标签、更新时间、来源数。
- 行点击：抽屉显示摘要/标签/来源；M1 不渲染全文（M2 接 `readVirtualDoc`）。

**日志页**

- 显示 `log.md` 最后 200 行（服务端截断），只读。

**设置页**

- 重命名：输入新名称，确认后调用 `PATCH`；成功后更新 hash 和范围引用。
- 简介/标签：同概览。
- 合并入口：作为目标库或源库打开向导。
- 归档：输入库名确认；移动到 `kbRoot/.trash/<name>-<YYYYMMDD-HHmmss>/`；恢复入口在侧栏“回收站”。
- 只读信息：目录名、createdAt、updatedAt、schemaVersion。

### 5.4 新建知识库

弹窗字段：

- 名称（必填，`sanitizeKbName` 规则；实时校验空/非法/重名）。
- 简介（可选，≤500 字）。
- 标签（可选，逗号分隔，≤20 个，每个 ≤32 字）。
- 复选框：`创建后立即上传资料`（默认勾选；创建成功后打开上传弹窗）。

提交后：`POST /kb/api/kbs` → 刷新列表 → 进入 `#/kb/<name>/overview`。

### 5.5 合并向导

**步骤 1：选择**

- 源库：从总览多选带入，或在本页多选；至少 1 个，不能包含目标。
- 目标：`合并到现有库`（下拉）或 `合并为新库`（名称 + 简介）。
- 说明：`移动文档，不复制；源库会保留为空库并标记已合并`。

**步骤 2：预览**

调用 `POST /kb/api/merge/preview`（目标可为现有库或新建，见 API）。展示：

- 将移动 N 篇、跳过重复 M 篇、改名 K 篇、跳过软删除 D1 篇、跳过失败 D2 篇。
- 冲突列表（最多 100 条）：源库、标题、原因（同 id 内容不同 / 同 id 内容相同将跳过）。
- 受影响笔记：扫描源库和目标库的笔记，列出引用了将被改名 docId 的笔记（提示可能断链）。
- 警告：源库或目标库有 `importing` 文档；有活动导入任务；目标库名已存在；源库含标准缓存。
- 快照说明：执行时两库各做一次元数据快照（不含 sources），并写移动日志；预览阶段不写盘。

**步骤 3：确认与执行**

- 要求勾选"我确认移动这些文档"；目标为新库时名称需再次匹配。
- `POST /kb/api/merge` → `{jobId}` → 进度页。
- 进度阶段：`校验` → `快照` → `移动` → `重建索引` → `完成`。
- 完成：显示目标库链接、移动/跳过/改名计数、报告路径、快照路径。

**失败与回滚**

- 任一步失败：把已移动的文件按移动日志反向移回，恢复两库清单（内存快照），写入失败原因；若反向移动也失败，保留日志并提示手工恢复路径。
- 不自动删除源库目录。

### 5.6 上传与导入

**入口**：总览"上传资料"（先选目标库）、库详情"上传资料"、新建后的"立即上传"。

**上传弹窗**

- 目标库：下拉（默认当前库）；可切换。
- 拖拽区：支持多文件/目录（`webkitdirectory`）；显示文件名、大小、类型。
- 客户端校验：扩展名白名单（与 `SUPPORTED_EXTS` 一致）、单文件 ≤ `uiMaxUploadBytes`、批量 ≤ `uiMaxBatchFiles`。
- 选项：
  - `允许跨库重复`（默认关）。
  - OCR 模型：`best`（默认）/`fast`（仅 PDF 扫描件有意义）。
- 开始后：逐个上传（并发 2），显示每个文件的上传进度；全部上传完成后自动启动导入任务。
- 导入进度：每文件状态（等待/导入中/成功/失败/跳过）、计数、当前文件名；完成后显示报告。
- 成功后：刷新库统计；提供"查看新资料"（跳资料页，按更新时间排序）。

**失败处理**

- 单文件上传失败：标记该文件失败，其他继续；可"重试失败项"。
- 导入任务失败：显示 worker 错误/报告；保留 staging 目录直到用户关闭弹窗（便于排查），24 小时后启动时清理。

### 5.7 标准更新

**入口**：总览"标准"卡片、标准库概览、`#/std/标准`。

**面板内容**

- 上次检查时间（读 `.std-check.json`）、缓存是否有效（7 天）。
- 登录状态：`bzCookie` 已配置/未配置（不显示值）；`authOk` 上次结果。
- 待下载数、已导入数、失败数。
- 按钮：
  - `仅检查`（`action=check`，不下载）。
  - `检查并下载`（`action=check-download`）。
  - `补下载`（`action=download`，缓存里有待下载项时可用）。
- `强制全查`复选框（忽略 7 天缓存）。
- `本轮上限`数字输入（0=不限，用于分批）。
- 下载前确认弹窗：说明"每个标准约 6 金币（VIP 免金币），本轮最多 N 个"；必须勾选确认才启动。
- 结果表：标准号、标题、状态（已是最新/有新版/草案转正/下载成功/导入成功/认证失败/未找到/金币不足）、消息。
- 完成后刷新库统计，并在卡片上保留最近一次检查摘要。

**M1 不做**：定时器、自动下载、后台静默检查。

### 5.8 重命名 / 简介 / 归档 / 取消归档

- **重命名**：`PATCH /kb/api/kbs/:name { name }`；成功后把 `.scopes.json` 中所有引用旧名的条目改为新名；同步 `schema.md` 的 H1 与 `index.md`（best-effort）；返回新名称。
- **简介/标签**：`PATCH { description?, tags? }`；写 manifest v5；`listKbs` 和 `kb_list` 带出。
- **归档**：`POST /kb/api/kbs/:name/archive { confirm: "<name>" }`；任何库（含非空）都可归档，必须逐字输入库名；移动到 `.trash/<name>-<timestamp>/`；从 `.scopes.json` 移除引用；返回 `{trashedTo, dir}`。
- **回收站**：侧栏“回收站”页调用 `GET /kb/api/trash`，列出 `.trash/` 中的库（名称、文档数、归档时间、是否可恢复）；点“恢复”调用 `POST /kb/api/trash/:dir/restore`，默认恢复为 manifest 里的原名；原名被占用时弹窗输入新名称再恢复。
- **恢复语义**：把 `.trash/<dir>` 移回 `kbRoot/<name>/`；如果改了名，同步更新 manifest.name、schema.md H1、index.md；不自动重新加入会话范围（Slice 2 的 `.scopes.json` 只在归档时移除引用，恢复后由用户重新选择）。
- **空库清理**：总览给 `default`、`kb= 标准` 显示“空库”徽标和归档快捷按钮。归档 `default` 前提示：配置的 `defaultKb` 将失效，建议先在 profile 里改 `defaultKb`。

**M1 回收站只做列出/单个恢复，不做**：自动过期清理、彻底删除、批量恢复；这些放 M2。

### 5.9 交互细节

- 加载：骨架屏/行内 spinner；按钮提交后禁用并显示"处理中"。
- 错误：顶部 toast + 表单内联错误；API 错误带 `code` 和可读 `message`。
- 确认：归档/合并/下载标准必须二次确认；危险按钮用危险色。
- 键盘：Esc 关闭弹窗；Enter 提交表单（多行文本除外）；Tab 焦点顺序合理。
- 空态与降级：API 不可用时显示"工作台服务未启用"和排查提示。
- 响应式：最小支持 960px 宽；窄屏卡片单列，表格横向滚动；不做手机专属布局。

## 6. 胶囊与范围

### 6.1 胶囊 UI

- 位置：`conversation.input.left`（输入框左侧扩展位）。
- sessionId：从该 slot 的 session-scope owner props 获取（`sessionId` 或 `session.id`）；若当前宿主不提供，退到 `conversation.session.header.utilities`；再不可用则不渲染。
- 收起态：数据库图标 + `知识库：全部` 或 `知识库：2 个`；有范围时用强调色。
- 展开态（portal 到 `document.body`，避免被输入框裁剪）：
  - 标题"本会话使用哪些知识库？"
  - 搜索框。
  - 库列表：复选框、名称、文档数、空库徽标；已归档库不出现。
  - 快捷：`全选` / `清空`。
  - 底部：`应用`、`取消`；`打开知识库工作台`（新标签打开 `/kb/`）。
- 应用：`PUT /kb/api/scope`，带 `x-kb-ui: 1`；成功后 toast"已限定为 N 个知识库"，胶囊更新；下一次模型请求的系统提示生效。
- 无知识库：显示"暂无知识库"+"去工作台新建"。
- 加载失败：胶囊显示 `知识库：—`，点开显示重试。
- 无 API（工作台未启用）：胶囊不渲染（静默降级）。

### 6.2 存储

文件：`kbRoot/.scopes.json`，权限 `0600`，原子写（临时文件 + rename），进程内串行队列。

```json
{
  "version": 1,
  "scopes": {
    "<sessionId>": {
      "mode": "selected",
      "kbs": ["标准", "变电试验"],
      "updatedAt": "2026-10-23T14:00:00.000Z",
      "inheritedFrom": null
    }
  }
}
```

- `mode`：`all` | `selected`；`selected` 且 `kbs=[]` 视为 `all`。
- 读取时清理：超过 `scopeTtlDays`（默认 30 天）的条目；已不存在的库名；归档库。
- 校验：`sessionId` 1–200 字符、无控制字符；库名经 `sanitizeKbName` 且必须存在；最多 50 个库。
- 写入失败：API 返回 `SCOPE_WRITE_FAILED`，胶囊回滚到旧状态。

### 6.3 继承

- `agent/session-start` 时：若该 session 没有显式范围，且 `session.meta.parentSession` 存在，则复制父会话范围，`inheritedFrom=<parentId>`。
- 子代理、fork 默认继承；继承后用户可在胶囊里改，改后 `inheritedFrom=null`。
- 父会话范围后来变化，不自动同步已继承的子会话（避免运行中行为突变）。
- 无父会话：`mode=all`。
- 派任务 = 在本会话内下任何指令，范围同样生效；子代理继承范围。任务模板/批量派发属于 M2。

### 6.4 工具行为矩阵

范围 `selected` 时（`kbs` 为选定库）：

| 工具 | `kb` 显式指定 | `kb` 省略 |
|---|---|---|
| `kb_list` | 必须在范围内，否则 `KB_OUT_OF_SCOPE` | 只列范围内库，结果带 `scope` |
| `kb_query` | 必须在范围内；`*` 视为范围内全部 | 在范围内跨库检索；结果带 `scope` |
| `kb_read` / `kb_view` | 必须在范围内；跨库同名时按现有规则解析，歧义报候选 | 只在范围内解析；多个库有同名文档则报候选 |
| `kb_edit` / `kb_describe` / `kb_retitle` / `kb_trust` / `kb_keep` / `kb_edit_batch` | 同上 | 同上 |
| `kb_history` / `kb_restore` / `kb_remove`（文档级） | 同上 | 同上 |
| `kb_import` / `kb_reparse` | 必须在范围内 | 范围只有 1 个库时用它；多个库时报"请指定 kb"；0 个按 `defaultKb` |
| `kb_std_check` | 必须是范围内的库（默认 `标准` 也需在范围内） | 默认 `标准`；不在范围则 `KB_OUT_OF_SCOPE` |
| `kb_lint` | 必须在范围内 | 范围内逐库跑（最多 20 个），结果按库分组 |
| `kb_snapshot` / `kb_export` | 必须在范围内；`kb_export` 多库时要求指定 | 范围 1 个库时用它；多个时报"请指定 kb" |
| `kb_rename`（库级）/ `kb_remove(removeKb=true)` | 必须在范围内 | 无默认，必须显式 |

`mode=all` 时保持现有行为，不改变默认 `defaultKb` 语义。

**错误文案**（示意）：

```text
本会话的知识库范围是「标准、变电试验」，不包含「电能质量」。
如需使用，请在输入框旁的知识库选择器里调整范围。
```

**范围外不静默降级**：不能悄悄搜全部库，必须报错，避免模型"假装在范围内"。

### 6.5 系统提示

在 `agent/session-start`（含 `resume`）时，通过 `agent.ctx.systemPrompt.section` 注册动态段（order 120）：

```text
[知识库范围] 本会话用户选定：标准、变电试验。
kb_* 工具只能访问这些库；范围外资料不要读取或检索。
用户要求其他库时，提示其使用输入框旁的知识库选择器切换。
```

`mode=all` 时：

```text
[知识库范围] 本会话未限定知识库，可使用全部知识库。
```

- 文本函数在每次组装时读取 `.scopes.json`，范围变化后下一轮生效。
- 若当前宿主版本不支持在 `agent.ctx` 注册 section，则退化为：范围变更时对在线 agent 调 `agent.inject()` 注入一条上下文；再失败则只依赖工具硬约束（可接受降级）。
- 插件晚于会话启动加载时，已有会话没有提示段；工具仍按范围执行，用户重新开会话后恢复提示。

### 6.6 边界情况

- 库被重命名：`PATCH` 成功后同步更新 `.scopes.json`。
- 库被归档：读取范围时自动剔除；若剔除后为空，视为 `all`。
- 同一标题在多个选定库：`kb_read` 报候选列表（沿用现有解析规则），不擅自选一个。
- `kb` 显式传 `*`：仅 `kb_query` 支持；范围模式下等价于范围内全部。
- 子代理：继承父范围；父范围变化不回溯。
- 并发：范围写入串行；读取无锁（原子替换保证读到完整 JSON）。
- 隐私：`.scopes.json` 不含对话内容，只含 sessionId 与库名。

## 7. 服务端设计

### 7.1 挂载与路由

在 `apply()` 中按需注册（只有 `webServer` 可用时）：

```js
ctx.inject(["webServer"], (sctx) => {
  // 注册 /kb 静态与 /kb/api 路由；jobs 通过 ctx.get("jobs") 按需获取
});
```

- 没有 `webServer` 的 profile（desktop/headless）不注册任何路由，插件其余功能不变。
- `uiEnabled=false` 时同样不注册路由（保留工具能力）。
- `jobs` 服务不可用时，上传/标准/合并接口返回 `503 JOBS_UNAVAILABLE`；只读接口仍可用。
- 路由：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/kb` | 308 跳到 `/kb/` |
| GET | `/kb/` | `ui/index.html` |
| GET | `/kb/<asset>` | `ui/` 下的白名单静态文件 |
| GET | `/kb/api/status` | 健康检查与能力探测 |
| GET | `/kb/api/kbs` | 库列表 |
| POST | `/kb/api/kbs` | 新建库 |
| GET | `/kb/api/kbs/:name` | 库详情 |
| PATCH | `/kb/api/kbs/:name` | 改名/简介/标签 |
| POST | `/kb/api/kbs/:name/archive` | 归档（含非空库） |
| GET | `/kb/api/trash` | 回收站列表 |
| POST | `/kb/api/trash/:dir/restore` | 恢复归档库（可改名） |
| GET | `/kb/api/kbs/:name/docs` | 文档分页 |
| GET | `/kb/api/kbs/:name/docs/:id` | 文档元数据 |
| GET | `/kb/api/kbs/:name/docs/:id/source` | 下载原件 |
| POST | `/kb/api/upload-batches` | 创建上传批次 |
| PUT | `/kb/api/upload-batches/:id/files` | 上传一个文件（raw body） |
| POST | `/kb/api/upload-batches/:id/import` | 启动导入任务 |
| GET | `/kb/api/upload-batches/:id` | 批次状态 |
| POST | `/kb/api/merge/preview` | 合并预览（目标可为新建） |
| POST | `/kb/api/merge` | 执行合并（目标可为新建） |
| POST | `/kb/api/kbs/:name/std-check` | 标准检查/下载 |
| GET | `/kb/api/jobs/:id` | 任务状态/进度 |
| GET | `/kb/api/scope` | 读范围（`?session=`） |
| PUT | `/kb/api/scope` | 写范围 |

静态资源用白名单，不开放目录遍历：`index.html`、`app.js`、`style.css`、`icons.js`、`favicon.svg`。其它路径 404。

### 7.2 API 约定

- JSON 请求/响应，`Content-Type: application/json; charset=utf-8`。
- 错误统一：

```json
{ "error": { "code": "KB_OUT_OF_SCOPE", "message": "…", "details": {} } }
```

- 成功：直接返回资源对象，不包 `data`。
- 变更请求必须带 `x-kb-ui: 1` 头（跨站表单无法设置），并校验 `Origin`/`Sec-Fetch-Site` 同源。
- 所有路由先过信任围栏；失败 403。
- 管理 API（库/文档/上传/合并/标准）不受胶囊范围约束；范围只作用于对话里的 `kb_*` 工具。
- 响应头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、API `Cache-Control: no-store`。

### 7.3 API 细节

#### `GET /kb/api/status`

```json
{
  "ok": true,
  "version": "0.19.0",
  "kbRoot": "/Users/littlesun/workspace/knowledge",
  "features": { "ui": true, "merge": true, "std": true }
}
```

#### `GET /kb/api/kbs`

```json
{
  "kbs": [
    {
      "name": "标准",
      "dir": "标准",
      "description": "现行标准、规程、规范",
      "tags": ["标准", "规程"],
      "createdAt": "2026-08-16T04:42:55.867Z",
      "updatedAt": "2026-10-23T14:15:59.714Z",
      "docs": { "total": 948, "ready": 934, "importing": 0, "failed": 1, "deleted": 13, "notes": 6 },
      "pages": 43094,
      "chars": 80950464,
      "types": { "pdf-text": 157, "pdf-scanned": 444, "pdf-mixed": 290, "docx": 34, "note": 6, "markdown": 2, "text": 1, "pdf": 1 },
      "trust": { "high": 834, "medium": 39, "low": 61, "unknown": 1 },
      "status": "warn",
      "mergedInto": null,
      "std": { "configured": true, "lastCheckAt": "2026-10-20T…", "updates": 3, "pendingDownloads": 3 }
    }
  ]
}
```

- 统计口径：`total` = 全部记录（含软删除）；`ready`/`importing`/`failed` 只统计未删除文档；`deleted` 单列，四者相加 = `total`；`pages`/`chars` 只统计未删除文档。
- 统计只读 manifest，不读文件内容；`types`/`trust`/`notes` 也只统计未删除文档。
- `status`：`empty`（0 有效文档）、`ok`、`warn`（有 failed/importing/无 schema）。
- `std` 仅对含标准号的库出现（M1 先给 `标准` 库；其它库可后续判断）。

#### `POST /kb/api/kbs`

请求：

```json
{ "name": "电气", "description": "电气一次/二次合并库", "tags": ["电气"] }
```

响应 `201`：

```json
{ "kb": { "name": "电气", "dir": "电气", "docs": { "total": 0, "ready": 0, "importing": 0, "failed": 0, "deleted": 0, "notes": 0 }, "pages": 0, "chars": 0, "types": {}, "trust": {}, "status": "empty" } }
```

错误：`KB_NAME_INVALID` 400、`KB_EXISTS` 409。重名检查大小写不敏感（APFS/NTFS 默认不区分文件大小写），并拒绝 `.`、`..`、`.trash`、以 `.` 开头的名称。

创建动作：`mkdir` → manifest v5（空 docs）→ `ensureSchema` → `ensureLog` → `refreshIndexIfStale`（生成空 index）。

#### `GET /kb/api/kbs/:name`

```json
{
  "kb": { "...": "同 KbSummary" },
  "schema": { "exists": true, "chars": 3331 },
  "index": { "chars": 1865 },
  "logTail": "最后 200 行",
  "recentDocs": [ { "id": "…", "title": "…", "type": "pdf-scanned", "updatedAt": "…" } ],
  "health": { "failed": 1, "importing": 0, "deleted": 13, "lowConfidenceDocs": 12, "corruptedDocs": 2 }
}
```

#### `PATCH /kb/api/kbs/:name`

请求（至少一个字段）：

```json
{ "name": "电气工程", "description": "…", "tags": ["电气", "一次", "二次"] }
```

- 改名：调用现有 `renameKb`；校验目标不存在；成功后更新 `.scopes.json`，并尝试同步 `schema.md` H1 与 `index.md`。
- 简介：≤500 字，去首尾空白；标签规范化（去重、去空、≤20 个、单个 ≤32 字）。
- 响应 `{ "kb": KbSummary, "renamedFrom": "旧名" | null }`。

#### `POST /kb/api/kbs/:name/archive`

```json
{ "confirm": "标准" }
```

- `confirm` 必须逐字等于库名。
- 归档 `default` 时返回警告字段，提示 `defaultKb` 将失效；不阻止归档。
- 目标：`kbRoot/.trash/<name>-<YYYYMMDD-HHmmss>/`；若已存在同名时间戳，追加 `-2`。
- 从 `.scopes.json` 移除该库；返回 `{ "trashedTo": ".trash/…", "dir": "<归档目录名>" }`。
- `default` 也允许归档，但必须在确认框里逐字输入库名；归档后从 `.scopes.json` 移除引用。

#### `GET /kb/api/trash`

```json
{
  "items": [
    {
      "dir": "电气一次-20261023-233649",
      "name": "电气一次",
      "docs": 8,
      "notes": 1,
      "archivedAt": "2026-10-23T15:36:49.000Z",
      "restorable": true,
      "reason": null
    }
  ]
}
```

- 只读 `.trash/` 下的一级目录；忽略文件。
- `name` 取归档目录里的 `kb.json` 的 `name`；`kb.json` 缺失/损坏时 `restorable=false`，`reason` 给出原因。
- `archivedAt` 取目录 mtime；`docs`/`notes` 取 manifest（未删除）。
- `.trash/` 不存在时返回 `{ "items": [] }`。

#### `POST /kb/api/trash/:dir/restore`

```json
{ "name": "电气一次" }
```

- `:dir` 是 `GET /trash` 返回的 `dir`（URL 编码）；拒绝 `/`、`..`、控制字符。
- `name` 可选；省略时用 manifest 里的原名。名称经 `sanitizeKbName` 校验。
- 目标 `kbRoot/<name>/` 已存在 → `409 KB_EXISTS`；工作台会弹窗让用户改名后重试。
- 恢复：`.trash/<dir>` 移动到 `kbRoot/<name>`；如果改了名，更新 manifest.name、schema.md H1、index.md；返回 `{ "kb": KbSummary, "restoredTo": "<name>" }`。
- 不自动加入 `.scopes.json`；恢复后用户需要在胶囊里重新选择（Slice 2）。
- 找不到 `.trash/<dir>` → `404 TRASH_NOT_FOUND`；manifest 损坏 → `409 TRASH_INVALID`。

#### `GET /kb/api/kbs/:name/docs`

查询参数：`query`、`type`（可重复或逗号分隔）、`trust`、`status`、`offset`（默认 0）、`limit`（默认 50，最大 200）、`sort`（`title|updatedAt|pages`）、`order`（`asc|desc`）。默认排除软删除文档；`status=deleted` 用于查看软删除文档。

响应：

```json
{
  "docs": [
    { "id": "…", "title": "…", "type": "pdf-scanned", "pages": 120, "chars": 345678, "status": "ready", "trust": "high", "summary": "…", "tags": ["…"], "updatedAt": "…", "deleted": false, "ocrConfidence": 0.93 }
  ],
  "total": 935,
  "offset": 0,
  "limit": 50
}
```

#### `GET /kb/api/kbs/:name/docs/:id`

返回文档元数据（不含正文）：id、title、type、pages、chars、parts、status、version、importedAt、updatedAt、contentSource、summary、summarySource、tags、trust、trustReason、ocrPages、ocrEngine、ocrConfidence、lowConfidencePages、corruptedPages、warnings、sourceFile、deleted。

#### `GET /kb/api/kbs/:name/docs/:id/source`

- 解析文档 `id`，在 `sources/` 下按 `<id>.*` 前缀匹配唯一文件；不存在则 404。
- `Content-Disposition: attachment; filename*=UTF-8''<sourceFile>`。
- 只允许 KB 目录内文件；`realpath` 前缀校验。

#### 上传批次

1. `POST /kb/api/upload-batches`：

```json
{ "kb": "标准", "create": false }
```

响应 `{ "batchId": "b-…", "kb": "标准", "maxBytes": 2147483648, "maxFiles": 1000 }`。

- 批次元数据：`import-tmp/ui-batches/<batchId>/batch.json`，含 kb、createdAt、files[]。
- 若 `create=true` 且库不存在：先创建空库。

2. `PUT /kb/api/upload-batches/:id/files?path=<encodeURIComponent(relativePath)>`

- raw body，`Content-Type: application/octet-stream`。
- `path` 是浏览器的相对路径（目录上传时含子目录），逐段校验：非空、无 `..`、无绝对路径、无控制字符；最终路径必须在批次目录内。
- 限制：单文件 `uiMaxUploadBytes`（默认 2 GiB）、批次 `uiMaxBatchFiles`（默认 1000）。
- 写临时文件后 `rename`，避免半文件；返回 `{ "path": "…", "size": 123 }`。

批次状态：`GET /kb/api/upload-batches/:id` → `{ "batch": { "id": "b-…", "kb": "标准", "status": "open|importing|done|failed", "files": [ { "path": "…", "size": 123 } ] } }`。

3. `POST /kb/api/upload-batches/:id/import`

```json
{ "allowCrossDuplicates": false, "ocrModel": "best" }
```

- 校验批次存在、至少 1 个文件；锁定批次状态 `importing` 防重复提交。
- 启动 `startImportJob`，参数 `files` 形如 `{ sourcePath: stagedAbs, relKey: relativePath, title: basename, sourceFile: relativePath, storedSourcePath: "" }`。
- 返回 `{ "jobId": "…" }`。

4. 清理：导入成功后删除批次目录；失败保留批次目录与 progress 便于排查，启动时清理超过 24 小时的批次。

#### 合并

`POST /kb/api/merge/preview`：

```json
{
  "sources": ["电气一次", "电气二次"],
  "target": { "name": "电气", "create": true, "description": "…" }
}
```

响应：

```json
{
  "plan": {
    "sources": [ { "name": "电气一次", "docs": 8, "deleted": 0 } ],
    "target": { "name": "电气", "exists": false },
    "summary": { "move": 15, "rename": 1, "skipSame": 0, "skipDeleted": 0, "skippedFailed": 0, "notes": 2 },
    "conflicts": [ { "fromKb": "电气二次", "docId": "abc123", "title": "…", "action": "rename", "newId": "def456", "reason": "same-id-different-content" } ],
    "notesAffected": [ { "kb": "电气一次", "docId": "…", "title": "…", "references": ["abc123"] } ],
    "warnings": [ { "code": "IMPORTING", "message": "源库有 1 篇导入中的文档" } ]
  }
}
```

- 预览不写任何文件；不创建目标库。
- 最多返回 100 条冲突/受影响笔记；总数在 `summary`。

`POST /kb/api/merge`：

```json
{
  "sources": ["电气一次", "电气二次"],
  "target": { "name": "电气", "create": true, "description": "…" },
  "confirm": true
}
```

响应 `{ "jobId": "…" }`。若目标库不存在且 `create=false` → 404；若源包含目标 → 400 `MERGE_INVALID`。

#### 标准检查

`POST /kb/api/kbs/:name/std-check`：

```json
{ "action": "check", "force": false, "limit": 0, "dryRun": false }
```

- `action`：`check` | `check-download` | `download`。
- 校验 `name` 在范围内（如果请求带 `session`）？M1：工作台不带会话，标准检查是管理操作，不受胶囊范围约束；胶囊范围只约束 `kb_*` 工具。API 侧不做 scope 校验，但要求库存在。
- 无 `bzCookie` 且请求下载：返回 `STD_NO_COOKIE` 400，提示先配置。
- 返回 `{ "jobId": "…" }`。

#### 任务状态

`GET /kb/api/jobs/:id`：

```json
{
  "job": {
    "id": "kb-import-1",
    "kind": "kb-import",
    "label": "导入 标准: 3 个文件",
    "status": "running",
    "detail": "",
    "startedAt": "…",
    "finishedAt": null,
    "progress": {
      "kind": "import",
      "total": 3, "done": 1, "ok": 1, "fail": 0, "skip": 0,
      "current": "GB_T 1234.pdf",
      "lines": ["OK …"]
    },
    "result": null
  }
}
```

- 进度来自内存 Map + worker 进度文件；任务结束保留 1 小时。
- `status`：`running` | `succeeded` | `failed` | `cancelled` | `stopping`。
- `result` 按 kind：
  - import：`{ fileCount, ok, fail, skip, lines }`；
  - merge：`{ moved, renamed, skippedSame, skippedDeleted, skippedFailed, notesAffected, journal, target, sources }`；
  - std：`{ checked, updates, currents, downloaded, imported, failed, authOk }`。
- 找不到 → 404 `JOB_NOT_FOUND`（可能重启后丢失）。

#### 范围

`GET /kb/api/scope?session=<id>`：

```json
{
  "scope": { "mode": "selected", "kbs": ["标准"], "inheritedFrom": null },
  "resolved": [ { "name": "标准", "docs": 935 } ]
}
```

`PUT /kb/api/scope`：

```json
{ "session": "…", "mode": "selected", "kbs": ["标准", "变电试验"] }
```

- 返回同上。
- 校验库都存在、未归档；`mode=all` 时忽略 `kbs`。
- 不校验 session 是否真实存在（cap 阶段允许先设后建）；但长度/字符校验。

### 7.4 数据模型

#### Manifest v5

在现有 manifest 顶层增加：

```json
{
  "schemaVersion": 5,
  "name": "标准",
  "description": "现行标准、规程、规范",
  "tags": ["标准", "规程"],
  "createdAt": "…",
  "updatedAt": "…",
  "mergedInto": null,
  "mergedAt": null,
  "docs": []
}
```

- `description`：字符串，≤500；默认 `""`。
- `tags`：字符串数组，≤20，单个 ≤32；默认 `[]`。
- `mergedInto`：合并后源库写目标库名；默认 `null`。
- `mergedAt`：ISO 时间；默认 `null`。
- `migrateManifest` 补默认值；`SCHEMA_VERSION=5`；首次写入备份 `kb.json.v4.bak`。
- `listKbs` 返回 `description`/`tags`/`mergedInto`；`kb_list` 的 `kbs` 项带出。
- 不改动 `docs[]` 结构。

#### `.scopes.json`

见 6.2。

#### `.trash/`

归档不是删除，而是把完整知识库目录移入 `<kbRoot>/.trash/`：

```
<kbRoot>/
  .trash/
    电气一次-20261023-233649/
      kb.json
      schema.md
      index.md
      log.md
      sources/
      markdown/
```

- 目录名：`<manifest.name>-<YYYYMMDD-HHmmss>`；同名时间戳冲突时追加 `-2`。
- `.trash/` 以点开头，`listKbs` 天然跳过；`kb_*` 工具按 `kbRoot/<name>` 查找，因此归档库对工具不可见、`kb_query` 的 `*` 也不会搜到。
- 恢复：把目录移回 `<kbRoot>/<name>`；如果改名，更新 manifest.name/schema H1/index。
- M1 不做自动过期清理、彻底删除；`.trash/` 由用户自行管理。

#### 上传批次

`<kb>/import-tmp/ui-batches/<batchId>/`：

```
batch.json        # { batchId, kb, createdAt, files:[{path,size,status}] }
<relativePath>    # 上传文件（保持目录结构）
```

- `batchId`：`b-` + 12 hex。
- 导入开始后 `batch.json` 标记 `status: "importing"`；结束删除整个目录。

#### 合并日志

`<target>/snapshots/merge-<YYYYMMDD-HHmmss>.json`：

```json
{
  "version": 1,
  "createdAt": "…",
  "sources": ["电气一次", "电气二次"],
  "target": "电气",
  "snapshots": [ { "kb": "电气一次", "path": "snapshots/….zip" } ],
  "actions": [
    { "fromKb": "电气一次", "docId": "abc", "newId": "abc", "title": "…", "action": "move" },
    { "fromKb": "电气二次", "docId": "abc", "newId": "def", "title": "…", "action": "rename" }
  ],
  "skipped": [ { "fromKb": "…", "docId": "…", "reason": "same-content" } ]
}
```

- 用于人工回滚和审计；M2 提供"撤销合并"按钮。

#### 任务进度

- `lib/web/jobs.js` 维护 `Map<jobId, progress>`；任务结束时写入 `result`。
- worker 导入：扩展 `worker/import-worker.mjs`，每完成一个文件写 `<kb>/import-tmp/ui-batches/<batchId>/progress.json`（原子写），字段 `{done,total,ok,fail,skip,current}`；API 读取该文件更新 Map。
- 合并/标准：直接在内存更新 Map（无需 worker）。

### 7.5 合并算法

**前置校验**

1. `sources` 非空且去重；目标不在 `sources` 中。
2. 所有源库存在；目标存在或 `target.create=true` 且名称合法。
3. 源/目标没有 `status==="importing"` 的文档；没有正在运行的合并/导入任务作用于这些库（内存 Map 检查）。
4. 目标名不与现有库冲突（创建时）。

**快照**

- 对每个源库与目标库（若存在）调用 `snapshotKb(dir, manifest, { label: "pre-merge" })`；默认 `includeSources=false`。
- 快照失败：中止合并，不移动任何文件。

**规划**

按 `sources` 顺序遍历每个库的文档（跳过软删除与 `status="failed"`；失败文档在报告中列出）：

| 情况 | 动作 |
|---|---|
| 目标无同 id | `move` |
| 目标有同 id，`sourceHash` 相同且非空 | `skip-same` |
| 目标有同 id，两者 `sourceHash` 为空，但 `title`+`type`+`chars` 相同 | `skip-same`（保守） |
| 目标有同 id，内容不同 | `rename`：生成新 id（sha1 前 12 位，避开目标/源全部现有 id 与文件名） |
| 同一批多个源库同 id | 先到先得；后到者按目标当前状态重新判断 |

- 笔记文档同样移动；`sources`/`linksOut` 不重写。
- 生成 `notesAffected`：扫描所有笔记的 `sources`/`linksOut`，若包含将改名的 docId，列入警告。

**执行（后台任务）**

1. 创建目标库（如需要）。
2. 获取目标锁，再按名称排序获取源库锁；任一超时 → 中止并释放。
3. 重新计算规划（防止预览后变化）。
4. 逐个执行动作：
   - `move`/`rename`：`rename` 源文件 `sources/<oldId>.<ext>` → 目标 `sources/<newId>.<ext>`；`rename` `markdown/<oldId>/` → `markdown/<newId>/`；如存在 `history/<oldId>/` 同样移动。
   - 更新 doc：`id`、`sourcePath`（若指向源库内部则改为目标路径；否则保留）、`updatedAt`。
   - 写入目标 manifest（批量，锁内一次写）；从源 manifest 移除（锁内一次写）。
   - 记录 journal action。
5. 重建目标/源 `index.md`（`refreshIndexIfStale` 或显式重建）；追加 `log.md`：`merge: 从 X 移入 N 篇`。
6. 源库 manifest 写 `mergedInto`/`mergedAt`；若源库变空，保留目录与 schema/index/log。
7. 写 journal 文件。
8. 返回结果：`{ moved, renamed, skippedSame, skippedDeleted, skippedFailed, notesAffected, target, sources }`。

**失败回滚**

- 已移动的文件按 journal 逆序 `rename` 回源库；恢复执行前内存中的两个 manifest（用 `writeManifestAtomic`）。
- 回滚失败：保留 journal，任务状态 `failed`，`detail` 给出 journal 路径与手工恢复说明。
- 目标库若为本次新建且失败：尽力删除空目录（仅当没有文件/清单）；否则保留。

**限制**

- 不自动改写笔记引用；只在预览/结果里提示。
- 不迁移 `.std-check.json`；源库缓存留在源库目录，目标库按自身缓存重新检查。
- 不允许合并到自身；不允许源库包含目标库。
- M1 只支持 `mode="move"`；复制模式 M2。

### 7.6 上传/导入任务

- 复用 `startImportJob`，但为 UI 批次增加 `progressFile` 参数。
- `worker/import-worker.mjs` 每完成一个文件写 progress JSON（原子写），字段见 7.4。
- 导入结束后：
  - 成功：删除批次目录；返回报告（ok/fail/skip 明细）。
  - 失败：保留批次目录与 progress，便于排查；24h 后清理。
- 文件元数据：
  - `relKey`：浏览器相对路径（统一 `/`，NFC，小写用于 docId）；保证同一文件重复上传=原位更新。
  - `sourceFile`：相对路径（保留原始大小写），用于展示。
  - `storedSourcePath`：`""`（浏览器路径无意义；docId 由 relKey 决定）。
  - `title`：basename 去扩展名；导入后可用 `kb_retitle` 清洗（M2 UI 入口）。
- 并发：UI 上传并发 2；导入 worker 串行（与现有行为一致）。
- 大小/数量限制：见 7.3。

### 7.7 标准更新任务

- 复用 `runStdCheck`；为其增加可选 `onProgress(event)` 回调（`collect`/`check`/`download`/`import` 四个阶段）。
- API 启动后台任务，更新内存 progress；结束返回 `runStdCheck` 的 report（裁剪掉内部缓存对象）。
- 下载前确认由 UI 负责；API 不强制（但 `action=check-download` 会真实下载，文档中提示）。
- 读取 `.std-check.json` 作为"上次检查/待下载"来源；不返回 cookie。
- 任务结果保留 1 小时。

### 7.8 静态资源与前端

- `ui/index.html`：`<div id="app">` + `<script type="module" src="./app.js">` + `<link rel="stylesheet" href="./style.css">`。
- `ui/app.js`：路由、fetch、渲染、弹窗、toast、轮询；可按 view 拆成 `ui/views/*.js`，但必须保持无构建、浏览器可直接加载。
- `ui/style.css`：CSS 变量、浅色/深色、卡片/表格/弹窗；不引入外部字体/图标库。
- 图标：内联 SVG（`ui/icons.js` 返回字符串）。
- 主题：`prefers-color-scheme` + 手动切换按钮（localStorage 记住）；颜色与 DSH 中性风格接近，不强行读取宿主 token（独立页）。
- 无构建、无 CDN、无运行时依赖；兼容最新 Chrome/Safari/Edge。
- 静态文件按 mtime 设置 `ETag`/`Last-Modified`，`Cache-Control: no-cache`（每次协商），避免升级后旧缓存。

#### 7.8.1 胶囊客户端 bundle

- 文件：`lib/client.js`，手写 CJS factory，无构建：

```js
window.__ModuleLoader__.load({
  id: "dsh-knowledge-base",
  factory: (require) => {
    const React = require("react");
    // ... 组件 ...
    const name = "knowledge-base-ui";
    const inject = ["slots", "locale"];
    function apply(ctx) {
      // ctx.slots.inject("conversation.input.left", () => ctx.slots.register(...))
    }
    return { name, inject, apply };
  },
});
```

- `id` 必须与宿主为该包分配的模块 id 一致：当前 profile 入口是 `dsh-knowledge-base`；若 loader 以 `package.json` 的 name 为准则改为 `dsh-knowledge-wiki`。Spike 阶段确认并记录。

- `package.json`：
  - `exports` 增加：`{ ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" }`；
  - `dsh.client = { platform: "web" }`；
  - `files` 增加 `lib/client.js`、`ui/`。
- 样式：注入一个带固定 id 的 `<style>`，fiber dispose 时移除；不污染宿主全局类名（前缀 `kb-`）。
- 图标：内联 SVG，不依赖宿主 icon 包。
- 主题：优先使用宿主 CSS 变量 `--dsw-alias-*`，取不到时回退到中性色。
- 失败隔离：`apply()` 内 try/catch；slot 不存在/API 404 时只记录一次 `console.warn`，不影响对话 UI。
- `dsh.client.inject` 先留空（只依赖 baseline react/react-dom）；spike 若需要 slot 声明顺序，再加入 `@deepseek-ai/dsh-client-ui-conversation`。

### 7.9 安全

- **信任围栏**：复用 `dsh-better-sidebar` 的 `isTrustedApiRequest(req, trustedHosts)` 逻辑（loopback + `webRuntime.trustedHosts`）；`webRuntime` 不可用时只允许 loopback。
- **CSRF**：变更请求要求 `x-kb-ui: 1`；校验 `Origin` 与请求 host 同源（或 `Sec-Fetch-Site: same-origin`）；不满足 403。
- **上传**：扩展名白名单；逐段路径校验；大小上限；临时文件 + rename；不执行上传内容。
- **下载**：只服务 `<kb>/sources/` 下、属于该库文档 id 的文件；`realpath` 前缀校验；设置 `Content-Disposition: attachment`。
- **密钥**：`bzCookie` 永不返回；状态只返回 `configured: true/false`；日志不打印 cookie。
- **响应头**：`nosniff`、`SAMEORIGIN`、CSP（`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'`）。
- **破坏性操作**：合并/归档/下载标准均需二次确认；合并前快照 + journal；归档进 `.trash/`。
- **范围不是权限边界**：范围是产品约束，用户可通过胶囊修改；真正的权限仍是本机文件系统权限。文档中明确。

### 7.10 性能

- 总览：只读 manifest；9 个库、约 1600 条记录，单次 < 100ms。按 manifest `mtime+size` 缓存 5 秒。
- 文档列表：manifest 内存过滤/分页；不读 markdown。
- 详情：只读 manifest + schema/index 头；`logTail` 只读文件尾部 64KB。
- 上传：流式写盘；不在内存缓冲整个文件。
- 合并：文件 `rename`（同文件系统）为主；跨文件系统时回退 `copy+rm`（并计入进度）。
- 任务轮询：1 秒；页面隐藏时暂停；失败指数退避到 5 秒。
- 前端首屏：一次 `/kbs`；详情懒加载；列表分页。

### 7.11 兼容与降级

- 无 `webServer`：不注册路由；工具照常。
- `webRuntime` 不可用：loopback-only fence。
- 胶囊 slot 不存在：尝试 `conversation.session.header.utilities`；再不存在则不渲染。
- 胶囊 API 404：不渲染；工作台独立可用。
- manifest v4：惰性迁移到 v5；不要求重导入。
- 现有测试：全部保持通过；新增测试不改旧断言。
- 包名/入口：当前目录 `~/.dsh/plugins/dsh-knowledge-base`，`package.json` name 为 `dsh-knowledge-wiki`，profile 入口名 `dsh-knowledge-base`。M1 先按现状验证 `dsh.client` 是否被 web loader 扫描；若因包名不一致不加载，则在 profile 增加 `dsh-knowledge-wiki` 别名入口（只改宿主配置，不改插件数据/工具），并在 README 记录。

## 8. 错误模型

| code | HTTP | 场景 | 用户提示 |
|---|---|---|---|
| `KB_NOT_FOUND` | 404 | 库不存在 | 知识库不存在，可能已被归档 |
| `KB_EXISTS` | 409 | 新建重名 | 同名知识库已存在 |
| `KB_NAME_INVALID` | 400 | 名称非法/为空 | 名称不能为空或包含非法字符 |
| `KB_OUT_OF_SCOPE` | 403 | 工具/接口访问范围外库 | 本会话范围不含该库 |
| `SCOPE_INVALID` | 400 | session/kbs 非法 | 范围参数无效 |
| `SCOPE_WRITE_FAILED` | 500 | 写 `.scopes.json` 失败 | 范围保存失败，请重试 |
| `UPLOAD_TOO_LARGE` | 413 | 单文件/批次超限 | 文件超过上限 |
| `UPLOAD_TYPE_UNSUPPORTED` | 415 | 扩展名不支持 | 不支持该文件类型 |
| `UPLOAD_PATH_INVALID` | 400 | 路径穿越/非法 | 上传路径无效 |
| `BATCH_NOT_FOUND` | 404 | 批次不存在/已过期 | 上传批次已过期，请重新上传 |
| `TRASH_NOT_FOUND` | 404 | 回收站条目不存在 | 归档记录不存在，可能已被恢复 |
| `TRASH_INVALID` | 409 | 归档目录里的 manifest 损坏 | 归档目录无法恢复，请手工检查 |
| `JOB_NOT_FOUND` | 404 | 任务不存在/服务重启 | 任务已结束或中断 |
| `JOBS_UNAVAILABLE` | 503 | 宿主未提供 jobs 服务 | 当前环境不支持后台任务 |
| `MERGE_INVALID` | 400 | 源/目标非法 | 合并参数无效 |
| `MERGE_CONFLICT` | 409 | 并发/锁失败 | 知识库正在被其他任务使用 |
| `STD_NO_COOKIE` | 400 | 未配置 bzCookie 下载 | 请先配置 bzCookie |
| `STD_AUTH_FAILED` | 502 | 站点登录失效 | 标准网登录已失效 |
| `FORBIDDEN` | 403 | 信任围栏/CSRF | 请求来源不受信任 |
| `BAD_REQUEST` | 400 | JSON/参数错误 | 请求参数错误 |
| `INTERNAL` | 500 | 未预期异常 | 内部错误，请查看日志 |

工具侧错误不经过 HTTP，但使用相同 code 文本（如 `[KB_OUT_OF_SCOPE] …`），便于模型和用户识别。

## 9. 测试计划

### 9.1 单元测试

- `test/scope-store.test.mjs`：读写/原子性/清理过期/剔除不存在库/继承/校验。
- `test/scope-resolve.test.mjs`：工具矩阵（表驱动，每个工具在 selected/all 下的 kb 解析）。
- `test/merge-plan.test.mjs`：无冲突、同 id 同 hash 跳过、同 id 不同 hash 改名、多源同 id、软删除、笔记引用。
- `test/merge-execute.test.mjs`：临时 KB 目录，真实移动文件，校验 manifest/index/log/journal；模拟失败回滚。
- `test/kbmeta.test.mjs`：创建空库、简介/标签规范化、manifest v4→v5 迁移、改名同步 scope。
- `test/upload-path.test.mjs`：路径校验、大小限制、扩展名白名单、批次清理。
- `test/web-api.test.mjs`：路由分发、JSON 错误、信任围栏、CSRF 头、404。
- `test/std-progress.test.mjs`：fake `runStdCheck`，进度事件/结果裁剪。

### 9.2 集成测试

- 临时 `kbRoot` + 2 个库 + 若干假文档（md/docx 小文件）；通过 API：
  1. `GET /kbs` 统计正确；
  2. `POST /kbs` 新建；
  3. 上传 3 个小 md → 启动导入 → 轮询完成 → 文档数 +3；
  4. 合并两库 → 源库空、目标库文档数正确、journal 存在；
  5. 写范围 → `kb_list`/`kb_query` 只返回范围内。
- 断言不触碰真实 `kbRoot`（全部在 `os.tmpdir()`）。

### 9.3 手工/浏览器测试

- 打开 `/kb/`：总览、空库徽标、卡片统计。
- 归档一个非空库 → 回收站显示 → 恢复 → 资料数不变；原名冲突时改名恢复。
- 新建 → 上传 → 资料页出现。
- 合并向导：预览/确认/进度/结果。
- 标准面板：仅检查/确认下载/结果表。
- 胶囊：选择 2 个库 → 胶囊显示 2 → 断开 API 后显示降级 → 恢复。
- 深色模式/窄屏。
- Playwright 截图存 `docs/screenshots/`（M1 结束时）。

### 9.4 验收标准

1. 总览的库数/文档数与 `kb_list` 一致。
2. 新建库后无需刷新即可上传。
3. 上传 3 个文件，进度逐文件可见，最终成功/失败数与报告一致。
4. 合并 2 个库后：目标库文档数=源库有效文档数之和-跳过数；源库空且 `mergedInto` 正确；journal 与快照存在；index/log 更新。
5. 胶囊选 1 个库后：`kb_query` 不会返回其他库结果；显式访问其他库返回范围错误。
6. 子代理继承父范围（用一个会派生子代理的任务验证）。
7. 标准"仅检查"不下载；"检查并下载"需确认；无 cookie 时返回 `STD_NO_COOKIE`。
8. 归档空库后总览不再显示，`.trash/` 中有目录。
9. 归档非空库后：总览与 `kb_query` 都不可见；回收站显示名称/文档数；恢复后回总览且能检索；原名冲突时改名恢复成功。
10. headless/desktop profile 下插件工具正常，`/kb/` 不存在。
11. 现有 131+ 测试全部通过。

## 10. 实施阶段（M1）

1. **Spike（1 个任务）**
   - 验证 `dsh.client` 在当前符号链接/包名下能否加载一个 hello-world 胶囊；
   - 验证 `/kb` 路由与 SPA fallback 不冲突；
   - 验证 `agent.ctx.systemPrompt.section` 可用性；
   - 记录结论，必要时调整入口/包名。
2. **数据层**
   - manifest v5 + 简介/标签 + `listKbs`/`kb_list` 带出；
   - `createKb`/`archiveKb`/`listTrash`/`restoreKb`/`updateKbMeta`；
   - `.scopes.json` 读写/继承/清理。
3. **API 层**
   - 路由骨架、信任围栏、CSRF、错误模型；
   - kbs/docs/create/patch/archive/scope/jobs；
   - 上传批次 + 导入任务 + 进度；
   - 合并预览/执行；
   - 标准检查任务。
4. **工作台前端**
   - 布局/路由/样式/组件；
   - 总览、详情、资料、笔记、日志、设置、回收站；
   - 新建/上传/合并/标准/归档/恢复弹窗；
   - 轮询与错误处理。
5. **胶囊**
   - client bundle、slot 注册、弹窗、API 对接、降级。
6. **工具范围层**
   - 解析/校验、错误文案、矩阵逐工具接入；
   - 系统提示段/继承。
7. **测试与文档**
   - 单元/集成/手工/截图；
   - README 增加"工作台"章节、配置说明、限制；
   - 版本 0.19.0。

M2（不在本次）：文档级编辑、lint/体检 UI、导出、回收站自动清理/彻底删除、定时更新、任务模板、内嵌标签页、合并撤销按钮、合并复制模式。

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 客户端 bundle 因包名/符号链接不被加载 | 胶囊不出现 | Spike 先验证；必要时加 `dsh-knowledge-wiki` 别名入口；胶囊失败不影响工作台 |
| `agent.ctx.systemPrompt.section` 在目标宿主版本不可用 | 模型看不到范围提示 | 退化 `agent.inject()`；再不行只靠工具硬约束；在 README 注明 |
| 合并中断/锁冲突 | 数据不一致 | 快照 + journal + 反向移动；要求无 importing 文档；失败保留 journal |
| 合并后笔记引用断链 | 笔记指向旧 docId | 预览提示 + 结果报告；M2 做引用重写 |
| 合并大库耗时长 | 用户以为卡死 | 后台任务 + 进度；文件移动为主；UI 显示阶段 |
| 上传大文件/目录 | 内存/磁盘压力 | 流式写盘、单文件/批次上限、24h 清理 |
| 标准下载消耗金币 | 误操作 | 默认只检查；下载前确认；显示上限；不自动下载 |
| 信任围栏遗漏 | 局域网未授权访问 | 复用 `isTrustedApiRequest`；变更请求 CSRF 头；`/kb` 也走围栏 |
| 工作台 UI 无构建、代码膨胀 | 维护困难 | 按 view 拆分模块；CSS 变量；单文件不超过 2500 行 |
| manifest v5 迁移异常 | 旧库读不了 | 惰性迁移 + `kb.json.v4.bak`；不重写 docs；先在一份副本上测试 |
| 误归档非空库 | 用户以为数据丢失 | 二次确认；归档只移动不删除；回收站可恢复；恢复前不清理 `.trash/` |
| 范围与用户预期不一致 | 模型拒绝回答 | 胶囊明确显示范围；错误文案给出切换入口；默认"全部" |

## 12. 附录

### 12.1 总览线框

```text
┌──────────────────────────────────────────────────────────────┐
│ 知识库工作台        [全部] [有内容] [空库]  搜索…   + 新建   │
│ 9 个库 · 1590 篇 · 11 篇笔记 · 21.2 万页 · 2.69 亿字          │
├──────────────────────────────────────────────────────────────┤
│ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐        │
│ │ ● 标准     ☑  │ │ ● 变电试验 ☐  │ │ ● 电能质量 ☐  │        │
│ │ 现行标准/规程  │ │ 变电检修试验   │ │ 电能质量资料   │        │
│ │ 935 篇 · 4.3万页│ │ 313 篇 · 1.3万页│ │ 132 篇 · 2916页│        │
│ │ ▓▓▓▓▓░░ 类型   │ │ ▓▓▓░░░░ 类型   │ │ ▓▓░░░░░ 类型   │        │
│ │ 高 834 中 39   │ │ 中 313        │ │ 中 131 低 1   │        │
│ │ 更新 10-23     │ │ 更新 10-23     │ │ 更新 10-23     │        │
│ └───────────────┘ └───────────────┘ └───────────────┘        │
│ 选中 2 个 → [合并…] [归档] [清除]                            │
└──────────────────────────────────────────────────────────────┘
```

### 12.2 库详情线框

```text
← 标准   [有失败]   [上传资料] [合并…] [⋯]
┌ 概览 ┬ 资料 ┬ 笔记 ┬ 日志 ┬ 设置 ┐
│ 简介：现行标准、规程、规范        [编辑] │
│ 935 篇 · 6 篇笔记 · 4.3 万页 · 8000 万字 │
│ 类型  ▓▓▓▓▓▓▓▓▓░░  PDF 文字/扫描/混合… │
│ 可信  ▓▓▓▓▓▓▓▓▓▓░  高 834 / 中 39 / 低 61│
│ 健康  1 篇导入失败 · 13 篇软删除          │
│ 最近  GB/T … / Q/GDW …                  │
│ 标准更新：上次检查 10-20 · 待下载 3  [检查]│
└──────────────────────────────────────────┘
```

### 12.3 配置项

在插件 config 增加（全部可选，默认值如下）：

```yaml
uiEnabled: true                # 是否注册 /kb 工作台与胶囊 API
uiMaxUploadBytes: 2147483648   # 单文件上限 2 GiB
uiMaxBatchFiles: 1000          # 单批次文件数上限
scopeInherit: true             # 子会话/子代理继承范围
scopeTtlDays: 30               # 范围记录保留天数
mergeSnapshotSources: false    # 合并快照是否包含 sources（默认否）
```

现有 config 不变。

### 12.4 新增/修改文件清单

```text
lib/web/server.js       新增：路由、静态、围栏
lib/web/api.js          新增：API 处理器
lib/web/scope.js        新增：范围存储
lib/web/jobs.js         新增：任务进度包装
lib/web/http.js         新增：JSON/body/错误/静态工具
lib/merge.js            新增：合并预览/执行/回滚
lib/kbmeta.js           新增：创建/归档/回收站/恢复/元数据
lib/scope.js            新增：工具范围解析
lib/client.js           新增：胶囊 client bundle
ui/index.html           新增
ui/app.js               新增
ui/style.css            新增
ui/icons.js             新增
ui/views/overview.js    新增
ui/views/detail.js      新增
ui/views/trash.js       新增：回收站列表与恢复
ui/views/modals.js      新增：新建/归档/恢复/文档弹窗
lib/store.js            修改：manifest v5、create/archive/listKbs
lib/index.js            修改：工具接入范围、注册 web 路由
worker/import-worker.mjs 修改：progress 文件
package.json            修改：dsh.client、exports、files、版本 0.19.0
test/*.test.mjs         新增/修改
README.md               修改：工作台、配置、限制
```

### 12.5 术语

| 术语 | 含义 |
|---|---|
| 工作台 | `/kb/` 的知识库管理页面 |
| 胶囊 | 输入框旁的知识库范围选择器 |
| 范围 | 本会话允许 `kb_*` 工具访问的知识库集合 |
| 硬约束 | 范围外工具直接报错，不静默降级 |
| 物理合并 | 移动文档到目标库，源库保留为空库 |
| 回收站 | `.trash/` 目录，存放已归档的完整知识库目录 |
| 归档 | 把知识库目录移入 `.trash/`，对工具和搜索不可见 |
| 取消归档 | 把 `.trash/` 中的库移回 `kbRoot/<name>/`，恢复使用 |
| 批次 | 一次上传的一组文件，导入任务以批次为单位 |
| 移动日志 | `merge-<ts>.json`，记录每个文档的 from/to |

## Slice 1 验收记录（2026-10-24）

- [x] `/kb/` 总览 9 个库（`标准` 有效文档 935 = 就绪 934 + 失败 1，43,094 页，80,950,464 字；全部库合计 1,590 篇有效文档、10 篇笔记、21.2 万页、约 2.69 亿字）
- [x] 新建 / 简介与标签 / 重命名 / 归档（含非空库）/ 归档确认名输错被拦截 / 回收站恢复
- [x] 资料分页（50 篇/页，第 1 页 1–50、第 2 页 51–100）、文档详情弹窗、下载原件（HTTP 200，`content-disposition: attachment`，PDF 完整）
- [x] `npm test` 全通过（180 tests / 0 fail）
- [x] 真实浏览器（WebKit/Safari 引擎）1280×900 深色模式与 800×900 窄屏布局均正常
- [x] 回归：`kb_list` 仍返回 9 个库；`kb_read(kb="标准", doc="schema")` 正常
- [x] 已安装进 `~/.dsh/plugins/dsh-knowledge-base`，并用同 profile 的临时 `dsh web --port 55930` 实例做真实宿主复核：
  - `GET /kb/api/status` 200（version `0.19.0-alpha.1`，features.ui=true）
  - `GET /kb/api/kbs` 返回 9 个库；`标准` 934 ready + 1 failed、43,094 页
  - `/kb/`、`/kb/app.js`、`/kb/api.js`、`/kb/style.css` 均为 200
  - `标准` 资料分页 total=935；原件下载 200 + `attachment`
- [x] 桌面端重启后在真实端口 `64276` 复核：status 200、9 个库、静态资源 200、资料 total=935；
  WebKit 渲染 9 张卡片、无 JS 错误
- [ ] 上传/合并/标准/范围（Slice 2/3）

验收说明：功能写流程在 `.acceptance/` 只读镜像上验证（kb.json 复制、sources/markdown 符号链接），
真实知识库根目录未被写入（无测试库、无 `.trash/`）；安装后在真实 DSH 宿主上只做只读复核。
安装前的旧 Web 进程启动于 2026-09-14，Node ESM 模块缓存不会热加载新增的 `lib/web/*` 代码；
桌面端重启后由新进程在 `64276` 提供服务，`/kb/` 已按最终代码正常工作。旧端口 55929 已不再监听。
安装补丁见 `kb-workbench-slice1.patch`。

验收中发现并修复三处问题：

1. **DSH 的 prefix 语义**：`prefix: p` 只命中 `p` 或 `p/<anything>`，最长前缀优先；
   原计划的 `prefix: "/kb/"` 只能命中 `/kb/`，静态资源与 API 都 404。改为 `prefix: "/kb"`
   （静态壳）与 `prefix: "/kb/api"`（JSON API），并加回归测试。
2. **挂载前缀归一化**：宿主可能传完整 URL，也可能传剥掉前缀的 URL；`relativeUiPath` /
   `relativeApiPath` 统一两种形式，避免静态文件被截成 `js`、API 被当成根路径。
3. **toast 生命周期**：toast 原本在 `#app` 内，任何一次 `render()` 都会清掉；改为挂在
   `body` 上，保存简介/重命名/恢复的提示才能稳定显示。
