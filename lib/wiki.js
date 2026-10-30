/**
 * Wiki 编译层：schema.md（维护规范）、index.md（内容目录）、log.md（操作流水），
 * 以及笔记的 kind/tags/sources、摘要与反链等纯函数。
 *
 * 设计原则：
 *  - manifest（kb.json）是唯一事实来源；index/log/schema 是面向人与模型的可读视图；
 *  - 本模块不导入 store.js（store 会导入本模块），避免循环依赖；
 *  - index.md 由清单渲染，log.md 只追加，schema.md 只在缺失时写入模板。
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { noteKindLabel, trustLabel, typeLabel } from "./labels.js";

// ---------------------------------------------------------------------------
// 虚拟文档：kb_read / kb_edit 用保留名访问 schema / index / log
// ---------------------------------------------------------------------------

export const VIRTUAL_DOCS = new Map([
  ["schema", "schema"],
  ["schema.md", "schema"],
  ["_schema", "schema"],
  ["index", "index"],
  ["index.md", "index"],
  ["_index", "index"],
  ["log", "log"],
  ["log.md", "log"],
  ["_log", "log"],
]);

export const VIRTUAL_TITLES = {
  schema: "维护规范",
  index: "内容索引",
  log: "操作日志",
};

export const VIRTUAL_TYPES = {
  schema: "schema",
  index: "index",
  log: "log",
};

/** 笔记 kind 白名单。 */
export const NOTE_KINDS = ["note", "summary", "entity", "concept", "topic"];

// ---------------------------------------------------------------------------
// schema.md —— 维护规范
// ---------------------------------------------------------------------------

export function schemaTemplate(kbName) {
  return `# schema.md — 知识库「${kbName}」维护规范

你是本知识库的维护代理：把 sources/ 的原始资料编译成可累积的知识页，
并长期维护一致性、交叉链接与可追溯性。本文件可修改（kb_edit doc="schema"），
插件不会覆盖已存在的内容。

## 三层结构
1. 原始层 sources/：导入的原始文件，只读（重新导入/重解析除外），不要改名或改写。
2. 派生层 markdown/：插件从原始文件生成的合并版与分块，供检索与精读。
3. 编译层：用 kb_add_note 写下的摘要/实体/概念/专题页（kind=summary|entity|concept|topic），
   这是知识库长期增值的部分，优先阅读这一层。

## 页面规范
- 笔记标题用名词短语；同一主题只保留一篇（同标题再写=更新，不要用「续」「修订版」另起新页）。
- 每篇笔记尽量写 sources（docId 或 docId#页码），没有出处的结论要标注「待核实」。
- 有长期价值的问答结论要沉淀成笔记，不要只留在对话里。
- 定期检查：互相矛盾的结论、被新资料推翻的旧结论、没有被引用的孤页、缺少资料的主题。

## 维护文件
- 内容索引 index.md：插件按清单自动生成，不要手改。
- 操作日志 log.md：插件只追加，不要回写历史。
- 摘要与标签：用 kb_describe 给文档写一行摘要 + 标签，索引会随之更新。
- 可信度：用 kb_trust 标 high/medium/low（发布/现行标准、正式教材为 high；企业文件/报批稿为 medium；草案/征求意见/已废止为 low）。
  检索遇到多份矛盾资料时，优先采用 high，并提醒用户 low 来源。
- 废止判断：同一标准号不同年份时，新版封面明确写“代替 <旧版号-年>”，就把旧版标 low、理由写“已被 X 代替”；
  报批稿/征求意见稿等过程稿不能作为废止旧版的依据。
- 本规范：用 kb_edit(doc="schema") 修订，用 kb_read(doc="schema") 查看。

## 三类操作
### ingest（摄取新资料）
1. kb_import 导入；
2. **导入后先 kb_retitle(all=true) 预览标题清洗**，确认后 dryRun=false 应用；
3. kb_read 读要点，kb_describe 写一行摘要与标签；存量文档可用 kb_describe(all=true, auto=true) 回填；
4. 用 kb_trust 标注来源可信度（发布/现行 high、企业文件/报批稿 medium、草案/征求意见/已废止 low）；
5. 更新或新建相关笔记（kb_add_note），在笔记里用 [[标题]] 或 docId#p12 建立交叉引用；
6. 确认 index.md（kb_read doc="index"）已反映新资料；必要时 kb_lint 复查。

### query（问答并沉淀）
1. 先 kb_read(doc="index") 定位页面，再用 kb_query / kb_read 精读，回答注明 docId 与页码；
2. 有长期价值的回答，整理后用 kb_add_note(kind="topic", sources=[...]) 存回；
3. 若结论修改了旧笔记，直接更新同一篇笔记（同标题），不要新开页面。

### lint（体检）
1. 找矛盾/被推翻的结论，在笔记中标注「已过时（被《X》取代）」；
2. 找只有引用没有内容的孤页，补摘要或并入主题页；
3. 找信息缺口，列出建议补充的资料清单（可写成一篇 kind="topic" 的笔记）。
`;
}

