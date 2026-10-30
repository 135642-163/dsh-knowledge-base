# 知识库质量只读审计报告（0.32 · 优先级 1）

- 生成时间：2026-10-30T15:00:25.505Z
- 知识库根目录：`/Users/littlesun/workspace/knowledge`
- 插件版本：0.31.9；解析管线：2026-10-22.2
- 扫描范围：1 个库 / 132 篇（资料 130、笔记 2）
- 只读校验：✅ 扫描前后清单与派生文件指纹一致（本轮未写库）
- 内容层扫描：130 篇派生 markdown（单遍字符级统计）

## 1. 结论摘要

本轮共识别 **11 类**问题信号：error 0 类、warning 6 类、info 5 类。其中 error 级 0 条次，warning 级 186 条次（同一篇可能命中多类，按类累计）。

- **内容层丢字（U+FFFD）**：30 篇，而清单里的 `corruptedPages` 只标了 3 篇 —— 旧管线没有逐页质量元数据，只看 kb_lint 会漏掉这批硬伤。
- **同标题重复**：3 组，多为 doc/pdf 双份或带后缀的重复导入（kb_lint 的 sourceHash/textHash 对旧库为空，抓不到）。
- **元数据缺失**：127 篇没有 sourceHash，内容去重与标准号检索都会受影响。

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
| 电能质量 | 132 | 130 | 2 | 0 | 0 | 0 | 130 | 0 | 3 | 30 | 9 |

### 可信度构成（解释低可信是否需要处理）

| high | medium | low | unknown | low 的理由分布 |
| --- | --- | --- | --- | --- |
| 0 | 131 | 1 | 0 | 过程稿/说明材料 1 |

> `low` 大多是「已被新版代替的旧标准」或「征求意见稿/编制说明」，属于**正确的标注**，不要当成问题去修。

## 4. 问题分类与数量

### 内容质量

| 类别 | 代码 | 严重度 | 数量 | 分库分布 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| 内容层 U+FFFD（文字层丢字，硬伤） | `content-fffd` | warning | 30 | 电能质量 30 | 内容层有 U+FFFD（文字层丢字，硬伤）：先 kb_view 核对，再 kb_reparse forceOcrPages=<坏页>；整本都坏时 forceOcr=true |
| 文字层损坏 / OCR 低置信 | `corrupted` | warning | 3 | 电能质量 3 | kb_view 核对坏页/低置信页；kb_reparse forceOcrPages=<坏页> 重识别 |
| PDF 缺逐页质量 sidecar（旧导入） | `pages-sidecar-missing` | info | 103 | 电能质量 103 | 旧导入没有逐页质量 sidecar，无法回看低置信页；需要时 kb_reparse 重建（不必批量做） |
| 内容层私用区字符（字体映射，多为公式/异体字） | `content-pua` | info | 9 | 电能质量 9 | 私用区字符（公式/异体字字体映射）：一般无需处理，抽查即可 |

**明细样例（每类前 8 条；完整清单见 JSON）**

| 类别 | 库 | docId | 标题 | 明细 |
| --- | --- | --- | --- | --- |
| content-fffd | 电能质量 | `307689d95df8` | 现代电能质量的基本问题 林海雪 | U+FFFD 4024 处（页 1,2,3,4,5,6,7,8）；19023 字 |
| content-fffd | 电能质量 | `e6a28930e453` | 国外谐波测量标准的新进展 林海雪 | U+FFFD 1944 处（页 1,2,3,4）；6916 字 |
| content-fffd | 电能质量 | `44a0edea7c58` | 电力系统电压波动和闪变标准介绍 林海雪 | U+FFFD 1792 处（页 1,2,3,4,5）；8949 字 |
| content-fffd | 电能质量 | `d225656c98d4` | 电力系统的三相不平衡讲座 ... 三相不平衡的干扰性负荷 林海雪 | U+FFFD 1500 处（页 1,2,3,4,5）；8814 字 |
| content-fffd | 电能质量 | `f3a9db943ca2` | 电力系统谐波标准的研讨 林海雪 | U+FFFD 1279 处（页 1,2,3,4,5,6,7）；9181 字 |
| content-fffd | 电能质量 | `d77b0f3712b8` | 关于加强电能质量管理的几个问题 林海雪 | U+FFFD 1110 处（页 1,2,3,4）；8860 字 |
| content-fffd | 电能质量 | `27affbb3d00f` | 电力系统中的谐波问题 林海雪 | U+FFFD 1100 处（页 1,2,3,4,5,6,7,8）；11447 字 |
| content-fffd | 电能质量 | `f394146f14c2` | 对电能质量改善的几点看法 林海雪 | U+FFFD 1069 处（页 1,2,3,4）；7102 字 |
| content-fffd | … | 共 30 条 | 其余 22 条见 JSON |  |
| corrupted | 电能质量 | `4687a15f3873` | 电力系统的三相不平衡讲座—...改善三相不平衡的措施(下) 林海雪 | 损坏 2 页，低置信 0 页 |
| corrupted | 电能质量 | `d64cfba1297e` | “另类”谐波电流超标的研究 周胜军 | 损坏 4 页，低置信 0 页 |
| corrupted | 电能质量 | `81e3f2688f3e` | 电力系统谐波电压标准的研讨 林海雪 | 损坏 13 页，低置信 0 页 |

