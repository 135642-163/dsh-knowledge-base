# 知识库质量只读审计报告（0.32 · 优先级 1）

- 生成时间：2026-10-30T16:28:16.927Z
- 知识库根目录：`/Users/littlesun/workspace/knowledge`
- 插件版本：0.31.9；解析管线：2026-10-22.2
- 扫描范围：7 个库 / 1566 篇（资料 1543、笔记 11）
- 只读校验：✅ 扫描前后清单与派生文件指纹一致（本轮未写库）
- 内容层扫描：1543 篇派生 markdown（单遍字符级统计）

## 1. 结论摘要

本轮共识别 **19 类**问题信号：error 0 类、warning 7 类、info 12 类。其中 error 级 0 条次，warning 级 118 条次（同一篇可能命中多类，按类累计）。

- **内容层丢字（U+FFFD）**：4 篇，而清单里的 `corruptedPages` 只标了 84 篇 —— 旧管线没有逐页质量元数据，只看 kb_lint 会漏掉这批硬伤。
- **元数据缺失**：2 篇没有 sourceHash，内容去重与标准号检索都会受影响。

## 2. 审计范围、方法与边界

**只读保证**

1. 脚本只 import `tryReadManifest` / `lintManifest` 与纯函数，不 import 任何写清单/写文档/删除函数；不调用 `listKbs`（它会 `mkdir` 根目录）。
2. 扫描前后对每库 `kb.json` / `index.md` / `log.md` / `schema.md` 取 mtime+size+ino，并对 `sources/`、`markdown/` 整棵树取条目数、总字节与最大 mtime；不一致即 exit 2。
3. 报告只写到 `--out`（默认 `docs/reports`），且拒绝写进被扫描的根目录。

**检查项**

| 分区 | 说明 |
| --- | --- |
| 导入与状态 | 失败/导入中/软删除/临时文件/缺 schema |
| 内容质量 | 0 字或极小正文、正文不完整、清单标注的坏页与低置信页、内容层 U+FFFD 与私用区字符、缺逐页 sidecar |
| 身份、标题与元数据 | 缺 sourceHash、标题含标准号但无结构化元数据、标题可清洗、旧管线产物 |
| 重复与版本 | 同内容（sourceHash/textHash）、同标题、同标准号同期同阶段、多版本、过程稿、同族写法 |
| 编译层（摘要 / 笔记 / 可信度） | 未编目、摘要乱码/过短、可信度缺失/偏低、笔记无来源/孤页/待合并 |
| 存储与派生层完整性 | 派生 markdown 与分块缺失/不一致、sources/ 孤儿原件 |
| 手工数据保护（清单，不是问题） | 手工维护字段清单（不是问题，供修复脚本避让） |

**未覆盖（需要人工或后续阶段）**

- 语义层面的矛盾/陈旧结论（同一主题多份资料说法冲突）——机械审计无法判定。
- 标准是否已有更新版本 —— 属于优先级 2（`kb_std_check`），本轮不查。
- 检索索引（FTS）新鲜度 —— 直接打开 `.index/fts.sqlite` 可能产生 `-wal/-shm` 文件，与只读约束冲突，本轮不查。
- 私用区字符（content-pua）只做统计，不建议批量重解析。

## 3. 总量（按库）

| 库 | 文档 | 资料 | 笔记 | 软删除 | 失败 | 导入中 | 内容扫描 | 派生缺失 | 坏页(清单) | U+FFFD | 私用区 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 变电试验 | 310 | 308 | 1 | 1 | 0 | 0 | 308 | 0 | 1 | 0 | 44 |
| 标准 | 911 | 900 | 7 | 4 | 0 | 0 | 900 | 0 | 50 | 3 | 101 |
| 电能质量 | 132 | 126 | 2 | 4 | 0 | 0 | 126 | 0 | 33 | 0 | 9 |
| 电气二次 | 8 | 8 | 0 | 0 | 0 | 0 | 8 | 0 | 0 | 0 | 0 |
| 电气工程教材 | 37 | 37 | 0 | 0 | 0 | 0 | 37 | 0 | 0 | 1 | 1 |
| 电气一次 | 11 | 7 | 1 | 3 | 0 | 0 | 7 | 0 | 0 | 0 | 0 |
| 历史 | 157 | 157 | 0 | 0 | 0 | 0 | 157 | 0 | 0 | 0 | 4 |

