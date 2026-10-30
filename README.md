# dsh-knowledge-wiki — DeepSeek Harness 知识库插件

把 Word / PPT / Excel / PDF（文字版与扫描版）等资料整理成**适合大模型阅读、学习的形式**，
存放在**固定、可命名、可导出、可持续修订**的知识库中；deepseek 通过一组 `kb_*` 工具
随时调用知识库内容进行问答、推理、整理、课件与文档制作等工作。

## 能力

| 工具 | 作用 |
| --- | --- |
| `kb_import` | 导入文件或目录（.docx / .doc 自动转换 / .pptx / .xlsx / .xlsm / .pdf / .md / .txt / .epub / .mobi / .azw3，扫描版 PDF 自动逐页 OCR 中文，自动识别文字层损坏页并只对问题页 OCR，文字层双栏页自动重排；Word OMML 公式转 LaTeX；Excel 按工作表转 Markdown 表格；.txt 自动识别 UTF-8/UTF-16/GBK；MOBI/AZW3 自动经 Calibre 转 EPUB）。旧版 .doc/.ppt 与 MOBI/AZW3 一律在后台任务中转换；正在导入中的同名文档自动跳过。**导入前自动查重**：同库重合跳过、跨库重合默认跳过并报告（见下文）；标准/书籍正文/封面优先，其他资料只用文件名 |
| `kb_reparse` | 从库内 `sources/` 重新解析文档（无需重新上传），用于 OCR/解析器升级后刷新旧管线产物；`doc` 单个、`all=true` 批量，支持 `forceOcr`、`forceOcrPages`/`skipOcrPages`、后台任务 |
| `kb_list` | 列出知识库 / 知识库内文档与状态（旧管线/已修订/文字层损坏/OCR 低置信会标注），每条带一行摘要与标签；省略 `kb` 时只列本会话范围内的库；默认最多 50 条，支持 `limit/offset/query/status/kind` 分页过滤（`kind=note` 只看笔记、`kind=source` 只看资料）；本库有维护规范时会提示 |
| `kb_query` | 全文检索（纯文本优先 FTS5/BM25 条款索引，正则/索引不可用时回退 ripgrep；中文短语直接搜；标准号自动兼容 GBT=GB/T=GB_T=GB∕T 与年份分隔符变体）；按标题/标题行/命中密度/更新时间排序，每文档默认 5 条；`kb="*"` 跨库检索；限定模式下省略 `kb` 检索范围内全部库；命中项带 part、页码、条款与笔记类型；返回结构化 `sources`（含深链）供界面引用 |
| `kb_read` | 按分块精读、读大纲、读整篇；大纲条目带页码/部分，读取时返回页码范围与结构化 `sources`；支持虚拟页 `doc="schema"`（维护规范）、`doc="index"`（内容索引）、`doc="log"`（操作日志），按 part 分页读取 |
| `kb_view` | 查看原始页面图片（PDF 按页渲染；Word/PPT/EPUB/MOBI 提取内嵌图）——公式、原理图、电路图专用 |
| `kb_edit` | 精确替换修订（持续修改完善）；`doc="schema"` 可修订该库维护规范（index/log 自动维护，不能编辑） |
| `kb_describe` | 给文档写一行摘要与标签（编目）：摘要会显示在 `kb_list` 与 `index.md`，重解析/重导入不会覆盖模型写的摘要；存量文档可 `all=true` + `auto=true` 批量回填缺失摘要（抽取式，不递增版本号，`limit` 分批） |
| `kb_retitle` | 修正标题：单篇传 `doc`（默认按 `cleanTitle` 去掉站点域名、`GB_T`、序号、span 残留等噪声），批量传 `all=true`（默认 `dryRun=true` 只预览，确认后 `dryRun=false` 应用）；会重建合并版首行标题、保留历史、版本+1 |
| `kb_trust` | 标注来源可信度：`high`（已发布现行标准、正式教材）/ `medium`（企业文件、培训资料、报批稿）/ `low`（草案、征求意见稿、已废止标准）/ `unknown`（清除）；支持单篇、`docs` 列表、`all=true` + `query`/`stage` 过滤（批量默认 dryRun）。检索会优先高可信、标注低可信并提醒用户 |
| `kb_lint` | 机械体检：导入失败、旧管线、文字层损坏/OCR 低置信、内容重复、同标准号同期同阶段重复、同号多版本、正文完整性/文件名与封面不一致、未编目、笔记无来源、续/修订版提示、无入链笔记、临时/锁文件（`~$*`、`.~lock.*`、`Thumbs.db`/`desktop.ini`/`.DS_Store`）、缺 schema；输出分组问题与建议动作（`kb_reparse`/`kb_describe`/`kb_remove`/`kb_edit`）；限定模式下省略 `kb` 逐库体检 |
| `kb_edit_batch` | 批量精确修订（事务语义）：一次提交 1–50 条 `{doc, old_string, new_string, replaceAll?}`，**先全部校验再写入**；任一条失败整批不改并回滚已写分块；`dryRun=true` 只校验。适合“一次改 10–15 页”的跨文档维护；同一文档一批只允许一条编辑 |
| `kb_snapshot` | 库级快照：把 `kb.json`、`schema/index/log`、派生 `markdown/`（可选 `sources/`）打包到知识库 `snapshots/`，用于批量编辑/重解析前留档；`list=true` 列出已有快照 |
| `kb_add_note` | 写入编译页/笔记（单篇上限 2MB）：`kind=summary/entity/concept/topic/note`、`tags`、`sources`（docId#页码 或 [[标题]]）；**同一标题再次调用=更新同一篇**（版本+1、保留历史），不要用「续」「修订版」另起新页 |
| `kb_remove` | 删除文档（默认软删除，可用 `kb_restore` 恢复；`soft=false` 永久删除）或整个知识库（删整库需显式 `kb` + `removeKb=true` 且 `confirm` 逐字等于知识库名称） |
| `kb_restore` | 恢复软删除文档（不带 `version`）或恢复历史版本（`version=N`，来自 `kb_history`） |
| `kb_history` | 列出文档保存过的历史版本（覆盖导入/重解析/编辑前的快照，最多 10 个） |
| `kb_export` | 导出 md（单文件）/ jsonl（分块，RAG 用；`chunkSize`/`chunkOverlap` 可切 RAG 小块）/ zip（完整包，内置 JSZip 打包，不依赖系统命令）/ **vault**（Obsidian Vault：`index.md` + `wiki/` 笔记与资料页 + `[[双链]]`，`includeSources=true` 时带 `raw/`） |
| `kb_rename` | 重命名知识库（`kb` 必填，须在本会话范围内） |

大文件（如整本扫描书）导入自动转为**后台任务**，与内置 `job_list` / `job_output` 联动查看进度；
取消后台任务会在 `job_output` 中显示为 cancelled。后台任务会写逐文件统计：
**只要有文件失败，任务状态就是 `failed`（详情写明“部分失败：成功 X，失败 Y”）**，不再把部分失败显示成完成。
长任务每 60 秒刷新一次 `heartbeatAt`（不改文档 `updatedAt`）；进程崩溃后，残留的 `.lock`
带 owner PID，下一个操作可在 PID 消失且锁超过 60 秒时快速回收，不必等满 30 分钟。

**旧版 .doc 自动转换**：Windows 用本机 Microsoft Word（COM 自动化，无对话框、禁宏）；
macOS 用自带 `textutil`；Linux 可用 LibreOffice。未装任何转换工具时会给出明确提示。

## 知识库存储结构（默认 `~/.dsh/knowledge/<知识库名>/`）

```
kb.json                    清单：文档列表（id/标题/类型/页数/大纲/版本/状态/
                           sha256/解析管线版本/contentSource/OCR 元数据/
                           summary·tags·笔记 kind/sources/linksOut）
schema.md                  维护规范（每库可定制；建库导入时写入模板）
index.md                   内容索引（清单自动渲染：笔记在前、资料在后，每条一行摘要）
log.md                     操作流水（只追加：ingest/edit/note/describe/remove/restore…）
sources/<docId><ext>       原始文件（逐字节保留）
markdown/<docId>/<docId>.md   合并版（整篇通读）
markdown/<docId>/parts/NNNN.md 分块版（检索、精读、RAG）
markdown/<docId>/parts/index.json 分块索引（合并版行号 → part/页码）
markdown/<docId>/pages.json   逐页质量（文字层/OCR、损坏标记、置信度）
exports/                   导出产物
```

- **知识库名称**：`kb_import` 的 `kb` 参数决定（可含中文），不存在即创建。
- **持续修改**：同名文件且内容未变 = **跳过不重跑**（返回 `skippedUnchanged`）；内容变化
  或 `forceReparse`/`kb_reparse` 时原位更新（版本号 +1）。`kb_edit` 精确替换并标记
  `edited=true`；`kb_add_note` 写编译页（同标题再次调用=更新该笔记）。清单会记录每个文档的 `sourcePath`：**同一路径**重复导入是原位更新，
  不同目录下的同名文件（如 `A/通知.pdf` 与 `B/通知.pdf`）会另建文档，不会互相覆盖。
  旧版本清单没有 `sourcePath` 的条目无法追溯来源，首次重导仍按原位更新，并在导入结果的
  warnings 里提示一次；担心覆盖时请先备份或导入到新库，重导一次后就会记录来源路径。
- **导出**：md 适合直接上传对话类产品（目录带摘要，笔记带 YAML frontmatter）；jsonl 适合 RAG 管道；
  zip 是完整可迁移包（含 README、`index.md`/`schema.md`/`log.md` 与全部 markdown，
  `includeSources=true` 时含原始文件）。
  zip 用 `generateNodeStream` **流式写盘**，不会把整包（含原始文件）先读进内存；
  导出清单剥离本机 `sourcePath`，失败条目整条略过。

## 知识库工作台（0.20.4）

插件在 web profile 下提供 `/kb/` 工作台（可通过配置 `uiEnabled: false` 关闭）：

- 总览：库卡片、简介、文档/笔记/页数/字数、类型与可信度分布；
- 新建知识库、编辑简介/标签、重命名、归档（含非空库，移动到 `.trash/`）；
- 回收站：列出归档库，支持恢复（原名冲突时可改名恢复）与彻底删除（需逐字输入库名确认，删除后磁盘文件不可恢复）；
- 库详情：概览 / 资料 / 笔记 / 日志 / 设置 / 标准更新；
- API：`GET /kb/api/status|kbs|kbs/:name|kbs/:name/docs|...`。

打开方式：在浏览器访问 `http://127.0.0.1:<dsh-web-port>/kb/`（端口见 `dsh web` 启动行）。

工作台支持直接在浏览器里上传资料：选文件 / 选目录 / 拖拽文件 → 逐个上传（并发 2）→ 后台导入；
目标库可在上传前切换；导入标题自动按 `cleanTitle` 去掉站点域名、`GB_T`/序号等噪声；逐文件进度与报告可见，
失败可重试。扫描件可选 OCR 精度（best 更准 / fast 更快）与「强制 OCR」（文字层损坏时）。批次临时目录在
导入成功后删除、失败保留 24 小时供排查（过期批次在新建批次时清扫）。单文件与单批次上限见配置
`uiMaxUploadBytes` / `uiMaxBatchFiles`。

- 上传/导入会自动跳过 Office 所有者文件（`~$…`）、LibreOffice 锁文件（`.~lock.…`）与
  `Thumbs.db` / `desktop.ini` / `.DS_Store` 等系统垃圾文件，并在上传面板与导入结果里报告
  「已跳过 N 个临时/锁文件」；普通 `.tmp` 文件不跳过。

「标准更新」面板（库详情 tab）：读取 `.std-check.json` 的上次检查时间、缓存有效期（TTL 7 天）
与待下载数（有新版 / 草案转正 / 可补下载）；支持仅检查 / 检查并下载 / 补下载 / 强制全查 / 本轮上限，运行中可取消（当前正在处理的标准完成后停止，之后不再发起新的下载）；
下载前必须勾选金币确认（每个标准约 6 金币，VIP 免金币）；`bzCookie` 只在状态里显示“已配置 / 未配置”，
不会回传给浏览器。

当前版本仍不支持合并知识库；后续版本再加入。

### 实现偏差 / 已知限制（0.20.4–0.22.0）

- 拖拽只接收**文件**，不做拖拽文件夹递归；整理整个目录请用「选择目录」。
- 资料列表沿用按标题排序，不支持按更新时间排序；导入完成在弹窗内直接给出逐文件结果。
- 失败批次仅用于排查：没有删除或重试**失败批次**的 API（`DELETE` 只接受未开始导入的 open 批次），
  目录保留至清扫；重试是客户端用本地失败文件重新上传。
- 批次 24 小时过期由「创建批次」触发清扫（create-triggered），不是后台定时任务。
- `refreshKbIndex` 仍留在 `lib/import-job.js` 的导入收尾里，尚未拆成独立模块。
- UI 没有真实浏览器 DOM 测试：资料工具栏（搜索防抖/输入法/跳页/清除/焦点）用 fake DOM 单测
  （`test/ui-docs-controls.test.mjs`），胶囊用 `node:vm` 跑 `lib/client.js`；样式、真实焦点顺序与
  布局仍需手工验收，另有 `scripts/check-ui.mjs` 的语法门禁。
- 范围只约束 `kb_*` 工具：工作台 HTTP API 与 UI 不受范围影响（范围不是权限边界）。
- `kb_edit_batch` / `kb_add_note` 为单库策略：范围有多库时必须显式 `kb`，不做跨库事务。
- 切换范围会改写一次 system prompt 前缀（同一范围下前缀稳定）；范围变更在下一轮模型步生效。
- `restoreKb` / `removeKbDir` 未做范围同步；失效库名由读取时清理（prune）兜底。
- 胶囊只注册在 `conversation.input.left`；`conversation.session.header.utilities` 未接入。

## 0.25.0 回收站增强与 CI

回收站的已删除资料支持跨库批量彻底删除、搜索与排序，并可按天自动过期清理；仓库新增 GitHub Actions，
跑单元/构建门禁与真实浏览器 E2E。

### 跨库批量彻底删除

- 「已删除资料」多选不再限制同一个库：勾选来自不同库的条目后仍可点 **彻底删除所选**。确认弹窗要求逐字输入
  **`彻底删除 N 篇`**（N 为去重后的篇数）；有重复条目时按勾选数输入也接受。服务端做同样校验，不一致回
  `400 CONFIRM_REQUIRED`。
- 行内单篇彻底删除仍走本库接口，逐字输入 **库名** 确认；资料页「清空本库已删除资料」同样输入库名。本库单篇/清空
  与跨库批量一样在清单锁内复验已删除状态（`requireDeleted`）。
- 删除前对**全部条目做只读预检**：库不存在/已归档（原目录不在活跃库中）、资料不存在或不在回收站（例如在用资料）都会
  **整批拒绝**（`409 KB_NOT_FOUND` / `409 DOC_NOT_DELETED`，`details` 带首个问题条目），合法条目也不会被提前删掉。
- 逐篇删除都在清单锁内**复验仍在回收站**：预检后到真正删除前被恢复（或重新进入导入）的条目拒绝删除，按
  「彻底删除失败：文档已不在回收站」计入 `failed` 并继续；不会因为并发恢复回 500。
- 预检通过后逐篇 `removeDoc(..., { requireDeleted: true })`；单篇失败不中断其余条目，返回 `{purged, failed, byKb}`，失败项只带库、标题与固定文案
  「彻底删除失败」，不跨 API 回传本机路径。每篇写所属库日志 `remove`（detail「彻底删除（跨库批量）」），
  每个受影响库刷新一次 `index.md`；日志/索引是附属写入，失败不会回滚已完成的永久删除。
- 单次最多 **500 篇**；`items` 为空、缺 `kb`/`id`、超过上限都是 `400 INVALID_ARGS`。请求仍要求工作台写头与同源。
- HTTP：`POST /kb/api/trash/docs/purge`，body `{items:[{kb,id}], confirm}`。

### 搜索与排序

- 「已删除资料」工具条新增搜索：对**库名、标题、类型、来源文件**做大小写不敏感子串匹配；输入 **300ms 防抖**，
  `Enter` 立即搜索；输入法组合期间不发中间请求，`compositionend` 后立即应用并恢复焦点。
