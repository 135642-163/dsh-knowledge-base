# 语义生产口径回归：B / summary / window（2026-10-31）

> 真实「标准」库、80 题、真实 `searchAll` 与 FTS 页码；向量在内存构建，不写真实库 `.index`。
> 脚本：`scripts/eval/semantic-production-audit.mjs`。

## 口径

- **B**：`searchAll` 的 FTS + boost 排序（不启用语义）。
- **S**：B + summary 600 字 dense（RRF）。
- **H**：B + window 8 窗口质心 dense（RRF）；dense 独有文档用 `locateInDoc` 补页码。
- 指标：Doc/Page Recall@10、Doc/Page MRR@10；延迟为 80 题单次查询耗时（不含建索引）。

## 结果

| 方案 | Doc Recall@10 | Doc MRR | Page Recall@10 | Page MRR | mean | p95 |
|---|---|---|---|---|---|---|
| B | 93.3% | 0.627 | **81.7%** | **0.576** | 43.4ms | 58.0ms |
| S summary | 90.0% | 0.601 | 76.7% | 0.494 | 61.6ms | 104.8ms |
| H window 质心 | **95.0%** | **0.643** | 80.0% | 0.529 | 55.3ms | 85.4ms |

分组：

| 组 | B Doc/Page | H Doc/Page |
|---|---|---|
| 条款定位 | 100% / 95.0% | 95.0% / 90.0% |
| 跨文档 | 86.7% / 80.0% | 100% / 80.0% |
| 数值限值 | 93.3% / 86.7% | 93.3% / 86.7% |
| 同义改写 | 90.0% / 50.0% | 90.0% / 50.0% |

## page-aware fusion（页码保护）

保留 B 的前 N 条带页码结果在头部，其余 top-10 槽位再放语义候选：

| pageGuard | Doc Recall@10 | Doc MRR | Page Recall@10 | Page MRR |
|---|---|---|---|---|
| 4 | 93.3% | 0.630 | 80.0% | 0.575 |
| 6 | 95.0% | 0.631 | 81.7% | 0.576 |
| **8** | **96.7%** | **0.631** | **83.3%** | **0.578** |

- pageGuard=8 同时超过 B 的 Page Recall（81.7%→83.3%）、Page MRR（0.576→0.578），
  Doc Recall 也从 93.3% 提到 96.7%；Doc MRR 略低于无保护的 H（0.643），但仍高于 B（0.627）。
- 代价只是 RRF 后的顺序调整，不扩大 top-K、不增加返回 Token；p95 约 98ms（仍 <120ms）。
- 已把 `SEMANTIC_PAGE_GUARD = 8` 设为语义通道默认；summary/window 都走同一保护。

## 结论

- **summary 不应作为默认**：Doc/Page Recall、MRR、延迟全面差于 B。
- **window + pageGuard=8** 是当前最优组合：Doc Recall 96.7%、Doc MRR 0.631、
  Page Recall 83.3%、Page MRR 0.578；语义默认仍关闭，开启时同时获得语义召回与页码保护。
- 页码下降问题已由 page-aware fusion 解决；不提高语义权重，也不扩大 top-K（避免 Token 增加）。

> 早期 80 题审计（`semantic-window-audit.md`）为 FTS 文档序近似，不是生产 B；本报告为正。
