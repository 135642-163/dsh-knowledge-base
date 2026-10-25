# 知识库 0.27：检索工作台与人工评测设计

> 状态：已按用户 2026-10-26 的四项确认修订（本地先提交 0.26、标准号回归放进 0.27 Task 1、
> 顶层 `#/search` + 侧栏入口、搜索结果复用工作台现有预览弹窗），可以进入实施。
> 基线：`dsh-knowledge-wiki` 0.26.0，`git 8a6a867`，`npm test` **912/912**、
> `npm run typecheck` / `check:client` 通过、E2E **10 passed / 0 failed / 1 skipped**。
> 关联：`2026-10-25-kb-metadata-ingest-sources-design.md` §8（条款级分块/FTS5 设计）、
> `2026-10-25-retrieval-eval.md`（60 条机制回归）、`2026-10-23-kb-workbench-design.md`（路由/API 约定）、
> `2026-10-24-kb-workbench-slice2b-design.md`（范围与胶囊既有契约）。
> 本轮目标只有两件：**可用的检索工作台**（HTTP + 页面）与**可复用的人工评测集与基准**。

## 1. 背景与要解决的问题

0.26 把检索索引做进了 `kb_query`（条款级 FTS5 + ripgrep 回退），但检索能力只有两处出口：

1. **对话工具** `kb_query`：模型用，人看不到排序、过滤、翻页，也无法在页面上比较结果。
2. **工作台资料页搜索** `GET /docs?query=`：只搜标题/摘要/标签，**不搜正文**。

同时 0.26 引入了一个检索回归（§3.3）：标准号带斜杠的查询被判定为纯文本走 FTS，
`GB` 与 `GB/T` 不再区分。0.27 必须先把这条修掉，否则「检索工作台」的标准号结果不可信。

第三件事是**评测**：0.26 的评测是机制回归（查询取条款原文开头 28 字），
不能回答「用户这么问，能不能找到」。0.27 交付 60 条人工问题与 A/B/C 三组对比，
为 0.29 的混合检索/RRF 提供门槛依据。

## 2. 范围与非目标

### 2.1 本切片做

- **#1 检索 API**：`GET /kb/api/search`，参数 `kb/q/limit/offset/tag/type/trust`，
  返回文档级去重结果（`docId/title/standardNo/page/clause/snippet/terms/deepLink/trust`）。
- **#2 检索工作台**：顶层 `#/search` 页面 + 侧栏入口；库/标签/类型/可信度过滤、
  「加载更多」分页、安全关键词高亮、点击复用现有预览弹窗与深链。
- **#3 回归修复**：标准号查询一律走精确正则路径（`expandStdQuery`），保持 `GB ≠ GB/T`。
- **#4 人工评测**：60 题（条款定位 20 / 跨文档 15 / 数值限值 15 / 同义改写 10），
  A=当前 FTS、B=FTS+标准号/标签/trust boost、C=ripgrep 基线；产出
  `docs/specs/2026-10-27-retrieval-benchmark.md`（Recall@10、MRR@10、p95、坏例分析）。

### 2.2 非目标

- 不引入 embedding / 向量库 / rerank / RRF（0.29 才评估）。
- 不改 PDF viewer 与关键词高亮实现（0.26 的已知限制继续登记，见 §9）。
- 不改 `kb_query` / `kb_read` 的签名与语义；不改胶囊、范围、回收站、导入行为。
- 不做保存检索、检索历史、检索结果导出、排序切换（默认排序即 B 变体）。
- 不为检索新增原生依赖；`node:sqlite` 不可用时保持 ripgrep 回退。
- 不做 assistant 正文角标（宿主无非破坏性注解槽，沿用 0.26 结论）。

## 3. 现状与关键事实

### 3.1 可复用的东西

| 能力 | 位置 | 说明 |
|---|---|---|
| 引擎选择与回退 | `lib/query.js` `searchKb()` | 纯文本优先 FTS5，正则/索引不可用/无命中回退 ripgrep |
| FTS 索引 | `lib/fts-index.js` | `searchFtsIndex()` 返回 clause 级命中（含 page/clause/trust） |
| 非纯文本判定 | `lib/query.js` `plainFtsQuery()` | 决定是否让 FTS 参与 |
| 标准号归一 | `lib/query.js` `expandStdQuery()` | `GB/T=GBT=GB_T=GB∕T`，年份分隔符兼容 |
| 排序（rg） | `lib/query.js` `rankMatches()` | 标题/标题行/命中数/新近度/trust |
| 来源结构 | `lib/sources.js` | `deepLinkFor` / `snippetOf` / `keywordsOfQuery` / `dedupeSources` |
| 预览与深链 | `ui/views/modals.js` `openPreviewModal`、`ui/deep-link.js` | 工作台已可 `?kb=&doc=&page=&clause=` 打开预览 |
| 文档投影 | `lib/web/data.js` `listDocs/readDoc` | tag/type/trust/standardNo 字段齐备 |