- 排序下拉：**删除时间（新→旧）**（默认）/ **删除时间（旧→新）** / **标题 A→Z** / **标题 Z→A** /
  **库名 A→Z** / **库名 Z→A**。切换排序立即请求并清空当前选择；未知/非法 `sort` 回落默认值，响应回显解析后的 `sort`。
- 过滤和排序在截断前对全量已删除资料执行：`total` 是命中总数，列表最多 **500** 篇，超出时显示「仅显示前 500 篇」。
- 搜索命中 0 篇显示「没有匹配的已删除资料」并提供 **清除搜索**；回收站本来为空则显示「没有已删除的资料」。
- 排序稳定性：删除时间相同或标题/库名相同时按「库名 + id」兜底；`deletedAt` 缺失/非法的行始终排在最后。
- HTTP：`GET /kb/api/trash/docs?query=&sort=`，响应额外返回归一化后的 `query` 与 `sort`。

### 自动过期清理

- 新配置 `trashRetentionDays`：默认 `0`（关闭），允许 **0–3650** 天。配置为 N 后，**工作台启动时**与
  **访问回收站时**（同一 `kbRoot` 每小时最多扫描一次，进程内节流）永久删除 `deletedAt` 超过 N 天的普通
  软删除资料。
- **跳过跨库移动留下的源库墓碑**（带 `movedTo` 的行）：撤销移动还要依赖它，即使过期也不自动清理，只能手动处理。
- 只扫描活跃（非归档、非合并）库；`deletedAt` 缺失或**不是 ISO 日期时间**（`YYYY-MM-DDTHH...`）的行无法判断年龄，
  跳过并计入 `skipped`；单篇删除失败（含锁内复验时已被恢复/重新导入）也计入 `skipped` 并继续处理其余条目。
- **单轮最多清理 500 篇**：达到上限即停止，返回 `capped=true`（表示可能还有未处理条目）；`byKb` 只统计实际删除的条目。
- 删除调用同样传 `requireDeleted: true`，锁内复验已删除状态；重新导入已软删除资料时 `markImporting` 会清除
  `deletedAt`/`deletedFromStatus`，导入期间不会被回收站列表、自动清理或批量彻底删除选中。
- 每篇写日志 `remove`（detail「自动清理（超过 N 天）」），有变动的库刷新一次 `index.md`；清理失败不影响工作台启动与
  回收站列举。目前只有配置入口，没有 UI 开关，也不是后台定时任务。

### CI / E2E

- `.github/workflows/ci.yml` 两个 job：
  - `unit`（ubuntu-latest）：`npm ci` → `npm run typecheck` → `npm test`。
  - `e2e`（macos-14）：安装 `@deepseek-ai/dsh@0.2.1-rc.2` → 用临时 `DSH_HOME` 首次启动 `dsh web` 生成 profile →
    用 `install-to-machine.sh` 注册本仓库 → 安装 Playwright WebKit → 跑 `npm run test:e2e`；失败时上传
    `test/e2e/.artifacts`（目录以 `.` 开头，workflow 用 `include-hidden-files: true` 才会收集）。
- 全新 CI profile 没有历史会话/模型凭据：胶囊用例自动 **skip** 并说明原因；工作台/回收站/搜索排序/移动/重试/预览用例
  照常执行，其余失败仍会让 job 红。
- 本地有真实 profile 与凭据时跑完整套件（当前 12 项；来源面板在 CLI 0.1.x 会 skip）；CI 为核心用例通过 + 胶囊/来源面板按宿主 skip（Office 可选预览在无转换引擎时也会 skip）。
- E2E 宿主兼容两种 profile 布局：优先 profile 自带 `node_modules`，否则使用 `profiles/node_modules` 共享目录；
  全新 CI profile 缺 `pnpm-lock.yaml` / `pnpm-workspace.yaml` 时跳过，不再启动失败。

### 已知限制（0.25.0）

- 自动清理对跨库移动墓碑不生效（`movedTo` 还要用于撤销移动），需要手动彻底删除；撤销移动后墓碑消失，才会进入普通清理范围。
- 跨库批量彻底删除仍逐篇调用 `removeDoc`，不是多库事务；单篇失败保留在 `failed` 里，需要人工重试。
- E2E 胶囊用例在全新 profile（无历史会话/模型凭据）自动 skip，CI 不覆盖胶囊交互。
- Chromium 下载在部分网络/CDN 不可用；E2E 套件优先 WebKit，只装 WebKit 也能跑。

## 0.26.0 资料元数据、摄取规范化与引用溯源

**人工编目与标签筛选**：工作台资料弹窗可直接编辑**标题、摘要与标签**，保存走
`PATCH /kb/api/kbs/:name/docs/:id/metadata`，服务端把 `summarySource` 标为 `manual`；
人工标题写 `titleSource=manual`，重新导入/重解析也不会被自动标题覆盖。人工摘要不会被
重新导入/重解析降级（优先级 manual > model > auto）。资料页新增标签下拉与
行内标签按钮，支持 `GET /docs?tag=` 筛选和 `facets.tags` 计数。

**摄取元数据**：导入时保存 `rawTitle/canonicalTitle/standardNo/Year/Part/Stage`、
`sourceHash`、`textHash`、`contentIntegrity`、`trust` 启发式与 `trustSource`。
标准/书籍允许**正文/封面优先**：文件名写 `GB`、封面写 `GB/T` 时按封面处理；但必须同时比较
正文完整性，封面完好、正文缺失（`cover-only/partial`）不会被当成完整版本。
其他资料（通知、台账、图纸、普通 md/txt/note）只用文件名/标题，不做正文优先。

**去重**：`sourceHash + 标准号+年+部分+阶段 + textHash + 标题 key`；同号不同阶段
（征求意见/报批/发布）不算重复。完整版不会被残缺版挡住，残缺版也不会覆盖完整版。
旧库可用回填脚本补齐身份元数据：

```bash
node scripts/backfill-doc-meta.mjs --root ~/.dsh/knowledge --kb 标准 --dry-run --hash --std --content --text
node scripts/backfill-doc-meta.mjs --root ~/.dsh/knowledge --kb 标准 --apply --hash --std --content --text
node scripts/backfill-doc-meta.mjs --root ~/.dsh/knowledge --kb 标准 --dry-run --retitle
node scripts/backfill-doc-meta.mjs --root ~/.dsh/knowledge --kb 标准 --dry-run --normalize-titles
node scripts/tag-doc-library.mjs --root ~/.dsh/knowledge --kb 标准 --dry-run
```

`--retitle` 只改明显格式噪声；`--normalize-titles` 处理书名号/括注标准号/裸标准号标题，
按「标准号 名称」重排，保留报批稿/征求意见稿并清理“上传版(1)”等后缀。
真实「标准」库（911 篇）已回填：911 篇 ready、904 篇有来源；结构化标准号 850 篇、
正文元数据 860 篇，标题规范化覆盖全部 904 篇来源文档，**裸标准号 0**（本轮从 254 篇补到 0；含 84 篇封面/首屏、47 篇 PDF 字号、40 篇英文 IEC/EN 封面，其余按系列/已知名称补全）；
历史 11 组同号重复未保留项和 1 篇发布通知已由用户彻底删除；当前 0 篇 deleted。
回填前清单备份在 `/tmp/kb-standard-20261025-before-font-titles.json`。`DL/T587—2025+…` 已规范为
`DL/T 587-2025 继电保护和安全自动装置运行管理规程`；`GB 19963.2-2024` 与
`GB/T 19963.2-2024 …` 已用同族完整标题补全，便于人眼区分。

**标签**：`scripts/tag-doc-library.mjs` 按标准前缀标「国家标准/行业标准/企业标准/团体标准/
国际标准」，按标题/摘要标「电能质量/继电保护/变压器/变电试验/绝缘/新能源/直流输电」；
只增人工标签、移除已不匹配的旧自动标签。当前 911 篇中 871 篇有标签，分布：
国家标准 367、行业标准 252、电能质量 233、企业标准 138、国际标准 92、新能源 103、
变压器 49、绝缘 38、继电保护 30、直流输电 16、变电试验 7、团体标准 5。
仍无标签的 40 篇主要是 7 篇笔记、索引/手册、附件/通知，以及暂无标准号的草案；
不强行归类。

**上传状态**：上传弹窗明确区分「上传中（文件尚未解析）」「已上传，待解析」「解析中」
「解析完成」「上传失败」「上传完成，解析未完成」「没有新资料（全部重复）」；
逐文件显示重复跳过原因，不再把「文件已上传」显示成解析完成。

**引用与溯源**：`kb_query`/`kb_read` 返回结构化 `sources`
（`kb/docId/title/page/clause/snippet/deepLink`），并通过 `presentationMeta` 交给客户端；
笔记自身的依据来源仍在 `noteSources`（0.26 起 `sources` 专指“本轮引用来源”）；
聊天里 `kb_query`/`kb_read` 工具行与每轮末尾的「本轮来源」面板可点击：
来源卡片在聊天内直接打开原件预览弹窗，不再跳转整个工作台：PDF/Office 通过服务端
`viewer.html` iframe 连续滚动全部页面；viewer 自带页码/缩放/旋转/下载/打印工具栏。
`kb_query` 自动携带查询词；`kb_read` 新增 `keywords` 参数，模型应把用户问题提炼的
2–6 个检索词传入。viewer 只高亮这些**检索关键词**（不把条款号当关键词），并滚到命中最多的一页；
页码不再作为强依赖。
WebKit 原生 PDF iframe 会下载/空白，故用逐页 PNG 组成的 HTML viewer；文本/图片/笔记走
`source?inline=1` 或 `content`。旧文档的 `parts/index.json` 页码已回填 748 篇；
`kb_read` 引用页按条款在分块中的实际页计算，旧 source meta 也会按 clause 反查页码和关键词。
工作台本身仍支持 `/kb/?kb=&doc=&page=&clause=` 深链，PDF/Office 预览会追加
`#page=N&zoom=page-fit`。本轮**不做** assistant 正文角标：宿主当前没有非破坏性的
assistant 文本注解槽，替换 `assistant-step` 会 shadow 官方 Markdown 渲染。

**检索（#4，FTS5 核心已接入）**：条款级分块 + SQLite FTS5/BM25、中文分词、token 预算与引用格式、
向量/rerank 评估门槛见 `docs/specs/2026-10-25-kb-metadata-ingest-sources-design.md` §8；
`lib/clauses.js`（条款切分）与 `lib/fts-index.js`（SQLite FTS5/BM25）已实现，并接入
`kb_query`：纯文本查询优先 FTS5，正则/索引不可用/无命中回退 ripgrep。当前真实「标准」库
索引 911 篇、14.95 万条款、224MB；增量同步、后台构建和 60 条机制评测已完成：Doc/Page Recall@10 95%，MRR 0.761，p95 47.5ms；见 `docs/specs/2026-10-25-retrieval-eval.md`。

### 已知限制（0.26.0）

- **PDF viewer/关键词高亮**：`viewer.html` 只服务聊天来源面板，工作台预览仍是原生 PDF iframe
  （WebKit 可能下载/空白）；viewer 与 `/page.png` 没有单测覆盖（0.28 已全部补齐）。扫描件原件没有文字层，
  `p.search()` 不命中，高亮会**静默为 0**（OCR 文字只在 markdown 里）；每页最多 240 个高亮框，
  超出静默截断；每次打开都把整份 PDF 读进内存。
- **标准号检索回归**：`GB/T 1234` 这类带斜杠写法被判为纯文本走 FTS，`gb` 命中几乎所有标准，
  GB 与 GB/T 不分（0.27 已修复，见下文）。
- FTS 查询是 token OR，多词精度靠 BM25；「标准」库索引 911 篇约 220MB；跨库首查会后台建索引。
- 来源面板 E2E 在 CLI 0.1.x 宿主 skip（历史投影不关联 `tool/result`），仅由单测覆盖。
- 其余 6 个库没有 standardNo/标签（回填只做「标准」）。
- `docs/specs/2026-10-25-retrieval-eval.md` 是机制回归（查询取条款原文开头 28 字），不是人工语义评测。


## 0.31.0 可选语义层（运行时收口；默认关闭）

> 当前进度：本轮先落地**运行时、分发与复验**（可选依赖 + 模型 + 向量一致性）；检索接入、索引与
> 80 题回归在后续提交完成。接入前后插件行为一致：`kb_query` / `/kb/api/search` 走 0.30 的 B 路径，
> 不加载任何模型、不读写向量索引。

**运行时（D1a 瘦身版，已定）**：`onnxruntime-node`（预编译 N-API 原生二进制）+ 
`@huggingface/tokenizers`（纯 JS WordPiece）；模型 `Xenova/bge-small-zh-v1.5` 的 `onnx/model.onnx`
（fp32，94.8MB，512 维）。查询侧加中文检索指令「为这个句子生成表示以用于检索相关文章：」，
文档侧不加；池化取 CLS（首个 token），L2 归一化。决策与 spike 证据见
`docs/specs/2026-10-31-semantic-runtime-adr.md`。

**打包策略：可选 peer（不随插件默认安装）**

- `package.json` 用 `peerDependencies` + `peerDependenciesMeta.*.optional = true` 声明
  `onnxruntime-node ^1.31.1` 与 `@huggingface/tokenizers ^0.2.0`。`npm ci` / `npm install`
  **不会**装这两个包（实测 `npm ci` 后 `node_modules` 里没有它们），所以 293MB 原生依赖只影响
  主动启用语义层的机器。
- 启用语义时在插件目录安装（`--no-save`：不写插件 `package.json`，升级插件不会被覆盖或冲突）：

  ```bash
  cd ~/.dsh/plugins/dsh-knowledge-base
  npm i --no-save onnxruntime-node@^1.31.1 @huggingface/tokenizers@^0.2.0
  ```

  运行时用 `import("onnxruntime-node")` / `import("@huggingface/tokenizers")` 探测；任一缺失、
  模型缺失或索引不可用 → 语义层关闭并**完全回退 0.30 的 B 路径**（默认 `semanticSearch=off`）。
- 模型放 `~/.dsh/tools/models/bge-small-zh-v1.5/`：`model.onnx`、`tokenizer.json`、
  `tokenizer_config.json`（合计约 95MB）。默认不联网下载，下载命令见 ADR §5。

**本机实测（macOS arm64 / Node 26.7.0 / onnxruntime-node 1.31.1 / tokenizers 0.2.0）**

| 项 | 实测 |
|---|---|
| 依赖体积 | onnxruntime-node **293MB**（darwin 87 / linux 70 / win32 136，三平台预编译二进制随包）；@huggingface/tokenizers 0.6MB |
| 模型体积 | 95MB（model.onnx 94.8MB + tokenizer.json 0.4MB） |
| session 加载 | **64ms** |
| 查询嵌入 | **p50 2.63ms / p95 2.92ms**（batch=1，含 tokenize + 推理 + CLS 池化 + L2） |
| 文档嵌入 | 12.6ms/篇（batch=8，平均 244 token）→ 911 篇约 **11.5s**（索引构建计划放后台进程） |
| 常驻内存 | 加载后 RSS **239MB**；仅查询稳态约 260MB；批量嵌入 911 篇峰值约 476MB（不在服务进程常驻） |
| 与 0.30 向量一致性 | 80 条查询余弦**最小 0.999999**；40 篇文档余弦**最小 0.999998**（门槛 >0.99） |

**已知限制（install script 策略）**

- npm 11 的 allowScripts 策略默认不执行 `onnxruntime-node` 的 `postinstall`。全新环境安装时会提示
  `npm warn install-scripts ... onnxruntime-node@1.31.1 (postinstall: node ./script/install)`。
  该脚本只下载**没有随 npm 包发布**的执行提供者二进制（linux/x64 的 CUDA/TensorRT、win32 的 GPU 包）；
  CPU 推理所需的二进制已随包内 `bin/napi-v6/{darwin,linux,win32}` 提供，**不执行脚本不影响 CPU 推理**
  （本轮实测都在未执行脚本的环境完成；darwin 的安装清单为空，脚本本身是 no-op）。
- 需要让脚本执行：`npm install-scripts approve onnxruntime-node`。pnpm 10+ 默认拦截安装脚本，
  会提示 `pnpm approve-builds`（本仓库的 esbuild 同理）。**不建议**在 linux/x64 上放行：
  会额外从 NuGet 拉 CUDA/TensorRT 运行库（数百 MB），与纯 CPU 语义检索无关。
