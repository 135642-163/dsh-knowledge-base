# 0.32 质量治理收尾报告（任务 1+2+3+4）

> 2026-10-31 · 续 `2026-10-30-repair-batch-fffd.md` · 已写库（每步先快照）
> 本轮完成：① reparse 身份保护；② 3 篇书目索引重新生成；③ 3 篇乱码摘要重写；④ 标准剩余零星 FFFD 定向 OCR。

## 1. 最终结果（全库 7 库 / 1566 篇）

| 指标 | 审计基线 | 第一轮后 | **本轮后** |
|---|---|---|---|
| 含 U+FFFD 的文档 | 87 | 36 | **4** |
| U+FFFD 字符总数 | 62,924 | 1,759 | **813（−98.7%）** |
| 摘要含乱码 | 27 | 3 | **0** |
| 缺 sourceHash | 649 | 615 | 612 |
| 缺逐页质量 sidecar | 1,386 | 1,328 | 1,303 |
| 旧管线产物 | 1,535 | 1,477 | 1,449 |
| 清单标注坏页 | 2 | 60 | 84（预期，记录"文字层曾损坏"） |
| 文档数 / 失败 / 导入中 | 1566 / 0 / 0 | 1566 / 0 / 0 | **1566 / 0 / 0** |

最终审计：`docs/reports/2026-10-31-quality-audit-final.md`（只读校验通过）。

## 2. 任务 1：reparse 不再改写身份元数据

**问题**：`kb_reparse` 走导入管线，会按正文重推标题/阶段，实测造成 6 篇 IEEE 标题重复加前缀、6 篇 `stage` 被重置。

**修复**（`lib/pipeline.js`）：`forceReparse && prevDoc` 时启用身份保护——
- `title / canonicalTitle / rawTitle` 沿用旧清单；
- `standardNo / standardPrefix / standardNumber / standardBase / standardYear / standardPart / standardSource / filenameStandardNo / contentTitle` 沿用旧值（正文解析失败也不会被清空）；
- `stage / stageLabel` 旧值非空且非 unknown 时保留；
- 只刷新正文、分块、摘要（auto）、哈希、页数、OCR 质量等"内容侧"字段。
新导入（非 reparse）仍保持"正文优先"，行为不变。

**测试**（`test/reparse.test.mjs` +2）：
- 重解析保留既有 `stage/stageLabel`；
- 重解析保留干净标题（不出现 `IEEE 1124-2003 IEEE Std 1124-2003` 式重复前缀）。
已做红绿验证：去掉补丁时两条测试都失败，加回后通过。

## 3. 任务 2：3 篇「书目索引（自动生成）」重新生成

**生成器**：新增 `scripts/build-catalog-index.mjs`（可从任意库清单重建索引；dry-run 默认，`--apply` 才写库）。
规则：行 = 所有 ready 文档（含笔记），排除索引自身；类型/页数/字数/大纲取自清单；大纲清掉 U+FFFD/私用区并只取前 3 条；按标题拼音排序。

| 库 | 旧行数 | 新行数 | 字符 | 乱码 |
|---|---|---|---|---|
| 变电试验 | 313（含过期条目/临时文件） | **309** | 24,160 → 23,720 | 6 → **0** |
| 电气工程教材 | 31（过期） | **36** | 2,386 → 2,704 | 56 → **0** |
| 历史 | 156 | **156** | 9,998 → 9,428 | 528 → **0** |

- 原位更新同一 docId（`7802bdb4954c`），版本 +1；
- 更新后按旧值恢复 `title / trust / stage`（导入管线会按正文重算这几个字段）——已验证：变电 medium、教材 high、历史 medium 均未变；
- 快照：`pre-catalog-2026-10-31`（变电 53.5MB / 教材 68.6MB / 历史 248.8MB，`unzip -t` 均通过）。

**测试**：`test/catalog-index.test.mjs`（2 条：表格生成/排序/排除自身/乱码清理/字数格式；sanitize 纯函数）。

## 4. 任务 3：3 篇乱码摘要重写

用 `kb_describe` 重写（`summarySource=model`，标签保留，索引刷新）：

