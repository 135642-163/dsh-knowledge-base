/**
 * 标准更新检查与自动下载（biaozhun.org）。
 *
 * 流程：从知识库清单的文档标题中提取标准号 → 逐条在标准网搜索比对年份 →
 * 发现更新/正式版时抓详情页（代替标准字段佐证）→ 用登录会话自动下载 PDF →
 * 经 importFileInto 直接导入知识库。内置请求限速与增量缓存（断点续查）。
 *
 * 站点机制（2026-08 实测）：
 *  - 搜索:  POST /plus/search.php  {kwtype:0, q:关键词}，站方建议纯数字编号
 *  - 详情:  GET  /html/<aid>.html  含标准号/发布日期/实施日期/代替标准等字段
 *  - 下载:  GET  /plus/download.php?aid=<aid> 确认页(6金币/VIP) →
 *           GET  /plus/download.php?open=2&id=<aid>&uhash=<hash> 实际文件
 *  - 登录:  仅微信扫码；本工具使用用户在浏览器登录后提供的 Cookie 串
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { importFileInto } from "./pipeline.js";

const DEFAULT_BASE = "https://www.biaozhun.org";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 标准前缀（长前缀在前，避免 GB 吞掉 GB/T 的 /T）。 */
const STD_PREFIXES = [
  "Q/GDW", "QGDW", "NB/T", "DL/T", "JB/T", "HG/T", "YD/T", "SJ/T", "YS/T",
  "JG/T", "JC/T", "TB/T", "CJ/T", "JGJ/T", "GA/T", "QB/T", "MH/T", "JT/T",
  "WS/T", "SN/T", "LY/T", "SY/T", "NY/T", "SL/T", "MT/T", "EJ/T", "GY/T",
  "GB/Z", "GB/T", "GBJ", "DB/T", "CJJ", "JGJ", "CECS", "JJF", "JJG",
  "GB", "NB", "DL", "JB", "HG", "YD", "SJ", "YS", "TB", "DB", "SL", "MT",
  "IEC/TS", "IEC/TR", "IEC", "ISO", "IEEE", "ANSI", "ASTM", "EN", "GJB",
];

/** 视为草案/过程资料的阶段后缀（不做年份更新对比，只查“是否已有正式版”）。 */
const DRAFT_STAGES = [
  "征求意见稿", "报批稿", "送审稿", "讨论稿", "工作组讨论稿",
  "编制说明", "大纲", "预审稿", "草案", "修订稿",
];

/** 视为已发布（参与年份对比）的阶段后缀。 */
const RELEASED_STAGES = ["发布稿", "正式版", "批准稿"];

