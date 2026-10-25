# 知识库 0.26：资料元数据、摄取规范化与引用溯源设计

> 状态：已按用户 2026-10-25 的 6 项确认修订，待 spec review；review 通过后再写实施计划与代码。
> 基线：`dsh-knowledge-wiki` 0.25.0，`git c7d564e`，`npm test` **812/812**（本轮已复跑确认），
> `npm run typecheck` / `check:client` / `check:ui` 均为独立门禁。
> 关联：`2026-10-24-kb-workbench-slice2b-design.md`（2B/0.21–0.25 的既有契约）、
> `文件管理系统架构设计参考.md`（上传≠可用、解析状态机、引用字段、检索通道）、
> `karpathy-llm-wiki-obsidian-windows.md`（raw / wiki / schema 三层）。
> 本轮目标按用户给定顺序：**#1 摘要/标签编辑与标签筛选 → #2 上传/摄取规范化 → 0.26 引用与溯源 → #4 检索优化设计（只设计）**。
> 本文件只做设计，不含代码改动；已确认口径见 §12。

## 1. 背景与要解决的问题

0.25.0 已经把工作台、回收站、跨库移动、失败重试、真实宿主 E2E 做稳，但资料层仍有四类“知道有洞、还没收口”的问题：

1. **资料编目只能由模型改，人不能改。** `kb_describe` 能写摘要/标签，工作台资料弹窗只读展示；用户看到摘要不准只能回聊天里让模型改。资料页的搜索已经能搜标签，但没有“按标签筛选”。
2. **摄取管线只记了“文件哈希”，没有记“这份资料是什么”。** 新上传的 `DL/T587—2025+继电保护…` 已解析成功（19 页/19577 字/sourceHash 有值），但 `trust=unknown`、标题未规范化、没有标准号/年份/部分/阶段。旧文档 `sourceHash` 为空，导入查重只能按标题 key，导致 `GB 19963.2` 两份字节不同、标题不同的文件没有被拦下。
3. **上传成功被误读成解析完成。** 当前弹窗有 `uploaded → starting → importing → done` 状态机，但 `uploaded` 的标签是“已上传”，完成页的标题是“导入完成”，逐文件 skipped 固定写成“文档正在导入中”。上传只是“字节到了”，解析失败/重复跳过/仍在导入都可能在“完成”页里被读成成功。架构参考里的“上传 ≠ 可用”必须落到文案和状态机上。
4. **引用与溯源没有结构化出口。** `kb_query`/`kb_read` 只有文本渲染，没有 `sources`；工作台预览没有 `?doc=&page=` 深链；模型回答里的来源只能靠自然语言，不能点回原文。DSH 宿主是否允许自定义工具结果/助手消息渲染，需要先 spike 再决定做到哪一层。

## 2. 范围与非目标

### 2.1 本切片做

- **#1** `PATCH /kb/api/kbs/:name/docs/:id/metadata`：人工摘要/标签，`summarySource=manual`；
  资料页按标签筛选（`GET /docs?tag=` + 标签 facets）；资料弹窗可编辑；API/UI/E2E 测试。
- **#2** 摄取元数据：`rawTitle`、`canonicalTitle`、正文/封面优先的 `standardNo/Year/Part/Stage`、
  `sourceHash`、`textHash`、`trust` 启发式、`summarySource`、`trustSource`；去重维度
  `sourceHash + 标准号+年+部分+阶段 + textHash + 标题 key`；同号不同阶段不算重复；
  旧文档 hash/标准号回填；`kb_lint` 用结构化元数据报告同号多版本；上传 UI 显示解析进度/错误。
- **#3** 0.26 引用与溯源：DSH host spike（工具结果/助手消息渲染）；`kb_query`/`kb_read` 返回结构化
  `sources`；工作台预览深链 `?doc=&page=`；本轮来源面板；E2E：来源面板、点击跳转、页码定位、来源缺失降级。
- **#4** 检索：条款级分块 + SQLite FTS5/BM25 已接入 kb_query；向量/rerank 评估方案；token 预算与引用格式。
  本轮只设计，不实现。

### 2.2 非目标

- 不做向量库/rerank 实现；不新增 embedding 依赖（#4 只给评估门槛）。
- 不做全局内容寻址（CAS）、跨 kbRoot 去重、跨机器同步。
- 不做多标签布尔组合筛选（本轮单标签 `tag`，facets 可切换）；不做标签管理页/改名。
- 不自动删除同号多版本；`kb_lint` 只报告，人工 `kb_remove`/`kb_keep`。
- 不替换 DSH 的 assistant 消息渲染（见 §7.3）；不做正文角标，除非宿主提供非破坏性注解 API。
- 不改 `.scopes.json` 结构，不改 21 个 `kb_*` 工具的范围语义；`kb_describe` 参数保持兼容。

## 3. 已确认事实与约束

### 3.1 基线事实

- 0.25.0 的 `npm test` 812/812 通过（本轮复跑，2.7s；含 `check:client`/`check-ui`）。
- 真实「标准」库 937 篇，`schemaVersion: 5`；`sourceHash` 只有新导入的少数文档有值；
  `standardNo/Year/Part/Stage/rawTitle/canonicalTitle` 字段均不存在。
- `DL/T587—2025+继电保护…`：`type=pdf-text`、`sourceHash` 有值、`trust=unknown`、标题未规范化。
- `GB 19963.2-2024`（扫描件）与 `GB/T 19963.2-2024 风电场…第2部分`（扫描件）标题/字节不同，旧文档 `sourceHash` 为空；当前 `scanDuplicates` 只看标题 key，未拦截。
- 当前 `lintManifest` 已能报告同号多版本：真实库 `same-number-stages` 23 组、`same-number-multi-year` 70 组；本轮把它改为优先使用结构化字段，并保持“不同阶段不算重复”的口径。
- 当前工作台上传状态机为 `select → uploading → starting → importing → done|error`；逐文件 `statusLabel("uploaded") = "已上传"`，完成页固定“导入完成”。

### 3.2 设计约束

- 不破坏 0.25 行为：`kb_query`/`kb_read` 现有字段只增不改；旧清单可读；无 DB/无 `node:sqlite` 时回退现有 ripgrep。
- `summarySource` 现有枚举只有 `model|auto`；新增 `manual` 必须兼容旧清单，且不能被重新导入/重解析降级。
- 所有 manifest 写入走现有 `writeManifestAtomic`/锁；新字段在 `migrateManifest` 中惰性归一，不在启动时批量写盘。
- 新测试全部使用临时目录，不依赖本机知识库；E2E 不污染真实 profile/kbRoot。
- 不自动 push/发布；实现完成后先报告 diff 与测试结果。

## 4. 总体方案与版本切分

### 4.1 三条独立但相邻的缝

```text
资料元数据（#1） ──┐
                   ├── 同一份 manifest 文档条目（schema v6）
摄取规范化（#2） ──┘        │
                            ├── sources 结构（#3）：工具输出 + 深链
                            └── 检索索引（#4）：条款/FTS，后置
```

- **#1 只改“人可编辑的编目字段”**：`summary`、`tags`、`summarySource`、`metaUpdatedAt`；不碰解析。
- **#2 改“导入时自动生成的元数据”**：标题、标准要素、哈希、可信度、去重；不改正文格式。
- **#3 只读 manifest/markdown**：把已有的 `docId/page/part` 组合成 `sources`；不改导入。
- **#4 是派生索引**：可从 sources 随时重建；0.26 不改变 `kb_query` 的外部契约。

### 4.2 版本建议（已确认）

**0.26.0 一次包含 #1 + #2 + #3**：#1/#2 先落地并各自可回滚，#3 在同一个 minor 里交付；
**#4 只写设计，不升版本**；如果 #4 后续实现，走 0.27.0。

### 4.3 已确认决策（2026-10-25）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 版本切分 | 0.26.0 = #1+#2+#3；#4 只设计 |
| 2 | trust 启发式 | 发布/批准稿 → `medium`；过程稿/说明材料/勘误 → `low`；非标准 → `unknown` |
| 3 | 标准号来源 | **以正文/封面为准，文件名只作回退**；不把 GB 与 GB/T 的差异交给用户命名 |
| 4 | 旧库回填 | 先 dry-run 报告，再 `--apply`（hash/std/text）；并对真实「标准」库执行 `--retitle`，逐条预览后应用 |
| 5 | 来源面板 E2E | 合成 session fixture（v4 JSONL，含 `tool/result.data.meta.sources`） |
| 6 | assistant 正文角标 | 本轮不做；只做工具行 + 本轮来源面板 |