### 3.2 真实库事实（只读核对，2026-10-26）

- 7 个活跃库 / 1566 篇：标准 911、变电试验 310、历史 157、电能质量 132、电气工程教材 37、
  电气一次 11、电气二次 8。
- 只有「标准」有 `.index/fts.sqlite`（224MB）与结构化标准号（850）、标签（871）；
  其余 6 库 `standardNo=0`、`tags=0`、无索引 → 跨库检索会触发这些库的后台建索引（派生数据）。
- `node:sqlite` 在桌面/CLI 宿主可用；CI unit job 用 Node 22（`node:sqlite` ≥22.5）。

### 3.3 已知回归（本轮修）

`plainFtsQuery()` 用一条手写正则识别标准号，只覆盖 `GB 1234`、`Q/GDW 651` 等少数形态：

```
GB 1234            -> ripgrep（正确）
GB/T 1234          -> FTS（错误）      GBT 1234   -> FTS（错误）
GB_T 1234          -> FTS（错误）      DL/T 587   -> FTS（错误）
GB/T 19963.2-2024  -> FTS（错误）
```

走 FTS 后 `tokenizeForFts` 会把查询拆成 `["gb","14549","gb/t","gbt"]` 并以 **OR** 连接，
`gb` 这个 token 命中几乎所有标准，"GB 与 GB/T 区分" 彻底失效。真实库实测
`GB/T 14549` 的 FTS top10 全部是无关标准（`DL/T 1344-2014`、`Q/GDW 10650.8-2021`…），
目标文档一篇未进；同一查询走 ripgrep（0.25 路径）可精确命中。

**修法**：`plainFtsQuery` 是否参与 FTS 的判据改为 `expandStdQuery(pattern) === null`，
即「能被标准号归一器认出的查询一律走精确正则」。不新增第二套前缀表（`lib/standards.js`
的 `STD_PREFIXES` 已是唯一口径）。

## 4. #1 检索 API

### 4.1 路由与参数

`GET /kb/api/search`（只读、走现有信任围栏；GET 不要求 `x-kb-ui`）

| 参数 | 规则 | 失败 |
|---|---|---|
| `q` | 必填；trim 后 1–200 字 | `400 SEARCH_EMPTY` |
| `kb` | 单库名；省略 / `*` / `all` = 全部活跃库（跳过归档、已合并、空库） | 未知 `404 KB_NOT_FOUND` |
| `limit` | 1–50，默认 20（越界夹取，不报错） | — |
| `offset` | ≥0，默认 0，上限 5000（夹取） | — |
| `tag` | 单标签精确匹配（与 `GET /docs?tag=` 同口径，区分大小写） | 空值等同不过滤 |
| `type` | `doc.type` 精确匹配（`pdf-text`/`pdf-scanned`/`pdf-mixed`/`docx`/`xlsx`/`text`/`markdown`/`note`…） | — |
| `trust` | `high`/`medium`/`low`/`unknown` | 其他值 `400 INVALID_ARGS` |

### 4.2 响应

```json
{
  "q": "风电场电压偏差",
  "kb": "",
  "kbs": ["标准"],
  "terms": ["风电场", "电压偏差"],
  "engine": "fts",
  "indexBuilding": false,
  "note": "",
  "total": 12,
  "estimated": true,
  "offset": 0,
  "limit": 20,
  "tookMs": 34,
  "facets": {
    "tags": [{ "name": "新能源", "count": 7 }],
    "types": [{ "name": "pdf-text", "count": 9 }],
    "trust": [{ "name": "high", "count": 11 }]
  },
  "results": [
    {
      "kb": "标准",
      "docId": "578d43c2bc85",
      "title": "GB/T 19963.2-2024 风电场接入电力系统技术规定 第2部分：海上风电",
      "standardNo": "GB/T 19963.2-2024",
      "page": 12,
      "clause": "5.2.2",
      "snippet": "…公共连接点电压偏差应不超过…",
      "terms": ["风电场", "电压偏差"],
      "trust": "high",
      "type": "pdf-text",
      "tags": ["新能源", "并网"],
      "hits": 3,
      "deepLink": "/kb/?kb=%E6%A0%87%E5%87%86&doc=578d43c2bc85&page=12&clause=5.2.2"
    }
  ]
}
```

