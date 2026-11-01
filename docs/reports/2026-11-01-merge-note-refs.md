# 合并：笔记引用自动改写（P2，2026-11-01）

## 行为

- 合并时若文档因「同 id 不同内容」被改名（`oldId → newId`）：
  - 目标库与源库的所有 `type=note` 文档；
  - `sources` 中 `oldId` 或 `oldId#pN` → `newId` / `newId#pN`；
  - `linksOut` 中 `oldId` → `newId`；
- 撤销合并时反向映射 `newId → oldId`，恢复引用；
- 自动改写发生在清单提交后、索引重建前；结果 `summary.notesRewritten` 记录实际改动笔记数；
- 预览阶段仍返回 `notesAffected`，让用户在执行前知道哪些笔记会受影响。

## 不处理

- 笔记正文里的 `[[标题]]` 文本不按 id 改写（它们按标题解析；改名不改标题）；
- 其他文档的正文/摘要中手写的旧 id 不自动替换——只处理结构化的 `sources`/`linksOut`。

## 测试

- `test/merge.test.mjs` 新增：源库笔记 `sources:["a1#p3"]`、`linksOut:["a1"]`；
  - 合并改名后变为新 id；
  - undo 后恢复 `a1`。
- 全量 **1305**（1301 通过、4 跳过，0 失败）。