### 可信度构成（解释低可信是否需要处理）

| high | medium | low | unknown | low 的理由分布 |
| --- | --- | --- | --- | --- |
| 831 | 660 | 61 | 2 | 过程稿/说明材料 23；已被代替（已废止） 38 |

> `low` 大多是「已被新版代替的旧标准」或「征求意见稿/编制说明」，属于**正确的标注**，不要当成问题去修。

## 4. 问题分类与数量

### 导入与状态

| 类别 | 代码 | 严重度 | 数量 | 分库分布 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| 软删除文档（回收站） | `deleted-soft` | info | 12 | 标准 4 / 电能质量 4 / 电气一次 3 / 变电试验 1 | 正常现象：软删除文档在回收站，保留原件与分块；确认不再需要时可彻底删除 |

### 内容质量

| 类别 | 代码 | 严重度 | 数量 | 分库分布 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| 文字层损坏 / OCR 低置信 | `corrupted` | warning | 84 | 标准 50 / 电能质量 33 / 变电试验 1 | kb_view 核对坏页/低置信页；kb_reparse forceOcrPages=<坏页> 重识别 |
| 正文可能不完整（封面/目录可用但正文缺失） | `content-incomplete` | warning | 22 | 标准 22 | 核对是「只有封面/目录」还是「编制说明本就不全」；补完整版或降级标注 |
| 内容层 U+FFFD（文字层丢字，硬伤） | `content-fffd` | warning | 4 | 标准 3 / 电气工程教材 1 | 内容层有 U+FFFD（文字层丢字，硬伤）：先 kb_view 核对，再 kb_reparse forceOcrPages=<坏页>；整本都坏时 forceOcr=true |
| 正文极小（<200 字） | `tiny-content` | warning | 3 | 标准 3 | kb_view 核对是否只有封面/目录；能拿到完整版就重新导入（同名=原位更新） |
| PDF 缺逐页质量 sidecar（旧导入） | `pages-sidecar-missing` | info | 1298 | 标准 805 / 变电试验 228 / 历史 152 / 电能质量 72 / 电气工程教材 34 / 电气二次 7 | 旧导入没有逐页质量 sidecar，无法回看低置信页；需要时 kb_reparse 重建（不必批量做） |
| 内容层私用区字符（字体映射，多为公式/异体字） | `content-pua` | info | 159 | 标准 101 / 变电试验 44 / 电能质量 9 / 历史 4 / 电气工程教材 1 | 私用区字符（公式/异体字字体映射）：一般无需处理，抽查即可 |

**明细样例（每类前 8 条；完整清单见 JSON）**

