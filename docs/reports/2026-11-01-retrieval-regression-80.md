# 80 题检索回归（P1，2026-11-01）

## 命令

```bash
npm run eval:retrieval
# 等价：
node scripts/eval-retrieval-80.mjs
```

默认读取：

- `scripts/eval/questions-2026-10-27.jsonl`（60 主集：条款/跨文档/数值/同义）
- `scripts/eval/questions-2026-10-30-paraphrase.jsonl`（20 条独立同义改写）

默认库：`~/workspace/knowledge/标准`；可用 `--dir` 覆盖。
搜索路径：生产 `searchAll`（文档分组/boost）+ FTS5，**不启语义模型**，结果确定、无需模型。

## 指标与阈值

| 指标 | 当前基线 | 默认阈值 |
|---|---|---|
| Doc Recall@10 | 88.8% | ≥85% |
| Page Recall@10 | 67.5% | ≥62% |
| Doc MRR@10 | 0.574 | ≥0.52 |
| Page MRR@10 | 0.455 | ≥0.40 |
| p95 | 50.8ms | ≤250ms |

任一不达标 → exit 1；`--out` 写 JSON（含未命中题与 top3 候选），`--quiet` 只保留退出码。
阈值可通过 `--min-doc-recall/--min-page-recall/--min-doc-mrr/--min-page-mrr/--max-p95` 覆盖。

## 分组基线

| 组 | n | Doc | Page | Page MRR |
|---|---:|---:|---:|---:|
| clause | 20 | 100.0% | 85.0% | 0.722 |
| multi-doc | 15 | 86.7% | 73.3% | 0.425 |
| numeric | 15 | 93.3% | 73.3% | 0.608 |
| paraphrase | 30 | 80.0% | 50.0% | 0.215 |
| **合计** | **80** | **88.8%** | **67.5%** | **0.455** |

> 这是 **FTS 确定性回归**，不是语义混合口径；语义 80 题审计见
> `2026-10-31-semantic-production-audit.md`（hybrid 的 Doc/Page 更高，但依赖模型）。
> 当前基线较 10-31 变化，主要因为库内重复清理/标题修正后题集期望文档仍是原 id（已确认无删除/缺失）。

## 失败路径验证

```bash
node scripts/eval-retrieval-80.mjs --min-doc-recall 0.99 --quiet
# exit 1（阈值未通过）
```

## 文件

- 脚本：`scripts/eval-retrieval-80.mjs`
- 题集：`scripts/eval/questions-2026-10-27.jsonl` + `scripts/eval/questions-2026-10-30-paraphrase.jsonl`
- 结果示例：运行 `--out /tmp/eval80.json` 生成。
