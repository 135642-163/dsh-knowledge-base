# 无标准号资料复核（24 篇，2026-11-01，只读）

- 范围：`标准` 库中在库、非笔记、`standardNo` 为空的资料（另有 1 篇自动生成的 `标准索引` markdown，不算资料）
- 结论：**21 篇本就不该有标准号**（规章/通知/介绍/内部项目稿）；**3 篇标准类资料需要处理**：1 篇补号、2 篇改 stage/trust

## A. 规章/通知/介绍（7 篇，保持无号）

| 文档 | 说明 |
|---|---|
| `afd211967028` 电能质量管理办法（暂行）2023 发改委令第8号 | 部门规章 |
| `2f5033a94732` 国网（运检/3）919-2018 电网谐波管理规定 | 公司规章制度 |
| `7e33733c262b` 供电营业规则 2024 发改委令第14号 | 部门规章 |
| `9489321e7e1b` 浙电规〔2020〕1号 电能质量管理规定 | 公司文件（含转发通知） |
| `d57184dadb5a` 国家电网公司关于印发…等8项标准的通知 | 通知/标准清单 |
| `234482d757a8` IEEE标准协会及其标准 | 介绍材料 |
| `4556cc691847` IEC及其技术工作程序 | 介绍材料 |

## B. 内部项目稿/研究报告（14 篇，保持无号）

- G5 系列 4 篇：`cfd57c0f0bde`（G5 5 Draft）、`531e15ad9fd9`（G5 4-1-2005）、`cc59ffcea4a5`（G5 5-2020）、`ccc7d07e1bbe`（G5 5工程导则评述）；
- 高压有源谐振抑制装置 10 篇：`dfb4bbfdece3`、`f130428b8aa6`、`10f7aa78dd4a`、`52c3a1cc9ddf`、`add3ba0ea11f`、`55c82961dcc5`、`05ed0f9005af`、`c7e26123140f`、`ed66d3a73aac`、`8ce7c5f2c293`；
- HARS 的 stage 已是征求意见稿/送审稿，trust low/medium，无需改号。
- **G5 5 Draft**（`cfd57c0f0bde`，61 页扫描）当前 stage=发布稿、trust=high，建议改 stage=draft、trust=medium；其余 G5 是报告，可改 stage=说明材料、trust=medium。

## C. 标准类资料（3 篇，需要处理）

| 文档 | 正文证据 | 建议 |
|---|---|---|
| `552f6e7793e1` comtrade99 | 第 1 页 `IEEE Std C37.111-1999`（Revision of C37.111-1991），标题 *IEEE Standard Common Format for Transient Data Exchange (COMTRADE) for Power Systems* | 补 `standardNo=IEEE C37.111-1999`，标题改为 `IEEE Std C37.111-1999 电力系统暂态数据交换通用格式（COMTRADE）`，trust=high |
| `80a5da4f6789` WD 2023003224 构网型变流器通用技术规范 | 第 1 页：`中华人民共和国国家标准 GB/T XXXX-XXXXX 构网型变流器通用技术规范（征求意见稿）` | 暂无正式号，**不要编造标准号**；标题保留项目号并补“（征求意见稿）”，stage=draft，trust=low/medium |
| `4bc90e9bf450` 数据中心基础设施施工及验收标准 | 第 1 页是“前言”，按 2020 年住建部计划修订；全文无标准号/封面号 | 属修订稿/报批稿，暂无号；建议 stage=review 或 notes、trust=medium，**不要补号** |

> 另有 `b372fa7b6256`「标准索引（自动生成）」是插件维护的索引页，既不是标准也不是资料，保持现状。

## 建议执行

1. 快照；
2. `comtrade99` 补号 + 改标题（需手工写 standardNo 字段，标题解析对 `C37.111` 不可靠）；
3. `WD 2023003224` 标题补“（征求意见稿）”、stage=draft、trust=medium；
4. `数据中心…` stage=review/notes、trust=medium；
5. G5 5 Draft stage=draft、trust=medium；其余 G5 报告 stage=notes、trust=medium；
6. 其余 21 篇不动。

> 本轮只读；未改任何文档。
