# Windows 实机反馈修复（2026-11-01）

来源：`/Volumes/home/工作/kb-windows-verify-for-mac.md`（Windows 0.35.0 自检 PASS，发现 3 个问题）。

## 1. kb_export 的 out 父目录不存在

- 现象：`out="...\.kb-win-test\out\xxx.md"` 时 `createWriteStream` 抛 ENOENT，宿主升级成
  `fatal load failure` 并重启，profile 用户层被重置。
- 修复：`kb_export` 在解析出 `outPath` 后先 `mkdir(dirname(outPath), {recursive:true})`；
  创建失败返回 `EXPORT_OUT_DIR` 结构化错误，不再把裸 ENOENT 抛到宿主层。
- 插件侧只能保证“目录不存在时自动建”；宿主把工具异常升级为 fatal 属于宿主行为，需另修。

## 2. Windows rename EPERM/EBUSY

- 现象：目录批量导入时 `import-tmp/<docId>` → `markdown/<docId>` 的 rename 被
  Defender/索引器持句柄，整批中断；单文件重试成功。
- 修复：`store.js` 新增 `renameWithRetry`：
  - 只重试 `EPERM` / `EBUSY` / `EACCES`；
  - 总 3 次尝试，退避 25ms、50ms；
  - 清单原子写、source/markdown、历史恢复、库目录 rename 统一走它。
- 非可重试错误立即抛出；测试覆盖重试成功与 ENOENT 不重试。

## 3. skipped 文案

- 现象：去重跳过被渲染成「该文档正在导入中」；`index.js` 把 `skipped` 一律当导入中，且丢掉
  `pipeline.js` 返回的 `reason`/`duplicate`。
- 修复：
  - `markImporting` 冲突跳过补 `reason:"importing"`；
  - `renderKbImport` 按 reason 显示：重复、库内已有完整版本、双方残缺、正在导入等；
  - 汇总从「因正在导入中已跳过」改为「已跳过，原因见下」。

## 4. 卡片彩色条

- 可信度四档从低饱和 `#4f9d69/#c9a36a/#b96a6a/#93a3b8`
  改为明亮 `#22c55e/#f5a524/#f05252/#6b9fff`；
- 库名圆点 `hsl(...,55%,52%)` → `hsl(...,82%,56%)`；
- 同步更新 `ui-overview` 断言。

## 测试

- 新增：export 父目录、rename 重试、skipped 文案；
- 全量 **1313**（1309 通过、4 跳过，0 失败）。

## 待办

- 0.35.1 已在 Windows 实机复测通过（见 `2026-11-02-windows-followup.md`）；
- 宿主 fatal 升级问题需要 DSH 宿主侧修复，不是本插件能完全兜住的。
