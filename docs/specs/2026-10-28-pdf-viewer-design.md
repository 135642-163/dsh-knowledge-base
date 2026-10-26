# 知识库 0.28：PDF viewer 与关键词高亮收口设计

> 状态：用户 2026-10-26 明确「PDF viewer 与关键词高亮实现可以继续做」，按 0.27 说明的默认取舍实施
> （工作台预览切 viewer；扫描件只提示并定位页码；页缓存放内存与系统临时目录；0.27 检索 API/排序不改）。
> 基线：`dsh-knowledge-wiki` 0.27.0（`3e9e37a`），`npm test` 985/985、E2E 11 passed / 1 skipped。
> 关联：`2026-10-27-search-workbench-design.md`（检索结果与深链）、
> `2026-10-25-kb-metadata-ingest-sources-design.md` §7（sources/深链/viewer 初版）。

## 1. 要解决的问题

0.26 引入的服务端 viewer（逐页 PNG + 关键词高亮）只服务聊天来源面板，并留有五处已知问题：

1. **显式页码被顶掉**：只要文档里有命中，初始页一律跳到「命中最多的一页」，来源卡/深链里的
   `page` 失效。
2. **命中计数不实**：每页最多渲染 240 个高亮框，超出静默截断，但顶部 `高亮 N 处` 仍在累加。
3. **扫描件静默 0 高亮**：原件没有文字层时 `page.search()` 返回空，页面没有任何解释。
4. **工作台预览没换**：工作台 PDF 仍是 `source?inline=1` 原生 iframe（WebKit 可能下载/空白），
   viewer 只给聊天用；检索结果点了也不会高亮。
5. **每页图都重新渲染**：`/page.png` 每次请求都读整份 PDF + mupdf 渲染，翻页/回滚很慢；
   旋转按钮只转图片、不转高亮框，标记会错位。

## 2. 范围与非目标

### 2.1 本切片做

- **页码语义**：显式 `page` 优先；没有 `page` 时才用「命中最多的一页」；越界夹取到 `1..total`。
- **诚实计数**：`hits` = 实际渲染的高亮框数；触顶时返回 `truncated` 并在工具栏提示「仅高亮前 N 处」。
- **扫描件降级**：`q` 非空但没有任何命中时给横幅：能确认没有文字层 → 「该原件没有文字层（扫描件），
  无法在页面上高亮；检索文字来自 OCR/解析文本」；否则 → 「未在原件中找到这些关键词」。
  另给「跳到首个命中」按钮（有命中且当前页没有命中时出现）。
- **服务端旋转**：`rotate=0|90|180|270` 同时作用于页图与高亮框（渲染矩阵同源，标记不再错位）。
- **工作台预览切 viewer**：`renderPreviewBody` 的 PDF 分支改用 `viewer.html?page=&q=`；
  `openPreviewModal` 新增 `terms`，`#/search` 点结果时把该结果的 `terms` 带过去。
- **页图缓存**：内存 LRU（64 页 / 32MB）+ `os.tmpdir()/dsh-kb-pages` 磁盘缓存（原子写、按 key 哈希、
  超过 800 个文件时按 mtime 清理），`/page.png` 命中时直接回 Buffer，响应带 `x-cache: hit|miss`。
- **测试**：`test/pdf-viewer.test.mjs`、`test/web-viewer.test.mjs`，以及 preview/deep-link/search 三个 E2E 的断言更新。

### 2.2 非目标

- 不改 `/kb/api/search` 的返回结构与排序；不改 `kb_query`/`kb_read`。
- 不做 PDF 文本层重建/OCR 叠加高亮（扫描件只能提示 + 页码定位）。
- 不做跨进程缓存/持久化缓存目录（`tmpdir` 清空即失效，属加速层）。
- 不改 Office 预览链路（仍走 `preview.pdf` + 引擎安装面板）。
- 不引入新依赖（mupdf 已是现有依赖）。

## 3. viewer 契约

`GET /kb/api/kbs/:name/docs/:id/viewer.html?page=&q=&rotate=`

| 参数 | 规则 |
|---|---|
| `page` | 可选正整数；缺省/非法 → 自动（有命中取命中最多的页，否则 1）；越界夹取 |
| `q` | `关键词1\|关键词2`，每个 trim 后 2–40 字，去重，最多 8 个 |
| `rotate` | `0/90/180/270`，非法回落 0 |

响应仍是自包含 HTML（CSP `default-src 'none'` + inline style/script），但新增：

- 工具栏 `高亮 N 处`（N = 实际渲染框数）；触顶时追加 `（仅前 240 处/页）`；
- 命中有、当前页无命中时出现 `首个命中` 按钮；
- 横幅（`#notice`）：无文字层 / 未找到关键词；
- 旋转按钮改为**重载** `viewer.html?rotate=…`（保持 page/q），页图与标记一起转。

`GET .../page.png?page=&dpi=&rotate=`：`dpi` 72–200 夹取，`rotate` 同上；命中缓存回 200 +
`x-cache: hit`，否则 `miss`。

## 4. 实现要点