## 5. #1 资料摘要/标签编辑与标签筛选

### 5.1 数据模型（与 #2 共用 schema v6）

文档条目新增/确认字段：

```json
{
  "id": "9073bd2af42c",
  "title": "GB/T 19963.2-2024 风电场接入电力系统技术规定 第2部分：海上风电",
  "rawTitle": "GB_T 19963.2-2024 风电场接入电力系统技术规定 第2部分：海上风电",
  "canonicalTitle": "GB/T 19963.2-2024 风电场接入电力系统技术规定 第2部分：海上风电",
  "summary": "海上风电场接入电力系统的技术要求。",
  "summarySource": "manual",
  "tags": ["海上风电", "并网", "GB/T 19963.2-2024"],
  "metaUpdatedAt": "2026-10-25T08:00:00.000Z"
}
```

`summarySource` 枚举：`manual | model | auto | ""`。
- `manual`：工作台人工编辑（本切片新增）。
- `model`：`kb_describe` 写入。
- `auto`：导入时的抽取式摘要。
- `""`：无摘要/已清空。

### 5.2 API：`PATCH /kb/api/kbs/:name/docs/:id/metadata`

请求：

```json
{
  "summary": "海上风电场接入电力系统的技术要求。",
  "tags": ["海上风电", "并网"]
}
```

- `summary`：string 或 null；`trim` + 空白折叠，最长 500 字；`""`/`null` 表示清空。
- `tags`：string[] 或逗号分隔 string；每项去 `#` 前缀、trim、最长 32 字、去重、最多 20 个；
  空数组表示清空。类型不对 → `400 INVALID_ARGS`。
- 至少提供 `summary`、`tags` 之一；否则 `400 INVALID_ARGS`。
- 只改元数据，不递增 `version`，不改 `updatedAt`；写 `metaUpdatedAt`。
- `summary` 非空 → `summarySource: "manual"`；清空 → `summarySource: ""`。
  只改 `tags` 不清改 `summarySource`。
- 拒绝 `importing`（409 `DOC_IMPORTING`）与已删除（409 `DOC_DELETED`），避免与导入/回收站竞态。
- 成功后写日志 `describe`（detail「人工编目」）、刷新 `index.md`；响应 `{ doc: readDoc(...) }`。
- 复用现有 `requireUiHeader` + `assertSameOrigin`；5xx 不回传路径。

`readDoc` / `listDocs` 增加 `summarySource`、`metaUpdatedAt`；`readDoc` 增加 `standardNo` 等（#2）。
`kb_describe` 仍写 `summarySource: "model"`；重新导入/重解析只在来源优先级更高时覆盖（见 §6.6）。

### 5.3 API：标签筛选与 facets

`GET /kb/api/kbs/:name/docs?tag=<tag>`：

- `tag` trim 后精确匹配（大小写敏感，标签本身不做小写化）；空 `tag` 等同不筛选。
- 过滤顺序：`status`（排除已删除/按状态）→ 搜索 `query` → `tag` → `trust` → `type` → 排序 → 分页；
  `total` 是标签过滤后的总数。
- 响应增加：
  ```json
  {
    "tag": "海上风电",
    "facets": {
      "tags": [
        { "name": "海上风电", "count": 7 },
        { "name": "并网", "count": 12 }
      ]
    }
  }
  ```
  `facets.tags` 在 `status/query/trust/type` 过滤后、`tag` 过滤前统计，按 count 降序、name 升序，
  最多 50 个；没有标签时为空数组。facets 只统计非删除资料。
- `tag` 与 `query` 可共存；搜索 haystack 仍包含标题/摘要/标签。

兼容性：新增字段均为 additive；旧客户端忽略。`total` 语义在带 `tag` 时改变符合预期。

### 5.4 工作台 UI

资料页：

- 工具栏新增标签选择：`<select data-docs-tag>`，首项「全部标签」，其后为 facets；
  选中后显示 `标签：X` chip + 「清除」。点击行内标签徽标也设置筛选。
- 行内标签：最多显示 3 个可点击 `.tag`，多余显示 `+N`（title 列出全部）；标签不是按钮语义的
  危险操作，用 `button type="button"` 并 `aria-pressed` 表示当前筛选。
- `state.docs.tag` 进入 `loadDetail`/`loadCurrentDocs` 的请求与竞态校验；切标签时清空选择、
  offset 归零；搜索/翻页/改每页条数保留当前标签。
- 空态：有标签筛选且 0 命中 → 「没有匹配该标签的资料」+「清除标签」。

资料弹窗：

- 摘要从只读 `<strong>` 改为 `<textarea name="doc-summary" maxlength="500">`；标签改为
  `<input name="doc-tags" value="a, b">`；显示来源徽标：`人工` / `模型` / `自动` / `未编目`。
- 「保存摘要/标签」按钮：内容未变时 disabled；保存成功后就地重绘、toast「已保存摘要/标签」、
  `onChanged` 刷新列表；失败在弹窗内 `.form-error` 显示，不关闭弹窗。
- 失败资料弹窗保留重试/移除；已删除资料弹窗不允许编辑（按钮隐藏 + 文案说明）。
- 纯函数：`normalizeDocSummary`、`normalizeDocTagsInput`、`docMetaPatch`、`summarySourceLabel`
  放 `ui/views/doc-meta.js`（无 DOM），供弹窗与测试复用；`ui/api.js` 增加 `patchDocMetadata`。

### 5.5 测试

- `test/web-doc-metadata.test.mjs`（新，~15）：成功/清空/只改标签、`manual`、`metaUpdatedAt`、
  不递增 version、`x-kb-ui`/同源、404/409、`tag` 筛选、facets 统计口径、空 tag、坏类型。
- `test/doc-meta.test.mjs`（新，~15）：摘要/标签归一化、来源徽标、patch 构造、标签输入解析。
- `test/ui-docs.test.mjs`（+6）：标签 select/当前 chip/行内标签/+N/空态/清除。
- `test/ui-docs-actions.test.mjs`（+5）：弹窗可编辑字段、来源徽标、已删除禁用、未变 disabled。
- `test/ui-api.test.mjs`（+2）：`patchDocMetadata` 与 `docs({tag})` 的 URL/body。
- E2E `scripts/e2e/tests/metadata.mjs`（新）：打开资料弹窗改摘要/标签 → 保存 → 列表显示标签 →
  按标签筛选 → 搜索共存；与回收站/失败资料互不干扰。

## 6. #2 摄取规范化

### 6.1 文档元数据（schema v6）

`SCHEMA_VERSION` 5 → 6。新增字段全部在 `migrateManifest` 中惰性归一（缺失 = 空/unknown），
`writeManifestAtomic` 首次写入时备份 `kb.json.v5.bak`。

```json
{
  "id": "578d43c2bc85",
  "title": "DL/T 587-2025 继电保护和安全自动装置运行管理规程",
  "rawTitle": "DLT587—2025+继电保护和安全自动装置运行管理规程",
  "canonicalTitle": "DL/T 587-2025 继电保护和安全自动装置运行管理规程",
  "sourceHash": "8cf1841b...",
  "textHash": "b3...",
  "textHashAlgo": "sha256-norm-v1",
  "standardNo": "DL/T 587-2025",
  "standardPrefix": "DL/T",
  "standardNumber": "587",
  "standardBase": "587",
  "standardYear": 2025,
  "standardPart": null,
  "standardSource": "content",
  "filenameStandardNo": "DL/T 587-2025",
  "contentTitle": "继电保护和安全自动装置运行管理规程",
  "contentIntegrity": "full",
  "bodyChars": 18320,
  "clauseCount": 47,
  "stage": "published",
  "stageLabel": "发布稿",
  "trust": "medium",
  "trustReason": "已发布标准，尚未核实现行/废止",
  "trustSource": "heuristic",
  "summary": "……",
  "summarySource": "auto",
  "metadataUpdatedAt": "2026-10-25T08:00:00.000Z"
}
```

- `standardPart`：`GB/T 19963.2` → `2`；`第2部分` 也解析为 `2`；无部分号 = `null`。
- `standardBase`：去掉末尾 `.N` 的编号；用于“同年同部分”分组和 GB/GB/T 变体比较。
- `stage` 枚举：`published | approved | draft | comment | review | discussion | plan | notes | redline | errata | variant | unknown`。
  `stageLabel` 保留中文（发布稿/报批稿/征求意见稿/说明材料/…）。
- `standardSource`：`content | filename | none`。**正文/封面解析成功时以 content 为准**；
  `filenameStandardNo` 保留文件名解析结果，供审计与“文件名与封面不一致”提示。