字段口径：

- `engine`：`fts`（全部库都走了索引）/ `rg`（全部回退）/ `mixed`（部分库回退）。
- `indexBuilding`：至少一个参与检索的库正在后台建索引（本次结果来自 ripgrep）。
- `note`：构建中/截断/单库失败等提示；为空串时不显示。
- `total`：过滤后**文档数**（不是命中条款数）。ripgrep 路径无法精确计数，`estimated=true`。
- `facets`：在过滤 **之前** 由命中文档统计，按 count 降序、name 升序，最多 20 项；
  用于「当前结果里有哪些标签/类型/可信度」。ripgrep 路径的 facets 同样带 `estimated` 语义（近似）。
- `page`/`clause`：来自该文档排名最高的命中；旧文档没有 `parts/index.json` 时允许 `null`
  （`page` 省略，`clause` 省略），前端显示「无页码」。
- `snippet`：围绕最早命中的检索词取 160 字窗口（找不到命中取开头 160 字），去换行、去注释块。
- `terms`：`keywordsOfQuery(q)` 的结果（≤8 个，长度 ≥2，停用词过滤），顶层与每条结果各一份，
  供 UI 高亮与 viewer 使用。
- `deepLink`：相对 `/kb/` URL，`page` 缺失时不带 `page`，`clause` 做 URL 编码。
- 响应**不含**绝对路径、库目录名以外的文件系统信息。

### 4.3 检索与排序

1. **目标库解析**：`kb` 单库 → 校验存在（不存在的库返回 404，不静默跳过）；
   `*`/`all`/空 → `listKbs()` 过滤掉 `mergedInto` 的库，逐库 `tryReadManifest`，读不到就跳过。
2. **单库检索**：`searchKb(ctxShim, execShim, kbDir, manifest, { pattern, ftsPattern, maxMatches, backgroundIndex: true })`
   - `ctxShim.subprocess.spawn` 来自 `opts.spawn`（`lib/web/server.js` 已注入 `ctx.subprocess.spawn`）；
   - `execShim.signal` 由请求 `close` 触发的 `AbortController` 提供；
   - `maxMatches = clamp(limit × 8, 200, 500)`，带过滤时 ×3（避免过滤把结果吃空）；
   - 单库失败（含 rg 启动失败）不抛 500：记 `note`，继续其他库。
3. **文档级归并**：按 `(kb, docId)` 分组，组内取引擎序第一条为 best hit，`hits` 记条数；
   `title/standardNo/trust/type/tags` 取自 manifest 投影（不是 markdown）。
4. **过滤**：`tag`/`type`/`trust` 在归并后按 manifest 字段过滤（不进 FTS 查询，避免 SQL 注入面）。
5. **排序（B 变体，产品默认）**：

   ```
   base  = 1 / (1 + engineRank)                      // 引擎序，0.5 → ~0
   boost = 3.0 × 标题命中项比例
         + 4.0 × 标准号命中（整号/前缀匹配，命中整号给满分）
         + 1.0 × 标签命中（任一检索词等于某个标签）
         + trust{high:1.0, medium:0.5, unknown:0, low:-0.5}
         + 0.3 × 新近度（0–1，365 天线性衰减）
   score = base + boost
   ```

   `A 变体`（仅评测脚本使用）= 关闭 boost，纯引擎序。并列时按 `(kb, title)` 稳定排序。
6. **分页**：对归并排序后的文档数组切片；`offset + limit > 5000` 时夹取到上限并在 `note` 提示。

### 4.4 错误与降级

| 场景 | 行为 |
|---|---|
| `q` 为空/超长 | `400 SEARCH_EMPTY` / `400 INVALID_ARGS` |
| `kb` 不存在 | `404 KB_NOT_FOUND`（文案「知识库不存在」） |
| `trust` 非法 | `400 INVALID_ARGS` |
| 需要 ripgrep 但 `opts.spawn` 缺失 | `503 SEARCH_UNAVAILABLE`（文案「检索进程不可用」） |
| FTS 索引不可用/过期 | `searchKb` 内部回退 ripgrep；大库后台构建，本次返回 rg 结果 + `indexBuilding` |
| 单库抛错 | 跳过该库，`note` 记录库名（不带路径），其余库正常返回 |
| 请求中断 | `AbortController` 取消 rg；不写响应 |

