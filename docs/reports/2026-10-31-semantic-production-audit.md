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

## 结论与取舍

- **summary 不应作为默认**：Doc/Page Recall、MRR、延迟全面差于 B。
- **window 质心**：Doc Recall +1.7pp、Doc MRR +0.016；代价是 Page Recall −1.7pp、Page MRR −0.046，
  p95 从 58ms 升到 85ms（仍在 120ms 内）。
- 页码下降主要来自 dense 独有文档插入 RRF 后把带页码的词法结果挤出 top-10；语义默认仍关闭，
  如果场景强依赖引用页码，应关闭语义或等待 page-aware fusion。
- 下一步：page-aware fusion（保页码的词法结果不被 dense-only 挤出），再决定是否重排阈值；
  在此之前不进一步提高语义权重，也不扩大 top-K（避免 Token 增加）。

> 早期 80 题审计（`semantic-window-audit.md`）为 FTS 文档序近似，不是生产 B；本报告为正。