- `contentTitle`：封面/正文中标准名称（去掉“中华人民共和国国家标准”“代替 …”等版式行）；
  与文件名名称不一致时只记录，不静默覆盖用户可见标题（`--retitle` 才会写回 `title`）。
- `contentIntegrity`：`full | partial | cover-only | unknown`；`bodyChars/clauseCount` 是判定依据。
  **封面完好不代表正文完整**：只有封面/目录、正文缺失或被截断的资料必须标 `cover-only/partial`，
  不能仅凭封面标准号参与“重复跳过”决策（见 §6.4.1）。
- `trustSource`：`manual | heuristic | unknown`；旧文档有 `trust != unknown` 且无该字段 → `manual`。
- 笔记（`type=note`）不需要 `standard*`；`textHash` 可选，不参与去重。

### 6.2 标准要素解析（`lib/doc-meta.js`）

单一来源，替换目前分散在 `dedup.titleKeys`、`lint.stageOf`、`standards.extractStdRef` 的三套口径：

```js
parseDocMeta(title, rawTitle) -> {
  rawTitle, canonicalTitle,
  standardPrefix, standardNumber, standardBase, standardYear, standardPart,
  standardNo, stage, stageLabel, isDraft, standardSource: "filename",
  filenameStandardNo,
  titleKey
}

parseCoverTitle(sectionsOrText, { maxChars = 3000 }) -> { title, confidence }

parseContentStandard(sectionsOrText, { maxChars = 8000, maxPages = 4 }) -> {
  standardPrefix, standardNumber, standardBase, standardYear, standardPart,
  standardNo, stage, stageLabel, contentTitle,
  contentIntegrity: "full"|"partial"|"cover-only"|"unknown", bodyChars, clauseCount,
  confidence: "high"|"medium"|"low"
} | null
```

- 标准号提取复用 `extractStdRef(cleanTitle(title))`（支持 GB/T=GBT=GB_T、Q/GDW、IEEE、IEC、
  年份分隔符、`ed2.0c1` 等）；阶段用**完整标题**上的 `stageOf`（`extractStdRef` 会剥掉尾部括号，
  不能拿它判 `（报批稿）`）。
- 部分号：`standardNumber` 末尾 `.N` 优先；否则标题 `第N部分`/`第N分册`；两者都有时以编号为准并校验一致。
- `canonicalTitle`：`cleanTitle` 增强标准号规范：
  - 前缀与编号之间补空格：`DL/T587` → `DL/T 587`；
  - 年份分隔符统一为 `-`：`—`/`–`/`~`/`～` → `-`；
  - `+`/`＋` 作为编号与名称分隔时改为空格：`DL/T587—2025+继电` → `DL/T 587-2025 继电`；
  - 只在前缀位于标题开头且能解析出编号/年份时改写，避免误伤正文。
- `titleKey`：规范化（NFKC、lower、去空白标点）后的标题；标准文档不作为主键（标准号键优先）。

`cleanTitle` 的增强只影响“标准号 + 名称”开头形态；现有 20+ 条 `titles-retitle` 断言必须逐条通过。

#### 6.2.1 正文/封面优先（关键）

用户明确要求：**不能只靠文件名判断 GB 与 GB/T**；封面/正文写的是 GB/T，就应按 GB/T 处理。

- `parseContentStandard(sectionsOrText, …)` 在**解析完成后**执行（回填时可传合并版前 8000 字），只看前 4 页/前 8000 字：
  - 标准号：在前 8000 字中扫描 `GB|GB/T|GB/Z|DL/T|NB/T|Q/GDW|IEC|IEEE|ISO|…` + 编号 + 年份，
    优先取第一页、靠近“中华人民共和国国家标准/行业标准”与“代替 …”之前的候选；
    用 `extractStdRef` 二次解析候选 + 下一行，避免把正文条款号误当标准号。
  - 名称：标准号后的 1–3 行，去掉“中华人民共和国国家标准”“GB/T …—20XX”“代替 GB/T …”
    “ICS …”“CCS …”“发布/实施”等部门/版式行；得到 `contentTitle`。
  - 阶段：前 3000 字中的“报批稿/征求意见稿/发布稿/送审稿/草案/编制说明/…”。
  - 置信：同时有前缀、编号、年份且出现在前 3 页 → `high`；缺年份/只在正文出现 → `medium`；
    只有前缀或候选歧义 → `low`（不覆盖文件名）。
- 合并规则（`mergeDocMeta(filenameMeta, contentMeta)`）：
  - `content` 置信 high/medium 且 `standardNo` 与文件名不同 → **以 content 为准**，
    `standardSource="content"`，`filenameStandardNo` 保留文件名结果；
  - content 置信 low 或 null → `standardSource="filename"`，用文件名结果；
  - 两者都没有 → `standardSource="none"`。
- 可见标题：新导入 `title` 默认用文件名规范化结果；若文件名只有标准号/极短，而 content 有名称，
  则用 `${standardNo} ${contentTitle}`；`canonicalTitle` 始终按合并后的标准号 + 名称规范化。
- **合并护栏**：文件名已有标准号时，content 必须与文件名同一主编号且年份不冲突才可纠正
  （GB→GB/T 可以；DL 1773 正文里的 `NB 2` 不行）。文件名已有名称时优先保留文件名的名称
  （封面标题常被版式截断，如少掉“技术规范”）；只有文件名为纯编号/无名称时才用正文标题补全。
- `standardSource`、`filenameStandardNo`、`contentTitle` 三者用于审计“文件名与封面不一致”；
  `kb_lint` 新增 info 组 `filename-standard-mismatch`（只提示，不改标题）。
- **去重顺序**：预筛只能用文件名（尚未解析）；解析后必须用 content 标准号再查一次索引。
  这样 `GB 19963.2-2024.pdf` 的封面 OCR 得到 `GB/T 19963.2-2024` 后，会与已入库的
  `GB/T 19963.2-2024 风电场…` 命中同一 `std` 键；两份都完整才按重复跳过，
  残缺/完整版本按 §6.4.1 矩阵处理。
- 扫描件 OCR 文本可能质量差：只接受 `high/medium`；标题/标准号行出现乱码、全角数字、
  页眉页脚混入时不覆盖文件名，但把候选写入 `warnings`，由 `kb_lint`/`kb_std_check` 继续核对。

#### 6.2.2 适用对象与正文完整性

- **适用对象**：只有“标准/书籍”允许正文/封面优先。
  - 标准：文件名或正文能解析出标准号（PDF/docx/pptx 等文档类型）；
  - 书籍：`epub`/`mobi` 用 `parseCoverTitle`（前两页/首个 heading）得到 `contentTitle`；
    只影响 `canonicalTitle/--retitle`，**不产生标准号**，不参与标准去重；正文不完整不 retitle；
  - 其他资料（通知、台账、图纸、xlsx、普通 md/txt/note）：**不做正文/封面优先**，只用文件名/标题，
    避免把正文里的偶然编号误当资料身份。
- **正文完整性**（与封面识别同时计算）：
  - `bodyChars` = 去掉前 2 个 section/前 1500 字（封面、题名页、目录首页）后的正文字符数；
  - `clauseCount` = 正文中条款标题（`5.2.2`/`第N章`/`附录 A`）的数量；
  - `contentIntegrity`：
    - `full`：`bodyChars >= 1000` 且（`clauseCount >= 3` 或 `bodyChars >= 5000`）；
    - `partial`：`bodyChars >= 200` 但未达 full；
    - `cover-only`：有封面/目录文本但 `bodyChars < 200`；
    - `unknown`：没有可用文字层/OCR 失败。
  - PDF 有页数时附加 `pagesWithText / pages`；低于 20% 直接降为 `partial/cover-only`。
- **硬规则**：`contentIntegrity` 不是 `full` 时：
  - 不执行 `--retitle`；只写 `canonicalTitle` 候选并进 `kb_lint`；
  - 与已有完整版本的标准号命中**不能直接判定“重复”**，按 §6.4.1 矩阵处理。
- 其他资料仍记录 `contentIntegrity` 供 lint 使用，但不参与身份判定。

### 6.3 内容指纹

- `sourceHash`：原文件字节 sha256（已有 `hashFile`）。
- `textHash`：解析后的规范化正文 sha256：
  - 输入 = `sections` 的 `heading + text`（按顺序），不包含标题行、分块注释、页码注释；
  - 规范化 = NFKC + 小写 + 去 HTML 注释/零宽字符 + 空白折叠；
  - `textHashAlgo = "sha256-norm-v1"`；算法版本变化时旧哈希不参与比较。