## 5. #2 工作台检索页

### 5.1 路由

| Hash | 页面 |
|---|---|
| `#/search` | 检索页（空态：显示检索框与「试试：电压偏差 / 谐波电流」示例） |
| `#/search?q=…&kb=…&tag=…&type=…&trust=…` | 带条件检索；刷新/后退可复现 |

- `ui/router.js` 的 `parseHash` 增加 `search` 分支，返回 `{ page: "search", query }`；
- 新增 `hrefForSearch(params)`：跳过空值参数，`q` 放最后（保持短 URL 可读）；
- 输入框防抖只更新 `state.search`，**不写 hash**；应用检索（防抖结束/Enter/过滤变更）后用
  `history.replaceState` 同步 hash，避免 `hashchange` 二次请求；
- 用户点侧栏「全文搜索」或外部深链进入时走 `hashchange` → 从 hash 读条件。

### 5.2 页面结构

```
工具条：[搜索框                              ] [库▾] [标签▾] [类型▾] [可信度▾] [清除]
状态行：命中 12 篇 · FTS · 34ms            （构建中时追加「索引构建中，本次回退全文检索」）
结果卡片（每篇一条）：
  标题（点击 = 打开原件预览）            [库名] [可信度徽标]
  标准号 · 第 5.2.2 条 · 第 12 页
  摘要（命中词 <mark> 高亮，安全文本节点）
  [打开原件]  ← 与标题同一动作；不新增全屏工作台
底部：[加载更多（还有 N 篇）] 或「已全部显示」
```

### 5.3 状态与交互

- `state.search = { q, appliedQ, kb, tag, type, trust, results, total, offset, limit,
  terms, engine, indexBuilding, note, loading, loadingMore, error, token }`。
- 输入框 300ms 防抖 + Enter 立即 + `composition` 期间不发请求（与资料页/回收站同一套写法）；
- **旧响应作废**：每次请求领 token（复用 `createRequestGate`），条件变化后旧响应直接丢弃；
- 过滤变更 → offset 归 0、结果整体替换；「加载更多」→ offset += limit 并**追加**，
  同一 `(kb, docId)` 不重复追加；
- 空态三分：未输入（示例词）、无结果（`没有匹配「…」的资料` + 清除条件）、错误（错误文案 + 重试）；
- 焦点恢复：重绘后输入框聚焦并把光标放回末尾（不抢其他输入）；
- 可访问性：过滤控件带 `aria-label`，状态行 `aria-live="polite"`，卡片标题是 `<button>`。

### 5.4 安全高亮（硬要求）

**禁止** 把 snippet 拼进 HTML 字符串。实现分两步：

1. 渲染阶段只输出容器：`<p class="snippet" data-hl="3"></p>`（不含任何命中内容）；
2. 挂载后 `applyHighlights(root, results, terms)`：
   - `highlightSegments(text, terms)` 纯函数把文本切成 `[{text, hit}]`（大小写不敏感，
     重叠命中取最长，非法正则字符按字面处理）；
   - 用 `document.createTextNode` + `document.createElement("mark")` 逐段 append，
     不使用 `innerHTML`；
   - `terms` 为空或文本为空时整段一个文本节点。

标题/标准号/库名/条款等仍走现有 `escapeHtml`。单测必须包含「标题与摘要里出现
`<img src=x onerror=alert(1)>` 时渲染结果里没有可执行 HTML」。

### 5.5 复用预览与深链

- 点卡片标题或「打开原件」→ `openPreviewModal({ name: kb, doc, icons, initialPage: page })`
  （先 `api.doc(kb, docId)`，失败 toast「资料不存在或已删除」）；
- 卡片同时是 `<a href={result.deepLink}>`（新标签打开），便于「在新标签打开工作台」与
  外部复制链接；点击时 `preventDefault` 走弹窗；
- 不改 `renderPreviewBody` / viewer / 高亮（PDF 原生 iframe 的已知限制沿用 0.26 记录）。

## 6. 数据流与模块划分

```
ui/app.js (#/search 路由)
  └─ ui/views/search.js        渲染（纯字符串，escapeHtml）
  └─ ui/search-core.js         纯函数：searchParamsOf / highlightSegments / applyHighlights / 选项表
  └─ ui/api.js  search()  ─────► GET /kb/api/search
                                  └─ lib/web/api.js（参数校验 + 目标库解析 + Abort）
                                       └─ lib/search.js（归并/过滤/排序/facets/分页；纯函数 + orchestrate）
                                            └─ lib/query.js searchKb（FTS5 → ripgrep 回退）
                                                 └─ lib/fts-index.js / rg
```

