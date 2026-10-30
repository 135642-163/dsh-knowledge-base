#!/usr/bin/env node
/**
 * 知识库质量只读审计（0.32 优先级 1 · 1.1）。
 *
 * 目标：先产出一份可信的「问题清单」，再和用户确认后分批修复。本脚本**只读**：
 *
 *  1) 只 import 只读 API（tryReadManifest / lintManifest / 纯函数），不 import 任何
 *     写清单、写文档、删改文档的函数；也不调用 listKbs（它会 mkdir 根目录）。
 *  2) 扫描前后对每个库做指纹（kb.json / index.md / log.md / schema.md 的
 *     mtime+size+ino，sources/ 与 markdown/ 的条目数），不一致即 exit 2，
 *     并在报告里标红（`readOnly.verified=false`）。
 *  3) 报告只写到 --out（默认 <repo>/docs/reports），并拒绝写进被扫描的知识库根目录。
 *
 * 检查范围：
 *  - 复用 kb_lint 的机械分组（失败/旧管线/损坏页/内容重复/同号重复/多版本/
 *    未编目/笔记无来源/孤页/缺 schema 等）；
 *  - 追加清单层检查：导入中、软删除、临时文件、0 字/极小正文、摘要乱码/过短、
 *    标题需清洗、标题重复、有标准号却无结构化元数据、缺 sourceHash、可信度分布；
 *  - 追加内容层检查（读派生 markdown）：U+FFFD（文字层丢失，硬伤）、私用区字符
 *    （字体映射，多为公式/异体字）、拉丁字母被映射成 CJK、派生文件缺失/分块数不符；
 *  - 追加存储层检查：sources/ 里有文件但清单无对应文档（孤儿原件）；
 *  - 手工数据保护清单：summarySource/titleSource/trustSource = manual 的文档逐条列出，
 *    后续批量脚本必须跳过。
 *
 * 输出：
 *  - `<out>/<name>.json` 机器可读（分类、计数、分库分布、条目、Top 动作）；
 *  - `<out>/<name>.md`  人类可读报告（分类数量、Top 10 建议动作、回滚方式）。
 *
 * 用法：
 *   node scripts/quality-audit.mjs --root ~/workspace/knowledge
 *   node scripts/quality-audit.mjs --root ~/workspace/knowledge --kb 标准 --kb 电能质量
 *   node scripts/quality-audit.mjs --root ~/workspace/knowledge --no-content-scan --out /tmp/audit
 */
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expandRoot, tryReadManifest } from "../lib/store.js";
import { lintManifest } from "../lib/lint.js";
import { PARSER_VERSION, VERSION } from "../lib/version.js";
import { parseDocMeta, titleKey } from "../lib/doc-meta.js";
import { cleanTitle } from "../lib/titles.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const DEFAULT_OUT = join(REPO_ROOT, "docs", "reports");

/** 内容层损坏阈值：与 parsers.textLayerQuality 的口径保持一致。 */
const FFFD_BAD = 3;
const PUA_BAD = 3;
const LATIN_CJK_BAD = 2;
const KNOWN_LIGATURE_HYPHENS = new Set([0xe011, 0xe012]);

/** 与 kb_lint 的 staleDays 默认值一致。 */
const STALE_DAYS = 90;

/** 页面小节标题（PDF 派生的 markdown 才有）。 */
const PAGE_HEADER = /^### 第 (\d+) 页$/my;

// ---------------------------------------------------------------------------
// 分类元数据：分区、建议动作、回滚方式
// ---------------------------------------------------------------------------

const SECTIONS = [
  ["state", "导入与状态"],
  ["content", "内容质量"],
  ["identity", "身份、标题与元数据"],
  ["duplicate", "重复与版本"],
  ["compiled", "编译层（摘要 / 笔记 / 可信度）"],
  ["integrity", "存储与派生层完整性"],
  ["manual", "手工数据保护（清单，不是问题）"],
];

/**
 * code → 展示信息。severity 以这里为准（kb_lint 分组则沿用 lint 的 severity）。
 * rollback 写的是「修完之后怎么退回去」，供后续修复批次直接引用。
 */
const CATEGORY_META = {
  // --- 导入与状态 ---------------------------------------------------------
  "kb-manifest-unreadable": {
    section: "state", action: "检查 kb.json（可能是写坏/手工编辑出错），从 kb.json.v*.bak 或 snapshots/ 恢复",
    rollback: "用最近的 kb.json 备份覆盖即可（不改 sources/ 与 markdown/）",
  },
  failed: {
    section: "state", action: "kb_reparse 重试（原件在 sources/）；确认文件本身损坏后软删除",
    rollback: "重试不改旧内容；软删除可用 kb_restore 恢复",
  },
  importing: {
    section: "state", action: "确认导入任务是否仍活着（>30 分钟视为僵尸），必要时 kb_reparse",
    rollback: "无内容变更",
  },
  "deleted-soft": {
    section: "state", action: "正常现象：软删除文档在回收站，保留原件与分块；确认不再需要时可彻底删除",
    rollback: "kb_restore 可恢复（soft=false 之后不可恢复）",
  },
  "temp-files": {
    section: "state", action: "kb_remove soft=false 彻底删除（临时文件没有保留价值）",
    rollback: "临时文件无内容价值，不需要回滚",
  },
  "schema-missing": {
    section: "state", action: 'kb_edit doc="schema" 补维护规范',
    rollback: "只新增文件，删除 schema.md 即回到原状",
  },

  // --- 内容质量 -----------------------------------------------------------
  "zero-content": {
    section: "content", action: "kb_view 看原件；确实为空/无法解析则重新导入或软删除",
    rollback: "kb_snapshot 后操作；重解析可用 kb_restore version=N",
  },
  "tiny-content": {
    section: "content", action: "kb_view 核对是否只有封面/目录；能拿到完整版就重新导入（同名=原位更新）",
    rollback: "kb_snapshot + kb_history/kb_restore version=N",
  },
  "content-incomplete": {
    section: "content", action: "核对是「只有封面/目录」还是「编制说明本就不全」；补完整版或降级标注",
    rollback: "kb_snapshot + kb_restore version=N",
  },
  "content-fffd": {
    section: "content", action: "内容层有 U+FFFD（文字层丢字，硬伤）：先 kb_view 核对，再 kb_reparse forceOcrPages=<坏页>；整本都坏时 forceOcr=true",
    rollback: "kb_snapshot 后 kb_reparse；新版本可用 kb_history + kb_restore version=N 回退",
  },
  "content-pua": {
    section: "content", action: "私用区字符（公式/异体字字体映射）：一般无需处理，抽查即可",
    rollback: "不建议批量重解析；若已重解析，用 kb_restore version=N 回退",
  },
  corrupted: {
    section: "content", action: "kb_view 核对坏页/低置信页；kb_reparse forceOcrPages=<坏页> 重识别",
    rollback: "kb_snapshot + kb_history/kb_restore version=N",
  },
  "pages-sidecar-missing": {
    section: "content", action: "旧导入没有逐页质量 sidecar，无法回看低置信页；需要时 kb_reparse 重建（不必批量做）",
    rollback: "kb_snapshot + kb_restore version=N",
  },

  // --- 身份、标题与元数据 -------------------------------------------------
  "metadata-missing": {
    section: "identity", action: "scripts/backfill-doc-meta.mjs --apply --hash --std --content（只补元数据，不动摘要/标题/可信度）",
    rollback: "kb_snapshot 后执行；清单可用快照覆盖 kb.json 回退",
  },
  "title-standard-without-meta": {
    section: "identity", action: "backfill-doc-meta --std --apply 解析结构化标准号；标题本身无需改",
    rollback: "kb_snapshot 后执行；kb.json 快照可回退",
  },
  "title-cleanup": {
    section: "identity", action: "kb_retitle dryRun=true 预览；确认后逐篇应用（不要整库一刀切）",
    rollback: "kb_snapshot + kb_history/kb_restore version=N",
  },
  "title-duplicate": {
    section: "duplicate", action: "人工核对是否同一份（doc/pdf、带后缀的重复导入）；保留一份，其余 kb_remove 或 kb_keep 说明",
    rollback: "kb_remove 默认软删除，kb_restore 可恢复；kb_keep clear=true 可取消标记",
  },
  "filename-standard-mismatch": {
    section: "identity", action: "已按正文处理；核对后可 kb_retitle 统一显示标题",
    rollback: "kb_snapshot + kb_restore version=N",
  },
  stale: {
    section: "identity", action: "旧管线产物：不必批量刷新；只在遇到内容问题时按需 kb_reparse（all=true 分批 + limit）",
    rollback: "kb_snapshot + kb_restore version=N",
  },
  "legacy-parser": {
    section: "identity", action: "旧管线产物：不必批量刷新；只在遇到内容问题时按需 kb_reparse（all=true 分批 + limit）",
    rollback: "kb_snapshot + kb_restore version=N",
  },

  // --- 重复与版本 ---------------------------------------------------------
  "duplicate-content": {
    section: "duplicate", action: "同一文件导入了多次：核对后保留一份，其余 kb_remove（软删除）",
    rollback: "kb_restore 恢复软删除",
  },
  "duplicate-text": {
    section: "duplicate", action: "正文完全相同：核对后保留一份，其余 kb_remove（软删除）",
    rollback: "kb_restore 恢复软删除",
  },
  "same-number": {
    section: "duplicate", action: "同号同期同阶段疑似重复：核对后 kb_remove 其一，或 kb_keep 标记「已核对保留」",
    rollback: "kb_keep clear=true 取消标记；kb_restore 恢复软删除",
  },
  "same-number-stages": {
    section: "duplicate", action: "属正常过程稿（征求意见/报批/发布），不需要删除；必要时在笔记里写明采用哪一版",
    rollback: "无需回滚",
  },
  "same-number-multi-year": {
    section: "duplicate", action: "同一标准号的多个年份版本：保留旧版，用 kb_std_check 核对是否有更新（优先级 2 再做）",
    rollback: "不建议删除旧版；如误删用 kb_restore",
  },
  "same-number-family": {
    section: "duplicate", action: "GB 与 GB/T 等同族写法：核对封面后保留正确写法，其余 kb_keep 或软删除",
    rollback: "kb_keep clear=true / kb_restore",
  },

  // --- 编译层 -------------------------------------------------------------
  "summary-missing": {
    section: "compiled", action: "kb_describe 补一行摘要（会自动进 index.md）",
    rollback: "kb_describe clear=true",
  },
  "summary-garbled": {
    section: "compiled", action: "先判断是「摘要抄到了乱码正文」还是「正文本身坏了」：正文坏了先修内容（kb_reparse），再 kb_describe 重写摘要",
    rollback: "kb_describe clear=true 或 kb_snapshot 覆盖 kb.json",
  },
  "summary-thin": {
    section: "compiled", action: "摘要偏短（<40 字）：可选补写，不影响检索",
    rollback: "kb_describe clear=true",
  },
  "trust-unknown": {
    section: "compiled", action: "kb_trust 标 high/medium/low（先核实是否现行标准/正式出版物）",
    rollback: "kb_trust level=unknown",
  },
  "trust-low": {
    section: "compiled", action: "正常：已废止标准（新版封面写明代替）与过程稿本来就该是 low，不要「修正」",
    rollback: "无需回滚",
  },
  "note-no-sources": {
    section: "compiled", action: "kb_add_note 同标题更新并补 sources（docId#页码）",
    rollback: "kb_snapshot + kb_restore version=N",
  },
  "supersede-hint": {
    section: "compiled", action: "把「续/修订版」合并回主线笔记（同标题 kb_add_note 更新），旧页软删除",
    rollback: "kb_restore 恢复旧页",
  },
  "orphan-note": {
    section: "compiled", action: "笔记有来源但没有入链：补双链或并入主题页，否则以后找不到",
    rollback: "kb_snapshot + kb_restore version=N",
  },
  "note-stale": {
    section: "compiled", action: `笔记超过 ${STALE_DAYS} 天未更新：复核结论是否被新资料推翻（不改也可）`,
    rollback: "无需回滚",
  },

  // --- 完整性 -------------------------------------------------------------
  "derived-missing": {
    section: "integrity", action: "派生层缺失：kb_reparse 从 sources/ 重建",
    rollback: "kb_snapshot + kb_restore version=N",
  },
  "orphan-source": {
    section: "integrity", action: "sources/ 里有文件但清单没有对应文档：核对后移到回收站（或重新 kb_import）",
    rollback: "文件移动可逆；重新导入会新建文档",
  },
};

