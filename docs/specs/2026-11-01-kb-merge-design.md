# 知识库合并设计（0.35，2026-11-01）

> 在 `2026-10-23-kb-workbench-design.md` §7.5 的基础上，按 0.34 当前代码收敛。
> 本文只定方案，不写数据；P0 后端先行，UI/撤销后置。

## 1. 现状

已有：
- manifest v5 已有 `mergedInto` / `mergedAt`，`normalizeManifest`/`listKbs`/Web data 已带出；
- 工作台/检索/回收站已过滤 `mergedInto != null` 的库；
- `lib/transfer.js` 已有单篇跨库移动的“暂存-校验-提交-软删除-撤销”原语；
- `/kb/api/status` 的 `features.merge` 仍为 `false`。

缺口：
- 没有 `lib/merge.js`，没有 preview/execute 接口，没有 UI 入口；
- transfer 是单篇软删除语义，合并需要“批量物理移动 + 源库归档标记”；
- 没有按标准号/年份/阶段的重复处理，只按 id 判冲突会制造重复。

## 1.5 两种“合并”的边界（重要）

| 类型 | 入口 | 数据形态 | 本设计是否覆盖 |
|---|---|---|---|
| **A. 本地库合并** | 工作台选 2 个本机库 → 合并 | 物理移动本机 A/B 的文档到 C；A/B 归档为 `mergedInto`；有 journal/快照/回滚 | **本设计 P0** |
| **B. 外部库导入并合并** | `kb_import_package` / 工作台导入 `.zip`（kbpack） | 外部包是文件，不是本机库；包内文档逐篇导入目标库，不做源库归档 | 已有 `mode=merge`；不在本 P0 代码中重写 |

- 两者共同点：都要处理“目标已有同号/同 id 文档”；
- 差异：A 有本机源库目录、文件移动、`mergedInto`、purge；B 只有包文件，导入后包仍在外部，源没有可归档的本地库；
- 后续 P1 可让 B 复用 A 的 `duplicatePolicy`/preview 语义，但 **P0 不改 `kb_import_package`**。

## 2. 目标与非目标

目标：
- 两个（后续支持 2–10 个）库合并到一个目标库；目标可已存在或新建；
- 合并前快照；执行可回滚；源库保留空目录并写 `mergedInto/mergedAt`；
- 重复/多版本在 **preview** 中显式分类，用户选择保留或跳过；
- 源库文档的 `sources/markdown/parts/history` 完整迁移，引用 id 尽量稳定；
- 工作台有“合并库”向导，后台任务 + 进度/结果。

非目标（P0）：
- 不做跨机器合并（走 kbpack）；
- 不做“撤销合并”按钮（P2，先保留 journal）；
- 不自动改写笔记引用（P1，先警告）；
- 不做源库部分文档的选择性合并（P0 整库）。

## 3. 数据模型

复用：
```json
// 源库 kb.json
{ "mergedInto": "目标库", "mergedAt": "ISO" }
```

新增 `<target>/snapshots/merge-<YYYYMMDD-HHmmss>.json`（journal）：
```json
{
  "version": 1,
  "createdAt": "…",
  "sources": ["A", "B"],
  "target": "C",
  "snapshots": [{ "kb": "A", "path": "snapshots/…zip" }],
  "actions": [
    { "fromKb": "A", "docId": "abc", "newId": "abc", "title": "…", "action": "move" },
    { "fromKb": "B", "docId": "abc", "newId": "def", "title": "…", "action": "rename" }
  ],
  "skipped": [{ "fromKb": "B", "docId": "…", "reason": "same-standard-same-stage" }]
}
```
- journal 用于人工回滚/审计，P2 做自动 undo；
- 源库文件在提交完成前不删除（复制到目标暂存 → 校验 → 目标清单写成功 → 源清单移除 → 再清理源文件）。

## 4. 合并前检查与冲突分类

### 4.1 前置

1. `sources` 去重、非空，目标不在 sources 中；
2. 源库存在且未归档/未 `mergedInto`；目标存在或 `create=true`；
3. 源/目标无 `status=importing` 文档，无运行中的 merge/import 任务；
4. 目标名合法且不与现有库冲突（create 时）；
5. 合并快照（默认 `includeSources=false`，配置 `mergeSnapshotSources` 可选 true）失败即中止。

### 4.2 规划分类（按 sources 顺序）

对每篇源文档（跳过软删除/失败），先看目标当前清单：

| 情况 | 动作 | 说明 |
|---|---|---|
| 目标无同 id，且无同标准号同版本 | `move` | 保留原 id |
| 目标有同 id，`sourceHash` 相同 | `skip-same` | 同内容 |
| 目标有同 id，内容不同 | `rename` | 新 id，保留两份 |
| 无同 id，但同标准号+年份+阶段 | `skip-duplicate`（默认） | 目标已有同一版本 |
| 无同 id，同标准号但不同年份/阶段 | `move-with-warning` | 多版本，保留 |
| 无标准号，titleKey 完全相同 | `skip-same` 或 `skip-duplicate` | 由 `duplicatePolicy` 决定 |
| 其余 | `move` | |

- 标准号/版本判定复用 `lib/dedup.js` 的 `titleKeys` 语义（GB 与 GB/T 同 code，部分号保留，年份/阶段分开）；
- `duplicatePolicy`：
  - `skip`（默认）：同号同版本跳过，保留目标；
  - `keep`：全部改名保留（会制造重复，preview 明确警告）。
- 预览返回 `summary {move, rename, skipSame, skipDuplicate, keepMultiVersion, skippedFailed}`、`conflicts`、`warnings`；
- `notesAffected`：扫描所有笔记的 `sources`/`linksOut`，包含将改名 docId 的列入警告（P0 不改写）。

