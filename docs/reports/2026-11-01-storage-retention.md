# 快照 / 导出保留策略（P1，2026-11-01）

## 策略

| 配置 | 默认 | 行为 |
|---|---:|---|
| `snapshotKeep` | 20 | 每次创建库快照后，`snapshots/` 只保留最近 N 份 `.zip`（连同 `.zip.json` sidecar）；0=不限制 |
| `exportKeep` | 20 | `kb_export` 写入库内 `exports/` 时，只保留最近 N 份 `.md/.jsonl/.zip`；0=不限制 |

- 只清理插件管理的 `snapshots/` 与 `exports/`；
- 只删已知扩展名，目录/其他文件不碰；
- `kb_export` 指定 `out` 的外部文件不参与清理；
- 时间排序按文件名（快照/导出名含 ISO 时间戳）。

## 当前真实库预演

```bash
node scripts/prune-kb-storage.mjs --root ~/workspace/knowledge --kb 标准
# snapshots 24→20（删 4，333.3MB）；exports 0→0
```

**默认 dry-run，未删除。** 下次创建快照时会按 20 份自动清理；也可手动：

```bash
node scripts/prune-kb-storage.mjs --root ~/workspace/knowledge --kb 标准 --apply
```

## 实现

- `lib/storage-retention.js`：`pruneSnapshots` / `pruneExports`，支持 dryRun；
- `kb_snapshot` 创建后自动 prune，结果返回 `pruned`；
- `kb_export` 写入库内 `exports/` 后自动 prune，结果返回 `pruned`；
- 新增 `scripts/prune-kb-storage.mjs`（默认 dry-run、`--apply`、`--json`）；
- 新增 `test/storage-retention.test.mjs` 3 例；
- 全量测试 **1295**（1291 通过、4 跳过，0 失败）。

## 备注

- 旧快照是安全留档，默认只保留 20 份；需要更多可把 `snapshotKeep` 调大或设 0；
- 当前 4 份 10-31 旧快照仍在，是否立即删除由用户决定。
