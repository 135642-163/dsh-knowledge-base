# 0.38 数据目录：工作台可修改知识库根目录

- 日期：2026-11-02
- 状态：已实现（待发布）；不涉及 npm

## 目标

用户不必改 `cordis.patch.yml` / 重装插件，就能在工作台查看并修改知识库根目录（kbRoot）。

## 设计

| 项 | 方案 |
|---|---|
| 持久化位置 | `$DSH_HOME/knowledge-wiki/settings.json`（无 DSH_HOME 时 `~/.dsh/...`），与具体知识库解耦，换目录不会把设置一起换走 |
| 启动优先级 | 保存的设置 > 插件配置 `kbRoot`；保存值损坏/缺失时自动回退配置 |
| 生效时机 | **重启 DSH 后生效**（运行中的工具/工作台仍用启动时目录；避免半热切换导致读写不一致） |
| 保存校验 | 必须是绝对路径（支持 `~` / 环境变量）；目录不存在则创建；必须是可写目录；文件路径报错 |
| 数据安全 | 只切换目录，**不移动、不删除**旧目录里的资料；新目录为空时工作台显示 0 个知识库 |
| 测试隔离 | `KB_SETTINGS_DISABLED=1` 时启动忽略保存值；单测/E2E 入口默认设置，避免读到开发者本机路径 |

## API

- `GET /kb/api/settings` → `{ kbRoot, kbRootSource, configKbRoot, savedKbRoot, restartRequired }`
  - `kbRoot` 是当前进程生效值；`savedKbRoot` 是已保存待重启值；
  - `restartRequired = savedKbRoot && savedKbRoot !== kbRoot`。
- `PUT /kb/api/settings` body `{ kbRoot }`
  - 非空：校验并保存，返回同上结构（`restartRequired=true`）；
  - 空串：清除保存值（恢复插件配置）；
  - 非法路径 → 400 `INVALID_KBROOT`。
- `GET /kb/api/status` 新增 `kbRootSource`（`config` / `setting`）与 `configKbRoot`，供页面解释来源。

## 工作台

- 侧栏新增「数据目录」入口（总览/详情/检索页均可见）；
- 弹窗显示「当前生效：…（来自插件配置/数据目录设置）」，输入新目录后可保存或恢复默认；
- 保存后显示「重启 DSH 后生效」，旧目录数据不受影响；
- 输入框支持 `~` 开头。

## 测试

- `test/kb-settings.test.mjs`（7 个）：路径归一化、读写/清除、文件路径拒绝、
  `resolveKbRoot` 优先级与 `KB_SETTINGS_DISABLED`、API GET/PUT/清空/非法路径、status 字段；
- `scripts/e2e/tests/kbroot-settings.mjs`：工作台弹窗显示本次 E2E 临时根目录（只读，不写本机）；
- `npm test` 1362（1358 通过 / 4 跳过）；`npm run typecheck` 通过；
  `DSH_E2E_ONLY=数据目录 npm run test:e2e` 1 passed。

## 已知限制

- **需要重启 DSH** 才能切换生效目录；工作台会明确提示。
- 不做“迁移/复制旧资料”到新目录（用户可自行复制，或用 kbpack 导出/导入）。
- 保存的设置是全局的（同一 DSH_HOME 下所有 profile 共用）；多实例如需不同目录，仍可用配置项覆盖或使用独立 DSH_HOME。

## 回滚

- 删除 `$DSH_HOME/knowledge-wiki/settings.json` 或在工作台点「恢复默认」，重启后回到插件配置目录；
- 不影响任何知识库内容。
