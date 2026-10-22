# dsh-knowledge-base — DeepSeek Harness 知识库插件

把 Word / PPT / Excel / PDF（文字版与扫描版）等资料整理成**适合大模型阅读、学习的形式**，
存放在**固定、可命名、可导出、可持续修订**的知识库中；deepseek 通过一组 `kb_*` 工具
随时调用知识库内容进行问答、推理、整理、课件与文档制作等工作。

## 能力

| 工具 | 作用 |
| --- | --- |
| `kb_import` | 导入文件或目录（.docx / .doc 自动转换 / .pptx / .xlsx / .xlsm / .pdf / .md / .txt / .epub / .mobi / .azw3，扫描版 PDF 自动逐页 OCR 中文，自动识别文字层损坏页并只对问题页 OCR，文字层双栏页自动重排；Word OMML 公式转 LaTeX；Excel 按工作表转 Markdown 表格；.txt 自动识别 UTF-8/UTF-16/GBK；MOBI/AZW3 自动经 Calibre 转 EPUB）。旧版 .doc/.ppt 与 MOBI/AZW3 一律在后台任务中转换；正在导入中的同名文档自动跳过。**导入前自动查重**：同库重合跳过、跨库重合默认跳过并报告（见下文） |
| `kb_reparse` | 从库内 `sources/` 重新解析文档（无需重新上传），用于 OCR/解析器升级后刷新旧管线产物；`doc` 单个、`all=true` 批量，支持 `forceOcr`、`forceOcrPages`/`skipOcrPages`、后台任务 |
| `kb_list` | 列出知识库 / 知识库内文档与状态（旧管线/已修订/文字层损坏/OCR 低置信会标注），每条带一行摘要与标签；默认最多 50 条，支持 `limit/offset/query/status/kind` 分页过滤（`kind=note` 只看笔记、`kind=source` 只看资料）；本库有维护规范时会提示 |
| `kb_query` | 全文检索（ripgrep 正则，中文短语直接搜；标准号自动兼容 GBT=GB/T=GB_T=GB∕T 与年份分隔符变体）；按标题/标题行/命中密度/更新时间排序，每文档默认 5 条；`kb="*"` 跨库检索；命中项带 part、页码与笔记类型 |
| `kb_read` | 按分块精读、读大纲、读整篇；大纲条目带页码/部分，读取时返回页码范围；支持虚拟页 `doc="schema"`（维护规范）、`doc="index"`（内容索引）、`doc="log"`（操作日志），按 part 分页读取 |
| `kb_view` | 查看原始页面图片（PDF 按页渲染；Word/PPT/EPUB/MOBI 提取内嵌图）——公式、原理图、电路图专用 |
| `kb_edit` | 精确替换修订（持续修改完善）；`doc="schema"` 可修订该库维护规范（index/log 自动维护，不能编辑） |
| `kb_describe` | 给文档写一行摘要与标签（编目）：摘要会显示在 `kb_list` 与 `index.md`，重解析/重导入不会覆盖模型写的摘要；存量文档可 `all=true` + `auto=true` 批量回填缺失摘要（抽取式，不递增版本号，`limit` 分批） |
| `kb_retitle` | 修正标题：单篇传 `doc`（默认按 `cleanTitle` 去掉站点域名、`GB_T`、序号、span 残留等噪声），批量传 `all=true`（默认 `dryRun=true` 只预览，确认后 `dryRun=false` 应用）；会重建合并版首行标题、保留历史、版本+1 |
| `kb_lint` | 机械体检：导入失败、旧管线、文字层损坏/OCR 低置信、内容重复、同标准号同期同阶段重复、同号多版本、未编目、笔记无来源、续/修订版提示、无入链笔记、缺 schema；输出分组问题与建议动作（`kb_reparse`/`kb_describe`/`kb_remove`/`kb_edit`） |
| `kb_edit_batch` | 批量精确修订（事务语义）：一次提交 1–50 条 `{doc, old_string, new_string, replaceAll?}`，**先全部校验再写入**；任一条失败整批不改并回滚已写分块；`dryRun=true` 只校验。适合“一次改 10–15 页”的跨文档维护；同一文档一批只允许一条编辑 |
| `kb_snapshot` | 库级快照：把 `kb.json`、`schema/index/log`、派生 `markdown/`（可选 `sources/`）打包到知识库 `snapshots/`，用于批量编辑/重解析前留档；`list=true` 列出已有快照 |
| `kb_add_note` | 写入编译页/笔记（单篇上限 2MB）：`kind=summary/entity/concept/topic/note`、`tags`、`sources`（docId#页码 或 [[标题]]）；**同一标题再次调用=更新同一篇**（版本+1、保留历史），不要用「续」「修订版」另起新页 |
| `kb_remove` | 删除文档（默认软删除，可用 `kb_restore` 恢复；`soft=false` 永久删除）或整个知识库（删整库需 `removeKb=true` 且 `confirm` 逐字等于知识库名称） |
| `kb_restore` | 恢复软删除文档（不带 `version`）或恢复历史版本（`version=N`，来自 `kb_history`） |
| `kb_history` | 列出文档保存过的历史版本（覆盖导入/重解析/编辑前的快照，最多 10 个） |
| `kb_export` | 导出 md（单文件）/ jsonl（分块，RAG 用；`chunkSize`/`chunkOverlap` 可切 RAG 小块）/ zip（完整包，内置 JSZip 打包，不依赖系统命令）/ **vault**（Obsidian Vault：`index.md` + `wiki/` 笔记与资料页 + `[[双链]]`，`includeSources=true` 时带 `raw/`） |
| `kb_rename` | 重命名知识库 |

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

## 配置（cordis.patch.yml 中该插件的 config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `kbRoot` | `~/.dsh/knowledge` | 知识库根目录 |
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
| `maxInlinePages` | 20 | 超过则转入后台任务导入 |
| `maxInlineBytes` | 10MB | 文件总字节数超过则转入后台任务导入 |
| `partMaxChars` | 8000 | 分块大小（字符） |
| `readMaxChars` | 20000 | kb_read 单次返回上限 |
| `queryMaxMatches` | 40 | kb_query 单次返回的匹配行上限 |
| `queryLineBytes` | 400 | kb_query 单行预览的最大字节数 |
| `importTimeoutMs` | 600000 | kb_import 工具调用超时（内联导入） |

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
npm test          # node:test（134 个用例）；覆盖查重精度、同名文件保护、后台失败统计、检索截断/单文档上限、
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
                  # 存量摘要回填（模型摘要保护/limit/remaining/表格兜底）
                  # （全部使用临时目录，不依赖本机知识库）
```

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
**不需要**手工编辑 profile 的 `cordis.patch.yml`：

```bash
dsh plugin --profile web add github:135642-163/dsh-knowledge-base
```

市场（dsh-market）上架后也可一键安装。更新只需 `git push origin main`：
市场对 GitHub 安装比较已安装 commit 与远端 HEAD，不需要 tag/Release。

> 当前 npm 上的 `dsh-knowledge-base` 是另一位作者的包，因此暂不发布 npm；
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
   脚本做三件事：建立目录联接 `~/.dsh/profiles/node_modules/dsh-knowledge-base`、
   把注册行写入 `~/.dsh/profiles/web/cordis.patch.yml`、启用 HMR 监视插件源码。
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