| docId | 标题 | 摘要要点 |
|---|---|---|
| `46975414effd` | IEC/TS 62749 中文 | 公用电网电能质量限值及评估方法征求意见稿（等同采用 IEC/TS 62749:2020），含各指标限值与单点/系统性评估方法 |
| `7286aaeeab33` | Q/GDW 10819-2018 电压监测仪技术规范 | 使用条件/分类命名/功能与结构性能要求 + 5 个附录，代替 Q/GDW 1819-2013 |
| `2b11b1f69ca8` | JJF（浙）1138-2017 变压器绕组变形测试仪校准规范 | 频响法测试仪校准：扫频/幅值衰减计量特性、校准条件与方法、结果表达与复校间隔 |

全库 `summary-garbled` 27 → **0**。

## 5. 任务 4：标准剩余零星 FFFD 定向 OCR（第二轮）

**范围**：32 篇 / 148 个"每页 <10 个 FFFD"的文本层页（第一轮按 ≥10/页 跳过的那批）。
**执行**：`forceOcrPages=<每篇坏页>`，300dpi / auto / 4 workers；16:07–16:17，0 失败。

**结果**：29 篇清零（FFFD <3 不再入审计），**3 篇出现回归 → 已回滚**：

| docId | pass2 前 | pass2 后 | 判断 |
|---|---|---|---|
| `32138458cedd` | 24 处 | **235 处** | 图 1 的图注 `C1-C3/L1-L3/…` 被 OCR 识别成 `�`，原文字层本来正确 |
| `0d8e86b187bb` | 24 处 | **235 处** | 同上 |
| `b1603a0ba2cc` | 12 处 | 12 处（页 24） | 公式下标被 OCR 压平（`∆Q容` → `△容`），公式质量下降 |

这 3 篇用 `pre-fffd-pass2-2026-10-31` 快照按"整篇 markdown + 完整清单条目"回滚（版本回到 v5/v3/v4），
并在 `log.md` 记录。**结论：图形/公式为主的页面，原文字层优于 OCR，不应该强行 OCR。**

## 6. 最终剩余 4 篇（813 字符）

| 库 | docId | FFFD | 原因 | 建议 |
|---|---|---|---|---|
| 标准 | `32138458cedd` | 24 | 图注符号，原文字层正确 | 保留原状，看图用 `kb_view` |
| 标准 | `0d8e86b187bb` | 24 | 同上 | 同上 |
| 标准 | `b1603a0ba2cc` | 12 | 公式下标 | 同上 |
| 电气工程教材 | `62f666e7e814` | 753 | 数学矩阵/公式符号，OCR 会更差 | 保持现状 |

另有 info 级 `content-pua` 159 篇（OCR 对个别符号的映射，如 `±`→U+E02D；不影响正文与数字），未批量清洗。

## 7. 新增快照（回滚用）

| 库 | 快照 | 大小 | 覆盖操作 |
|---|---|---|---|
| 变电试验 | `pre-catalog-2026-10-31` | 53.5 MB | 书目索引重建 |
| 电气工程教材 | `pre-catalog-2026-10-31` | 68.6 MB | 书目索引重建 |
| 历史 | `pre-catalog-2026-10-31` | 248.8 MB | 书目索引重建 |
| 标准 | `pre-fffd-pass2-2026-10-31` | 82.9 MB | 第二轮 OCR（已回滚 3 篇） |

回滚方式同前：单篇 `kb_history` → `kb_restore version=N`；整库解压快照覆盖 `kb.json` + `markdown/`（sources 未动）。

## 8. 代码变更与测试

| 文件 | 变更 |
|---|---|
| `lib/pipeline.js` | reparse 身份保护（标题/标准号/阶段不被正文覆盖） |
| `lib/index.js` | `kb_snapshot` 输出 schema 补 `includeSources`（修 0.31.9 的校验失败） |
| `scripts/build-catalog-index.mjs` | 新增书目索引生成器（dry-run 默认） |
| `scripts/quality-audit.mjs` | 只读审计脚本（上一轮） |
| `test/reparse.test.mjs` | +2（身份保护，红绿已验证） |
| `test/snapshot.test.mjs` | +1（输出字段与 schema 一致） |
| `test/catalog-index.test.mjs` | +2（索引生成/清理） |
| `test/quality-audit.test.mjs` | +7（审计分类/只读守卫） |

