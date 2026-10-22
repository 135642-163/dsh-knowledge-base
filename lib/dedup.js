/**
 * 导入前查重：基于标题的关键信息比对（标准号代码+年份+版本桶 + 核心短语），
 * 在解析/OCR 之前把重合文件筛掉，避免重复入库与重复计算。
 *
 * 规则（与知识库内笔记「导入规范」一致）：
 *  - 同库重合 → 跳过（始终）；
 *  - 跨库重合 → 默认跳过并在结果中报告，用户确认需要时用 allowCrossDuplicates: true 导入；
 *  - 同名文件（同 relKey → 同 docId）不视为重合：由 store 原位更新（版本号+1）。
 *
 * 匹配口径：
 *  - 标准号代码：GB/T=GBT、DL/T=DLT、Q/GDW=Q_GDW、连字符/破折号（-、—、–、~、～）归一，
 *    部分号小数点保留（10650.2 ≠ 10650）；
 *  - 年份：双方都有年份时必须相同；一方无年份（如无年份的报批稿）不判重合——可能是新修订；
 *  - 版本桶：发布稿/无标记 → pub；报批稿 → draft；征求意见稿 → comment；编制说明 → notes 等，
 *    同代码同年份但版本桶不同（如报批稿 vs 发布稿）不判重合；
 *  - 无标准号的文件按核心短语比对（相等，或最长公共前缀 ≥ 8 字且双方 ≥ 8 字），版本桶须一致。
 */
import { docIdFor, kbDirPath, listKbs, tryReadManifest } from "./store.js";

// 带年份的标准号模式（连字符兼容 -、—、–、~、～）
const STD_PATTERNS = [
  /GB[\s/∕_T]*\d{4,5}(?:\.\d+)?\s*[-\u2013\u2014~～]\s*\d{4}/i,
  /DL[\s/∕_T]*\d{3,4}(?:\.\d+)?\s*[-\u2013\u2014~～]\s*\d{4}/i,
  /NB[\s/∕_T]*\d{3,5}(?:\.\d+)?\s*[-\u2013\u2014~～]\s*\d{4}/i,
  /TB[\s/∕_T]*\d{3,4}(?:\.\d+)?\s*[-\u2013\u2014~～]\s*\d{4}/i,
  /Q[\s/∕_]*GDW[\s/∕_]*\d{3,5}(?:\.\d+)?\s*[-\u2013\u2014~～]\s*\d{4}/i,
  /T[\s/∕_]*(?:CEC|CES|CECS|SZ)[\s/∕_]*\d{3,4}(?:\.\d+)?\s*[-\u2013\u2014~～]\s*\d{4}/i,
  /IEEE[\s/∕_]*Std[\s/∕_]*[\w.\-]+\s*[-\u2013\u2014~～]\s*\d{4}/i,
  /IEC[\s/∕_]*\d[\w.\-]*\s*[-\u2013\u2014~～]\s*\d{4}/i,
];
// 无年份的标准号代码（如「Q_GDW 10212（报批稿）」）
const STD_CODE_PATTERN =
  /(?:Q[\s/∕_]*GDW|GB|DL|NB|TB|T[\s/∕_]*(?:CEC|CES)|IEEE[\s/∕_]*Std|IEC)[\s/∕_T]*\d{3,5}(?:\.\d+)?/i;
// 裸编号-年份（如 919-2018）；前导组限 2–3 位数字，避免把「2026—2028」这类年份区间误判
const NUM_PATTERN = /(?:^|[^\d])(\d{2,3})\s*[-\u2013\u2014~～]\s*(\d{4})/;
// 版本标记 → 版本桶（无标记视同发布）
const EDITION_BUCKETS = [
  [/报批(?:稿)?/, "draft"],
  [/征求意见(?:稿)?/, "comment"],
  [/送审稿/, "review"],
  [/终审稿/, "final"],
  [/批准稿/, "approve"],
  [/草案/, "plan"],
  [/编制说明/, "notes"],
  [/发布(?:稿)?/, "pub"],
];

function normalizeStdCode(s) {
  return s
    .replace(/[\s/∕_]/g, "")
    .replace(/^(GB|DL|NB|TB|Q)T/i, "$1")
    .replace(/[-\u2013\u2014~～]+$/, "")
    .toUpperCase();
}

