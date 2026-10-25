# 知识库 0.26 资料元数据、摄取规范化与引用溯源实施计划

> **给执行者：** 先读 `docs/specs/2026-10-25-kb-metadata-ingest-sources-design.md` 的 §4.3 已确认决策。
> 本计划按用户确认执行：0.26.0 含 #1+#2+#3；#4 只设计；标准/书籍正文/封面优先且必须比较正文完整性；
> 其他资料不 content-first；旧库先 dry-run 再 apply + retitle；来源面板 E2E 用合成 session fixture；
> 本轮不做 assistant 正文角标。
> 执行方式：当前会话内逐任务 TDD；每个 Task 结束跑该范围测试并报告；不 push/发布。

> **执行状态（2026-10-25）：** 已完成 #1 编目/标签、#2 摄取规范化与回填、#3 结构化来源/深链；
> #4 已交付条款切分/FTS5 核心并接入 kb_query；单元测试 **912/912**；E2E **10 passed / 0 failed / 1 skipped**
> （skip 为来源面板：CLI 0.1.x 历史投影不关联 `tool/result`；单测覆盖渲染/降级）。
> 真实「标准」库已 dry-run → apply → retitle → trust，详见设计文档 §11.1。
> 版本已升 0.26.0；未 push/发布。

**Goal:** 让资料可人工编目/按标签筛选，导入时记录可审计的标准元数据与内容指纹并正确去重，工具返回结构化来源与可点击深链，同时给出条款级 FTS5 检索设计。

**Architecture:** 新增纯函数层 `lib/doc-meta.js`（标题/标准号/正文完整性/trust）与 `lib/dedup-index.js`（去重键与匹配矩阵）；schema v6 只增字段，旧清单惰性迁移；`kb_query`/`kb_read` 输出 additive `sources`，客户端通过 `tool.call.toolview` + `turnTail` 渲染；检索索引不进入 0.26 实现。

**Tech Stack:** Node.js ESM、`node:test`、现有 `store.js`/`pipeline.js`/`web/api.js`/静态工作台 UI、React 18（宿主 external）、esbuild、Playwright E2E。

---

## 文件结构

```text
lib/doc-meta.js              新：标准要素/内容标准号/正文完整性/标题规范化/trust 启发式/textHash 规范化
lib/dedup-index.js           新：去重索引与 matchCandidate（含 §6.4.1 完整性矩阵）
lib/backfill.js              新：旧库回填（纯函数 + 写 manifest）
lib/store.js                 改：SCHEMA_VERSION 6、文档字段归一、commitDoc 元数据、markSkipped/importingFrom
lib/pipeline.js              改：sourceHash 复用、content meta、textHash、去重跳过、markSkipped
lib/import-job.js            改：worker 参数透传 dedup
worker/import-worker.mjs     改：stage/reason、dedup 索引、跳过状态
lib/web/http.js              改：readRawToFile 返回 hash
lib/web/upload.js            改：批次 hash、导入报告 matchKind/reason
lib/web/data.js              改：readDoc/listDocs 新字段、tag 筛选、facets
lib/web/api.js               改：PATCH metadata 路由
lib/kbmeta.js                不变（库级元数据与文档元数据分开）
lib/lint.js                  改：结构化标准号、metadata-missing、duplicate-text、content-incomplete、mismatch
lib/query.js                 改：sources 辅助（page/clause/deepLink）与渲染预算；FTS 设计不改
lib/index.js                 改：kb_query/kb_read sources、presentationMeta、系统提示引用格式、kb_describe 兼容
ui/views/doc-meta.js         新：摘要/标签归一化与 patch 构造
ui/views/sources.js          新：sources 渲染/去重/链接（工作台与客户端共用纯函数）
ui/deep-link.js              新：?doc=&page= 解析与 page fragment
ui/api.js                    改：patchDocMetadata、docs tag、tags facets
ui/app.js                    改：docs tag 状态、深链启动、弹窗编辑刷新
ui/docs-controls.js          改：tag 变更重载
ui/views/detail.js           改：标签筛选/行内标签
ui/views/modals.js           改：可编辑摘要/标签、来源徽标、initialPage
ui/upload-core.js            改：阶段文案/全重复 empty/逐文件 reason
ui/views/upload.js           改：上传≠解析文案
src/client/index.tsx         改：tool views + turnTail 来源面板
lib/client.js                改：esbuild 构建产物
scripts/backfill-doc-meta.mjs 新：CLI（dry-run 默认；含 --normalize-titles）
scripts/tag-doc-library.mjs   新：标准层级/主题标签批处理（dry-run 默认）
lib/tagging.js                新：标签分类纯函数
lib/clauses.js                新：条款级分块（FTS 输入，已接入测试）
lib/fts-index.js              新：SQLite FTS5/BM25 索引核心（尚未替换 kb_query）
scripts/e2e/session-fixture.mjs 新：合成 session JSONL
scripts/e2e/tests/metadata.mjs / upload.mjs / deep-link.mjs / sources.mjs 新
scripts/e2e/host.mjs / run.mjs 改：beforeStart、workspace/session fixture、E2E_ONLY
test/*                       新/改见各 Task
README.md / docs/specs / docs/plans / package.json / lib/version.js 改
```

---

## Task 0: 基线、分支与运行时 host spike

**Files:** 无代码；产出 `.acceptance/` 日志/截图（临时）。

- [ ] **Step 0.1: 确认基线**

Run:
```bash
cd /Users/littlesun/.dsh/plugins/dsh-knowledge-base
git status --short
npm test 2>&1 | tail -8
```
Expected: 只有本 spec/plan 的未跟踪文件；`tests 812`、`pass 812`、`fail 0`。

- [ ] **Step 0.2: host spike（与 Task 1 并行）**

用临时 profile + 临时 kbRoot 插入探针插件，注册：
- `tool.call.toolview` key `kb_query`，把 `phase`、`block.meta`、`block.content` 的 keys 写 JSONL；
- `conversation.chat.turnTail` id `kb-sources-probe`，把 `turn`/`seq` 的 keys 写 JSONL；
- 用真实模型轮次或 Task 8 的合成 session 触发一次 `kb_query`。

Record: `.acceptance/2026-10-25-sources-spike.jsonl` + `.png`。若 `turn` 字段名与设计不符，先改 §7.1 再写代码。
Expected: 能拿到 `block.meta.sources`；`turnTail` 能按 turn 聚合 tool 节点。拿不到则停止 Task 9，先报告。

---

## Task 1: `lib/doc-meta.js` 纯函数