- `npm test`：**1114 / 1114**；`typecheck` / `check:client` 通过；
- `test:e2e`：**12 passed / 1 skipped**（既有 skip）；
- 未提交、未推送；运行中的宿主仍是旧代码，**重启 DSH 后** reparse 保护与 snapshot 修复才生效。

## 9. 剩余可选项（不阻塞）

1. `title-duplicate` 20 组（doc/pdf 双份等）、`same-number` 2 组：需要人工核对后 `kb_keep`/`kb_remove`；
2. `content-pua` 159 篇：info 级，可忽略；
3. `metadata-missing` 612 篇：可用 `backfill-doc-meta --apply --hash --std` 批量回填（需快照）；
4. 3 篇书目索引的 auto 摘要以"生成时间…"开头，若要更可读可 `kb_describe` 重写。

## 10. 追加：重复组处置、sourceHash 回填、孤儿原件清理

### 10.1 重复组（20 组标题重复 + 2 组同号重复）→ 全部清零

**kb_keep（已核对保留，共 32 篇）**：
- 变电试验 8 组 doc/pdf 双份（16 篇）——两种格式都保留；
- 标准 8 组（16 篇）：IEC 62586-1（2013 doc/pdf + 2017 新版）、IEC 62586-2（同）、
  IEC 61000-4-37（2015/2016）、IEC 61000-4-30（2008/2015）、IEC 61000-3-2（2018/2020）、
  Q/GDW 10817、Q/GDW 10819 —— 属"不同版本/双份"，非重复。

**软删除（8 篇，可 `kb_restore`）**：
- 电能质量：3 组同名同内容模板（chars 完全相同、同一源文件名）各删 1 篇；另删 `2025《电能质量管理典型案例汇编》`（与 `《电力行业…》` sourceHash 相同）；
- 标准：`GB/T 20297-2006` 的重复扫描（保留 24 页版）、`DL/T 1773-2017` 的 OCR 乱码版（保留文字层版）、IEC TR 63282 的第二份副本；
- 变电试验：`3变电站设备验收规范第3部分：组合电器`（与无前缀标题同 sourceHash）。

审计改动：`title-duplicate` 现在尊重 `dedupKeep`（kb_keep 标记后不再误报），已加测试。

### 10.2 sourceHash 回填（609 篇）

`scripts/backfill-doc-meta.mjs --hash --apply` 逐库执行（仅 hash，不动标题/摘要/可信度）：

| 库 | 回填 | 库 | 回填 |
|---|---|---|---|
| 变电试验 | 307 | 电气工程教材 | 36 |
| 电能质量 | 94 | 电气一次 | 7 |
| 电气二次 | 8 | 历史 | 156 |
| 标准 | 1（处理后） | | |

`metadata-missing`：612 → **2**（仅剩 `GB/T 14598`、`GB/T 17626` 两篇裸编号标题，需人工补全标题/标准号）。

### 10.3 孤儿原件

`标准/sources/918af5730527.pdf`（7MB，与同名 `.md` 同 id，导致 backfill 跳过）：
已移到 `标准/.cleanup-backup-2026-10-31/`（保留原件），随后 `.md` 成功回填 hash；孤儿原件计数 1 → **0**。

### 10.4 收尾审计

`docs/reports/2026-10-31-quality-audit-final.md`：

- warning：`corrupted` 84、`content-incomplete` 22、`content-fffd` 4、`tiny-content` 3、`metadata-missing` 2、`title-standard-without-meta` 2、`supersede-hint` 1；
- `title-duplicate` / `same-number` / `duplicate-content` / `duplicate-text` / `orphan-source` 全部为 **0**；
- 文档 1566（ready 1554 / 笔记 11 / 软删除 12），失败 0、导入中 0；
- 测试 1114/1114，e2e 12+1。

**优先级 1（知识库质量治理）到此完成。**