| 类别 | 库 | docId | 标题 | 明细 |
| --- | --- | --- | --- | --- |
| corrupted | 变电试验 | `40cdbab3ce3c` | 国家电网公司变电检测管理规定（试行） 第31分册 纸绝缘聚合度测量细则 | 损坏 4 页，低置信 0 页 |
| corrupted | 标准 | `0e951cd6dd7f` | Electromagnetic compatibility (EMC) – Part 4-29: Testing and measureme | 损坏 1 页，低置信 0 页 |
| corrupted | 标准 | `8bd855c52ad2` | Electromagnetic compatibility (EMC) – Part 3-11: Limits – Limitation o | 损坏 3 页，低置信 0 页 |
| corrupted | 标准 | `dd699a895343` | Electromagnetic compatibility (EMC) – Part 3: Limits – Section 8: Sign | 损坏 1 页，低置信 0 页 |
| corrupted | 标准 | `07dad79f2b40` | Q/GDW 651-2011 电能质量评估技术导则 | 损坏 15 页，低置信 0 页 |
| corrupted | 标准 | `cfd57c0f0bde` | G5 5 Draft | 损坏 29 页，低置信 0 页 |
| corrupted | 标准 | `82491f32ccf9` | Electromagnetic compatibility (EMC) - Part 4-1: Testing and measuremen | 损坏 1 页，低置信 0 页 |
| corrupted | 标准 | `4073ed31b302` | Q/GDW 11-264-2010 典型扰动源接入电网电能质量评估导则 | 损坏 1 页，低置信 0 页 |
| corrupted | … | 共 84 条 | 其余 76 条见 JSON |  |
| content-incomplete | 标准 | `7c54e1fef03e` | GB 32880.3-2016 征求意见稿-编制说明 | partial（正文 1741 字，条款 0 条） |
| content-incomplete | 标准 | `17d50503c62b` | GB 32880.1-2016 征求意见稿-编制说明 | partial（正文 1322 字，条款 0 条） |
| content-incomplete | 标准 | `29353daaff6e` | GB 17626.30-2012 工作组讨论稿-编制说明 | partial（正文 1511 字，条款 0 条） |
| content-incomplete | 标准 | `0729a7f1e1f3` | GB 32880.2-2016 征求意见稿-编制说明 | partial（正文 1771 字，条款 0 条） |
| content-incomplete | 标准 | `51f1cdb13df1` | NB 41004-2014 征求意见稿-编制说明 | partial（正文 1278 字，条款 0 条） |
| content-incomplete | 标准 | `243a743f98f9` | NB 41005-2014 编制说明 | partial（正文 1705 字，条款 0 条） |
| content-incomplete | 标准 | `ea2d6a0c1e72` | IEC 61000-3-5-ed2.0c2-2010 | partial（正文 729 字，条款 4 条） |
| content-incomplete | 标准 | `b00642d6c83e` | IEC 61000-3-5-ed2.0c1-2009 | partial（正文 689 字，条款 0 条） |
| content-incomplete | … | 共 22 条 | 其余 14 条见 JSON |  |
| content-fffd | 标准 | `32138458cedd` | Q/GDW 12230.7-2022 无功补偿及谐波治理装置技术规范 | U+FFFD 24 处（页 33,34,37）；42358 字 |
| content-fffd | 标准 | `0d8e86b187bb` | 无功补偿及谐波治理装置技术规范第7部分：直流滤波器组 | U+FFFD 24 处（页 33,34,37）；58417 字 |
| content-fffd | 标准 | `b1603a0ba2cc` | Q/GDW 10212 电力系统无功补偿配置技术导则（报批稿） | U+FFFD 12 处（页 22,23）；23537 字 |
| content-fffd | 电气工程教材 | `62f666e7e814` | 从线性代数到张量计算 | U+FFFD 753 处（页 11,12,13,14,15,16,19,20,21,22,25,26,27,28,29,30,31,32,33,34,35,36,37,38,41, |
| tiny-content | 标准 | `a01187bc5353` | 电能质量限值计算说明 | chars=129 integrity=full —— 电能质量限值计算说明 |
| tiny-content | 标准 | `f3c0d4cc6f94` | 垂直档距和水平档距、代表档距的定义和计算 | chars=20 integrity=cover-only —— 垂直档距和水平档距、代表档距的定义和计算 |
| tiny-content | 标准 | `3bbcfb8d6105` | GB/T 528-2009 硫化橡胶或热塑性橡胶拉伸应力应变性能的测定 | chars=20 integrity=cover-only —— GB/T 528-2009 硫化橡胶或热塑性橡胶拉伸应力应变性能的测定 |

### 身份、标题与元数据

| 类别 | 代码 | 严重度 | 数量 | 分库分布 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| 元数据缺失（可回填） | `metadata-missing` | warning | 2 | 电能质量 2 | scripts/backfill-doc-meta.mjs --apply --hash --std --content（只补元数据，不动摘要/标题/可信度） |
| 标题含标准号但清单没有结构化标准号 | `title-standard-without-meta` | warning | 2 | 电能质量 2 | backfill-doc-meta --std --apply 解析结构化标准号；标题本身无需改 |
| 旧管线产物（可选刷新） | `stale` | info | 1441 | 标准 835 / 变电试验 306 / 历史 156 / 电能质量 93 / 电气工程教材 36 / 电气二次 8 / 电气一次 7 | 旧管线产物：不必批量刷新；只在遇到内容问题时按需 kb_reparse（all=true 分批 + limit） |
| 标题可再清洗（kb_retitle） | `title-cleanup` | info | 2 | 标准 1 / 电气二次 1 | kb_retitle dryRun=true 预览；确认后逐篇应用（不要整库一刀切） |

**明细样例（每类前 8 条；完整清单见 JSON）**