**Files:**
- Create: `lib/doc-meta.js`
- Create: `test/doc-meta.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeTitle, parseContentStandard, parseDocMeta, parseCoverTitle,
  textFingerprint, trustHeuristic, contentIntegrityFor,
} from "../lib/doc-meta.js";

test("parseDocMeta 解析 DL/T 587—2025+ 标题并规范化", () => {
  const meta = parseDocMeta("DL/T587—2025+继电保护和安全自动装置运行管理规程", "DLT587—2025+继电保护和安全自动装置运行管理规程");
  assert.equal(meta.standardPrefix, "DL/T");
  assert.equal(meta.standardNumber, "587");
  assert.equal(meta.standardYear, 2025);
  assert.equal(meta.standardNo, "DL/T 587-2025");
  assert.equal(meta.canonicalTitle, "DL/T 587-2025 继电保护和安全自动装置运行管理规程");
  assert.equal(meta.standardSource, "filename");
});

test("parseDocMeta 解析 GB/T 19963.2 与部分号", () => {
  const meta = parseDocMeta("GB/T 19963.2-2024 风电场接入电力系统技术规定 第2部分：海上风电");
  assert.equal(meta.standardBase, "19963");
  assert.equal(meta.standardPart, "2");
  assert.equal(meta.standardNo, "GB/T 19963.2-2024");
  assert.equal(meta.stage, "published");
});

test("parseDocMeta 识别报批稿（括号内）", () => {
  const meta = parseDocMeta("DL/T 587—2025 继电保护和安全自动装置运行管理规程（报批稿）");
  assert.equal(meta.stage, "draft");
  assert.equal(meta.stageLabel, "报批稿");
});

test("parseContentStandard 从封面正文识别 GB/T 19963.2", () => {
  const content = parseContentStandard(`
中华人民共和国国家标准
GB/T 19963.2-2024
风电场接入电力系统技术规定 第2部分：海上风电
2024-09-29 发布
`);
  assert.equal(content.standardNo, "GB/T 19963.2-2024");
  assert.equal(content.contentTitle, "风电场接入电力系统技术规定 第2部分：海上风电");
  assert.equal(content.confidence, "high");
});

test("parseContentStandard 不接受正文条款号当标准号", () => {
  const content = parseContentStandard("5.2.2 继电保护装置应满足以下要求。\n6.1 试验方法。");
  assert.equal(content, null);
});

test("contentIntegrityFor 区分 full/partial/cover-only", () => {
  const full = contentIntegrityFor({ sections: [{ page: 1, text: "封面" }, { page: 2, text: "5.1 正文".repeat(200) }] });
  assert.equal(full.integrity, "full");
  const cover = contentIntegrityFor({ sections: [{ page: 1, text: "GB/T 19963.2-2024 封面" }] });
  assert.equal(cover.integrity, "cover-only");
});

test("trustHeuristic：发布→medium，过程稿→low，非标准→unknown", () => {
  assert.deepEqual(trustHeuristic({ stage: "published", standardNo: "GB/T 1-2020" }), {
    trust: "medium", reason: "已发布标准，尚未核实现行/废止",
  });
  assert.equal(trustHeuristic({ stage: "draft", standardNo: "GB/T 1-2020" }).trust, "low");
  assert.equal(trustHeuristic({}).trust, "unknown");
});

test("textFingerprint 忽略空白/注释且稳定", () => {
  const a = textFingerprint([{ heading: "5.1", text: "正文  内容\n" }]);
  const b = textFingerprint([{ heading: "5.1", text: "正文 内容" }]);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("parseCoverTitle 用于 epub/mobi 书籍", () => {
  const book = parseCoverTitle("电力系统分析\n第一章 绪论\n正文…");
  assert.equal(book.title, "电力系统分析");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/doc-meta.test.mjs`
Expected: FAIL `Cannot find module '../lib/doc-meta.js'`。

- [ ] **Step 3: 实现 `lib/doc-meta.js`**

