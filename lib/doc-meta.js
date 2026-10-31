/**
 * 资料身份元数据：标题规范化、标准要素、正文/封面标准号、正文完整性、trust 启发式。
 *
 * 这里只做纯函数，不读盘；标题与标准号的解析口径集中在本模块，
 * store/pipeline/lint/standards 都复用它，避免多套正则各自漂移。
 */
import { createHash } from "node:crypto";
import { extractStdRef, familyOf } from "./standards.js";
import { cleanTitle } from "./titles.js";

/** 版本阶段：编制说明优先（它是草案的配套文件，不是同一份文档）。 */
export function stageOf(title) {
  const t = String(title ?? "");
  if (/编制说明|修编情况|情况介绍|条文说明|宣贯|释义|解读|修改单|征求意见函/.test(t)) return "说明材料";
  if (/redline/i.test(t)) return "Redline版";
  if (/勘误|更正|(?<![a-z])cor\d|[-\s]ed\d+(?:\.\d+)?c\d+/i.test(t)) return "勘误版";
  if (/\bSASO\b/i.test(t)) return "SASO版";
  if (/编制说明/.test(t)) return "编制说明";
  if (/报批稿/.test(t)) return "报批稿";
  if (/征求意见稿/.test(t)) return "征求意见稿";
  if (/送审稿/.test(t)) return "送审稿";
  if (/讨论稿|工作组/.test(t)) return "讨论稿";
  if (/草案/.test(t)) return "草案";
  if (/发布稿/.test(t)) return "发布稿";
  return "发布稿";
}

const EXPLICIT_STAGE_RE = /发布稿|批准稿|正式版|报批稿|征求意见稿|送审稿|讨论稿|草案|编制说明|说明材料|Redline|勘误/i;

const STAGE_KEYS = Object.freeze({
  发布稿: "published",
  正式版: "published",
  批准稿: "approved",
  报批稿: "draft",
  征求意见稿: "comment",
  送审稿: "review",
  讨论稿: "discussion",
  草案: "plan",
  说明材料: "notes",
  编制说明: "notes",
  Redline版: "redline",
  勘误版: "errata",
  SASO版: "variant",
});