### 身份、标题与元数据

| 类别 | 代码 | 严重度 | 数量 | 分库分布 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| 元数据缺失（可回填） | `metadata-missing` | warning | 127 | 电能质量 127 | scripts/backfill-doc-meta.mjs --apply --hash --std --content（只补元数据，不动摘要/标题/可信度） |
| 标题含标准号但清单没有结构化标准号 | `title-standard-without-meta` | warning | 2 | 电能质量 2 | backfill-doc-meta --std --apply 解析结构化标准号；标题本身无需改 |
| 旧管线产物（可选刷新） | `stale` | info | 127 | 电能质量 127 | 旧管线产物：不必批量刷新；只在遇到内容问题时按需 kb_reparse（all=true 分批 + limit） |

**明细样例（每类前 8 条；完整清单见 JSON）**

| 类别 | 库 | docId | 标题 | 明细 |
| --- | --- | --- | --- | --- |
| metadata-missing | 电能质量 | `59716bfa9ba5` | 电压暂降与短时中断 肖先勇 | 缺 sourceHash |
| metadata-missing | 电能质量 | `6eed221a8978` | 电力系统的电压波动和闪变：第4讲 电压波动和闪变的计算 | 缺 sourceHash |
| metadata-missing | 电能质量 | `08fbf0dc73ac` | 电能质量国家标准讲座(1) 供电电压偏差标准 林海雪 | 缺 sourceHash |
| metadata-missing | 电能质量 | `21571aed9b94` | 国标《电能质量暂时过电压和瞬态过电压》编制说明 林海雪 | 缺 sourceHash |
| metadata-missing | 电能质量 | `118c578663b8` | 电力系统的电压波动和闪变：第2讲 电压波动和闪变的标准 | 缺 sourceHash |
| metadata-missing | 电能质量 | `04ac4767e27d` | 公用电网谐波国标中的几个问题 林海雪 | 缺 sourceHash |
| metadata-missing | 电能质量 | `48a5d68b5749` | 用户谐波电流限值的确定 林海雪 | 缺 sourceHash |
| metadata-missing | 电能质量 | `ca9f7122ffe8` | 闪变值计算方法的研究 赵刚 | 缺 sourceHash |
| metadata-missing | … | 共 127 条 | 其余 119 条见 JSON |  |
| title-standard-without-meta | 电能质量 | `709d485d3958` | GB/T 14598 | 可解析为 GB/T 14598 |
| title-standard-without-meta | 电能质量 | `10c7a8d782b3` | GB/T 17626 | 可解析为 GB/T 17626 |

### 重复与版本

| 类别 | 代码 | 严重度 | 数量 | 分库分布 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| 同库标题重复（疑似同一份资料导入多次） | `title-duplicate` | warning | 3 | 电能质量 3 | 人工核对是否同一份（doc/pdf、带后缀的重复导入）；保留一份，其余 kb_remove 或 kb_keep 说明 |

**明细样例（每类前 8 条；完整清单见 JSON）**

| 类别 | 库 | docId | 标题 | 明细 |
| --- | --- | --- | --- | --- |
| title-duplicate | 电能质量 | `4d7378fc8738,23a4e6dcbfe8` | 附件2-2 电能质量监督报告（模板） | 4d7378fc8738(docx,17889字) \| 23a4e6dcbfe8(docx,17889字) |
| title-duplicate | 电能质量 | `3753713ac463,fe159b8fd2ff` | 附件1-2 电能质量评估报告(模板) | 3753713ac463(docx,2963字) \| fe159b8fd2ff(docx,2963字) |
| title-duplicate | 电能质量 | `51f99a9900de,207dcea2c01c` | 附件1-1 电能质量评估报告审查要点（2025年修订） | 51f99a9900de(docx,119443字) \| 207dcea2c01c(docx,119443字) |