| 类别 | 库 | docId | 标题 | 明细 |
| --- | --- | --- | --- | --- |
| metadata-missing | 电能质量 | `709d485d3958` | GB/T 14598 | 缺结构化标准号 |
| metadata-missing | 电能质量 | `10c7a8d782b3` | GB/T 17626 | 缺结构化标准号 |
| title-standard-without-meta | 电能质量 | `709d485d3958` | GB/T 14598 | 可解析为 GB/T 14598 |
| title-standard-without-meta | 电能质量 | `10c7a8d782b3` | GB/T 17626 | 可解析为 GB/T 17626 |

### 重复与版本

| 类别 | 代码 | 严重度 | 数量 | 分库分布 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| 同标准号多版本 | `same-number-multi-year` | info | 61 | 标准 61 | 同一标准号的多个年份版本：保留旧版，用 kb_std_check 核对是否有更新（优先级 2 再做） |
| 同标准号同期不同阶段 | `same-number-stages` | info | 24 | 标准 24 | 属正常过程稿（征求意见/报批/发布），不需要删除；必要时在笔记里写明采用哪一版 |
| 同标准号不同写法（GB vs GB/T 等） | `same-number-family` | info | 7 | 标准 7 | GB 与 GB/T 等同族写法：核对封面后保留正确写法，其余 kb_keep 或软删除 |

### 编译层（摘要 / 笔记 / 可信度）

| 类别 | 代码 | 严重度 | 数量 | 分库分布 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| 疑似应合并的笔记（续/修订版） | `supersede-hint` | warning | 1 | 标准 1 | 把「续/修订版」合并回主线笔记（同标题 kb_add_note 更新），旧页软删除 |
| 摘要过短（<40 字） | `summary-thin` | info | 114 | 变电试验 40 / 标准 24 / 历史 20 / 电气工程教材 12 / 电能质量 11 / 电气一次 6 / 电气二次 1 | 摘要偏短（<40 字）：可选补写，不影响检索 |
| 无入链笔记（有来源但没被其他笔记引用） | `orphan-note` | info | 8 | 标准 4 / 电能质量 2 / 变电试验 1 / 电气一次 1 | 笔记有来源但没有入链：补双链或并入主题页，否则以后找不到 |
| 未标注可信度 | `trust-unknown` | info | 2 | 标准 2 | kb_trust 标 high/medium/low（先核实是否现行标准/正式出版物） |

**明细样例（每类前 8 条；完整清单见 JSON）**

| 类别 | 库 | docId | 标题 | 明细 |
| --- | --- | --- | --- | --- |
| supersede-hint | 标准 | `7dc9d9260fe5` | GB/T 11032-2020 表格乱码修复记录（续）：A.1/B.1 与试验项目表 |  |

### 手工数据保护（清单，不是问题）

| 类别 | 代码 | 严重度 | 数量 | 分库分布 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| 手工维护的摘要/标题（批量脚本必须跳过） | `manual-protected` | info | 8 | 标准 7 / 变电试验 1 | 不批量改；需要改时逐条确认 |

## 5. Top 10 建议动作（等确认后逐批执行）

### 1. 修内容层 U+FFFD（文字层丢字）（4 篇/组）

- 涉及库：标准 3 / 电气工程教材 1
- 工具：kb_view + kb_reparse
- 做法：先 kb_view 抽查坏页确认是「真乱码」；再 kb_reparse forceOcrPages=<页号列表>（整本都坏用 forceOcr=true）
- 分批：按库分批，每批 ≤20 篇；先做 电能质量 / 标准
- 快照：每批先 kb_snapshot（含 sources 可省，说明局限）
- 风险：重解析会版本号 +1；OCR 也可能识别出新的错字，必须抽查
- 手工数据：不涉及摘要/标题/可信度，不会覆盖手工数据
- 回滚：kb_snapshot 后 kb_reparse；新版本可用 kb_history + kb_restore version=N 回退

### 2. 补完整正文（封面/目录可用但正文缺失）（22 篇/组）

- 涉及库：标准 22
- 工具：重新导入 / kb_view
- 做法：仅处理 cover-only 与正文明显缺失的资料；「编制说明」类 partial 属正常，不要动
- 分批：先处理 cover-only 的少数几篇
- 快照：导入是原位更新，先 kb_snapshot
- 风险：重新导入会覆盖当前解析产物（版本号 +1）
- 手工数据：若该文档有手工摘要需先记录，重导入后摘要保留但摘要内容可能过时
- 回滚：kb_snapshot + kb_restore version=N

