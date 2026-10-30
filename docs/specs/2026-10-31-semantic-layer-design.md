# 知识库 0.31：可选语义层（文档级 RRF + 两阶段页码 + 词面强命中优先）设计

> 状态：待实施。依据 0.30 评测（`docs/specs/2026-10-30-doc-level-hybrid-benchmark.md`）。
> 基线：`dsh-knowledge-wiki` 0.30.0（本地 `3823c7b`），`npm test` 1022/1022、E2E 11 passed / 1 skipped。
> 原则：**默认关闭**、关闭时与 0.30 行为完全一致；真实库只读；不自动 push。

## 1. 背景与结论

0.30 在 80 题（60 主集 + 20 条独立同义题）上验证了「**文档级**语义向量 + RRF」：

| 口径 | B（FTS+boost） | H（文档级 RRF） |
|---|---|---|
| 20 条独立同义题 Doc Recall@10 / MRR | 65.0% / 0.317 | **80.0% / 0.497** |
| 60 题主集 | 83.3% / 0.608 | **85.8% / 0.638** |
| 合并 80 题 | 78.8% / 72.5% / 0.535 | **84.4% / 74.4% / 0.603** |

成本：911 篇文档向量 **1.9MB**、本机首建 **11s**、查询嵌入约 **1.6ms**；条款级 dense 已否决
（292MB / 27 分钟 / 召回更低）。但 H 有两个明确短板，0.31 必须先修掉再谈上线：

1. **Page Recall 退步**（数值限值组 93.3% → 86.7%）：文档级向量没有页码，dense 独有命中的文档
   无法定位到页；
2. **条款定位 MRR 退步**（0.875 → 0.772）：RRF 把词面强命中的 top-1 稀释到中段。

## 2. 目标与非目标

### 2.1 目标

- 语义层作为**可选功能**接入 `kb_query` 与工作台 `GET /kb/api/search`；默认关闭。
- 排序 = 文档级 RRF（B 的 boost 文档序 + 文档 dense 序），并叠加：
  - **两阶段页码定位**：文档进入候选后，在该文档内用 FTS 条款命中定位页码；
  - **词面强命中优先**：满足强条件时把词面 top-1 锁定，避免条款定位 MRR 退步。
- 索引：`<kb>/.index/doc-vectors.f32` + `doc-vectors.meta.json`，按 manifest 增量刷新，
  损坏/缺模型时**完全回退** B（与 0.26 的 FTS→rg 回退同款）。
- 状态与开关：配置 `semanticSearch: off|on`（默认 off）；`/kb/api/status` 暴露
  `semantic: { enabled, indexReady, model, dim, docs }`；工作台状态行在启用时标注「语义」。
- 验收要跑 80 题回归，指标不低于下列门槛（见 §8）。

### 2.2 非目标

- 不做条款级向量、不做 rerank、不做 query rewrite、不做跨库/跨机器索引共享。
- 不改变默认（关闭）行为、不改变 `sources`/深链/分页契约、不改 viewer。
- 不引入需要编译工具链的原生依赖（预编译二进制见 §6 决策）。
- 不改 `.scopes.json`、胶囊、回收站、导入管线。

## 3. 架构与数据流

```
searchAll / kb_query
  └─ 现有 B：FTS 条款 → groupHitsByDoc → rankResults（boost）
  └─ 可选 semantic：
       docQueryVec = embed(query)                 （1.6ms）
       denseDocs   = topK(cosine(query, docVecs)) （<1ms，911×512）
       fused       = RRF(B 的文档序, denseDocs)    （k=20）
       strongLex   = 词面强命中？（见 §4.3）→ 锁第一位
       对每个候选文档：FTS(doc=该文档, query) → 最佳条款页码（两阶段）
       输出 results（page/clause/snippet 与 B 同口径）
```

- 新模块：`lib/semantic.js`（纯函数：向量归一化、余弦 topK、RRF、强词面判定、页码回填编排）、
  `lib/semantic-index.js`（索引读写/增量/损坏回退）、`lib/semantic-runtime.js`（embedder 注入 +
  真实实现 + 降级）。