### 编译层（摘要 / 笔记 / 可信度）

| 类别 | 代码 | 严重度 | 数量 | 分库分布 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| 摘要含乱码字符（U+FFFD / 私用区） | `summary-garbled` | warning | 21 | 电能质量 21 | 先判断是「摘要抄到了乱码正文」还是「正文本身坏了」：正文坏了先修内容（kb_reparse），再 kb_describe 重写摘要 |
| 摘要过短（<40 字） | `summary-thin` | info | 13 | 电能质量 13 | 摘要偏短（<40 字）：可选补写，不影响检索 |
| 无入链笔记（有来源但没被其他笔记引用） | `orphan-note` | info | 2 | 电能质量 2 | 笔记有来源但没有入链：补双链或并入主题页，否则以后找不到 |

**明细样例（每类前 8 条；完整清单见 JSON）**

| 类别 | 库 | docId | 标题 | 明细 |
| --- | --- | --- | --- | --- |
| summary-garbled | 电能质量 | `48a5d68b5749` | 用户谐波电流限值的确定 林海雪 | source=auto —— 谐波国家标准（GB/T14549-93）自1993年颁布执行以 来�在控制电网谐波“污染”、提高电网和用电设备安全、 经 |
| summary-garbled | 电能质量 | `747276035ce0` | 配电网短路阻抗测量方法的研究 赵刚 | source=auto —— （1∙西安交通大学电气工程学院 710049 2∙中国电力科学研究院 100085） 摘 要 根据现场试验推荐了几种配电 |
| summary-garbled | 电能质量 | `236be6114298` | 并联电容器装置的不同电抗率配置分析 周胜军 | source=auto —— 周胜军 1�林海雪 1�余文辉 2 （1．中国电力科学研究院�北京 100192；2．广东电网公司茂名供电局�广东茂名  |
| summary-garbled | 电能质量 | `9dc87f19a6ec` | 电气化铁路的谐波标准问题 林海雪 | source=auto —— Problems on Harmonics Standard for Electrified Railway 中国电力科 |
| summary-garbled | 电能质量 | `4666b25e0e98` | 电力系统的三相不平衡讲座—... 三相不平衡的危害(下) 林海雪 | source=auto —— 供 用 电 第�卷第�期 ����年�月 |
| summary-garbled | 电能质量 | `1196b6ad54ab` | 电力系统的三相不平衡讲座 ...改善三相不平衡的措施(上) 林海雪 | source=auto —— 第�卷第�期 ����年�月 供 用 电 |
| summary-garbled | 电能质量 | `e87c7aec5b8f` | 并联电容器装置的谐波简化分析与计算 周胜军 | source=auto —— 周胜军�林海雪 （中国电力科学研究院�北京 100192） 摘 要：随着电网中非线性感性负荷的增加�并联电容器引发的谐波 |
| summary-garbled | 电能质量 | `50d3087b9058` | 电力系统的三相不平衡讲座—... 三相不平衡的危害(上) 林海雪 | source=auto —— 供 用 电 第�卷第�期 ����年��月 |
| summary-garbled | … | 共 21 条 | 其余 13 条见 JSON |  |

## 5. Top 10 建议动作（等确认后逐批执行）

### 1. 修内容层 U+FFFD（文字层丢字）（30 篇/组）

- 涉及库：电能质量 30
- 工具：kb_view + kb_reparse
- 做法：先 kb_view 抽查坏页确认是「真乱码」；再 kb_reparse forceOcrPages=<页号列表>（整本都坏用 forceOcr=true）
- 分批：按库分批，每批 ≤20 篇；先做 电能质量 / 标准
- 快照：每批先 kb_snapshot（含 sources 可省，说明局限）
- 风险：重解析会版本号 +1；OCR 也可能识别出新的错字，必须抽查
- 手工数据：不涉及摘要/标题/可信度，不会覆盖手工数据
- 回滚：kb_snapshot 后 kb_reparse；新版本可用 kb_history + kb_restore version=N 回退