export function stageKeyOf(label) {
  return STAGE_KEYS[String(label ?? "")] ?? "unknown";
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 标准号规范：前缀 + 空格 + 编号 + 年份；年份分隔符统一为 -。 */
export function canonicalStdHead(ref) {
  return `${ref.prefix} ${ref.number}${ref.year != null ? `-${ref.year}` : ""}`;
}

/**
 * 把“DL/T587—2025+名称”整理成“DL/T 587-2025 名称”。
 * 只在标题开头能解析出标准号时改写；不改变无标准号标题。
 */
const LOOSE_STD_RE =
  /(?:Q\/GDW|IEC\/TS|IEC\/TR|GB\/T|GB\/Z|GB|DL\/T|NB\/T|JB\/T|HG\/T|YD\/T|TB\/T|CJJ|JGJ|JJF|JJG|IEC|IEEE|ISO|EN|T\/[A-Z]{2,}|T[A-Z]{3,})\s*[\d０-９]/gi;
const STD_TITLE_START =
  /^\s*(?:《|Q\/GDW|IEC\/TS|IEC\/TR|GB\/T|GB\/Z|GB|DL\/T|NB\/T|JB\/T|HG\/T|YD\/T|TB\/T|CJJ|JGJ|JJF|JJG|IEC|IEEE|ISO|EN|T\/[A-Z]{2,}|T[A-Z]{3,})/i;

function standardEnd(text, start, ref) {
  const slice = text.slice(start);
  const numberIndex = slice.indexOf(String(ref.number));
  if (numberIndex < 0) return start + slice.length;
  let end = start + numberIndex + String(ref.number).length;
  const year = /^\s*[-—–~～]\s*((?:19|20)\d{2}|\d{2})(?=\s|$|[^\d])/.exec(text.slice(end));
  if (year) end += year[0].length;
  return end;
}

function standardTitleShape(cleaned) {
  if (STD_TITLE_START.test(cleaned)) return true;
  if (/(?:通知|纪要|函|名单|回执|附件|申请表|会议|征集|说明)/.test(cleaned)) return false;
  if (!/(?:规范|规程|导则|标准|技术规定|技术要求|技术条件|方法|规则|条例|办法)/.test(cleaned)) return false;
  // 允许“名称 + 标准号 [+ 版本]”的写法；标准号必须在标题后半段。
  LOOSE_STD_RE.lastIndex = 0;
  let last = null;
  for (const match of cleaned.matchAll(LOOSE_STD_RE)) last = match;
  return Boolean(last && (last.index ?? 0) >= cleaned.length - 80);
}

function looseStdRef(title) {
  const cleaned = cleanTitle(title);
  // 只在“书名号/标准号开头”或“标准名 + 末尾标准号”的标题里找标准号；
  // 通知/纪要正文中引用的 IEC/GB 号不能被当成这份资料自己的标准号。
  if (!standardTitleShape(cleaned)) return null;
  const text = normalizeDigits(cleaned);
  for (const match of text.matchAll(LOOSE_STD_RE)) {
    const start = match.index ?? 0;
    let tail = text.slice(start);
    const cut = tail.search(/[（()）\[\]【】《》\n]/);
    if (cut > 0) tail = tail.slice(0, cut);
    tail = tail.trim();
    let ref = extractStdRef(tail);
    if (!ref || !/\d/.test(ref.number)) continue;
    if (ref.year == null) {
      const inferred = new RegExp(
        `${escapeRe(ref.prefix)}\\s*${escapeRe(ref.number)}\\s*[-—–~～]\\s*((?:19|20)\\d{2})`,
        "i"
      ).exec(text);
      if (inferred) ref = { ...ref, year: Number(inferred[1]) };
    }
    return { ref, cleaned, text, start, end: standardEnd(text, start, ref) };
  }
  return null;
}

function cleanBody(value) {
  return String(value ?? "")
    .replace(/_{2,}/g, " ")
    .replace(/[（(]\s*[)）]/g, " ")
    .replace(/\(\s*\d+\s*\)|（\s*\d+\s*）/g, " ")
    .replace(/^[\s\-—–~～+＋、，,;；:：]+|[\s\-—–~～+＋、，,;；:：]+$/g, "")
    .replace(/^\d{1,3}\s+(?=[\u4e00-\u9fa5A-Za-z0-9])/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function stageSuffix(text) {
  const value = String(text ?? "");
  const version = /(?:Ver|V)\s*(\d+(?:\.\d+)*)/i.exec(value);
  const stage = /报批稿/.test(value)
    ? "报批稿"
    : /征求意见稿/.test(value)
      ? "征求意见稿"
      : /送审稿/.test(value)
        ? "送审稿"
        : /讨论稿|工作组/.test(value)
          ? "讨论稿"
          : /发布稿|正式版|批准稿/.test(value)
            ? ""
            : "";
  if (!stage) return "";
  const notes = /内部|整合|代替|部分代替|修订/.test(value)
    ? value.replace(/^[\s\-—–（(]+|[)）\s]+$/g, "").replace(/^标准|^稿/, "").trim().slice(0, 60)
    : "";
  const label = notes
    ? (notes.includes(stage) ? notes : `${stage}-${notes}`)
    : stage;
  return `（${label}${version ? ` ${version[0]}` : ""}）`;
}

function titleBodyFrom(text, found) {
  const book = text.match(/《([^》]+)》/);
  if (book) {
    const title = cleanBody(book[1]);
    let tail = text.slice((book.index ?? 0) + book[0].length);
    // 去掉末尾括号里的标准号；保留阶段/说明
    tail = tail.replace(/[（(]\s*(?:Q\/GDW|IEC\/TS|IEC\/TR|GB\/T|GB\/Z|GB|DL\/T|NB\/T|JB\/T|HG\/T|YD\/T|TB\/T|CJJ|JGJ|JJF|JJG|IEC|IEEE|ISO|EN|T\/[A-Z]{2,}|T[A-Z]{3,})[\s\S]*?[)）]/gi, " ");
    tail = tail.replace(/[（(]\s*[)）]/g, " ");
    tail = tail.replace(/[-—–]?\s*上传版[\s\S]*$/gi, " ").replace(/\s*(?:无水印|扫描件)\s*$/i, " ");
    const suffix = stageSuffix(tail);
    if (suffix) return `${title}${suffix}`;
    const note = cleanBody(tail.replace(/^[\s\-—–]+/, ""));
    return note ? `${title}（${note}）` : title;
  }
  if (!found) return cleanBody(text);
  const before = cleanBody(text.slice(0, found.start));
  const after = cleanBody(text.slice(found.end));
  const body = cleanBody(`${before} ${after}`);
  if (!body) return "";
  // 只去掉末尾上传/水印噪声；正文标题本身保持原样
  return body.replace(/\s*(?:[-—–]?\s*上传版(?:\(\d+\))?|无水印|扫描件)$/i, "").trim();
}

/** 标题开头的通用标准号（用于把「编号 名称」里的编号剥掉；兼容 DL/NB/IEC/TS 等写法）。 */
const LEADING_STD_RE =
  /^\s*(?:Q\/GDW|IEC(?:\/TS|\/TR)?|IEEE|ISO|EN|GB(?:\/T|\/Z)?|DL(?:\/T)?|NB(?:\/T)?|JB(?:\/T)?|HG(?:\/T)?|YD(?:\/T)?|TB(?:\/T)?|CJJ|JGJ|JJF|JJG|T\/[A-Z]{2,})\s*\d[\dA-Za-z.\/\-—–~～]*\s*/i;

/**
 * 统一标题为「标准号 + 名称」：标准类资料（有 standardNo）一律用规范编号开头：
 *   withStandardPrefix("标准编写规则 第10部分：产品标准", "GB/T 20001.10-2014（发布稿）")
 *   → "GB/T 20001.10-2014 标准编写规则 第10部分：产品标准"
 * 标题已有编号会先剥掉再补规范编号（幂等）；无标准号时原样返回。
 */
export function withStandardPrefix(title, standardNo) {
  const clean = cleanTitle(title).replace(/\s+/g, " ").trim();
  const ref = extractStdRef(String(standardNo ?? "").trim());
  if (!ref) return clean.slice(0, 200);
  const head = canonicalStdHead(ref);
  const headRe = new RegExp(`^\\s*${head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*")}(?=$|[\\s\-—–~～/（(])`, "i");
  const matched = headRe.exec(clean);
  const body = (matched ? clean.slice(matched[0].length) : clean.replace(LEADING_STD_RE, ""))
    .replace(/^[\s\-—–~～/]+/, "")
    .trim();
  // 标题只剩年份（如 DL 860.803-202X 的“202X”）时仍用连字符，避免变成“DL 860.803 202X”。
  const joiner = /^(?:19|20)\d{2}[A-Z]?$|^\d{3,4}[A-Z]?$/.test(body) ? "-" : " ";
  const next = body ? `${head}${joiner}${body}` : head;
  return next.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function canonicalizeTitle(title) {
  const text = normalizeDigits(String(title ?? ""));
  const found = looseStdRef(text);
  if (!found) {
    const book = text.match(/^([\s\S]{0,40}?)《([^》]+)》([\s\S]*)$/);
    if (book) {
      const prefix = cleanBody(book[1]);
      const body = cleanBody(book[2]);
      const tail = String(book[3] ?? "").replace(/[-—–]?\s*上传版[\s\S]*$/gi, " ");
      const suffix = stageSuffix(tail);
      const keepPrefix = prefix && !/^\d{6,}.*(?:PA|（启动会）|\(启动会\))/i.test(prefix);
      return `${keepPrefix ? `${prefix} ` : ""}${body}${suffix}`.slice(0, 200);
    }
    return cleanTitle(text);
  }
  const head = canonicalStdHead(found.ref);
  const body = titleBodyFrom(found.text, found);
  return (body ? `${head} ${body}` : head).slice(0, 200);
}

const TITLE_KEY_NOISE =
  /[\s\u3000\-—_/\\:：,，。.、；;？?！!（）()【】\[\]《》〈〉「」『』"'“”‘’·•…]/g;

/** 标题是否像标准/技术文件（用于允许正文/封面优先；通知/附件不算）。 */
export function looksLikeStandardTitle(title) {
  const text = String(title ?? "").trim();
  if (!text) return false;
  if (/(?:通知|纪要|函|名单|回执|附件|申请表|索引|手册|目录|说明书)/.test(text)) return false;
  return /(?:规范|规程|导则|标准|技术规定|技术要求|技术条件|方法|规则|条例)(?:\s|$|[（(第])/.test(text)
    || /第\s*[一二三四五六七八九十\d]+\s*(?:部分|分册)/.test(text);
}

/** 摘要归一化：折叠空白、trim、最多 500 字。 */
export function normalizeDocSummary(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, 500);
}

/** 标题比较键：NFKC、小写、去空白与标点；不改变数字/字母。 */
export function titleKey(title) {
  return String(title ?? "").normalize("NFKC").toLowerCase().replace(TITLE_KEY_NOISE, "");
}

function partFromNumber(number) {
  const match = /\.(\d+)$/.exec(String(number ?? ""));
  return match ? match[1] : null;
}

function partFromTitle(title) {
  const match = /第\s*([一二三四五六七八九十百零〇两\d]+)\s*(部分|分册|册)/.exec(String(title ?? ""));
  return match ? String(match[1]) : null;
}

/**
 * 从文件名/标题解析标准要素。
 * @param {string} title 用于显示/LLM 的标题
 * @param {string} rawTitle 原始文件名（未清洗）
 */
export function parseDocMeta(title, rawTitle = title) {
  const raw = String(rawTitle ?? title ?? "").trim();
  // 调用方可能显式传 title（kb_import 的标题参数、重命名后的标题），
  // 标准号优先从 title 解析；rawTitle 只在 title 解析不到时回退。
  const fromTitle = canonicalizeTitle(String(title ?? "").trim() || raw);
  let canonical = fromTitle;
  let ref = extractStdRef(fromTitle);
  if (!ref) {
    const fromRaw = canonicalizeTitle(raw);
    const rawRef = extractStdRef(fromRaw);
    if (rawRef) {
      canonical = fromRaw;
      ref = rawRef;
    }
  }
  const stageLabel = stageOf(String(title ?? raw));
  const stage = stageKeyOf(stageLabel);
  const stageExplicit = EXPLICIT_STAGE_RE.test(String(title ?? raw));
  if (!ref) {
    return {
      rawTitle: raw,
      canonicalTitle: canonical,
      standardPrefix: "",
      standardNumber: "",
      standardBase: "",
      standardYear: null,
      standardPart: partFromTitle(title),
      standardNo: "",
      standardSource: "none",
      filenameStandardNo: "",
      stage,
      stageLabel,
      stageExplicit,
      isDraft: ["draft", "comment", "review", "discussion", "plan"].includes(stage),
      titleKey: titleKey(canonical),
    };
  }
  const number = String(ref.number);
  let year = Number.isFinite(ref.year) ? ref.year : null;
  if (year == null) {
    // 某些写法把年份放在空格分隔的阶段词前（splitStage 会把它并进 stage），
    // 例如 Q/GDW 10650.6-2019 报批稿；这里从编号后补抓 4 位年份。
    const inferred = new RegExp(
      `^${escapeRe(ref.prefix)}\\s*${escapeRe(number)}\\s*[-—–~～]\\s*((?:19|20)\\d{2})`,
      "i"
    ).exec(canonical);
    if (inferred) year = Number(inferred[1]);
  }
  const standardBase = number.replace(/\.\d+$/, "");
  const standardNo = canonicalStdHead({ ...ref, year });
  return {
    rawTitle: raw,
    canonicalTitle: canonical,
    standardPrefix: ref.prefix,
    standardNumber: number,
    standardBase,
    standardYear: year,
    standardPart: partFromNumber(number) ?? partFromTitle(title),
    standardNo,
    standardSource: "filename",
    filenameStandardNo: standardNo,
    stage,
    stageLabel,
    stageExplicit,
    isDraft: ["draft", "comment", "review", "discussion", "plan"].includes(stage),
    titleKey: titleKey(canonical),
  };
}

function looksLikeContentTitle(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 4 || text.length > 80) return false;
  if (/^第?\s*\d+\s*页/.test(text)) return false;
  if (/^\d{4}(?:[-年/.]|\s|$)/.test(text)) return false;
  if (/代替|废止|实施|发布|前言|目\s*次|目\s*录|标准号|ICS|CCS/i.test(text)) return false;
  if (/^(?:GB|DL|NB|JB|TB|Q\/GDW|IEC|IEEE|ISO)\b/i.test(text)) return false;
  if (/^[\d\s.\-—–~～/]+$/.test(text)) return false;
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]{2,}/g) ?? []).length;
  return cjk >= 2 || latin >= 1;
}

const CONTENT_STD =
  /(?:Q\/GDW|GB\/T|GB\/Z|GB|DL\/T|DL\/Z|NB\/T|NB|JB\/T|HG\/T|YD\/T|TB\/T|CJJ|JGJ|IEC\/TS|IEC|IEEE|ISO)\s*[\d.]+(?:\s*[-—–~～]\s*(?:19|20)\d{2})?/gi;
const BAD_TITLE_LINE =
  /^(?:中华人民共和国|国家标准|行业标准|代替|ICS|CCS|发布|实施|前言|目\s*次|目\s*录|标准号|Standard)/i;

export function textFromSections(input) {
  if (typeof input === "string") return input;
  const sections = Array.isArray(input?.sections)
    ? input.sections
    : Array.isArray(input)
      ? input
      : [];
  return sections.map((section) => `${section?.heading ?? ""}\n${section?.text ?? ""}`).join("\n");
}

function normalizeDigits(text) {
  return String(text ?? "")
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[∕／]/g, "/")
    .replace(/．/g, ".")
    .replace(/[－＿]/g, "-")
    .replace(/[—–~～]/g, "-")
    .replace(/(?<=\d)\s*一\s*(?=\d{2,4}\b)/g, "-");
}