- `textHash` 在 `commitDoc` 时写入；`kb_edit`/`kb_edit_batch` 后重新计算（否则编辑过的文档不再参与内容去重）。
- 旧文档 `textHash` 由回填脚本可选计算（`--text`）。

### 6.4 去重索引与匹配口径

新增 `lib/dedup-index.js`，只做纯数据索引与匹配：

```js
buildDedupIndex({ kbRoot, targetKb, kbNames = null }) -> {
  bySourceHash, byTextHash, byStdKey, byStdFamilyKey, byTitleKey,
  docs: [{ kb, dir, id, title, status, keys }]
}
matchCandidate(index, { sourceHash, textHash, title, standard..., docId, targetKb })
  -> [{ kb, dir, id, title, kind, scope, sameKb }]
```

匹配顺序与 `kind`：

| kind | 条件 | 是否跳过 |
|---|---|---|
| `source-hash` | 候选 `sourceHash` 与库内 ready 文档相同 | 是（同库/跨库按规则） |
| `text-hash` | 候选 `textHash` 与库内 ready 文档相同，且 `textHashAlgo` 一致 | 是 |
| `std` | `standardPrefix + base + year + part + stage` 全同；有正文标准号时用正文，否则用文件名 | 是（完整性见 §6.4.1） |
| `std-family` | `family + base + year + part + stage` 全同，但前缀不同（GB vs GB/T）；正文标准号不可用时的回退 | 是（完整性见 §6.4.1） |
| `title-exact` | 无标准号时，`titleKey` 完全相同 | 是 |
| `title-prefix` | 无标准号时，短标题是长标题完整前缀 | 否（similar，提示确认） |
| `stage-variant` | 同号同年同部分但阶段不同 | **否**（不是重复；仅 `kb_lint` info） |
| `year-variant` | 同号同部分但年份不同 | 否（多版本；仅 lint） |
| `part-variant` | 同号同年但部分不同 | 否（不同分册） |

规则：

- **同库命中永远跳过**（保持 0.25 行为）；**跨库命中默认跳过**，`allowCrossDuplicates: true` 才导入，
  并在报告里给出 `matchKind` 与 `scope`。
- 标准号**以正文为准**：解析后若封面 OCR 得到 `GB/T 19963.2-2024`，则两条资料都按 `GB/T`
  精确命中 `std`，不依赖文件名里的 `GB` 写法。`std-family` 只在正文不可用/置信不足时回退；
  `GB` 与 `GB/T` 是同一族（`familyOf`），回退时报告“写法差异”。
- 一方有年份、一方没有 → 不判重复（可能是新修订），归入 similar 不跳过。
- 笔记、failed、deleted、importing 文档不进入索引。
- `sourceHash`/`textHash` 命中优先于标准号命中；报告只保留最高置信的 kind，其余作为 `alsoMatched`。

#### 6.4.1 封面命中但正文不完整的处理矩阵

标准/书籍的 `std` 命中后，还要比较**候选（新文件）与已匹配文档的 `contentIntegrity/bodyChars`**：

| 新文件 | 已有文档 | 处理 | 报告 |
|---|---|---|---|
| full | full | 跳过（重复） | `matchKind=std`，`reason=duplicate` |
| full | cover-only/partial/unknown | **不跳过，照常导入** | `replacesIncomplete: true`，提示“已有版本正文不完整/未知，已保留新文件” |
| cover-only/partial/unknown | full | 跳过 | `reason=existing-full`，提示“库内已有完整版本” |
| cover-only/partial | cover-only/partial | 跳过 | `reason=both-incomplete`，`kb_lint` 列入 `content-incomplete` |
| unknown | cover-only/partial | 跳过 | `reason=unknown-integrity`，交人工核对 |

- 这条矩阵只作用于 `std/std-family` 命中；`sourceHash` 相同（同一文件）仍直接跳过，
  `textHash` 相同（正文完全一致）也直接跳过。
- “不跳过”不会删除旧文档；新文件以正常导入落库，`kb_lint` 会并列显示两份，
  由人工用 `kb_remove` 清掉残缺版。跨库同规则；`allowCrossDuplicates` 仍可强制导入。
- 笔记、xlsx、普通业务文档不进入该矩阵（没有标准号身份）。

### 6.5 管线接入

1. **上传批次**：`addBatchFile` 在写盘时用 `createHash("sha256")` 计算 `hash`，写入 `batch.json`
   的 `{path,size,hash}`；旧批次没有 hash 时按 `size` + 后续 pipeline 计算兜底。
2. **批次导入**：`buildImportFiles` 传 `sourceHash`；`scanDuplicates` 使用 `dedup-index` 预筛
   `source-hash/std/std-family/title`；`importBatch` 把 `dedup: { kbRoot, kbNames, allowCrossKb }`
   写进 worker 参数。
3. **worker**：启动时 `buildDedupIndex` 一次；每个文件调用 `importFileInto({ dedupIndex, allowCrossKb })`；
   成功后把新文档的 hash/std/title 写回内存索引（同一批内的重复也能拦）。
4. **pipeline**：
   - 解析前：用传入的 `dedupIndex` 再查一次 `source-hash/std/std-family/title`（防止预筛后被并发导入）；
   - 解析后：先 `parseContentStandard` 合并正文标准号，用**合并后的标准号**再查一次 `std/std-family`
     （这是 `GB 19963.2` 与 `GB/T 19963.2` 真正被拦住的位置）；再计算 `textHash` 查 `text-hash`；
   - `std/std-family` 命中时按 §6.4.1 比较 `contentIntegrity/bodyChars`：完整版可越过残缺版正常导入；
     其余命中 → 清理暂存、恢复 `markImporting` 前的条目，返回
     `{ skipped: true, reason: "duplicate"|"existing-full"|"both-incomplete", duplicate: { kind, matched } }`，
     **不 markFailed**；
   - 不传 `dedupIndex` 时保持 0.25 行为（测试/特殊调用），只在同库内做 `skippedUnchanged`。
5. **`kb_import`/`kb_std_check`**：同样构建索引；下载导入用 `stableKey` 时仍允许原位更新。
6. **`kb_reparse`**：不走去重（用户明确要重解析），但会刷新 `textHash`。
7. **`markImporting`/`markSkipped`**：
   - `markImporting` 额外记录 `importingFrom`（`status/error/deletedAt/deletedFromStatus`）；
   - `commitDoc`/`markFailed` 删除该字段；
   - 新增 `markSkipped(dir, docId)`：若原条目不存在 → 移除占位；存在 → 恢复 `importingFrom`；
   - 防止“重复跳过”把文档永久卡在 `importing`。

### 6.6 摘要/可信度与重新导入

`commitDoc` 的覆盖规则：

| 旧 `summarySource` | 新导入来源 | 结果 |
|---|---|---|
| `manual` | 任意 | 保留人工摘要/来源 |
| `model` | `auto`/空 | 保留模型摘要/来源 |
| `auto` | `auto`/空 | 用新抽取摘要 |
| 任意 | `manual`（不会由导入产生） | 用 manual |

- 标签：新导入没有标签时保留旧标签；有标签时以新标签替换。
- `trust`：`trustSource=manual` 永不覆盖；`heuristic` 只在旧 `trust=unknown` 或无来源时写入；
  重新导入保留旧 `trust/trustReason/trustSource`。
- `trustHeuristic(meta)`（已确认口径；`stage` 优先取正文/封面，其次标题）：
  - `stage` 为 draft/comment/review/discussion/plan/notes/redline/errata/variant → `low`，
    理由“过程稿/说明材料/勘误（非现行发布版）”；
  - `stage` 为 published/approved 且解析出标准号 → `medium`，理由“已发布标准，尚未核实现行/废止”；
  - 无标准号 → `unknown`，不写理由；
  - 标题含“非正式版/送审/报批/征求意见/草案” → `low`。
- `kb_trust` 设置 `trustSource: "manual"`；`level=unknown` 清空 `trustSource`。
- `kb_describe` 仍写 `model`；显式工具调用可以改人工摘要，但来源改为 `model`（导入不会）。

### 6.7 回填旧文档

新增 `scripts/backfill-doc-meta.mjs` + 可测试的 `lib/backfill.js`：

```bash
node scripts/backfill-doc-meta.mjs --root ~/.dsh/knowledge --kb 标准 --dry-run
node scripts/backfill-doc-meta.mjs --root ~/.dsh/knowledge --kb 标准 --apply --hash --std --content --text
node scripts/backfill-doc-meta.mjs --root ~/.dsh/knowledge --kb 标准 --apply --retitle
```