- 唯一的原生依赖是 `onnxruntime-node` 的预编译 N-API 二进制（napi-v6，ABI 稳定），不需要本机编译
  工具链；Node ≥20 可用（实测 Node 26.7.0）。三平台二进制都打进包，安装体积固定约 293MB，
  安装脚本也不会裁剪它。

## 0.30.0 文档级语义融合评测与高亮提示修复

**评测结论（新）**：0.29 的负结果是因为条款级 dense 与「从条款反推」的题集。0.30 补了
**20 条独立同义题**（先写问题，再按真实库定位期望，未照抄条款原文），并改用**文档级**语义向量
（911 篇，标题+标准号+标签+摘要+首段，索引仅 1.9MB、本机首建 11 秒）做倒数排名融合（RRF）：

| 题集 | B FTS + boost | H 文档级 RRF | 差值 |
|---|---|---|---|
| 20 条独立同义题（Doc Recall@10 / MRR） | 65.0% / 0.317 | **80.0% / 0.497** | +15.0pp / +0.180 |
| 60 题主集 | 83.3% / 0.608 | **85.8% / 0.638** | +2.5pp / +0.030 |
| 合并 80 题 | 78.8% / 0.535 | **84.4% / 0.603** | +5.6pp / +0.068 |

分组看：同义改写 30 题（10 旧 + 20 新）**66.7% → 80.0%**、MRR 0.317 → 0.480；
条款定位 100% 持平（MRR 0.875 → 0.772 是唯一退步）、跨文档 60% → 63.3%、
数值限值 93.3% 持平但 Page Recall 93.3% → 86.7%（文档级向量没有页码）。
**因此 0.30 不接入生产**，0.31 按「文档级融合 + 两阶段页码定位 + 词面强命中优先」实现可选语义层，
运行时选型为 transformers.js（ONNX/WASM，无原生依赖）。完整数据、坏例与复现命令见
`docs/specs/2026-10-30-doc-level-hybrid-benchmark.md`。

**高亮提示修复（回答「为什么有的资料能检索到关键词、点开原件却没有高亮」）**：

- 检索跑在**解析/OCR 后的文本**上，viewer 高亮跑在**原始 PDF 的文字层**上。扫描件（`pdf-scanned`）
  原件没有文字层，`page.search()` 找不到任何词，所以不会出现高亮；卡片上的「命中 3 条条款」
  指的是 OCR 文本里的条款命中，不是页面上的高亮次数。
- viewer 现在**即使没有带检索词**也会对无文字层的资料给出横幅：
  「该资料是扫描件（原件没有文字层），页面上不会显示关键词高亮；检索到的文字来自 OCR/解析文本」；
  带检索词时仍是原来的两种提示（无文字层 / 未找到关键词）。
- 搜索结果卡片把「命中 N 处」改为「**命中 N 条条款**」，并加 `title` 说明；
  viewer 顶部的「高亮 N 处」才是页面上的高亮框数量（同一关键词多次出现会重复计数）。

### 已知限制（0.30.0）

- 文档级语义融合**只在评测脚本里**，`kb_query`、`/kb/api/search`、排序与索引格式均未改变；
  要做成功能需要引入 JS ONNX 运行时与约 92MB 模型（0.31）。
- Page Recall 的短板（数值组 86.7%）要等两阶段页码定位落地才会补回；当前 H 的页码只来自
  B 的条款命中。
- 只测 `bge-small-zh-v1.5` 一档模型；20 条新题由我按真实库概念编写，不是外部标注。
- 扫描件仍然无法在页面上高亮（原件无字形可锚定），只能提示 + 按页码定位。

## 0.29.0 混合检索评测（embedding/RRF，未接入生产）

**这一版只新增离线评测工具与报告，不改变插件运行时行为**：`kb_query`、工作台 `/kb/api/search`、
排序、索引格式都不动；`scripts/eval/` 与 Python 依赖不进发布包。

**做了什么**：在 0.27 的 60 题人工问题上，补跑语义检索与融合：

- **D 纯 dense**：条款级 `BAAI/bge-small-zh-v1.5`（512 维、92MB、查询带中文检索指令），
  余弦取 top-200 条款后按文档去重；
- **E 条款级 RRF**：FTS 条款序（top-200）+ dense 条款序（top-200）倒数排名融合（k=60）；
- **F 文档级 RRF**：B 的 boost 文档序（top-50）+ dense 文档序（top-50）融合（k=20）。

**结果（60 题，真实「标准」库 911 篇 / 14.95 万条款，只读）**

| 变体 | Doc Recall@10 | Page Recall@10 | MRR@10 | p95 |
|---|---|---|---|---|
| B FTS + boost（0.27 生产） | **83.3%** | **78.3%** | **0.608** | 55ms |
| D 纯 dense（bge-small-zh） | 60.8% | 60.8% | 0.271 | 7ms |
| E 条款级 RRF | 75.0% | 75.0% | 0.437 | 62ms |
| F 文档级 RRF | 79.2% | 78.3% | 0.559 | 59ms |

同义改写组（10 题）Doc Recall：B 70.0% / D 40.0% / E 70.0% / F 70.0%——**没有提升**；
条款定位组 B 100% vs F 95% / E 90%，数值限值组 B 93.3% vs F 86.7%。也就是说，在当前模型与
语料下，**embedding/RRF 的收益为负**：语义近似能被召回，但会被同族标准（`GB/T 19963.1/.2/2011`、
`GB/T 15543-2008/1995`、`Q/GDW 10650.x`）与 OCR 噪声条款淹没。

**索引成本**：149,519 条款 × 512 维 float32 = **292MB（约 321MB/千篇）**，超过 0.27 设计门槛
（200MB/千篇）；本机 ONNX CPU 嵌入 92 条/秒，全库首建约 **27 分钟**；dense 检索本身很快
（numpy 暴力余弦 60 题 0.3s，单题 5ms 级）。

**结论**：0.30 **暂不**把 embedding/RRF 接入生产检索；判据按「相对 B 不下降且同义改写 +10pp、
体积 <200MB/千篇、p95 <200ms」执行（比 0.27 spec §8.5 的「相对 ripgrep」更严）。
下一轮优先做「**文档级 embedding**（911 篇只需几秒）+ **路由式混合**（只在无标准号、无高频
条款术语的查询上启用 dense）」，通过后再谈条款级与 int8 量化。

完整方法、坏例与复现命令见 `docs/specs/2026-10-29-hybrid-embedding-benchmark.md`。

### 已知限制（0.29.0）

- 这是**离线评测**，不是可用功能：要复现需自备 Python 3.10+、`fastembed` 与能访问
  huggingface 的网络；仓库不锁定这些依赖。
- 只测了 `bge-small-zh-v1.5` 一档小模型；更强模型（jina-zh / bge-base 级）未测，
  因此不能据此否定 embedding 方向，只能说「当前档位 + 当前融合方式不达标」。
- 60 题从条款原文反推标注，词面重合对 BM25 有利；真正公平的语义测试只有同义改写 10 题，
  样本偏小，结论应结合 0.30 的补充题集再看。
- dense 索引只在 `/tmp` 评测产物里，产品不感知；也没有做量化、增量更新与跨进程共享。

## 0.28.0 PDF viewer 与关键词高亮

**工作台 PDF 预览改用服务端 viewer**：`ui/views/modals.js` 的 PDF 分支不再内嵌原生 PDF iframe
（WebKit 会下载/空白），改为 `GET /kb/api/kbs/:name/docs/:id/viewer.html` 的逐页 PNG viewer，
支持连续滚动、页码跳转、缩放、旋转、下载与打印。Office 预览链路不变（仍是 `preview.pdf` +
一键安装转换引擎）。

**页码语义修正**：显式 `page` 优先（来源卡/深链/检索结果里的页码不再被「命中最多的一页」顶掉）；
没有页码时才自动落到命中最多的页；越界夹取到 `1..总页数`。

**关键词高亮**：`#/search` 点结果时把该结果的 `terms` 带进 viewer（`?q=词1|词2`），
聊天来源面板本来就带 `kb_query` 的检索词；条款号不会被当成关键词。高亮框由服务端按
mupdf 的 `page.search()` 四边形计算，**与页图共用同一个旋转矩阵**，旋转 90/180/270 后不再错位
（旋转按钮会带 `rotate` 重载本页）。

**扫描件降级**：原件没有文字层（扫描件）时不再静默 0 高亮，顶部给出横幅
「该原件没有文字层（扫描件），无法在页面上高亮；检索到的文字来自 OCR/解析文本，可按页码定位」；
有文字层但没搜到词时提示「未在原件中找到这些关键词」；有命中但当前页没有命中时出现「首个命中」按钮。

**诚实计数**：每页最多渲染 240 个高亮框，触顶时工具栏显示
「高亮 N 处（每页最多 240 处，已截断）」，不再只给一个会让人误以为全量的数字。

**页图缓存**：`/page.png` 现在先查内存 LRU（64 页 / 32MB），再查
`os.tmpdir()/dsh-kb-pages` 的磁盘缓存（按「源文件 mtime+size+页码+dpi+旋转」哈希，原子写、
超过 800 个文件按 mtime 清理）。响应带 `x-cache: hit|miss`；**缓存不写知识库目录**，
系统清理临时目录后自动重渲染。

**参数与安全**：`q` 每个词 2–40 字、去重、最多 8 个；`page`/`dpi`/`rotate` 全部夹取；
标题与关键词一律 HTML 转义；CSP 仍是 `default-src 'none'` + inline style/script。

真实库冒烟（只读）：`GB/T 12325-2008`（扫描件）正确显示「没有文字层」横幅；
`GB 14549-2011 编制说明` 命中 182 处并自动落到第 13 页；`/page.png` 首帧 `miss`、再次 `hit`。

### 已知限制（0.28.0）

- **扫描件无法页内高亮**：原件没有文字层，只能提示 + 按页码定位；OCR 文本在 markdown 侧，
  页面上没有可锚定的字形。
- 每页最多 240 个高亮框（现在会如实标注截断）；超长文档打开时服务端要扫全部页做 `search()`，
  首开较慢，没有虚拟滚动或按需搜索。
- Office 预览仍走 `preview.pdf`，不享受 viewer 的高亮与逐页缓存。
- 旋转以 90° 为步进并整页重载（不做动画）；特殊旋转/竖排原件需要手动转。
- 页缓存只是加速层：内存或 `tmpdir` 被清理后会重新渲染；不做跨进程共享。

## 0.27.0 检索工作台与人工评测

**检索工作台**：工作台新增顶层 **全文搜索** 页（`#/search`，侧栏「全文搜索」入口）：跨库检索资料
正文与条款，结果按文档去重；每张卡片显示标题、标准号、条款、页码、可信度、命中数与命中摘要
（0.28 起点开卡片会把检索词带进 PDF viewer 直接高亮）。
支持按 **知识库 / 标签 / 类型 / 可信度** 过滤、**加载更多** 分页；点标题或「打开原件」复用工作台
现有预览弹窗（不新增全屏工作台）。过滤条件写回 hash（`#/search?q=…&kb=…&tag=…&type=…&trust=…`），
刷新与浏览器后退都能复现同一组条件。

**安全高亮**：摘要里的检索词由 `ui/search-core.js` 的 `highlightSegments` / `applyHighlights`
用**文本节点 + `<mark>`** 渲染，不拼接 HTML；标题或摘要里出现 `<img onerror=…>` 之类内容只会
显示成文本。摘要正文不进入渲染字符串，只输出空容器与下标，挂载后再用文本节点填充。

**接口**：`GET /kb/api/search?q=&kb=&limit=&offset=&tag=&type=&trust=`

- `q` 必填（trim 后 1–200 字）；`kb` 省略 / `*` / `all` = 全部活跃库（归档、已合并、空库与软删除
  资料不参与）；`trust` 只接受 `high/medium/low/unknown`。
- 返回 `q/kbs/terms/engine/indexBuilding/note/total/estimated/offset/limit/tookMs/facets/results`；
  每条结果含 `kb/docId/title/standardNo/page/clause/snippet/terms/trust/type/tags/hits/deepLink`。
- 纯文本优先条款级 FTS5；标准号与含正则的查询退回 ripgrep；单库失败只写 `note`（不带绝对路径），
  不整页报错；`estimated=true` 表示总数按候选集估计。

**排序**：生产排序 = 引擎序 + 标题命中 + **标准号命中**（删分隔符后双向包含，因此 `GB/T 19963`
不会奖励 `GB 19963`）+ 标签命中 + 可信度 + 新近度。工作台检索与 `kb_query` 共用同一份条款索引，
互不改写；`kb_query` 的返回字段不变。

**修复 0.26 标准号检索回归**：`GB/T 1234`、`GBT 1234`、`GB_T 1234`、`GB∕T 1234`、`DL/T 587`、
`GB/T 19963.2-2024` 等写法此前被判为「纯文本」走 FTS——分词后 `gb` 命中几乎所有标准，GB 与 GB/T
不再区分（真实库 `GB/T 14549` 的 FTS top10 全是无关标准）。现在「能被标准号归一器认出的查询」
一律走 `expandStdQuery` 精确正则，不再经过 FTS；判定复用 `expandStdQuery` 与
`standards.js` 的长前缀表，没有第二套前缀列表。

**60 题人工评测**：`scripts/eval/questions-2026-10-27.jsonl`（条款定位 20 / 跨文档 15 / 数值限值 15 /
同义改写 10；人工标注 expected doc/page/clause），`node scripts/eval-benchmark.mjs` 只读跑四组对比：
A = 当前 FTS，B = FTS + 标准号/标签/trust boost（0.27 生产排序），C = ripgrep 0.25 路径（整句当正则），
C1 = 关键词 OR 输入 + 旧排序。报告见 `docs/specs/2026-10-27-retrieval-benchmark.md`，当前结果：

| 变体 | Doc Recall@10 | Page Recall@10 | MRR@10 | p95 |
| --- | --- | --- | --- | --- |
| A 当前 FTS | 75.0% | 72.5% | 0.466 | 57ms |
| B FTS + boost | **83.3%** | **78.3%** | **0.608** | 57ms |
| C ripgrep（0.25 整句） | 3.3% | 3.3% | 0.022 | 29ms |
| C1 ripgrep + 关键词 OR | 1.7% | 1.7% | 0.006 | 250ms |

分组看：条款定位 A/B 都是 100%，B 的 MRR 从 0.674 提到 0.875；跨文档 53% → 60%；数值限值
87% → 93%；**同义改写 40% → 70%**。数据集用 `node scripts/eval-benchmark.mjs --validate` 校验与
真实库的一致性（只读打开索引）。本轮不引入 embedding/向量/rerank。

### 已知限制（0.27.0）

- **不承诺「打开即高亮」**（0.28 已修）：工作台预览在 0.27 仍是原生 PDF iframe，`viewer.html`
  只在聊天来源面板使用；0.28 起工作台也走 viewer、检索结果会带关键词，扫描件仍无法页内高亮。
- **FTS 是 token OR**：多词查询靠 BM25 与 boost 排序，不做 AND/phrase 过滤；词多时精度会掉，
  坏例逐条列在评测报告里。
- 其余 6 个库没有 `standardNo`/`tags`（0.26 回填只做「标准」），因此**标签过滤与标准号加权只在
  「标准」库有效**；首次跨库搜索会为这些库后台建索引（派生数据写入 `<kb>/.index`），当次请求
  回退 ripgrep 并在状态行提示。
- 结果分页只有「加载更多」，没有页码跳转；没有检索历史/保存检索/排序切换/结果导出。
- `total` 在 ripgrep 路径是估计值（`estimated=true`）。
- 单库失败会写进 `note` 但结果里看不出缺了哪个库的命中，需要看状态行。
- 标准号查询走 ripgrep，页码/条款来自 `parts/index.json`；个别旧文档没有页码数据时结果不带
  `page`（深链只到文档），而条款索引路径有页码。真实库冒烟：`GB/T 14549` 首条命中
  `GB/T 14549-1993`，该文档当前没有页码。

## 0.24.0 回收站治理

回收站分成「归档库」与「已删除资料」两个分区：整库归档仍在回收站里恢复/彻底删除，软删除的单篇资料也有了自己的跨库列表、行内操作与按库批量彻底删除；资料页还能一键清空本库回收站。