## 5. 执行算法

1. 生成 journal 文件与预合并快照；创建目标库（如需要）；
2. 获取目标 + 源库锁（按名称排序，超时中止）；
3. 重新计算规划（防止预览后变化）；
4. 对每个 `move`/`rename`：
   - 在目标库 `.merge/<tx>/` 复制 `sources/<id>.*`、`markdown/<id>/`、`history/<id>/`；
   - 校验文件大小/存在；目标清单写新文档（id/newId、sourcePath 改目标路径、updatedAt）；
   - 源清单移除该文档（软删除或直接移除？P0 **直接移除**，文件在 journal 中留底；源库最终为空）；
   - journal 记录；
5. 全部动作完成后：
   - 重建目标 `index.md`/FTS；追加 `log.md`；
   - 源库 `mergedInto/mergedAt`；若源库仍有被跳过文档则 **不标记 mergedInto**，只报告“部分合并”；
   - 更新 `.scopes.json`：从 selected 范围中移除已归档的源库；
   - 写 journal 完成状态；
6. 失败：按 journal 逆序回滚（把目标暂存/已提交文件移回源库、恢复清单），回滚失败保留 journal 并给出路径；
7. 结果：`{moved, renamed, skippedSame, skippedDuplicate, keptMultiVersion, notesAffected, target, sources, journal}`。

## 6. API（仅工作台，不走 kb_* 工具）

`POST /kb/api/merge/preview`
```json
{ "sources": ["A","B"], "target": { "name": "C", "create": true }, "duplicatePolicy": "skip" }
```

`POST /kb/api/merge`
```json
{ "sources": ["A","B"], "target": { "name": "C", "create": true }, "duplicatePolicy": "skip", "confirm": true }
```
→ `{ "jobId": "…" }`，任务 kind `merge`。

`GET /kb/api/jobs/:id` → `merge` result 含第 5 节字段。

状态：`features.merge=true`；源库过滤沿用现有 `mergedInto`。

## 7. 工作台 UX

- 知识库列表多选（2+）→「合并库」；
- 目标：已有库下拉 / 新建（名称、简介、标签）；
- Preview 表格：源库文档数、move/rename/skip 计数、冲突列表（可展开）、多版本警告、受影响笔记；
- 重复处理单选：跳过同号同版本（默认）/ 全部保留；
- 确认后跳任务进度；完成后显示结果与“前往目标库”。

## 8. 测试/验收

P0 后端：
- `test/merge-plan.test.mjs`：无冲突、同 id 同 hash、同 id 异 hash 改名、同号同版本跳过、同号多版本保留、无标准号同标题、软删除跳过、notesAffected；
- `test/merge-execute.test.mjs`：临时 KB 真实移动；目标 docs/源 mergedInto/journal/index/log；失败注入回滚；
- 验收：2 库合并后目标文档数 = 源有效文档和 − 跳过数；源库为空且 `mergedInto` 正确；journal 与快照存在；scope 清理。

P1：API + 工作台向导 + E2E（preview→execute→列表/检索）。
P2：撤销合并（journal 逆操作）、笔记引用自动改写、2–10 源库、选择性合并。

## 9. 已确认默认值（2026-11-01）

1. **重复策略**：默认 `skip`（同号同版本跳过，保留目标）；同号不同年/阶段保留；`keep` 为显式选项；
2. **源库保留**：**A 方案，懒清理 7 天**。合并成功后源文件保留，源清单标 `mergedInto` +
   `mergePurgeAfter = mergedAt + 7d`；下次插件启动/工作台打开时检查，到期才删除 `sources/`、
   `markdown/`、`history/` 大文件，保留 `kb.json`/schema/index/log 作为墓碑；用户一直不上线则不清，
   第 8 天上线时在启动检查中清理。**不使用 `trashRetentionDays`**（它跳过 merged 库）。
3. **部分合并**：有跳过文档时源库不标 `mergedInto`，继续可见；不进入 purge；
4. **笔记引用**：P0 只警告，P1 自动改写；
5. **合并快照**：默认不含 sources；配置 `mergeSnapshotSources=true` 可含。

## 9.5 撤销合并（已实现）

- `undoMerge({kbRoot,target,journal})` 按 journal 把目标文档移回源库，恢复源 `mergedInto` 等字段；
- API `POST /kb/api/merge/undo`（confirm 后后台 job `kb-merge-undo`）；
- 工作台合并成功结果区提供「撤销本次合并」；
- 只恢复合并动作，不恢复合并后对目标正文的修改；
- 改名动作会同步改写 `sources`/`linksOut`，undo 反向恢复。

## 10. 合并源清理（A 方案）

> 实现状态（2026-11-01）：P0 后端 `lib/merge.js`（plan/execute/sweep）+ P1 API/工作台向导 + P2 撤销合并、
> 笔记引用自动改写已落地；`features.merge=true`。P2 仅剩外部 kbpack 策略统一。

- 源 manifest 新增 `mergePurgeAfter` / `mergePurgedAt`；
- 合并成功且源库为空时写 `mergedInto/mergedAt/mergePurgeAfter`；
- `lib/merge.js` 提供 `sweepMergedSources({ kbRoot, now })`：
  - 只处理 `mergedInto != null && mergePurgeAfter <= now && !mergePurgedAt` 的源库；
  - 删除 `sources/`、`markdown/`、`history/`、`import-tmp/`，保留 `snapshots/`、`kb.json`、`schema.md`、`index.md`、`log.md`；
  - 写 `mergePurgedAt` 与 log；失败不阻塞启动，下次再试；
- 插件启动（`apply`）时 best-effort 调用一次；工作台打开时也可调用（P1）；
- 不依赖系统 cron/launchd，也不在用户离线时后台运行。