- 默认 dry-run，输出逐类计数与样例（不写盘）；`--apply` 每库一次原子写 manifest。
- `--hash`：从 `sources/<id>.*` 计算 `sourceHash`（找不到原件计数 skipped）。
- `--std`：从 `sourceFile`/`title` 解析标准要素、`rawTitle`、`canonicalTitle`；不自动改 `title`。
- `--content`：读取合并版前 8000 字，`parseContentStandard` 优先；正文与文件名不一致时以正文为准，
  写 `standardSource/contentTitle/filenameStandardNo/contentIntegrity`；正文低置信/不完整时回退 `--std`，
  并计入 `content-incomplete`。
- `--text`：从合并版 markdown 计算 `textHash`（可选，耗时）。
- `--trust`：仅对 `trust=unknown` 的文档应用启发式（默认关闭，避免改已有 834 篇 high）。
- `--retitle`：把 `canonicalTitle` 写回 `title`（走 `kb_retitle` 同样的版本/历史/合并版更新）。
  本轮已确认对真实「标准」库执行：先 dry-run 出变更清单 → 用户确认 → `--apply --retitle`；
  只改标准号/名称规范形态，不把无标准号的业务文档改名；`contentIntegrity != full` 的文档不 retitle。
  **安全门**：只对 `needsRetitle`（前缀与编号无空格、`+`/全角符号、年份后直接接名称等明显噪声）
  且 `safeRetitle`（去掉空白/标点/分隔符后字符序列一致，仅格式变化）成立的标题改写；
  普通 `-征求意见稿` 风格、2 位年份、正文标题被截断的文档保持原题。
- 不递增 `version`（除 `--retitle`），不改 `updatedAt`，写 `metadataUpdatedAt`。
- 回填后 `kb_lint` 的 `metadata-missing` 组应清零或只剩“原件缺失”；`filename-standard-mismatch`
  只提示，不改标题。

### 6.8 `kb_lint` 报告

新增/调整分组：

- `metadata-missing`（warning）：缺 `sourceHash` 或（非笔记）缺 `standardNo` 且标题可解析；
  hint「运行 scripts/backfill-doc-meta.mjs --apply」。
- `duplicate-text`（warning）：`textHash` 相同的 ready 文档（与现有 `duplicate-content`
  `sourceHash` 组并列）。
- `same-number`（warning）：同 `prefix + base + year + part + stage` 且未 `dedupKeep`；
  文案「同号同期同阶段」。
- `same-number-stages`（info）：同 `prefix + base + year + part`、阶段不同；
  文案「不同阶段不算重复，无需删除」。
- `same-number-multi-year`（info）：同 `prefix + base + part`、年份不同；列各年与阶段。
- `same-number-family`（info）：`family + base + year + part + stage` 相同但前缀不同
  （GB vs GB/T）；提示“可能是同一标准的写法差异，核对后保留其一或 kb_keep”。
- `filename-standard-mismatch`（info）：`standardSource="content"` 且 `filenameStandardNo` 与
  `standardNo` 不同；提示“文件名与封面/正文不一致，已按正文处理”，不改标题。
- `content-incomplete`（warning）：`contentIntegrity` 为 `cover-only`/`partial`/`unknown` 的标准/书籍；
  提示“封面可用但正文可能缺失，建议重新导入完整版或 kb_view 核对”，不自动删除。
- 分组优先用文档字段；字段缺失才解析标题（兼容旧清单）。
- 不在 lint 里自动删除；保持 `kb_keep` / `kb_remove` 人工决策。

### 6.9 上传 UI：上传≠解析

新增纯函数（`ui/upload-core.js`）：

- `fileStageLabel(item, phase)`：`pending/uploading/uploaded/queued/parsing/parsed/failed/skipped-duplicate/skipped-importing`。
- `uploadPhaseTitle(state)`：
  - `uploading` → 「上传中（文件尚未解析）」
  - `starting` → 「文件已上传，正在启动解析…」
  - `importing` → 「解析中 · <库>」
  - `done` → 「解析完成 · <库>」
  - `empty` → 「没有新资料（全部重复）」
  - `error` → 上传成功但解析失败时「上传完成，解析未完成」；上传失败时「上传失败」
- 逐文件文案：`uploaded` 显示「已上传，待解析」（不是“完成”）；`parsing` 显示「解析中」；
  `parsed` 显示「已解析」；`failed` 显示「解析失败：原因」；`skipped-duplicate` 显示
  「重复跳过（同库/跨库：标题/标准号/正文相同）」。
- 完成页汇总：`成功 N · 失败 M · 重复跳过 K · 导入中跳过 J`；不再把所有 skipped 写成
  “文档正在导入中”。
- `importBatch` 全重复（`jobId:null`）→ phase `empty`，文案「没有新资料：全部与库内重合」，
  不显示「导入完成」。
- 上传成功但 `importBatch` 抛错 → phase `error`，标题「上传完成，解析未完成」，保留文件列表与
  「重试导入」；上传失败 → 标题「上传失败」，不出现解析相关文案。
- worker progress 每文件增加 `stage`（`queued/parsing/parsed/failed/skipped`）与 `reason`；
  `progress.done` 仍按文件计数；旧 UI 仍能读 `status`。

### 6.10 测试

- `test/doc-meta.test.mjs`（新，~35）：标准要素矩阵（GB/GB/T/DL/Q/GDW/IEC/IEEE、年份、部分、
  阶段、括号阶段、乱标题）、canonicalTitle、titleKey、textHash 规范化、trustHeuristic；
  `parseContentStandard` 的封面标准号/名称/阶段、全角数字、页眉页脚噪声、低置信回退、
  正文与文件名不一致时 content 优先；`contentIntegrity` 的 full/partial/cover-only/unknown 阈值；
  书籍 `parseCoverTitle`（epub/mobi）与“其他资料不 content-first”的负例。
- `test/dedup-index.test.mjs`（新，~30）：sourceHash/textHash/std/std-family/title 命中、
  同号不同阶段/年份/部分不跳过、同库/跨库、allowCrossDuplicates、alsoMatched、坏文档跳过、
  §6.4.1 的 full/partial/cover-only 矩阵。
- `test/import-metadata.test.mjs`（新，~15）：commit 落字段、重新导入保留 manual/model/trust、
  textHash、markSkipped 恢复、同批重复、旧清单惰性归一。
- `test/lint-metadata.test.mjs`（新，~14）：metadata-missing、duplicate-text、same-number 各分组、
  结构化字段优先、旧标题回退、part/family、filename-standard-mismatch。
- `test/backfill.test.mjs`（新，~12）：dry-run 不写、apply 原子写、hash/std/text/trust/retitle、
  原件缺失、坏清单跳过。
- `test/upload-core.test.mjs`（+10）：阶段文案、全重复 empty、上传失败 vs 解析失败、逐文件 reason。
- `test/web-upload-batch.test.mjs`（+3）：`addBatchFile` 返回 hash、batch.json 持久化、旧批次兼容。
- `test/web-upload-import.test.mjs`（+4）：dedup 报告 `matchKind`、textHash 跳过、worker 参数、
  `jobId:null` 全重复。
- `test/import-job.test.mjs`（+3）：worker stage/reason、markSkipped 不卡 importing。
- E2E `upload.mjs`（新）：上传两份同号不同阶段文件，确认都保留；上传重复文件，确认跳过文案；
  上传失败文件，确认“解析失败”而非“上传完成”。

### 6.11 标签分类与标题规范化（2026-10-25 实施）

- 类型标签：GB/GB/T/GB/Z/JJF → 国家标准；DL/DL/T、NB/NB/T、JB、TB 等 → 行业标准；
  Q/GDW、国网文件 → 企业标准；T/... → 团体标准；IEC/IEEE/ISO/EN → 国际标准。
- 主题标签：电能质量、继电保护、变压器、变电试验、绝缘、新能源、直流输电；依据标题/摘要。
  通知/纪要/附件因开头不是标准号或书名号，不会被误标成标准类型。
- 标题规范化：支持书名号/括注/名称后置标准号；输出「标准号 名称」，保留报批稿/
  征求意见稿阶段，清理上传版后缀；裸标准号只有在正文标题通过质量校验或同族存在
  完整标题时才补全，OCR 句子/章节标题不参与。
- 脚本：`scripts/tag-doc-library.mjs`（默认 dry-run，`--apply` 写 tags/metaUpdatedAt）；
  `scripts/backfill-doc-meta.mjs --normalize-titles`（仍先 dry-run）。
