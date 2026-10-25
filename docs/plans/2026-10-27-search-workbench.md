# 知识库 0.27 检索工作台实施计划

> **给执行者：** 先读 `docs/specs/2026-10-27-search-workbench-design.md`（尤其是 §3.3 回归、§4 API 契约、§5.4 安全高亮）。
> 用户已确认：0.26 先本地 commit（已完成，`8a6a867`，未 push）；标准号回归放进本切片 Task 1；
> 检索入口用顶层 `#/search` + 侧栏；搜索结果复用工作台现有预览弹窗（不动 viewer）。
> 执行方式：当前会话内逐任务 TDD；每个 Task 先写失败测试，结束跑该范围测试并报告；不 push/发布。
>
> **执行状态（2026-10-26）：** Task 1–7 全部完成。`npm test` **985/985**；`npm run typecheck` /
> `check:client` / `check-ui` 通过；E2E **11 passed / 0 failed / 1 skipped**（新增检索用例）。
> 60 题评测已产出：A 75.0% / B 83.3%（Doc Recall@10）、MRR 0.466 → 0.608，报告见
> `docs/specs/2026-10-27-retrieval-benchmark.md`。版本 0.27.0 已改，未 push。

**Goal:** 让工作台具备可用的全文检索（文档级结果、过滤、分页、安全高亮、深链预览），
并交付 60 条人工问题的 A/B/C 基准报告，作为 0.29 混合检索的决策依据。

**Architecture:** `lib/search.js` 承担「manifest 投影 + 匹配 → 文档级结果」的纯逻辑与排序；
`lib/web/api.js` 只做参数校验、目标库解析与请求生命周期；前端 `#/search` 复用 `ui/api.js`、
`ui/deep-link.js`、`ui/views/modals.js`（预览）；高亮只走 DOM 文本节点。

**Tech Stack:** Node.js ESM、`node:test`、`node:sqlite`（FTS5）、打包的 ripgrep、原生 DOM、
`ui/app.js` 模板字符串 + `escapeHtml`、Playwright E2E。

---

## 文件结构

```text
lib/search.js                 新：snippetAround / groupHitsByDoc / scoreResult / rankResults /
                                  buildSearchResponse / facetsOf / searchAll（searcher 可注入）
lib/query.js                  改：plainFtsQuery 改判据（expandStdQuery）、导出判定、抽 searchLibrary 薄封装
lib/web/api.js                改：GET /search 路由（校验、目标库、Abort、单库失败降级）
lib/web/data.js               改：导出 activeKbs/类型清单等投影辅助（避免复刻筛选口径）
ui/router.js                  改：#/search 解析 + hrefForSearch
ui/search-core.js             新：searchParamsOf / highlightSegments / applyHighlights / 选项表
ui/views/search.js            新：工具条、状态行、结果卡片、加载更多、空/错/加载态
ui/app.js                     改：state.search、loadSearch、路由分支、侧栏入口、hash 同步、绑定
ui/api.js                     改：search(params)
ui/style.css                  改：结果卡片与 <mark> 样式
scripts/e2e/seed.mjs          改：新增「检索库」夹具（标准号/条款/页码/标签/trust）
scripts/e2e/tests/search.mjs  新：API + UI + 深链
scripts/e2e/run.mjs           改：注册 search 用例
scripts/eval/questions-2026-10-27.jsonl  新：60 条人工问题
scripts/eval-benchmark.mjs    新：A/B/C 三变体评测与报告生成
test/query-routing.test.mjs   新
test/search-core.test.mjs     新
test/web-search.test.mjs      新
test/ui-search.test.mjs       新
test/ui-search-controls.test.mjs 新
test/eval-dataset.test.mjs    新
test/ui-router.test.mjs       改
test/ui-api.test.mjs          改
README.md / docs/specs / package.json / package-lock.json / lib/version.js  改
```

---

## Task 1: 标准号检索回归（先修，后续任务依赖）

**Files:** `lib/query.js`、`test/query-routing.test.mjs`（新）、`test/query-fts.test.mjs`（加例）

- [ ] **Step 1: 写失败测试**