### 回收站两个标签页

- **归档库**（`#/trash`，默认）：0.23.0 的整库列表，逐库 **恢复** / **彻底删除**，另显示文档数、笔记数与归档时间；不可恢复的库给出原因并且只能彻底删除。
- **已删除资料**（`#/trash?tab=docs`）：只列 **活跃库** 中被软删除（`status=deleted`）的资料，每行带 **库** 徽标、类型与删除时间；归档库里的资料**不单独列出**——它们随库一起恢复，归档库整库恢复后回到正常状态。
- 两个页签都显示计数（归档库个数 / 已删除资料总篇数）；页签链接就是 hash，刷新与浏览器后退都能回到同一分区，未知 `tab` 值回落到归档库。
- 切换页签或连续刷新时，先发出的旧请求会被请求代号（token）作废，不会把上一轮结果盖到新页签上；归档库与已删除资料并行加载，其中一个失败不影响另一个展示（各自给出错误与重试）。

### 已删除资料操作

- 行内提供 **恢复** / **彻底删除**；恢复回到删除前的状态（失败资料恢复后仍是失败，失败原因保留）。
- **跨库移动留下的源库墓碑按目标副本状态处理**：带 `movedTo.kb` 的行不再一律只能撤销移动。
  `GET /kb/api/trash/docs` 为这类行附加 `movedToState`（`live` / `deleted` / `missing`）与
  `canRestoreSource`，行内操作按矩阵渲染：

  | 目标副本 B 的状态 | `movedToState` | 回收站行内操作 | `POST .../restore` |
  | --- | --- | --- | --- |
  | 目标库可用且副本 `status=ready` | `live` | **撤销移动** | `409 DOC_MOVED`（`details.targetKb`） |
  | 目标库可用但副本已软删除 | `deleted` | **恢复** | `200`，恢复 A 并清除 `movedTo`；B 保持已删除 |
  | 副本被彻底删除 / 目标库归档 / 目标库不存在 | `missing` | **恢复** | `200`，恢复 A 并清除 `movedTo`；不复活 B |

  **先彻底删除 B 会让 A 从「不可恢复」变为可恢复**：B 还在时直接恢复 A 会造出两份可用副本，所以只能
  `409`；B 被 purge（或目标库归档）后 A 的 `movedToState` 变为 `deleted`/`missing`，回收站改为提供
  **恢复**，服务端清掉 A 的 `movedTo` 后让 A 回到删除前状态。恢复只清 `movedTo`，更早的 `movedFrom`
  保留；B 不会因此复活，不存在两份可用资料。`kb_restore(version=N)` 的历史版本恢复默认仍拒绝移动
  墓碑，只有 API 确认目标副本不可用后才显式传 `clearMovedTo`。撤销移动仍走 0.23.0 的 `undo-move`：
  源文档恢复、目标副本软删除进目标库回收站。
- 多选后 **恢复所选** 逐篇恢复，**允许跨库**（选中的资料可以来自不同库）；部分失败不中断其余条目，最后按成功/失败篇数提示。目标副本仍可用的已移动行会自动排除（旧选择项没有状态时也按可用处理），工具条提示「已排除 N 篇已移动资料，请在对应库中撤销移动」；目标副本已删除/缺失的已移动行与普通软删除资料一样纳入恢复。它们仍可勾选用于彻底删除。
- **彻底删除所选只能同一库**：勾选跨库时按钮禁用并提示「彻底删除一次只能处理同一个库的资料」；行内单篇与多选批量走同一个确认弹窗，列出（最多 10 个）标题与总篇数。**0.25.0 起跨库多选可用，确认改为 `彻底删除 N 篇`。**
- 回收站里的彻底删除（行内、批量、清空本库）都要求**逐字输入库名**确认；服务端对 `confirm` 做同样的去首尾空白比较，不一致返回 `400 CONFIRM_REQUIRED`（资料页「已删除」筛选里的单篇彻底删除仍是 0.23.0 的输入标题确认）。**0.25.0 起跨库批量改为输入 `彻底删除 N 篇`，行内与清空本库仍是库名。**
- 彻底删除会移除原件、`markdown/` 解析内容与历史版本，**不可恢复**；被移动过的资料还会失去 **撤销移动**——确认弹窗明确提示「彻底删除会移除原件、解析内容与历史版本，且撤销移动将不再可用。」（撤销移动依赖源库清单里的 `movedTo` 记录，记录随永久删除一起消失）。反过来，**彻底删除目标库副本 B 会让源库墓碑 A 变为可恢复**（`movedToState` 变 `missing`）：A 不再需要撤销移动即可恢复，服务端恢复时清除 `movedTo`，B 保持缺失。
- 每次彻底删除写库日志 `remove`（detail「彻底删除」）并刷新 `index.md`；这两个附属写入是 **best-effort**：永久删除已完成后，日志或索引刷新失败只留在服务端，不会再让请求以 500 收场。单篇失败继续处理其余条目，最后返回 `{kb, purged, failed}`，失败文案固定为「彻底删除失败」，不带本机路径。

### 清空本库

- 资料页切到 **已删除** 筛选（且库内确有已删除资料）时，工具栏出现 **清空本库已删除资料**；确认弹窗同样要求逐字输入库名，服务端按 `all=true` 一次清空该库回收站。
- 没有已删除资料的库不显示该入口；「已删除」筛选下即使当前页/搜索没有结果，只要库内还有回收站内容，入口仍保留。

### 上限

- 全局已删除资料列表最多显示 **500** 篇：超出时接口回 `truncated=true`，页面提示「仅显示前 500 篇」，`total` 仍是真实总数。
- 归档库内的资料不计入该列表与总数；合并库（清单已并入目标库）也不重复列出。

### HTTP

- `GET /kb/api/trash/docs` → `{items, total, truncated}`；只扫描活跃（非归档、非合并）库，按 `deletedAt` 倒序（缺失/非法日期排最后，同刻按库名+id 稳定排序），只读接口。
- `POST /kb/api/kbs/:name/docs/purge`，body `{all?, ids?, confirm}` → `{kb, purged, failed}`：`confirm` 必须等于库名（否则 `400 CONFIRM_REQUIRED`）；`all` 与 `ids` 必须二选一（否则 `400 INVALID_ARGS`）；`ids` 里有未删除/不属于本库/不存在的条目回 `409 DOC_NOT_DELETED`；`all=true` 但回收站为空回 `409 NO_DELETED_DOCS`；`all` 只选回收站条目，绝不触碰在用资料。
- `POST /kb/api/kbs/:name/docs/:id/restore` 对已跨库移动的源库文档：目标副本 `live` 时返回 `409 DOC_MOVED`（文案「文档已跨库移动，请使用撤销移动」，`details.targetKb` 为目标库）；目标副本 `deleted`/`missing`（副本已软删/彻底删除、目标库归档或不存在）时返回 `200 {doc, restoredMovedSource: true}`，恢复源文档并清除 `movedTo`。未知文档仍是 `404 DOC_NOT_FOUND`，普通软删除文档的恢复行为不变。

### 已知限制（0.24.0）

- 不能跨库批量彻底删除：一次批量只能处理同一个库，跨库需分库确认（恢复所选可以跨库）。**0.25.0 已支持跨库批量彻底删除。**
- 回收站暂无搜索与排序选项：已删除资料固定按删除时间倒序、最多 500 篇。**0.25.0 已支持搜索与六种排序。**
- 归档库内的资料只能随库一起恢复，不能在「已删除资料」里单独恢复或彻底删除。
- 没有自动过期清理：已删除资料会一直保留，需要手动恢复或彻底删除。**0.25.0 起可配置 `trashRetentionDays`。**
- 回收站真实 DOM 自动化不完整：**0.25.0 起 Playwright E2E 覆盖回收站两页签、行内恢复、行内/批量彻底删除、清空本库、搜索/排序/筛选空态与跨库选择**；但 **`loadTrash` 旧响应作废（token）、刷新后清空选择、跨库恢复循环不在 E2E 套件内**，仍只由一次性 WKWebView 验收覆盖。

## 0.23.0 资料治理

工作台的资料可以删除、跨库移动、失败后重试；总览卡片改为单条类型条 + 可信度圆点；Office 预览支持一键安装转换引擎。

### 删除与回收站

- 可删除**就绪（ready）与失败（failed）**资料；**软删除**拒绝导入中的资料（`409 DOC_IMPORTING`），已删除的不能重复删除。入口在资料行（就绪=「移除」，失败=「重试 / 移除」）、失败资料的文档弹窗（「移入回收站」）与多选工具条（「移入回收站」）。
- **默认软删除**：只把清单状态改为 `deleted`，记 `deletedAt` 与 `deletedFromStatus`，原件、`markdown/` 解析内容与历史版本全部保留。恢复后回到删除前的状态——失败资料恢复后仍是失败，失败原因也还在。
- 状态筛选新增 **已删除**（`status=deleted`）。该列表每行提供 **恢复** 与 **彻底删除**；从别的库移动过来的资料显示 **撤销移动** 而不是普通「恢复」（见下节）。
- **彻底删除只能从回收站发起**：对未删除的资料即使标题确认正确也会被服务端拒绝（`409 DOC_NOT_DELETED`，文案「彻底删除只能从回收站发起」）。唯一例外是**卡死的导入中任务**——`status=importing` 且 `updatedAt` 超过 30 分钟未更新（或缺失）时可用永久删除清掉半成品，未满 30 分钟仍是 `409 DOC_IMPORTING`。
- 彻底删除必须逐字输入资料标题才能确认（服务端同样校验 `confirm` 去首尾空白后与标题完全一致，否则 `400 CONFIRM_REQUIRED`）；会删掉原件、解析内容与历史版本，**不可恢复**。
- **批量只做软删除**：多选工具条只有「移入回收站」，没有批量彻底删除；部分失败时按篇报告成功/失败数量。
- 每次删除/恢复都写库日志：`remove`（detail 区分「软删除」/「永久删除」）与 `restore`，并刷新 `index.md`。
- HTTP：`POST /kb/api/kbs/:name/docs/:id/delete`（body `{permanent?, confirm?}`）、`POST /kb/api/kbs/:name/docs/:id/restore`。

### 跨库移动

- 资料 tab 多选（只有 ready/failed 行可勾选）→「移动到…」→ 选目标库。目标必须是**同一个 `kbRoot` 下、未合并**的另一个库；下拉不列当前库与已合并库。
- 先做**预检**（只读）：逐篇校验文档就绪/未删除/原件存在，汇总「将移动 N 篇（约 X MB）」，并按 **同 ID / 同内容 / 同标题** 分组列出目标库已有的重复。
- **冲突策略**：默认「跳过」；可改「重命名为副本」——同 ID 冲突换新 id，同标题冲突追加「（副本）」「（副本 2）」；**同内容（`sourceHash`）始终跳过**，改名只会制造真重复。
- **移动 = 复制到目标库 + 源库软删除**：目标库先写 `.transfer/<transferId>/` 暂存并逐字节校验（原件大小、markdown 文件数与字节），再落位，最后才原子写清单；journal 在落位前先写 `mounted` 标记，只有标记过的目标路径才归本次移动所有——commit 阶段才发现 id 冲突（跳过）时不会误删目标库既有文档。源库文档标记 `deleted` + `movedTo`，所以在源库回收站能 **撤销移动**。
- **撤销移动**：源文档恢复为移动前状态，目标库副本**软删除进目标库回收站**；两边的原件与解析内容都保留。只在目标副本仍可用、transferId 匹配、且**未被修改**时允许——移动时在 `movedFrom.version` 记录源文档版本，目标副本被 `kb_edit` 改过（`edited=true`）或 version 已变化后拒绝撤销（`409 TRANSFER_UNDO_UNAVAILABLE`，文案「目标副本已被修改，无法撤销移动」）。
- **目标副本已删除/缺失时**：撤销移动仍会拒绝（没有可软删的目标副本），但 0.24.0 起源库墓碑会转为可恢复（`movedToState` 为 `deleted`/`missing`），在全局回收站（`#/trash?tab=docs`）点 **恢复** 即可回到删除前状态并清除 `movedTo`；目标副本保持已删除/缺失。
- 单批上限 **50 篇 / 500 MB**（超过是 `413 TRANSFER_TOO_MANY` / `TRANSFER_TOO_LARGE`）；同一 `kbRoot` 的 move/undo 进程内串行执行。
- **历史版本不复制**：目标库从零开始积累历史；没有原件的笔记不能移动（预检/移动报「原件不存在」）。
- 每篇文档一份 journal（`<kbRoot>/.transfers/<transferId>.json`）+ 目标库暂存目录。进程崩溃后，下一次预检/移动/撤销会先收敛：目标清单已提交→补齐源库删除并清暂存；未提交→只删 journal 记录过且在 `sources/` / `markdown/` 白名单内的路径，不把半成品留成清单里的孤儿，也不会误删库清单或其它目录。
- HTTP：`POST /kb/api/kbs/:name/docs/move/preflight`、`POST /kb/api/kbs/:name/docs/move`、`POST /kb/api/kbs/:name/docs/:id/undo-move`。

### 失败资料

- 失败行显示 **失败** 徽标与 重试 / 移除；文档弹窗显示 `error` 原文与 `warnings` 列表，并提供 **重新导入**（仅失败资料）。
- **重新导入不是重新上传**：服务端用 `sources/` 里保存的原件重跑导入管线（强制完整重解析），以后台任务 `kb-reparse` 执行；界面每 1 秒轮询任务（约 2 分钟超时），成功/失败都有 toast，结算后刷新资料列表与库计数。
- 同一行不会重复触发重试；原件已丢失时不能重试（`409 SOURCE_MISSING`）；非失败资料 `409 DOC_NOT_FAILED`。重试失败时任务详情固定为 `重试失败：<标题>`，不带本机绝对路径。
- 资料列表与详情新增 `error` / `sourceFile` / `movedTo`（列表）与 `error` / `errorAt` / `warnings`（详情）投影，列表直接显示失败原因，不必逐篇读详情。

### 卡片可视化（方案 B）

- 总览卡片只保留**一条**横向类型构成条：按类型篇数分段（圆角段、颜色区分类型），hover 显示「类型 pdf-text 3 · docx 1」，空库显示空条。
- 可信度不再画第二条比例条，改为一行紧凑圆点图例：行首 **可信度** 标签 + 只显示非零档的 `● N`（高/中/低/未知各有固定颜色，单项 hover「高 3」，整行 title/aria-label 给四档完整计数）。四档全为零时不占位。

### 一键安装 Office 转换引擎

- 预览 Office（docx/pptx/xlsx 等）时若 `/office/status` 报引擎不可用，预览面板直接显示安装区：说明「约 300 MB，转换只在本机进行」、勾选同意、点 **安装转换引擎**；未勾选前按钮禁用。
- `POST /kb/api/office/install` 必须带 `{confirm:true}`（否则 `400 CONSENT_REQUIRED`），以后台任务 `office-install` 安装到 `~/.dsh/tools/libreoffice-kit`（可用 `DSH_OFFICE_KIT_HOME` 改目录）；装 `@deepseek-ai/libreoffice-kit@0.2.2` 与当前平台引擎包（Linux 走 wasm），完成后跑 `<node> <cli> capabilities`，输出里必须有 `conversions` 才算成功。
- 界面每 1.5 秒轮询安装任务并显示阶段/进度文字；成功后复查 `/office/status` 并自动重载预览（带 cache-bust）。**已安装**时预览直接内嵌、不进入安装区（`/office/install` 也直接回 `{alreadyInstalled:true}`）；并发安装返回 `409 OFFICE_INSTALL_RUNNING`。
- 缺少 Node/npm 时不启动安装，面板改为「缺少 Node/npm，无法自动安装，请按 README 手动安装」。手动命令：

  ```sh
  mkdir -p ~/.dsh/tools/libreoffice-kit && cd ~/.dsh/tools/libreoffice-kit
  npm install @deepseek-ai/libreoffice-kit
  ```

- 安装失败文案固定且不含本机路径；退出码/日志尾部只放在错误 `details` 里供本地排查。

### 已知限制（0.23.0）

