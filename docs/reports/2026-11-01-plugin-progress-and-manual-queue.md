# 插件侧进展 + 人工判断清单（2026-11-01）

## 一、插件侧本轮完成

### 1. 条款解析：页眉标准号不再变成条款 `Q`

- 现象：`Q / GDW 1168—2013` 被 `APPENDIX_RE` 当成附录 `Q`，`kb_query` 出现 `[Q]`、来源“第 Q 条”。
- 修复：`lib/clauses.js` 跳过标准体系页眉（`Q / GDW`、`GB/T …—…`、`DL/T …` 等），不当作条款。
- 验证：`Q/GDW 1168` 的 155 个 `clause=Q` 清零；全库重算 FTS 后 clauses 114,444 → 113,852，`kb_query` 不再出现 `[Q]`。
- 测试：新增 3 个回归，套件 **1284/1284**。

### 2. P0 实测：>20 页 PDF 后台导入

- 用临时库 `导入回归-20261101` 导入 78 页 Q/GDW 1168 PDF；
- `kb_import` 正确转后台，job `kb-import-b260327cc2724297` 完成，文档 `ready`，78 页 / 88,214 字；
- 之前的 `session "[object Object]" has no live agent` 不再复现（owner 修复生效）；
- 测试库已删除，真实库未受影响。

## 二、剩余人工判断清单（按优先级）

| 项目 | 数量 | 怎么判断 | 建议动作 |
|---|---|---|---|
| 前缀不一致 | 29 | 用 `kb_view page=1` 看封面印刷前缀/编号/年份；与站点记录比。**封面与库内一致、站点不同 → 站点错，不要改**；过程稿 → 不改；封面明确是另一个前缀 → 改 | 18 篇过程稿不动；11 篇站点错不动；只有封面证据新的才改 |
| IEC edition 后缀 | 4 | `-ed2.0c1/c2` 是版本/勘误标识，不是年份；标题与标准号一致 | 不改 |
| 坏页 | 48 | `kb_view` 看该页：表格/图形页 OCR 文本可读、无 U+FFFD → 保留 flag；正文空白/乱码 → `kb_reparse forceOcrPages`；源文件缺页 → 补源 | 不再对表格页反复 OCR；只处理真空白/乱码页 |
| 正文不完整 | 19 | 算 chars/页：<200 且页数多 = 文字层失败；<5 页且说明/勘误 = 本来就短；1 页 20 字 = 只有封面 | 4 篇文字层失败已 OCR；`GB/T 528` 只有封面，需补完整 PDF；其余 18 篇不动 |
| 噪声摘要 | 31 | 打开前 1–2 页找“本文件规定了/适用于”；有范围句 → 人工压缩成 1–2 句；英文/扫描无正文 → 用封面标题写，不能编造 | 逐篇补，参考 `2026-11-01-summary-cleanup.md` |
| `e462e9082d31` | 1 | 看封面/正文：是否 Q/GDW 10650.6、正文标题《变电站电能质量在线监测应用导则》是否同一份 | 同一份→补全标题；不是→另立/移动，不要硬套 10650.6 |
| `8376ada3933c` | 1 | 第 1 页是国网印发通知；往后翻是否含标准正文 | 只有通知→改 stage=notes/标题；含正文→像 Q/GDW 1168 一样拆分 |
| 缺正式版 | 4 | 860.74/81/92 的 2014/2016 版、DL/T 1412 正式版；站点有且金币/次数可接受才下 | 需要时走补下载批次；旧 2006/征求意见稿保持 low |
| 保留两份的重复 | 3 组 | 不同语言/格式（IEC 62586-1/2）或草案+单章修改（IEC/TS 63222-3）；已 `kb_keep` | 不再动；若后续发现同版同语言重复再删 |
| 无标准号 | 23 | 规章/通知/介绍/内部项目稿 → 不补号；标准类（如 comtrade）才补；正式号未知不要编造 | 已补 comtrade；其余保持无号 |
| 站点错误前缀 | 11 | 封面明确 GB（如 GB 1094.x、GB 20840.x、GB 311.1），站点写 GB/T | 不改；引用时以封面为准 |

> 详细证据与逐篇列表见：
> `2026-11-01-stdno-prefix-review.md`、`2026-11-01-bad-pages-incomplete-review.md`、
> `2026-11-01-summary-cleanup.md`、`2026-11-01-no-standardno-review.md`。

## 三、插件侧剩余待办

1. **P0 ZIP64 >4GB 导出**兼容与测试；
2. **P1 bzCookie 安全存储**（Keychain / Credential Manager / Secret Service，替代 profile 明文）；
3. **P1 检索回归 80 题**（命令/阈值）；
4. **P1 导出清理/保留策略**；
5. **P2 kb_view/kb_read 多库范围错误提示**；
6. P2 合并两个知识库设计、Windows/macOS E2E、水印真实页 A/B、交付 README、只读共享；
7. 版本 0.34.1/changelog/tag（用户确认后，不 push）。

---

## 四、ZIP64 导出（2026-11-01 继续）

- 新增 `lib/zip-options.js`，统一 `{ streamFiles: true, compression: "DEFLATE", zip64: true }`；
- `kb_export(format="zip")`、`kb_snapshot`、Obsidian vault 导出都改用它；
- JSZip 默认在 4GB 边界报错，ZIP64 打开后允许 >4GB 单成员/整包；读取端 `zip-reader` 与 JSZip 均支持 ZIP64；
- 新增 `test/zip-options.test.mjs`；套件 **1285/1285**。

---

## 五、ZIP64 4GB 实测（2026-11-01）

- JSZip 写 ZIP64 实测失败：4.4GB 包中央目录长度回绕成 105MB、无 ZIP64 extra；
- 改用 `yazl`，`exportZip` / `snapshotKb` / `exportVault` 全部流式写入 + `forceZip64Format`；
- 4.4GB 稀疏 PDF 实测：ZIP64 extra=true、source file_size=4,400,000,000，Python zipfile 与内置 `openZipReader` 均通过；产物已清理。
- 详见 `2026-11-01-zip64-4gb-test.md`。