```js
// test/query-routing.test.mjs
import { shouldUseFts } from "../lib/query.js";

test("标准号查询不走 FTS（GB ≠ GB/T）", () => {
  for (const q of ["GB 1234", "GB/T 1234", "GBT 1234", "GB_T 1234", "GB∕T 1234",
                   "GB/T 19963.2-2024", "DL/T 587", "DL/Z 460", "Q/GDW 10650.1",
                   "Q/GDW 651", "NB/T 31005", "T/CEC 123", "GB/Z 17625.3"]) {
    assert.equal(shouldUseFts(q), false, q);
  }
});
test("普通中文与正则仍走 FTS", () => {
  for (const q of ["电压偏差", "谐波电流", "GB/T \\d+", "电压|谐波"]) {
    assert.equal(shouldUseFts(q), true, q);
  }
});
```

- [ ] **Step 2: 跑测试确认失败** `node --test test/query-routing.test.mjs` → `shouldUseFts is not a function`

- [ ] **Step 3: 实现**

```js
/** 纯文本查询是否交给 FTS；标准号形态必须留给 expandStdQuery + ripgrep（GB ≠ GB/T）。 */
export function shouldUseFts(pattern) {
  const value = String(pattern ?? "");
  if (expandStdQuery(value) !== null) return false;
  // 用户显式写正则（或含元字符）时不进 FTS
  return !/[\\^$.*+?()[\]{}|]/.test(value);
}
```

`plainFtsQuery` 改为 `shouldUseFts` 的别名（内部调用），保持既有调用点不变。

- [ ] **Step 4: 加一条语义回归**（`test/query-fts.test.mjs`）：临时库里两篇文档
  （标题/正文分别 `GB 1234-2020` 与 `GB/T 1234-2020`），用真实 spawn 的 `ctx.subprocess` 薄封装：
  `searchKb(..., { pattern: "GB/T 1234" })` 只返回 `GB/T` 那份，`GB 1234` 只返回 `GB` 那份。

- [ ] **Step 5:** `node --test test/query-routing.test.mjs test/query-fts.test.mjs test/query.test.mjs test/query-normalize.test.mjs`

---

## Task 2: `lib/search.js`

**Files:** `lib/search.js`（新）、`test/search-core.test.mjs`（新）

- [ ] **Step 1: 写失败测试（节选）**

```js
test("同一文档只保留一条结果并记 hits", () => {
  const out = groupHitsByDoc([hit("d1", 3), hit("d1", 9), hit("d2", 1)]);
  assert.equal(out.length, 2);
  assert.equal(out[0].hits, 2);
  assert.equal(out[0].page, 3); // 取引擎序第一条
});
test("snippet 围绕最早命中词取窗口", () => {
  const text = "甲".repeat(120) + "电压偏差" + "乙".repeat(120);
  const snippet = snippetAround(text, ["电压偏差"], 40);
  assert.ok(snippet.includes("电压偏差"));
  assert.ok(snippet.length <= 40);
});
test("boost 打开时标准号命中排到前面，关闭时保持引擎序", () => { /* … */ });
test("tag/type/trust 过滤在归并后生效，facets 反映过滤前", () => { /* … */ });
test("分页与 total/estimated", () => { /* … */ });
```

- [ ] **Step 2: 跑测试确认失败** `node --test test/search-core.test.mjs`

- [ ] **Step 3: 实现**（纯函数，无 IO）

  - `normalizeSearchFilters({ tag, type, trust, limit, offset })`：夹取与清洗；
  - `matchesFilters(doc, filters)`；
  - `groupHitsByDoc(hits, { docs })`：`(kb, docId)` 分组、best hit、`hits`、投影 title/standardNo/trust/type/tags；
  - `snippetAround(text, terms, maxChars = 160)`；
  - `scoreResult(result, { terms, boost })`、`rankResults(results, { terms, boost })`；
  - `facetsOf(results)`；
  - `buildSearchResponse({ q, kb, kbs, terms, engine, indexBuilding, notes, results, filters, tookMs })`；
  - `searchAll({ kbRoot, kbs, searcher, query, filters })`：逐库 `searcher()`，收集 `engine/note`，
    单库异常转 `note` 不抛。

- [ ] **Step 4:** `node --test test/search-core.test.mjs`

---

## Task 3: `GET /kb/api/search`

