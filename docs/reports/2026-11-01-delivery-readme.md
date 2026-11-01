# 交付 README（P2，2026-11-01）

## 问题

0.34 的 zip 包内 `README.md` 有“摘要”列，但 `buildKbpackManifest` 从未把 `doc.summary` 写进
`manifest.json`，所以交付包里该列一直是空的；README 也缺少统计、引用方式和限制说明。

## 修复

1. `buildKbpackManifest` 每个文档新增：
   - `summary`（≤500 字）、`tags`、`trustReason`；
2. `validateKbpackManifest` 同步保留这些字段（旧包没有时为空，兼容）；
3. 重写 `renderExportReadme`：
   - 标题（自定义 / 交付子集 / 整库）；
   - **交付统计**：知识库、文档数、笔记数、原始文件是否包含、内容体积、导出时间、导出器；
   - **包内结构**：README/manifest/kb.json/index/schema/log/markdown/parts/sources；
   - **引用与页码**：`docId#页码`、`### 第 N 页`、manifest 的 pages/parts；
   - **文档清单**：标题、标准号、页数、类型、可信度、摘要（现在有值）；
   - **使用限制**：OCR/图纸/表格、low trust、sources 是否包含。

## 测试

- `test/kbpack-export.test.mjs` 增加断言：
  - manifest 文档含 `summary === "人工摘要"`；
  - README 含“交付统计”“文档清单”“人工摘要”“docId#页码”。
- 全量 **1297**（1293 通过、4 跳过，0 失败）。

## 示例

`kb_export format=zip` 的包内 README 现在类似：

```markdown
# 知识库交付包说明（N 篇）

## 交付统计
| 知识库 | 标准 |
| 文档 | 891（笔记 7） |
...

## 引用与页码
- 用 `docId#页码` 作为稳定引用键，例如 `a1b2c3d4#17`；
...

## 文档清单
| # | 标题 | 标准号 | 页数 | 类型 | 可信度 | 摘要 |
...
```