### 3. 处理 0 字/极小正文资料（3 篇/组）

- 涉及库：标准 3
- 工具：kb_view / 重新导入
- 做法：先看原件是不是只有封面；有完整版就重新导入，没有就标注或软删除
- 分批：逐篇
- 快照：kb_snapshot
- 风险：低
- 手工数据：不涉及
- 回滚：kb_snapshot + kb_history/kb_restore version=N

### 4. 回填资料身份元数据（sourceHash/标准号）（2 篇/组）

- 涉及库：电能质量 2
- 工具：scripts/backfill-doc-meta.mjs
- 做法：node scripts/backfill-doc-meta.mjs --root <kbRoot> --apply --hash --std --content（只补元数据，不动摘要/标题/trust）
- 分批：一次性，但先 --dry-run 看变更量
- 快照：必须先 kb_snapshot（会写 kb.json）
- 风险：中：会重算标准号，个别标题解析可能偏移，需抽查
- 手工数据：脚本跳过 summarySource/titleSource/trustSource=manual 的字段
- 回滚：kb_snapshot 后执行；清单可用快照覆盖 kb.json 回退

### 5. 补充过短摘要（可选）（114 篇/组）

- 涉及库：变电试验 40 / 标准 24 / 历史 20 / 电气工程教材 12 / 电能质量 11 / 电气一次 6 / 电气二次 1
- 工具：kb_describe
- 做法：摘要 <40 字的资料，按需补写；不影响检索排序
- 分批：按库分批
- 快照：记录原摘要
- 风险：低
- 手工数据：跳过 summarySource=manual
- 回滚：kb_describe clear=true

### 6. 补可信度标注（2 篇/组）

- 涉及库：标准 2
- 工具：kb_trust
- 做法：先核实是否现行/正式出版物，再标 high/medium/low
- 分批：逐篇
- 快照：记录原值
- 风险：低
- 手工数据：跳过 trustSource=manual
- 回滚：kb_trust level=unknown

### 7. 旧管线产物刷新（可选，成本高）（1441 篇/组）

- 涉及库：标准 835 / 变电试验 306 / 历史 156 / 电能质量 93 / 电气工程教材 36 / 电气二次 8 / 电气一次 7
- 工具：kb_reparse
- 做法：只在遇到具体内容问题时按需重解析；不要一次刷全库
- 分批：≤20 篇/批
- 快照：kb_snapshot
- 风险：高成本 + 可能引入新解析差异
- 手工数据：摘要/标题/可信度保留，正文会重建
- 回滚：kb_snapshot + kb_restore version=N

## 6. 回滚手册（后续修复批次统一遵循）

| 操作 | 回滚方式 |
| --- | --- |
| 任何写操作前 | `kb_snapshot`（库级快照，写入 `<kb>/snapshots/`）；大库可 includeSources=false 并注明局限 |
| `kb_remove`（默认软删除） | `kb_restore` 恢复；软删除保留原件与分块 |
| `kb_remove soft=false` | **不可恢复**，只用于临时文件/确认无价值的副本 |
| `kb_keep` | `kb_keep clear=true` 取消标记 |
| `kb_trust` | `kb_trust level=unknown` 清除标注 |
| `kb_describe` | `kb_describe clear=true` 清空摘要与标签（原摘要需人工备份） |
| `kb_retitle` / `kb_edit` / `kb_reparse` | `kb_history` 查版本 → `kb_restore version=N` |
| `backfill-doc-meta` | 执行前 kb_snapshot；清单可用快照里的 kb.json 覆盖回退 |
| 孤儿原件移入回收站 | 把文件从 `.trash/` 移回 `sources/<docId>.<ext>` |

## 7. 手工数据保护清单

- `summarySource=manual`：5 篇
  - `e3241498cbf3` 《变压器试验技术》
  - `976ed155732d` IEC/TS 63222-3 电能质量管理导则 第 3 部分 用户特性建模（草案）
  - `7ec06b7c4567` IEC/TS 63222-3 电能质量管理导则 第 3 部分 用户特性建模（草案） - 第四章修改
  - `46975414effd` IEC/TS 62749 公用电网限值及其评估方法（征求意见稿）
  - `91dd50555c6b` Q/GDW 10739-2024 变电设备在线监测接口网络通信规范