/** kb_lint 分组里没有单独 meta 的，按通用兜底。 */
function metaFor(code) {
  return CATEGORY_META[code] ?? { section: "state", action: "按类别名核对后处理", rollback: "kb_snapshot 后再操作" };
}

/** 后续修复批次的建议动作表（按 code 聚合），用于生成 Top 10。 */
const ACTION_PLAN = [
  {
    code: "content-fffd", priority: 1,
    title: "修内容层 U+FFFD（文字层丢字）",
    tool: "kb_view + kb_reparse",
    how: "先 kb_view 抽查坏页确认是「真乱码」；再 kb_reparse forceOcrPages=<页号列表>（整本都坏用 forceOcr=true）",
    batch: "按库分批，每批 ≤20 篇；先做 电能质量 / 标准",
    snapshot: "每批先 kb_snapshot（含 sources 可省，说明局限）",
    risk: "重解析会版本号 +1；OCR 也可能识别出新的错字，必须抽查",
    manualData: "不涉及摘要/标题/可信度，不会覆盖手工数据",
  },
  {
    code: "title-duplicate", priority: 2,
    title: "合并同标题重复资料",
    tool: "kb_keep / kb_remove",
    how: "逐组对照 sourceFile：同一份资料的 doc/pdf、带「(1)」后缀的重复导入 → 保留一份，其余 kb_remove（软删除）",
    batch: "按库逐组人工确认，不做自动合并",
    snapshot: "软删除即时可恢复，仍建议先 kb_snapshot",
    risk: "doc 与 pdf 可能是不同版本的同一标准，删错会丢内容",
    manualData: "不涉及",
  },
  {
    code: "duplicate-text", priority: 3,
    title: "清理正文完全相同的副本",
    tool: "kb_remove",
    how: "按组保留内容最全/命名最规范的一份，其余软删除",
    batch: "一次做完（组数少）",
    snapshot: "kb_snapshot",
    risk: "低",
    manualData: "不涉及",
  },
  {
    code: "same-number", priority: 4,
    title: "核对同号同期同阶段重复",
    tool: "kb_keep / kb_remove",
    how: "确认是同一版本后 kb_keep 标记或软删除副本；不同阶段（征求意见/报批/发布）不算重复",
    batch: "逐组确认",
    snapshot: "kb_snapshot",
    risk: "中：可能误删不同批次的标准",
    manualData: "不涉及",
  },
  {
    code: "content-incomplete", priority: 5,
    title: "补完整正文（封面/目录可用但正文缺失）",
    tool: "重新导入 / kb_view",
    how: "仅处理 cover-only 与正文明显缺失的资料；「编制说明」类 partial 属正常，不要动",
    batch: "先处理 cover-only 的少数几篇",
    snapshot: "导入是原位更新，先 kb_snapshot",
    risk: "重新导入会覆盖当前解析产物（版本号 +1）",
    manualData: "若该文档有手工摘要需先记录，重导入后摘要保留但摘要内容可能过时",
  },
  {
    code: "tiny-content", priority: 6,
    title: "处理 0 字/极小正文资料",
    tool: "kb_view / 重新导入",
    how: "先看原件是不是只有封面；有完整版就重新导入，没有就标注或软删除",
    batch: "逐篇",
    snapshot: "kb_snapshot",
    risk: "低",
    manualData: "不涉及",
  },
  {
    code: "metadata-missing", priority: 7,
    title: "回填资料身份元数据（sourceHash/标准号）",
    tool: "scripts/backfill-doc-meta.mjs",
    how: "node scripts/backfill-doc-meta.mjs --root <kbRoot> --apply --hash --std --content（只补元数据，不动摘要/标题/trust）",
    batch: "一次性，但先 --dry-run 看变更量",
    snapshot: "必须先 kb_snapshot（会写 kb.json）",
    risk: "中：会重算标准号，个别标题解析可能偏移，需抽查",
    manualData: "脚本跳过 summarySource/titleSource/trustSource=manual 的字段",
  },
  {
    code: "summary-garbled", priority: 8,
    title: "重写乱码摘要（先修内容，再写摘要）",
    tool: "kb_describe",
    how: "内容修好后用 kb_describe 写一行摘要；正文仍乱码的不要急着写摘要",
    batch: "≤20 篇/批",
    snapshot: "kb_describe 覆盖摘要，先记录原摘要或 kb_snapshot",
    risk: "低",
    manualData: "跳过 summarySource=manual",
  },
  {
    code: "orphan-source", priority: 9,
    title: "清理无主原件",
    tool: "文件系统 / kb_import",
    how: "确认 sources/ 里的孤儿文件确实不属于任何文档 → 移到 .trash；若是有用资料则重新导入",
    batch: "逐个",
    snapshot: "移动前记录文件名",
    risk: "低（先核对）",
    manualData: "不涉及",
  },
  {
    code: "note-orphan", priority: 10,
    title: "给孤页笔记补双链/来源",
    tool: "kb_add_note",
    how: "同标题更新笔记，补 sources 或在主题页里引用",
    batch: "逐篇",
    snapshot: "kb_snapshot",
    risk: "低",
    manualData: "笔记本身就是手工内容，改前必须逐条确认",
  },
  {
    code: "summary-thin", priority: 11,
    title: "补充过短摘要（可选）",
    tool: "kb_describe",
    how: "摘要 <40 字的资料，按需补写；不影响检索排序",
    batch: "按库分批",
    snapshot: "记录原摘要",
    risk: "低",
    manualData: "跳过 summarySource=manual",
  },
  {
    code: "trust-unknown", priority: 12,
    title: "补可信度标注",
    tool: "kb_trust",
    how: "先核实是否现行/正式出版物，再标 high/medium/low",
    batch: "逐篇",
    snapshot: "记录原值",
    risk: "低",
    manualData: "跳过 trustSource=manual",
  },
  {
    code: "stale", priority: 13,
    title: "旧管线产物刷新（可选，成本高）",
    tool: "kb_reparse",
    how: "只在遇到具体内容问题时按需重解析；不要一次刷全库",
    batch: "≤20 篇/批",
    snapshot: "kb_snapshot",
    risk: "高成本 + 可能引入新解析差异",
    manualData: "摘要/标题/可信度保留，正文会重建",
  },
];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    root: "",
    kbs: [],
    out: DEFAULT_OUT,
    name: "",
    contentScan: true,
    maxItems: 200,
    staleDays: STALE_DAYS,
    jsonOnly: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? "";
    if (arg === "--root") options.root = next();
    else if (arg === "--kb") options.kbs.push(next());
    else if (arg === "--out") options.out = next();
    else if (arg === "--name") options.name = next();
    else if (arg === "--max-items") options.maxItems = Math.max(1, Number(next()) || 200);
    else if (arg === "--stale-days") options.staleDays = Math.max(0, Number(next()) || STALE_DAYS);
    else if (arg === "--no-content-scan") options.contentScan = false;
    else if (arg === "--json-only") options.jsonOnly = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function usage() {
  console.log(`用法: node scripts/quality-audit.mjs --root <kbRoot> [选项]

只读审计知识库质量，输出 JSON + Markdown 报告；不修改被扫描的库。

选项:
  --root <dir>         知识库根目录（必填，支持 ~ 开头）
  --kb <name>          只审计指定库，可重复；省略=全部
  --out <dir>          报告输出目录（默认 <repo>/docs/reports）
  --name <base>        报告文件名前缀（默认 <YYYY-MM-DD>-kb-quality-audit）
  --max-items <n>      JSON 里每类最多列多少条（默认 200；计数不受影响）
  --stale-days <n>     笔记多久未更新算待复核（默认 90）
  --no-content-scan    跳过派生 markdown 内容层扫描（更快，但看不到 U+FFFD）
  --json-only          只写 JSON，不写 Markdown
  --quiet              只在最后打印一行摘要
  -h, --help           显示帮助`);
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function statOrNull(file) {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}

function statSignature(info) {
  if (!info) return null;
  return { mtimeMs: Math.round(info.mtimeMs), size: info.size, ino: String(info.ino ?? "") };
}

function pickDoc(doc) {
  return {
    docId: doc.id,
    title: doc.title,
    type: doc.type ?? "",
    status: doc.status ?? "",
    detail: "",
  };
}

function addCategory(list, category) {
  list.push({
    code: category.code,
    label: category.label,
    severity: category.severity,
    section: category.section,
    source: category.source ?? "audit",
    count: category.count ?? (category.items?.length ?? 0),
    items: category.items ?? [],
    hint: category.hint ?? "",
    action: category.action ?? "",
    rollback: category.rollback ?? "",
  });
}

/**
 * 单遍扫描一段派生 markdown：统计 U+FFFD / 私用区字符 / 拉丁字母被映射成 CJK，
 * 并按 `### 第 N 页` 归到页。返回计数与坏页列表。
 */
export function analyzeDerivedText(text) {
  const result = { chars: 0, fffd: 0, pua: 0, latinCjk: 0, pages: [] };
  if (typeof text !== "string" || text.length === 0) return result;
  let page = null;
  let pageAcc = { page: null, fffd: 0, pua: 0, latinCjk: 0 };
  let lineStart = true;
  const pageAccs = new Map();
  PAGE_HEADER.lastIndex = 0;

  const flush = () => {
    if (pageAcc.fffd + pageAcc.pua + pageAcc.latinCjk === 0) return;
    const key = pageAcc.page === null ? "(未分页)" : pageAcc.page;
    const prev = pageAccs.get(key);
    if (prev) {
      prev.fffd += pageAcc.fffd;
      prev.pua += pageAcc.pua;
      prev.latinCjk += pageAcc.latinCjk;
    } else {
      pageAccs.set(key, { ...pageAcc });
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (lineStart && code === 35 /* # */) {
      PAGE_HEADER.lastIndex = i;
      const m = PAGE_HEADER.exec(text);
      if (m) {
        flush();
        page = Number(m[1]);
        pageAcc = { page, fffd: 0, pua: 0, latinCjk: 0 };
        i = PAGE_HEADER.lastIndex - 1;
        // 页标题行末尾的换行由下面的循环自然处理
        continue;
      }
    }
    result.chars += 1;
    if (code === 0xfffd) {
      result.fffd += 1;
      pageAcc.fffd += 1;
    } else if (code >= 0xe000 && code <= 0xf8ff) {
      if (!KNOWN_LIGATURE_HYPHENS.has(code)) {
        result.pua += 1;
        pageAcc.pua += 1;
      }
    } else if (code >= 0x7283 && code <= 0x72a3) {
      result.latinCjk += 1;
      pageAcc.latinCjk += 1;
    }
    lineStart = code === 10 /* \n */;
  }
  flush();
  result.pages = [...pageAccs.values()]
    .filter((p) => p.fffd > 0 || p.pua >= PUA_BAD || p.latinCjk >= LATIN_CJK_BAD)
    .sort((a, b) => (a.page === null ? -1 : b.page === null ? 1 : a.page - b.page));
  return result;
}

/** 汇总派生层：merged markdown 是否存在、分块数是否与清单一致、逐页质量 sidecar。 */
async function inspectDerived(dir, doc) {
  const base = join(dir, "markdown", doc.id);
  const out = { merged: false, parts: 0, partsDir: false, pagesSidecar: false };
  try {
    const info = await stat(join(base, `${doc.id}.md`));
    out.merged = info.size > 0;
  } catch {
    /* 缺失 */
  }
  try {
    const files = await readdir(join(base, "parts"));
    out.partsDir = true;
    out.parts = files.filter((name) => name.endsWith(".md")).length;
  } catch {
    /* 缺失 */
  }
  const pages = await statOrNull(join(base, "pages.json"));
  out.pagesSidecar = Boolean(pages);
  return out;
}

/** 逐库列出目录（不调用 listKbs，避免它 mkdir 根目录）。 */
async function listKbDirs(root, only = []) {
  const entries = await readdir(root, { withFileTypes: true });
  const wanted = new Set(only.map((name) => String(name).trim()).filter(Boolean));
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (wanted.size > 0 && !wanted.has(entry.name)) continue;
    const dir = join(root, entry.name);
    const manifest = await tryReadManifest(dir);
    out.push({ dir, name: manifest?.name || entry.name, manifest });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return out;
}

/** 目录树摘要：条目数、总字节、最大 mtime（用于证明扫描没有改动派生层）。 */
async function treeDigest(dir, maxDepth = 3) {
  const digest = { entries: 0, bytes: 0, maxMtimeMs: 0, exists: false };
  async function walk(current, depth) {
    let list;
    try {
      list = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    digest.exists = true;
    for (const entry of list) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(full, depth + 1);
      } else {
        const info = await statOrNull(full);
        if (!info) continue;
        digest.entries += 1;
        digest.bytes += info.size;
        digest.maxMtimeMs = Math.max(digest.maxMtimeMs, Math.round(info.mtimeMs));
      }
    }
  }
  await walk(dir, 0);
  return digest;
}

/** 库指纹：清单/编译层文件 stat + sources/markdown 目录树摘要。 */
async function fingerprintKb(dir) {
  const files = {};
  for (const name of ["kb.json", "index.md", "log.md", "schema.md"]) {
    files[name] = statSignature(await statOrNull(join(dir, name)));
  }
  const sources = await treeDigest(join(dir, "sources"), 0);
  const markdown = await treeDigest(join(dir, "markdown"), 3);
  return { files, sources, markdown };
}

export async function fingerprintRoot(root, dirs) {
  const out = {};
  for (const item of dirs) {
    out[item.name] = await fingerprintKb(item.dir);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 单库审计
// ---------------------------------------------------------------------------

/**
 * 审计一个知识库。只读：只调用 tryReadManifest / lintManifest / readFile / stat。
 * @returns 单库报告对象
 */
export async function auditKb({ dir, name, manifest, options }) {
  const now = options.now ?? Date.now();
  const staleDays = options.staleDays ?? STALE_DAYS;
  const maxItems = options.maxItems ?? 200;

  if (!manifest) {
    const items = [{ docId: "kb.json", title: name, type: "", status: "unreadable", detail: dir }];
    return {
      name,
      dir,
      unreadable: true,
      totals: { docs: 0, ready: 0, notes: 0, sources: 0, deleted: 0, failed: 0, importing: 0 },
      categories: [
        {
          code: "kb-manifest-unreadable",
          label: "清单不可读（kb.json 缺失/损坏）",
          severity: "error",
          section: "state",
          source: "audit",
          count: 1,
          items,
          hint: "该库无法参与审计；先确认 kb.json 是否损坏",
          action: metaFor("kb-manifest-unreadable").action,
          rollback: metaFor("kb-manifest-unreadable").rollback,
        },
      ],
      manualProtected: { summary: [], title: [], trust: { count: 0, items: [] } },
      provenance: {},
      derivedMissing: 0,
      contentScanned: 0,
    };
  }

  const docs = Array.isArray(manifest.docs) ? manifest.docs : [];
  const ready = docs.filter((d) => d.status === "ready" && !d.deletedAt);
  const notes = ready.filter((d) => d.type === "note");
  const sources = ready.filter((d) => d.type !== "note");
  const deleted = docs.filter((d) => Boolean(d.deletedAt));
  const failed = docs.filter((d) => d.status === "failed");
  const importing = docs.filter((d) => d.status === "importing");

  const schema = await statOrNull(join(dir, "schema.md"));
  const hasSchema = Boolean(schema);

  const categories = [];

  // ---- 1) 复用 kb_lint 的机械分组（items 全量取回，报告再截断） -------
  const lint = lintManifest(manifest, {
    kbName: name,
    hasSchema,
    now,
    staleDays,
    maxItems: 1_000_000,
  });
  for (const group of lint.groups) {
    // duplicate-text 在下面用「正文有实质内容」的口径重算：
    // kb_lint 会把两篇只有封面（20 字）的残件也判成「正文完全相同」，属噪声。
    // unlabeled 交给 summary-missing（kb_lint 会把没有摘要的笔记也算进去，
    // 而笔记本来就没有摘要，不该算问题）。
    if (group.code === "duplicate-text" || group.code === "unlabeled") continue;
    const meta = metaFor(group.code);
    addCategory(categories, {
      code: group.code,
      label: group.label,
      severity: group.severity,
      section: meta.section,
      source: "kb_lint",
      count: group.count,
      items: group.items,
      hint: group.hint,
      action: meta.action,
      rollback: meta.rollback,
    });
  }

  // 正文完全相同（只看有实质内容的资料；残件已在 tiny-content / zero-content 里报）
  const MIN_TEXT_DUP_CHARS = 200;
  const byText = new Map();
  for (const doc of sources) {
    const hash = String(doc.textHash ?? "").trim();
    if (!hash || (doc.chars ?? 0) < MIN_TEXT_DUP_CHARS) continue;
    const list = byText.get(hash) ?? [];
    list.push(doc);
    byText.set(hash, list);
  }
  const textDupGroups = [...byText.values()].filter((list) => list.length > 1);
  addCategory(categories, {
    code: "duplicate-text",
    label: `正文完全相同的文档（≥${MIN_TEXT_DUP_CHARS} 字）`,
    severity: "warning",
    section: "duplicate",
    source: "audit",
    count: textDupGroups.length,
    items: textDupGroups.map((list) => ({
      docId: list.map((doc) => doc.id).join(","),
      title: list.map((doc) => doc.title).join(" / "),
      type: list.map((doc) => doc.type).join("/"),
      status: "ready",
      detail: `同一正文导入 ${list.length} 次（${list.map((doc) => `${doc.chars ?? 0} 字`).join(" / ")}）`,
    })),
    hint: "确认后保留一份，其余 kb_remove（默认软删除，可恢复）",
    action: metaFor("duplicate-text").action,
    rollback: metaFor("duplicate-text").rollback,
  });

  // ---- 2) 清单层追加检查 ------------------------------------------------
  // 导入中（lint 没有；僵尸导入超过 30 分钟很可能是任务已死）
  if (importing.length > 0) {
    addCategory(categories, {
      code: "importing",
      label: "导入中的文档",
      severity: "warning",
      section: "state",
      count: importing.length,
      items: importing.map((doc) => ({
        ...pickDoc(doc),
        detail: `updatedAt=${doc.updatedAt ?? ""}`,
      })),
      hint: "超过 30 分钟未完成视为僵尸导入，可用 kb_reparse 重试",
      action: metaFor("importing").action,
      rollback: metaFor("importing").rollback,
    });
  }

  // 软删除（信息项：回收站里还有东西）
  if (deleted.length > 0) {
    addCategory(categories, {
      code: "deleted-soft",
      label: "软删除文档（回收站）",
      severity: "info",
      section: "state",
      count: deleted.length,
      items: deleted.map((doc) => ({
        ...pickDoc(doc),
        detail: `deletedAt=${doc.deletedAt ?? ""}`,
      })),
      hint: "软删除保留原件与分块，可用 kb_restore 恢复",
      action: metaFor("deleted-soft").action,
      rollback: metaFor("deleted-soft").rollback,
    });
  }

  // 0 字 / 极小正文（lint 没有）
  const zero = sources.filter((d) => (d.chars ?? 0) === 0 || (d.parts ?? 0) === 0);
  addCategory(categories, {
    code: "zero-content",
    label: "0 字 / 0 分块资料",
    severity: "error",
    section: "content",
    count: zero.length,
    items: zero.map((doc) => ({
      ...pickDoc(doc),
      detail: `chars=${doc.chars ?? 0} parts=${doc.parts ?? 0} pages=${doc.pages ?? 0}`,
    })),
    hint: "解析完全失败或原件为空",
    action: metaFor("zero-content").action,
    rollback: metaFor("zero-content").rollback,
  });

  const tiny = sources.filter((d) => (d.chars ?? 0) > 0 && (d.chars ?? 0) < 200);
  addCategory(categories, {
    code: "tiny-content",
    label: "正文极小（<200 字）",
    severity: "warning",
    section: "content",
    count: tiny.length,
    items: tiny.map((doc) => ({
      ...pickDoc(doc),
      detail: `chars=${doc.chars ?? 0} integrity=${doc.contentIntegrity ?? ""} —— ${doc.title}`,
    })),
    hint: "常见于「只有封面一页」的 PDF",
    action: metaFor("tiny-content").action,
    rollback: metaFor("tiny-content").rollback,
  });

  // 扫描件缺逐页质量 sidecar（解释为什么「没有低置信页」）
  const pdfDocs = sources.filter((d) => ["pdf-text", "pdf-scanned", "pdf-mixed"].includes(d.type));
  const noSidecar = [];
  const manualProtected = { summary: [], title: [], trust: { count: 0, items: [] } };
  for (const doc of docs) {
    if (doc.summarySource === "manual") manualProtected.summary.push(pickDoc(doc));
    if (doc.titleSource === "manual") manualProtected.title.push(pickDoc(doc));
    if (doc.trustSource === "manual") {
      manualProtected.trust.count += 1;
      // trustSource=manual 几乎等于全库（迁移默认值），只留少量样例，避免报告膨胀
      if (manualProtected.trust.items.length < 20) manualProtected.trust.items.push(pickDoc(doc));
    }
  }

  // 摘要：空 / 乱码 / 过短（lint 的 unlabeled 把笔记也算进去，这里只算资料）
  const summaryMissing = sources.filter((d) => !String(d.summary ?? "").trim());
  addCategory(categories, {
    code: "summary-missing",
    label: "未编目（资料没有一行摘要）",
    severity: "warning",
    section: "compiled",
    count: summaryMissing.length,
    items: summaryMissing.map(pickDoc),
    hint: "笔记没有摘要属正常，本项只统计资料",
    action: metaFor("summary-missing").action,
    rollback: metaFor("summary-missing").rollback,
  });

  const SUMMARY_BAD = /[\uFFFD\uE000-\uF8FF]/;
  const summaryGarbled = sources.filter((d) => SUMMARY_BAD.test(String(d.summary ?? "")));
  addCategory(categories, {
    code: "summary-garbled",
    label: "摘要含乱码字符（U+FFFD / 私用区）",
    severity: "warning",
    section: "compiled",
    count: summaryGarbled.length,
    items: summaryGarbled.map((doc) => ({
      ...pickDoc(doc),
      detail: `source=${doc.summarySource || "?"} —— ${String(doc.summary ?? "").slice(0, 60)}`,
    })),
    hint: "摘要抄到了乱码正文：先修内容再重写摘要",
    action: metaFor("summary-garbled").action,
    rollback: metaFor("summary-garbled").rollback,
  });

  const summaryThin = sources.filter((d) => {
    const value = String(d.summary ?? "").trim();
    return value.length > 0 && value.length < 40 && !SUMMARY_BAD.test(value);
  });
  addCategory(categories, {
    code: "summary-thin",
    label: "摘要过短（<40 字）",
    severity: "info",
    section: "compiled",
    count: summaryThin.length,
    items: summaryThin.slice(0, maxItems).map((doc) => ({
      ...pickDoc(doc),
      detail: `${String(doc.summary ?? "").trim().length} 字`,
    })),
    hint: "可选补写；不影响检索",
    action: metaFor("summary-thin").action,
    rollback: metaFor("summary-thin").rollback,
  });

  // 标题：需要清洗 / 有标准号却没有结构化元数据 / 同库重复标题
  const needsClean = sources.filter((d) => cleanTitle(d.title) !== d.title);
  addCategory(categories, {
    code: "title-cleanup",
    label: "标题可再清洗（kb_retitle）",
    severity: "info",
    section: "identity",
    count: needsClean.length,
    items: needsClean.map((doc) => ({
      ...pickDoc(doc),
      detail: `→ ${cleanTitle(doc.title).slice(0, 80)}`,
    })),
    hint: "cleanTitle 只做站点后缀/编号前缀/单位等机械清洗",
    action: metaFor("title-cleanup").action,
    rollback: metaFor("title-cleanup").rollback,
  });

  const stdTitleNoMeta = sources.filter((doc) => {
    if (String(doc.standardNo ?? "").trim()) return false;
    const parsed = parseDocMeta(doc.title, doc.rawTitle ?? doc.title);
    return Boolean(parsed.standardNo);
  });
  addCategory(categories, {
    code: "title-standard-without-meta",
    label: "标题含标准号但清单没有结构化标准号",
    severity: "warning",
    section: "identity",
    count: stdTitleNoMeta.length,
    items: stdTitleNoMeta.map((doc) => ({
      ...pickDoc(doc),
      detail: `可解析为 ${parseDocMeta(doc.title, doc.rawTitle ?? doc.title).standardNo}`,
    })),
    hint: "用 backfill-doc-meta --std --apply 回填（只补元数据）",
    action: metaFor("title-standard-without-meta").action,
    rollback: metaFor("title-standard-without-meta").rollback,
  });

  const byTitle = new Map();
  for (const doc of sources) {
    // kb_keep 标记过的文档 = 人工已核对「保留」，不再参与同标题重复告警
    if (doc.dedupKeep === true) continue;
    const key = titleKey(doc.title);
    if (!key) continue;
    const list = byTitle.get(key) ?? [];
    list.push(doc);
    byTitle.set(key, list);
  }
  const dupTitleGroups = [...byTitle.values()].filter((list) => list.length > 1);
  addCategory(categories, {
    code: "title-duplicate",
    label: "同库标题重复（疑似同一份资料导入多次）",
    severity: "warning",
    section: "duplicate",
    count: dupTitleGroups.length,
    items: dupTitleGroups.map((list) => ({
      docId: list.map((doc) => doc.id).join(","),
      title: list[0].title,
      type: list.map((doc) => doc.type).join("/"),
      status: "ready",
      detail: list
        .map((doc) => `${doc.id}(${doc.type},${doc.chars ?? 0}字)`)
        .join(" | "),
    })),
    hint: "doc/pdf 双份或带后缀的重复导入；核对后保留一份",
    action: metaFor("title-duplicate").action,
    rollback: metaFor("title-duplicate").rollback,
  });

  // ---- 3) 内容层扫描（读派生 markdown） ---------------------------------
  let contentScanned = 0;
  let derivedMissing = 0;
  let noSidecarCount = 0;
  const fffdDocs = [];
  const puaDocs = [];
  const missingDocs = [];
  const partMismatch = [];

  if (options.contentScan !== false) {
    for (const doc of sources) {
      const derived = await inspectDerived(dir, doc);
      if (!derived.merged || !derived.partsDir) {
        derivedMissing += 1;
        if (missingDocs.length < maxItems) {
          missingDocs.push({
            ...pickDoc(doc),
            detail: `merged=${derived.merged ? "ok" : "缺失"} parts=${derived.partsDir ? derived.parts : "缺失"}`,
          });
        }
        continue;
      }
      if (pdfDocs.includes(doc) && !derived.pagesSidecar) noSidecarCount += 1;
      if ((doc.parts ?? 0) > 0 && derived.parts !== (doc.parts ?? 0)) {
        if (partMismatch.length < maxItems) {
          partMismatch.push({
            ...pickDoc(doc),
            detail: `清单 ${doc.parts} 块 / 磁盘 ${derived.parts} 块`,
          });
        }
      }
      let text = "";
      try {
        text = await readFile(join(dir, "markdown", doc.id, `${doc.id}.md`), "utf8");
      } catch {
        continue;
      }
      contentScanned += 1;
      const analyzed = analyzeDerivedText(text);
      const badPages = analyzed.pages
        .map((page) => (page.page === null ? "未分页" : String(page.page)))
        .join(",");
      if (analyzed.fffd >= FFFD_BAD) {
        fffdDocs.push({
          ...pickDoc(doc),
          bad: analyzed.fffd,
          detail: `U+FFFD ${analyzed.fffd} 处${badPages ? `（页 ${badPages}）` : ""}；${analyzed.chars} 字`,
        });
      } else if (analyzed.pua >= PUA_BAD) {
        puaDocs.push({
          ...pickDoc(doc),
          bad: analyzed.pua,
          detail: `私用区字符 ${analyzed.pua} 处${badPages ? `（页 ${badPages}）` : ""}`,
        });
      }
    }
  }

  fffdDocs.sort((a, b) => b.bad - a.bad);
  puaDocs.sort((a, b) => b.bad - a.bad);
  addCategory(categories, {
    code: "content-fffd",
    label: "内容层 U+FFFD（文字层丢字，硬伤）",
    severity: "warning",
    section: "content",
    count: fffdDocs.length,
    items: fffdDocs,
    hint: "清单里的 corruptedPages 只覆盖新管线；旧库要靠这一项才能发现",
    action: metaFor("content-fffd").action,
    rollback: metaFor("content-fffd").rollback,
  });
  addCategory(categories, {
    code: "content-pua",
    label: "内容层私用区字符（字体映射，多为公式/异体字）",
    severity: "info",
    section: "content",
    count: puaDocs.length,
    items: puaDocs,
    hint: "一般无需处理；批量重解析收益低",
    action: metaFor("content-pua").action,
    rollback: metaFor("content-pua").rollback,
  });

  // 派生层完整性
  addCategory(categories, {
    code: "derived-missing",
    label: "派生文件缺失（markdown / parts）",
    severity: "error",
    section: "integrity",
    count: derivedMissing,
    items: missingDocs,
    hint: "清单有条目但磁盘上没有派生文件，检索会静默漏掉",
    action: metaFor("derived-missing").action,
    rollback: metaFor("derived-missing").rollback,
  });

  addCategory(categories, {
    code: "parts-mismatch",
    label: "分块数与清单不一致",
    severity: "info",
    section: "integrity",
    count: partMismatch.length,
    items: partMismatch,
    hint: "通常是清单与磁盘不同步；kb_reparse 可重建",
    action: "核对后 kb_reparse 重建（不影响检索命中，只影响分块导航）",
    rollback: "kb_snapshot + kb_restore version=N",
  });

  addCategory(categories, {
    code: "pages-sidecar-missing",
    label: "PDF 缺逐页质量 sidecar（旧导入）",
    severity: "info",
    section: "content",
    count: noSidecarCount,
    items: [],
    hint: "没有 sidecar 就无法回看低置信页；不是错误，只是覆盖缺口",
    action: metaFor("pages-sidecar-missing").action,
    rollback: metaFor("pages-sidecar-missing").rollback,
  });

  // 旧管线产物已在 kb_lint 的 stale 分组里（items 全量），这里不重复统计。

  // ---- 4) sources/ 孤儿原件 --------------------------------------------
  let orphanSources = [];
  try {
    const files = await readdir(join(dir, "sources"));
    const known = new Set();
    for (const doc of docs) {
      const ext = extname(doc.sourceFile ?? "").toLowerCase();
      if (ext) known.add(`${doc.id}${ext}`);
    }
    orphanSources = files.filter((file) => !known.has(file));
  } catch {
    orphanSources = [];
  }
  addCategory(categories, {
    code: "orphan-source",
    label: "sources/ 里有文件但清单无对应文档",
    severity: "info",
    section: "integrity",
    count: orphanSources.length,
    items: orphanSources.slice(0, maxItems).map((file) => ({
      docId: file,
      title: file,
      type: "source",
      status: "orphan",
      detail: join(dir, "sources", file),
    })),
    hint: "软删除文档的原件会留在这里；排除之后仍是孤儿才需要清理",
    action: metaFor("orphan-source").action,
    rollback: metaFor("orphan-source").rollback,
  });

  // ---- 5) 手工数据保护清单（不是问题，但必须让修复脚本看见） ----------
  if (manualProtected.summary.length > 0 || manualProtected.title.length > 0) {
    addCategory(categories, {
      code: "manual-protected",
      label: "手工维护的摘要/标题（批量脚本必须跳过）",
      severity: "info",
      section: "manual",
      source: "audit",
      count: manualProtected.summary.length + manualProtected.title.length,
      items: [
        ...manualProtected.summary.map((item) => ({ ...item, detail: "summarySource=manual" })),
        ...manualProtected.title.map((item) => ({ ...item, detail: "titleSource=manual" })),
      ],
      hint: "这些字段只能逐条确认后修改",
      action: "不批量改；需要改时逐条确认",
      rollback: "改前记录原值；kb_history 可回退",
    });
  }

  return {
    name,
    dir,
    unreadable: false,
    totals: {
      docs: docs.length,
      ready: ready.length,
      notes: notes.length,
      sources: sources.length,
      deleted: deleted.length,
      failed: failed.length,
      importing: importing.length,
    },
    categories,
    manualProtected,
    provenance: {
      summarySource: countBy(docs, (d) => d.summarySource || "(空)"),
      titleSource: countBy(docs, (d) => d.titleSource || "(空)"),
      trustSource: countBy(docs, (d) => d.trustSource || "(空)"),
      trust: countBy(ready, (d) => d.trust || "unknown"),
    },
    trustLowReasons: countBy(
      ready.filter((d) => d.trust === "low"),
      (d) => (/^已被/.test(d.trustReason ?? "") ? "已被代替（已废止）" : /过程稿|草案|说明材料|勘误|Redline/i.test(d.trustReason ?? "") ? "过程稿/说明材料" : d.trustReason || "(无理由)")
    ),
    derivedMissing,
    contentScanned,
    noSidecarCount,
    hasSchema,
    lintCounts: lint.counts,
    lintGroups: lint.groups.map((group) => ({ code: group.code, count: group.count, severity: group.severity })),
  };
}

function countBy(list, fn) {
  const out = {};
  for (const item of list) {
    const key = fn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

/** 把各库分类合并成全局分类，附分库分布。 */
export function aggregateCategories(kbs) {
  const map = new Map();
  for (const kb of kbs) {
    for (const category of kb.categories) {
      if (!category || category.count === 0) continue;
      let entry = map.get(category.code);
      if (!entry) {
        entry = {
          code: category.code,
          label: category.label,
          severity: category.severity,
          section: category.section,
          source: category.source,
          count: 0,
          kbCounts: {},
          items: [],
          hint: category.hint,
          action: category.action,
          rollback: category.rollback,
        };
        map.set(category.code, entry);
      }
      entry.count += category.count;
      entry.kbCounts[kb.name] = (entry.kbCounts[kb.name] ?? 0) + category.count;
      // 条目合并：每库最多带 maxItems，全局再截断
      for (const item of category.items) {
        entry.items.push({ ...item, kb: kb.name });
      }
      if (!entry.action && category.action) entry.action = category.action;
    }
  }
  return [...map.values()].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
      b.count - a.count ||
      a.code.localeCompare(b.code)
  );
}

/** 生成 Top N 建议动作（按 ACTION_PLAN 的优先级 + 实际数量）。 */
export function buildTopActions(categories, limit = 10) {
  const byCode = new Map(categories.map((category) => [category.code, category]));
  const actions = [];
  for (const plan of ACTION_PLAN) {
    const category = byCode.get(plan.code);
    if (!category || category.count === 0) continue;
    actions.push({
      rank: actions.length + 1,
      code: plan.code,
      title: plan.title,
      count: category.count,
      kbs: category.kbCounts,
      tool: plan.tool,
      how: plan.how,
      batch: plan.batch,
      snapshot: plan.snapshot,
      risk: plan.risk,
      manualData: plan.manualData,
      rollback: category.rollback,
    });
  }
  return actions.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 报告渲染
// ---------------------------------------------------------------------------

function fmtCounts(kbCounts) {
  return Object.entries(kbCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`)
    .join(" / ");
}

function table(headers, rows) {
  const lines = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

function renderMarkdown(report) {
  const { totals, categories, kbs, topActions, readOnly } = report;
  const lines = [];
  const warn = categories.filter((c) => c.severity !== "info");

  lines.push(`# 知识库质量只读审计报告（0.32 · 优先级 1）`);
  lines.push("");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 知识库根目录：\`${report.root}\``);
  lines.push(`- 插件版本：${report.pluginVersion}；解析管线：${report.parserVersion}`);
  lines.push(`- 扫描范围：${kbs.length} 个库 / ${totals.docs} 篇（资料 ${totals.sources}、笔记 ${totals.notes}）`);
  lines.push(
    `- 只读校验：${readOnly.verified ? "✅ 扫描前后清单与派生文件指纹一致（本轮未写库）" : "❌ **检测到扫描期间文件发生变化，报告不可信**"}`
  );
  if (report.contentScan === false) {
    lines.push(`- 内容层扫描：已跳过（--no-content-scan），U+FFFD / 私用区统计为 0 不代表没有`);
  } else {
    lines.push(`- 内容层扫描：${report.contentScanned} 篇派生 markdown（单遍字符级统计）`);
  }
  lines.push("");

  lines.push("## 1. 结论摘要");
  lines.push("");
  const errorCount = categories.filter((c) => c.severity === "error" && c.count > 0).length;
  const warningCount = categories.filter((c) => c.severity === "warning" && c.count > 0).length;
  const infoCount = categories.filter((c) => c.severity === "info" && c.count > 0).length;
  lines.push(
    `本轮共识别 **${categories.filter((c) => c.count > 0).length} 类**问题信号：` +
      `error ${errorCount} 类、warning ${warningCount} 类、info ${infoCount} 类。` +
      `其中 error 级 ${categories.filter((c) => c.severity === "error").reduce((s, c) => s + c.count, 0)} 条次，` +
      `warning 级 ${categories.filter((c) => c.severity === "warning").reduce((s, c) => s + c.count, 0)} 条次（同一篇可能命中多类，按类累计）。`
  );
  lines.push("");
  const highlights = [];
  const fffd = categories.find((c) => c.code === "content-fffd");
  if (fffd) {
    highlights.push(
      `**内容层丢字（U+FFFD）**：${fffd.count} 篇，而清单里的 \`corruptedPages\` 只标了 ${kbs.reduce((s, kb) => s + (kb.lintCounts?.corrupted ?? 0), 0)} 篇 —— 旧管线没有逐页质量元数据，` +
        `只看 kb_lint 会漏掉这批硬伤。`
    );
  }
  const dupTitle = categories.find((c) => c.code === "title-duplicate");
  if (dupTitle) {
    highlights.push(`**同标题重复**：${dupTitle.count} 组，多为 doc/pdf 双份或带后缀的重复导入（kb_lint 的 sourceHash/textHash 对旧库为空，抓不到）。`);
  }
  const metaMissing = categories.find((c) => c.code === "metadata-missing");
  if (metaMissing) {
    highlights.push(`**元数据缺失**：${metaMissing.count} 篇没有 sourceHash，内容去重与标准号检索都会受影响。`);
  }
  for (const item of highlights) lines.push(`- ${item}`);
  lines.push("");

  lines.push("## 2. 审计范围、方法与边界");
  lines.push("");
  lines.push("**只读保证**");
  lines.push("");
  lines.push("1. 脚本只 import `tryReadManifest` / `lintManifest` 与纯函数，不 import 任何写清单/写文档/删除函数；不调用 `listKbs`（它会 `mkdir` 根目录）。");
  lines.push("2. 扫描前后对每库 `kb.json` / `index.md` / `log.md` / `schema.md` 取 mtime+size+ino，并对 `sources/`、`markdown/` 整棵树取条目数、总字节与最大 mtime；不一致即 exit 2。");
  lines.push("3. 报告只写到 `--out`（默认 `docs/reports`），且拒绝写进被扫描的根目录。");
  lines.push("");
  lines.push("**检查项**");
  lines.push("");
  lines.push(
    table(
      ["分区", "说明"],
      SECTIONS.map(([code, label]) => [
        label,
        {
          state: "失败/导入中/软删除/临时文件/缺 schema",
          content: "0 字或极小正文、正文不完整、清单标注的坏页与低置信页、内容层 U+FFFD 与私用区字符、缺逐页 sidecar",
          identity: "缺 sourceHash、标题含标准号但无结构化元数据、标题可清洗、旧管线产物",
          duplicate: "同内容（sourceHash/textHash）、同标题、同标准号同期同阶段、多版本、过程稿、同族写法",
          compiled: "未编目、摘要乱码/过短、可信度缺失/偏低、笔记无来源/孤页/待合并",
          integrity: "派生 markdown 与分块缺失/不一致、sources/ 孤儿原件",
          manual: "手工维护字段清单（不是问题，供修复脚本避让）",
        }[code],
      ])
    )
  );
  lines.push("");
  lines.push("**未覆盖（需要人工或后续阶段）**");
  lines.push("");
  lines.push("- 语义层面的矛盾/陈旧结论（同一主题多份资料说法冲突）——机械审计无法判定。");
  lines.push("- 标准是否已有更新版本 —— 属于优先级 2（`kb_std_check`），本轮不查。");
  lines.push("- 检索索引（FTS）新鲜度 —— 直接打开 `.index/fts.sqlite` 可能产生 `-wal/-shm` 文件，与只读约束冲突，本轮不查。");
  lines.push("- 私用区字符（content-pua）只做统计，不建议批量重解析。");
  lines.push("");

  lines.push("## 3. 总量（按库）");
  lines.push("");
  lines.push(
    table(
      ["库", "文档", "资料", "笔记", "软删除", "失败", "导入中", "内容扫描", "派生缺失", "坏页(清单)", "U+FFFD", "私用区"],
      kbs.map((kb) => {
        const get = (code) => kb.categories.find((c) => c.code === code)?.count ?? 0;
        return [
          kb.name,
          kb.totals.docs,
          kb.totals.sources,
          kb.totals.notes,
          kb.totals.deleted,
          kb.totals.failed,
          kb.totals.importing,
          kb.contentScanned ?? 0,
          kb.derivedMissing ?? 0,
          get("corrupted"),
          get("content-fffd"),
          get("content-pua"),
        ];
      })
    )
  );
  lines.push("");

  // 可信度与手工数据构成：说明「低可信/未知」是问题还是正常
  const trustTotal = { high: 0, medium: 0, low: 0, unknown: 0 };
  for (const kb of kbs) {
    for (const [key, value] of Object.entries(kb.provenance?.trust ?? {})) {
      trustTotal[key in trustTotal ? key : "unknown"] += value;
    }
  }
  const lowReasons = {};
  for (const kb of kbs) {
    for (const [reason, value] of Object.entries(kb.trustLowReasons ?? {})) {
      lowReasons[reason] = (lowReasons[reason] ?? 0) + value;
    }
  }
  lines.push("### 可信度构成（解释低可信是否需要处理）");
  lines.push("");
  lines.push(
    table(
      ["high", "medium", "low", "unknown", "low 的理由分布"],
      [[
        trustTotal.high,
        trustTotal.medium,
        trustTotal.low,
        trustTotal.unknown,
        Object.entries(lowReasons).map(([reason, count]) => `${reason} ${count}`).join("；") || "-",
      ]]
    )
  );
  lines.push("");
  lines.push(
    "> `low` 大多是「已被新版代替的旧标准」或「征求意见稿/编制说明」，属于**正确的标注**，不要当成问题去修。"
  );
  lines.push("");

  lines.push("## 4. 问题分类与数量");
  lines.push("");
  for (const [code, sectionLabel] of SECTIONS) {
    const list = categories.filter((c) => c.section === code && c.count > 0);
    if (list.length === 0) continue;
    lines.push(`### ${sectionLabel}`);
    lines.push("");
    lines.push(
      table(
        ["类别", "代码", "严重度", "数量", "分库分布", "建议动作"],
        list.map((c) => [
          c.label,
          `\`${c.code}\``,
          c.severity,
          c.count,
          fmtCounts(c.kbCounts) || "-",
          c.action || "-",
        ])
      )
    );
    lines.push("");
    // 明细样例：让报告自己就能拿来讨论，不必再翻 JSON
    const sampleRows = [];
    for (const category of list) {
      if (category.severity === "info" || category.items.length === 0) continue;
      const samples = category.items.slice(0, 8);
      for (const item of samples) {
        sampleRows.push([
          category.code,
          item.kb ?? "-",
          `\`${item.docId}\``,
          String(item.title ?? "").replace(/\|/g, "\\|").slice(0, 70),
          String(item.detail ?? "").replace(/\|/g, "\\|").slice(0, 90),
        ]);
      }
      if (category.items.length > samples.length) {
        sampleRows.push([
          category.code,
          "…",
          `共 ${category.items.length} 条`,
          `其余 ${category.items.length - samples.length} 条见 JSON`,
          "",
        ]);
      }
    }
    if (sampleRows.length > 0) {
      lines.push("**明细样例（每类前 8 条；完整清单见 JSON）**");
      lines.push("");
      lines.push(table(["类别", "库", "docId", "标题", "明细"], sampleRows));
      lines.push("");
    }
  }

  lines.push("## 5. Top 10 建议动作（等确认后逐批执行）");
  lines.push("");
  if (topActions.length === 0) {
    lines.push("没有需要处理的问题。");
    lines.push("");
  }
  for (const action of topActions) {
    lines.push(`### ${action.rank}. ${action.title}（${action.count} 篇/组）`);
    lines.push("");
    lines.push(`- 涉及库：${fmtCounts(action.kbs)}`);
    lines.push(`- 工具：${action.tool}`);
    lines.push(`- 做法：${action.how}`);
    lines.push(`- 分批：${action.batch}`);
    lines.push(`- 快照：${action.snapshot}`);
    lines.push(`- 风险：${action.risk}`);
    lines.push(`- 手工数据：${action.manualData}`);
    lines.push(`- 回滚：${action.rollback}`);
    lines.push("");
  }

  lines.push("## 6. 回滚手册（后续修复批次统一遵循）");
  lines.push("");
  lines.push(
    table(
      ["操作", "回滚方式"],
      [
        ["任何写操作前", "`kb_snapshot`（库级快照，写入 `<kb>/snapshots/`）；大库可 includeSources=false 并注明局限"],
        ["`kb_remove`（默认软删除）", "`kb_restore` 恢复；软删除保留原件与分块"],
        ["`kb_remove soft=false`", "**不可恢复**，只用于临时文件/确认无价值的副本"],
        ["`kb_keep`", "`kb_keep clear=true` 取消标记"],
        ["`kb_trust`", "`kb_trust level=unknown` 清除标注"],
        ["`kb_describe`", "`kb_describe clear=true` 清空摘要与标签（原摘要需人工备份）"],
        ["`kb_retitle` / `kb_edit` / `kb_reparse`", "`kb_history` 查版本 → `kb_restore version=N`"],
        ["`backfill-doc-meta`", "执行前 kb_snapshot；清单可用快照里的 kb.json 覆盖回退"],
        ["孤儿原件移入回收站", "把文件从 `.trash/` 移回 `sources/<docId>.<ext>`"],
      ]
    )
  );
  lines.push("");

  lines.push("## 7. 手工数据保护清单");
  lines.push("");
  const manual = report.manualProtected;
  lines.push(`- \`summarySource=manual\`：${manual.summary.length} 篇`);
  for (const item of manual.summary) lines.push(`  - \`${item.docId}\` ${item.title}`);
  lines.push(`- \`titleSource=manual\`：${manual.title.length} 篇`);
  for (const item of manual.title) lines.push(`  - \`${item.docId}\` ${item.title}`);
  lines.push(`- \`trustSource=manual\`：${manual.trust} 篇`);
  lines.push("");
  lines.push(
    "> 注意：`trustSource=manual` 的存量几乎等于全库（旧清单迁移时默认写 manual），" +
      "不能当成「人工已核实」的证据。批量改可信度必须先逐条确认，不能按这个字段判断。"
  );
  lines.push("");

  lines.push("## 8. kb_lint 分组对照");
  lines.push("");
  const lintCodes = new Set();
  for (const kb of kbs) for (const group of kb.lintGroups ?? []) lintCodes.add(group.code);
  const lintRows = [];
  for (const code of [...lintCodes].sort()) {
    const row = [code];
    for (const kb of kbs) {
      row.push(kb.lintGroups?.find((g) => g.code === code)?.count ?? 0);
    }
    lintRows.push(row);
  }
  lines.push(
    table(
      ["lint 分组", ...kbs.map((kb) => kb.name)],
      lintRows.length > 0 ? lintRows : [["（无）", ...kbs.map(() => 0)]]
    )
  );
  lines.push("");
  lines.push(
    "> 说明：本报告对两个 lint 分组做了口径修正 —— `unlabeled` 改由 `summary-missing` 统计（只算资料，" +
      "笔记本来就没有摘要）；`duplicate-text` 只算正文 ≥200 字的资料（只有封面的残件另见 `tiny-content`）。" +
      "因此这两行的 lint 原始计数与正文分类表不同属正常。"
  );
  lines.push("");

  lines.push("## 9. 复现");
  lines.push("");
  lines.push("```bash");
  lines.push(
    `node scripts/quality-audit.mjs --root ${report.root}` +
      (report.selectedKbs?.length ? ` ${report.selectedKbs.map((n) => `--kb ${n}`).join(" ")}` : "")
  );
  lines.push("```");
  lines.push("");
  lines.push(`报告文件：\`${report.files?.json ?? ""}\` / \`${report.files?.markdown ?? ""}\``);
  lines.push("");
  lines.push(
    "> 修复批次复跑时请用 `--name <日期>-quality-audit-after` 另存，避免覆盖本基线报告，" +
      "这样前后对比才有据可查。"
  );
  lines.push("");
  lines.push("## 10. 只读证据");
  lines.push("");
  lines.push(`扫描前后指纹比对结果：**${readOnly.verified ? "一致（未写库）" : `不一致：${readOnly.changedKbs.join(", ")}`}**。`);
  lines.push("");
  lines.push(
    table(
      ["库", "kb.json mtime/size", "sources/", "markdown/", "index.md", "log.md"],
      kbs.map((kb) => {
        const fp = (readOnly.after ?? readOnly.before)?.[kb.name] ?? {};
        const manifest = fp.files?.["kb.json"];
        return [
          kb.name,
          manifest ? `${new Date(manifest.mtimeMs).toISOString()} / ${manifest.size}B` : "缺失",
          fp.sources?.entries ?? 0,
          `${fp.markdown?.entries ?? 0} 个文件 / ${Math.round((fp.markdown?.bytes ?? 0) / 1024)}KB`,
          fp.files?.["index.md"] ? "有" : "缺失",
          fp.files?.["log.md"] ? "有" : "缺失",
        ];
      })
    )
  );
  lines.push("");
  lines.push(
    "> 只读是「扫完再核对」：如果扫描期间有其他进程（宿主/导入任务）在写库，这里会显示不一致，报告结论需重跑确认。"
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function auditRoot(options = {}) {
  const startedAt = Date.now();
  const root = resolve(expandRoot(options.root ?? ""));
  if (!root) throw new Error("必须提供 --root（知识库根目录）");
  const out = resolve(options.out ?? DEFAULT_OUT);
  if (out === root || out.startsWith(root + sep)) {
    throw new Error(`拒绝把报告写进被扫描的知识库根目录: ${out}`);
  }
  const name = String(options.name ?? "").trim() || `${today()}-kb-quality-audit`;
  const dirs = await listKbDirs(root, options.kbs ?? []);
  if (dirs.length === 0) throw new Error(`根目录下没有找到知识库: ${root}`);

  const before = await fingerprintRoot(root, dirs);
  const kbs = [];
  for (const item of dirs) {
    kbs.push(
      await auditKb({
        dir: item.dir,
        name: item.name,
        manifest: item.manifest,
        options: { ...options, now: startedAt },
      })
    );
  }
  const after = await fingerprintRoot(root, dirs);
  const changed = [];
  for (const item of dirs) {
    if (JSON.stringify(before[item.name]) !== JSON.stringify(after[item.name])) changed.push(item.name);
  }
  const readOnly = {
    verified: changed.length === 0,
    changedKbs: changed,
    before,
    after,
  };

  const categories = aggregateCategories(kbs);
  const totals = kbs.reduce(
    (sum, kb) => ({
      kbs: sum.kbs + 1,
      docs: sum.docs + kb.totals.docs,
      ready: sum.ready + kb.totals.ready,
      notes: sum.notes + kb.totals.notes,
      sources: sum.sources + kb.totals.sources,
      deleted: sum.deleted + kb.totals.deleted,
      failed: sum.failed + kb.totals.failed,
      importing: sum.importing + kb.totals.importing,
    }),
    { kbs: 0, docs: 0, ready: 0, notes: 0, sources: 0, deleted: 0, failed: 0, importing: 0 }
  );

  const manualProtected = { summary: [], title: [], trust: 0 };
  for (const kb of kbs) {
    manualProtected.summary.push(...kb.manualProtected.summary);
    manualProtected.title.push(...kb.manualProtected.title);
    manualProtected.trust += kb.manualProtected.trust.count;
  }

  const report = {
    report: "kb-quality-audit",
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    pluginVersion: VERSION,
    parserVersion: PARSER_VERSION,
    root,
    selectedKbs: options.kbs ?? [],
    contentScan: options.contentScan !== false,
    contentScanned: kbs.reduce((sum, kb) => sum + (kb.contentScanned ?? 0), 0),
    totals,
    counts: Object.fromEntries(categories.map((category) => [category.code, category.count])),
    categories,
    kbs,
    manualProtected,
    topActions: buildTopActions(categories, 10),
    readOnly,
    files: {},
  };

  const jsonPath = join(out, `${name}.json`);
  const markdownPath = join(out, `${name}.md`);
  report.files = { json: jsonPath, markdown: options.jsonOnly === true ? "" : markdownPath };
  await mkdir(out, { recursive: true });
  // JSON 里每类条目按 maxItems 截断（计数是完整的）
  const jsonReport = {
    ...report,
    categories: report.categories.map((category) => {
      const cap = category.severity === "info" ? Math.min(options.maxItems ?? 200, 50) : options.maxItems ?? 200;
      return {
        ...category,
        items: category.items.slice(0, cap),
        itemsTruncated: category.items.length > cap,
      };
    }),
    kbs: report.kbs.map((kb) => ({
      ...kb,
      categories: kb.categories.map((category) => {
        const cap = category.severity === "info" ? Math.min(options.maxItems ?? 200, 50) : options.maxItems ?? 200;
        return { ...category, items: category.items.slice(0, cap), itemsTruncated: category.items.length > cap };
      }),
    })),
    readOnly: {
      verified: readOnly.verified,
      changedKbs: readOnly.changedKbs,
      fingerprint: readOnly.after,
    },
  };
  await writeFile(jsonPath, JSON.stringify(jsonReport, null, 2), "utf8");
  if (options.jsonOnly !== true) {
    await writeFile(markdownPath, renderMarkdown(report), "utf8");
  }

  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.root) {
    usage();
    throw new Error("缺少 --root");
  }
  const report = await auditRoot(options);
  const warn = report.categories.filter((c) => c.count > 0 && c.severity !== "info");
  if (!options.quiet) {
    console.log(`[audit] root=${report.root}`);
    console.log(`[audit] ${report.totals.kbs} 库 / ${report.totals.docs} 篇；内容扫描 ${report.contentScanned} 篇`);
    console.log(`[audit] 只读校验：${report.readOnly.verified ? "通过（未写库）" : `失败（${report.readOnly.changedKbs.join(",")}）`}`);
    for (const category of warn) {
      console.log(`[audit] ${category.severity.padEnd(7)} ${category.code.padEnd(24)} ${category.count}`);
    }
    console.log(`[audit] 报告：${report.files.json}`);
    if (report.files.markdown) console.log(`[audit] 报告：${report.files.markdown}`);
  } else {
    console.log(
      `[audit] ${report.totals.docs} 篇 / ${warn.length} 类问题 / 只读校验 ${report.readOnly.verified ? "通过" : "失败"}`
    );
  }
  if (!report.readOnly.verified) {
    console.error("[audit] 扫描期间检测到知识库文件变化，请检查是否有其他进程在写库");
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[audit] 失败: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
