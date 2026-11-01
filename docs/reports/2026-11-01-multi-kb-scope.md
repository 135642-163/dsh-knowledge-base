# 多库范围错误提示/跨库解析（P2，2026-11-01）

## 问题

`kb_read` / `kb_view` 等文档工具在「全部知识库」范围、省略 `kb` 时，原先直接落到 `defaultKb`（标准）；
如果文档在另一个库，用户会看到「知识库中没有找到」，不知道应该指定哪个库。

## 修复

`resolveDocTarget` 在 `scope.mode === "all"` 且未显式指定 `kb` 时：

1. 先查默认库；
2. 未唯一命中时扫描范围内所有库：
   - 唯一命中 → 直接解析到那个库（`kb_read`/`kb_view` 省略 kb 也能读到唯一文档）；
   - 零命中 → `KB_NOT_FOUND`，消息列出全部库名，提示“用 kb 参数指定库，或先用 kb_list”；
   - 多命中 → `KB_AMBIGUOUS`，消息列候选 `kb/docId（标题）`，提示“用 kb 参数指定库”。
3. 虚拟文档（schema/index/log）仍然走默认库，不做跨库；
4. `selected` 范围的原有跨库逻辑不变；显式 `kb` 仍然优先。

## 测试

- `test/scope.test.mjs` 新增 2 例：
  - 全部范围跨库唯一命中 → `B/b1`；
  - 全部范围多命中 → `KB_AMBIGUOUS` + 候选/“请用 kb 参数指定库”。
- 全量 **1297**（1293 通过、4 跳过，0 失败）。

## 影响的工具

所有通过 `resolveDocTarget` 的 doc 工具（read/view/edit/describe/trust/remove/restore/history 等）。
显式 `kb` 行为不变；用户仍应优先用 `kb_query` 定位后带 `kb` 操作。