### 2. 合并同标题重复资料（3 篇/组）

- 涉及库：电能质量 3
- 工具：kb_keep / kb_remove
- 做法：逐组对照 sourceFile：同一份资料的 doc/pdf、带「(1)」后缀的重复导入 → 保留一份，其余 kb_remove（软删除）
- 分批：按库逐组人工确认，不做自动合并
- 快照：软删除即时可恢复，仍建议先 kb_snapshot
- 风险：doc 与 pdf 可能是不同版本的同一标准，删错会丢内容
- 手工数据：不涉及
- 回滚：kb_remove 默认软删除，kb_restore 可恢复；kb_keep clear=true 可取消标记

### 3. 回填资料身份元数据（sourceHash/标准号）（127 篇/组）

- 涉及库：电能质量 127
- 工具：scripts/backfill-doc-meta.mjs
- 做法：node scripts/backfill-doc-meta.mjs --root <kbRoot> --apply --hash --std --content（只补元数据，不动摘要/标题/trust）
- 分批：一次性，但先 --dry-run 看变更量
- 快照：必须先 kb_snapshot（会写 kb.json）
- 风险：中：会重算标准号，个别标题解析可能偏移，需抽查
- 手工数据：脚本跳过 summarySource/titleSource/trustSource=manual 的字段
- 回滚：kb_snapshot 后执行；清单可用快照覆盖 kb.json 回退

### 4. 重写乱码摘要（先修内容，再写摘要）（21 篇/组）

- 涉及库：电能质量 21
- 工具：kb_describe
- 做法：内容修好后用 kb_describe 写一行摘要；正文仍乱码的不要急着写摘要
- 分批：≤20 篇/批
- 快照：kb_describe 覆盖摘要，先记录原摘要或 kb_snapshot
- 风险：低
- 手工数据：跳过 summarySource=manual
- 回滚：kb_describe clear=true 或 kb_snapshot 覆盖 kb.json

### 5. 补充过短摘要（可选）（13 篇/组）

- 涉及库：电能质量 13
- 工具：kb_describe
- 做法：摘要 <40 字的资料，按需补写；不影响检索排序
- 分批：按库分批
- 快照：记录原摘要
- 风险：低
- 手工数据：跳过 summarySource=manual
- 回滚：kb_describe clear=true

### 6. 旧管线产物刷新（可选，成本高）（127 篇/组）

- 涉及库：电能质量 127
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

- `summarySource=manual`：0 篇
- `titleSource=manual`：0 篇
- `trustSource=manual`：132 篇

> 注意：`trustSource=manual` 的存量几乎等于全库（旧清单迁移时默认写 manual），不能当成「人工已核实」的证据。批量改可信度必须先逐条确认，不能按这个字段判断。

## 8. kb_lint 分组对照

| lint 分组 | 电能质量 |
| --- | --- |
| corrupted | 3 |
| metadata-missing | 127 |
| orphan-note | 2 |
| stale | 127 |

> 说明：本报告对两个 lint 分组做了口径修正 —— `unlabeled` 改由 `summary-missing` 统计（只算资料，笔记本来就没有摘要）；`duplicate-text` 只算正文 ≥200 字的资料（只有封面的残件另见 `tiny-content`）。因此这两行的 lint 原始计数与正文分类表不同属正常。

## 9. 复现

```bash
node scripts/quality-audit.mjs --root /Users/littlesun/workspace/knowledge --kb 电能质量
```

报告文件：`/Users/littlesun/.dsh/plugins/dsh-knowledge-base/docs/reports/2026-10-30-quality-audit-after-pilot.json` / `/Users/littlesun/.dsh/plugins/dsh-knowledge-base/docs/reports/2026-10-30-quality-audit-after-pilot.md`

> 修复批次复跑时请用 `--name <日期>-quality-audit-after` 另存，避免覆盖本基线报告，这样前后对比才有据可查。

## 10. 只读证据

扫描前后指纹比对结果：**一致（未写库）**。

| 库 | kb.json mtime/size | sources/ | markdown/ | index.md | log.md |
| --- | --- | --- | --- | --- | --- |
| 电能质量 | 2026-10-30T15:00:21.663Z / 399345B | 130 | 657 个文件 / 16009KB | 有 | 有 |

> 只读是「扫完再核对」：如果扫描期间有其他进程（宿主/导入任务）在写库，这里会显示不一致，报告结论需重跑确认。