- 只能在同一个 `kbRoot` 内移动；不同根目录的库之间没有迁移入口（需手工搬目录或重新导入）。
- 单批 50 篇 / 500 MB，超过需要分批。
- 无原件的笔记不能移动；历史版本不随移动复制，目标库从零开始。
- 批量操作只提供软删除；彻底删除只能逐篇确认标题，且只能从回收站发起（唯一例外：`updatedAt` 超过 30 分钟未更新的卡死导入中资料）。
- 撤销移动只在目标副本仍然可用且未被修改（`edited` / version 与移动时一致）时成立；目标副本被改/删后不能撤销。目标副本被软删除、被彻底删除或目标库归档后，源库墓碑可从全局回收站 **恢复**（0.24.0 起清除 `movedTo`，目标副本保持已删除/缺失）。
- 真实 DOM 的删除/移动/重试流程由一次性 WKWebView 脚本验收，尚未接入 Playwright 自动化。
- Office 一键安装会下载约 300 MB 引擎；本次发布验收时本机已装引擎，**未做真实重新下载**（安装面板的同意、已安装、任务轮询与失败分支由单测覆盖）。

## 0.22.0 交互完善

本会话范围、工作台资料浏览与原件查看的易用性补完。其中「一个都没选」的含义是**破坏性变更**。

### 本会话不启用知识库（破坏性变更）

新增第三种范围模式「未启用」（`mode: "none"`）：`清空` + `应用` 即关闭本会话的知识库。

- **空选择语义变更**：0.21.x 里 `selected` + 空 `kbs` 等价 `all`；0.22.0 起归一化为
  `{mode: "none", kbs: []}`，只有显式 `mode: "all"` 才表示全部库。`全选` 提交「全部」，
  `清空` 后应用提交「未启用」；不做修改直接应用保持当前状态（重开面板时 `none` 全部不勾选）。
- **工具全禁用**：`none` 下 21 个 `kb_*` 工具一律拒绝，在读/写任何库数据之前抛 `KB_DISABLED`
  「本会话未启用知识库；请在输入框旁的知识库选择器中选择库或「全部」后重试」，不读取、不检索任何库。
  注意参数 schema 的必填项（如 `path`、`doc`、`old_string`）由工具框架在进入 `execute` 前校验，
  缺参时可能先返回 `INVALID_ARGS`；对没有 schema 必填参数的工具（`kb_remove`、`kb_rename`）
  范围门保证最先，其余工具在通过 schema 校验后、访问任何库数据之前过范围门
  （`kb_rename({})` / `kb_remove({})` 也先报 `KB_DISABLED`）。
- **系统提示**：`none` 只注入一行「本会话未启用知识库：不要调用 kb_* 工具，也不要检索知识库」；
  `all` 仍不注入；`selected` 的库名全部失效时也按未启用处理。
- **胶囊与 API**：新增状态 `知识库：未启用`；`PUT /kb/api/scope` 接受 `{mode:"none"}`（忽略随请求
  带来的 `kbs`）；空 `selected` 也落盘成 `none`。
- **清理与继承**：`selected` 的库名全部失效（删除/归档/合并）时写回 `mode:"none"`，不再退回「全部」；
  父会话 `none` 快照为子会话 `none`。
- **迁移提示**：0.21.x 里把「清空 + 应用」当「全部」用的会话，升级后会变成「未启用」；要恢复全部请点
  「全选」，或把范围重新应用为「全部」。

### 胶囊：外部点击关闭与焦点归位

- 点击面板与胶囊之外的任意位置，面板**立即**关闭并丢弃未应用的草稿，不会提交范围，也不会触发任何
  `kb_*` 调用。
- 焦点不在同一个 tick 里同步还给胶囊：浏览器处理完这次点击的默认聚焦动作后（`setTimeout(…, 0)`）
  才把焦点送回胶囊，避免被默认动作覆盖；卸载或重开面板时清掉待执行的定时器。
- `Esc` 仍然关闭面板并**同步**把焦点还给胶囊。

### 资料页：分页、搜索与状态筛选

- 顶部与底部各一组分页：`第 X / Y 页 · 共 N 篇`、上一页 / 下一页，页码输入框可直接跳页（越界自动
  收敛到 1..总页数）；表格底部另显示当前区间 `第 a–b 篇`。
- 每页条数 50 / 100 / 200（默认 50；旧链接或手改 URL 里的其它值一律回落 50）。
- 搜索按**标题 + 摘要 + 标签**过滤（服务端 `query`，不区分大小写），输入 **300ms 防抖**；输入法
  组合期间不发中间请求，`compositionend` 立即应用，`Enter` 立即搜索。
- 状态筛选 `全部` / `有失败` / `导入中`（`status=failed|importing`），可与搜索、分页叠加；搜索或
  切换筛选会把偏移重置到第一页。
- 旧响应保护：每次请求领一个单调代号，晚到的旧响应直接丢弃，不覆盖新条件、也不把旧词记成已应用；
  每次重绘重新挂载工具栏，旧的防抖计时器与监听会被摘掉。
- 空状态：有搜索词/筛选但无结果时保留工具栏（可继续改词或「清除搜索」），不显示分页；新条件的
  结果还没回来时只显示工具栏与「正在搜索…」，上一轮查询的行/表格与分页都不渲染。

### 查看原件

- 文档详情弹窗新增「查看原件」：
  - PDF 内联 `source?inline=1`；图片（png / jpg / jpeg / webp / gif）直接内嵌；
  - txt / md 走 `/content` 读取全文（超过 2 MB 截断并提示）；
  - Office（doc / docx / odt / xls / xlsx / ods / ppt / pptx / odp）先由 **LibreOfficeKit** 转成 PDF，
    再内联 `preview.pdf`：首次转换需要几秒（弹窗内有提示），之后命中缓存；
  - 笔记走 `/content` 的合并版 markdown，按纯文本预览；
  - 其它格式（epub、压缩包等）提示「该格式暂不支持内嵌预览」并给「下载原件」。
- **引擎可选**：装好后自动探测（`officeKitCli` → `DSH_OFFICE_KIT_CLI` → `~/.dsh/tools/libreoffice-kit`
  默认安装 → PATH 里的 `dsoffice`）；没装时 Office 预览返回「未安装 Office 转换引擎（LibreOfficeKit），
  请安装后重试」，弹窗底部仍可下载原件，其它格式不受影响。安装命令（需要 Node ≥ 22.19）：

  ```sh
  mkdir -p ~/.dsh/tools/libreoffice-kit && cd ~/.dsh/tools/libreoffice-kit
  npm install @deepseek-ai/libreoffice-kit
  ```

  也可以把 `officeKitCli` 配成 CLI 的绝对路径，或设环境变量 `DSH_OFFICE_KIT_CLI`。
- **缓存**：`<库>/.preview/<docId>-<mtime>-<size>.pdf`，源文件变化自然失效；转换先写临时文件、校验
  `%PDF-` 后原子 rename，失败不留残渣；同一文档的并发请求合并成一次转换，并顺手清掉该文档的旧缓存。
- **安全**：内联只放行白名单扩展名（PDF / 位图 / txt / md），HTML / SVG 等可能执行脚本的格式仍然只能
  下载；内联响应带 `x-content-type-options: nosniff` 与 `cache-control: private, no-store`；预览失败只回
  固定文案，不把本机路径回传给浏览器。

### 笔记

- 笔记 tab 列出编译页（标题 / 更新时间 / 摘要），点标题打开**文本预览**（合并版 markdown，纯文本渲染、
  HTML 转义）；笔记没有原件，列表里不提供下载入口，预览失败时也只显示错误与「关闭」，不提供下载。
- 列表请求上限 200 篇；总数超过返回条数时底部提示「仅显示前 N 篇（共 M 篇）」，不做分页。

### 徽标与重命名

- 库卡片 / 详情页把状态拆成「导入中 N」「有失败 N」两个徽标（只显示非零项），hover 的 title 给出完整拆分
  「成功 X · 导入中 Y · 失败 Z」；详情页的「有失败」是按钮，点一下跳到资料 tab 并按 `status=failed`
  过滤；总览卡片保持只读展示，不打断「点卡片打开库」的语义。
- 详情页页头新增「重命名」按钮（与设置页的重命名等价，成功后刷新库列表并跳到新库名的同一 tab）。

### 临时/锁文件跳过与体检

- 导入与工作台上传会跳过：`~$*`（Office 所有者/锁文件）、`.~lock.*`（LibreOffice 锁文件）、
  `Thumbs.db`、`desktop.ini`、`.DS_Store`——大小写不敏感，只看文件名；普通 `.tmp` **不**跳过。
- 跳过的文件不占导入额度，结果里报告「已跳过 N 个临时/锁文件」，上传面板同样提示；目录里全是临时
  文件时报「目录中没有可导入的文件（已跳过 N 个临时文件）」。
- `~$` 文件是 Word 打开文档时生成的**所有者/锁文件**（记录打开者与机器），不是资料本身；以前误导入
  后会在资料列表里留下打不开的条目。
- `kb_lint` 新增「临时/锁文件」组，列出**升级前**已经进库的这类文档，建议用 `kb_remove` 删除
  （`soft=false` 彻底删除）。

### 已知限制（0.22.0）

- Office 原件预览依赖**可选**的 LibreOfficeKit 边车；未安装时只有 PDF / 图片 / 文本 / 笔记可预览，
  Office 走下载。边车要求 Node ≥ 22.19，首次安装要拉对应平台的原生引擎，体积较大。
- PDF / 图片 / 文本预览直接流**原文件字节**：不做服务端渲染、转码或 DRM 解密，加密/受保护的 PDF
  能否显示取决于浏览器。
- 资料搜索只覆盖标题、摘要与标签，**不是全文检索**；正文检索仍用 `kb_query`。
- 笔记预览按纯文本显示（markdown 不解析，公式/表格按原文）。
- `restoreKb` / `removeKbDir` 仍未做会话范围同步（沿用 0.21.1 的记录，失效库名由读取时 prune 兜底）。
- 仍没有真实浏览器自动化：资料工具栏与预览由 fake DOM / 纯函数单测 + `scripts/check-ui.mjs` 语法门禁
  覆盖，样式、真实焦点顺序与 Office 转换结果需手工验收。

## 会话知识库范围与胶囊（0.21.0）

输入框左侧工具行新增「知识库」胶囊，为**当前会话**选定可用知识库；`kb_*` 工具按范围执行：

- **胶囊状态**：`知识库：全部`（默认）/ `知识库：N 个`（限定时用强调色）/ `知识库：未启用`（本会话
  关闭知识库，0.22.0 新增）/ `知识库：…`（加载中）/ `知识库：—`（加载失败，点击重试）。没有
  `/kb/api/status`（无 webServer、旧版服务端）或未声明 `features.scope` 时**不渲染**（静默降级，
  工具与提示照常）。
- **全部 / 限定 / 未启用**：`全部` 不限制，以后新增的库也自动包含；面板在「全部」模式下**复选框
  全部勾选**，取消勾选任意一个即切换为「限定」。0.21.x 的旧规则是「`全选` / `清空` 都提交回全部
  （空选择等价全部）」；**0.22.0 起**改为 `全选` 提交「全部」、`清空` 提交「未启用」
  （`mode: "none"`，一个都没选**不再**等价全部），详见上节。不做修改直接应用会保持当前状态。
- **关闭面板**：点击面板与胶囊之外的任意位置（或按 `Esc`）关闭面板并丢弃未应用的草稿；
  与相邻的权限/模型选择 popover 一致，不会因为点击外部而提交范围。外部点击后的焦点归还时机见
  上节「0.22.0 交互完善」的胶囊小节。
- **工具硬约束**：未启用模式（0.22.0）下 21 个 `kb_*` 工具全部拒绝，返回 `KB_DISABLED`
  「本会话未启用知识库；请在输入框旁的知识库选择器中选择库或「全部」后重试」，不读取、不检索任何库；
  其中 schema 必填参数（如 `path` / `doc` / `old_string`）缺失时框架会先报 `INVALID_ARGS`，
  `kb_remove` / `kb_rename` 无 schema 必填参数、保证范围门最先，其余工具在访问任何库数据之前过范围门；
  显式指定范围外的库 → `KB_OUT_OF_SCOPE`（附当前范围与调整方式）；
  单库语义工具（`kb_import` / `kb_reparse` / `kb_snapshot` / `kb_export` / `kb_edit_batch` /
  `kb_add_note`）在限定模式多库且省略 `kb` 时 → `KB_REQUIRED`（提示用 `kb` 指定一个）。
  `kb_list` / `kb_query` 输出带 `scope`；`kb_query` 在限定模式下省略 `kb` 时检索范围内全部库
  （`kb="*"` 等价范围内全部；全部模式沿用 `defaultKb`）。
- **跨库文档解析**：`kb_read` / `kb_view` / `kb_edit` / `kb_describe` / `kb_retitle` / `kb_trust` /
  `kb_keep` / `kb_history` / `kb_restore` / `kb_remove`（文档级）省略 `kb` 时，在范围内按标题/id
  解析：唯一命中直接用；命中多个报候选（`kb/docId/标题`）并提示指定 `kb`；`schema`/`index`/`log`
  是库级维护文件，不跨库解析。
- **`kb_lint` 逐库体检**：限定模式下省略 `kb` 会逐库执行并按库分组（单库失败不影响其它库），
  最多 `scopeLintMaxKbs`（默认 20）个，超出时返回 `truncated` 与 `omittedKbs`。
- **子会话继承**：subagent/fork 首次使用范围时把父会话的生效范围**快照**到自己的条目
  （`inheritedFrom`），父会话之后改范围不回溯；只聊天、从未调用 `kb_*` 的子会话，系统提示仍跟随
  父范围；父会话为「未启用」时子会话也快照成「未启用」。
- **存储**：`<kbRoot>/.scopes.json`，权限 `0600`、临时文件 + rename 原子替换、按 kbRoot 进程内串行写；
  条目默认 `scopeTtlDays`（30）天过期，但 **TTL 只清理 `selected` 条目**：工具真正使用范围时按
  24 小时粒度续期，GET/系统提示只读不续期；`none`（显式关闭）与 `all` 条目不做 TTL 清理，
  关闭不会在 30 天后被静默恢复成「全部」。读取时惰性剔除过期的 `selected` 条目与
  已删除/已归档/已合并的库名；某个 `selected` 条目的库名全部失效时
  落盘为 `mode: "none"`（而不是退回「全部」）。
- **接口**：`GET /kb/api/scope?session=<id>`、`PUT /kb/api/scope`（`x-kb-ui: 1` + 同源）；
  `/kb/api/status` 的 `features.scope` 声明能力。
- **降级**：`.scopes.json` 损坏或超过 1MB → 读按「全部」，写入失败并提示
  「范围文件已损坏或过大，无法保存；请备份后删除该文件再重试」；文件不可写但可读 →
  工具按只读范围解析可用，胶囊应用报「范围保存失败，请重试」且 chip 不变、面板保留。
- **生效时机**：范围变更在**下一轮模型步**生效；系统提示只在「限定」与「未启用」模式注入说明
  （未启用时注入一行「不要调用 kb_* 工具，也不要检索知识库」），切换范围会改写一次 system prompt
  前缀（同一范围下前缀稳定）。
- **行为变化**：`kb_std_check` 省略 `kb` 时默认「标准」（不再用 `defaultKb`）；
  `kb_rename` 与 `kb_remove(removeKb=true)` 必须显式传 `kb`。
- **已知限制**：范围是产品约束，**不是权限边界**（工作台 API/UI 不受影响，`session` 由客户端提供，
  不做身份认证）；`kb_edit_batch` / `kb_add_note` 是单库操作；`restoreKb` / `removeKbDir` 未做范围
  同步（失效库名由读取时清理兜底）；胶囊只注册在 `conversation.input.left`；无 session 身份的
  调用（非常规宿主路径、测试）fail-open 不限制。
- **fail-open 行为（重要，可能静默放宽范围）**：
  - 只有 `selected` 范围条目超过 `scopeTtlDays`（默认 30 天）**且期间没有工具调用**会被惰性过期删除，
    会话退回「全部」，**系统不会提示**；活跃使用会把 `selected` 条目续期（24 小时粒度，无需改范围）。
    `none` 条目**不会**因 TTL 过期而被恢复为「全部」（显式关闭会一直保留，工具与系统提示都保持未启用），
    `all` 条目过期后解析结果仍是「全部」，无需清理。需要永久保留 `selected` 请设
    `scopeTtlDays: 0` 关闭过期。
  - 范围内所有库都被删除/归档/合并后，`selected` 收敛为「未启用」（**不会**退回「全部」）。
  - 库身份以**目录名**为准，`manifest.name` 只作为显示名；手工改坏清单只会让显示名与目录名不一致，
    范围勾选、导入查重与归档清理仍按目录名工作。
  - 若子会话的父 agent 不在线（恢复历史会话），胶囊可能暂时显示「全部」；首次 `kb_*` 调用仍会
    按父范围落快照。

