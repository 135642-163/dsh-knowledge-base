# 只读共享（P2，2026-11-01）

## 语义

- `kb.json` 新增 `readOnly`（默认 `false`）；
- 只读库仍允许：`kb_list` / `kb_query` / `kb_read` / `kb_view` / `kb_export` / 工作台浏览；
- 禁止：导入/重解析、笔记/编辑、删除/恢复/彻底删除、元数据修改、快照创建/恢复、标准更新检查、
  合并（源或目标）、kbpack 导入、重命名/归档/删除整库；
- 关闭只读只允许一个元数据操作：`readOnly:false`（工作台设置里取消勾选并保存）。

## 入口

- API：`PATCH /kb/api/kbs/:name` body `{readOnly:true|false}`；
- 工作台：库「设置」→「只读共享」复选框；详情头显示「只读共享」徽标，上传/导入/重命名/归档禁用；
- 工具：`kb_list` 库名后显示「（只读）」；写工具抛 `KB_READONLY`，Web 返回 409；
- 共享方式：复制/同步整个库目录（含 `kb.json`），接收方打开后即只读；也可用 kbpack 分发。

## 边界

- 这是**插件层只读**，不是操作系统文件权限；直接改文件仍可绕过；
- 没有多用户 Web 鉴权/分享 token；只读共享是“目录/包 + manifest 标记”；
- 只读库的 `.std-check.json`/`.index` 缓存也不会更新；导出/查询仍可用。

## 测试

- `test/readonly.test.mjs`：标记、导入/元数据/删除拒绝、关闭只读、合并源/目标拒绝；
- `test/web-readonly.test.mjs`：API 状态可见、删除 409、PATCH 关闭只读；
- E2E `只读共享：标记/写入口/关闭`：徽标、上传禁用、读取可用、删除 409、关闭后恢复；
- 全量 **1309**（1305 通过、4 跳过）；完整 E2E **14 passed / 1 skipped**。
