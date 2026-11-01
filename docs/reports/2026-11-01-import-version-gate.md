# 导入质量闸门：同号多版本提示（2026-11-01）

## 目标

用户在导入时很难自己发现「同标准号不同年份/阶段」——新文件可能悄悄变成第二份 2021 版、或报批稿与发布稿并存。导入前由插件检测并提示；用户确认或修正标题后仍可入库。

## 行为

1. 导入前按标题标准号比较（GB/T 与 GB 视为同一 code，部分号保留）：
   - 同号不同年份 → `versionConflicts[].reason = "different-year"`；
   - 同号同年不同阶段（发布稿/报批稿/征求意见稿等）→ `"different-stage"`；
   - 同号一方无年份 → `"unknown-year"`。
2. **同库**冲突：该文件先暂停，不写入；结果返回 `versionConflicts` + `versionConfirmed:false`，其他无冲突文件照常导入。
3. 用户确认后重新执行 `kb_import` 并传 `allowSameNumber: true` → 冲突文件入库，结果 `versionConfirmed:true`。
4. 用户也可改 `title`（单文件）修正年份/阶段后再导入。
5. **跨库**同号多版本只提示、不阻断；仍受 `allowCrossDuplicates` 控制的是“完全重合”的跨库文件。
6. 同号同年同阶段仍按原规则判重跳过，不进入此闸门。

## 结果字段

```json
{
  "versionConflicts": [
    {
      "title": "GB/T 12325-2019 电能质量 供电电压偏差",
      "scope": "same-kb",
      "reason": "different-year",
      "matched": [{ "kb": "标准", "title": "GB/T 12325-2008 ...", "id": "..." }]
    }
  ],
  "versionConfirmed": false
}
```

## 示例

- 先导入 `GB/T 12325-2008`；
- 再导入 `GB/T 12325-2019`：不写入，返回 `versionConflicts/reason=different-year`，渲染提示“同库多版本已暂停”；
- 加 `allowSameNumber: true` 重试：写入 2019 版，`versionConfirmed=true`，两版共存；
- 同号 `（报批稿）` 与发布稿：`different-stage`；
- 跨库版本：仅提示。

## 代码/测试

- `lib/dedup.js`：新增 `versionConflict()` 与 `scanDuplicates().versionConflicts`；
- `lib/index.js`：`allowSameNumber` 参数、同库暂停、渲染与 `versionConfirmed`；
- 测试：`test/dedup.test.mjs` 2 例、`test/kb-import-version-gate.test.mjs` 1 例；
- 全量 **1288/1288**。
