# 知识库 0.31 可选语义层实施计划

> 先读 `docs/specs/2026-10-31-semantic-layer-design.md`（尤其 §4.3 排序、§4.4 两阶段页码、§5 运行时决策）。
> 基线：0.30.0（本地 `3823c7b` + 文档 `6e5deaf`；远端 0.29 已推），`npm test` 1022/1022、E2E 11 passed / 1 skipped。
> 运行时已决策：**D1a 瘦身版**（ADR 已写，spike 通过：与评测向量 cos 0.999999、查询 2.68ms）。
> 执行方式：逐任务 TDD；每任务先写失败测试→实现→跑该范围→全量；**不 push**，完成后报告。
> 真实库只读：索引只写 `<kb>/.index/`，测试全部用临时 `kbRoot`。

**Goal:** 把 0.30 评测里胜出的「文档级语义 RRF」做成默认关闭的可选层，并用两阶段页码与
词面强命中优先修掉 Page Recall / 条款定位 MRR 两个短板，80 题回归达到设计 §8 门槛。

**Architecture:** `lib/semantic.js`（纯函数 + 编排）+ `lib/semantic-index.js`（向量索引）
+ `lib/semantic-runtime.js`（embedder 注入/真实实现/降级）；`lib/search.js` 与
`lib/index.js` 只增加可选的 semantic 通道，关闭时走现有代码路径。

---

## Task 0: 运行时决策与 spike（已完成，执行时复验）

**决策**：D1a 瘦身版（`onnxruntime-node` + `@huggingface/tokenizers`），见
`docs/specs/2026-10-31-semantic-runtime-adr.md`。

**已完成 spike 的结论（作为验收基线）**：

- 模型 `Xenova/bge-small-zh-v1.5` → `onnx/model.onnx` 94.8MB、`tokenizer.json`、
  `tokenizer_config.json`；hidden 512、BertModel；
- 与 0.30 Python/fastembed 的向量余弦 **0.999999**（6 条查询 + 4 篇文档）；
- 查询嵌入 p50 **2.68ms** / p95 3.13ms；session 加载 55ms；RSS 293MB；
- 磁盘：`onnxruntime-node` 298MB（三平台二进制）、tokenizer 0.6MB。

执行时（新对话）需做的复验与收口：

- [ ] 在**仓库内**复验 spike：`npm i -D onnxruntime-node @huggingface/tokenizers`，
      模型放 `~/.dsh/tools/models/bge-small-zh-v1.5`（命令见 ADR §5），跑通一次嵌入并核对
      512 维 / 余弦 >0.99（可直接用 0.30 的 `.f32` 对比）；若环境不允许装依赖，改为注入假
      embedder 完成 Task 1/2 的单测，真实 runner 用例 skip 并记录。
- [ ] 定**打包策略**：按 ADR「可选 peer / 伴生包」二选一，写进 `package.json` 与 README；
      运行时用 `import("onnxruntime-node")` 探测，缺失时 `enabled=false`。
- [ ] 记录 install script 提示（npm allowScripts / pnpm approve-builds）到 README 已知限制。

## Task 1: `lib/semantic.js` 纯函数

**Files:** `lib/semantic.js`（新）、`test/semantic-core.test.mjs`（新）

- [ ] 测试：
  - `normalizeVector([3,4])` → `[0.6,0.8]`；零向量 → null；
  - `cosineTopK({ query, vectors, ids, k })`：固定小矩阵，返回按分数降序的 id；
  - `fuseDocRrf({ lexical, dense, k: 20 })`：复用 `scripts/eval/fusion.mjs` 的语义
    （注意：生产用 `lib/` 实现，测试与评测实现要一致，可在单测里对比两者对同一输入的结果）；
  - `isStrongLexicalHit({ query, terms, topDoc, topClause })`：标题命中 + ≥2 个不同词命中 +
    `trust !== low` → true；缺一 → false；
  - `locatePageInDoc({ docHits, ftsMatches })`：B 已命中 → 直接用；只有 dense → 取文档内
    最佳条款页码；都没有 → `{ page: null, clause: "" }`。
- [ ] 实现：全部纯函数，无 IO；向量用 `Float32Array`。
- [ ] `node --test test/semantic-core.test.mjs`

## Task 2: `lib/semantic-index.js` 向量索引

**Files:** `lib/semantic-index.js`（新）、`test/semantic-index.test.mjs`（新）

- [ ] 测试（临时 kbRoot + 注入假 embedder，不依赖模型）：
  - 首建：3 篇文档 → `doc-vectors.f32` 行数 3、`doc-vectors.meta.json` 字段齐；
  - 增量：改 1 篇（version+1）→ 只重算 1 篇（假 embedder 调用次数 = 1）；
  - 删除：删 1 篇 → 行数 2、顺序与 meta 一致；
  - 维度不符/文件截断 → `indexReady=false` 且不抛；
  - `manifestStamp` 不变 → 不重建（embedder 调用 0 次）。