### 0.21.1

0.21.0 范围功能的四个复审修正（无破坏性变更）：

- **库身份统一为目录名**：`/kb/api/scope` 的 `resolved`、胶囊勾选与 PUT 载荷、导入查重同库判定、
  彻底删除的范围别名清理都以目录名为准；清单 `name` 只作为显示名（API/胶囊/查重报告仍显示它）。
- **文档解析单一来源**：`kb_read` / `kb_view` / `kb_edit` / `kb_describe` / `kb_keep` / `kb_trust` /
  `kb_retitle` / `kb_remove` / `kb_restore` / `kb_history` 跨库解析后直接使用解析器返回的文档，
  只有解析器未返回文档时才回退到库内 `resolveDoc`，避免二次解析产生分歧。
- **范围 TTL 续期**：工具真正使用范围时按 24 小时粒度刷新 `updatedAt`，活跃会话不会在
  `scopeTtlDays` 后过期；GET 与系统提示仍只读不续期。
- **系统提示措辞**：静态系统提示（order 106）的导入查重说明改为「当前库及本会话范围内的知识库
  （未限定范围时为全部）」，与 2B 的范围化查重一致。

## 侧栏入口（0.19.1）

桌面端/网页端的左侧栏底部新增「知识库」入口：

- 展开侧栏显示数据库图标 + “知识库”；收起侧栏只显示图标；
- 点击在 DSH 内打开工作台弹窗，不离开当前页面、不新开浏览器标签；
- 弹窗内用 iframe 承载 `/kb/`；右上角 ×、Esc 或点击遮罩关闭；
- 入口激活时有与侧栏其他按钮一致的底色，字体/高度也一致；
- 客户端源码在 `src/client/index.tsx`，构建产物为 `lib/client.js`。

客户端构建：

```bash
npm run build:client   # 重新生成 lib/client.js
npm run check:client   # 校验产物是否与源码同步（npm test 会先跑）
npm run typecheck      # 客户端 TypeScript 类型检查
```

bundle 只依赖宿主提供的 React，不打包第二份 React；`package.json` 的 `dsh.client`
声明 `platform: "web"` 与对 `@deepseek-ai/dsh-client-ui-sidebar` 的依赖。

> **DSH 0.2.x 注意**：`client-modules` 要求 profile 里 loader entry 的 `name`
> 与 `package.json` 的 `name` 完全一致（本插件为 `dsh-knowledge-wiki`）。
> 如果从旧版的 `dsh-knowledge-base` 别名迁移，请把 profile `cordis.patch.yml`
> 的 `name` 改为 `dsh-knowledge-wiki`，并在 `~/.dsh/profiles/node_modules/` 建同名软链；
> 否则 `/kb/` 服务端仍可用，但客户端侧栏入口不会加载。

## 编译层：schema / index / log 与笔记（0.13.0）

对照 Karpathy「LLM Wiki」的三层结构，0.13.0 把知识库从“资料库 + 检索”补成**可累积的 Wiki**：
原始资料只读，之上的知识页由模型持续编译与维护。

- **schema.md（规则层）**：每个库根目录一份维护规范，写明三层约束、页面规范与
  ingest/query/lint 流程。建库导入时自动写入，**已存在不覆盖**；
  `kb_read(doc="schema")` 查看，`kb_edit(doc="schema")` 修订。系统提示会引导 agent
  先读规范再做整理，换领域时改这一份即可，不必改插件。
- **index.md（内容目录）**：由清单自动渲染，**编译页（笔记）排在原始资料之前**；
  每条包含标题、一行摘要、类型/字数/版本/更新时间与标签。`kb_read(doc="index")` 阅读
  （按 part 分页），导入/编辑/删除/编目后自动刷新。摘要两级：`kb_describe` 写的模型摘要优先，
  导入时的抽取式摘要兜底；重解析/重导入**不会覆盖**模型摘要。
- **log.md（操作流水）**：只追加，记录 `ingest / reparse / edit / note / note-update /
  describe / remove / restore / schema` 的时间、文档与版本；`kb_read(doc="log")` 查看，
  导出时一并带上。日志超过 1.5MB 自动只保留最近 3000 行。
- **笔记升级为 Wiki 页**：`kb_add_note` 支持 `kind`（summary/entity/concept/topic/note）、
  `tags`、`sources`（`docId#页码` 或 `[[标题]]`）；写入时解析来源并维护反链。
  `kb_read` 会显示“依据来源”和“被引用”（哪些笔记引用了这篇原文）。
- **不再增生**：同一标题再次调用 `kb_add_note` = 更新同一篇（版本+1、保留历史版本），
  省略的 kind/tags/sources 会沿用旧值；检索命中里笔记与原文都可按 docId 溯源。

清单升级到 v3（补 `summary/summarySource/tags` 与笔记 `kind/sources/linksOut`）。
旧库首次写入时惰性迁移，并按来源版本备份为 `kb.json.v2.bak`（v1 仍是 `kb.json.v1.bak`）；
迁移只补字段，不改正文。已有的旧库在下次导入/写笔记时自动获得 `schema.md`，
也可以直接 `kb_edit(doc="schema")` 修订来创建。

## 维护闭环：lint / 标题清洗 / 检索归一化（0.14.0）

- **`kb_lint`（体检）**：只做机械可判定项，语义矛盾仍需模型判断：
  - 导入失败、旧管线、文字层损坏/OCR 低置信；
  - 内容完全相同（`sourceHash` 重复）、同标准号 + 年份 + 阶段重复；
  - 同号不同阶段（征求意见/报批/发布/编制说明）**不判重复**，单独列为信息项；
    同号多版本也单独列出，提示可用 `kb_std_check` 查更新；
  - 未编目（没有摘要）、笔记没有来源、「续/修订版」标题、无入链笔记、缺 `schema.md`；
  - 输出分组问题 + 建议动作（`kb_reparse` / `kb_describe` / `kb_remove` / `kb_edit`），
    每组默认最多列 20 条，`maxItems` 可调。
- **`kb_retitle`（标题清洗）**：`cleanTitle` 保守去掉
  `(标准网-www.biaozhun.org)` / `_www.upbz.net` 等站点水印、`_span style=…` 残留、
  `1.`/`2、` 序号前缀，把 `GB_T`/`GBT`/`QGDW`/`T_CEC` 规范成 `GB/T`/`Q/GDW`/`T/CEC`，
  剩余下划线转空格。单篇传 `doc` 即可；批量 `all=true` 默认只预览（`dryRun=true`），
  确认后 `dryRun=false` 应用（逐篇保留历史、版本+1、重建合并版 H1）。
- **检索归一化**：`kb_query` 对“标准号 + 编号（+ 年份)”的简单查询自动扩展写法，
  `GBT 11032`、`GB∕T 11032`、`GB_T 11032` 都能命中 `GB/T 11032-2020`；
  年份分隔符 `- — – ~ ～` 等价；`GB 11032` 不会误命中 `GB/T 11032`。
  显式正则（含 `\d`、括号等元字符）原样执行，输出里会标 `expandedPattern` 说明已扩展。

## 已核对保留标记（0.18.0）

- **`kb_keep`**：把一组「同号同期同阶段」文档标记为已人工核对、决定全部保留
  （中英译本、不同分册、不同修订版、OCR 重制版等）。
  - 单篇 `doc` 或批量 `docs`（最多 200），可写 `note` 保留理由；
  - `clear=true` 取消标记；
  - 只改元数据，不递增版本号；`kb_list` / `kb_read` 显示 `[已核对保留]`。
- **体检**：整组都标记后，`kb_lint` 不再报该组重复，计数进 `dedupKeptGroups`；
  未标记的组仍照常报。
- 适合场景：中文翻译 + 英文原版、不同修订版、同标准 OCR 重制版等“看起来同号、
  实际都有独立价值”的组合。

## 分发与安装（0.17.0）

- **包名/loader id 改名**：`dsh-knowledge-wiki` / `knowledge-wiki`，避免与已收录的
  `htcqp802/dsh-knowledge-base` 撞名；仓库名仍是 `135642-163/dsh-knowledge-base`。
- **兼容 DSH 0.2.x**：`peerDependencies` 放宽到 `>=0.1.0-rc.6 <0.3.0`；
  已用 `dsh-tools@0.2.1-rc.2` 跑完整测试。
- **免 build script 安装**：`tesseract.js` 的 postinstall（OpenCollective 提示）会触发
  pnpm 的 build 审批、导致一键安装失败；改为把其 `src/` vendored 到 `vendor/tesseract`
  （Apache-2.0，保留 LICENSE），依赖只剩无 postinstall 的 `tesseract.js-core` 等。
  用全新 `DSH_HOME` 执行 `dsh plugin add file:...` 已无 `allowBuilds` 阻塞。
- 旧名安装迁移与市场状态见 [docs/distribution.md](docs/distribution.md)。

## 可信度标签（0.16.0）

- **`kb_trust`**：给文档标 `high` / `medium` / `low` / `unknown`（清除），可写理由。
  - 单篇：`doc`；批量：`docs` 列表；整库按条件：`all=true` + `query`（标题子串）/ `stage`（published / draft / material）。
  - 批量默认 `dryRun=true` 先预览；写入只改元数据，不递增版本号。
- **检索与阅读**：`kb_query` 命中项带 `trust`，排序对高可信加分、低可信减分但**不隐藏**；
  结果里标注 `[可信度:高/中/低]`，命中含低可信文件时给出提醒。
  `kb_read` 头部显示可信度；`kb_list` 可按 `trust` 过滤并显示标签；`index.md` 每条也带可信度。
- **使用约定**：多份资料矛盾时，优先采用高可信版本，同时告知用户低可信来源及分歧；
  已废止标准、草案、征求意见稿应标 `low`，报批稿/企业文件通常 `medium`，发布/现行标准与正式教材为 `high`。
- **旧版废止**：同号不同年时，若新版封面明确写“代替 <旧版号-年>”，把旧版标 `low`、
  理由写“已被 X 代替”；报批稿/征求意见稿不能作为废止依据。
- **体检**：`kb_lint` 会统计未标注可信度的文档并建议 `kb_trust`。

## 互操作与维护：Vault / 批量事务 / 快照（0.15.0）

- **Obsidian Vault 导出**：`kb_export(format="vault")` 生成 zip，解压即可作为 Vault 打开：
  - `index.md`（双链，编译页在前）、`schema.md`、`log.md`；
  - `wiki/topics|entities|concepts|summaries|notes/<标题>.md`：笔记带 YAML frontmatter、
    “依据来源”与“被引用”双链；
  - `wiki/sources/<标题>.md`：每份资料的摘要页（doc_id、页数、字数、原始文件链接、被引用笔记）；
  - `raw/`：`includeSources=true` 时包含原始文件（默认不含，避免几 GB 的扫描件）。
  - 文件名做文件系统安全化并全局去重，双链按文件名解析。
- **批量事务编辑**：`kb_edit_batch` 一次提交多条编辑，**先全量校验再写入**；
  任一条找不到 `old_string`/多处命中未 `replaceAll`/文档非 ready，整批不改；
  写入阶段失败会回滚已写分块，清单只在全部成功后一次性更新（版本号+1）。
  `dryRun=true` 只返回将替换的处数。同一文档一批只允许一条编辑。
- **库级快照**：`kb_snapshot` 把清单、`schema/index/log`、派生 `markdown/`
  （可选 `sources/`）打包到 `<知识库>/snapshots/<时间>-<标签>.zip`，
  并在同目录留 `.zip.json` 元数据；`list=true` 查看历史快照。
  默认不含 `sources/` 与 `history/`，用于批量编辑/重解析前留档；恢复见包内 `meta.json`。
- **存量摘要回填（0.15.1）**：`kb_describe(all=true, auto=true, limit=…)` 从合并版正文抽第一段
  回填缺失摘要；纯表格资料退化为「表格「工作表」：首行内容」，无可靠文字层的扫描件标注
  「扫描/影印资料…建议 kb_view」，已有模型摘要不覆盖，不递增内容版本号。

## PDF 双栏重排（0.12.0）

文字层 PDF 会逐页做保守的双栏检测：

- 左右栏首各至少 4 行，且每栏占正文行 ≥18%；两栏栏首中位数相距 ≥0.18 页宽；
- 中央装订线附近的行首 <15%；行内大间隙（表格单元格）过多的页直接跳过；
- 通栏标题/页眉页脚保持在原位，只把栏内行按“左栏从上到下、右栏从上到下”排序；
- 只处理文字层；扫描 OCR 页不重排。复杂三栏/图文混排/跨栏表格可能不触发，
  建议用 `kb_view` 对照原页。
- 触发重排的页会写进导入 warnings（`检测到双栏页：...`）。

## Word OMML 公式（0.10.0）

`.docx` 里的 OMML 公式会转成 LaTeX，并保持在正文原位置：

- 行内公式 → `$...$`，独立公式 → `$$...$$`；
- 支持常用结构：分数、上下标、根式、括号、求和/积分、函数、极限、
  矩阵/方程组、重音、上划线等；希腊字母/运算符映射为 LaTeX 命令；
- 无法完整转换的复杂公式会保留可读文本或 `[公式]` 占位，并在导入 warnings
  中提示；页眉/页脚/脚注里的公式暂不处理；
- 含公式的旧 `.docx` 需要 `kb_reparse` 才会重新提取；新导入直接生效。
- 公式仍建议对照原始 Word/`kb_view` 核对（尤其大型分式/矩阵）。

## 软删除与恢复（0.9.0）

- `kb_remove` 删除单个文档时**默认软删除**：清单标记 `status="deleted"` +
  `deletedAt`，`markdown/` 与 `sources/` 保留，可用 `kb_restore` 恢复；
  `soft=false` 才永久删除，删整库始终不可恢复。
- 软删除后：`kb_list` 仍显示该文档并标 `[已删除]`（可用 `status="deleted"` 过滤），
  `kb_query` / `kb_read` / `kb_view` / `kb_edit` / `kb_reparse` 默认排除，
  `kb_export` 的 md/jsonl/zip 也不包含；`kb_restore` 恢复后重新可读可搜。
- 重新导入同一文档（同 docId）会把软删除文档恢复为 ready 并更新内容。
- 注意：这是“软删除保护”，不是完整版本历史；覆盖导入/编辑的旧内容仍不保留。

## 版本历史（0.11.0）

- 在**覆盖导入/重解析**和**`kb_edit` 修订**前，自动把当前 `markdown/<docId>/`
  快照到 `history/<docId>/v<version>/`，并记录标题/字数/部分/大纲等元数据；
  每个文档最多保留最近 10 个版本。
- `kb_history` 查看版本列表（版本号/时间/原因/字数/部分）；`kb_restore(version=N)`
  恢复某个历史版本，恢复前会先把当前版本再存一份，因此恢复操作本身可反悔。
- 恢复后的当前版本号继续递增（例如 v2 恢复 v1 → 当前 v3），历史里保留 v1/v2；
  `kb_list` 会标 `[历史 N]`。
- 历史只快照 Markdown 内容，不复制原始 sources；`kb_view` 查看旧版本页面图时
  仍会打开当前源文件，需注意版本对应关系。

## Excel 导入（0.8.0）

`.xlsx` / `.xlsm` 按工作表转成 Markdown 表格：

- 支持共享字符串、内联字符串、富文本 run、数字/布尔/错误值；
- 公式取**缓存值**（Excel 保存时算出的结果）；没有缓存值时显示 `=公式文本`；
- 隐藏工作表跳过并告警；单表超过 2000 行 / 50 列会截断并告警；
- 日期/百分比等格式暂未还原，按单元格存储值显示；旧版二进制 `.xls` 不支持
  （请另存为 `.xlsx`）；宏（`.xlsm`）只读表格内容，不执行宏。

## OCR 质量（0.5.0）