```js
/**
 * 资料身份元数据：标题规范化、标准要素、正文/封面标准号、正文完整性、trust 启发式。
 * 纯函数，不读盘；标题/标准号口径只有这一处。
 */
import { createHash } from "node:crypto";
import { extractStdRef, familyOf } from "./standards.js";
import { stageOf } from "./lint.js";
import { cleanTitle } from "./titles.js";

const STAGE_KEYS = {
  发布稿: "published", 正式版: "published", 批准稿: "approved",
  报批稿: "draft", 征求意见稿: "comment", 送审稿: "review",
  讨论稿: "discussion", 草案: "plan", 说明材料: "notes", 编制说明: "notes",
  "Redline版": "redline", 勘误版: "errata", "SASO版": "variant",
};

export function stageKeyOf(label) {
  return STAGE_KEYS[String(label ?? "")] ?? "unknown";
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 标准号规范：前缀+空格+编号+年份，分隔符统一 -。 */
function canonicalStdHead(ref) {
  return `${ref.prefix} ${ref.number}${ref.year != null ? `-${ref.year}` : ""}`;
}

/** 把“DL/T587—2025+名称”整理成“DL/T 587-2025 名称”。 */
export function canonicalizeTitle(title) {
  const cleaned = cleanTitle(title);
  const ref = extractStdRef(cleaned);
  if (!ref) return cleaned;
  const head = canonicalStdHead(ref);
  const re = new RegExp(
    `^${escapeRe(ref.prefix)}\\s*${escapeRe(ref.number)}\\s*(?:[-\\u2013\\u2014~～]\\s*${ref.year ?? "\\d{4}"})?\\s*[+＋]?\\s*`,
    "i"
  );
  if (!re.test(cleaned)) return cleaned;
  const rest = cleaned.replace(re, "").trim();
  return (rest ? `${head} ${rest}` : head).slice(0, 200);
}

export function titleKey(title) {
  return String(title ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000\-—_/\\:：,，。.、；;？?！!（）()【】\[\]《》〈〉「」『』"'“”‘’·•…]/g, "");
}

export function parseDocMeta(title, rawTitle = title) {
  const raw = String(rawTitle ?? title ?? "").trim();
  const canonical = canonicalizeTitle(raw);
  const ref = extractStdRef(canonical);
  const stageLabel = stageOf(String(title ?? raw));
  const stage = stageKeyOf(stageLabel);
  if (!ref) {
    return {
      rawTitle: raw, canonicalTitle: canonical,
      standardSource: "none", filenameStandardNo: "",
      standardPrefix: "", standardNumber: "", standardBase: "", standardYear: null, standardPart: null,
      standardNo: "", stage, stageLabel, isDraft: stage === "draft" || stage === "comment",
      titleKey: titleKey(canonical),
    };
  }
  const number = String(ref.number);
  const partFromNumber = /\.(\d+)$/.test(number) ? number.replace(/^.*\./, "") : null;
  const partFromTitle = /第\s*([一二三四五六七八九十百零〇两\d]+)\s*(部分|分册|册)/.exec(String(title ?? ""));
  const standardPart = partFromNumber ?? (partFromTitle ? String(partFromTitle[1]) : null);
  const standardBase = number.replace(/\.\d+$/, "");
  const standardNo = canonicalStdHead(ref);
  return {
    rawTitle: raw, canonicalTitle: canonical,
    standardSource: "filename", filenameStandardNo: standardNo,
    standardPrefix: ref.prefix, standardNumber: number, standardBase,
    standardYear: ref.year ?? null, standardPart,
    standardNo, stage, stageLabel, isDraft: ref.isDraft,
    titleKey: titleKey(canonical),
  };
}

const CONTENT_STD = /(?:Q\/GDW|GB\/T|GB\/Z|GB|DL\/T|NB\/T|NB|JB\/T|TB\/T|IEC\/TS|IEC|IEEE|ISO)\s*[\d.]+(?:\s*[-—–~]\s*(?:19|20)\d{2})?/gi;
const BAD_TITLE_LINE = /^(?:中华人民共和国|国家标准|行业标准|代替|ICS|CCS|发布|实施|前言|目\s*次|目\s*录|标准号|Standard)/;

function textFromSections(input) {
  if (typeof input === "string") return input;
  const sections = Array.isArray(input?.sections) ? input.sections : Array.isArray(input) ? input : [];
  return sections.map((s) => `${s.heading ?? ""}\n${s.text ?? ""}`).join("\n");
}

export function parseContentStandard(input, { maxChars = 8000 } = {}) {
  const text = textFromSections(input).slice(0, maxChars).replace(/[０-９Ａ-Ｚａ-ｚ]/g,
    (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!text.trim()) return null;
  const candidates = [...text.matchAll(CONTENT_STD)]
    .map((m) => ({ raw: m[0], index: m.index ?? 0 }))
    .filter((c) => c.index < Math.min(maxChars, 5000));
  if (candidates.length === 0) return null;
  // 取最靠前、且后文不像条款号的候选；优先含年份的
  candidates.sort((a, b) => (b.raw.match(/(19|20)\d{2}/) ? 1 : 0) - (a.raw.match(/(19|20)\d{2}/) ? 1 : 0) || a.index - b.index);
  for (const cand of candidates) {
    const lineStart = text.lastIndexOf("\n", cand.index) + 1;
    const lineEnd = text.indexOf("\n", cand.index);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim();
    if (line.length > 80) continue;
    const ref = extractStdRef(line);
    if (!ref) continue;
    const after = text.slice(lineEnd < 0 ? text.length : lineEnd + 1).split("\n").map((s) => s.trim()).filter(Boolean);
    const titleLine = after.find((l) => l.length >= 2 && l.length <= 80 && !BAD_TITLE_LINE.test(l) && !/^\d+(?:\.\d+)+\s/.test(l));
    const contentTitle = titleLine && !/^(GB|DL|NB|IEC|IEEE|ISO)\b/i.test(titleLine) ? titleLine : "";
    const stageLabel = stageOf(text.slice(0, 3000));
    return {
      standardPrefix: ref.prefix, standardNumber: String(ref.number),
      standardBase: String(ref.number).replace(/\.\d+$/, ""),
      standardYear: ref.year ?? null,
      standardPart: /\.(\d+)$/.test(String(ref.number)) ? String(ref.number).replace(/^.*\./, "") : null,
      standardNo: canonicalStdHead(ref),
      stage: stageKeyOf(stageLabel), stageLabel, contentTitle,
      confidence: ref.year ? "high" : "medium",
    };
  }
  return null;
}

export function parseCoverTitle(input, { maxChars = 3000 } = {}) {
  const text = textFromSections(input).slice(0, maxChars);
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean)
    .filter((l) => l.length >= 2 && l.length <= 80 && !BAD_TITLE_LINE.test(l));
  return lines[0] ? { title: lines[0], confidence: "medium" } : null;
}

function bodySections(input) {
  const sections = Array.isArray(input?.sections) ? input.sections : [];
  if (sections.length <= 2) return sections;
  return sections.slice(2);
}

export function contentIntegrityFor(input) {
  const sections = Array.isArray(input?.sections) ? input.sections : [];
  const body = bodySections(input);
  const bodyChars = body.reduce((n, s) => n + String(s.text ?? "").length, 0);
  const clauseCount = body.reduce((n, s) => n + (String(s.text ?? "").match(/(?:^|\n)\s*(?:\d+(?:\.\d+){1,4}|第[一二三四五六七八九十百]+[章节篇]|附录\s*[A-Z])/g) ?? []).length, 0);
  const pages = sections.map((s) => Number(s.page) || 0).filter((n) => n > 0);
  const pagesWithText = new Set(pages).size;
  let integrity = "unknown";
  if (bodyChars >= 1000 && (clauseCount >= 3 || bodyChars >= 5000)) integrity = "full";
  else if (bodyChars >= 200) integrity = "partial";
  else if (sections.some((s) => String(s.text ?? "").trim())) integrity = "cover-only";
  if (pages.length > 0 && pagesWithText / pages.length < 0.2) integrity = integrity === "full" ? "partial" : integrity;
  return { integrity, bodyChars, clauseCount, pagesWithText };
}

export function textFingerprint(input) {
  const sections = Array.isArray(input) ? input : Array.isArray(input?.sections) ? input.sections : [];
  const normalized = sections.map((s) => `${s.heading ?? ""}\n${s.text ?? ""}`).join("\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function trustHeuristic(meta) {
  if (!meta?.standardNo) return { trust: "unknown", reason: "" };
  if (["draft", "comment", "review", "discussion", "plan", "notes", "redline", "errata", "variant"].includes(meta.stage)) {
    return { trust: "low", reason: "过程稿/说明材料/勘误（非现行发布版）" };
  }
  if (meta.stage === "published" || meta.stage === "approved") {
    return { trust: "medium", reason: "已发布标准，尚未核实现行/废止" };
  }
  return { trust: "unknown", reason: "" };
}
```

- [ ] **Step 4: 跑测试**

Run: `node --test test/doc-meta.test.mjs`
Expected: PASS（若 `stageOf`/`cleanTitle` 行为不符，先修实现而不是改断言；断言是 spec 口径）。

- [ ] **Step 5: 全量回归**

Run: `npm test 2>&1 | tail -8`
Expected: 812 + 新增用例全绿；`check:client`/`check-ui` 通过。

---

## Task 2: schema v6、store 字段与摘要优先级

**Files:**
- Modify: `lib/store.js`（SCHEMA_VERSION、migrateManifest、commitDoc、markImporting/markSkipped）
- Create: `test/manifest-v6.test.mjs`
- Create: `test/import-metadata.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/manifest-v6.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, readManifest } from "../lib/store.js";

test("v5 manifest lazily migrates to v6 with new fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-v6-"));
  const dir = join(root, "库");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "kb.json"), JSON.stringify({
    schemaVersion: 5, name: "库", docs: [{ id: "d1", title: "标题", status: "ready", version: 1, sourceHash: "h" }],
  }), "utf8");
  const manifest = await readManifest(dir);
  assert.equal(SCHEMA_VERSION, 6);
  const doc = manifest.docs[0];
  assert.equal(doc.rawTitle, "标题");
  assert.equal(doc.canonicalTitle, "标题");
  assert.equal(doc.summarySource, "");
  assert.equal(doc.trustSource, "manual"); // sourceHash 存在但 trust 未知？这里 trust 默认 unknown
  assert.equal(await readFile(join(dir, "kb.json"), "utf8").then((s) => JSON.parse(s).schemaVersion), 5);
  await rm(root, { recursive: true, force: true });
});
```

把 `trustSource` 的期望按实际口径改为：`trust==="unknown"` → `"unknown"`。同时写 `commitDoc` 保留 manual/model 摘要的测试：