- [ ] 实现：`ensureDocVectors({ dir, manifest, embedder, stamp, background })`、
  `readDocVectors`、`docVectorsStatus`；文件 0600；原子写（临时文件 + rename）。
- [ ] `node --test test/semantic-index.test.mjs`

## Task 3: `lib/semantic-runtime.js` 真实运行时

**Files:** `lib/semantic-runtime.js`（新）、`test/semantic-runtime.test.mjs`（新）

- [ ] 按 ADR 实现 D1a 瘦身版（代码骨架见 ADR §3）：
  - 懒加载 `onnxruntime-node` + `@huggingface/tokenizers`；`Tokenizer(tokenizerJson, tokenizerConfig)`；
  - `InferenceSession.create(model.onnx)`；输入 `input_ids/attention_mask/token_type_ids`
    （int64，补 0），输出 `last_hidden_state`；
  - **CLS 池化（第 0 个 token）+ L2 归一化**；文档不加指令、查询加
    「为这个句子生成表示以用于检索相关文章：」；batch=8、max 512 token；
  - `embed(texts)` / `embedQuery(q)`；模型目录可配置（默认 `~/.dsh/tools/models/bge-small-zh-v1.5`）；
  - 依赖缺失/模型缺失 → `{ available:false, reason:"runner_missing"|"model_missing" }`，回退 B。
- [ ] 测试：注入假模型；模型缺失 → 降级对象（`available:false, reason`）；下载未同意 →
  不联网、降级；同一进程只告警一次。
- [ ] `node --test test/semantic-runtime.test.mjs`

## Task 4: 接入 `/kb/api/search` 与 `kb_query`

**Files:** `lib/search.js`、`lib/web/api.js`、`lib/index.js`、`lib/web/server.js`（注入 opts）、
`test/web-search-semantic.test.mjs`（新）、`test/query-semantic.test.mjs`（新）

- [ ] 测试：
  - `semanticSearch=off`：与 0.30 完全一致（golden：同一输入的结果 JSON 逐字段比较）；
  - `on` + 假 embedder/预置向量：`engine="hybrid"`，dense 独有文档出现在结果里且 page 由
    两阶段回填；强词面命中时条款定位 top-1 不变；
  - 索引构建中 → 回退 B + `note`；模型不可用 → 回退 B + `status.semantic.reason`。
- [ ] 实现：`searchAll({ ..., semantic })` 可选通道；`/search` 与 `kb_query` 从 opts 读取
  语义状态；`/kb/api/status` 增加 `semantic` 字段。
- [ ] `node --test test/web-search-semantic.test.mjs test/query-semantic.test.mjs` + 回归
  `test/web-search.test.mjs`、`test/search-core.test.mjs`。

## Task 5: 80 题回归与门槛

**Files:** `scripts/eval-benchmark.mjs`（改）、`docs/specs/2026-10-31-semantic-regression.md`

- [ ] 给 benchmark 增加 `--semantic-sim` 模式：直接读取 0.30 的文档向量与查询向量（不跑模型），
  按生产 `lib/semantic.js` 的融合/两阶段逻辑产出 `K` 变体（生产等价）。
- [ ] 跑 80 题（60 主集 + 20 独立同义），核对设计 §8 六条门槛；不达标先调 §4.3 的阈值组，
  不允许按题号特判。
- [ ] 写回归报告（含与 B/H 的对比、Page Recall 恢复情况、条款定位 MRR、p95）。

## Task 6: 文档、版本、验收

**Files:** `README.md`、`docs/specs/2026-10-31-semantic-layer-design.md`（追加实施记录）、
`package.json`、`package-lock.json`、`lib/version.js`

- [ ] README 增加 0.31 段：如何开启、模型下载/同意、索引位置与大小、已知限制；
- [ ] 版本 0.31.0；`npm test` / `typecheck` / `check:client` / `check-ui` / E2E 全绿；
- [ ] 报告 diff 与测试输出；**不 push**。

## 验收清单

- [ ] 默认关闭：行为与 0.30 完全一致，且不加载模型；
- [ ] 开启后 80 题：Doc Recall ≥ 84.4%、Page Recall ≥ 72.5%、MRR ≥ 0.603、条款定位 MRR ≥ 0.875、
      20 题独立同义 ≥ 80.0%、p95 < 120ms；
- [ ] 两阶段页码对 dense 独有文档返回 page/clause（无命中则 page=null 并标注）；
- [ ] 强词面优先只影响排序，不改变召回集合；
- [ ] 模型缺失/索引损坏/构建中都能回退 B，且只告警一次；
- [ ] 真实库只读；索引 0600；不写 sources/markdown；不 push。
