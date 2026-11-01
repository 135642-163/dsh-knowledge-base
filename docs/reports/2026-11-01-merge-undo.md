# 合并知识库 P2：撤销合并（2026-11-01）

## 实现

- `lib/merge.js` 新增 `undoMerge({kbRoot, target, journal})`：
  - 读取目标库 `snapshots/merge-*.json`；
  - 校验目标文档存在、源库没有同 id 文档；
  - 把目标 `sources/markdown/history` 复制回源库（源库全量保留期间已有副本则复用）；
  - 恢复源清单文档、清 `mergedInto/mergedAt/mergePurgeAfter/mergePurgedAt`；
  - 从目标清单移除文档并删目标副本；
  - journal 写 `status:"undone"`；
  - 失败恢复源/目标清单并清理已复制回的文件。
- API：`POST /kb/api/merge/undo`，body `{target, journal, confirm:true}`，后台 job `kb-merge-undo`。
- 工作台：合并任务成功后，结果区出现「撤销本次合并」按钮；撤销成功再刷新列表。
- 支持全量合并与部分合并撤销；已 purge 的源库也能从目标副本复制回。

## 测试

- `test/merge.test.mjs` +2：
  - 全量合并后 undo，源文档恢复、目标清空、`mergedInto` 清除、journal undone；
  - 部分合并后 undo，源库原有跳过文档保留、目标只剩原有文档。
- `test/web-merge.test.mjs` 增加 API undo job 流程。
- 全量 **1304**（1300 通过、4 跳过，0 失败）。

## 边界

- 只按 journal 恢复合并动作；合并后对目标文档正文的修改不会回滚（journal 不含正文快照）；
- 不自动改写笔记引用；
- 外部 kbpack `mode=merge` 不走此 undo（没有本地 journal）。