function editionBucket(title) {
  for (const [re, bucket] of EDITION_BUCKETS) {
    if (re.test(title)) return bucket;
  }
  return "pub";
}

// 系列文件的部/分册标记：第2部分、第36分册、第3篇、第1卷…
// 同核心标题但部号不同的文件不是同一份（如「XX导则 第1部分」vs「第2部分」）。
const PART_RE = /第\s*([一二三四五六七八九十百零〇两\d]+)\s*(部分|分册|篇|章|节|卷|册)/;
const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  if (s.length === 1 && s in CN_DIGITS) return CN_DIGITS[s];
  return s;
}

function partKey(title) {
  const m = String(title ?? "").match(PART_RE);
  return m ? `${m[2]}:${cnNumber(m[1])}` : "";
}

/** 去掉空白与标点后的核心短语，用于同标题比较（不改变数字/字母）。 */
const CORE_NOISE = /[\s\u3000\-—_/\\:：,，。.、；;？?！!（）()【】\[\]《》〈〉「」『』"'“”‘’·•…]/g;
function normalizeCore(s) {
  return String(s ?? "").normalize("NFKC").toLowerCase().replace(CORE_NOISE, "");
}

/** 标题关键信息：标准号代码、年份（无则 null）、版本桶、核心短语。 */
export function titleKeys(title) {
  const t = String(title ?? "");
  let code = null;
  let year = null;
  for (const p of STD_PATTERNS) {
    const m = t.match(p);
    if (!m) continue;
    const s = m[0];
    const ym = s.match(/(\d{4})$/);
    code = normalizeStdCode(s.slice(0, ym ? ym.index : s.length));
    year = ym ? Number(ym[1]) : null;
    break;
  }
  if (!code) {
    const m = t.match(STD_CODE_PATTERN);
    if (m) code = normalizeStdCode(m[0]);
  }
  if (!code) {
    const m = t.match(NUM_PATTERN);
    if (m) {
      code = `NUM:${m[1]}`;
      year = Number(m[2]);
    }
  }
  // 核心短语：去掉开头编号（"1."、"1、"）；优先取第一个《…》的内容；
  // 否则取到第一个“顶层”分隔符（空白或标点）为止，中英文括号成对跳过——
  // 这样 "电能质量管理办法（暂行） 2023年…" → "电能质量管理办法（暂行）"，
  // "中国海装6.2MW变流器原理图" → 全文，"供电营业规则 2024年…" → "供电营业规则"。
  let core = t.replace(/^[\d.、\s]+/, "");
  const bracket = core.match(/《([^》]{2,60})》/);
  if (bracket) core = bracket[1];
  else {
    let out = "";
    let depth = 0;
    for (const ch of core) {
      if (ch === "（" || ch === "(") depth += 1;
      else if ((ch === "）" || ch === ")") && depth > 0) depth -= 1;
      // 注意：分隔符不含 "."（避免截断 6.2MW、PMS3.0 等）；中文句号仍作分隔
      if (depth === 0 && /[\s,，。;；:：、]/.test(ch)) break;
      out += ch;
    }
    core = out.trim();
  }
  core = core.replace(/\s+/g, " ");
  return { code, year, edition: editionBucket(t), core, part: partKey(t) };
}

/**
 * 无标准号时按核心短语比对，返回置信级别：
 *  - "exact"  规范化后完全相同 → 可自动跳过；
 *  - "prefix" 短标题是长标题的完整前缀（如「XX导则」vs「XX导则（试行）」）
 *             → 只提示相似，不自动跳过；
 *  - null     仅共享一段公共前缀（常见于同一个单位名开头）→ 不匹配。
 *
 * 旧实现用「最长公共前缀 ≥ 9 字」判重合，会把
 * 「国网浙江省电力有限公司电能质量管理规定」和
 * 「国网浙江省电力有限公司关于印发…的通知」误判为同一份文件。
 */
function coresMatch(a, b) {
  const A = normalizeCore(a);
  const B = normalizeCore(b);
  const la = [...A].length;
  const lb = [...B].length;
  if (Math.min(la, lb) < 6) return null;
  if (A === B) return "exact";
  const [short, long] = la < lb ? [A, B] : [B, A];
  if (short.length < 6) return null;
  return long.startsWith(short) ? "prefix" : null;
}

function keysMatch(cand, doc) {
  if (cand.code && doc.code) {
    if (cand.code !== doc.code) return null;
    if (cand.year !== null && doc.year !== null) {
      if (cand.year !== doc.year) return null;
    } else if (cand.year === null && doc.year === null) {
      /* 双方都无年份：继续看版本桶 */
    } else {
      return null; // 一方有年份一方没有：不判重合（可能是新修订）
    }
    return cand.edition === doc.edition ? "exact" : null;
  }
  if (!cand.code && !doc.code) {
    if (cand.edition !== doc.edition) return null;
    // 部号不同（第1部分 vs 第2部分）不是同一份文件
    if (cand.part !== doc.part) return null;
    return coresMatch(cand.core, doc.core);
  }
  return null; // 一方有标准号、一方没有：不按标题判重合
}

/**
 * 对候选文件列表做导入前查重。
 * @param root kbRoot 绝对路径
 * @param targetKb 目标知识库名（与清单 name 比对）
 * @param files [{ sourcePath, relKey, title, docId? }]
 * @param allowCrossKb true 时跨库重合文件照常导入（同库重合始终跳过）
 * @returns { kept, duplicates, similar }
 *   duplicates: 高置信重合（标准号/年份/版本桶一致，或标题规范化后完全相同），按规则跳过；
 *   similar:    仅标题前缀相似的低置信匹配，照常导入并在结果中提示人工确认。
 *   每项 { title, sourcePath, scope, matched:[{kb,title,id}] }
 */
export async function scanDuplicates({ root, targetKb, files, allowCrossKb = false }) {
  // 预加载所有知识库的清单与文档关键信息（一次遍历，避免逐文件重复读盘）
  const catalogs = [];
  for (const k of await listKbs(root)) {
    const dir = kbDirPath(root, k.dir ?? k.name);
    const manifest = await tryReadManifest(dir);
    if (!manifest) continue;
    catalogs.push({
      name: manifest.name || k.name,
      docs: (manifest.docs ?? [])
        .filter((d) => d && (!d.status || d.status === "ready"))
        .map((d) => ({ id: d.id, title: String(d.title ?? ""), keys: titleKeys(d.title) })),
    });
  }
  const kept = [];
  const duplicates = [];
  const similar = [];
  const toMatched = (list) => list.map(({ kb, title, id }) => ({ kb, title, id }));

  for (const f of files) {
    const cand = titleKeys(f.title ?? "");
    const docId = f.docId ?? (f.relKey ? docIdFor(f.relKey) : null);
    const exact = [];
    const near = [];
    for (const cat of catalogs) {
      const isTarget = cat.name === targetKb;
      for (const doc of cat.docs) {
        if (docId && doc.id === docId) continue; // 同名文件：原位更新，不视为重合
        const kind = keysMatch(cand, doc.keys);
        if (kind === null) continue;
        const hit = { kb: cat.name, title: doc.title, id: doc.id, sameKb: isTarget };
        if (kind === "exact") exact.push(hit);
        else near.push(hit);
      }
    }

    // 只有低置信的标题前缀相似：照常导入，但把候选列出来让用户确认
    if (exact.length === 0) {
      if (near.length > 0) {
        const scope = near.some((m) => m.sameKb) ? "same-kb" : "cross-kb";
        similar.push({
          title: f.title,
          sourcePath: f.sourcePath,
          scope,
          matched: toMatched(near.slice(0, 5)),
        });
      }
      kept.push(f);
      continue;
    }

    const hasSameKb = exact.some((m) => m.sameKb);
    const scope = hasSameKb ? "same-kb" : "cross-kb";
    if (scope === "cross-kb" && allowCrossKb === true) {
      kept.push(f);
      continue;
    }
    duplicates.push({
      title: f.title,
      sourcePath: f.sourcePath,
      scope,
      matched: toMatched(exact.slice(0, 5)),
    });
  }
  return { kept, duplicates, similar };
}
