/**
 * 找资料：标准走标准网检索，其他资料走 DeepSeek Search；
 * 支持从图片里先 OCR 出标准号/标题（默认本地 OCR，显式才上云）。
 *
 * 只返回候选，不自动下载/入库：搜索结果里转载、错版、付费墙混杂，
 * 由用户或 agent 确认后再用 kb_import 导入。
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { deepseekSearch } from "./deepseek-api.js";
import { extractStdRef, familyOf, parseSearchResults, queryCandidates, searchStd } from "./standards.js";
import { ocrImageBatch } from "./ocr.js";
import { kbDirPath, readManifest } from "./store.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 标准号规范化：用于候选去重。 */
export function normalizeStdKey(value) {
  const ref = extractStdRef(String(value ?? ""));
  return ref ? `${ref.prefix}${ref.number}${ref.year != null ? `-${ref.year}` : ""}`.replace(/\s+/g, "") : "";
}

/** 从封面 OCR 行里挑最像标准名称的一行（排除编号、发布信息、机构名）。 */
export function guessTitleFromOcrLines(lines) {
  const candidates = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (line.length < 6 || line.length > 60) continue;
    if (!/[\u4e00-\u9fa5]/.test(line)) continue;
    if (/^(?:ICS|CCS|代替|发布|实施|国家电网|中国|标准|Q\/|GB|DL|NB)/i.test(line)) continue;
    if (/(?:发布|实施|代替|企业标准|前言|目次|ICS|CCS)/.test(line)) continue;
    candidates.push(line);
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] ?? "";
}

const STD_LINE_RE = /(?:Q\/GDW|Q\/[A-Z]{2,4}|GB\/T|GB\/Z|GB|DL\/T|NB\/T|JB\/T|HG\/T|YD\/T|TB\/T|CJJ|JGJ|JJF|JJG|IEC\/TS|IEC\/TR|IEC|IEEE|ISO|EN)\s*\d+(?:\.\d+)*(?:\s*[-—–~～]\s*(?:19|20)\d{2})?/i;

/** 在一段 OCR 文本里找第一个标准号：逐行试（封面/页眉常见整行编号）。 */
export function firstStandardRef(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.replace(/[《》【】]/g, "").trim());
  for (const line of lines) {
    if (line === "") continue;
    const ref = extractStdRef(line);
    if (ref) return ref;
    const match = STD_LINE_RE.exec(line);
    if (match) {
      const fromMatch = extractStdRef(match[0]);
      if (fromMatch) return fromMatch;
    }
  }
  return null;
}

/** 从 OCR 文本里猜搜索词：优先标准号，其次第一行像标题的中文。 */
export function queryFromOcrText(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return { query: "", kind: "general", standardNo: "" };
  const ref = firstStandardRef(raw);
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/[<>|]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const guessedTitle = guessTitleFromOcrLines(lines);
  if (ref) {
    const standardNo = `${ref.prefix} ${ref.number}${ref.year != null ? `-${ref.year}` : ""}`.trim();
    return {
      // 先给网页搜索用「标准号 + 标题」；标准网检索仍用 standardNo 字段的纯编号。
      query: [standardNo, guessedTitle].filter(Boolean).join(" "),
      kind: "standard",
      standardNo,
      title: guessedTitle,
    };
  }
  const title = guessedTitle || lines.find((line) => line.length >= 4) || raw.slice(0, 80);
  return { query: title, kind: "general", standardNo: "", title };
}