```js
test("reimport preserves manual summary and manual trust", async () => {
  // 用 importFileInto 导两次：第二次不同内容；第一次通过 updateDocMetaLocked 写 manual
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/manifest-v6.test.mjs test/import-metadata.test.mjs`
Expected: FAIL `SCHEMA_VERSION` 仍是 5 / 字段缺失。

- [ ] **Step 3: 实现 store 改动**

`lib/store.js`：
1. `SCHEMA_VERSION = 6`；
2. `migrateManifest` 的 doc 归一增加：

```js
rawTitle: typeof doc.rawTitle === "string" ? doc.rawTitle : (typeof doc.title === "string" ? doc.title : ""),
canonicalTitle: typeof doc.canonicalTitle === "string" ? doc.canonicalTitle : (typeof doc.title === "string" ? doc.title : ""),
standardNo: typeof doc.standardNo === "string" ? doc.standardNo : "",
standardPrefix: typeof doc.standardPrefix === "string" ? doc.standardPrefix : "",
standardNumber: typeof doc.standardNumber === "string" ? doc.standardNumber : "",
standardBase: typeof doc.standardBase === "string" ? doc.standardBase : "",
standardYear: Number.isFinite(doc.standardYear) ? doc.standardYear : null,
standardPart: doc.standardPart == null ? null : String(doc.standardPart),
standardSource: ["content", "filename", "none"].includes(doc.standardSource) ? doc.standardSource : "none",
filenameStandardNo: typeof doc.filenameStandardNo === "string" ? doc.filenameStandardNo : "",
contentTitle: typeof doc.contentTitle === "string" ? doc.contentTitle : "",
contentIntegrity: ["full", "partial", "cover-only", "unknown"].includes(doc.contentIntegrity) ? doc.contentIntegrity : "unknown",
bodyChars: Number.isFinite(doc.bodyChars) ? doc.bodyChars : 0,
clauseCount: Number.isFinite(doc.clauseCount) ? doc.clauseCount : 0,
textHash: typeof doc.textHash === "string" ? doc.textHash : "",
textHashAlgo: typeof doc.textHashAlgo === "string" ? doc.textHashAlgo : "",
stage: typeof doc.stage === "string" ? doc.stage : "unknown",
stageLabel: typeof doc.stageLabel === "string" ? doc.stageLabel : "",
trustSource: ["manual", "heuristic", "unknown"].includes(doc.trustSource)
  ? doc.trustSource
  : (doc.trust && doc.trust !== "unknown" ? "manual" : "unknown"),
metadataUpdatedAt: typeof doc.metadataUpdatedAt === "string" ? doc.metadataUpdatedAt : "",
```

3. `commitDoc` payload 增加这些字段，并写入 entry；摘要覆盖按优先级：

```js
const rank = (source) => ({ manual: 3, model: 2, auto: 1, "": 0 })[source] ?? 0;
const prevSource = prev?.summarySource ?? "";
const nextSource = summarySource ?? "";
const keepPrevSummary = rank(prevSource) > rank(nextSource);
summary: keepPrevSummary ? (prev.summary ?? "") : (summary ?? prev?.summary ?? ""),
summarySource: keepPrevSummary ? prevSource : (nextSource || prevSource),
trust: prev?.trustSource === "manual" ? prev.trust : (prev?.trust ?? "unknown"),
trustReason: prev?.trustSource === "manual" ? prev.trustReason : (prev?.trustReason ?? ""),
trustSource: prev?.trust ?? "unknown" ?? "",
```

（实际实现以“prev.trustSource=manual 保留；否则保留 prev 的 trust/trustSource”为准；不要误写。）

4. `markImporting` 增加 `importingFrom` 快照；`commitDoc`/`markFailed` 删除；新增：

```js
export async function markSkipped(dir, docId) {
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    const idx = manifest.docs.findIndex((d) => d.id === docId);
    if (idx < 0) return;
    const doc = manifest.docs[idx];
    const prev = doc.importingFrom;
    if (!prev || (prev.status == null && !prev.deletedAt)) {
      // 新文档的占位：没有版本/历史就移除
      if ((doc.version ?? 0) === 0 || (prev?.new === true)) manifest.docs.splice(idx, 1);
      else delete doc.importingFrom;
    } else {
      if (prev.status) doc.status = prev.status; else delete doc.status;
      if (prev.deletedAt) doc.deletedAt = prev.deletedAt; else delete doc.deletedAt;
      if (prev.deletedFromStatus) doc.deletedFromStatus = prev.deletedFromStatus; else delete doc.deletedFromStatus;
      if (prev.error) doc.error = prev.error; else delete doc.error;
      delete doc.importingFrom;
    }
    await writeManifestAtomic(dir, manifest);
  });
}
```

`markImporting` 里：

```js
...(prev ? { importingFrom: {
  status: prev.status ?? null,
  deletedAt: prev.deletedAt ?? null,
  deletedFromStatus: prev.deletedFromStatus ?? null,
  error: prev.error ?? null,
  new: false,
} } : { importingFrom: { new: true } }),
```

- [ ] **Step 4: 跑测试**

Run: `node --test test/manifest-v6.test.mjs test/import-metadata.test.mjs test/manifest-v5.test.mjs`
Expected: v6 新测试 PASS；旧 v5 断言按版本号更新（`SCHEMA_VERSION` 期望 6）。

- [ ] **Step 5: 全量**

Run: `npm test 2>&1 | tail -8`
Expected: 全绿；`manifest-v5.test.mjs` 已改为断言 6 或新增 v6 测试。

---

## Task 3: `lib/dedup-index.js` 与 §6.4.1 矩阵

**Files:**
- Create: `lib/dedup-index.js`
- Create: `test/dedup-index.test.mjs`

- [ ] **Step 1: 写失败测试**

至少覆盖：
- 同 `sourceHash` → skip；
- 正文 `GB/T` 与文件名 `GB` 同号同年同部分同阶段 → `std` skip；
- 同号不同阶段（comment vs published）→ 不 skip；
- 同号不同年份/部分 → 不 skip；
- 新 full + 旧 cover-only → 不 skip，`replacesIncomplete`；
- 新 cover-only + 旧 full → skip `existing-full`；
- 跨库 allowCrossKb 行为；
- title exact/prefix。

```js
test("same family draft vs published is not a duplicate", () => {
  const idx = buildDedupIndex([{ kb: "标准", id: "a", title: "GB/T 1-2020", status: "ready",
    standardNo: "GB/T 1-2020", standardPrefix: "GB/T", standardBase: "1", standardYear: 2020,
    standardPart: null, stage: "published", contentIntegrity: "full" }], { targetKb: "标准" });
  const hits = matchCandidate(idx, { title: "GB/T 1-2020（报批稿）", standardNo: "GB/T 1-2020",
    standardPrefix: "GB/T", standardBase: "1", standardYear: 2020, stage: "draft" });
  assert.equal(hits.length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/dedup-index.test.mjs`
Expected: FAIL module missing。