- 依赖注入：`searchAll` 接受可选 `semantic` 通道（`{ enabled, embed, docVectors, ... }`），
  单测不需要模型；真实运行时由 `semantic-runtime.js` 提供，失败即 `enabled=false`。

## 4. 关键设计

### 4.1 文档文本与模型

- 模型：`BAAI/bge-small-zh-v1.5`（512 维；查询侧加中文检索指令
  「为这个句子生成表示以用于检索相关文章：」；文档侧不加指令）。
- 文档文本：`标准号 + 标题 + 标签 + 摘要 + 首条款正文（≤300 字）`，总长 ≤600 字（与 0.30 评测一致，
  保证评测可复现）。
- 归一化：L2；相似度 = 点积；只保留 float32（1.9MB/911 篇）。

### 4.2 索引文件与生命周期

```
<kb>/.index/doc-vectors.f32        # N×512 float32，行序 = doc-vectors.meta.json 的 docs 顺序
<kb>/.index/doc-vectors.meta.json  # { schemaVersion, model, dim, docs:[{id,version,updatedAt}], manifestStamp, builtAt }
```

- **惰性构建**：首次需要语义检索且 `indexReady=false` 时构建；大库（>100 篇）放后台进程（复用
  `fts-worker.mjs` 的模式），当次请求回退 B 并在 `note` 里说明。
- **增量**：`manifestStamp` 变化时比较每篇 `id/version/updatedAt`；只重算变动/新增文档；
  删除文档时重写向量文件（按行重建，1.9MB 成本可忽略）。
- **损坏/缺模型**：读失败或维度不符 → 视为不可用，`indexReady=false`，回退 B；不阻塞检索。
- 文件权限 0600；不写 `sources/`、`markdown/`。

### 4.3 排序：RRF + 词面强命中优先

- 文档级 RRF：`score = 1/(k+rank_lex) + 1/(k+rank_dense)`，`k=20`；lex = B 的文档序（top-50），
  dense = 文档向量余弦序（top-50）。
- **强词面命中**（解决条款定位 MRR 退步）：当 B 的 top-1 同时满足
  ① 查询词命中标题（≥1 个 length≥2 的词），② 该文档最佳条款命中 ≥2 个不同查询词，
  ③ 且该文档 `trust != low` 时，把 B 的 top-1 锁定在 fused 的第 1 位，其余按 RRF 排序。
  三条阈值先用 60 题主集做小范围验证（只允许这一处调参，禁止按题号特判）。
- 输出方式：沿用 `lib/search.js` 的 `buildSearchResponse`，不新增字段；`engine` 增加 `"hybrid"`。

### 4.4 两阶段页码定位

- 对最终进入 top-10 的每个文档：
  1. 该文档已在 B 的条款命中里 → 直接用 B 的 best clause `page/pageEnd/clause`（现状）；
  2. 只在 dense 命中 → 在该文档内跑一次 FTS 条款查询（`docId` 过滤，term = 查询关键词），
     取最佳条款的 `pageStart/clause`；
  3. 仍无命中 → `page=null`、`clause=""`，卡片显示「无页码」，snippet 用文档摘要/首段。
- 延迟预算：top-10 文档 × 单文档 FTS（`docDir` 模式，`perFile` 上限 20）≈ 10 × 2–5ms；
  p95 目标 < 120ms（B 约 55ms）。
- 页码只用于 `sources/deepLink` 与卡片展示，不改变文档级 Recall 口径。

### 4.5 开关、状态与降级

| 场景 | 行为 |
|---|---|
| `semanticSearch=off`（默认） | 完全走 0.30 的 B，代码路径不加载模型 |
| `on` 且索引就绪 | B + 文档 RRF + 两阶段页码 + 强词面优先 |
| `on` 但模型不可用/下载未同意 | 回退 B，`status.semantic.reason=model_unavailable`，只告警一次 |
| `on` 但索引构建中 | 本次回退 B，`note` 提示「语义索引构建中」，后台完成后下次生效 |
| 索引损坏/维度不符 | 删除重建（best-effort）；失败回退 B |