/** 图片 → PNG（mupdf 也能把常见图片当单页文档打开）。 */
async function imageToPng(path, dpi = 200) {
  const { default: mupdf } = await import("mupdf");
  const data = await readFile(path);
  const ext = extname(String(path)).toLowerCase();
  if (ext === ".webp") throw new Error("WebP 图片请先转换为 PNG/JPEG 再查找（工作台会自动转换）");
  if (![".png", ".jpg", ".jpeg"].includes(ext)) throw new Error("图片仅支持 PNG/JPEG");
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  let doc;
  try {
    doc = mupdf.Document.openDocument(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), mime);
  } catch (error) {
    throw new Error(`无法读取图片（支持 PNG/JPEG/WebP）：${error?.message ?? error}`);
  }
  try {
    if (doc.countPages() < 1) throw new Error("图片没有可识别页面");
    const page = doc.loadPage(0);
    const zoom = Math.max(0.5, Math.round(dpi) / 72);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      return pixmap.asPNG();
    } finally {
      try { pixmap.destroy(); } catch { /* ignore */ }
      try { page.destroy(); } catch { /* ignore */ }
    }
  } finally {
    try { doc.destroy(); } catch { /* ignore */ }
  }
}

/** OCR 一张图片，返回文本与引擎标记（cloud=true 表示已上传云端）。 */
export async function recognizeImageQuery(path, {
  engine = "auto",
  deepseek = null,
  cloudOcrEnabled = true,
  cloudOcrConcurrency = 3,
} = {}) {
  const png = await imageToPng(path);
  const warnings = [];
  if (engine === "deepseek" && cloudOcrEnabled === false) {
    throw new Error("云端 OCR 已在插件配置中禁用（cloudOcrEnabled=false）");
  }
  const apiKey = engine === "deepseek" ? String(deepseek?.resolveKey ? await deepseek.resolveKey() : "") : "";
  if (engine === "deepseek" && apiKey === "") {
    throw new Error("云端 OCR 需要 DeepSeek API Key：宿主未配置 DEEPSEEK_API_KEY");
  }
  const results = await ocrImageBatch([{ png, page: 1 }], {
    engine: engine === "deepseek" ? "deepseek" : "auto",
    ...(engine === "deepseek" ? { deepseek: { apiKey, baseUrl: deepseek?.baseUrl, concurrency: cloudOcrConcurrency } } : {}),
    onWarning: (message) => warnings.push(message),
  });
  const text = String(results?.[0]?.text ?? "").trim();
  const cloud = results?.[0]?.engine === "deepseek";
  return { text, cloud, warnings };
}