/** 读取 schema.md；不存在时返回 {exists:false, text:""}。 */
export async function readSchema(kbDir) {
  try {
    const text = await readFile(join(kbDir, "schema.md"), "utf8");
    return { exists: true, text, chars: text.length };
  } catch {
    return { exists: false, text: "", chars: 0 };
  }
}

/** 原子写 schema.md。 */
export async function writeSchema(kbDir, text) {
  await mkdir(kbDir, { recursive: true });
  const tmp = join(kbDir, `.schema.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, text, "utf8");
  await rename(tmp, join(kbDir, "schema.md"));
}

/** 建库时写入默认 schema.md；已存在则不覆盖。 */
export async function ensureSchema(kbDir, kbName) {
  const { exists } = await readSchema(kbDir);
  if (exists) return false;
  await writeSchema(kbDir, schemaTemplate(kbName || basename(kbDir)));
  return true;
}

// ---------------------------------------------------------------------------
// log.md —— 只追加的操作流水
// ---------------------------------------------------------------------------

const LOG_MAX_BYTES = 1.5 * 1024 * 1024;
const LOG_KEEP_LINES = 3000;

function logTimestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/**
 * 追加一条操作日志。
 * @param entry { action, title, docId?, version?, detail? }
 */
export async function appendLog(kbDir, entry) {
  const { action = "update", title = "", docId = "", version, detail = "" } = entry ?? {};
  const line =
    `- ${logTimestamp()}  ${String(action).padEnd(8)}  ${title}` +
    `${docId ? `（${docId}）` : ""}${version ? ` v${version}` : ""}` +
    `${detail ? `  ${detail}` : ""}\n`;
  const file = join(kbDir, "log.md");
  try {
    await mkdir(kbDir, { recursive: true });
    let exists = true;
    try {
      await stat(file);
    } catch {
      exists = false;
    }
    if (exists) {
      await appendFile(file, line, "utf8");
    } else {
      await writeFile(file, `# 操作日志\n\n${line}`, "utf8");
    }
    const info = await stat(file);
    if (info.size > LOG_MAX_BYTES) {
      const raw = await readFile(file, "utf8");
      const lines = raw.split("\n");
      const kept = lines.slice(-LOG_KEEP_LINES);
      await writeFile(file, `# 操作日志\n\n${kept.join("\n")}`.replace(/\n{3,}/g, "\n\n"), "utf8");
    }
  } catch {
    /* 日志是附属产物：写失败不能影响主流程 */
  }
}

export async function readLog(kbDir) {
  try {
    return await readFile(join(kbDir, "log.md"), "utf8");
  } catch {
    return "# 操作日志\n\n（暂无记录）\n";
  }
}

/** 启动时补一份空日志（已存在不覆盖），让知识库目录结构自解释。 */
export async function ensureLog(kbDir) {
  const file = join(kbDir, "log.md");
  try {
    await stat(file);
  } catch {
    await mkdir(kbDir, { recursive: true });
    await writeFile(file, "# 操作日志\n\n（暂无记录）\n", "utf8");
  }
}