- `lib/web/pdf-viewer.js`
  - 纯函数：`normalizeViewerTerms`、`clampViewerPage`、`normalizeRotate`、
    `resolveStartPage({ requested, total, pageHits })`、`transformQuad(quad, matrix, boundsBox)`。
  - `renderPdfViewerHtml({ pdfPath, title, page = null, terms, rotate = 0 })`：
    对每页 `toStructuredText` 抽样判断文字层（最多 3 页）、`search(term)` 取 quad、
    用与渲染同一个矩阵把 quad 投到旋转后的页面框里算百分比；
    返回 `{ html, total, hits, truncated, start, hasTextLayer, requestedPage }`。
- `lib/web/pdf-pages.js`（新）
  - `renderPdfPage({ pdfPath, page, dpi, rotate })`：读文件 → mupdf → PNG；
    key = `sha1(pdfPath|mtimeMs|size|page|dpi|rotate)`，先查内存、再查 tmpdir、最后渲染并回填；
    磁盘写用临时文件 + rename，清理 best-effort。
  - `pageCacheStats()` / `resetPageCache()` 供测试与观测。
- `lib/web/api.js`：两个路由改用上述模块；`viewer.html` 解析 `q/rotate`，`page` 缺省传 null；
  `page.png` 增加 `rotate`，缓存命中直接返回。
- `ui/api.js`：`viewerUrl(name, id, { page, terms, rotate })`；保留 `previewPdfUrl`（Office）。
- `ui/views/modals.js`：`renderPreviewBody` 的 `pdf` 分支用 `urls.viewer`（不再拼 `#page`），
  office 分支不变；`openPreviewModal` 接受 `terms`，PDF 的 iframe 用 viewer URL。
- `ui/app.js`：`openSearchResult` 透传结果级 `terms`；卡片带 `data-search-index` 以便取 terms。
- `src/client/index.tsx`：没有页码时不再硬塞 `page=1`（让 viewer 自动落到命中页），其余不动；
  重新构建 `lib/client.js`。

## 5. 测试计划

| 层 | 文件 | 要点 |
|---|---|---|
| viewer 纯函数/HTML | `test/pdf-viewer.test.mjs`（新） | 词归一、页码夹取、显式页码优先、旋转坐标、命中计数与触顶、无文字层横幅、转义 |
| 路由/缓存 | `test/web-viewer.test.mjs`（新） | viewer.html 200/CSP/参数、page.png PNG + `x-cache`、rotate 改变尺寸、缓存命中、无文字层 PDF、非 PDF 415 |
| 预览纯函数 | `test/ui-preview.test.mjs`（改） | PDF 用 viewer URL、带 q、office 不变、转义 |
| E2E | `scripts/e2e/tests/{preview,deep-link,search}.mjs`（改） | 工作台 PDF → viewer iframe；深链 page/越界/缺省；检索结果 → viewer + `.hl` 可见 |

## 6. 已知限制（本轮登记）

- 扫描件/无文字层的原件**无法在页面上高亮**，只做提示与页码定位（OCR 文字在 markdown 侧）。
- 高亮框仍限制每页 240 个（现在会如实提示截断），极长文档不做虚拟滚动。
- 页缓存是加速层：内存 64 页、磁盘最多 800 个文件；`tmpdir` 被系统清理后重新渲染。
- 旋转以 90° 为步进且整页重载（不做动画）；印刷体竖排/特殊旋转页面靠 `rotate` 参数手动校正。
- Office 预览仍用 `preview.pdf`，不享受 viewer 的高亮。

## 7. 兼容性与版本

- 新增参数全部可选；旧链接（无 `q`/`rotate`）行为只是更准确（不再无故跳页）。
- 工作台预览切 viewer 改变了一个可视行为（原生 iframe → 逐页 viewer）；E2E 断言同步更新。
- `/kb/api/search` 与排序、`kb_query` 输出、胶囊/范围/回收站均不变。
- 版本 0.28.0；README 增加 `## 0.28.0` 与 `### 已知限制（0.28.0）`。

## 8. 实施记录（2026-10-26）

- 基线：0.27.0（`3e9e37a`），`npm test` 985/985、E2E 11 passed / 1 skipped。
- 已完成：viewer 页码语义（显式优先/自动命中页/夹取）、旋转矩阵与高亮同源、命中计数与 240 截断提示、
  扫描件/未命中横幅、首个命中按钮、参数校验；`page.png` 内存 LRU + `tmpdir` 磁盘缓存 + `x-cache`；
  工作台 PDF 预览切 viewer、检索结果透传 `terms`、客户端无页码不再硬塞 `page=1`。
- 测试：`npm test` **1011/1011**（新增 `pdf-viewer` 14、`web-viewer` 9，`ui-preview`/`ui-api` 各 +2 改写）；
  `typecheck` / `check:client`（重建 `lib/client.js`）/ `check-ui` 通过；E2E **11 passed / 0 failed / 1 skipped**
  （preview、deep-link、search 三处断言已切到 viewer 并验证 `.hl` 可见）。
- 真实库只读冒烟：`GB/T 12325-2008`（扫描件）显示「没有文字层」横幅、8 页；`GB 14549-2011 编制说明`
  182 处命中、自动落第 13 页；`/page.png` 首帧 `miss`、再次 `hit`（216582 / 152580 字节一致）。
- 未做（按计划）：跨进程/持久缓存、虚拟滚动、按需搜索、Office 预览切 viewer、扫描件页内高亮。