/** 标准网候选：按编号检索，返回统一结构（找不到返回空数组）。 */
export async function searchStandards({
  query,
  stdNo = "",
  baseUrl = "https://www.biaozhun.org",
  cookie = "",
  rateMs = 1200,
  fetchImpl,
  limit = 10,
} = {}) {
  const ref = extractStdRef(stdNo || query || "");
  const family = ref ? familyOf(ref.prefix) : "";
  const queries = ref
    ? queryCandidates({ compareNumber: ref.compareNumber, year: ref.year, prefix: ref.prefix }).slice(0, 2)
    : [String(query ?? "").trim()].filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const q of queries) {
    if (q === "") continue;
    let page;
    try {
      page = await searchStd(baseUrl, q, cookie, { page: 1, fetchImpl });
    } catch {
      await sleep(rateMs);
      continue;
    }
    if (page?.redirectAid) {
      const href = page.redirectHref ?? `/html/${page.redirectAid}.html`;
      out.push({
        source: "biaozhun",
        title: ref ? `${ref.prefix} ${ref.number}${ref.year != null ? `-${ref.year}` : ""}` : q,
        stdNo: ref ? `${ref.prefix} ${ref.number}${ref.year != null ? `-${ref.year}` : ""}` : "",
        url: `${baseUrl}${href}`,
        site: "biaozhun.org",
        date: "",
        authority: 3,
        score: 3,
        downloadAid: page.redirectAid,
        summary: "",
      });
      break;
    }
    const items = parseSearchResults(page?.html ?? "", ref ?? null);
    for (const item of items) {
      // 编号相同但体系不同（Q/GDW 10212 vs TB 10212）不能算命中。
      if (ref) {
        const itemRef = extractStdRef(item.stdNo ?? "");
        if (!itemRef || familyOf(itemRef.prefix) !== family) continue;
      }
      const key = `${normalizeStdKey(item.stdNo)}|${item.href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        source: "biaozhun",
        title: item.title || item.stdNo || q,
        stdNo: item.stdNo ?? "",
        url: `${baseUrl}${item.href}`,
        site: "biaozhun.org",
        date: item.pubDate ?? "",
        authority: 3,
        score: 2,
        downloadAid: item.aid,
        summary: [item.status, item.implDate ? `实施 ${item.implDate}` : ""].filter(Boolean).join("；"),
      });
      if (out.length >= limit) break;
    }
    await sleep(rateMs);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** 通用网页候选：DeepSeek Search 结果统一成同一结构。 */
export async function searchWeb({
  query,
  apiKey,
  baseUrl,
  count = 10,
  fetchImpl,
  standardNo = "",
  title = "",
} = {}) {
  const q = String(query ?? "").trim();
  if (q === "") return [];
  const results = await deepseekSearch({
    query: q,
    apiKey,
    baseUrl,
    count,
    needContent: false,
    fetchImpl,
  });
  const stdKey = normalizeForMatch(standardNo);
  const titleKey = normalizeForMatch(title);
  const mapped = results.map((item) => ({
    source: "web",
    title: String(item.title ?? ""),
    stdNo: (() => {
      const ref = extractStdRef(`${item.title ?? ""} ${item.snippet ?? ""}`);
      return ref ? `${ref.prefix} ${ref.number}${ref.year != null ? `-${ref.year}` : ""}` : standardNo;
    })(),
    url: String(item.url ?? ""),
    site: String(item.site_name ?? ""),
    date: String(item.date ?? "").slice(0, 10),
    authority: Number(item.authority ?? -1),
    score: Number(item.rerank_score ?? 0),
    summary: String(item.summary ?? item.snippet ?? "")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600),
  })).filter((item) => item.url);
  if (stdKey === "" && titleKey === "") return mapped;
  // 有标准号/标题时只保留真正相关的搜索结果：正文包含该编号，或标题包含目标名称。
  return mapped.filter((item) => {
    const text = normalizeForMatch(`${item.title} ${item.summary}`);
    if (stdKey !== "" && text.includes(stdKey)) return true;
    if (titleKey.length >= 6 && text.includes(titleKey.slice(0, Math.min(12, titleKey.length)))) return true;
    return false;
  });
}

function normalizeForMatch(value) {
  return String(value ?? "").replace(/[\s\-_/—–~～,，。；;：:（）()\[\]【】《》"'“”‘’]/g, "").toLowerCase();
}

/** 候选是否已在库内：按标准号精确匹配，或标题互相包含。 */
export async function markInLibrary(candidates, { kbRoot, kbs = null } = {}) {
  const names = Array.isArray(kbs) && kbs.length > 0
    ? kbs
    : [];
  const docs = [];
  for (const kb of names) {
    try {
      const manifest = await readManifest(kbDirPath(kbRoot, kb));
      for (const doc of manifest.docs ?? []) {
        if (doc.status !== "ready") continue;
        docs.push({
          kb,
          docId: doc.id,
          title: String(doc.title ?? ""),
          standardNo: String(doc.standardNo ?? ""),
        });
      }
    } catch {
      /* 单个库读失败不影响候选展示 */
    }
  }
  const norm = (value) => String(value ?? "").replace(/[\s\-—–_/]/g, "").toLowerCase();
  for (const item of candidates) {
    const stdKey = normalizeStdKey(item.stdNo);
    const titleKey = norm(item.title).slice(0, 40);
    const hit = docs.find((doc) => {
      if (stdKey && normalizeStdKey(doc.standardNo) === stdKey) return true;
      const docTitle = norm(doc.title);
      return titleKey.length >= 6 && (docTitle.includes(titleKey) || titleKey.includes(docTitle.slice(0, 40)));
    });
    if (hit) item.inLibrary = { kb: hit.kb, docId: hit.docId, title: hit.title };
  }
  return candidates;
}