- `lib/search.js` 不读 HTTP、不读 DOM：输入 manifest 投影 + 匹配列表，输出响应对象；
  `searcher` 作为依赖注入，便于单测与评测复用同一套排序。
- 评测脚本直接 `import { rankResults, scoreResult } from lib/search.js`（B 变体 = boost 开），
  A 变体 = 同函数 `boost:false`，保证「测的就是产品代码」。

## 7. 测试计划

| 层 | 文件 | 要点 |
|---|---|---|
| 路由判定 | `test/query-routing.test.mjs`（新） | `GB/T`/`GBT`/`GB_T`/`GB∕T`/`DL/T`/`Q/GDW`/`T/CEC`/带部分号/带年份 → 不走 FTS；中文/正则 → 走 FTS |
| 核心 | `test/search-core.test.mjs`（新） | 文档级去重、best hit、snippet 窗口、boost 各项、boost off 保序、三类过滤、分页、facets、estimated |
| API | `test/web-search.test.mjs`（新） | 双路径（无 sqlite skip）、GB≠GB/T 端到端、跨库 `*`、过滤、400/404/503、limit/offset 夹取、响应无绝对路径、deleted/archived 排除 |
| UI 渲染 | `test/ui-search.test.mjs`（新） | 卡片字段、深链 href、空/错/加载态、转义、`highlightSegments` 与 `applyHighlights`（fake document） |
| UI 交互 | `test/ui-search-controls.test.mjs`（新） | 防抖/IME/Enter/焦点/旧响应作废/过滤重置 offset/加载更多追加 |
| 路由与客户端 | `test/ui-router.test.mjs`、`test/ui-api.test.mjs`（改） | `#/search` 解析、`hrefForSearch`、URL 编码 |
| E2E | `scripts/e2e/tests/search.mjs`（新） | API 断言 + UI（高亮 `<mark>`、过滤、加载更多）+ 深链打开预览 |
| 评测集 | `test/eval-dataset.test.mjs`（新） | 60 题、分组 20/15/15/10、id 唯一、expected 字段齐 |

约束：全部使用临时 `kbRoot`；真实库只读；不新增原生依赖。

## 8. #4 人工评测设计

### 8.1 数据集

`scripts/eval/questions-2026-10-27.jsonl`，每行：

```json
{"id":"Q01","group":"clause","q":"风电场公共连接点电压偏差的允许值是多少",
 "expected":[{"kb":"标准","docId":"…","title":"…","page":12,"clause":"5.2.2"}],
 "note":"依据：第 5.2.2 条 表 3"}
```

- 分组：`clause` 20（条款定位）、`multi-doc` 15（跨文档，expected 2–3 篇）、
  `numeric` 15（数值/限值）、`paraphrase` 10（同义改写，问题用同义词不复述原文）。
- 语料：真实「标准」库（唯一有条款索引的库）。只读：`DatabaseSync(..., {readOnly:true})` +
  打包的 ripgrep。
- 校验：`--validate` 核对 expected docId 存在、`page ≤ doc.pages`、
  clause 文本出现在该页（best-effort），失败列出不阻断出报告但计入「数据问题」。

### 8.2 变体与指标

| 变体 | 实现 |
|---|---|
| A 当前 FTS | `searchFtsIndex` + 文档级归并，纯 bm25 序 |
| B FTS + boost | `lib/search.js` `rankResults({ boost: true })`（标准号/标签/trust/标题/新近度） |
| C ripgrep 基线 | `expandStdQuery`/原样 pattern → `parseRgOutput` + `rankMatches` |

指标：Doc Recall@10（多文档题按命中比例）、Page Recall@10、MRR@10（doc 级，附 Page-MRR）、
p95 与平均延迟（预热后，不含索引构建）。报告含三变体总表 + 每变体逐题排名 + 坏例分析
（分词错切/OR 稀释/页码缺失/同号多版本/标题无标准号/跨库排序）。

### 8.3 结论门槛（供 0.29 使用）

- B 相对 A：Doc Recall@10 +5pp 或 MRR +0.05，且 p95 < 200ms → 0.27 默认启用 B（本轮已启用）；
- C 只作为「有无索引」对照：若 B 在数值/条款题上不优于 C，需在报告里解释而不是掩盖；
- 0.29 是否引入 embedding：看 A/B 在 `paraphrase` 组的绝对水平与坏例类型。