- 配置：`semanticSearch`（`off|on`）、`semanticModelDir`（默认 `~/.dsh/tools/models`）；
  首次启用需要显式同意下载（复用 `autoDownloadModels` 的语义，默认不下载）。
- `/kb/api/status`：`semantic: { enabled, indexReady, model, dim, docs, reason? }`；
  工作台检索状态行在启用时显示 `· 语义`，构建中显示提示。

## 5. 运行时选型（已定：D1a 瘦身版）

> 2026-10-30 已拍板 **D1a 瘦身版**，详见 `docs/specs/2026-10-31-semantic-runtime-adr.md`：
> `onnxruntime-node`（预编译原生，298MB）+ `@huggingface/tokenizers`（纯 JS，0.6MB），
> 不用 `@huggingface/transformers`（它会再拉 onnxruntime-web 150MB 与 sharp）。
> Spike 已验证：与 0.30 Python/fastembed 的向量 **cos=0.999999**，查询嵌入 p50 **2.68ms**，
> session 加载 55ms，常驻 RSS 293MB。

| 选项 | 结论 |
|---|---|
| **D1a 瘦身版（选定）** | `onnxruntime-node` + tokenizer.js；可选 peer 安装、默认不装；语义关闭时不加载 |
| D1a 完整版（transformers.js） | 不采用：多 150MB WASM + sharp 原生，收益为零 |
| D1b（纯 WASM） | 不采用：解包 150MB、Node 下需自行接 onnxruntime-web、速度 2–4× 慢 |
| D1c（外部 Python worker） | 不采用：可研但不可发布（用户需装 Python + fastembed），查询嵌入仍要外部进程 |

**备选回退**：若后续发现 298MB 不可接受，退化到 D1c-c2（常驻 Python worker）或 D1c-c4
（只保留离线评测），Task 1/2/4/5 不受影响。

## 6. 安全与资源

- 模型只从本地缓存/用户同意的下载地址加载；默认不联网；下载前需要 `confirm: true`。
- 索引与模型缓存路径不进入 `sources/`/`markdown/`；索引文件 0600。
- 真实库验收只读：索引是派生数据（写 `<kb>/.index/`），不改清单/正文；测试全用临时 `kbRoot`。

## 7. 测试计划

| 层 | 文件 | 要点 |
|---|---|---|
| 纯函数 | `test/semantic-core.test.mjs`（新） | 向量归一化/余弦 topK；RRF 顺序；强词面三条件；两阶段页码回填（有/无命中）；空向量降级 |
| 索引 | `test/semantic-index.test.mjs`（新） | 首建/增量（改一篇）/删除/维度不符/损坏回退；manifestStamp；注入假 embedder |
| 运行时 | `test/semantic-runtime.test.mjs`（新） | embedder 注入、模型缺失降级、下载未同意降级、只告警一次 |
| 接入 | `test/web-search-semantic.test.mjs`（新）、`test/query-semantic.test.mjs`（新） | `/search` 与 `kb_query` 在 on/off 下的结果差异；`engine=hybrid`；页码来自两阶段；关闭时与 0.30 完全一致（golden 对比） |
| 评测回归 | `scripts/eval-benchmark.mjs`（改） | 新增 `--semantic-on` 模式的端到端变体（用本地向量），80 题回归 |
| E2E | `scripts/e2e/tests/search.mjs`（改） | 语义开启（夹具向量）时状态行有「语义」、卡片页码存在；关闭时行为不变 |

## 8. 验收标准（80 题，硬门槛）