- 真实库当前 871/911 有标签；40 篇为 7 篇笔记、索引/手册、附件/通知及暂无标准号的草案，不强行归类。

## 7. #3 0.26 引用与溯源

### 7.1 DSH host spike（源码级已确认，运行时待补）

宿主：桌面 **0.2.1-rc.2** / CLI 0.1.1-rc.2（本轮源码检查与真实会话日志）。

已确认：

1. **工具结果可自定义渲染。** `tool.call.toolview` 是 keyed slot，按 wire tool name 注册；
   owner props 含 `phase`（`preparing/start/result`）与 `block`（`content`、`meta`、`isError`），
   以及 `useDisclosure`、`callId`、`toolName`、`openFile`、`inspect`。
   `kb_query`/`kb_read` 可直接注册该 slot，不替换通用 tool-call 树。
2. **结构化 meta 能到客户端。** `defineTool({ output: { presentationMeta(args, value) } })`
   由 `dsh-tools` 持久化到 `tool/result` 的 `data.meta`；真实会话日志中 `read` 工具的
   `data.meta.path/lines` 已实证。因此 `sources` 可走 meta，不需要把 JSON 塞进正文让客户端解析。
3. **本轮来源面板可行。** `conversation.chat.turnTail` 是 list slot，props 含 `turn`、`seq`、
   `openFile`；配合 `useChat((s) => s.nodes)` 可按 turn 聚合 tool-call 节点的 `meta.sources`。
   运行时还需确认 `turn` 的具体字段（`turn.turn` / `seq`）与节点 `location`。
4. **助手正文没有非破坏性注解槽。** 唯一的助手正文 renderer 是 `conversation.chat.node` 的
   `key: "assistant-step"`；注册它会**整体替换**宿主 assistant 消息渲染（markdown/附件/操作行），
   属于 `shadows-shipped-ui`。`conversation.chat.assistant-actions` 只能加操作按钮，不能插正文角标。
5. **包注入要验证。** 当前 `dsh.client.inject` 只有 `@deepseek-ai/dsh-client-ui-sidebar`；
   注册 `tool.call.toolview` / `turnTail` 需要 `ctx.slots.inject` 等待 slot 出现，可能还要在
   `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-chat` / `...-ui-tool`。Spike 必须验证
   两种注入方式，失败时降级为不渲染来源面板（胶囊/工作台不受影响）。

运行时 spike 任务（实施第一阶段）：

- 临时 profile + 临时 kbRoot，插入探针插件，注册 `tool.call.toolview`（key `kb_query`）与
  `conversation.chat.turnTail`，把 props keys/`block.meta`/`turn` 写 JSONL。
- 用真实模型轮次或合成 session fixture 触发一次 `kb_query`；截图 + 日志留档 `.acceptance/`。
- 结论写入 `docs/specs/…` 的“spike 记录”小节；未通过就不进入 §7.4 的面板实现。

### 7.2 `sources` 结构（`kb_query` / `kb_read`）

工具输出新增顶层 `sources`（additive，最多 20 条）：

```json
{
  "kb": "标准",
  "docId": "578d43c2bc85",
  "title": "DL/T 587-2025 继电保护和安全自动装置运行管理规程",
  "page": 12,
  "pageEnd": 12,
  "clause": "5.2.2",
  "snippet": "5.2.2 继电保护装置应…",
  "deepLink": "/kb/?kb=%E6%A0%87%E5%87%86&doc=578d43c2bc85&page=12&clause=5.2.2"
}
```

- `page` 无页码时为 `null`（省略或 null，schema 用 nullable number）；`pageEnd` 仅跨页。
- `clause` 从最近的前置 heading 或匹配行首条款号提取；没有则 `null`。
- `snippet` 去换行、最多 160 字；不包含绝对路径。
- `deepLink` 始终为相对 `/kb/` URL；`page` 缺失时省略；`clause` URL 编码。
- `kb_query`：每个展示命中一条，按 `(kb, docId, page, clause)` 去重，最多 20；
  同名文档多命中合并为一条，snippet 取第一条。
- `kb_read`：当前 part 一条（`page` = pageStart，`clause` = 最近 outline 条目）；
  `part=all` 时最多 20 条（按 part 切）；虚拟文档（schema/index/log）`sources: []`。
- `output.render` 在末尾追加最多 5 条紧凑来源（给模型看，便于引用）；完整 `sources` 供 UI 用。
- `presentationMeta` 返回 `{ sources }`，tool view 直接读 `block.meta.sources`。

### 7.3 工具结果视图与“本轮来源”面板

新增客户端组件（`src/client/index.tsx` 或拆 `src/client/sources.tsx`）：

- `KbQueryToolRow`（key `kb_query`）与 `KbReadToolRow`（key `kb_read`）：
  - result 阶段显示「找到 N 处 / 来源 K 篇」+ 前 3 条来源 chip；
  - 展开后列出全部 sources：`标题 · 第 5.2.2 条 · 第 12 页`，点击 `<a href=deepLink target="_blank">`
    在新标签打开工作台预览；
  - `preparing/start` 用通用小行，不伪造结果；
  - 样式用插件注入 CSS（`dsh-kb-source-*`），不依赖宿主内部组件。
- `KbSourcesTurnPanel`（`conversation.chat.turnTail`, id `kb-sources`, order 30）：
  - 用 `useChat((s) => s.nodes)` 取节点 Map；按 `turn`/`seq` 过滤该 turn 的 tool-call 节点；
  - 递归收集 `root.meta.sources`（含 PTC 子调用），按 `(kb,docId,page,clause)` 去重；
  - 有来源时渲染「本轮来源 (N)」+ 前 12 条 + 「展开全部」；无来源返回 `null`；
  - 链接同工具视图；点击不触发聊天滚动/提交。
- **不做** assistant 正文角标：宿主没有注解槽，替换 `assistant-step` 会 shadow 官方渲染。
  如果后续宿主提供 `assistant text decorator`/`annotation`，再按 `sources` 的 `docId/page/clause`
  做 `[1]` 角标；本轮在 README/设计中记录为待办。
- 降级：
  - slot 未出现/注册失败 → 不渲染面板，胶囊/工作台不受影响；
  - `meta.sources` 缺失/格式坏 → 工具行回退通用文本，不抛错；
  - 深链打开失败 → 工作台 toast「资料不存在或已删除」；
  - 无 page → 打开预览但不追加 `#page`，显示「该资料没有页码」。

### 7.4 工作台深链 `?doc=&page=`

- 入口：`/kb/?kb=<库名>&doc=<docId>&page=<页码>&clause=<条款>`；`embed=1` 时同样生效。
- `ui/app.js` 启动：
  - 解析 query；`kb` 缺失时若当前只有一个库用它，否则回退第一个库；
  - 等 `loadKbs` 完成后 `GET /kbs/:name/docs/:id`；404 → toast「资料不存在或已删除」并清理 query；
  - 成功 → `openPreviewModal({ name, doc, initialPage })`；`page` 取正整数并 clamp 到 `doc.pages`；
  - 非法/超界 page → 1，并在弹窗显示「页码超出范围，已定位到第 1 页」；
  - `clause` 先用于标题旁显示「第 5.2.2 条」，不做正文滚动（后续 FTS 再做高亮）。
- 预览：
  - PDF / Office 转换后的 PDF：iframe URL 追加 `#page=N&zoom=page-fit`（fragment 不发给服务端）；
  - 图片/文本/笔记：显示「该格式没有页码，已打开资料」；笔记仍走 `/content`。
- 纯函数：`ui/deep-link.js` 的 `parsePreviewDeepLink(search)`、`withPageFragment(url,page)`、
  `clampPage(page,pages)`；测试覆盖编码、缺参、非法值、超界。
- 兼容：无 query 时行为不变；`#/kb/...` 路由不受影响。

### 7.5 测试与 E2E

- `test/sources-view.test.mjs`（新，~12）：source 校验/去重/链接编码/标题格式/缺失降级。
- `test/query-sources.test.mjs`（新，~10）：`kb_query` 单库/跨库 sources、去重、page/clause、
  无 page、render 尾部来源、schema。
- `test/read-sources.test.mjs`（新，~10）：part/all/outline/虚拟文档 sources、pageStart/pageEnd。
- `test/deep-link.test.mjs`（新，~12）：解析/编码/page clamp/无页码/坏 doc。
- `test/sources-client.test.mjs`（新，~15）：VM/fake DOM 注册 `tool.call.toolview`、
  `turnTail`；meta.sources 渲染、坏 meta 回退、无来源 null、链接 href。