- `titleSource=manual`：3 篇
  - `976ed155732d` IEC/TS 63222-3 电能质量管理导则 第 3 部分 用户特性建模（草案）
  - `7ec06b7c4567` IEC/TS 63222-3 电能质量管理导则 第 3 部分 用户特性建模（草案） - 第四章修改
  - `46975414effd` IEC/TS 62749 公用电网限值及其评估方法（征求意见稿）
- `trustSource=manual`：1549 篇

> 注意：`trustSource=manual` 的存量几乎等于全库（旧清单迁移时默认写 manual），不能当成「人工已核实」的证据。批量改可信度必须先逐条确认，不能按这个字段判断。

## 8. kb_lint 分组对照

| lint 分组 | 变电试验 | 标准 | 电能质量 | 电气二次 | 电气工程教材 | 电气一次 | 历史 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| content-incomplete | 0 | 22 | 0 | 0 | 0 | 0 | 0 |
| corrupted | 1 | 50 | 33 | 0 | 0 | 0 | 0 |
| duplicate-text | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| metadata-missing | 0 | 0 | 2 | 0 | 0 | 0 | 0 |
| orphan-note | 1 | 4 | 2 | 0 | 0 | 1 | 0 |
| same-number-family | 0 | 7 | 0 | 0 | 0 | 0 | 0 |
| same-number-multi-year | 0 | 61 | 0 | 0 | 0 | 0 | 0 |
| same-number-stages | 0 | 24 | 0 | 0 | 0 | 0 | 0 |
| stale | 306 | 835 | 93 | 8 | 36 | 7 | 156 |
| supersede-hint | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| trust-unknown | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| unlabeled | 0 | 1 | 0 | 0 | 0 | 0 | 0 |

> 说明：本报告对两个 lint 分组做了口径修正 —— `unlabeled` 改由 `summary-missing` 统计（只算资料，笔记本来就没有摘要）；`duplicate-text` 只算正文 ≥200 字的资料（只有封面的残件另见 `tiny-content`）。因此这两行的 lint 原始计数与正文分类表不同属正常。

## 9. 复现

```bash
node scripts/quality-audit.mjs --root /Users/littlesun/workspace/knowledge
```

报告文件：`/Users/littlesun/.dsh/plugins/dsh-knowledge-base/docs/reports/2026-10-31-quality-audit-final.json` / `/Users/littlesun/.dsh/plugins/dsh-knowledge-base/docs/reports/2026-10-31-quality-audit-final.md`

> 修复批次复跑时请用 `--name <日期>-quality-audit-after` 另存，避免覆盖本基线报告，这样前后对比才有据可查。

## 10. 只读证据

扫描前后指纹比对结果：**一致（未写库）**。

| 库 | kb.json mtime/size | sources/ | markdown/ | index.md | log.md |
| --- | --- | --- | --- | --- | --- |
| 变电试验 | 2026-10-30T16:27:58.556Z / 2912557B | 309 | 1952 个文件 / 96194KB | 有 | 有 |
| 标准 | 2026-10-30T16:28:12.327Z / 2912440B | 904 | 8829 个文件 / 220780KB | 有 | 有 |
| 电能质量 | 2026-10-30T16:27:58.594Z / 427741B | 130 | 668 个文件 / 15685KB | 有 | 有 |
| 电气二次 | 2026-10-30T16:27:03.216Z / 111817B | 8 | 316 个文件 / 9268KB | 有 | 有 |
| 电气工程教材 | 2026-10-30T16:27:05.156Z / 415041B | 37 | 6518 个文件 / 151619KB | 有 | 有 |
| 电气一次 | 2026-10-30T16:27:05.239Z / 25287B | 10 | 53 个文件 / 1264KB | 有 | 有 |
| 历史 | 2026-10-30T16:27:09.339Z / 2540245B | 157 | 13901 个文件 / 556375KB | 有 | 有 |

> 只读是「扫完再核对」：如果扫描期间有其他进程（宿主/导入任务）在写库，这里会显示不一致，报告结论需重跑确认。