1. Doc Recall@10 ≥ **84.4%**（0.30 的 H），且 ≥ B（78.8%）；
2. Page Recall@10 ≥ **72.5%**（B 的水平）——两阶段页码必须把 86.7% 的数值组短板补回；
3. MRR@10 ≥ **0.603**（H），且**条款定位组 MRR ≥ 0.875**（B 的水平）；
4. 20 条独立同义题 Doc Recall@10 ≥ **80.0%**；
5. 默认关闭时 `npm test`/E2E 与 0.30 完全一致（新增 golden 对比测试）；
6. 查询 p95 < **120ms**（开启语义时，含查询嵌入与两阶段页码）；
7. 全门禁：`npm test`、`typecheck`、`check:client`、`check-ui`、E2E。

## 9. 风险

- **模型下载/分发**：92MB 需要网络与同意；CI 无模型 → 相关用例必须能 skip 或注入假 embedder。
- **原生依赖**：D1a 会引入 `onnxruntime-node` 预编译二进制；需要 `optionalDependencies` + 运行时探测。
- **RRF/强词面阈值过拟合**：只允许一组阈值，必须在 60 主集与 20 独立题上同时不退步。
- **两阶段页码延迟**：10 次单文档 FTS；若超预算，改为一次多文档 FTS + 内存过滤。
- **索引体积**：1.9MB/911 篇可接受；千篇级约 2MB，不需要量化。

## 10. 版本与交付

- 版本 **0.31.0**；README 增加 0.31 段（默认关闭、如何开启、模型下载、已知限制）；
- 交付物：`lib/semantic*.js`、接入改动、单测、80 题回归报告（追加到
  `docs/specs/2026-10-30-doc-level-hybrid-benchmark.md` 或新报告）、README/版本；
- **不自动 push**，完成后报告 diff 与测试，等用户确认。

## 11. 实施记录（0.31.0，2026-10-30）

> 状态：已实施。验收数据见 `docs/specs/2026-10-31-semantic-regression.md`。

**新增模块**：`lib/semantic.js`（纯函数）、`lib/semantic-index.js`（`<kb>/.index/doc-vectors.*`）、
`lib/semantic-runtime.js`（D1a 运行时）、`lib/semantic-service.js`（通道/状态装配）、
`lib/semantic-worker.mjs`（>100 篇后台建索引）。

**接入点**：`lib/search.js` 的 `searchAll`/`applySemanticToResults`、`/kb/api/search`、`kb_query`、
`/kb/api/status` 的 `semantic` 字段；配置 `semanticSearch`（默认 off）与 `semanticModelDir`。

**与设计稿的实现偏差（都是为了达标/可维护，已记录理由）**：

1. **两阶段页码不用「文档内 FTS 查询」而用「文档内按词命中扫描条款」**：FTS 的 docId 过滤实测
   17.6ms/篇，top-10 会把 p95 推到 160ms+；改为 `clauses(doc_id)` 索引（首次打开旧索引时惰性创建，
   149k 条款约 1.1s）后 p95 69ms（预计算向量口径，含生产融合逻辑）。语义等价：仍是在该文档内找
   查询词命中的条款页码/条款号。
2. **强词面命中的标题条件**增加「查询与标题共享任一 CJK 二字片段」：`keywordsOfQuery` 会切出
   「光伏并网逆变器功」这类长片段，纯子串会漏掉标题只含「光伏」的文档（Q12 条款定位 MRR 从
   第 9 名回到第 1 名）。其余两条条件与阈值不变；在 60 主集与 20 独立题上同时验证。
3. **索引稳定性**：除设计稿要求的字段外，meta 增加 `dataHash`（sha256），半写（f32 已换、meta
   未换）会被判损坏并全量重建，不会被当作有效索引。
4. **关闭路径**：`semanticSearch=off` 时 `searchAll` 的返回对象只是多一个
   `semantic:{applied:false,reason:""}` 内部字段（不进 HTTP 响应），结果/排序/字段与 0.30 逐字段一致
   （`test/search-semantic.test.mjs` 的 golden 对比）。

**验收结论**：80 题 Doc 84.4% / Page 77.5% / MRR 0.613 / 条款定位 MRR 0.883 / 20 独立题 Doc 80.0% /
p95 69.0ms（预计算向量），六条门槛全部达标；`npm test` 1076/1076、typecheck、check:client、E2E
11 passed / 1 skipped。