**Files:** `lib/web/api.js`、`lib/web/data.js`、`test/web-search.test.mjs`（新）

- [ ] **Step 1: 写失败测试（节选）**

```js
test("GET /search 返回文档级结果与深链", async (t) => { /* temp kb + markdown → 断言字段 */ });
test("标准号查询保持 GB 与 GB/T 区分", async (t) => { /* 两篇同号不同前缀 */ });
test("tag/type/trust 过滤与 facets", async () => {});
test("kb=* 跨库、归档/合并/删除库与文档被排除", async () => {});
test("q 为空 400、未知库 404、trust 非法 400、需要 rg 但无 spawn 503", async () => {});
test("limit/offset 夹取、响应中没有绝对路径", async () => {});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

  - `api.js` 新增分支（放在 `/docs` 之前）：解析 `q/kb/limit/offset/tag/type/trust`；
  - `targetsOf(opts, kb)`：单库 `ensureKb`；`*`/空 → `listKbs()` 过滤 `mergedInto`；
  - `AbortController` 绑定 `req.on("close")`；`ctxShim = { subprocess: { spawn: opts.spawn } }`、
    `execShim = { signal }`；
  - `lib/search.js` `searchAll` + `buildSearchResponse`；`tookMs` 用 `performance.now()`；
  - `data.js` 暴露 `activeKbEntries(root)` 与 `docFilterProjection(doc)`（与 `listDocs` 同字段口径）。

- [ ] **Step 4:** `node --test test/web-search.test.mjs`；再跑 `test/web-doc-metadata.test.mjs`、`test/web-preview.test.mjs` 回归。

---

## Task 4: 前端 `#/search`

**Files:** `ui/router.js`、`ui/search-core.js`（新）、`ui/views/search.js`（新）、`ui/app.js`、`ui/api.js`、`ui/style.css`；测试 `test/ui-search.test.mjs`、`test/ui-search-controls.test.mjs`、`test/ui-router.test.mjs`、`test/ui-api.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
test("parseHash 认 #/search 与条件", () => {
  assert.deepEqual(parseHash("#/search?q=%E7%94%B5%E5%8E%8B&trust=high"),
    { page: "search", query: { q: "电压", trust: "high" } });
});
test("卡片渲染包含标准号/条款/页码且转义 HTML", () => {
  const html = renderSearch(stateWith({ title: "<img src=x onerror=1>" }), { icons, fmtNumber });
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("GB/T 19963.2-2024") && html.includes("第 12 页"));
});
test("highlightSegments 大小写不敏感、重叠取最长、无正则字符问题", () => {});
test("applyHighlights 只用文本节点与 mark（fake document）", () => {});
test("加载更多追加且不重复同一 (kb, docId)", () => {});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

  - `router.js`：`#/search` 分支 + `hrefForSearch({q,kb,tag,type,trust})`；
  - `search-core.js`：`searchParamsOf`、`highlightSegments`、`applyHighlights`（`doc.createTextNode` /
    `doc.createElement("mark")`，命中段落 `append`）、`SEARCH_TYPE_OPTIONS`、`SEARCH_TRUST_OPTIONS`、
    `searchStatusLine`、`hasMore`；
  - `views/search.js`：`renderSearch(state, { icons, fmtNumber })`；摘要容器
    `<p class="snippet" data-hl="<index>"></p>`；空态/错误态/加载态/「加载更多」；
  - `app.js`：`state.search`、`loadSearch({ reset })`（`createRequestGate` 作废旧响应）、
    `bind()` 里接输入框（300ms 防抖 + IME + Enter）、四个下拉、`[data-search-more]`、
    卡片点击（`openPreviewModal`）、侧栏「全文搜索」入口、`replaceState` 同步 hash；
  - `style.css`：卡片、`mark`、状态行、过滤条。

- [ ] **Step 4:** `node --test test/ui-search.test.mjs test/ui-search-controls.test.mjs test/ui-router.test.mjs test/ui-api.test.mjs`

---

## Task 5: E2E 检索用例

**Files:** `scripts/e2e/seed.mjs`、`scripts/e2e/tests/search.mjs`（新）、`scripts/e2e/run.mjs`