- E2E `deep-link.mjs`：打开 `?kb=甲库&doc=7777…&page=1` → 预览弹窗 + iframe `#page=1`；
  `page=999` → 第 1 页提示；`doc=不存在` → toast；`page` 缺失 → 无 fragment。
- E2E `sources.mjs`：写入**合成 session fixture**（v4 JSONL，含一条 `kb_query` tool/result
  `data.meta.sources`），在临时 DSH_HOME 打开该会话 → 断言工具行来源 chip、点击打开工作台、
  页码定位、坏 sources 回退。Fixture 生成器放 `scripts/e2e/session-fixture.mjs`，不进产品包。
  - 这是本设计唯一需要 runtime spike 兜底的 E2E；若宿主拒绝合成 session，先修 fixture 而不是
    降低断言。实在不可行時在验收记录里明确写“未覆盖”，并由用户决定是否接受。

## 8. #4 检索优化设计（核心模块已试点，尚未接入 kb_query）

### 8.1 现状

- `kb_query` 用打包的 ripgrep 正则扫 `markdown/<docId>/<docId>.md`，按行命中；
  `rankMatches` 用标题命中/标题行/命中数/更新时间/trust 做启发式排序。
- 分块 `parts/0001.md` 默认 8000 字，粒度过大；没有 clause 级元数据；没有 BM25/向量。
- 优点：零索引、即装即用、正则能力强；缺点：长文档召回粗、同义/近义弱、结果行号到页码靠 part index。

### 8.2 条款级分块

新增 `lib/clauses.js`（纯函数，先测试后接索引）：

- 输入：`sections`（heading/text/page）或 part 文件 + partIndex。
- 切分：
  - 先按空行段落；识别条款起始：
    - `^\s*(\d+(?:\.\d+){0,5})\s+(\S.*)$`（5.2.2 …）
    - `^\s*第[一二三四五六七八九十百]+[章节篇]\s*`
    - 附录 `^[A-Z](?:\.\d+)*\s+`
  - 条款正文超过 800 字按中文句末标点切；小于 40 字的尾段并入前一条款。
- 每条 `{ docId, part, clause, heading, text, pageStart, pageEnd, lineStart, lineEnd }`；
  `lineStart/lineEnd` 相对合并版，用于兼容现有 `matches` 的 `lineNumber`。
- 先只用于 FTS 索引，不改变 `markdown/parts` 文件；`kb_read` 仍按 part。
- 已落地 `lib/clauses.js` + `lib/fts-index.js` 与单测（2026-10-25），并接入 `kb_query`：
  纯文本优先 FTS5，正则/索引不可用/无命中回退 ripgrep；真实库索引已构建。
- 增量同步：按 version/updatedAt 只重建变动文档；首次/损坏回退全量。
- 后台构建：索引缺失/过期时拉起 `lib/fts-worker.mjs`，当前查询回退 ripgrep。
- 60 条机制评测：Doc/Page Recall@10 95%、MRR 0.761、p95 47.5ms；见
  `docs/specs/2026-10-25-retrieval-eval.md`（非人工语义评测）。

### 8.3 SQLite FTS5 / BM25

- 引擎：Node 内置 `node:sqlite`（桌面宿主 Node 24 已确认 FTS5 可用）；Node <22.5 或
  `DatabaseSync` 不可用时回退现有 ripgrep，并只告警一次。**不新增原生依赖**。
- 路径：`<kb>/.index/fts.sqlite`（0600，WAL）；`meta` 表存 `schemaVersion/builtAt/manifestUpdatedAt`。
- 表：
  ```sql
  CREATE TABLE docs(id TEXT PRIMARY KEY, title TEXT, standard_no TEXT, year INTEGER,
                    part TEXT, stage TEXT, trust TEXT, updated_at TEXT, version INTEGER);
  CREATE TABLE clauses(id INTEGER PRIMARY KEY, doc_id TEXT, part INTEGER, clause TEXT,
                       heading TEXT, page_start INTEGER, page_end INTEGER,
                       line_start INTEGER, line_end INTEGER, text TEXT, tokens TEXT);
  CREATE VIRTUAL TABLE clauses_fts USING fts5(tokens, clause, heading,
                       content='clauses', content_rowid='id', tokenize='unicode61');
  ```
- 中文分词：`tokens` = `Intl.Segmenter("zh",{granularity:"word"})` 的 word（长度≥2）+
  CJK 二元组 + 数字/标准号拆分；查询同样分词。FTS5 `unicode61` 对整段中文只会切出一个 token，
  必须预分词（已实测）。
- BM25 权重：正文 1.0、heading 2.0、clause 2.5；trust/recency 作为二次 boost：
  `score = bm25 + 0.15*trustScore + 0.05*recency`。
- 索引生命周期：
  - 首次 `kb_query` 或导入完成后 `ensureIndex`：比较 manifest `updatedAt`/每 doc `version`，
    增量 `syncDoc`；坏 DB → 删除重建（best-effort）。
  - `kb_edit`/`kb_add_note`/`kb_remove`/软删除/移动后标脏，下次查询增量同步。
  - 大库首次建索引在后台任务里做，`kb_query` 返回「索引构建中，已回退全文检索」。
- 回退：任何 SQLite 错误都不影响查询；记录 `indexFallback: true` 与 note。

### 8.4 检索与引用输出

- `kb_query` FTS 路径：候选 top 50 → 按 doc 去重（每 doc 最多 3 条）→ 取 `maxMatches`；
  `matches` 保持 `docId/title/path/lineNumber/line/part/pageStart/pageEnd/trust`，
  `lineNumber` 用 clause 的 `lineStart`，`line` 用 snippet；
  `sources` 用 clause/page；`total` 用 FTS 命中数（或 `COUNT(*)` 近似，标注 `estimated`）。
- 现有 `maxMatches` 默认 40 不变；新增 `maxSources=12`、`sourceSnippetChars=160` 配置。
- 标准号查询：继续用 `expandStdQuery` 生成变体，同时在 FTS 查询里加标准号 token；两者取并集。
- 不实现的：向量、rerank、query rewrite（先评估）。

### 8.5 向量/rerank 评估

先离线评估，不先写产品代码：

- 数据集：从真实「标准」库取 60 个问题（条款定位 20、跨文档对比 15、数值/限值 15、
  同义改写 10），人工标 1–3 个正确 clause/doc。
- 对照组：
  - A：现状 ripgrep + rankMatches；
  - B：FTS5 BM25（条款级）；
  - C：B + 标准号别名/trust/recency boost；
  - D：C + bge-m3（或可用的中文 embedding）+ RRF；
  - E：D + bge-reranker-v2-m3 对 top 20 精排。
- 指标：Recall@10、MRR@10、引用正确率（回答中引用是否支撑结论）、p95 延迟、索引体积。
- 门槛（建议）：
  - B 相对 A Recall@10 +15% 且 p95 < 200ms → 0.27 默认启用 B；
  - D 相对 C Recall@10 +10% 且 p95 < 500ms、索引 < 200MB/千篇 → 再评估引入 embedding；
  - E 相对 D 引用正确率 +10% 且 p95 < 1s → 再评估 rerank；
  - 任一不达标 → 不做，避免为小库增加重依赖。
- 结论先写进 `docs/specs/2026-10-25-retrieval-eval.md`（后续），本轮只在本文给方案。

### 8.6 Token 预算与引用格式

| 输出 | 默认 | 硬上限 | 说明 |
|---|---|---|---|
| `kb_query` matches | 40 | 500 | 保持现有参数 |
| `kb_query` sources | 12 | 20 | 每条 ~100 token |
| source snippet | 160 字 | 240 字 | 去换行 |
| `kb_query` 渲染文本 | 8,000 字 | 12,000 字 | 超出截断并提示 |
| `kb_read` maxChars | 20,000 | 200,000 | 保持现有 |
| `kb_read` sources | 1（part） | 20（all） | 每条 ~60 token |
| 正文引用 | 每个结论 1 处 | — | 不堆砌 |

按中文约 1.5 字/token 估算：query 默认约 5–6k token（含 matches+sources），read 默认约 13k token；
超预算时优先保留 sources，截断 matches，并在末尾提示“已截断，请收窄检索词”。

引用格式（写入系统提示与工具 render）：

- 标准：`（《风电场接入电力系统技术规定》GB/T 19963.2-2024 第 5.2.2 条，第 12 页）`；
  标题本身含标准号时省略书名号：`（GB/T 19963.2-2024 第 5.2.2 条，第 12 页）`。