- **逐页检测文字层损坏**：U+FFFD 替换字符、私用区字符（E011/E012 连字符除外）、
  以及拉丁字母被映射成 CJK 表意文字（`犃`–`犣`，如 `犌犅/犜` ← GB/T）。
  只有被判定损坏或文字量稀薄的页才走 OCR，不再需要为了一个坏文字层整本 `forceOcr`。
- **置信度保留**：rapidocr / tesserocr / tesseract.js 都返回 0–100 置信度；
  `ocrConfidence` 是 OCR 页平均值，`lowConfidencePages` 是低于 65 的页。
  原生 tesseract CLI 兜底后端不提供置信度（该后端下低置信列表为空）。
- **逐页质量 sidecar**：`markdown/<docId>/pages.json` 记录每页
  `{page, source, corrupted, confidence}`；清单里保存 `corruptedPages`/
  `lowConfidencePages`/`ocrConfidence`。
- **UI 告警**：`kb_list` 标注 `[文字层损坏 N页]` / `[OCR低置信 N页]`；
  `kb_read` 返回页码范围与 OCR 平均置信度，并在正文后提示问题页，建议 `kb_view` 核对。
- **精细控制**：`kb_import` / `kb_reparse` 支持 `forceOcrPages="12,48"` 与
  `skipOcrPages="1,2"`；`forceOcr` 仍可强制全部页面。

## 检索体验（0.4.1）

- `kb_list` 默认只返回前 50 个文档，并返回 `total`（筛选后）、`totalAll`（全部）、
  `offset`、`limit`、`hasMore`；用 `offset` 翻页，或用 `query`（标题子串）、
  `status`（ready/importing/failed）过滤。948 文档的库不再一次刷满上下文。
- `kb_query` 排序：标题命中 > 标题行（`#`/`##`）命中 > 同文档命中数 > 更新时间；
  同一文档默认最多保留 5 条，避免单个文档刷屏（在 `doc` 指定的单文档检索中放宽）。
- `kb_query` 传 `kb="*"` 检索全部知识库，结果带 `kb` 字段，并在跨库范围内重新排序；
  没有 `markdown` 目录的空库会被跳过，不会让整次检索失败。
- 旧笔记不再显示 `[旧管线]`（笔记没有原始文件，无法也不需要 `kb_reparse`）。

## RAG 小块导出（0.7.0）

`kb_export(format="jsonl")` 默认仍按 part 导出（兼容旧行为）；传
`chunkSize` 后按段落/句子切成适合 embedding 的小块：

```js
kb_export({
  kb: "标准",
  format: "jsonl",
  out: "/tmp/standard-chunks.jsonl",
  chunkSize: 800,      // 100–4000；建议 600–800
  chunkOverlap: 80,    // 0–300；建议 50–120
})
```

- 优先段落边界，其次中文/英文句末标点，超长句才硬切；每行 `text` 长度不超过 `chunkSize`。
- 每行字段：`kb`、`docId`、`title`、`type`、`part`、`parts`、`chunk`、`chunks`、
  `pageStart`/`pageEnd`（PDF 等有分块索引时）、`contentSource`（text-layer/ocr/note）、
  `chars`、`text`。
- 分块导出会去掉开头的 `<!-- doc: ... -->` 注释；分块/页码来自 `parts/index.json`，
  页码是 part 级范围（不是逐行精确页码）。
- md / zip 不受影响。

## 数据模型与引用锚点（0.4.0）

- 每个文档记录 `sourceHash`（sha256）、`parserVersion`、`contentSource`
  （`text-layer` / `ocr` / `mixed` / `converted` / `text` / `note`）以及
  `ocrEngine/ocrDpi/ocrLang/ocrPages/ocrModel`。
- **未变化不重跑**：同一文件、同一标题、同一管线版本再次 `kb_import` 时直接跳过，
  不重新 OCR；内容变化、标题变化或 OCR 模型变化时重新解析。强制重跑用
  `kb_reparse`（或 `kb_import` 的 `forceOcr`）。
- **清单 v1 → v2 惰性迁移**：读时兼容旧清单，首次写入时升级，并在知识库目录留下
  `kb.json.v1.bak`；旧文档会按 type 推断 `contentSource`，`kb_list` 显示 `[旧管线]`。
- **分块索引**：`parts/index.json` 记录每个 part 在合并版中的起止行与页码范围；
  `kb_query` 命中项返回 `part/pageStart/pageEnd`，`kb_read outline` 返回
  `{title, level, page, part}`，`kb_read` 读取某部分时返回页码范围。
  可直接用 `docId#p页码` 作为对外引用锚点。

## 导入前查重（kb_import 内置）

`kb_import` 在解析/OCR 之前，先用**文件名/标题**与当前知识库及全部知识库比对，
把匹配分成两档：

- **重合（exact）**：标准号/年份/版本桶一致，或标题规范化后完全相同 → 按规则跳过；
  - 同库重合 → 始终跳过（同路径同名文件例外：按原位更新，版本号 +1）；
  - 跨库重合 → 默认跳过并在结果中列出；确认需要时加 `allowCrossDuplicates: true` 重新执行。
- **相似（similar）**：短标题是长标题的完整前缀等低置信匹配（如「XX导则」vs「XX导则（试行）」）
  → **照常导入**，并在结果里列出候选，提示人工确认。相似不自动跳过，是为了避免把
  「国网浙江省电力有限公司电能质量管理规定」和以同一单位名开头的另一份通知误当成重复丢掉。

比对口径（`lib/dedup.js`）：

- 标准号归一：`GB/T = GBT`、`DL/T = DLT`、`Q/GDW = Q_GDW`，连字符/破折号（`- — – ~ ～`）
  等同，部分号小数点保留（`10650.2 ≠ 10650`）；
- 年份：双方都有年份时必须相同；一方无年份（如无年份的报批稿）不判重合——可能是新修订；
- 版本桶：发布稿/无标记、报批稿、征求意见稿、编制说明、送审稿、草案等互不判重合；
- 部/分册标记：`第N部分 / 第N分册 / 第N篇 / 第N卷` 不同的文件不判重合
  （`XX导则 第1部分` 与 `第2部分` 是两份文件）；
- 无标准号的文件按核心短语比对：规范化（去空白/标点、全半角归一）后**完全相等**才算重合；
  只是完整前缀的算相似，不自动跳过；仅共享一段公共前缀（如相同的单位名开头）不算匹配。

回归测试：`npm test`（隔离临时目录，不依赖本机知识库）。`node dev/dedup-test.mjs` 是早期
依赖本机知识库内容的开发脚本，内容变化后其固定 id 断言可能过期，不作为发布门禁。

## 指定知识库目录（kbRoot）

知识库根目录由插件配置 `kbRoot` 决定，默认 `~/.dsh/knowledge`。**一个插件实例（一个 profile）只有一个根目录**；
`kb_import` 的 `kb` 参数只是根目录下的子目录名，不是路径。工作台**总览页会只读显示当前根目录**，
`GET /kb/api/status` 也返回 `kbRoot`，可用它们确认配置是否生效。

### 方式一：市场 / GitHub 安装（bundle，推荐）

插件安装后由包内 `cordis.patch.yml` 自动挂载（loader id `knowledge-wiki`）。用户只需在自己的 profile
用户层**按 id 覆盖要改的键**，**不要**再写一条 `insert: id: knowledge-wiki`（重复 loader id 会启动失败）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: knowledge-wiki
  config:
    kbRoot: /Users/alice/知识库      # Windows 例：D:\知识库
    defaultKb: 标准
```

保存后由 HMR 热应用；没生效就重启 `dsh web`。

### 方式二：一键脚本参数（源码 / 本机安装）

```bash
./install-to-machine.sh [插件目录] [知识库根目录]        # macOS / Linux：第二个参数
powershell -ExecutionPolicy Bypass -File install-to-machine.ps1 -KbRoot D:\知识库 -DefaultKb 标准
```

脚本写的是它自己的 `insert` 行（id `knowledge-base`）；从 bundle 安装迁移过来时，先删掉旧的 `insert`。

### 验证

```bash
dsh --profile web --dump-config | grep -A8 knowledge-wiki   # 看最终生效的 kbRoot
curl -s http://127.0.0.1:<dsh 端口>/kb/api/status            # 返回里有 kbRoot
```

也可以直接看工作台总览页的「知识库根目录」。启动成功后根目录下会出现 `.plugin-load.log`。

### 注意

- **用绝对路径**。当前只展开 `~` 和 `~/`（Windows 的 `~\` 不展开，也不支持 `$HOME` / `%USERPROFILE%` 展开）；
  相对路径按 `dsh` 进程的工作目录解析，容易落到意外的位置。
- **改根目录不会迁移数据**：旧目录原样保留但不再显示。要迁移就停插件 → 移动整个目录 → 改配置 → 重启；
  会话范围（`<kbRoot>/.scopes.json`）也随根目录走，等于换了一套库和范围。
- **不要多机/多进程同时写同一个根目录**：SQLite WAL 与清单写入是单机假设；共享盘只建议一个写入者。
- 需要多套互不干扰的资料时，用多个 profile 各自配 `kbRoot`（例如 `dsh --profile work`）。
- 自定义了 `DSH_HOME` 时，插件默认值仍是 `~/.dsh/knowledge`，需要显式配 `kbRoot`。

## 配置（cordis.patch.yml 中该插件的 config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `kbRoot` | `~/.dsh/knowledge` | 知识库根目录（怎么改见「指定知识库目录（kbRoot）」） |
| `defaultKb` | `default` | 未指定 kb 时的默认知识库 |
| `ocrLang` | `chi_sim+eng` | OCR 语言（竖排古籍可试 `chi_sim_vert`） |
| `ocrWorkers` | `0`（自动） | OCR 并行 worker 数；0 = 按本机 CPU/内存自适应：`min(核数一半, 内存/1.5GB)`，下限 2、上限 16（24 线程/32GB 机器 ≈ 12） |
| `ocrDpi` | `0`（自动） | 扫描页渲染分辨率；0 = 300 DPI（tesseract best 模型的设计分辨率；低清扫描源可显式调低，上限 400） |
| `ocrEngine` | `auto` | OCR 引擎：auto（rapidocr > tesserocr > 原生 tesseract > wasm 兜底）/ rapidocr / tesseract / wasm |
| `pdfColumnReorder` | `true` | 文字层 PDF 是否自动检测双栏并重排阅读顺序；误判时可关闭 |
| `autoDownloadModels` | `true` | tesseract 家族模型缺失时自动下载到 `~/.dsh/tools/tessdata`；rapidocr 自带模型不触发 |
| `ocrNativeBin` | `""` | 原生 tesseract / tesserocr 环境的显式二进制或 python 路径（留空自动探测） |
| `ocrPythonBin` | `""` | rapidocr 环境的显式 python 路径（留空自动探测 `~/.dsh/tools/rapidocr-env` 与 PATH） |
| `ebookConvertBin` | `""` | Calibre ebook-convert 的显式路径（MOBI/AZW3 转换用；留空自动探测 PATH、`~/.dsh/tools/calibre`、macOS 默认安装位置） |
| `officeKitCli` | `""` | LibreOfficeKit CLI 的显式路径（Office 原件预览转 PDF；留空自动探测 `DSH_OFFICE_KIT_CLI`、`DSH_OFFICE_KIT_HOME`、`~/.dsh/tools/libreoffice-kit` 默认安装与 PATH 里的 `dsoffice`） |
| `maxInlinePages` | 20 | 超过则转入后台任务导入 |
| `maxInlineBytes` | 10MB | 文件总字节数超过则转入后台任务导入 |
| `partMaxChars` | 8000 | 分块大小（字符） |
| `readMaxChars` | 20000 | kb_read 单次返回上限 |
| `queryMaxMatches` | 40 | kb_query 单次返回的匹配行上限 |
| `queryLineBytes` | 400 | kb_query 单行预览的最大字节数 |
| `importTimeoutMs` | 600000 | kb_import 工具调用超时（内联导入） |
| `uiMaxUploadBytes` | `2147483648`（2 GiB） | 工作台上传单文件上限（字节，1 MiB–16 GiB） |
| `uiMaxBatchFiles` | `1000` | 工作台上传单批次文件数上限（1–5000） |
| `scopeTtlDays` | `30` | `selected` 会话范围条目过期天数（`none`/`all` 不做 TTL 清理）；0 = 不过期 |
| `scopeLintMaxKbs` | `20` | `kb_lint` 在限定模式下最多检查多少个库 |
| `trashRetentionDays` | `0` | 回收站自动清理：已删除资料超过 N 天自动彻底删除；0 = 关闭，允许 0–3650；跨库移动墓碑始终保留 |

> 0.22.0 新增可选的 `officeKitCli`（Office 原件预览转 PDF）；0.23.0 起配 `officeKitCli` 之外还可用
> 环境变量 `DSH_OFFICE_KIT_CLI`（显式 CLI）或 `DSH_OFFICE_KIT_HOME`（安装/探测目录，一键安装也会装到
> 这里）。`scopeTtlDays` 仍控制 `selected` 会话范围条目的过期天数（`none`/`all` 不做 TTL 清理），
> `scopeLintMaxKbs` 仍是 `kb_lint` 逐库上限。0.25.0 新增 `trashRetentionDays`（默认 0 = 关闭）。

> 引擎选择：默认只有内置 **tesseract.js（WASM）** 可用，零安装、全平台可移植。
> 可选加速：`~/.dsh/tools/rapidocr-env` 装 RapidOCR（Python，中文印刷页最快）或
> `~/.dsh/tools/tesseract-env` 装原生 tesseract（Windows 用 micromamba 建环境，
> 二进制探测支持 conda 的 `Library/bin`/`Scripts` 布局）；在 tesseract-env 中
> `micromamba install -c conda-forge tesserocr pillow` 后会启用**常驻 tesserocr 后端**
> （引擎常驻内存，免去原生 tesseract 每页进程启动与模型重载的开销）。
> 多个后端都被探测到后 `auto` 自动择优。

## 中文 OCR 模型数据

`data/tessdata/` 预置 tesseract 中文模型（chi_sim / chi_sim_vert / eng，best 版，
仅保留 `.traineddata.gz` —— tesseract.js（WASM）与 tesseract 4.00+/tesserocr
均可直接读取 gz 格式）。缺失时可重新下载：

```bash
mkdir -p data/tessdata
cd data/tessdata
for l in chi_sim chi_sim_vert eng; do
  curl -fL "https://cdn.jsdelivr.net/npm/@tesseract.js-data/$l/4.0.0_best_int/$l.traineddata.gz" -o "$l.traineddata.gz"