- [ ] **Step 3: 实现 `lib/dedup-index.js`**

```js
/**
 * 去重索引：只认 manifest 字段 + 解析后的候选元数据。
 * 同库 always skip；跨库 allowCrossKb 时放行；std 命中按 §6.4.1 比较正文完整性。
 */
import { familyOf } from "./standards.js";
import { canonicalizeTitle, parseDocMeta } from "./doc-meta.js";

const READY = (doc) => doc && (!doc.status || doc.status === "ready") && doc.type !== "note";

export function docIdentity(doc) {
  if (doc.standardNo) return doc;
  const meta = parseDocMeta(doc.title ?? "", doc.rawTitle ?? doc.title ?? "");
  return { ...doc, ...meta, standardNo: meta.standardNo, stage: meta.stage };
}

export function stdKey(meta) {
  return meta.standardNo
    ? `${meta.standardPrefix}\0${meta.standardBase}\0${meta.standardYear ?? ""}\0${meta.standardPart ?? ""}\0${meta.stage}`
    : "";
}
export function familyKey(meta) {
  return meta.standardNo
    ? `${familyOf(meta.standardPrefix)}\0${meta.standardBase}\0${meta.standardYear ?? ""}\0${meta.standardPart ?? ""}\0${meta.stage}`
    : "";
}

export function buildDedupIndex(docs, { targetKb } = {}) {
  const index = { bySourceHash: new Map(), byTextHash: new Map(), byStdKey: new Map(), byFamilyKey: new Map(), byTitleKey: new Map(), targetKb };
  for (const raw of docs ?? []) {
    if (!READY(raw)) continue;
    const doc = docIdentity(raw);
    const push = (map, key, value) => {
      if (!key) return;
      const arr = map.get(key) ?? [];
      arr.push(value);
      map.set(key, arr);
    };
    const entry = { ...doc, sameKb: doc.kb === targetKb };
    push(index.bySourceHash, doc.sourceHash, entry);
    push(index.byTextHash, doc.textHash, entry);
    push(index.byStdKey, stdKey(doc), entry);
    push(index.byFamilyKey, familyKey(doc), entry);
    push(index.byTitleKey, doc.titleKey ?? parseDocMeta(doc.title ?? "").titleKey, entry);
  }
  return index;
}

function integrityRank(value) { return value === "full" ? 3 : value === "partial" ? 2 : value === "cover-only" ? 1 : 0; }

export function matchCandidate(index, candidate) {
  const meta = candidate.standardNo ? candidate : parseDocMeta(candidate.title ?? "", candidate.rawTitle ?? candidate.title ?? "");
  const hits = [];
  const add = (kind, doc) => {
    if (doc.id === candidate.docId) return;
    hits.push({
      kb: doc.kb, dir: doc.dir ?? doc.kb, id: doc.id, title: doc.title, kind,
      sameKb: doc.kb === index.targetKb,
      contentIntegrity: doc.contentIntegrity ?? "unknown",
    });
  };
  for (const doc of index.bySourceHash.get(candidate.sourceHash) ?? []) add("source-hash", doc);
  for (const doc of index.byTextHash.get(candidate.textHash) ?? []) add("text-hash", doc);
  for (const doc of index.byStdKey.get(stdKey(meta)) ?? []) add("std", doc);
  if (!hits.some((h) => h.kind === "std")) {
    for (const doc of index.byFamilyKey.get(familyKey(meta)) ?? []) add("std-family", doc);
  }
  if (!meta.standardNo) {
    for (const doc of index.byTitleKey.get(meta.titleKey) ?? []) add("title-exact", doc);
  }
  // 去重：同 id/kind 一次
  const seen = new Set();
  return hits.filter((h) => {
    const key = `${h.kind}\0${h.kb}\0${h.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * §6.4.1 决策：返回 { skip, reason, replacesIncomplete }。
 * 非 std 命中直接 skip（同库/跨库规则由调用方先处理 allowCrossKb）。
 */
export function decideDuplicate(hits, candidate, { allowCrossKb = false } = {}) {
  if (hits.length === 0) return { skip: false, reason: "", replacesIncomplete: false };
  const exact = hits.find((h) => h.kind === "source-hash") ?? hits.find((h) => h.kind === "text-hash");
  if (exact) return { skip: true, reason: "duplicate", match: exact };
  const std = hits.filter((h) => h.kind === "std" || h.kind === "std-family");
  const pick = std[0] ?? hits[0];
  if (!std.length) return { skip: true, reason: "duplicate", match: pick };
  const candidateRank = integrityRank(candidate.contentIntegrity);
  const existingRank = integrityRank(pick.contentIntegrity);
  const cross = !pick.sameKb;
  if (cross && allowCrossKb) return { skip: false, reason: "", match: pick };
  if (candidateRank >= 3 && existingRank < 3) {
    return { skip: false, reason: "replaces-incomplete", replacesIncomplete: true, match: pick };
  }
  if (candidateRank < 3 && existingRank >= 3) {
    return { skip: true, reason: "existing-full", match: pick };
  }
  if (candidateRank < 3 && existingRank < 3) {
    return { skip: true, reason: "both-incomplete", match: pick };
  }
  return { skip: true, reason: "duplicate", match: pick };
}
```

- [ ] **Step 4: 跑测试**

Run: `node --test test/dedup-index.test.mjs`
Expected: PASS。

- [ ] **Step 5: 全量**

Run: `npm test 2>&1 | tail -8`
Expected: 旧 `dedup.test.mjs` 仍绿；若 `titleKeys` 被移除，保留兼容导出或改测试。

---

## Task 4: #1 API/Store：metadata 与 tag

**Files:**
- Modify: `lib/web/data.js`、`lib/web/api.js`
- Create: `test/web-doc-metadata.test.mjs`
- Modify: `test/web-docs-search.test.mjs`（tag/facets 兼容）

- [ ] **Step 1: 写失败测试**

```js
test("PATCH metadata writes manual summary and tags", async () => {
  // 起 registerKbWeb（复用 web-api-write.test.mjs 的 helper）
  const res = await patch("/kbs/标准/docs/d1/metadata", {
    summary: "  人工摘要  ", tags: ["#并网", "海上风电", "并网"],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.doc.summary, "人工摘要");
  assert.equal(res.body.doc.summarySource, "manual");
  assert.deepEqual(res.body.doc.tags, ["并网", "海上风电"]);
  assert.equal("version" in res.body.doc, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/web-doc-metadata.test.mjs`
Expected: 404 NOT_FOUND（路由未实现）。

- [ ] **Step 3: 实现**

`lib/web/data.js`：
- `listDocs` 返回 `summarySource`、`metaUpdatedAt`、`standardNo/Year/Part/Stage`；
- 增加 `tag` 过滤（在 query 之后、trust/type 之前），返回 `tag` 与 `facets.tags`；
- `readDoc` 增加同样字段 + `standardSource/contentTitle/standardPart`。

`lib/web/api.js` 在 `segments.length===5 && segments[2]==="docs" && segments[4]==="metadata" && method==="PATCH"`：

```js
const { name, dir } = ensureKb(opts, segments[1]);
const body = await readJsonBody(req);
const manifest = await readManifest(dir);
const doc = (manifest.docs ?? []).find((d) => d.id === segments[3]);
if (!doc) throw new KbError("DOC_NOT_FOUND", 404, "文档不存在");
if (doc.status === "importing") throw new KbError("DOC_IMPORTING", 409, "文档正在导入，暂不能编目");
if (isDeleted(doc)) throw new KbError("DOC_DELETED", 409, "文档已删除");
const patch = {};
if (body.summary !== undefined) {
  if (body.summary !== null && typeof body.summary !== "string") throw new KbError("INVALID_ARGS", 400, "summary 必须是字符串或 null");
  const summary = String(body.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  patch.summary = summary;
  patch.summarySource = summary ? "manual" : "";
}
if (body.tags !== undefined) {
  const tags = normalizeTags(body.tags);
  patch.tags = tags;
}
if (Object.keys(patch).length === 0) throw new KbError("INVALID_ARGS", 400, "请提供 summary 或 tags");
patch.metaUpdatedAt = new Date().toISOString();
await withManifestLock(dir, async () => {
  const fresh = await readManifest(dir);
  await updateDocMetaLocked(dir, fresh, doc.id, patch);
});
await appendLog(dir, { action: "describe", title: doc.title, docId: doc.id, detail: "人工编目" });
await refreshKbIndex(dir);
return sendJson(res, 200, { doc: await readDoc(opts.kbRoot, name, doc.id) });
```

（实际导入 `withManifestLock`/`updateDocMetaLocked`/`normalizeTags`，注意 api.js 顶部 import。）

- [ ] **Step 4: 跑测试**

Run: `node --test test/web-doc-metadata.test.mjs test/web-docs-search.test.mjs`
Expected: PASS。

- [ ] **Step 5: 全量**

Run: `npm test 2>&1 | tail -8`。

---

## Task 5: #1 UI：弹窗编辑与标签筛选

**Files:** `ui/views/doc-meta.js`（新）、`ui/views/sources.js`（暂不）、`ui/api.js`、`ui/app.js`、`ui/docs-controls.js`、`ui/views/detail.js`、`ui/views/modals.js`、`test/ui-docs.test.mjs`、`test/ui-docs-actions.test.mjs`、`test/ui-api.test.mjs`、`test/ui-doc-meta.test.mjs`、`test/ui-docs-tag.test.mjs`。

- [ ] **Step 1: 写失败测试**

```js
test("doc modal renders editable summary/tags and source label", () => {
  const html = renderDocModalBody({ name: "标准", id: "d1", doc: {
    title: "T", summary: "摘要", summarySource: "manual", tags: ["并网"],
  }});
  assert.match(html, /name="doc-summary"/);
  assert.match(html, /name="doc-tags"/);
  assert.match(html, /人工/);
});
test("docs toolbar renders tag select and active tag", () => {
  const html = renderDetail(makeState({ tag: "并网", facets: { tags: [{ name: "并网", count: 2 }] }, items: [makeDoc("a", { tags: ["并网"] })], total: 1 }), current, { icons, fmtNumber });
  assert.match(html, /data-docs-tag/);
  assert.match(html, /标签：并网/);
  assert.match(html, /data-action="docs-tag"/);
});
```

- [ ] **Step 2: 跑测试确认失败**：`node --test test/ui-docs.test.mjs test/ui-doc-meta.test.mjs` → FAIL。

- [ ] **Step 3: 实现**

`ui/views/doc-meta.js`：

```js
export function normalizeDocSummary(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}
export function parseDocTagsInput(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[,，、\n]+/);
  const out = [];
  for (const raw of list) {
    const tag = String(raw ?? "").replace(/^#+/, "").trim();
    if (!tag || tag.length > 32 || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}
export function summarySourceLabel(source) {
  return { manual: "人工", model: "模型", auto: "自动", "": "未编目" }[source] ?? "未编目";
}
export function docMetaPatch({ summary, tags }) {
  const patch = {};
  if (summary !== undefined) patch.summary = normalizeDocSummary(summary);
  if (tags !== undefined) patch.tags = parseDocTagsInput(tags);
  return patch;
}
```

`ui/api.js` 增加 `patchDocMetadata(name,id,body)`；`api.docs` 已支持任意 params，无需改。
`ui/views/modals.js` `renderDocModalBody` 的摘要/标签行改成 textarea/input + 保存按钮 + 来源徽标；`openDocModal` 绑定保存：

```js
async function saveMeta() {
  const patch = docMetaPatch({ summary: node.querySelector('[name="doc-summary"]').value, tags: node.querySelector('[name="doc-tags"]').value });
  const saved = await api.patchDocMetadata(name, id, patch);
  paint(saved.doc);
  notify("已保存摘要/标签");
  await onChanged?.();
}
```

`ui/views/detail.js`：
- `docsToolbar` 增加 `facets`/`tag` 参数、`<select data-docs-tag>`、当前 chip/清除；
- 行内标签按钮 `data-action="docs-tag" data-tag`；
- 空态文案。
`ui/app.js`：
- `state.docs` 初始化/重置加 `tag: ""`, `facets: { tags: [] }`；
- `loadDetail` 请求加 `tag: state.docs.tag`，stale 校验加 tag；
- `bind` 处理 `docs-tag`（设置/清空、offset=0、selected=[]、`loadDetail`）。
`ui/docs-controls.js`：
- 请求体加 `tag: String(state.docs.tag ?? "")`；
- 监听 `select[data-docs-tag]` 的 change → `state.docs.tag=value; state.docs.offset=0; selected=[]; load()`。
- 清除按钮/行内标签点击由全局委托处理。

- [ ] **Step 4: 跑测试**

Run: `node --test test/ui-docs.test.mjs test/ui-docs-actions.test.mjs test/ui-doc-meta.test.mjs test/ui-docs-tag.test.mjs test/ui-api.test.mjs`
Expected: PASS。

- [ ] **Step 5: 全量**

Run: `npm test 2>&1 | tail -8`；`npm run typecheck`。

---

## Task 6: 摄取管线：content meta + textHash + 去重 + worker

**Files:** `lib/pipeline.js`、`lib/import-job.js`、`worker/import-worker.mjs`、`lib/web/upload.js`、`test/import-metadata.test.mjs`、`test/kb-import-similar.test.mjs`、`test/web-upload-import.test.mjs`、`test/worker-progress.test.mjs`。

- [ ] **Step 1: 写失败测试**

- 导入一份文件名 `GB 19963.2-2024.pdf`，正文封面写 `GB/T 19963.2-2024`，另一份文件名 `GB/T ...`，第二份被 `std` 跳过；
- 新 full + 旧 cover-only 不跳过，`replacesIncomplete`；
- 同号不同阶段不跳过；
- `textHash` 相同跨文件名跳过；
- 同批重复时 worker 报告 `skipped` + `reason`，文档不残留 `importing`。

- [ ] **Step 2: 跑测试确认失败**：`node --test test/import-metadata.test.mjs`。

- [ ] **Step 3: 实现**

`lib/pipeline.js`：
- 输入新增 `dedupIndex`、`allowCrossKb`、`sourceHash`（可选）、`rawTitle`；
- `sourceHash = input.sourceHash ?? await hashFile(sourcePath)`；
- 解析后：

```js
const contentMeta = contentEligible(kind, filenameMeta) ? parseContentStandard(parsed.sections) : null;
const merged = mergeDocMeta(filenameMeta, contentMeta);
const integrity = contentIntegrityFor(parsed);
const textHash = textFingerprint(parsed.sections);
const hits = matchCandidate(dedupIndex ?? emptyIndex, {
  sourceHash, textHash, title: docTitle, docId,
  ...merged, contentIntegrity: integrity.integrity,
});
const decision = decideDuplicate(hits, { ...merged, contentIntegrity: integrity.integrity }, { allowCrossKb });
if (decision.skip) {
  await rm(staged, { recursive: true, force: true });
  await markSkipped(kbDir, docId);
  return { docId, title: docTitle, skipped: true, reason: decision.reason, duplicate: decision.match };
}
```

- 解析前也查一次 `sourceHash/std`（如果有 `dedupIndex`），命中直接返回 skip，不必 markImporting；
- `commitDoc` 传 `rawTitle/canonicalTitle/standard*/contentIntegrity/bodyChars/clauseCount/textHash/textHashAlgo/trust/trustSource`；
- `trustHeuristic` 只在 `prevTrust` 非 manual 且 `prev.trust === "unknown"` 时写入（可在 store 里做）。

`lib/import-job.js`：`prepareImportArgs` 增加 `dedup: { kbRoot, kbNames, allowCrossKb }` 字段；worker 参数透传。
`worker/import-worker.mjs`：
- 启动时 `buildDedupIndex`（从 `kbRoot` 下所有 manifest 读取；可复用 `listKbs`/`tryReadManifest`）；
- 每文件 `stage:"parsing"` → `importFileInto` → 成功 `stage:"parsed"`，跳过 `stage:"skipped"` + `reason`；
- 成功后把新 doc 加入索引（供同批后续）；
- `progress.files[i].reason = report.reason`。

`lib/web/upload.js`：
- `scanDuplicates` 改用 `doc-meta/dedup-index` 或保持旧 API 但增加 `matchKind`；
- 导入报告 `files` 加 `reason`/`matchKind`；
- `importBatch` 全重复返回 `{ jobId:null, status:"empty", duplicates, similar }`（已有 status empty）。

- [ ] **Step 4: 跑测试**

Run: `node --test test/import-metadata.test.mjs test/web-upload-import.test.mjs test/worker-progress.test.mjs`
Expected: PASS。

- [ ] **Step 5: 全量**：`npm test 2>&1 | tail -8`。

---

## Task 7: 上传批次 hash 与 UI 文案

**Files:** `lib/web/http.js`、`lib/web/upload.js`、`ui/upload-core.js`、`ui/views/upload.js`、`test/web-upload-batch.test.mjs`、`test/upload-core.test.mjs`、`test/ui-upload.test.mjs`（新）。

- [ ] **Step 1: 写失败测试**

```js
test("readRawToFile returns sha256", async () => {
  const { readRawToFile } = await import("../lib/web/http.js");
  const { size, hash } = await readRawToFile(Readable.from([Buffer.from("abc")]), tmp);
  assert.equal(size, 3);
  assert.match(hash, /^[0-9a-f]{64}$/);
});
test("upload phase labels do not call uploaded parsed", () => {
  assert.equal(fileStageLabel({ status: "uploaded" }, "starting"), "已上传，待解析");
  assert.equal(uploadPhaseTitle({ phase: "starting" }), "文件已上传，正在启动解析…");
  assert.equal(uploadPhaseTitle({ phase: "empty" }), "没有新资料（全部重复）");
});
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现**

`lib/web/http.js` `readRawToFile`：

```js
const hash = createHash("sha256");
const limiter = new Transform({
  transform(chunk, enc, cb) {
    size += chunk.length;
    if (maxBytes > 0 && size > maxBytes) { cb(new WebError(...)); return; }
    hash.update(chunk);
    cb(null, chunk);
  },
});
return { size, hash: hash.digest("hex") };
```

`lib/web/upload.js` `addBatchFile` 存 `{ path, size, hash }`；`buildImportFiles` 传 `sourceHash`。
`ui/upload-core.js` 增加 `fileStageLabel`/`uploadPhaseTitle`（按 spec §6.9），`statusLabel` 保留兼容。
`ui/views/upload.js` 用新函数；`empty` phase 渲染“没有新资料：全部与库内重合”；完成页汇总加重复/导入中跳过；上传失败/解析失败分开标题。
`ui/upload-core.js` 的 `nextPhase` 加 `starting:{empty:"empty"}`。

- [ ] **Step 4: 跑测试**：`node --test test/upload-core.test.mjs test/web-upload-batch.test.mjs test/ui-upload.test.mjs`。

- [ ] **Step 5: 全量**。

---

## Task 8: 回填脚本与 lint

**Files:** `lib/backfill.js`、`scripts/backfill-doc-meta.mjs`、`lib/lint.js`、`test/backfill.test.mjs`、`test/lint-metadata.test.mjs`、`test/lint.test.mjs`。

- [ ] **Step 1: 写失败测试**：dry-run 不写；apply 写字段；content 优先；cover-only 不 retitle；metadata-missing/duplicate-text/same-number/content-incomplete/mismatch 分组。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**：
  - `lib/backfill.js`：`planBackfill({dir, options})` 读 manifest，按 doc 计算 patch（hash/std/content/text/trust/retitle），返回 `{changes, counts, skipped, errors}`；`applyBackfill` 一次 `withManifestLock` + `writeManifestAtomic`；`--retitle` 复用 `renameDoc`/`rebuildMerged`/history 逻辑（可调用现有 `retitleDoc` 辅助；若没有导出，抽出）。
  - `scripts/backfill-doc-meta.mjs`：arg parse（`--root --kb --dry-run --apply --hash --std --content --text --trust --retitle`），默认 dry-run，打印计数/样例/JSON 可选。
  - `lib/lint.js`：`docStandardOf(doc)` 优先字段，回退 `parseDocMeta`；按 §6.8 分组；`content-incomplete`/`filename-standard-mismatch`。
- [ ] **Step 4: 跑测试**。
- [ ] **Step 5: 真实库 dry-run**

Run:
```bash
node scripts/backfill-doc-meta.mjs --root /Users/littlesun/workspace/knowledge --kb 标准 --dry-run --hash --std --content --text
```
报告计数/样例；不要直接 apply。用户已确认 apply，但先在阶段报告里给出清单，然后执行：

```bash
node scripts/backfill-doc-meta.mjs --root /Users/littlesun/workspace/knowledge --kb 标准 --apply --hash --std --content --text
node scripts/backfill-doc-meta.mjs --root /Users/littlesun/workspace/knowledge --kb 标准 --dry-run --retitle
```
第二次 dry-run 给 retitle 清单；确认后 `--apply --retitle`。执行前 `kb_snapshot` 留库级快照（脚本或工具）。记录变更数量、DL/T 标题新值、GB 19963.2 的 `standardSource`。

- [ ] **Step 6: 全量** `npm test`。

---

## Task 9: #3 sources schema、深链与工作台预览

**Files:** `lib/query.js`、`lib/index.js`、`ui/sources-view.js`、`ui/deep-link.js`、`ui/api.js`、`ui/app.js`、`ui/views/modals.js`、`test/query-sources.test.mjs`、`test/read-sources.test.mjs`、`test/deep-link.test.mjs`、`test/sources-view.test.mjs`。

- [ ] **Step 1: 写失败测试**

```js
test("kb_query returns sources with deepLink", async () => {
  const result = await tools.get("kb_query").execute({ pattern: "电压", kb: "标准" }, exec);
  assert.equal(result.sources[0].kb, "标准");
  assert.match(result.sources[0].deepLink, /^\/kb\/\?kb=.*&doc=.*&page=/);
  assert.ok(result.sources[0].snippet.length <= 160);
});
test("deep link parser clamps page", () => {
  assert.deepEqual(parsePreviewDeepLink("?kb=标准&doc=d1&page=999"), { kb: "标准", docId: "d1", page: 999, clause: "" });
  assert.equal(clampPage(999, 10), 10);
});
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现**
  - `lib/query.js`：`clauseOfLine`（向前找 heading）、`sourcesFromMatches`（去重、snippet、deepLink）、`withPage`。
  - `lib/index.js`：`kb_query` 结果加 `sources`，`output.schema` 加 additive `sources`；`presentationMeta` 返回 `{ sources }`；render 尾部最多 5 条紧凑来源；`kb_read` 结果加 `sources`（part/all），schema/presentationMeta；系统提示加引用格式。
  - `ui/sources-view.js`：`dedupeSources`/`sourceLabel`/`sourceHref`（纯函数）。
  - `ui/deep-link.js`：`parsePreviewDeepLink`/`withPageFragment`/`clampPage`。
  - `ui/api.js`：`previewPdfUrl`/`sourceInlineUrl` 可选 page? 用 `withPageFragment` 在 modal 内拼。
  - `ui/views/modals.js`：`renderPreviewBody` 接受 `initialPage`/`page`，iframe URL 加 `#page=N&zoom=page-fit`；`openPreviewModal` 支持 `initialPage`。
  - `ui/app.js`：启动解析 query；`loadKbs` 后打开 `openPreviewModal`；404 toast；清理 query。

- [ ] **Step 4: 跑测试**。
- [ ] **Step 5: 全量**。

---

## Task 10: #3 客户端 tool views + 本轮来源面板 + E2E

**Files:** `src/client/index.tsx`、`lib/client.js`（构建产物）、`test/sources-client.test.mjs`、`test/client-entry.test.mjs`、`scripts/e2e/session-fixture.mjs`、`scripts/e2e/tests/deep-link.mjs`、`scripts/e2e/tests/sources.mjs`、`scripts/e2e/run.mjs`。

- [ ] **Step 1: 写失败测试**：VM/fake DOM 注册 `tool.call.toolview` key `kb_query`/`kb_read`、`turnTail` id `kb-sources`；坏 meta 回退；无来源 null；链接 href。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**
  - `src/client/index.tsx`：注册 `tool.call.toolview`（key `kb_query`/`kb_read`）和 `conversation.chat.turnTail`；组件从 `block.meta.sources` 读；`useChat((s)=>s.nodes)` 聚合 turn；CSS 注入。
  - `package.json` `dsh.client.inject` 视 spike 结果增加 `@deepseek-ai/dsh-client-ui-chat`/`-ui-tool`；`lib/client.js` 重新构建（`npm run build:client`）。
  - `scripts/e2e/session-fixture.mjs`：写 v4 JSONL（session/settings/turn/user/assistant/tool call/tool result meta.sources），zstd 压缩到临时 DSH_HOME。
  - `scripts/e2e/tests/sources.mjs`：打开 fixture 会话，断言工具行来源 chip、点击打开 `/kb/?...`、页码定位、坏 sources 回退。
  - `scripts/e2e/tests/deep-link.mjs`：深链直接打开预览、page clamp、缺 doc toast。
  - `scripts/e2e/run.mjs`：注册两个新测试。
- [ ] **Step 4: 跑测试**：`node --test test/sources-client.test.mjs test/client-entry.test.mjs`；`npm run check:client`。
- [ ] **Step 5: E2E**：`npm run test:e2e`（本地真实 profile；失败先看 `.artifacts`）。E2E 可能因合成 session 格式失败，按 Task 0 spike 记录修 fixture。

---

## Task 11: 文档、版本、验收

**Files:** `README.md`、`docs/specs/2026-10-24-kb-workbench-slice2b-design.md`（追加 §25 0.26）、`package.json`、`package-lock.json`、`lib/version.js`。

- [ ] **Step 1:** `package.json`/`package-lock.json` 根与 `packages[""]`、`lib/version.js` → `0.26.0`。
- [ ] **Step 2:** README 增加 `## 0.26.0 资料元数据、摄取规范化与引用溯源`；写摘要/标签编辑、`summarySource=manual`、标签筛选、正文/封面优先与完整性矩阵、回填命令、`sources`/深链、已知限制。
- [ ] **Step 3:** spec 追加 §25 记录实现/验收（测试数、真实库回填计数、host spike 结果、E2E 结果、未做项）。
- [ ] **Step 4:** `npm test`、`npm run typecheck`、`npm run check:client`、`node scripts/check-ui.mjs` 全绿。
- [ ] **Step 5:** 报告 `git diff --stat`、关键文件 diff、测试输出；不 push/发布。等待用户确认后再考虑 PR/发布。

---

## 验收清单

- [ ] `PATCH /kbs/:name/docs/:id/metadata` 可用，`summarySource=manual`，不递增内容版本。
- [ ] 资料页可按标签筛选，facets/空态/清除正确。
- [ ] schema v6 旧清单惰性迁移，`commitDoc` 保留 manual/model 摘要与 manual trust。
- [ ] 标准/书籍正文/封面优先；`contentIntegrity` 矩阵生效；其他资料不 content-first。
- [ ] 去重维度 sourceHash/std/std-family/textHash/title；同号不同阶段不跳过。
- [ ] 上传 UI 区分“已上传，待解析”“解析中”“解析完成”“上传失败/解析未完成/全部重复”。
- [ ] 旧库 dry-run/apply/retitle 有记录；`kb_lint` 报告 metadata-missing/duplicate-text/same-number/content-incomplete/mismatch。
- [ ] `kb_query`/`kb_read` 带 `sources`，深链 `?doc=&page=` 可打开预览并定位页码。
- [ ] tool views + 本轮来源面板可用；坏 meta/无来源降级。
- [ ] 补充 E2E：来源面板、点击跳转、页码定位、来源缺失降级。
- [ ] `npm test`（含 check:client/check-ui）、`npm run typecheck` 全绿；版本 0.26.0。
```
