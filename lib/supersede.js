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
import { classifyDocKind, extractStdRef, familyOf, normNum } from "./standards.js";

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

/** 从站点「代替标准」字段里拆出「被 … 代替」的继任编号。 */
export function successorsOf(field) {
  const m = String(field ?? "").match(/被([^；。]+?)代替/);
  if (!m) return [];
  return m[1].split(/[;；,，、]/).map((s) => s.trim()).filter(Boolean);
}