- [ ] **Step 1:** 夹具「检索库」：两篇 ready 文档
  - `GB/T 1234-2020 风电场电能质量技术规定`：3 页条款（`4.1 电压偏差…`、`4.2 谐波电流…`），
    tags `["检索","新能源"]`、`trust: "high"`；
  - `GB 1234-2020 风电场并网技术规定`：2 页条款，`trust: "medium"`，tag `["检索"]`。
  - 只新增独立库，不动「甲库」既有断言。
- [ ] **Step 2:** `tests/search.mjs` 三层断言
  1. API：`ctx.api.request("GET", "/search?q=电压偏差")` → 字段/深链/`total`；
     `q=GB/T 1234` 只含 GB/T 那篇（rg 路径）；
  2. UI：`#/search?q=电压偏差` → 卡片、`<mark>` 文本、状态行、库/标签/可信度过滤、
     `limit` 变小后「加载更多」追加；
  3. 深链：点卡片标题 → `.preview-modal` 打开且文本/页码符合预期；关闭后回到检索页。
- [ ] **Step 3:** `DSH_E2E_ONLY=检索 npm run test:e2e`，再全量。

---

## Task 6: 60 题人工评测

**Files:** `scripts/eval/questions-2026-10-27.jsonl`（新）、`scripts/eval-benchmark.mjs`（新）、
`test/eval-dataset.test.mjs`（新）、`docs/specs/2026-10-27-retrieval-benchmark.md`（产出）

- [ ] **Step 1:** 从真实「标准」库读只读索引，挑 60 条题目：
  - `clause` 20：条款定位（「风电场公共连接点电压偏差允许值」）；
  - `multi-doc` 15：跨文档（「谐波电流限值在哪些标准里规定」→ 2–3 篇）；
  - `numeric` 15：数值/限值（「10 kV 供电电压允许偏差」）；
  - `paraphrase` 10：同义改写（用「电压跌落」问「电压暂降」的条款）。
  - 每题的 expected 必须来自索引里的真实 `docId/page_start/clause`，并人工核对页码与条款。
- [ ] **Step 2:** `eval-benchmark.mjs`：三变体跑同一批题，输出上面约定的报告（含逐题表）；
  `--validate` 只校验数据集与真实库一致性。
- [ ] **Step 3:** `test/eval-dataset.test.mjs`：计数 20/15/15/10、id 唯一、字段与类型、无重复问题文本。
- [ ] **Step 4:** 跑一次填报告；坏例写清原因分类与结论。

---

## Task 7: 文档、版本、验收

**Files:** `README.md`、`package.json`、`package-lock.json`、`lib/version.js`、
`docs/specs/2026-10-27-search-workbench-design.md`（追加实施记录）

- [ ] **Step 1:** 版本 0.27.0（三处）。
- [ ] **Step 2:** README 增加 `## 0.27.0 检索工作台与人工评测` + `### 已知限制（0.27.0）`；
  回填 0.26 段 `### 已知限制（0.26.0）` 与测试计数（812 → 实际数）；测试清单补 0.26/0.27 新增覆盖。
- [ ] **Step 3:** spec 追加「实施记录」：真实库只读验收、E2E 结果、评测结论。
- [ ] **Step 4:** `npm test`、`npm run typecheck`、`npm run check:client`、`npm run test:e2e` 全绿。
- [ ] **Step 5:** 报告 `git diff --stat` 与测试输出；不 push、不发布。

---

## 验收清单

- [ ] `GET /kb/api/search` 支持 `kb/q/limit/offset/tag/type/trust`，返回文档级去重结果与深链。
- [ ] 标准号查询保持 `GB ≠ GB/T`（API 与 `kb_query` 两侧都有回归测试）。
- [ ] 高亮只用文本节点，`<img onerror>` 之类的标题/摘要不会变成可执行 HTML。
- [ ] `#/search` 可过滤、可加载更多、可打开预览；刷新/后退能复现同一组条件。
- [ ] E2E 覆盖 API + UI + 深链。
- [ ] 60 题报告产出（Recall@10、MRR@10、p95、坏例分析），数据集可复用。
- [ ] `npm test` / `typecheck` / `check:client` / E2E 全绿；真实库未被写入；不 push。