/** 标准网通常不收录的体系：用于把“站外预期查不到”与“编号解析失败”区分开。 */
const OFF_SITE_FAMILIES = new Set(["QGDW", "IEC", "IEEE", "EN", "ISO", "ANSI", "ASTM", "GJB"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(text) {
  return String(text ?? "")
    // Windows 文件名把 / 写成 _：GB_T→GB/T、NB_T→NB/T、Q_GDW→Q/GDW、IEC_TS→IEC/TS
    .replace(/^Q_GDW/i, "Q/GDW")
    .replace(/^([A-Z]{1,4})_T(?=\s|-|\d|\.|$)/i, "$1/T")
    .replace(/^([A-Z]{1,4})_Z(?=\s|-|\d|\.|$)/i, "$1/Z")
    .replace(/^IEC_(TS|TR)(?=\s|-|\d)/i, "IEC/$1")
    .replace(/[\uFF0D\u2013\u2014\u2015_]/g, "-")
    .replace(/[\u3000]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[∕／]/g, "/")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

/** 去掉标题末尾的版本阶段后缀（- 或空格分隔），返回 { base, stage }。 */
function splitStage(title) {
  let t = normalize(title).replace(/\[[^\]]*\]\s*$/, "").replace(/[【（(][^)）】]*[)）】]\s*$/, "");
  let stage = "";
  const STAGES = [...DRAFT_STAGES, ...RELEASED_STAGES];
  /** 仅剥离、不视为阶段词的文件描述后缀（如"扫描件"） */
  const STRIP_ONLY = ["扫描件", "照片版", "电子版", "文字版", "影印版"];
  const isStage = (seg) => STAGES.some((s) => seg === s || seg.endsWith(s) || seg.startsWith(s));
  const isStrip = (seg) => isStage(seg) || STRIP_ONLY.some((s) => seg === s || seg.endsWith(s));
  const parts = t.split(/\s*-\s*/);
  // 由后往前剥离 - 分隔的阶段段
  while (parts.length > 1 && isStrip(parts[parts.length - 1].trim())) {
    const seg = parts.pop().trim();
    if (isStage(seg)) stage = seg;
  }
  // 末段再按空格剥离阶段词（如 "IEC 63222-3 中文大纲 0106"）：从后向前找阶段词，
  // 其右侧允许隔着至多一个纯数字 token（工作组日期）
  let lastSeg = parts[parts.length - 1] ?? "";
  const tokens = lastSeg.trim().split(/\s+/);
  if (tokens.length > 1) {
    let stageIdx = -1;
    for (let k = tokens.length - 1; k >= 1; k--) {
      const tok = tokens[k].replace(/[()（）。．.]/g, "").trim();
      if (tok && isStrip(tok)) {
        stageIdx = k;
        break;
      }
      if (!/^\d{1,4}$/.test(tok)) break;
      if (tokens.length - 1 - k >= 1) break; // 最多跳过一个数字 token
    }
    if (stageIdx >= 0) {
      if (isStage(tokens[stageIdx].replace(/[()（）。．.]/g, "").trim())) {
        stage = STAGES.find((s) => {
          const tok = tokens[stageIdx].replace(/[()（）。．.]/g, "").trim();
          return tok === s || tok.endsWith(s) || tok.startsWith(s);
        }) ?? tokens[stageIdx];
      }
      tokens.splice(stageIdx);
    }
  }
  parts[parts.length - 1] = tokens.join(" ");
  return { base: parts.join("-").trim(), stage };
}

/** 从标题提取标准要素：{ prefix, number, year, stage, isDraft }；非标准返回 null。 */
export function extractStdRef(title) {
  const { base, stage } = splitStage(title);
  let t = base;
  // 无斜杠写法规范为带斜杠：GBT→GB/T、DLT→DL/T 等（双字母行业 + T 结尾）
  t = t.replace(/^(DLT|NBT|JBT|HGT|YDT|SJT|YST|JGT|JCT|TBT|CJT)(?=\s|-|\d|\.)/i, (m) => `${m[0]}${m[1]}/${m[2]}`);
  t = t.replace(/^GBT(?=\s|-|\d|\.)/i, "GB/T");
  t = t.replace(/^GBZ(?=\s|-|\d|\.)/i, "GB/Z");
  t = t.replace(/^Q[\s-]*GDW/i, "Q/GDW");
  let prefix = null;
  for (const p of STD_PREFIXES) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^(?:${esc})(?=[\\s\\-.(（]|$|[0-9])`, "i").test(t)) {
      prefix = p.toUpperCase();
      break;
    }
  }
  // 团体标准：T/XXX（带斜杠）或 TXXX（无斜杠，3 个字母以上，避免误伤 TB 等双字母前缀）
  if (!prefix) {
    const mSlash = t.match(/^(T\/[A-Z]{2,})(?=[\s\-.(（]|$|[0-9])/i);
    const mBare = t.match(/^(T[A-Z]{3,})(?=[\s\-.(（]|$|[0-9])/i);
    if (mSlash) prefix = mSlash[1].toUpperCase();
    else if (mBare) prefix = `T/${mBare[1].slice(1)}`.toUpperCase();
  }
  if (!prefix) return null;
  let rest = t.slice(prefix.length).trim();
  // 处理 GB/T 残留（正常情况下 GB/T 前缀已整体匹配）
  rest = rest.replace(/^\/\s*T(?=\s|-|$)/i, "").trim();
  if (rest.startsWith("/T")) rest = rest.slice(2).trim();
  // 截断/剥年之前的原始编号段，供恢复解析使用
  const restRaw = rest;
  // 提取年份：优先 4 位年份（年份后可跟 -/空格/结束）；否则末尾 2 位年份按 19xx
  let year = null;
  const m4 = rest.match(/-((?:19|20)\d{2})(?=-|$|\s)/g);
  if (m4 && m4.length > 0) {
    year = Number(m4[m4.length - 1].replace(/^-/, ""));
    rest = rest.replace(/-((?:19|20)\d{2})(?=-|$|\s)/g, "").replace(/-$/, "");
  } else {
    const m2 = rest.match(/-(\d{2})(?=$|\s)/);
    if (m2 && Number(m2[1]) >= 10 && Number(m2[1]) <= 99) {
      year = 1900 + Number(m2[1]);
      rest = rest.replace(/-(\d{2})(?=$|\s)/, "");
    }
  }
  // 编号后的中文标题部分截断（标准号不含空格）
  const spaceIdx = rest.search(/\s/);
  if (spaceIdx > 0) rest = rest.slice(0, spaceIdx);
  rest = rest.replace(/[\s.]+$/g, "");
  if (!rest) return null;
  // IEC ed2.0c2 等修订后缀：比较编号用主编号，展示保留完整号
  let fullNumber = rest;
  let compareNumber = fullNumber.replace(/-ed\d+(?:\.\d+)?c\d+$/i, "");
  let numYear = year ? Number(year) : null;
  // 标题写法不规范时（尾随中文、_ 分隔、T/Z 残留、无水印/Redline/SASO 等杂质、
  // 20XX 占位年份、年份后直接接中文），上面的规则会切出无意义的“编号”，
  // 使该标准在站点永远查不到。仅在结果不可用时启用恢复解析，正常标题逐字不变。
  if (!isCleanStdNumber(compareNumber)) {
    const rec = recoverStdNumber(restRaw);
    if (rec) {
      fullNumber = rec.number;
      compareNumber = rec.number;
      if (rec.year != null) numYear = rec.year;
    }
  }
  const isDraft = DRAFT_STAGES.includes(stage);
  const isReleasedStage = RELEASED_STAGES.includes(stage);
  return {
    prefix,
    number: fullNumber,
    compareNumber,
    year: numYear,
    stage: stage || (isReleasedStage ? "发布稿" : ""),
    isDraft,
    released: !stage || isReleasedStage,
  };
}

/** 编号是否为规范形态（纯数字、点、连字符），用于判断是否需要恢复解析。 */
export function isCleanStdNumber(n) {
  return /^\d+(?:\.\d+)?(?:-\d+)*$/.test(String(n ?? ""));
}

/**
 * 从残缺编号段恢复标准编号：跳过 T/Z/Std、(电子) 之类残留，取数字骨架并剥离年份。
 * 仅在常规解析得到不可用编号时兜底，正常标题不会走到这里。
 * @returns {{number: string, year: number|null}|null}
 */
function recoverStdNumber(rest) {
  // 20XX / 202X 是占位年份，不是年份，先清除
  let s = String(rest ?? "").replace(/(?:^|[\s\-])(?:20\d[Xx]|20[Xx]{2})(?=[\s\-]|$)/g, " ");
  // 跳过编号前的括号限定：JJF (电子) 0013-2018、JJF (浙) 1138-2017
  for (;;) {
    const m = s.match(/^[\s\-_.]*(?:STD\.?|T|Z)?[\s\-_.]*\([^)]*\)[\s\-_.]*/i);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  const start = s.search(/\d/);
  if (start < 0) return null;
  const tail = s.slice(start);
  let core = (tail.match(/^\d[\d.\-]*/) ?? [""])[0].replace(/[-.]+$/, "");
  if (!core) return null;
  // 年份：段内首个 4 位年份（- 或空格分隔均可）
  let year = null;
  const my = tail.match(/(?:^|[\s\-])((?:19|20)\d{2})(?!\d)/);
  if (my) year = Number(my[1]);
  const mTail = core.match(/^(.*?)-((?:19|20)\d{2})$/);
  if (mTail) {
    core = mTail[1];
    if (year == null) year = Number(mTail[2]);
  }
  if (!core) return null;
  return { number: core, year };
}

/** 归一化编号用于比较：小写、去空格。 */
export function normNum(n) {
  return String(n ?? "").toLowerCase().replace(/\s+/g, "");
}

/** 编号匹配规则：完全相等；或同主号（小数点前相同）且站点号包含库内号（如 41004 ↔ 41004.2）。 */
export function numMatches(kbNum, siteNum) {
  const kb = normNum(kbNum);
  const site = normNum(siteNum);
  if (!kb || !site) return false;
  if (site === kb) return true;
  // 仅允许部分号关系：site 以 kb + "." 开头（如 41004 ↔ 41004.2），
  // 避免 18039.1 误配 18039.11
  return site.startsWith(kb + ".");
}

/** 标准体系族：GB/T、GB/Z 归 GB；NB/T 归 NB；Q/GDW 归 QGDW。 */
export function familyOf(prefix) {
  const p = String(prefix ?? "").toUpperCase();
  if (p === "Q/GDW" || p === "QGDW") return "QGDW";
  const m = p.match(/^([A-Z]+)(?:\/T|\/Z)?$/);
  return m ? m[1] : p;
}

/** 生成站内搜索候选词（按站方建议优先纯数字）。 */
export function queryCandidates(ref) {
  const num = ref.compareNumber;
  const year = ref.year;
  const set = [];
  const noDots = num.replace(/\./g, "");
  if (year) {
    set.push(`${num}-${year}`, `${noDots}-${year}`);
  }
  set.push(num, noDots);
  if (num.includes("-")) {
    set.push(num.split("-")[0]);
  }
  return [...new Set(set)].filter((s) => s.length >= 2);
}

// ---------------------------------------------------------------------------
// HTTP 层
// ---------------------------------------------------------------------------

async function fetchWith(baseUrl, path, init = {}, cookie) {
  const headers = {
    "User-Agent": UA,
    ...(init.headers ?? {}),
  };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(baseUrl + path, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(25000),
  });
  return res;
}

export async function searchStd(baseUrl, query, cookie) {
  const body = new URLSearchParams({ kwtype: "0", q: query });
  const res = await fetchWith(
    baseUrl,
    "/plus/search.php",
    {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
    cookie
  );
  if (res.status === 302 || res.status === 301) {
    // DedeCMS 命中单个结果会直接跳详情页
    const loc = res.headers.get("location") ?? "";
    const aid = loc.match(/\/html\/(\d+)\.html/);
    return { redirectAid: aid ? Number(aid[1]) : null, items: [] };
  }
  return { redirectAid: null, html: await res.text() };
}

/** 解析搜索结果页 → [{ aid, title, stdNo, pubDate, implDate, status }]。 */
export function parseSearchResults(html, ref) {
  const items = [];
  // 每个结果是一个 <li> 块，内含 related_tit 链接、标准号 dl、state、发布日期
  const blocks = html.match(/<li>[\s\S]*?<\/li>/g) ?? [];
  for (const block of blocks) {
    if (!block.includes("related_tit")) continue;
    const anchor = block.match(/<a[^>]+href="\/html\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/);
    if (!anchor) continue;
    const aid = Number(anchor[1]);
    const title = anchor[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const stdNoDl = block.match(/<span>标准号<\/span>([\s\S]*?)<\/dl>/);
    let stdNo = null;
    if (stdNoDl) {
      stdNo = stdNoDl[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, "");
    }
    const stateM = block.match(/<div class="state">([^<]*)<\/div>/);
    const ems = [...block.matchAll(/<em>(\d{4}-\d{2}-\d{2})<\/em>/g)].map((m) => m[1]);
    items.push({
      aid,
      title,
      stdNo: stdNo ? normalize(stdNo) : null,
      pubDate: ems[0] ?? null,
      implDate: ems[1] ?? null,
      status: stateM ? stateM[1].trim() : "",
    });
  }
  // 编号匹配：剔除年份后的编号与库内编号相等（或互为前后缀且含小数点分段）；
  // 指定 ref 但无匹配时返回空数组（避免模糊搜索结果被误当作命中）
  if (ref?.compareNumber) {
    const kb = normNum(ref.compareNumber);
    const match = items.filter((it) => {
      if (!it.stdNo) return false;
      const r = extractStdRef(it.stdNo);
      return numMatches(kb, r?.compareNumber ?? "");
    });
    return match;
  }
  return items;
}

/** 解析详情页字段。 */
export function parseDetail(html) {
  const grab = (label) => {
    const m = html.match(new RegExp(`<span>${label}：</span>([\\s\\S]*?)(?=</dd>|</li>)`));
    return m ? m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() : "";
  };
  const titleM = html.match(/<title>([^<]*)<\/title>/);
  return {
    title: titleM ? titleM[1].replace(/[_－].*$/, "").trim() : "",
    stdNo: normalize(grab("标准号").replace(/\s*-\s*/g, "-")),
    pubDate: grab("发布日期"),
    implDate: grab("实施日期"),
    replaced: grab("代替标准"),
    dept: grab("主管部门"),
  };
}

export async function fetchDetail(baseUrl, aid, cookie) {
  const res = await fetchWith(baseUrl, `/html/${aid}.html`, {}, cookie);
  const html = await res.text();
  return parseDetail(html);
}

/** 下载确认页：解析金币/下载链接。 */
export async function fetchDownloadPage(baseUrl, aid, cookie) {
  const res = await fetchWith(baseUrl, `/plus/download.php?aid=${aid}`, {}, cookie);
  const html = await res.text();
  const link = html.match(/href="(\/plus\/download\.php\?open=2[^"]+)"/);
  const costM = html.match(/下载需要\s*(\d+)\s*金币/);
  const vipM = /VIP会员.*?免费下载/.test(html);
  const noAuthM = /版权限制暂无下载/.test(html);
  return {
    html,
    fileLink: link ? link[1].replace(/&amp;/g, "&") : null,
    costCoins: costM ? Number(costM[1]) : null,
    vipFree: vipM,
    noAuth: noAuthM,
  };
}

/** 下载文件字节；返回 { buffer, ext, contentType } 或 { error }。 */
export async function downloadFile(baseUrl, page, cookie) {
  if (!page.fileLink) return { error: page.noAuth ? "未登录或版权限制" : "未找到下载链接" };
  let url = baseUrl + page.fileLink;
  let referer = `${baseUrl}/plus/download.php`;
  let currentCookie = cookie;
  const baseHost = new URL(baseUrl).host;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        ...(currentCookie ? { Cookie: currentCookie } : {}),
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(90000),
    });
    const loc = res.headers.get("location");
    if ((res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307) && loc) {
      url = new URL(loc, url).toString();
      referer = url;
      // 跳转到文件服务器（down.biaozhun.cc）后不再携带站点登录 Cookie
      if (new URL(url).host !== baseHost) currentCookie = "";
      continue;
    }
    const ct = String(res.headers.get("content-type") ?? "").toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (ct.includes("text/html") || ct.includes("application/json")) {
      const text = buf.toString("utf8").slice(0, 8000);
      const tM = text.match(/<title>([^<]*)<\/title>/);
      let reason = tM?.[1] ?? "HTML 响应（未登录/金币不足/文件不存在）";
      if (/登录|注册会员|请先/.test(text)) reason = "需要登录（Cookie 缺失或失效）";
      else if (/金币|余额|积分不足/.test(text)) reason = "金币不足或账号权限不足";
      else if (/404/.test(text)) reason = "文件不存在(404)";
      return { error: reason };
    }
    let ext = "pdf";
    const dm = res.headers.get("content-disposition") ?? "";
    const fm = dm.match(/filename="?([^";]+)"?/);
    if (fm) {
      ext = fm[1].split(".").pop()?.toLowerCase() || "pdf";
    }
    if (buf.length > 0 && buf[0] === 0x50 && buf[1] === 0x4b) ext = "zip";
    return { buffer: buf, ext, contentType: ct };
  }
  return { error: "重定向次数过多" };
}

// ---------------------------------------------------------------------------
// 检查编排
// ---------------------------------------------------------------------------

/** 读取知识库清单并聚合出标准列表：{ ref, docs:[{id,title,year,stage}], maxReleasedYear } */
export async function collectKbStandards(kbDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(kbDir, "kb.json"), "utf8"));
  } catch {
    throw new Error(`知识库清单不存在: ${join(kbDir, "kb.json")}`);
  }
  const byNum = new Map();
  for (const doc of manifest.docs ?? []) {
    const ref = extractStdRef(doc.title ?? "");
    if (!ref) continue;
    const key = normNum(ref.compareNumber);
    if (!byNum.has(key)) {
      byNum.set(key, {
        key,
        prefix: ref.prefix,
        number: ref.compareNumber,
        docs: [],
        maxReleasedYear: null,
        hasDraft: false,
      });
    }
    const g = byNum.get(key);
    g.docs.push({
      id: doc.id,
      title: doc.title,
      year: ref.year,
      stage: ref.stage,
      isDraft: ref.isDraft,
      released: ref.released,
      sourceFile: doc.sourceFile,
    });
    if (ref.released && ref.year != null) {
      g.maxReleasedYear = Math.max(g.maxReleasedYear ?? 0, ref.year);
    }
    if (ref.isDraft) g.hasDraft = true;
  }
  return { groups: [...byNum.values()], totalDocs: manifest.docs?.length ?? 0 };
}

function loadCache(cachePath) {
  try {
    const c = JSON.parse(readFileSync(cachePath, "utf8"));
    return c?.items && typeof c.items === "object" ? c : { items: {} };
  } catch {
    return { items: {} };
  }
}

function saveCache(cachePath, cache) {
  writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
}

/**
 * 执行一轮检查（可续查）。
 * @param opts { kbDir, baseUrl, cookie, rateMs, maxAgeDays, force, limit, action }
 *   action: 'check'（只检查）| 'check-download'（检查并下载更新）
 */
export async function runStdCheck(opts) {
  const {
    kbDir, baseUrl = DEFAULT_BASE, cookie = "", rateMs = 1200,
    maxAgeDays = 7, force = false, limit = 0, action = "check-download", dryRun = false,
    onProgress,
  } = opts;
  const emit = typeof onProgress === "function" ? onProgress : () => {};
  const cachePath = join(kbDir, ".std-check.json");
  const cache = loadCache(cachePath);
  const { groups, totalDocs } = await collectKbStandards(kbDir);
  emit({ phase: "collect", done: 0, total: groups.length, current: "", checked: 0 });
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 86400000;

  const report = {
    kbDir,
    totalDocs,
    stdGroups: groups.length,
    checked: 0,
    fresh: 0,
    deferred: 0,
    updates: [],
    currents: [],
    draftsReleased: [],
    notFound: [],
    newerInKb: [],
    skippedNonStd: totalDocs - groups.reduce((a, g) => a + g.docs.length, 0),
    downloaded: [],
    downloadFailed: [],
    authOk: null,
  };

  const pending = groups.filter((g) => {
    const it = cache.items[g.key];
    if (force || !it || !it.checkedAt) return true;
    if (it.status === "update" || it.status === "released") return true; // 待下载项重入
    return now - it.checkedAt > maxAgeMs;
  });

  // download 模式：跳过检查，直接从缓存取待下载项（金币充值后补下载用）
  if (action === "download") {
    for (const g of groups) {
      const it = cache.items[g.key];
      if (!it || !it.siteAid) continue;
      if (it.status === "update" || it.status === "released") {
        const dest = it.status === "update" ? report.updates : report.draftsReleased;
        if (!it.downloadedAt) dest.push(it);
      }
    }
    report.checked = 0;
    report.fresh = groups.length;
    report.deferred = 0;
    report.stdGroups = groups.length;
  } else {

  let done = 0;
  for (const g of pending) {
    if (limit > 0 && done >= limit) break;
    const entry = cache.items[g.key] ?? {
      key: g.key, number: g.number, prefix: g.prefix,
      docs: g.docs.map((d) => ({ id: d.id, title: d.title, year: d.year, stage: d.stage })),
    };
    entry.docs = g.docs.map((d) => ({ id: d.id, title: d.title, year: d.year, stage: d.stage }));
    try {
      let found = null;
      let searchCount = 0;
      const kbFam = familyOf(g.prefix);
      for (const q of queryCandidates({ compareNumber: g.number, year: g.maxReleasedYear ?? null })) {
        const r = await searchStd(baseUrl, q, cookie);
        searchCount++;
        if (r.redirectAid) {
          await sleep(rateMs);
          const d = await fetchDetail(baseUrl, r.redirectAid, cookie);
          const dr = extractStdRef(d.stdNo ?? "");
          if (d.stdNo && dr && numMatches(g.number, dr.compareNumber) && familyOf(dr.prefix) === kbFam) {
            found = { aid: r.redirectAid, stdNo: d.stdNo, title: d.title, pubDate: d.pubDate, implDate: d.implDate, status: "" };
            break;
          }
        } else if (r.html) {
          const items = parseSearchResults(r.html, { compareNumber: g.number })
            .filter((it) => familyOf(extractStdRef(it.stdNo ?? "")?.prefix ?? "") === kbFam);
          if (items.length > 0) {
            // 多个同编号结果取年份最大者（站点一般只收录现行版）
            items.sort((a, b) => (extractStdRef(b.stdNo ?? "")?.year ?? 0) - (extractStdRef(a.stdNo ?? "")?.year ?? 0));
            found = items[0];
            break;
          }
        }
        await sleep(rateMs);
      }
      entry.lastQueryCount = searchCount;
      entry.checkedAt = now;

      if (found) {
        const siteRef = extractStdRef(found.stdNo ?? found.title);
        const siteYear = siteRef?.year ?? null;
        entry.siteAid = found.aid;
        entry.siteNo = found.stdNo;
        entry.siteTitle = found.title;
        entry.siteYear = siteYear;
        entry.siteStatus = found.status || null;
        if (found.pubDate) entry.sitePubDate = found.pubDate;
        // 佐证：更新候选抓详情页“代替标准”
        const kbMax = g.maxReleasedYear;
        let status;
        if (siteYear == null) {
          status = "unknown";
        } else if (kbMax == null || g.hasDraft && !g.maxReleasedYear) {
          status = "released"; // 库内只有草案/编制说明，站上有正式条目
        } else if (siteYear > kbMax) {
          status = "update";
        } else if (siteYear === kbMax) {
          status = "current";
        } else {
          status = "newer-in-kb";
        }
        if (status === "update" || status === "released") {
          await sleep(rateMs);
          try {
            const d = await fetchDetail(baseUrl, found.aid, cookie);
            entry.replacedBy = null;
            if (d.replaced) entry.replaced = d.replaced;
            if (d.pubDate) entry.sitePubDate = d.pubDate;
            if (d.implDate) entry.siteImplDate = d.implDate;
            entry.detailOk = true;
          } catch {
            entry.detailOk = false;
          }
        }
        entry.status = status;
        entry.kbYears = g.docs.map((d) => d.year).filter((y) => y != null);
        cache.items[g.key] = entry;
        if (status === "update") report.updates.push(entry);
        else if (status === "released") report.draftsReleased.push(entry);
        else if (status === "current") report.currents.push(entry);
        else if (status === "newer-in-kb") report.newerInKb.push(entry);
      } else {
        entry.status = "not-found";
        entry.siteAid = null;
        entry.siteNo = null;
        cache.items[g.key] = entry;
        report.notFound.push(entry);
      }
      done++;
      report.checked++;
      emit({
        phase: "check",
        done,
        total: pending.length,
        current: String(g.number ?? g.key ?? ""),
        checked: report.checked,
        updates: report.updates.length,
        downloaded: report.downloaded.length,
        failed: report.downloadFailed.length,
      });
    } catch (error) {
      entry.error = String(error?.message ?? error);
      entry.status = "error";
      cache.items[g.key] = entry;
      report.checked++;
      done++;
      emit({
        phase: "check",
        done,
        total: pending.length,
        current: String(g.number ?? g.key ?? ""),
        checked: report.checked,
        updates: report.updates.length,
        downloaded: report.downloaded.length,
        failed: report.downloadFailed.length,
      });
    }
    if (done % 20 === 0) saveCache(cachePath, cache);
    await sleep(rateMs);
  }
  saveCache(cachePath, cache);
  // pending 含两类：缓存过期待查 + 因 limit 顺延。必须分开计数，
  // 否则分批执行时会把“还没查”的组谎报成“新鲜跳过”，让人误以为已查完。
  report.fresh = Math.max(0, groups.length - pending.length);
  report.deferred = Math.max(0, pending.length - report.checked);
  } // end else (check 模式)

  // 下载阶段
  if ((action === "check-download" || action === "download") && !dryRun) {
    const targets = [...report.updates, ...report.draftsReleased];
    const downloadTotal = targets.length;
    let downloadDone = 0;
    for (const t of targets) {
      downloadDone += 1;
      const it = cache.items[t.key] ?? t;
      const reportDownload = () => emit({
        phase: "download",
        done: downloadDone,
        total: downloadTotal,
        current: String(it.siteNo ?? it.number ?? ""),
        downloaded: report.downloaded.length,
        failed: report.downloadFailed.length,
      });
      if (it.downloadedAt) {
        report.downloaded.push({ ...it, already: true });
        reportDownload();
        continue;
      }
      await sleep(rateMs * 2);
      try {
        // 废止标准不下载（站点明确标注废止/作废，下载已无意义）
        if (it.siteStatus === "废止" || it.siteStatus === "作废") {
          it.downloadError = `站点标注已${it.siteStatus}，不下载`;
          report.downloadFailed.push({ stdNo: it.siteNo, aid: it.siteAid, reason: it.downloadError });
          cache.items[t.key] = it;
          reportDownload();
          continue;
        }
        // 标准体系防线：库内 QGDW 编号与站点 GB/T 同号时属于不同体系，不自动下载
        const siteRef = extractStdRef(it.siteNo ?? "");
        const kbFam = familyOf(it.prefix ?? extractStdRef(it.docs?.[0]?.title ?? "")?.prefix ?? "");
        const siteFam = familyOf(siteRef?.prefix ?? "");
        if (kbFam && siteFam && kbFam !== siteFam) {
          it.downloadError = `编号相同但标准体系不同（库内 ${kbFam} / 站点 ${siteFam}），需人工确认`;
          report.downloadFailed.push({ stdNo: it.siteNo, aid: it.siteAid, reason: it.downloadError });
          cache.items[t.key] = it;
          reportDownload();
          continue;
        }
        const page = await fetchDownloadPage(baseUrl, it.siteAid, cookie);
        if (page.noAuth) {
          report.authOk = false;
          it.downloadError = "未登录/版权限制（Cookie 缺失或失效）";
          report.downloadFailed.push({ stdNo: it.siteNo, aid: it.siteAid, reason: it.downloadError });
          reportDownload();
          break; // 登录态问题，停止后续下载
        }
        const file = await downloadFile(baseUrl, page, cookie);
        if (file.error === "DAILY_LIMIT") {
          it.downloadError = "今日下载次数已用完（每日上限），明日继续";
          report.dailyLimit = true;
          report.downloadFailed.push({ stdNo: it.siteNo, aid: it.siteAid, reason: it.downloadError });
          cache.items[t.key] = it;
          reportDownload();
          break; // 每日上限，停止后续下载尝试
        }
        if (file.error) {
          it.downloadError = file.error;
          report.downloadFailed.push({ stdNo: it.siteNo, aid: it.siteAid, reason: file.error });
          cache.items[t.key] = it;
          reportDownload();
          continue;
        }
        const safeNo = String(it.siteNo ?? it.number).replace(/[\\/:*?"<>|]/g, "_");
        const fileName = `${safeNo}.${file.ext}`;
        const dlDir = join(kbDir, "import-tmp", "std-download");
        await mkdir(dlDir, { recursive: true });
        const filePath = join(dlDir, fileName);
        await writeFile(filePath, file.buffer);
        it.downloadedFile = fileName;
        it.downloadedAt = new Date().toISOString();
        cache.items[t.key] = it;
        report.downloaded.push({ stdNo: it.siteNo, aid: it.siteAid, file: fileName, bytes: file.buffer.length, import: null });
        reportDownload();
      } catch (error) {
        it.downloadError = String(error?.message ?? error);
        report.downloadFailed.push({ stdNo: it.siteNo, aid: it.siteAid, reason: it.downloadError });
        cache.items[t.key] = it;
        reportDownload();
      }
    }
    saveCache(cachePath, cache);
    if (report.downloadFailed.length > 0 && report.authOk === null) report.authOk = true;
  }
  return { report, cache };
}

/**
 * 构造 importDownloaded 用的导入函数：
 * 已存在的来源文件跳过；导入前上报进度（工作台任务用）。
 */
export function createStdImportFn({ kbDir, existing = new Set(), config = {}, onProgress } = {}) {
  return async (filePath, title) => {
    const fileName = basename(filePath);
    if (existing.has(fileName)) return { docId: null, skipped: true };
    existing.add(fileName);
    onProgress?.(fileName, title);
    return importFileInto(kbDir, {
      sourcePath: filePath,
      relKey: `std-download/${fileName}`,
      stableKey: true,
      title,
      config,
    });
  };
}

/** 把已下载的文件导入知识库（供工具层调用，避免在库内硬编码 pipeline）。 */
export async function importDownloaded(kbDir, cache, importFile, importConfig) {
  const out = [];
  const items = Object.values(cache.items ?? {});
  for (const it of items) {
    if (!it.downloadedFile || it.importedDocId) continue;
    const filePath = join(kbDir, "import-tmp", "std-download", it.downloadedFile);
    try {
      const siteTitle = String(it.siteTitle ?? "").trim();
      const title = (siteTitle || `${it.siteNo ?? it.number}`).slice(0, 200);
      const r = await importFile(filePath, title, importConfig);
      it.importedDocId = r?.docId ?? null;
      it.importedAt = new Date().toISOString();
      out.push({ stdNo: it.siteNo, file: it.downloadedFile, docId: it.importedDocId, title });
    } catch (error) {
      it.importError = String(error?.message ?? error);
      out.push({ stdNo: it.siteNo, file: it.downloadedFile, error: it.importError });
    }
  }
  return out;
}

/** 渲染检查报告为纯文本。 */
export function renderStdReport(report) {
  const L = [];
  L.push(`标准更新检查报告（${new Date().toLocaleString("zh-CN")}）`);
  L.push(`知识库: ${report.kbDir}`);
  L.push(`文档总数 ${report.totalDocs}，识别标准组 ${report.stdGroups}，本轮检查 ${report.checked}，缓存内新鲜跳过 ${report.fresh}${report.deferred > 0 ? `，因 limit 顺延待查 ${report.deferred}` : ""}`);
  L.push("");
  if (report.updates.length > 0) {
    L.push(`【发现更新 ${report.updates.length} 条】`);
    for (const u of report.updates) {
      const oldY = u.docs.map((d) => d.year).filter(Boolean).sort().reverse()[0] ?? "?";
      L.push(`- ${u.siteNo ?? u.number}（库内 ${oldY} → 站点 ${u.siteYear}${u.siteStatus ? `，${u.siteStatus}` : ""}）${u.siteTitle ?? ""}${u.replaced ? `｜代替标准: ${u.replaced}` : ""}`);
    }
  }
  if (report.draftsReleased.length > 0) {
    L.push(`【草案已有正式版 ${report.draftsReleased.length} 条】`);
    for (const u of report.draftsReleased) {
      L.push(`- ${u.siteNo ?? u.number}（库内草案 → 站点 ${u.siteYear}${u.siteStatus ? `，${u.siteStatus}` : ""}）${u.siteTitle ?? ""}`);
    }
  }
  if (report.currents.length > 0) L.push(`【现行无更新 ${report.currents.length} 条】（略，见 .std-check.json）`);
  if (report.notFound.length > 0) {
    // 分三类：解析失败（我们的问题）／站外体系（站点本就不收）／确未收录，
    // 避免把“编号没解析对”混进“站点没有”，误导人工复核方向。
    const parseBad = report.notFound.filter((u) => !isCleanStdNumber(u.number));
    const rest = report.notFound.filter((u) => isCleanStdNumber(u.number));
    const offsite = rest.filter((u) => OFF_SITE_FAMILIES.has(familyOf(u.prefix ?? "")));
    const absent = rest.filter((u) => !OFF_SITE_FAMILIES.has(familyOf(u.prefix ?? "")));
    L.push(`【站点未收录 ${report.notFound.length} 条】`);
    if (parseBad.length > 0) {
      L.push(`- 编号解析异常 ${parseBad.length} 条（查询词无效，属程序问题而非站点缺失，建议修正标题写法）：`);
      for (const u of parseBad.slice(0, 30)) L.push(`  - ${u.number}`);
      if (parseBad.length > 30) L.push(`  …共 ${parseBad.length} 条`);
    }
    if (offsite.length > 0) {
      const byPrefix = new Map();
      for (const u of offsite) byPrefix.set(u.prefix ?? "?", (byPrefix.get(u.prefix ?? "?") ?? 0) + 1);
      L.push(`- 站外体系 ${offsite.length} 条（标准网通常不收录，属预期）：${[...byPrefix].map(([p, c]) => `${p} ${c}`).join("、")}`);
    }
    if (absent.length > 0) {
      L.push(`- 站点确未收录 ${absent.length} 条（可能已废止或该体系未收录），前 30 条：`);
      for (const u of absent.slice(0, 30)) {
        const y = (u.docs ?? []).map((d) => d.year).filter(Boolean).sort().reverse()[0];
        L.push(`  - ${u.number}${y ? `-${y}` : ""}`);
      }
      if (absent.length > 30) L.push(`  …共 ${absent.length} 条`);
    }
  }
  if (report.newerInKb.length > 0) L.push(`【库内年份更新于站点记录 ${report.newerInKb.length} 条】（可能是站点收录滞后，跳过）`);
  if (report.downloaded.length > 0) {
    L.push(`【已下载 ${report.downloaded.length} 份】`);
    for (const d of report.downloaded) L.push(`- ${d.stdNo} → ${d.file} (${d.bytes} B)${d.already ? "（此前已下载）" : ""}`);
  }
  if (report.downloadFailed.length > 0) {
    L.push(`【下载失败 ${report.downloadFailed.length} 份】`);
    for (const d of report.downloadFailed) L.push(`- ${d.stdNo}：${d.reason}`);
  }
  if (report.deferred > 0) {
    L.push("");
    L.push(`⚠ 尚有 ${report.deferred} 组未检查（本轮达到 limit 上限，并非已查完）：再次调用 kb_std_check 会从断点续查。`);
  }
  if (report.authOk === false) L.push("⚠ 登录态失效：请重新提供浏览器 Cookie 到插件配置 bzCookie。");
  return L.join("\n");
}
