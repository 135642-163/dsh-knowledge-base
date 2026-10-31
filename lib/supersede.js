/**
 * 版本收敛（离线规则，不联网）：同一标准号下若库里存在更新的年份，
 * 则最新年份那版最可能是现行版，更老的年份按「已被替代」处理。
 *
 * 依据：用户口径（2026-10-31）——同编号、同名称的标准，最新年份才最可能是现行，
 * 更老的一定已被替代。这条规则只依赖知识库自身，可作为站点「废止」标记的补充/兜底：
 * 站点没写被谁代替时，库里若有同号新版，旧版同样可以判定为废止。
 *
 * 约束：
 *  - 只把「正文类」文档当作版本候选（草案/编制说明/说明材料不参与——草案不能证明正式版失效）；
 *  - 名称必须相似（默认 Dice ≥ 0.8），避免同号不同名的资料被误判；
 *  - 分册号属于编号的一部分（4728.6 与 4728.7 是两条线），不互相收敛。
 */
import { classifyDocKind, extractStdRef, familyOf, normNum, successorsOf } from "./standards.js";

export { successorsOf };

const PUNCT = /[\s\u3000，。、；：（）()《》<>〈〉【】·—–\-＿_/,.:：]+/g;
const NOISE = /(征求意见稿|报批稿|送审稿|讨论稿|草案|编制说明|说明材料|发布稿|批准稿|Redline版|勘误版|非正式版|扫描件|无水印无加密|含印发通知|OCR)/gi;

/** 名称归一：去掉开头标准号、阶段/噪声词、部分前缀与标点，只留可比对的名称骨架。 */
export function nameKey(title) {
  let t = String(title ?? "");
  t = t.replace(/^\s*[A-Za-z]+\s*[\/／]?\s*[A-Za-z]*\s*[\d.]+(?:[-—－]\d{4})?\s*/, "");
  t = t.replace(/第\s*[0-9一二三四五六七八九十]+\s*部分\s*[:：]?/g, "");
  t = t.replace(NOISE, "");
  t = t.replace(PUNCT, "");
  return t.toLowerCase();
}

/** 字符二元组 Dice 相似度（0–1）。 */
export function nameSimilarity(a, b) {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let common = 0;
  let total = 0;
  for (const [g, c] of gx) {
    total += c;
    const d = gy.get(g);
    if (d) common += Math.min(c, d);
  }
  for (const c of gy.values()) total += c;
  return total === 0 ? 0 : (2 * common) / total;
}

/** 文档的标准号要素：优先规范字段，退回标题解析。 */
function refOf(doc) {
  if (doc.standardNo) {
    const parsed = extractStdRef(doc.standardNo);
    const year = Number.isFinite(doc.standardYear)
      ? doc.standardYear
      : parsed?.year ?? null;
    return { prefix: doc.standardPrefix || parsed?.prefix || "", number: doc.standardNumber || parsed?.number || "", year };
  }
  const r = extractStdRef(doc.title ?? "");
  return r ? { prefix: r.prefix, number: r.compareNumber, year: r.year ?? null } : null;
}

/**
 * 找出「库内已有同号更新版本」的旧版文档。
 * @param manifest 知识库清单（docs 数组）
 * @param opts { minSimilarity?: number, includeMarks?: boolean }
 * @returns {{groups: Array<{key:string, prefix:string, number:string, keep:object[], olds:object[]}>, docs: number}}
 */
export function collectLibrarySuperseded(manifest, { minSimilarity = 0.8 } = {}) {
  const docs = (manifest?.docs ?? []).filter((d) => !d.deletedAt);
  const buckets = new Map();
  for (const doc of docs) {
    const ref = refOf(doc);
    if (!ref || !ref.number || ref.year == null) continue;
    const kind = classifyDocKind({ stage: doc.stage, title: doc.title, stageLabel: doc.stageLabel });
    if (kind !== "text") continue; // 草案/编制说明不代表正式版本
    const key = `${familyOf(ref.prefix)}:${normNum(ref.number)}`;
    if (!buckets.has(key)) buckets.set(key, { key, prefix: ref.prefix, number: ref.number, rows: [] });
    buckets.get(key).rows.push({ doc, year: Number(ref.year) });
  }

  const groups = [];
  for (const bucket of buckets.values()) {
    const byYear = new Map();
    for (const row of bucket.rows) {
      if (!byYear.has(row.year)) byYear.set(row.year, []);
      byYear.get(row.year).push(row);
    }
    if (byYear.size < 2) continue;
    const years = [...byYear.keys()].sort((a, b) => b - a);
    const newest = years[0];
    const keep = byYear.get(newest);
    const olds = [];
    for (const year of years.slice(1)) {
      for (const row of byYear.get(year)) {
        const similar = keep.some((k) => nameSimilarity(k.doc.title, row.doc.title) >= minSimilarity);
        if (!similar) continue;
        olds.push({ docId: row.doc.id, year, title: row.doc.title, standardNo: row.doc.standardNo ?? "" });
      }
    }
    if (olds.length === 0) continue;
    groups.push({
      key: bucket.key,
      prefix: bucket.prefix,
      number: bucket.number,
      keep: keep.map((k) => ({ docId: k.doc.id, year: k.year, title: k.doc.title, standardNo: k.doc.standardNo ?? "" })),
      olds,
    });
  }
  groups.sort((a, b) => b.olds.length - a.olds.length || a.key.localeCompare(b.key));
  return { groups, docs: groups.reduce((n, g) => n + g.olds.length, 0) };
}

/** 给旧版文档生成 trust 理由（与站点口径区分，便于以后复核）。 */
export function librarySupersedeReason(group) {
  const keep = group.keep
    .map((k) => k.standardNo || `${group.prefix} ${group.number}-${k.year}`)
    .join("、");
  return `库内已有同号更新版本 ${keep}（按“最新年份为现行版”判定旧版已废止）`;
}