## 9. 已知限制（本轮登记，不修）

1. **PDF viewer/高亮沿用 0.26 限制**：`viewer.html` 只服务聊天来源面板，工作台预览仍是原生
   PDF iframe（WebKit 可能下载/空白）；扫描件 PDF 无文字层 → 高亮静默为 0；无单测覆盖。
   0.27 的检索结果因此不承诺「打开即高亮」，只在卡片里显示命中摘要。
2. **FTS token OR 语义**：多词查询精度靠 bm25 与 boost，不做 AND/phrase 改造（坏例进报告）。
3. **跨库首查建索引**：其余 6 库无索引，首次跨库搜索会后台构建（派生数据写入 `<kb>/.index`），
   本次请求回退 ripgrep 并在状态行提示。
4. **只对「标准」有标准号/标签元数据**：其他库的 `tag`/`type` 过滤只有 `type`/`trust` 有效。
5. 标准号查询走 ripgrep，页码/条款依赖 `parts/index.json`；个别旧文档没有页码数据时不带
   `page`（深链只到文档），条款索引路径才有页码。真实库冒烟：`GB/T 14549` 首条命中
   `GB/T 14549-1993`，该文档当前无页码。
6. 检索无排序切换、无检索历史、无结果导出。
6. `total` 在 ripgrep 路径是估计值（`estimated=true`）。

## 10. 兼容性与版本

- 新路由 additive：不改任何既有 API 字段；`kb_query`/`kb_read` 不变。
- 前端新页面 additive：不改资料页/回收站/胶囊；`lib/client.js`（插件客户端 bundle）不动，
  `check:client` 不受影响。
- 版本 0.27.0；README 增加 `## 0.27.0` 与 `### 已知限制（0.27.0）`，并回填 0.26 段缺失的
  `### 已知限制（0.26.0）` 与测试计数（812 → 912）。
- 回滚：删掉 `/search` 路由与 `#/search` 分支即可，无数据迁移、无清单变更。

## 11. 实施记录（2026-10-26）

- 基线：0.26.0（`8a6a867`，未 push），`npm test` 912/912、E2E 10 passed / 1 skipped。
- 已完成：标准号路径回归修复（`shouldUseFts`）、`lib/search.js`、`GET /kb/api/search`、
  `#/search` 检索页（侧栏入口、过滤、加载更多、安全高亮、深链预览）、E2E 检索用例、
  60 题人工评测集与基准脚本、README/版本 0.27.0。
- 测试：`npm test` **985/985**（新增 `query-routing` 5、`query-fts` 标准号回归 1、`search-core` 20、
  `web-search` 11、`ui-search` 18、`ui-search-controls` 10、`ui-router` 2、`ui-api` 1、
  `eval-dataset` 4，其余为 0.26 已有用例）；`npm run typecheck` / `check:client` / `check-ui` 通过。
- E2E：新增「检索：标准号区分、关键词高亮、过滤与深链预览」，全量 **11 passed / 0 failed / 1 skipped**
  （skip 仍是来源面板在 CLI 0.1.x 的历史投影问题）。新增独立夹具库「检索库」（3 篇，含
  `GB/T 1234-2020` 与 `GB 1234-2020` 同号不同前缀）；胶囊用例的「全选」断言改为按 `/kbs` 实际库数，
  避免新增夹具库后脆断。
- 评测（真实「标准」库 911 篇，只读）：A 当前 FTS Doc Recall@10 75.0% / MRR 0.466；
  B FTS + boost **83.3% / 0.608**（条款定位 MRR 0.674 → 0.875，同义改写 40% → 70%）。
  ripgrep 基线 C（整句当正则，0.25 默认）3.3%、C1（关键词 OR + 旧排序）1.7%：正则没有相关性
  排序，关键词一多标题命中在字母序上退化成噪声。p95：A/B 约 57ms，C 29ms，C1 250ms。
  细节与坏例见 `docs/specs/2026-10-27-retrieval-benchmark.md`。
- 只读约束：评测脚本用 `DatabaseSync(..., { readOnly: true })` 打开真实索引，ripgrep 只扫
  `markdown/`；没有改清单、没重跑导入、没删除资料；0.27 的 API/UI 测试全部用临时 `kbRoot`。
- 未做（按计划）：embedding/向量/rerank/RRF、检索历史、保存检索、排序切换、结果导出、
  assistant 正文角标、PDF viewer 与高亮改造（沿用 0.26 已知限制）。
