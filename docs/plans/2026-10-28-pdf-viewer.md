# 知识库 0.28 PDF viewer 与关键词高亮实施计划

> 先读 `docs/specs/2026-10-28-pdf-viewer-design.md`。用户已确认默认取舍（工作台预览切 viewer、
> 扫描件只提示、页缓存放内存与 tmpdir、0.27 检索 API 不改）。逐任务 TDD，不 push。
>
> **执行状态（2026-10-26）：** Task 1–5 全部完成。`npm test` **1011/1011**、`typecheck`/`check:client`/
> `check-ui` 通过、E2E **11 passed / 1 skipped**；真实库只读冒烟通过（扫描件横幅、命中计数、缓存命中）。
> 版本 0.28.0；未 push。

**Goal:** viewer 的页码/计数/旋转/扫描件行为可信，工作台 PDF 预览切到 viewer 并能从检索结果带关键词高亮，
页图有缓存不再每次重渲染。

**Architecture:** `lib/web/pdf-viewer.js` 出纯函数 + 服务端 HTML；`lib/web/pdf-pages.js` 管页图与缓存；
`ui/views/modals.js` 只换 PDF 分支的 URL；E2E 三个用例更新断言。

## 文件结构

```text
lib/web/pdf-viewer.js      改：normalize/clamp/rotate/resolveStartPage/transformQuad，命中计数、横幅、旋转
lib/web/pdf-pages.js       新：renderPdfPage + 内存 LRU + tmpdir 磁盘缓存 + stats/reset
lib/web/api.js             改：viewer.html 解析 q/rotate/page(null)、page.png 用缓存与 rotate
ui/api.js                  改：viewerUrl(name,id,{page,terms,rotate})
ui/views/modals.js         改：renderPreviewBody pdf 分支用 viewer；openPreviewModal 收 terms
ui/app.js                  改：检索结果透传 terms + data-search-index
ui/views/search.js         改：卡片带 data-search-index
src/client/index.tsx       改：无页码不硬塞 page=1；重建 lib/client.js
test/pdf-viewer.test.mjs   新
test/web-viewer.test.mjs   新
test/ui-preview.test.mjs   改
scripts/e2e/tests/preview.mjs / deep-link.mjs / search.mjs  改
README.md / docs/specs / package.json / package-lock.json / lib/version.js  改
```

## Task 1: viewer 纯函数 + 渲染（先写测试）

- [ ] `test/pdf-viewer.test.mjs`：
  - `normalizeViewerTerms("电压|电压| 谐波 |a|")` → `["电压","谐波"]`（去重、2–40 字、≤8 个）；
  - `clampViewerPage(0,10)=1`、`(99,10)=10`、`(5,10)=5`、`("x",10)=1`；
  - `normalizeRotate(90)=90`、`(45)=0`、`(-90)=270`、`("270")=270`；
  - `resolveStartPage({ requested: 7, total: 20, pageHits: new Map([[3,5]]) })` → 7（显式优先）；
    `requested: null` + pageHits → 3；都没有 → 1；
  - `transformQuad` 对 rotate 0/90 的百分比与手算一致（用固定 bounds）；
  - 用真实 tiny PDF（Helvetica 文本）跑 `renderPdfViewerHtml`：`hits>0`、HTML 含 `<span class="hl"`、
    `start` 等于显式 page、无横幅；
  - 用无文字层 PDF（只画矩形）跑：`hits=0`、`hasTextLayer=false`、HTML 含「没有文字层」横幅；
  - 标题/词里的 `<img onerror>` 被转义。
- [ ] 实现 `lib/web/pdf-viewer.js` 的纯函数与 `renderPdfViewerHtml`（含旋转矩阵、抽样文字层、
  命中计数、`truncated`、「首个命中」按钮、旋转按钮重载）。
- [ ] `node --test test/pdf-viewer.test.mjs`

## Task 2: 页图与缓存

- [ ] `test/web-viewer.test.mjs`：
  - `GET viewer.html?page=999&q=电压|电压&rotate=90` → 200、CSP 头、HTML 里都是夹取后的参数；
  - `GET page.png?page=1` → `image/png` + `x-cache: miss`，第二次 → `x-cache: hit`；
  - `page.png?rotate=90` 的 PNG 宽高与 0° 互换（读 IHDR）；
  - 无文字层 PDF 的 viewer.html 带横幅；非 PDF/office 源 → 415。
- [ ] 实现 `lib/web/pdf-pages.js`（内存 LRU + tmpdir 磁盘、原子写、清理）并接入 `api.js`。
- [ ] `node --test test/web-viewer.test.mjs`

## Task 3: 工作台预览切 viewer

- [ ] `test/ui-preview.test.mjs`：`renderPreviewBody({kind:"pdf", urls:{ viewer }})` 用 viewer URL；
      office 仍用 `preview.pdf` + `#page`；URL 参数带 `q`；HTML 转义。
- [ ] `ui/api.js` 加 `viewerUrl`；`modals.js` 改 PDF 分支 + `terms`；`app.js`/`views/search.js` 透传 terms。
- [ ] `src/client/index.tsx` 去掉无页码时的 `page=1`，`npm run build:client`。
- [ ] `node --test test/ui-preview.test.mjs test/ui-search.test.mjs test/sources-client.test.mjs` + `npm run check:client`。

## Task 4: E2E

- [ ] `preview.mjs`：PDF iframe → `/viewer.html`，不再断言 `source?inline=1`；
      点击后能看到 viewer 的 `.page`/工具栏。
- [ ] `deep-link.mjs`：`page=1` → viewer URL 含 `page=1`；`page=999` → 夹到 1；
      无 page → URL 不含 page（自动落命中页）。
- [ ] `search.mjs`：点结果 → viewer iframe 含 `q=` 与 `page=`，且 iframe 内 `.hl` 数量 > 0。
- [ ] `npm run test:e2e`

## Task 5: 文档/版本/验收

- [ ] README `## 0.28.0` + `### 已知限制（0.28.0）`；版本 0.28.0（三处）。
- [ ] design 追加实施记录；`npm test` / `typecheck` / `check:client` / E2E 全绿；报告 diff，不 push。

## 验收清单

- [ ] 显式页码优先，越界夹取；无 page 才落命中页。
- [ ] `hits` 与实际渲染框数一致，触顶有提示。
- [ ] 无文字层 PDF 有横幅；有命中但当前页无命中时有「首个命中」。
- [ ] 旋转 90/180/270 后页图与高亮框对齐（同一渲染矩阵）。
- [ ] 工作台 PDF 预览走 viewer；检索结果点开带关键词高亮。
- [ ] `/page.png` 二次请求命中缓存（`x-cache: hit`）。
- [ ] 0.27 检索 API/排序与 `kb_query` 输出不变；全门禁绿；真实库只读；不 push。