/** 解析标准号 → { key, year }；key 用「体系+主编号」，/T /Z 后缀归一。 */

export function parseStdNo(stdNo) {
  const m = String(stdNo ?? "").replace(/[∕／]/g, "/").match(/^([A-Za-z/]+)\s*([\d.]+)(?:[-—－](\d{4}))?/);
  if (!m) return null;
  return { key: `${m[1].toUpperCase().replace(/\/T$|\/Z$/, "")}${m[2]}`, year: m[3] ? Number(m[3]) : null };
}

/** 库里是否已有该标准号的正文（同编号、年份不低于给定版本）。 */
export function libraryHolds(manifest, stdNo) {
  const want = parseStdNo(stdNo);
  if (!want) return false;
  return (manifest?.docs ?? []).some((doc) => {
    if (doc.deletedAt) return false;
    const got = parseStdNo(doc.standardNo || "");
    if (!got || got.key !== want.key) return false;
    return want.year == null || (got.year ?? 0) >= want.year;
  });
}

/** 标准号匹配（封面「代替」声明里的写法：GB/T 20000.2—2009、GB/Z 19963-2005）。 */
const DECL_STD = /([A-Z]{2,}(?:\s*\/\s*[A-Z]{1,3})?)\s*(\d+(?:\.\d+)*)\s*(?:[-—–－]|\s)\s*((?:19|20)\d{2})/g;

/**
 * 从文本里的「代替 …」声明中取出被替代的标准号。
 * 只认「代替 <编号>」这一方向；「被 <编号> 代替」是反方向，不在这里处理。
 * 返回去重后的标准号字符串（如 "GB/T 20000.2-2009"）。
 */
export function replacementTargets(text) {
  const out = [];
  const src = String(text ?? "");
  // 逐条「代替 …」声明：截到句末/换行，若遇到「被」则只取「被」之前的替代对象
  for (const m of src.matchAll(/代替\s*([^；。\n]*)/g)) {
    let chunk = m[1] ?? "";
    const bei = chunk.indexOf("被");
    if (bei >= 0) chunk = chunk.slice(0, bei);
    for (const hit of chunk.matchAll(DECL_STD)) {
      const prefix = hit[1].replace(/\s+/g, "").toUpperCase();
      const number = hit[2];
      const year = Number(hit[3]);
      const stdNo = `${prefix} ${number}-${year}`;
      if (!out.includes(stdNo)) out.push(stdNo);
    }
  }
  return out;
}

/** 在清单里找标准号完全对应的文档（同编号同体系；年份一致优先）。 */
function findDocByStdNo(docs, stdNo) {
  const want = parseStdNo(stdNo);
  if (!want) return null;
  const candidates = docs.filter((d) => {
    if (d.deletedAt) return false;
    const got = parseStdNo(d.standardNo || "");
    return got && got.key === want.key;
  });
  if (candidates.length === 0) return null;
  const exact = candidates.find((d) => parseStdNo(d.standardNo || "")?.year === want.year);
  return exact ?? null;
}

/**
 * 用「封面/前言声明代替」建立代替关系：库内某标准声明代替 X，且库里也有 X → X 判定为废止。
 * 这条比年份更可靠：能表达跨编号替代（如 GB/T 22386-2008 被 GB/T 14598.24-2017 代替）。
 * @param {{ manifest: object, texts: Map<string,string> }} input texts: docId → 封面/前言文本
 */
export function collectCoverSuperseded({ manifest, texts } = {}) {
  const live = (manifest?.docs ?? []).filter((d) => !d.deletedAt);
  const found = new Map(); // oldDocId → { old, replacing:Set }
  for (const doc of live) {
    const text = texts?.get?.(doc.id) ?? "";
    if (!text) continue;
    // 只有正文类文档的「代替」声明才作数：草案/编制说明里写“代替 X”不能证明 X 已废止；
    // 更要求声明方本身是有标准号的正式标准（笔记/记录里出现“代替”字样不算）
    if (!doc.standardNo) continue;
    if (String(doc.type ?? "") === "note") continue;
    if (classifyDocKind({ stage: doc.stage, title: doc.title, stageLabel: doc.stageLabel }) !== "text") continue;
    for (const target of replacementTargets(text)) {
      const old = findDocByStdNo(live, target);
      if (!old || old.id === doc.id) continue;
      if (parseStdNo(old.standardNo || "")?.key !== parseStdNo(doc.standardNo || "")?.key) {
        // 跨编号替代是合法的（14598.24 代替 22386），只要求 old 不是自身后代
      }
      if (!found.has(old.id)) found.set(old.id, { old, replacing: new Set() });
      found.get(old.id).replacing.add(doc.id);
    }
  }
  const groups = [...found.values()].map(({ old, replacing }) => ({
    key: `${old.standardNo || old.id}`,
    olds: [{ docId: old.id, title: old.title, standardNo: old.standardNo ?? "", year: parseStdNo(old.standardNo || "")?.year ?? null }],
    keep: [...replacing].map((id) => {
      const d = live.find((x) => x.id === id);
      return { docId: id, title: d?.title ?? "", standardNo: d?.standardNo ?? "", year: parseStdNo(d?.standardNo ?? "")?.year ?? null };
    }),
  }));
  return { groups, docs: groups.length };
}

/** 封面代替关系的 trust 理由。 */
export function coverSupersedeReason(group) {
  const by = group.keep.map((k) => k.standardNo || k.title).filter(Boolean).join("、");
  const old = group.olds.map((o) => o.standardNo || o.title).join("、");
  return `封面声明代替 ${old}（${by} 的封面/前言）`;
}