// ---------------------------------------------------------------------------
// index.md —— 内容目录（由清单渲染）
// ---------------------------------------------------------------------------

function oneLine(text, max = 160) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

function fmtDate(iso) {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "-";
  return new Date(t).toISOString().replace("T", " ").slice(0, 16);
}

function docLine(doc) {
  const summary = oneLine(doc.summary, 120) || "（未编目）";
  const meta = [
    doc.id,
    doc.type === "note" ? noteKindLabel(doc.kind) : typeLabel(doc.type),
    doc.pages ? `${doc.pages}页` : "",
    `${doc.chars ?? 0}字`,
    `v${doc.version ?? 0}`,
    `可信度:${trustLabel(doc.trust)}`,
    fmtDate(doc.updatedAt),
  ].filter(Boolean);
  const tags = Array.isArray(doc.tags) && doc.tags.length > 0 ? `  #${doc.tags.join(" #")}` : "";
  return `- ${doc.title} — ${summary}〔${meta.join("｜")}〕${tags}`;
}

/**
 * 由清单渲染 index.md 文本。
 * 编译层（笔记）排在前面：回答问题时优先看这些页，再回到原始资料。
 */
export function renderIndex(manifest) {
  const all = manifest?.docs ?? [];
  const ready = all.filter((d) => d.status === "ready" && !d.deletedAt && d.status !== "deleted");
  const notes = ready
    .filter((d) => d.type === "note")
    .sort((a, b) => String(a.kind ?? "note").localeCompare(String(b.kind ?? "note")) || String(a.title).localeCompare(String(b.title), "zh-Hans-CN"));
  const sources = ready
    .filter((d) => d.type !== "note")
    .sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"));
  const failed = all.filter((d) => d.status === "failed");
  const lines = [
    `# 知识库「${manifest?.name ?? ""}」索引`,
    "",
    `> 更新时间：${fmtDate(new Date().toISOString())}｜共 ${all.length} 篇（就绪 ${ready.length}，笔记 ${notes.length}，资料 ${sources.length}${failed.length ? `，失败 ${failed.length}` : ""}）`,
    "> 本文件由插件按清单生成；`kb_read(doc=\"index\")` 查看，不要手改。",
    "",
    "## 编译页（笔记）",
    "",
  ];
  if (notes.length === 0) {
    lines.push("（还没有笔记；用 kb_add_note 沉淀结论，kind=summary|entity|concept|topic）");
  } else {
    for (const doc of notes) lines.push(docLine(doc));
  }
  lines.push("", "## 原始资料", "");
  if (sources.length === 0) {
    lines.push("（暂无资料；用 kb_import 导入）");
  } else {
    for (const doc of sources) lines.push(docLine(doc));
  }
  if (failed.length > 0) {
    lines.push("", "## 导入失败", "");
    for (const doc of failed) {
      lines.push(`- ${doc.title}（${doc.id}）— ${oneLine(doc.error, 120) || "导入失败"}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** 写 index.md（原子）。 */
export async function writeIndex(kbDir, manifest) {
  await mkdir(kbDir, { recursive: true });
  const text = renderIndex(manifest);
  const tmp = join(kbDir, `.index.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, text, "utf8");
  await rename(tmp, join(kbDir, "index.md"));
  return text;
}

/**
 * 索引比 kb.json 新就直接返回缓存，否则重写后返回。
 * kb_read(doc="index") 与导出共用：既保证读到最新，又不必每次重写。
 */
export async function refreshIndexIfStale(kbDir, manifest) {
  const indexPath = join(kbDir, "index.md");
  try {
    const [indexInfo, manifestInfo] = await Promise.all([stat(indexPath), stat(join(kbDir, "kb.json"))]);
    if (indexInfo.mtimeMs >= manifestInfo.mtimeMs) {
      return { text: await readFile(indexPath, "utf8"), refreshed: false };
    }
  } catch {
    /* 缺文件或清单：下面重写 */
  }
  return { text: await writeIndex(kbDir, manifest), refreshed: true };
}

// ---------------------------------------------------------------------------
// 虚拟文档读取：按 partMaxChars 切分，支持 outline / all / 序号
// ---------------------------------------------------------------------------

/** 按行把长文本切成不超过 maxChars 的部分。 */
export function splitVirtualParts(text, maxChars = 8000) {
  const cap = Math.max(500, Math.floor(Number(maxChars) || 8000));
  const value = String(text ?? "");
  if (value.length <= cap) return [value];
  const parts = [];
  let current = "";
  for (const line of value.split("\n")) {
    if (line.length > cap) {
      if (current) {
        parts.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += cap) parts.push(line.slice(i, i + cap));
      continue;
    }
    if (current && current.length + line.length + 1 > cap) {
      parts.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [""];
}

/** 读取虚拟文档全文（schema / index / log）。 */
export async function readVirtualDoc(kbDir, kind, manifest) {
  if (kind === "schema") {
    const { text } = await readSchema(kbDir);
    return {
      title: VIRTUAL_TITLES.schema,
      text: text || schemaTemplate(manifest?.name ?? basename(kbDir)),
      exists: Boolean(text),
    };
  }
  if (kind === "index") {
    const { text } = await refreshIndexIfStale(kbDir, manifest);
    return { title: VIRTUAL_TITLES.index, text, exists: true };
  }
  const text = await readLog(kbDir);
  return { title: VIRTUAL_TITLES.log, text, exists: true };
}

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

/** OCR 页眉/标准头行：ICS/CCS/GB/T 编号行、扫描页眉，摘要里要跳过。 */
const SUMMARY_HEADER_RE = /^(?:ICS|CCS|ISBN|GB\/?T?|DL\/?T?|NB\/?T?|JB\/?T?|HG\/?T?|YD\/?T?|IEC|ISO|EN|Q\/GDW)\s*(?:[\d０-９]|[/／]|[A-Z])/i;

/** 一行是否像 OCR 噪声：大量 1–2 字符的拉丁碎片、替换符、或无可读词。 */
export function isOcrNoiseLine(value) {
  const line = String(value ?? "").trim();
  if (line.length < 8) return false;
  if (/\uFFFD{1,}/.test(line)) return true;
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length < 6) return false;
  const short = tokens.filter((token) => /^[A-Za-z0-9]{1,2}$/.test(token)).length;
  const latin = tokens.filter((token) => /^[A-Za-z]{1,}$/.test(token)).length;
  return short / tokens.length >= 0.5 || latin / tokens.length >= 0.6;
}

/** 摘要前的清洗：跳过 OCR 页眉/ICS 行/乱码行；全都像噪声时退回原文。 */
export function cleanSummaryText(value, { fallbackToOriginal = true } = {}) {
  const lines = String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const kept = lines.filter((line) => {
    if (SUMMARY_HEADER_RE.test(line) && line.length <= 120) return false;
    return !isOcrNoiseLine(line);
  });
  if (kept.length > 0) return kept.join(" ");
  return fallbackToOriginal ? lines.join(" ") : "";
}

/** 抽取式摘要：取第一段有实质内容的正文（跳过 OCR 页眉/乱码），失败时退回标题。 */
export function summarizeSections(sections, maxChars = 160) {
  for (const section of Array.isArray(sections) ? sections : []) {
    const cleaned = cleanSummaryText(section?.text, { fallbackToOriginal: false });
    if (cleaned === "") continue;
    const text = cleaned
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[#>*_`|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length >= 20) return oneLine(text, maxChars);
  }
  const first = Array.isArray(sections) ? sections.find((s) => s?.heading) : null;
  return first ? oneLine(first.heading, maxChars) : "";
}

const SCOPE_HEADING_RE = /^\s*(?:[（(]?\s*(?:1|１|一)\s*[）)]?\s*[.、]?\s*)?主题内容(?:与|和)?适用范围\s*$|^\s*[（(]?\s*(?:1|１|一)\s*[）)]?\s*[.、]?\s*范\s*围(?:[\s.·…]*\d+)?\s*$/;
const NEXT_CLAUSE_RE = /^\s*(?:[（(]?\s*(?:2|２|二)\s*[）)]?\s*[.、]?\s*\S|(?:[（(]?\s*\d+\s*[）)]?\s*[.、]?\s*)?(?:规范性引用文件|引用标准|术语和定义|术语|定义|符号和缩略语)\s*$)/;
const TOC_LINE_RE = /[.·…]{3,}\s*\d+\s*$|^\s*\d+\s*[.、]?\s*\S+\s+\d+\s*$/;

/**
 * 标准类资料优先用第 1 章「范围」当摘要（标准一般都有这一节）。
 * 支持「1 范围」「1范围」「（1）范围」「主题内容与适用范围」；
 * 跳过目次、页眉/页码、标准号行/OCR 噪声，遇到下一章（2 …）停止；
 * 目次里也有「1 范围 1」，取实质内容最长的那一段，避免把目录当摘要。
 */
export function summarizeStandardScope(value, maxChars = 160, { title = "" } = {}) {
  const lines = String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const cleanTitle = String(title ?? "").replace(/\s+/g, " ").trim();
  let best = "";
  for (let start = 0; start < lines.length; start += 1) {
    if (!SCOPE_HEADING_RE.test(lines[start])) continue;
    const collected = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (NEXT_CLAUSE_RE.test(line)) break;
      if (TOC_LINE_RE.test(line)) break;
      if (/^#{1,6}\s+/.test(line)) continue;
      if (/^\d+\s*\/\s*\d+$/.test(line)) continue;
      if (/^\|/.test(line)) continue;
      if (SUMMARY_HEADER_RE.test(line) && line.length <= 120) continue;
      if (isOcrNoiseLine(line)) continue;
      if (/^(?:GB|GB\/T|GB\/Z|DL|DL\/T|NB|NB\/T|Q\/GDW|IEC|ISO|TB|JB|YD)\s*[\d/]/.test(line) && line.length < 80) continue;
      if (cleanTitle && line.replace(/\s+/g, " ").trim() === cleanTitle) continue;
      collected.push(line);
      if (collected.join(" ").length > maxChars * 2) break;
    }
    const text = collected.join(" ").replace(/\s+/g, " ").trim();
    if (text.length >= 20 && text.length > best.length) best = text;
  }
  return best.length >= 20 ? oneLine(best, maxChars) : "";
}

export function summarizeText(text, maxChars = 160) {
  const clean = String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine(clean, maxChars);
}

// ---------------------------------------------------------------------------
// 标签与来源引用
// ---------------------------------------------------------------------------

export function normalizeTags(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === "string") list = input.split(/[,，、\s]+/);
  const out = [];
  for (const raw of list) {
    const tag = String(raw ?? "")
      .replace(/^#+/, "")
      .replace(/^\[+|\]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (tag.length === 0) continue;
    if (/[,，、\n]/.test(tag)) continue;
    if (tag.length > 32) continue;
    if (!out.includes(tag)) out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

/** 宽松查询：id 精确 / 标题精确（忽略大小写）/ 标题唯一子串。 */
export function findDocLoose(manifest, ref) {
  const s = String(ref ?? "").trim();
  if (!s) return null;
  const docs = (manifest?.docs ?? []).filter((d) => d.status !== "deleted" && !d.deletedAt);
  const exact = docs.find((d) => d.id === s);
  if (exact) return exact;
  const lower = s.toLowerCase();
  const titleExact = docs.filter((d) => String(d.title ?? "").toLowerCase() === lower);
  if (titleExact.length === 1) return titleExact[0];
  const titlePart = docs.filter((d) => String(d.title ?? "").toLowerCase().includes(lower));
  if (titlePart.length === 1) return titlePart[0];
  return null;
}

/** 从正文里抽取 [[双链]] 标题（不去重，调用方归一）。 */
export function linksFromContent(content) {
  const out = [];
  const re = /\[\[([^\]\n]{1,200})\]\]/g;
  let m;
  while ((m = re.exec(String(content ?? ""))) !== null) {
    const name = m[1].trim();
    if (name) out.push(name);
  }
  return out;
}

/**
 * 规范化笔记的来源引用：
 *   "docId" / "docId#p12" / "[[标题]]" / "标题" → "docId#p12"
 * 解析不到的引用原样保留并给出 warning（不阻断写入）。
 */
export function normalizeSources(input, manifest) {
  const list = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input];
  const sources = [];
  const linksOut = new Set();
  const warnings = [];
  for (const raw of list) {
    let s = String(raw ?? "").trim();
    if (!s) continue;
    const bracket = /^\[\[([\s\S]+)\]\]$/.exec(s);
    if (bracket) s = bracket[1].trim();
    let page = null;
    const hash = /^(.+?)#p?(\d+)$/i.exec(s);
    if (hash) {
      s = hash[1].trim();
      page = Number(hash[2]);
    }
    const doc = findDocLoose(manifest, s);
    if (!doc) {
      // 解析不到时保留原始引用（含页码），方便之后补对应文档
      sources.push(page !== null ? `${s}#p${page}` : s);
      warnings.push(`来源 "${s}" 未在库内找到，已按原文保留`);
      continue;
    }
    linksOut.add(doc.id);
    if (page !== null && Number(doc.pages) > 0 && page > Number(doc.pages)) {
      warnings.push(`来源 ${doc.title} 的页码 ${page} 超出总页数 ${doc.pages}`);
    }
    const ref = page !== null ? `${doc.id}#p${page}` : doc.id;
    if (!sources.includes(ref)) sources.push(ref);
  }
  return { sources, linksOut: [...linksOut], warnings };
}

/** 笔记里 [[标题]] → docId，并入 linksOut。 */
export function resolveContentLinks(content, manifest) {
  const linksOut = [];
  for (const name of linksFromContent(content)) {
    const doc = findDocLoose(manifest, name);
    if (doc && !linksOut.includes(doc.id)) linksOut.push(doc.id);
  }
  return linksOut;
}

/** 谁引用了这篇文档（按笔记的 sources / linksOut 反查）。 */
export function backlinksFor(manifest, docId) {
  const out = [];
  for (const doc of manifest?.docs ?? []) {
    if (doc.type !== "note" || doc.id === docId) continue;
    if (doc.status === "deleted" || doc.deletedAt) continue;
    const hit =
      (Array.isArray(doc.linksOut) && doc.linksOut.includes(docId)) ||
      (Array.isArray(doc.sources) && doc.sources.some((s) => String(s).split("#")[0] === docId));
    if (hit) {
      out.push({
        docId: doc.id,
        title: doc.title,
        kind: doc.kind ?? "note",
        sources: Array.isArray(doc.sources) ? doc.sources.filter((s) => String(s).split("#")[0] === docId) : [],
      });
    }
  }
  return out.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"));
}

// ---------------------------------------------------------------------------
// YAML frontmatter（仅导出时渲染，笔记正文保持纯净）
// ---------------------------------------------------------------------------

function yamlScalar(value) {
  const s = String(value ?? "");
  if (/^[\w\u4e00-\u9fa5./#-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 生成 note 的 YAML frontmatter；非笔记或无元数据时返回 ""。 */
export function frontmatterFor(doc) {
  if (doc?.type !== "note") return "";
  const lines = ["---", `title: ${yamlScalar(doc.title)}`];
  if (doc.kind) lines.push(`kind: ${yamlScalar(doc.kind)}`);
  if (Array.isArray(doc.tags) && doc.tags.length > 0) {
    lines.push(`tags: [${doc.tags.map(yamlScalar).join(", ")}]`);
  }
  if (Array.isArray(doc.sources) && doc.sources.length > 0) {
    lines.push(`sources: [${doc.sources.map(yamlScalar).join(", ")}]`);
  }
  if (doc.summary) lines.push(`summary: ${yamlScalar(doc.summary)}`);
  if (doc.updatedAt) lines.push(`updated: ${yamlScalar(doc.updatedAt)}`);
  lines.push("---", "", "");
  return lines.join("\n");
}