done
```

> **市场/GitHub 安装默认会自动补模型**：`.gitignore` 不提交 `data/tessdata/`（约 35 MB），
> 因此首次走 tesseract 家族 OCR 时，`autoDownloadModels=true` 会优先复用已有模型，
> 把缺失模型下载到 `~/.dsh/tools/tessdata`；rapidocr 自带模型，不会触发下载。
> 关闭自动下载后，第一次 OCR 会报“OCR 语言模型缺失”并给出上述手动下载命令。
> 知识库根目录下的 `.plugin-load.log` 也会记录 `tessdata=ok` / `tessdata=missing:...`。

## 测试

```bash
npm test          # node:test（1022 个用例）；覆盖查重精度、同名文件保护、后台失败统计、检索截断/单文档上限、
                  # 相似导入提示、OCR 模型检查、流式 zip、心跳与锁回收、
                  # 清单 v1→v2→v3 迁移与备份、内容哈希跳过、kb_reparse、分块索引/页码锚点、
                  # kb_list 分页/过滤/kind、检索排序、跨库检索、文字层质量启发式、
                  # 逐页 OCR 决策、OCR 帧置信度、质量告警、模型自动下载、
                  # RAG 小块切分与 jsonl 分块导出、xlsx 表格解析、
                  # Word OMML 公式转 LaTeX、PDF 双栏重排、
                  # 软删除/恢复、版本历史快照/恢复、
                  # schema/index/log 虚拟文档、kb_describe 编目与重解析保护、
                  # 笔记 kind/tags/sources/同标题 upsert、反链、导出 frontmatter 与索引、
                  # kb_lint 分组与假阳性防护、kb_retitle 清洗/批量预览、标准号检索归一变体、
                  # Vault 导出结构/双链、批量事务编辑的回滚与 dryRun、库级快照创建/列表、
                  # 存量摘要回填（模型摘要保护/limit/remaining/表格兜底）、
                  # 可信度标注/过滤/排序/低可信提醒、
                  # 会话范围存储/继承/工具矩阵/提示段/API/归档重命名同步、
                  # 范围「未启用」模式（21 工具 KB_DISABLED、空选择归一为 none、PUT/胶囊/继承/清理）、
                  # 胶囊客户端（注册、面板、应用/失败回滚、可访问性、外部点击延迟还焦点）VM 测试、
                  # 资料工具栏（防抖/输入法/跳页/每页条数/清除/焦点/旧响应丢弃）fake DOM 测试、
                  # 资料搜索（标题+摘要+标签）与状态筛选、笔记列表、状态徽标与重命名弹窗、
                  # 原件预览（白名单 inline、Office→PDF 缓存/并发合并/引擎缺失、/content 截断与转义）、
                  # 临时/锁文件识别、导入跳过与 kb_lint 分组、
                  # 资料生命周期（软删除/恢复原状态/彻底删除确认、导入中拒绝、error/movedTo 投影）、
                  # 失败资料重试（kb-reparse 任务、原件缺失、非失败拒绝、轮询/超时/结果提示）、
                  # 跨库移动（预检摘要与冲突分组、同 ID/内容/标题策略、副本命名、50 篇/500 MB 上限、
                  # 逐篇事务与部分失败、撤销移动、journal 崩溃恢复与暂存清理）、
                  # 删除/移动/重试 UI（多选工具条、确认弹窗、目标库过滤、结果页与撤销进度、行内重试）、
                  # 总览单条类型条 + 可信度圆点（无第二比例条、非零项/颜色/hover 计数）、
                  # Office 引擎状态与一键安装（同意校验、已安装短路、缺 Node/npm、后台任务进度、capabilities 校验）、
                  # 全局回收站（活跃库扫描/归档与合并库排除、字段投影、deletedAt 倒序、500 篇上限与 truncated、
                  # 按库批量彻底删除的库名确认/all 与 ids 二选一/409 分支、部分失败、日志与索引刷新）、
                  # 回收站搜索与排序（库名/标题/类型/来源文件、大小写、未知排序回落、六种排序、
                  # 同刻/同名稳定兜底、非法日期最后、过滤后 total/truncated）、
                  # 跨库批量彻底删除（整句确认「彻底删除 N 篇」、kb+id 去重、全量预检整批拒绝、
                  # 未知/归档库与在用资料 409、500 上限、部分失败、逐库日志/索引、写请求同源、
                  # 锁内复验并发恢复不误删）、
                  # 回收站自动清理（保留期边界、movedTo/非 ISO 时间/归档合并库/导入中跳过、单篇失败继续、
                  # 单轮 500 上限 capped、锁内复验恢复不误删、逐库计数、GET 每小时节流、启动清理、
                  # trashRetentionDays 默认 0/夹取边界、重新导入清 deletedAt/deletedFromStatus）、
                  # 回收站 UI 纯函数（两页签与 hash、搜索/排序工具条、筛选空态与清除搜索、
                  # 行内恢复/撤销移动按 movedToState 渲染、选择键、
                  # 批量恢复目标排除目标仍可用的移动行、跨库批量彻底删除、确认短语与正文、移动资料警告）、
                  # 移动源生命周期（目标副本 live/deleted/missing 矩阵、恢复清 movedTo、
                  # 目标库归档/不存在、无重复可用副本）、
                  # 0.26 资料编目与摄取（摘要/标签归一化与 manual 来源、标签 facets、schema v6 迁移、
                  # 正文优先标准号与完整性矩阵、去重矩阵、回填脚本 dry-run/apply、lint 元数据分组、
                  # 来源 sources/深链、viewer 与预览降级）、
                  # 0.26 检索索引（条款切分、FTS5 建/增量/损坏回退、中文分词、kb_query 双路径积分）、
                  # 0.27 检索工作台（标准号路径判定与 GB≠GB/T、文档级归并与 boost 排序、snippet 窗口、
                  # 过滤/facets/分页、搜索页渲染与安全高亮、防抖/IME/Enter/旧响应作废/加载更多、
                  # 60 题评测集结构）、
                  # 0.28 PDF viewer（页码语义、旋转矩阵与四象限坐标、命中计数与 240 上限、
                  # 扫描件/未命中横幅、转义、viewer.html 参数夹取、page.png 内存+磁盘缓存、
                  # 旋转后页图宽高互换、预览纯函数改用 viewer URL）、
                  # 0.29 评测纯函数（RRF 融合的单/双列表顺序、k 平滑、字符串文档 id、
                  # 空值过滤；条款行→文档级顺序与页码区间；嵌入文本拼装与截断）、
                  # 0.30（20 条独立同义题集结构与 id 冲突、文档级 dense/RRF 变体、
                  # 扫描件无检索词也提示、卡片「命中 N 条条款」与 viewer「高亮 N 处」区分）
                  # （全部使用临时目录，不依赖本机知识库）
```

> **自动化边界**：`npm test` 覆盖回收站的可导出纯函数与 API；`npm run test:e2e` 的真实浏览器流程覆盖
> 回收站两页签、行内恢复、行内/批量彻底删除、清空本库、搜索/排序/筛选空态与跨库选择、资料编目、
> 上传状态、深链预览与**检索工作台（标准号区分、关键词高亮、过滤、清除、深链预览）**；
> `loadTrash` 旧响应作废（token）、刷新后清空选择、跨库恢复循环**不在 E2E 套件内**（仍只有一次性
> WKWebView 验收）；CI 的全新 profile 上胶囊用例自动 skip。`npm test` 本身仍不需要浏览器。

## 端到端测试（Playwright）

`npm test` 之外另有一条真实浏览器 E2E（**不在** `npm test` 内，不改变发布包运行时）：

```bash
npm run e2e:install   # 首次安装 WebKit + Chromium（约 300 MB；可重复执行）
npm run test:e2e      # 自托管临时 DSH web 宿主并跑完整流程
```

- 自托管：临时 profile `e2e-<6hex>`（优先软链真实 `web` profile 的 `node_modules`，否则用
  `profiles/node_modules` 共享目录）+ 临时 `kbRoot`（`os.tmpdir()/kb-e2e-*`），结束或中断自动清理；
  **不会修改** `~/.dsh/profiles/web` 或真实知识库。
- 固定数据：甲库/乙库（活跃）+ 丙库（归档）；直接写 `kb.json`、`sources/`、`markdown/`，
  覆盖 ready / deleted / failed / note / PDF / docx。
- 覆盖流程：已删除资料的搜索（库名/标题/类型/来源文件）、六种排序、筛选空态与清除搜索、跨库多选；
  回收站两个页签（恢复、逐字输入库名彻底删除、批量删除、清空本库）、
  跨库移动 → 撤销 → 再次移动 → 目标副本删除后的墓碑恢复、失败资料重试、
  PDF/笔记/Office 原件预览、资料编目（摘要/标签保存 + 标签筛选）、上传解析状态与重复跳过、
  `?doc=&page=` 深链预览/缺资料 toast、输入框胶囊（清空/全选/应用/外部点击关闭）。
  来源面板用例会写一个合成 session 并挂到临时 workspace；CLI 0.1.x 的历史投影不把
  `tool/result` 关联到工具行（工具行停在 running），该用例会 **skip** 并说明原因；
  桌面/支持 tool result meta 的宿主会继续断言工具行来源、本轮来源与深链跳转。
  工具行/面板渲染与降级本身由 `test/sources-client.test.mjs` 覆盖。
- 浏览器优先 WebKit（DSH 桌面端引擎），失败回退 Chromium；失败产物写到
  `test/e2e/.artifacts/<timestamp>/`（截图、URL、console 错误、宿主日志），
  正常也会打印本次产物目录。
- 可选环境变量：`DSH_E2E_URL` 复用已启动宿主（要求其 `kbRoot` 在临时目录，或显式
  `DSH_E2E_ALLOW_MUTATE=1`）、`DSH_E2E_TOKEN`（全新 DSH_HOME 首次启动会要求 token，
  E2E 会从宿主日志自动读取；外部宿主可用此变量显式提供）、`DSH_E2E_BROWSER=chromium`、
  `DSH_E2E_KEEP=1`、`DSH_E2E_PYTHON=<python>`、`DSH_E2E_ONLY=<用例名子串>`（只跑匹配用例，
  调试用）、`DSH_E2E_DSH_BIN=<dsh 路径>`、`DSH_E2E_SOURCE_PROFILE=<profile>`。
- 浏览器下载走 Playwright CDN；受限网络可用 `PLAYWRIGHT_DOWNLOAD_HOST=<mirror>`
  后重试 `npm run e2e:install`。Chromium 下载失败（CDN/镜像缺对应版本）不影响套件，
  可只装 WebKit：`npx playwright install webkit`（套件本来就优先 WebKit）。
- **CI（GitHub Actions，`.github/workflows/ci.yml`）**：
  - `unit` job（ubuntu）：`npm ci` → `typecheck` → `npm test`，每次 push/PR 自动跑。
  - `e2e` job：**手动 `workflow_dispatch` + `run_e2e=true`**，在自托管
    `[self-hosted, macOS, dsh-profile]` runner 上跑完整套件（runner 需有 `dsh`、
    已登录的 web profile/工作区会话，胶囊不会 skip）；来源面板是否执行取决于宿主是否
    保留 tool result meta。失败上传 `test/e2e/.artifacts`。
  - 为什么不在 GitHub 托管 runner 上自动跑：全新 `DSH_HOME` 首次启动会要求一次性
    token，浏览器/同源 API 的认证链路在托管 runner 上不稳定，且没有历史会话/模型凭据
    （胶囊无法挂载）。自托管 runner 复用已配置 profile，结果与本地一致（当前 10/10 + 1 skip）。
  - 本地有凭据 profile 当前 **11 passed / 0 failed / 1 skipped**（skip = CLI 0.1.x
    未投影 tool result meta），E2E 中的回收站用例会真实执行一次**跨库批量彻底删除**。

## 使用示例（对 harness 直接说）

- “把 /Users/me/资料 目录导入知识库「项目管理」，其中有两本扫描版书，导入后告诉我结构”
- “在知识库「项目管理」里查一下‘进度偏差 纠偏措施’，结合上下文给我分析”
- “先读一下知识库的维护规范，再按它的流程整理这批新资料”
- “把刚才的分析结论沉淀成专题页，注明依据哪几份原文、第几页”
- “给这几份标准各写一行摘要和标签，方便以后在索引里找”
- “把知识库中关于 XX 的内容整理成一份 20 页的培训课件（PPT 结构）”
- “导出知识库为 markdown 单文件，我要上传给其他 AI”

## 插件实现说明

- 纯 JS/WASM 解析栈：mammoth（Word）、JSZip+fast-xml-parser（PPT/Excel）、
  mupdf（PDF 文字层/渲染）、tesseract.js（OCR）、@vscode/ripgrep（检索）——
  除 npm 依赖外无系统要求；导出 zip 同样用内置 JSZip 打包，不依赖系统 `zip`/`tar`。
- .doc/.ppt 转换跨平台：Windows → Word/PowerPoint COM；macOS → textutil；Linux → LibreOffice；
  转换全部异步执行（不阻塞宿主事件循环），旧格式导入强制走后台任务。
- MOBI/AZW3 电子书经 Calibre `ebook-convert` 转 EPUB 后复用 EPUB 解析管线（未安装 Calibre
  时给出明确提示）；转换同样只在后台 worker 中执行。
- OCR 并发数与 DPI 按本机 CPU 核数/内存自适应（见配置表），无需手工按机器调参；
  rapidocr/tesserocr 后端为常驻进程帧协议，模型只加载一次。
- 后台导入 = 子进程 worker + harness 原生 jobs 服务（`ctx.jobs`），可取消（显示为
  cancelled）、可流式看进度；worker 支持 `@json文件` 方式传参，避免 Windows 命令行
  长度/引号截断。
- 所有写入经暂存目录原子提交；清单更新带目录锁，支持并发安全；同一文档 30 分钟内的
  重复导入自动跳过；插件加载时会自动清扫崩溃遗留的 `import-tmp` 暂存目录。
- 导出（md/jsonl）流式写入、zip 用 Node 流直接进 JSZip，超大知识库不产生内存尖峰。
- 每个文档 `type` 自动判定：`pdf-text` / `pdf-scanned` / `pdf-mixed`。

## 接入方式

### 从 GitHub / 市场安装（推荐）

插件已声明 `dsh.bundle.patch`，安装后由包内 `cordis.patch.yml` 自动挂载，
**不需要**手工编辑 profile 的 `cordis.patch.yml`（要改知识库根目录见「指定知识库目录（kbRoot）」）：

```bash
dsh plugin --profile web add github:135642-163/dsh-knowledge-base
```

市场（dsh-market）上架后也可一键安装。更新只需 `git push origin main`：
市场对 GitHub 安装比较已安装 commit 与远端 HEAD，不需要 tag/Release。

> 本插件包名已改为 `dsh-knowledge-wiki`、loader id 为 `knowledge-wiki`，避免与另一位作者的 `dsh-knowledge-base` 撞名；npm 暂未发布（未登录 npm），当前走 GitHub 安装。
> 分发策略、旧脚本安装迁移与 catalog 提交见 [docs/distribution.md](docs/distribution.md)。

### 从源码安装（Git 仓库，通用）

仓库不包含 `node_modules/` 与 OCR 模型，克隆后按顺序执行：

```bash
cd dsh-knowledge-base
npm install          # 安装依赖（生成 node_modules/）
```

然后下载中文 OCR 模型（见上文「中文 OCR 模型数据」的下载脚本，`data/tessdata/` 与
`data/tessdata-fast/` 各一份）。需要 MOBI/AZW3 时另外安装 [Calibre](https://calibre-ebook.com/)
并确保 `ebook-convert` 在 PATH 中（或配置 `ebookConvertBin` 指向它）。
之后按平台继续下面的 Windows / macOS / Linux 步骤。

### Windows

1. 打包分发版插件目录内自带 `node_modules/`（依赖自包含）与 `data/tessdata/` 中文 OCR 模型；
   从 Git 源码安装时按上一节先执行 `npm install` 并下载模型。
2. 运行一键脚本（普通 PowerShell 即可，无需管理员权限）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Users\Moon\.dsh\plugins\dsh-knowledge-base\install-to-machine.ps1
   ```
   脚本做三件事：建立目录联接 `~/.dsh/profiles/node_modules/dsh-knowledge-wiki`、
   把注册行（id `knowledge-wiki`）写入 `~/.dsh/profiles/web/cordis.patch.yml`、启用 HMR 监视插件源码。
   也可手工执行等价操作（`cmd /c mklink /J <目标> <插件目录>` + 编辑 cordis.patch.yml）。
3. 正在运行的 `dsh web` 会**热应用** cordis.patch.yml 的变更——知识库根目录
   （`~/.dsh/knowledge`）下出现 `.plugin-load.log` 即加载成功；否则重启 `dsh web`。
4. 新开一个会话，说“调用 kb_list”验证。

### macOS / Linux

参照仓库根目录的 `install-to-machine.sh`（软链 + cordis.patch.yml 注册，macOS 用软链替代目录联接）。

## 标准更新检查（kb_std_check）

对知识库（默认「标准」库）中的标准做更新检查：从文档标题自动提取标准号（GB/NB/DL/QGDW/IEC/团体标准等），
在标准网 biaozhun.org 逐条检索比对年份；发现新版本或「草案已有正式版」时，用登录会话自动下载 PDF
并直接导入知识库（旧版原文保留）。支持 `check`（只报告）/ `check-download`（默认，检查并下载）、
`force`（忽略 7 天缓存全查）、`limit`（分批）、`dryRun`（模拟）。

- 增量缓存：`<kbDir>/.std-check.json`（中断后再次调用自动续查）
- 下载凭据：config `bzCookie` —— 用户在浏览器登录 biaozhun.org 后提供的 Cookie 串
  （站点仅微信扫码登录；未配置时工具只做检查报告）
- 请求限速：config `stdRateMs`（默认 1200ms/次），防站点封控
- 站点每次下载消耗 6 金币（VIP 免金币），金币不足的标准在报告中列出失败原因
