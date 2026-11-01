# 水印净化 A/B（P2，2026-11-01）

## 脚本

```bash
# 合成水印 A/B（原图 / 合成水印 / 净化）
node scripts/watermark-ab.mjs --root ~/workspace/knowledge --kb 标准 --docs 3 \
  --report /tmp/watermark-synthetic.md --json /tmp/watermark-synthetic.json

# 真实页 A/B（不叠加合成水印；原页 OCR vs 净化 OCR）
node scripts/watermark-ab.mjs --root ~/workspace/knowledge --kb 标准 \
  --doc f92a8a27a07a --doc fc86ebdbe7f0 --docs 2 --real \
  --report /tmp/watermark-real.md --json /tmp/watermark-real.json
```

## 合成水印（3 篇真实文字层页）

| 文档 | 页 | 真值字数 | CER 干净 | CER 水印 | CER 净化 | 净化像素% |
|---|---:|---:|---:|---:|---:|---:|
| IEEE Std 519-1992 | 3 | 2501 | 0.0060 | 0.1375 | 0.0996 | 7.62% |
| GB/T 18451.1-2022 | 5 | 620 | 0.0855 | 0.0855 | 0.0839 | 7.37% |
| IEEE Std C37.111-1999 | 2 | 2978 | 0.2589 | 0.3173 | 0.2901 | 7.53% |

- 平均 CER：干净 **0.1168** → 合成水印 **0.1801** → 净化 **0.1579**；
- 合成浅灰斜线确实拉高 CER，净化回补一部分；但样本是合成水印，不代表真实字形/密度。

## 真实页（2 篇真实文字层页，`--real`）

| 文档 | 页 | 真值字数 | CER 原页 | CER 净化 | 净化像素% | 结论 |
|---|---:|---:|---:|---:|---:|---|
| Q/GDW 12663.1-2026 钢结构 | 5 | 1155 | 0.3810 | **0.2623** | 2.89% | 检测到真实水印，净化明显改善 |
| GB/T 39853.1-2021 PQI | 5 | 1039 | 0.1367 | 0.1713 | 0.08% | 几乎无真实水印，净化反而轻微变差 |

- 平均 CER：原页 **0.2589** → 净化 **0.2168**；
- 结论：**只有检测到真实水印（净化像素比例较高）时才值得净化**；对本来干净的文字层页，
  `watermark=auto` 也可能引入轻微 OCR 噪声。
- 建议：保留 `watermark=auto` 默认（真实库多数扫描件有水印）；对干净 PDF 批量导入时可用
  `watermark=off`；不做全库统一 `strong`。

## 边界

- 真实页的 CER 真值来自该页文字层；文字层自身有 OCR 噪声时，所有变体 CER 都会偏高；
- 样本量小（2 篇真实页），结论用于方向判断，不作为统计显著结论。