- 多处：`（GB/T 19963.2-2024 第 5.2.2 条，第 12 页；DL/T 587-2025 第 6.1 条，第 20 页）`。
- 无页码：省略“第 N 页”；无条款：用“第 N 部分”。
- 笔记：`（笔记《…》，第 3 页）`。
- `deepLink` 只给 UI 用，不写进回答正文；正文引用用文档标题 + 标准号 + 条款 + 页码。

## 9. 兼容性与迁移

- **schema v6**：旧 v5 清单可读；首次写入备份 `kb.json.v5.bak`；未知字段保留。
- **summarySource**：旧值 `model/auto/""` 不变；新 `manual` 只在 API/UI 写入。
- **工具输出**：`sources`、`standardNo` 等字段 additive；旧断言/旧模型忽略即可。
- **去重**：同库行为不变（仍跳过）；跨库默认不变；新增 `matchKind` 字段。
- **上传 UI**：文案变化（“已上传” → “已上传，待解析”等），状态机新增 `empty`；旧 job 无 `stage`
  时回退 `status`。
- **索引**：默认关闭/惰性；没有 `.index/` 时行为与 0.25 完全一致。
- **版本**：0.26.0（#1+#2+#3），#4 设计不改版本；README/spec/plan 同步。
- **回滚**：#1/#2 数据字段 additive，旧代码读新清单会忽略新字段；#3 客户端 slot 注册失败自动降级。

## 10. 风险与已知限制

- **标准号解析误判**：`extractStdRef` 对非标准标题可能误抓编号；用 `standardPrefix` 白名单 +
  `canonicalTitle` 只在开头匹配，回填 dry-run 人工抽检。
- **封面 OCR 误读**：正文优先能纠正文件名，但扫描件 OCR 也可能把 `GB/T` 读成 `GB` 或读错年份；
  `parseContentStandard` 只接受 high/medium，低置信回退文件名并写 warning；`std-family` 只作回退，
  报告 `matchKind` 供人工核对。同库暂不支持强制导入（保持 0.25 规则）。
- **textHash 后置**：需要先解析才能判重，重复大文件仍会消耗一次解析时间；这是“字节不同、正文相同”
  的必要成本。上传批次可先按 sourceHash/std 拦截大部分。
- **SQLite 可用性**：Node 20 无 `node:sqlite`；回退 rg。桌面/CLI 当前 Node 24/26 已确认 FTS5。
- **中文分词**：`Intl.Segmenter` 对标准术语/生僻词可能切错；用二元组 + 标准号 token 兜底，
  评估集必须包含术语查询。
- **宿主 slot 兼容**：DSH 0.2.1 的 tool/turnTail 契约可能随版本变；用特性探测 + 失败不渲染，
  并锁 peerDependencies 范围。
- **合成 session E2E**：依赖 DSH session v4 格式；只放在 E2E，不进入产品；格式升级时同步 fixture。
- **人工摘要被模型覆盖**：显式 `kb_describe` 仍可改 manual 摘要（来源变 model）；导入不会。
  如需要“人工锁定”，后续加 `summaryLocked`，本轮不做。

## 11. 实施阶段（确认后写详细 plan）

1. **Task 0：运行时 host spike**（#3 的前置，可与 #1 并行）：tool.call.toolview / turnTail /
   presentationMeta / 注入方式；产出日志与截图。
2. **Task 1：schema v6 + `lib/doc-meta.js` + `lib/dedup-index.js`**：纯函数与迁移测试先行。
3. **Task 2：#1 API/store**：`PATCH metadata`、tag 筛选/facets、`summarySource=manual`、测试。
4. **Task 3：#1 UI**：弹窗编辑、标签筛选、ui/api、测试。
5. **Task 4：#2 pipeline/worker/upload**：hash、textHash、去重、markSkipped、上传状态文案、测试。
6. **Task 5：#2 回填 + lint**：脚本、dry-run、真实「标准」库回填、lint 分组、测试。
7. **Task 6：#3 sources/深链/工具视图/面板**：schema、render、presentationMeta、深链、VM 测试。
8. **Task 7：#3 E2E**：深链、合成 session 来源面板、失败降级；全量 `npm test`/`typecheck`/E2E。
9. **Task 8：文档/版本**：README、spec 更新、0.26.0；报告 diff 与测试结果，不 push。
10. **Task 9（只设计）：#4 评估文档**：按 §8.5 落地评估计划，不写实现。

每步先写失败测试→实现→跑该文件测试→最后全量；每阶段结束报告，不跨阶段自动提交/推送。

### 11.1 本轮实施记录（2026-10-25）

- 测试基线 812/812 → 当前 **912**（新增 doc-meta/dedup-index/manifest-v6/import-metadata/
  backfill/lint-metadata/query-sources/deep-link/sources-view/sources-client/ui-doc-meta/
  ui-docs-tag/web-doc-metadata 等）。
- 真实「标准」库（初始 937 篇）已执行：
  `--apply --hash --std --content --text --retitle`：sourceHash 927、结构化标准号 860、
  正文元数据 827、textHash 930、retitle 23、原件缺失跳过 1、错误 0；
  随后 `--apply --trust`：仅 2 篇 unknown 得到 medium。
- 随后追加 `--normalize-titles` 三轮（53/41/22 篇）与标签脚本：当前结构化标准号 869、
  正文元数据 860、标题规范化覆盖全部 904 篇来源文档（裸标准号 0）、871/911 篇有标签；
  用户已彻底删除全部软删除项；当前 0 篇 deleted。
  `GB 19963.2-2024` 与 `GB/T 19963.2-2024…` 均已补全同族标题，`contentIntegrity=full`，
  同标准号索引可命中并跳过新上传。
- lint：metadataMissing 1、contentIncomplete 22、filenameStandardMismatch 7、
  duplicateText 2 组、sameNumberDuplicate 0 组、sameNumberStages 25、sameNumberMultiYear 62、
  sameNumberFamily 7；不自动删除。
- E2E：**10 passed / 0 failed / 1 skipped**。skip 为来源面板用例：CLI 0.1.x 的
  历史投影没有把 `tool/result` 关联到工具行（工具行停在 running），因此无法在 CLI 宿主
  验证来源 chip；工具行/本轮来源/缺 meta 降级由 `test/sources-client.test.mjs` 覆盖，
  桌面/较新宿主跑同一用例时会继续断言。深链、编目、上传状态均真实通过。
- 回填前清单备份在 `/tmp/kb-standard-20261025-before-backfill.json`（本机临时路径，不进仓库）。

## 12. 已确认决策与执行口径（2026-10-25）

1. **版本**：0.26.0 一次包含 #1 + #2 + #3；#4 只写设计，不升版本。
2. **trust**：发布/批准稿 → `medium`；过程稿/说明材料/勘误/Redline → `low`；非标准 → `unknown`；
   已有 `trustSource=manual` 的文档不覆盖。
3. **标准号来源**：标准/书籍可以正文/封面优先，文件名只作回退；**必须同时比较正文完整性**
   （`contentIntegrity/bodyChars/clauseCount`）。`GB 19963.2` 与 `GB/T 19963.2` 两条扫描件
   在解析后按封面 OCR 的 `GB/T 19963.2-2024` 精确命中 `std`；但若任一份只有封面/目录、
   正文缺失，按 §6.4.1 矩阵处理（完整版不被残缺版挡住，残缺版不覆盖完整版）。
   `std-family` 只作为正文不可用时的回退。`standardSource/filenameStandardNo/contentTitle`
   记录审计信息，`kb_lint` 增加 `filename-standard-mismatch` 与 `content-incomplete`。
   **其他资料（通知/台账/图纸/普通 md/txt/note）不做正文/封面优先。**
4. **回填**：先 dry-run 报告（逐类计数/样例/版本变更清单），确认后对真实「标准」库
   `--apply --hash --std --content --text`，再 `--apply --retitle`；只规范标准号/名称形态，
   不改无标准号的业务文档；`--retitle` 走版本/历史/合并版更新。
5. **来源面板 E2E**：合成 session fixture（v4 JSONL，含 `tool/result.data.meta.sources`）；
   fixture 生成器只进 `scripts/e2e`，不进产品包。
6. **assistant 正文角标**：本轮不做。只做 `tool.call.toolview`（kb_query/kb_read）+
   `conversation.chat.turnTail` 本轮来源面板；正文角标等宿主提供非破坏性注解 API 后再做。

执行顺序仍按 §11：先写详细 plan（`docs/plans/2026-10-25-kb-metadata-ingest-sources.md`），
再从 Task 1 开始逐任务 TDD；每阶段报告 diff 与测试，不自动 push/发布。
