/**
 * 标准更新检查与自动下载（biaozhun.org）。
 *
 * 流程：从知识库清单的文档标题中提取标准号 → 逐条在标准网搜索比对年份 →
 * 发现更新/正式版时抓详情页（代替标准字段佐证）→ 用登录会话自动下载 PDF →
 * 经 importFileInto 直接导入知识库。内置请求限速与增量缓存（断点续查）。
 *
 * 站点机制（2026-10 复测，取代 2026-08 的旧假设）：
 *  - 搜索:  第 1 页 POST /plus/search.php {kwtype:0, q:关键词}；翻页 GET /plus/search.php?q=&PageNo=N
 *  - 结果:  标题链接是分类路径 /guojia/、/hangye/、/difang/、/tuanti/、/jiliang/、/qiye/ + 少量旧 /html/
 *           （旧实现只认 /html/，导致多结果页永远解析为 0 → 大批标准被误报“未收录”）
 *  - 详情:  GET <结果的 href>（不能写死 /html/<aid>.html：分类路径的记录在 /html/ 下是 404）
 *           含标准号/发布日期/实施日期/代替标准，以及本站下载页链接
 *  - 下载:  下载 id 与详情页 id 是**两套编号**：必须取详情页里的 /plus/download.php?aid=<下载 id>，
 *           拿详情页 id 直接下载会拿到别的标准；下载前还要用确认页标题反查编号，
 *           对不上就中止（防串档）。
 *  - 登录:  仅微信扫码；本工具使用用户在浏览器登录后提供的 Cookie 串
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isDeleted } from "./store.js";

const DEFAULT_BASE = "https://www.biaozhun.org";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 标准前缀（长前缀在前，避免 GB 吞掉 GB/T 的 /T）。 */
const STD_PREFIXES = [
  "Q/GDW", "QGDW", "NB/T", "DL/T", "DL/Z", "JB/T", "HG/T", "YD/T", "SJ/T", "YS/T",
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
const OFF_SITE_FAMILIES = new Set(["QGDW", "IEC", "IEC/TS", "IEC/TR", "IEEE", "EN", "ISO", "ANSI", "ASTM", "GJB"]);

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

/** 从站点「代替标准」字段里拆出「被 … 代替」的继任编号（与库内版本收敛规则同一口径）。 */
export function successorsOf(field) {
  const m = String(field ?? "").match(/被([^；。]+?)代替/);
  if (!m) return [];
  return m[1].split(/[;；,，、]/).map((s) => s.trim()).filter(Boolean);
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

/**
 * 匹配类型：exact（同号）| partial（同主号不同分册，如库内 41004 ↔ 站点 41004.2）| null。
 * partial 只用于“提示人工确认”，不能参与年份判定——否则裸号文档会把某个分册的
 * 年份当成本号的新版本（库内 30 处裸号/分册并存的编号都会踩到）。
 */
export function matchKind(kbNum, siteNum) {
  const kb = normNum(kbNum);
  const site = normNum(siteNum);
  if (!kb || !site) return null;
  if (site === kb) return "exact";
  if (site.startsWith(kb + ".")) return "partial";
  return null;
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

async function fetchWith(baseUrl, path, init = {}, cookie, fetchImpl) {
  const headers = {
    "User-Agent": UA,
    ...(init.headers ?? {}),
  };
  if (cookie) headers.Cookie = cookie;
  const doFetch = fetchImpl ?? fetch;
  const res = await doFetch(baseUrl + path, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(25000),
  });
  return res;
}

/** 结果/详情页的路径族：搜索结果是分类路径，只有少量老记录还在 /html/ 下。 */
const DETAIL_PATH_RE = /\/(?:html|guojia|hangye|difang|tuanti|jiliang|qiye|jisuan)\/(\d+)\.html/;

/**
 * 站内搜索。第 1 页用 POST（站方推荐形式），翻页用 GET + PageNo。
 * 返回 { redirectAid, redirectHref, html, page }；302 表示命中单条并直达详情页。
 */
export async function searchStd(baseUrl, query, cookie, { page = 1, fetchImpl } = {}) {
  const p = Math.max(1, Math.round(Number(page) || 1));
  let res;
  if (p === 1) {
    res = await fetchWith(
      baseUrl,
      "/plus/search.php",
      {
        method: "POST",
        body: new URLSearchParams({ kwtype: "0", q: query }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      cookie,
      fetchImpl
    );
  } else {
    res = await fetchWith(baseUrl, `/plus/search.php?${new URLSearchParams({ q: query, PageNo: String(p) })}`, {}, cookie, fetchImpl);
  }
  if (res.status === 302 || res.status === 301) {
    // DedeCMS 命中单个结果会直接跳详情页
    const loc = String(res.headers.get("location") ?? "").trim();
    const href = loc.startsWith("http") ? new URL(loc).pathname : loc;
    const aid = href.match(DETAIL_PATH_RE);
    return { redirectAid: aid ? Number(aid[1]) : null, redirectHref: aid ? href : null, items: [] };
  }
  return { redirectAid: null, redirectHref: null, html: await res.text(), page: p };
}

/**
 * 解析搜索结果页 → [{ aid, href, title, stdNo, pubDate, implDate, status }]。
 * 标题链接可能落在分类路径或旧 /html/ 路径上，两种都要认，且把 href 一并带出，
 * 详情页必须按这个 href 取（写死 /html/ 会 404）。
 */
export function parseSearchResults(html, ref) {
  const items = [];
  // 每个结果是一个 <li> 块，内含 related_tit 链接、标准号 dl、state、发布日期
  const blocks = String(html ?? "").match(/<li>[\s\S]*?<\/li>/g) ?? [];
  for (const block of blocks) {
    if (!block.includes("related_tit")) continue;
    const anchor = block.match(/<a[^>]+href="([^"]*\/(?:html|guojia|hangye|difang|tuanti|jiliang|qiye|jisuan)\/(\d+)\.html)"[^>]*>([\s\S]*?)<\/a>/);
    if (!anchor) continue;
    const href = anchor[1].startsWith("http") ? new URL(anchor[1]).pathname : anchor[1];
    const aid = Number(anchor[2]);
    const title = anchor[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const stdNoDl = block.match(/<span>标准号<\/span>([\s\S]*?)<\/dl>/);
    let stdNo = null;
    if (stdNoDl) {
      stdNo = stdNoDl[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, "");
    }
    const stateM = block.match(/<div class="state">([^<]*)<\/div>/);
    const ems = [...block.matchAll(/<em>(\d{4}-\d{2}-\d{2})<\/em>/g)].map((m) => m[1]);
    items.push({
      aid,
      href,
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
    return items.filter((it) => it.stdNo && matchKind(kb, extractStdRef(it.stdNo)?.compareNumber ?? "") !== null);
  }
  return items;
}

/** 解析详情页字段；downloadAid 是本站下载页用的**另一个**编号（详情页 id ≠ 下载 id）。 */
export function parseDetail(html) {
  const text = String(html ?? "");
  const grab = (label) => {
    const m = text.match(new RegExp(`<span>${label}：</span>([\\s\\S]*?)(?=</dd>|</li>)`));
    return m ? m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() : "";
  };
  const titleM = text.match(/<title>([^<]*)<\/title>/);
  // 详情页把“标准状态 + 下载 id”放在 <... class="s-status" data-aid="147478" data-zt="现行"> 上
  const dlAid = text.match(/data-aid="(\d+)"/) ?? text.match(/\/plus\/download\.php\?aid=(\d+)/);
  const zt = text.match(/data-zt="([^"]*)"/);
  return {
    title: titleM ? titleM[1].replace(/[_－].*$/, "").trim() : "",
    stdNo: normalize(grab("标准号").replace(/\s*-\s*/g, "-")),
    pubDate: grab("发布日期"),
    implDate: grab("实施日期"),
    replaced: grab("代替标准"),
    dept: grab("主管部门"),
    status: zt ? zt[1].trim() : "",
    downloadAid: dlAid ? Number(dlAid[1]) : null,
    notFoundPage: /暂时找不到|页面不存在/.test(text.slice(0, 3000)),
  };
}

/**
 * 抓详情页。target 可以是详情页 href（"/hangye/123.html"）或数字 aid；
 * 数字 aid 走旧 /html/ 路径，失败时由调用方回退到 href。
 */
export async function fetchDetail(baseUrl, target, cookie, { fetchImpl } = {}) {
  const isHref = typeof target === "string" && target.startsWith("/");
  const path = isHref ? target : `/html/${target}.html`;
  const res = await fetchWith(baseUrl, path, {}, cookie, fetchImpl);
  const html = await res.text();
  const detail = parseDetail(html);
  return { ...detail, href: path, notFoundPage: detail.notFoundPage || html.length < 1200 };
}

/** 从确认页标题反查标准号（用于下载前防串档）。 */
export function parseConfirmPage(html) {
  const text = String(html ?? "");
  const titleM = text.match(/<title>([^<]*)<\/title>/);
  const title = titleM ? titleM[1].replace(/_下载地址列表.*$/, "").replace(/_标准网.*$/, "").replace(/_.*$/, "").trim() : "";
  const plain = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const costM = plain.match(/下载需要\s*(\d+)\s*金币/);
  const link = text.match(/href="(\/plus\/download\.php\?open=2[^"]+)"/);
  return {
    title,
    ref: extractStdRef(title),
    costCoins: costM ? Number(costM[1]) : null,
    vipFree: /VIP会员.*?免费下载/.test(plain),
    noAuth: /版权限制暂无下载/.test(plain),
    fileLink: link ? link[1].replace(/&amp;/g, "&") : null,
  };
}

/** 下载确认页：解析金币/下载链接 + 确认页标准号（防串档）。 */
export async function fetchDownloadPage(baseUrl, aid, cookie, { fetchImpl } = {}) {
  const res = await fetchWith(baseUrl, `/plus/download.php?aid=${aid}`, {}, cookie, fetchImpl);
  const html = await res.text();
  return { html, ...parseConfirmPage(html) };
}

/** 下载文件字节；返回 { buffer, ext, contentType } 或 { error }。 */
export async function downloadFile(baseUrl, page, cookie, { fetchImpl } = {}) {
  if (!page.fileLink) return { error: page.noAuth ? "未登录或版权限制" : "未找到下载链接" };
  let url = baseUrl + page.fileLink;
  let referer = `${baseUrl}/plus/download.php`;
  let currentCookie = cookie;
  const baseHost = new URL(baseUrl).host;
  const doFetch = fetchImpl ?? fetch;
  for (let hop = 0; hop < 4; hop++) {
    const res = await doFetch(url, {
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
      // 每日限额要先于金币判断：限额页往往也提到金币，误判成“金币不足”会让人去充值
      else if (/(今日|每日|当天)[^。]{0,12}(下载|次数)|(下载|次数)[^。]{0,8}(上限|用完|已满|超限)/.test(text)) return { error: "DAILY_LIMIT" };
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
  return { error: "重定向过多" };
}

// ---------------------------------------------------------------------------
// 检查编排
// ---------------------------------------------------------------------------

/** 标题里的过程资料标记：草案类不计入“库内已有正文年份”。 */
const DRAFT_TITLE_RE = /征求意见|报批|送审|讨论稿|草案|大纲|预审|修订稿/;
/** 编制说明/修订说明等伴生材料：库里没有正文，不能当作“已有该版本”。 */
const COMPANION_TITLE_RE = /编制说明|修订说明|编制大纲|条文说明|标准说明/;

/** 文档归类：text（正文/勘误/Redline 等可代表该版本存在）| draft（草案类）| companion（编制说明类）。 */
export function classifyDocKind({ stage, title, stageLabel, titleIsDraft } = {}) {
  const t = String(title ?? "");
  const manifestStage = String(stage ?? "");
  const draftStage = ["draft", "comment", "review", "discussion", "plan"].includes(manifestStage);
  if (draftStage || titleIsDraft === true || DRAFT_TITLE_RE.test(t) || DRAFT_STAGES.includes(String(stageLabel ?? ""))) return "draft";
  if (COMPANION_TITLE_RE.test(t)) return "companion";
  return "text";
}

/**
 * 读取知识库清单并聚合出标准列表。
 * 每组：{ key, prefix, number, docs, maxTextYear, hasDraft, hasText }
 *  - maxTextYear 只取“可代表该版本存在”的文档年份（正文/勘误/Redline），
 *    排除草案类与编制说明；软删除文档不参与。
 */
export async function collectKbStandards(kbDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(kbDir, "kb.json"), "utf8"));
  } catch {
    throw new Error(`知识库清单不存在: ${join(kbDir, "kb.json")}`);
  }
  const byNum = new Map();
  const docs = (manifest.docs ?? []).filter((doc) => !isDeleted(doc));
  for (const doc of docs) {
    const ref = doc.standardNo
      ? {
          prefix: doc.standardPrefix || "",
          number: doc.standardNumber || "",
          compareNumber: doc.standardNumber || "",
          year: Number.isFinite(doc.standardYear) ? doc.standardYear : null,
          stage: doc.stageLabel || "",
          isDraft: ["draft", "comment", "review", "discussion", "plan"].includes(doc.stage),
          released: ["published", "approved"].includes(doc.stage),
        }
      : extractStdRef(doc.title ?? "");
    if (!ref || !ref.compareNumber) continue;
    // 组键必须带标准体系：GB 311 与 DL/T 311、Q/GDW 618 与 DL/T 618 是不同标准，
    // 只用编号做键会把它们并成一组，年份比较和命中判定都会串。
    const key = `${familyOf(ref.prefix)}:${normNum(ref.compareNumber)}`;
    if (!byNum.has(key)) {
      byNum.set(key, {
        key,
        prefix: ref.prefix,
        number: ref.compareNumber,
        docs: [],
        maxTextYear: null,
        hasText: false,
        hasDraft: false,
      });
    }
    const g = byNum.get(key);
    const kind = classifyDocKind({
      stage: doc.stage,
      title: doc.title,
      stageLabel: ref.stage,
      titleIsDraft: ref.isDraft === true,
    });
    g.docs.push({
      id: doc.id,
      title: doc.title,
      year: ref.year,
      stage: ref.stage,
      isDraft: ref.isDraft,
      released: ref.released,
      kind,
      sourceFile: doc.sourceFile,
    });
    if (kind === "text" && ref.year != null) {
      g.maxTextYear = Math.max(g.maxTextYear ?? 0, ref.year);
      g.hasText = true;
    }
    if (kind === "draft") g.hasDraft = true;
  }
  return { groups: [...byNum.values()], totalDocs: docs.length, docs };
}

/**
 * 状态判定（纯函数，便于回归测试）。
 * kind: matchKind 的结果；maxTextYear: 库内正文最新年份（null = 只有草案/编制说明/无年份）。
 */
export function classifyStatus({ siteYear = null, kind = null, maxTextYear = null } = {}) {
  if (kind === "partial") return "ambiguous"; // 同主号不同分册：需人工确认，不可自动下载
  if (!kind) return null;
  if (siteYear == null) return "unknown";
  if (maxTextYear == null) return "released"; // 库内没有该号正文，站上有正式条目
  if (siteYear > maxTextYear) return "update";
  if (siteYear === maxTextYear) return "current";
  return "newer-in-kb";
}

/** 站点状态是否为废止/作废。 */
function isSupersededStatus(status) {
  return /废止|作废/.test(String(status ?? ""));
}

/** 清掉上一次检查遗留的站点侧字段（判 not-found/error 时用），避免旧值串进新报告。 */
const SITE_FIELDS = [
  "siteAid", "siteHref", "siteNo", "siteTitle", "siteYear", "siteStatus",
  "sitePubDate", "siteImplDate", "replaced", "replacedBy", "detailOk", "downloadAid", "matchKind",
];
function clearSiteFields(entry) {
  for (const f of SITE_FIELDS) delete entry[f];
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

/** 一次搜索最多翻几页（站方 15 条/页；热门编号 60+ 条，第 3 页足以覆盖同号跨体系）。 */
const MAX_SEARCH_PAGES = 3;

/**
 * 按标准号去站点精确抓一条记录（补下载用）。
 * 与检查流程同样的规则：分类路径翻页、详情页按 href 取、只接受同体系同号（exact）。
 * @returns {Promise<{found:boolean, stdNo?:string, href?:string, downloadAid?:number, year?:number,
 *   title?:string, status?:string, replaced?:string, pubDate?:string, implDate?:string, reason?:string}>}
 */
export async function findStdOnSite({
  baseUrl = DEFAULT_BASE, stdNo, cookie = "", rateMs = 1200, fetchImpl, maxPages = MAX_SEARCH_PAGES,
} = {}) {
  const target = extractStdRef(stdNo ?? "");
  if (!target || !isCleanStdNumber(target.compareNumber)) return { found: false, reason: "编号无法解析" };
  const family = familyOf(target.prefix);
  const accept = (detail, fallback) => {
    const ref = extractStdRef(detail.stdNo ?? fallback?.stdNo ?? "");
    if (!ref) return null;
    if (familyOf(ref.prefix) !== family) return null;
    if (matchKind(target.compareNumber, ref.compareNumber) !== "exact") return null;
    return {
      found: true,
      stdNo: detail.stdNo || fallback?.stdNo || "",
      href: detail.href ?? fallback?.href,
      downloadAid: detail.downloadAid ?? null,
      year: ref.year ?? null,
      title: detail.title || fallback?.title || "",
      status: detail.status || fallback?.status || "",
      replaced: detail.replaced || "",
      pubDate: detail.pubDate || fallback?.pubDate || "",
      implDate: detail.implDate || fallback?.implDate || "",
    };
  };
  for (const q of queryCandidates({ compareNumber: target.compareNumber, year: target.year })) {
    for (let page = 1; page <= maxPages; page++) {
      const r = await searchStd(baseUrl, q, cookie, { page, fetchImpl });
      if (r.redirectAid) {
        await sleep(rateMs);
        const d = await fetchDetail(baseUrl, r.redirectHref ?? r.redirectAid, cookie, { fetchImpl });
        const hit = accept(d, { href: r.redirectHref, stdNo: "" });
        if (hit) return hit;
        break;
      }
      const items = parseSearchResults(r.html ?? "", null);
      const picked = pickFound(items, { number: target.compareNumber, family });
      if (picked) {
        if (picked.kind !== "exact") break; // 分册/同主号不算命中，不必再抓详情
        await sleep(rateMs);
        const d = await fetchDetail(baseUrl, picked.href ?? picked.aid, cookie, { fetchImpl });
        const hit = accept(d, picked);
        if (hit) return hit;
        break;
      }
      if (items.length === 0) break;
      await sleep(rateMs);
    }
    await sleep(rateMs);
  }
  return { found: false, reason: "站点未找到该编号（可能未收录或编号写法不同）" };
}

/** 从一批结果里挑本组的命中：精确同号优先，其次年份最新；partial 只在无精确命中时兜底。 */
function pickFound(items, { number, family }) {
  const scored = [];
  for (const it of items) {
    const ref = extractStdRef(it.stdNo ?? it.title ?? "");
    if (!ref) continue;
    if (familyOf(ref.prefix) !== family) continue;
    const kind = matchKind(number, ref.compareNumber);
    if (!kind) continue;
    scored.push({ ...it, ref, year: ref.year ?? null, kind });
  }
  if (scored.length === 0) return null;
  const rank = (k) => (k === "exact" ? 0 : 1);
  scored.sort((a, b) => rank(a.kind) - rank(b.kind) || (b.year ?? 0) - (a.year ?? 0));
  return scored[0];
}

/**
 * 执行一轮检查（可续查）。
 * @param opts { kbDir, baseUrl, cookie, rateMs, maxAgeDays, force, limit, action, shouldStop, fetchImpl }
 *   action: 'check'（只检查）| 'check-download'（检查并下载更新）| 'download'（只补下载）
 *   shouldStop: 可选协作取消回调；返回 true 时在下一个网络请求前停止，已发出的请求可能完成。
 */
export async function runStdCheck(opts) {
  const {
    kbDir, baseUrl = DEFAULT_BASE, cookie = "", rateMs = 1200,
    maxAgeDays = 7, force = false, limit = 0, action = "check-download", dryRun = false,
    onProgress, shouldStop, fetchImpl,
  } = opts;
  const stopped = () => shouldStop?.() === true;
  const emit = typeof onProgress === "function" ? onProgress : () => {};
  const cachePath = join(kbDir, ".std-check.json");
  const cache = loadCache(cachePath);
  const { groups, totalDocs, docs: liveDocs } = await collectKbStandards(kbDir);
  // 离线规则：同号已有更新年份 ⇒ 旧版按已废止处理（不联网；动态 import 避免加载期循环依赖）
  let librarySuperseded = { groups: [], docs: 0 };
  try {
    const mod = await import("./supersede.js");
    librarySuperseded = mod.collectLibrarySuperseded({ docs: liveDocs });
  } catch {
    /* 规则不可用时不影响检查本身 */
  }
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
    superseded: [],
    ambiguous: [],
    unknown: [],
    skippedNonStd: totalDocs - groups.reduce((a, g) => a + g.docs.length, 0),
    downloaded: [],
    downloadFailed: [],
    coinsSpent: 0,
    dailyLimit: false,
    authOk: null,
    cancelled: false,
    librarySuperseded,
  };

  const pending = groups.filter((g) => {
    const it = cache.items[g.key];
    if (force || !it || !it.checkedAt) return true;
    if (it.status === "update" || it.status === "released") return true; // 待下载项重入
    return now - it.checkedAt > maxAgeMs;
  });

  // download 模式：跳过检查，直接从缓存取待下载项（金币充值后再继续用）
  if (action === "download") {
    for (const g of groups) {
      const it = cache.items[g.key];
      if (!it || it.downloadedAt) continue;
      if (it.status === "update" || it.status === "released") {
        const dest = it.status === "update" ? report.updates : report.draftsReleased;
        dest.push(it);
      }
    }
    report.checked = 0;
    report.fresh = groups.length;
    report.deferred = 0;
    report.stdGroups = groups.length;
  } else {

  let done = 0;
  for (const g of pending) {
    if (stopped()) {
      report.cancelled = true;
      break;
    }
    if (limit > 0 && done >= limit) break;
    const entry = cache.items[g.key] ?? {
      key: g.key, number: g.number, prefix: g.prefix,
      docs: g.docs.map((d) => ({ id: d.id, title: d.title, year: d.year, stage: d.stage })),
    };
    entry.docs = g.docs.map((d) => ({ id: d.id, title: d.title, year: d.year, stage: d.stage, kind: d.kind }));
    try {
      let found = null;
      let searchCount = 0;
      let detailOk = null;
      const kbFam = familyOf(g.prefix);
      const mark = (label) => { if (stopped()) { report.cancelled = true; throw new Error(`cancelled:${label}`); } };
      // 站外体系（Q/GDW、IEC、IEEE、EN…）标准网不收录：直接判未收录，不必逐条搜索
      const offSite = OFF_SITE_FAMILIES.has(kbFam);
      search: for (const q of offSite ? [] : queryCandidates({ compareNumber: g.number, year: g.maxTextYear ?? null })) {
        for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
          mark("pre-search");
          const r = await searchStd(baseUrl, q, cookie, { page, fetchImpl });
          searchCount++;
          if (r.redirectAid) {
            // 302：站点已锁定唯一结果，直接抓详情并用编号校验（防止跳错页）
            await sleep(rateMs);
            mark("pre-detail");
            const d = await fetchDetail(baseUrl, r.redirectHref ?? r.redirectAid, cookie, { fetchImpl });
            const ref = extractStdRef(d.stdNo ?? "");
            const kind = ref ? matchKind(g.number, ref.compareNumber) : null;
            if (d.stdNo && ref && kind && familyOf(ref.prefix) === kbFam) {
              found = {
                aid: r.redirectAid, href: d.href, stdNo: d.stdNo, title: d.title || d.stdNo,
                status: d.status || "", pubDate: d.pubDate, implDate: d.implDate,
                replaced: d.replaced, downloadAid: d.downloadAid,
                ref, year: ref.year ?? null, kind,
              };
              detailOk = !d.notFoundPage;
            }
            break search;
          }
          const pageItems = parseSearchResults(r.html ?? "", null);
          const hit = pickFound(pageItems, { number: g.number, family: kbFam });
          if (hit) {
            // 抓详情页拿“代替标准 / 下载 id / 状态”（搜索条目里没有下载 id）
            await sleep(rateMs);
            mark("pre-detail");
            const d = await fetchDetail(baseUrl, hit.href ?? hit.aid, cookie, { fetchImpl });
            if (d.stdNo) {
              const ref = extractStdRef(d.stdNo);
              found = {
                ...hit,
                stdNo: d.stdNo,
                title: d.title || hit.title,
                status: d.status || hit.status || "",
                pubDate: d.pubDate || hit.pubDate,
                implDate: d.implDate || hit.implDate,
                replaced: d.replaced,
                downloadAid: d.downloadAid,
                href: d.href,
                ref,
                year: ref?.year ?? hit.year,
              };
              detailOk = !d.notFoundPage;
            } else {
              found = { ...hit, status: hit.status || "", replaced: "", downloadAid: null };
              detailOk = false;
            }
            break search;
          }
          // 本页没有匹配：只有仍可能有后续结果时才翻页。
          // 本页连“同数字不同体系”的条目都没有时，深页基本是别的编号，继续翻只是浪费请求。
          if (pageItems.length === 0) break;
          const digits = String(g.number).replace(/[^0-9.]/g, "");
          const mentions = pageItems.some((it) => {
            const num = String(extractStdRef(it.stdNo ?? "")?.compareNumber ?? "").replace(/[^0-9.]/g, "");
            return num.length > 0 && (num.includes(digits) || digits.includes(num));
          });
          if (!mentions) break;
          await sleep(rateMs);
        }
        await sleep(rateMs);
      }
      // 站点把同编号的新版放在另一条记录里时，当前记录只会标「废止」并写明「被 X 代替」。
      // 直接按 X 去抓：抓到比库内更新的版本就升级为 update，否则维持 superseded。
      let replacedBy = "";
      if (found && isSupersededStatus(found.status)) {
        for (const succ of successorsOf(found.replaced).slice(0, 2)) {
          mark("pre-successor");
          const hit = await findStdOnSite({ baseUrl, stdNo: succ, cookie, rateMs, fetchImpl, maxPages: 2 });
          if (hit.found && hit.year != null && (g.maxTextYear == null || hit.year > g.maxTextYear)) {
            const ref = extractStdRef(hit.stdNo ?? succ);
            found = {
              aid: hit.downloadAid ?? null,
              href: hit.href,
              stdNo: hit.stdNo || succ,
              title: hit.title || succ,
              status: hit.status || "",
              pubDate: hit.pubDate || "",
              implDate: hit.implDate || "",
              replaced: hit.replaced || "",
              downloadAid: hit.downloadAid ?? null,
              ref,
              year: ref?.year ?? hit.year,
              kind: "exact",
            };
            replacedBy = succ;
            break;
          }
          await sleep(rateMs);
        }
      }

      entry.lastQueryCount = searchCount;
      entry.checkedAt = now;

      if (found) {
        delete entry.error;
        const kbMax = g.maxTextYear;
        let status = classifyStatus({ siteYear: found.year, kind: found.kind, maxTextYear: kbMax });
        // 站点标注废止/作废：库内这一版已被替代，单独成组提示收敛（不是“已是最新”）。
        // 但库内已有更新的正文（siteYear < maxTextYear）时，命中的只是站点的旧记录，
        // 应保持 newer-in-kb，不能诬告“库内版本已废止”。
        if (status && ["update", "released", "current"].includes(status) && isSupersededStatus(found.status)) {
          status = "superseded";
        }
        entry.siteAid = found.aid;
        entry.siteHref = found.href ?? null;
        entry.siteNo = found.stdNo;
        entry.siteTitle = found.title;
        entry.siteYear = found.year ?? null;
        entry.siteStatus = found.status || null;
        entry.matchKind = found.kind;
        entry.maxTextYear = kbMax;
        if (found.pubDate) entry.sitePubDate = found.pubDate;
        if (found.implDate) entry.siteImplDate = found.implDate;
        if (found.replaced) entry.replaced = found.replaced; else delete entry.replaced;
        if (found.downloadAid) entry.downloadAid = found.downloadAid; else delete entry.downloadAid;
        entry.detailOk = detailOk === true;
        if (replacedBy) entry.replacedBy = replacedBy; else delete entry.replacedBy;
        entry.status = status;
        entry.kbYears = g.docs.map((d) => d.year).filter((y) => y != null);
        cache.items[g.key] = entry;
        if (status === "update") report.updates.push(entry);
        else if (status === "released") report.draftsReleased.push(entry);
        else if (status === "current") report.currents.push(entry);
        else if (status === "newer-in-kb") report.newerInKb.push(entry);
        else if (status === "superseded") report.superseded.push(entry);
        else if (status === "ambiguous") report.ambiguous.push(entry);
        else report.unknown.push(entry);
      } else {
        // 未命中：必须清掉上一轮的站点字段，否则旧的“代替标准/年份”会串进新报告
        clearSiteFields(entry);
        delete entry.error;
        entry.offSite = OFF_SITE_FAMILIES.has(kbFam);
        entry.status = "not-found";
        entry.checkedAt = now;
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
      if (report.cancelled) break;
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
      if (stopped()) {
        report.cancelled = true;
        break;
      }
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
      // 限速等待期间也可能收到取消：真正花金币的下载请求必须在发出前再确认一次。
      if (stopped()) {
        report.cancelled = true;
        break;
      }
      try {
        // 废止标准不下载（站点明确标注废止/作废，下载已无意义）
        if (isSupersededStatus(it.siteStatus)) {
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
        // 站点下载 id 与详情页 id 不是一套编号：必须用详情页里解析出的 downloadAid
        const dlAid = it.downloadAid ?? null;
        if (!dlAid) {
          it.downloadError = "详情页未解析到站点下载 id，跳过（不拿详情页 id 冒险下载）";
          report.downloadFailed.push({ stdNo: it.siteNo, aid: it.siteAid, reason: it.downloadError });
          cache.items[t.key] = it;
          reportDownload();
          continue;
        }
        const page = await fetchDownloadPage(baseUrl, dlAid, cookie, { fetchImpl });
        // 页面请求可能正在途中：它在取消前发出可以完成，但花金币的文件下载不再发起。
        if (stopped()) {
          report.cancelled = true;
          break;
        }
        // 防串档：确认页标题必须回指同一个标准号
        const expect = extractStdRef(it.siteNo ?? "");
        const confKind = expect && page.ref ? matchKind(expect.compareNumber, page.ref.compareNumber) : null;
        if (!confKind) {
          it.downloadError = `下载确认页与目标标准不一致（目标 ${it.siteNo ?? "?"} / 确认页 ${page.title || "无法解析"}），已中止`;
          report.downloadFailed.push({ stdNo: it.siteNo, aid: dlAid, reason: it.downloadError });
          cache.items[t.key] = it;
          reportDownload();
          continue;
        }
        if (page.noAuth) {
          report.authOk = false;
          it.downloadError = "未登录/版权限制（Cookie 缺失或失效）";
          report.downloadFailed.push({ stdNo: it.siteNo, aid: dlAid, reason: it.downloadError });
          cache.items[t.key] = it;
          reportDownload();
          break; // 登录态问题，停止后续下载
        }
        if (page.costCoins != null) it.costCoins = page.costCoins;
        const file = await downloadFile(baseUrl, page, cookie, { fetchImpl });
        if (file.error === "DAILY_LIMIT") {
          it.downloadError = "今日下载次数已用完（每日上限），明日继续";
          report.dailyLimit = true;
          report.downloadFailed.push({ stdNo: it.siteNo, aid: dlAid, reason: it.downloadError });
          cache.items[t.key] = it;
          reportDownload();
          break; // 每日上限，停止后续下载尝试
        }
        if (file.error) {
          it.downloadError = file.error;
          report.downloadFailed.push({ stdNo: it.siteNo, aid: dlAid, reason: file.error });
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
        if (page.costCoins) report.coinsSpent += page.costCoins;
        delete it.downloadError;
        cache.items[t.key] = it;
        report.downloaded.push({ stdNo: it.siteNo, aid: dlAid, file: fileName, bytes: file.buffer.length, costCoins: page.costCoins ?? null, import: null });
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
 * onProgress(fileName, title, { skipped }) 对每个处理到的文件恰好调用一次。
 */
export function createStdImportFn({ kbDir, existing = new Set(), config = {}, onProgress } = {}) {
  return async (filePath, title) => {
    const fileName = basename(filePath);
    if (existing.has(fileName)) {
      onProgress?.(fileName, title, { skipped: true });
      return { docId: null, skipped: true };
    }
    existing.add(fileName);
    onProgress?.(fileName, title, { skipped: false });
    const { importFileInto } = await import("./pipeline.js");
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

/** 报告里“库内年份”的展示值：正文最新年份（没有正文时退回全部年份并标注）。 */
function kbYearText(entry) {
  if (entry.maxTextYear != null) return String(entry.maxTextYear);
  const all = (entry.docs ?? []).map((d) => d.year).filter((y) => y != null);
  if (all.length === 0) return "?";
  const nonText = (entry.docs ?? []).some((d) => d.kind === "draft" || d.kind === "companion");
  return `${Math.max(...all)}${nonText ? "（非正文）" : ""}`;
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
      L.push(`- ${u.siteNo ?? u.number}（库内正文 ${kbYearText(u)} → 站点 ${u.siteYear}${u.siteStatus ? `，${u.siteStatus}` : ""}）${u.siteTitle ?? ""}${u.replaced ? `｜代替标准: ${u.replaced}` : ""}${u.downloadAid ? "" : "｜⚠ 未取到下载 id"}`);
    }
  }
  if (report.draftsReleased.length > 0) {
    L.push(`【草案已有正式版 ${report.draftsReleased.length} 条】`);
    for (const u of report.draftsReleased) {
      L.push(`- ${u.siteNo ?? u.number}（库内仅草案/编制说明 → 站点 ${u.siteYear}${u.siteStatus ? `，${u.siteStatus}` : ""}）${u.siteTitle ?? ""}${u.replaced ? `｜代替标准: ${u.replaced}` : ""}`);
    }
  }
  const lib = report.librarySuperseded;
  if (lib && lib.docs > 0) {
    L.push(`【库内同号旧版本 ${lib.docs} 篇】（同号已有更新年份：最新年份视为现行版，旧版按已废止处理，可用 scripts/mark-superseded-low.mjs --library 标 low）`);
    for (const g of lib.groups.slice(0, 15)) {
      L.push(`- ${g.prefix} ${g.number}（现行候选 ${g.keep.map((k) => k.year).join("/")}；旧版 ${g.olds.map((o) => o.year).join("/")}）`);
    }
    if (lib.groups.length > 15) L.push(`  …共 ${lib.groups.length} 组`);
  }
  if (report.superseded.length > 0) {
    L.push(`【库内版本已被站点标注废止/作废 ${report.superseded.length} 条】（建议收敛为 trust=low，需人工核对代替关系）`);
    for (const u of report.superseded.slice(0, 40)) {
      L.push(`- ${u.siteNo ?? u.number}（库内正文 ${kbYearText(u)}｜站点 ${u.siteStatus ?? "废止"}）`);
    }
    if (report.superseded.length > 40) L.push(`  …共 ${report.superseded.length} 条`);
  }
  if (report.ambiguous.length > 0) {
    L.push(`【编号分册歧义 ${report.ambiguous.length} 条】（库内是裸号、站点命中的是分册；不参与年份判定，需人工确认）`);
    for (const u of report.ambiguous.slice(0, 30)) L.push(`- 库内 ${u.number} ↔ 站点 ${u.siteNo ?? "?"}`);
    if (report.ambiguous.length > 30) L.push(`  …共 ${report.ambiguous.length} 条`);
  }
  if (report.currents.length > 0) L.push(`【已是最新 ${report.currents.length} 条】（略，见 .std-check.json）`);
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
  if (report.unknown.length > 0) L.push(`【站点命中但年份无法解析 ${report.unknown.length} 条】（见 .std-check.json）`);
  if (report.downloaded.length > 0) {
    L.push(`【已下载 ${report.downloaded.length} 份】`);
    for (const d of report.downloaded) L.push(`- ${d.stdNo} → ${d.file} (${d.bytes} B)${d.costCoins ? `，${d.costCoins} 金币` : ""}${d.already ? "（此前已下载）" : ""}`);
    if (report.coinsSpent > 0) L.push(`  本轮消耗金币合计 ${report.coinsSpent}`);
  }
  if (report.downloadFailed.length > 0) {
    L.push(`【下载失败 ${report.downloadFailed.length} 份】`);
    for (const d of report.downloadFailed) L.push(`- ${d.stdNo}：${d.reason}`);
  }
  if (report.dailyLimit) L.push("⚠ 站点提示今日下载次数已用完：本轮已停止，明日可继续（缓存中待下载项保留）。");
  if (report.deferred > 0) {
    L.push("");
    L.push(`⚠ 尚有 ${report.deferred} 组未检查（本轮达到 limit 上限，并非已查完）：再次调用 kb_std_check 会从断点续查。`);
  }
  if (report.authOk === false) L.push("⚠ 登录态失效：请重新提供浏览器 Cookie 到插件配置 bzCookie。");
  return L.join("\n");
}