function cleanCoverLine(line) {
  return String(line ?? "")
    .replace(/^#+\s*/, "")
    .replace(/^[-*•·\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function coverTitleFragment(line) {
  const text = cleanCoverLine(line);
  if (text.length < 2 || text.length > 80) return "";
  if (BASE_TITLE_STOP.test(text)) return "";
  if (/[，。；、]/.test(text)) return "";
  if (/^\d+(?:\.\d+)*\s+/.test(text)) return "";
  if (/^(?:本标准|本文件|本部分|本规范|本导则|下列|范围|术语|引用标准|目次|前言|发布|实施|主题内容|适用范围)/.test(text)) return "";
  if (/主题内容|适用范围|引用标准|术语和定义|Copyright|Provided by|Not for|License|Aucune partie|publication/i.test(text)) return "";
  if (/中国国家标准化管理委员会|国家标准化管理委员会|国家能源局|国家电网有限公司|国家电网公司/.test(text)) return "";
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  if (cjk < 2) return "";
  return text;
}

function coverTitleFromContext(text, candidate, line, lineEnd, ref) {
  const parts = [];
  const before = cleanCoverLine(line.replace(CONTENT_STD, " ")).replace(/^[\s:：\-—–]+|[\s:：\-—–]+$/g, "");
  const beforePart = coverTitleFragment(before);
  if (beforePart && beforePart !== String(ref.number)) parts.push(beforePart);
  const lines = text
    .slice(lineEnd < 0 ? text.length : lineEnd + 1)
    .split("\n")
    .map(cleanCoverLine)
    .filter(Boolean)
    .slice(0, 12);
  const english = [];
  for (const raw of lines) {
    if (/^(?:###\s*)?第\s*\d+\s*页/.test(raw)) break;
    if (/中华人民共和国|标准化指导性技术文件|国家能源局|国家市场监督管理|中国国家标准化管理委员会|国家标准化管理委员会|国家电网有限公司|国家电网公司|备案号|ICS|CCS/.test(raw)) continue;
    if (/代替|废止|实施|发布|前言|目\s*次|目\s*录/.test(raw)) continue;
    if (/Copyright|Provided by|Not for|License|Aucune partie|publication|IEC Central|Electrotechnical Commission/i.test(raw)) continue;
    if (/^\d+(?:\.\d+)*\s+/.test(raw) || /主题内容|适用范围|^术语和定义|^引用标准/.test(raw)) break;
    const part = coverTitleFragment(raw);
    if (part) {
      if (parts.length < 3) parts.push(part);
      if (parts.length >= 3) break;
      continue;
    }
    if (parts.length === 0 && /[A-Za-z]{3,}/.test(raw) && !/^(?:NORME|CEI|IEC|TECHNICAL|INTERNATIONAL|Reference|Numéro|Première|First edition)/i.test(raw)) {
      english.push(raw);
      if (english.length >= 3) break;
    }
    if (english.length > 0 && /^(?:Reference|Numéro|First edition|Première)/i.test(raw)) break;
  }
  if (parts.length === 0 && english.length > 0) parts.push(...english);
  let title = parts.join(" ").replace(/\s+/g, " ").trim();
  title = title
    .replace(/第[工I1一]部分/g, (m) => (m.includes("工") ? "第1部分" : m))
    .replace(/第\s*([0-9]+)\s*部分/g, "第$1部分")
    .replace(/\s*(?:中国国家标准化管理委员会|国家标准化管理委员会|国家能源局|国家电网有限公司|国家电网公司).*$/g, "")
    .replace(/[\s:：\-—–]+$/g, "");
  return title.length >= 4 ? title.slice(0, 100) : "";
}

const BASE_TITLE_STOP =
  /^(?:中华人民共和国|国家标准|行业标准|标准化指导性技术文件|代替|ICS|CCS|发布|实施|前言|目\s*次|目\s*录|标准号|Standard)/i;

/**
 * 阶段词只扫“封面区”：正文/目录里出现“编制说明”多半是附录清单或目次条目，
 * 出现“修改单（不包括勘误的内容）”是规范性引用文件的样板句。
 * 两者都会把标准正文误判成说明材料（Q/GDW 的附录里几乎都带编制说明）。
 */
const STAGE_SCAN_STOP = /前\s*言|目\s*次|目\s*录|规范性引用文件|^\s*1\s*范\s*围/m;

/** 取用于判定版本阶段的封面片段：截到第一个 前言/目次/目录/规范性引用文件/1 范围 之前。 */
export function stageScanText(text, { maxChars = 3000, fallback = 600 } = {}) {
  const s = String(text ?? "").slice(0, maxChars);
  const m = s.match(STAGE_SCAN_STOP);
  // 找到正文起点就只扫它之前（封面/标题页）；找不到（如编制说明没有前言）才扫前 600 字
  const cut = m && m.index != null ? m.index : Math.min(s.length, fallback);
  return s.slice(0, Math.max(0, cut));
}

/**
 * 从解析后的正文/封面提取标准号。
 * 只在前 8000 字内找，优先含年份且靠前的候选；找不到返回 null。
 */
export function parseContentStandard(input, { maxChars = 8000, expectedStandardNo = "" } = {}) {
  const text = normalizeDigits(textFromSections(input).replace(/<!--[\s\S]*?-->/g, " ")).slice(0, maxChars);
  if (!text.trim()) return null;
  const expected = String(expectedStandardNo ?? "").replace(/[^A-Za-z0-9.]/g, "").toLowerCase();
  const candidates = [...text.matchAll(CONTENT_STD)]
    .map((match) => {
      const index = match.index ?? 0;
      const lineEnd = text.indexOf("\n", index);
      const line = text.slice(index, lineEnd < 0 ? text.length : lineEnd).replace(/\s+/g, " ").trim();
      const ref = extractStdRef(line);
      let score = 0;
      if (/中华人民共和国|行业标准|国家标准|标准化指导性技术文件/.test(line)) score += 6;
      if (/本标准|本文件|本部分|引用|考虑|采用|术语|范围|前言|目次|。/.test(line)) score -= 6;
      const before = text.slice(Math.max(0, index - 160), index);
      if (/本标准|本文件|本部分|按照|引用|标准化工作导则|标准化文件的结构/.test(before)
        || /标准化工作导则|标准化文件的结构/.test(line)) score -= 30;
      if (index < 1800) score += 2;
      if (/(?:19|20)\d{2}/.test(match[0])) score += 2;
      if (expected && ref) {
        const normalize = (value) => String(value ?? "").replace(/\/(?:T|Z|G)/g, "").replace(/[^A-Za-z0-9.]/g, "").toLowerCase();
        const actual = normalize(`${ref.prefix}${ref.number}`);
        const wanted = normalize(expected);
        if (actual === wanted || actual.includes(wanted) || wanted.includes(actual)) score += 12;
      }
      return { raw: match[0], index, line, ref, score };
    })
    .filter((candidate) => candidate.index < Math.min(maxChars, 6000));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  for (const candidate of candidates) {
    if (candidate.score < -4) continue;
    const lineEnd = text.indexOf("\n", candidate.index);
    const line = candidate.line;
    if (line.length === 0 || line.length > 160) continue;
    const ref = candidate.ref ?? extractStdRef(line);
    if (!ref) continue;
    const after = text
      .slice(lineEnd < 0 ? text.length : lineEnd + 1)
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    const titleLine = after.find(
      (value) =>
        value.length >= 2 &&
        value.length <= 80 &&
        !BAD_TITLE_LINE.test(value) &&
        !/^\d+(?:\.\d+)+\s/.test(value) &&
        !/^(?:GB|DL|NB|IEC|IEEE|ISO|Q\/GDW)\b/i.test(value)
    );
    const fallbackTitle = looksLikeContentTitle(titleLine) ? titleLine : "";
    const contentTitle = coverTitleFromContext(text, candidate, line, lineEnd, ref) || fallbackTitle;
    const stageText = stageScanText(text);
    const hasExplicitStage =
      /报批稿|征求意见稿|送审稿|讨论稿|草案|编制说明|说明材料|发布稿|批准稿|Redline|勘误/i.test(stageText);
    const stageLabel = stageOf(stageText);
    const standardNo = canonicalStdHead(ref);
    return {
      standardPrefix: ref.prefix,
      standardNumber: String(ref.number),
      standardBase: String(ref.number).replace(/\.\d+$/, ""),
      standardYear: Number.isFinite(ref.year) ? ref.year : null,
      standardPart: partFromNumber(ref.number) ?? partFromTitle(text.slice(candidate.index, candidate.index + 300)),
      standardNo,
      stage: hasExplicitStage ? stageKeyOf(stageLabel) : "unknown",
      stageLabel: hasExplicitStage ? stageLabel : "",
      contentTitle,
      confidence: ref.year != null && candidate.index < 5000 ? "high" : "medium",
    };
  }
  return null;
}

/**
 * 合并文件名元数据与正文/封面元数据。
 * content 置信 high/medium 且拿到标准号时以 content 为准；否则保留 filename。
 */
export function mergeDocMeta(filenameMeta, contentMeta) {
  if (!contentMeta || contentMeta.confidence === "low" || !contentMeta.standardNo) {
    return filenameMeta;
  }
  // 文件名已有标准号时，正文候选必须与文件名同一主编号；否则多半是正文里的
  // 引用/表号（如 DL 1773 正文里出现 NB 2），不能覆盖文件名。
  if (filenameMeta.standardNo && filenameMeta.standardBase && contentMeta.standardBase
    && String(filenameMeta.standardBase) !== String(contentMeta.standardBase)) {
    return filenameMeta;
  }
  if (filenameMeta.standardNo && Number.isFinite(filenameMeta.standardYear)
    && contentMeta.standardYear != null
    && Number(filenameMeta.standardYear) !== Number(contentMeta.standardYear)) {
    return filenameMeta;
  }
  if (filenameMeta.standardNo && Number.isFinite(filenameMeta.standardYear) && contentMeta.standardYear == null) {
    return filenameMeta;
  }
  const filenameRest = String(filenameMeta.canonicalTitle ?? "")
    .replace(new RegExp(`^${escapeRe(filenameMeta.standardNo ?? "")}\\s*`), "")
    .trim();
  // 文件名已有名称时优先保留（封面标题常被版式截断，如少掉“技术规范”）；
  // 只有文件名只有编号/没有名称时才用正文标题补全。
  const rest = filenameRest || contentMeta.contentTitle;
  const canonical = canonicalizeTitle(`${contentMeta.standardNo} ${rest}`.trim());
  const stage = filenameMeta.stageExplicit
    ? filenameMeta.stage
    : (contentMeta.stage && contentMeta.stage !== "unknown" ? contentMeta.stage : filenameMeta.stage);
  return {
    ...filenameMeta,
    ...contentMeta,
    standardSource: "content",
    filenameStandardNo: filenameMeta.standardNo || "",
    canonicalTitle: canonical,
    standardYear: contentMeta.standardYear ?? filenameMeta.standardYear,
    standardPart: contentMeta.standardPart ?? filenameMeta.standardPart,
    stage,
    stageLabel: filenameMeta.stageExplicit
      ? filenameMeta.stageLabel
      : (contentMeta.stageLabel || filenameMeta.stageLabel),
    isDraft: ["draft", "comment", "review", "discussion", "plan"].includes(stage),
    titleKey: titleKey(canonical),
  };
}

/** 书籍封面标题（epub/mobi）：只用于 title/canonicalTitle，不产生标准号。 */
export function parseCoverTitle(input, { maxChars = 3000 } = {}) {
  const text = textFromSections(input).slice(0, maxChars);
  const lines = text
    .split("\n")
    .map((value) => value.trim())
    .filter(
      (value) =>
        value.length >= 2 &&
        value.length <= 80 &&
        !BAD_TITLE_LINE.test(value) &&
        !/^\d+(?:\.\d+)+\s/.test(value)
    );
  const title = lines.find((line) => looksLikeContentTitle(line));
  return title ? { title, confidence: "medium" } : null;
}

function bodyTextForIntegrity(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const textOf = (section) => String(section?.text ?? "");
  const total = list.reduce((sum, section) => sum + textOf(section).length, 0);
  if (total === 0) return "";
  const firstTwo = list.slice(0, 2).reduce((sum, section) => sum + textOf(section).length, 0);
  // 前两段确实是封面/题名页/目录（占比小）时整段丢弃；否则按全文字符数前 20% 截掉，
  // 避免把纯文本/软段落误判成“只有封面”。
  if (list.length > 2 && firstTwo / total < 0.5) {
    return list
      .slice(2)
      .map((section) => `${section?.heading ?? ""}\n${section?.text ?? ""}`)
      .join("\n");
  }
  const coverChars = Math.min(1500, Math.floor(total * 0.2));
  return list
    .map((section) => `${section?.heading ?? ""}\n${section?.text ?? ""}`)
    .join("\n")
    .slice(coverChars);
}

/**
 * 正文完整性：封面完好不代表正文完整。
 * @returns {{integrity:"full"|"partial"|"cover-only"|"unknown", bodyChars:number, clauseCount:number, pagesWithText:number}}
 */
export function contentIntegrityFor(input, { kind = "" } = {}) {
  const sections = Array.isArray(input?.sections)
    ? input.sections
    : Array.isArray(input)
      ? input
      : [];
  // 纯文本/表格没有“封面/正文”之分：只要有正文就按 full，避免把短资料误判成残缺。
  if (kind && !["pdf", "docx", "pptx", "epub", "mobi"].includes(kind)) {
    const chars = sections.reduce((sum, section) => sum + String(section?.text ?? "").length, 0);
    return {
      integrity: chars > 0 ? "full" : "unknown",
      bodyChars: chars,
      clauseCount: 0,
      pagesWithText: 0,
    };
  }
  const body = bodyTextForIntegrity(sections);
  const bodyChars = body.trim().length;
  const clauseCount = (
    body.match(
      /(?:^|\n)\s*(?:\d+(?:\.\d+){1,4}|第[一二三四五六七八九十百]+[章节篇]|附录\s*[A-Z])/g
    ) ?? []
  ).length;
  const pageNumbers = sections.map((section) => Number(section?.page) || 0).filter((page) => page > 0);
  const pagesWithText = new Set(pageNumbers).size;
  const totalPages = pageNumbers.length > 0 ? Math.max(...pageNumbers) : 0;
  let integrity = "unknown";
  if (bodyChars >= 1000 && (clauseCount >= 3 || bodyChars >= 5000)) integrity = "full";
  else if (bodyChars >= 200) integrity = "partial";
  else if (sections.some((section) => String(section?.text ?? "").trim())) integrity = "cover-only";
  if (totalPages > 0 && pagesWithText / totalPages < 0.2) {
    integrity = integrity === "full" ? "partial" : integrity;
  }
  return { integrity, bodyChars, clauseCount, pagesWithText };
}

/** 正文指纹：去注释/零宽/空白折叠后 sha256；用于“字节不同、正文相同”的去重。 */
export function textFingerprint(input) {
  const raw = typeof input === "string" ? input : textFromSections(input);
  const normalized = String(raw ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/** 只有这些明显格式噪声才值得 retitle；普通的“-阶段”风格保持原样。 */
export function needsRetitle(title) {
  const value = String(title ?? "");
  return /[+＋]/.test(value)
    || /^[A-Z][A-Z/]*\d/.test(value)
    || /[-—–~～](?:19|20)\d{2}[^\s\-—–~～]/.test(value);
}

/** 只允许“同内容、仅格式不同”的标题改写；用于旧库 retitle 的安全门。 */
export function safeRetitle(from, to) {
  const normalize = (value) => String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-—–~～+＋/\\_.,，。:：;；()（）【】\[\]《》〈〉「」『』"'“”‘’]/g, "");
  return normalize(from) === normalize(to) && String(from) !== String(to);
}

/** trust 启发式；只对解析出标准号的资料生效。 */
export function trustHeuristic(meta) {
  if (!meta?.standardNo) return { trust: "unknown", reason: "" };
  if (
    ["draft", "comment", "review", "discussion", "plan", "notes", "redline", "errata", "variant"].includes(
      meta.stage
    )
  ) {
    return { trust: "low", reason: "过程稿/说明材料/勘误（非现行发布版）" };
  }
  if (meta.stage === "published" || meta.stage === "approved") {
    return { trust: "medium", reason: "已发布标准，尚未核实现行/废止" };
  }
  return { trust: "unknown", reason: "" };
}

export { familyOf };
