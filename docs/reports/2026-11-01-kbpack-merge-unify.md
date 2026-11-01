# kbpack 导入合并策略统一（P2，2026-11-01）

## 目标

让外部 kbpack `mode=merge` 与本地合并使用同一套「同号同版本」语义：

- 默认 `duplicatePolicy=skip`：同标准号+年份+阶段默认跳过，保留目标库；
- `duplicatePolicy=keep`：同号同版本改名保留两份；
- 同号不同年/阶段：保留并报告（`versionConflicts`）；
- 同 id 相同内容：仍幂等跳过；同 id 不同内容：仍另存新 id。

## 实现

- `importKbpack({ duplicatePolicy })`；
- `kb_import_package` 新增 `duplicatePolicy` 参数；
- 输出新增 `duplicatePolicy`、`keptDuplicates`、`versionConflicts`（dryRun 与正式导入都返回）；
- 工作台「导入知识库包」在 `mode=merge` 时增加「同号同版本重复」下拉；
- 复用 `scanDuplicates` 的 `versionConflicts`，不新增一套标准号解析。

## 边界

- 外部 kbpack 仍是「包文件 → 目标库」导入，不做源库归档/`mergedInto`；
- 本地合并有物理移动/journal/undo，外部导入没有；
- 但两者的 `duplicatePolicy` 默认与 `versionConflicts` 语义已对齐。

## 测试

- `test/kbpack-import.test.mjs`：同标准号不同 id，`keep` 后目标 2 篇、`keptDuplicates=1`；
- 全量 **1306**（1302 通过、4 跳过，0 失败）。
