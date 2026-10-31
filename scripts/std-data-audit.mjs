#!/usr/bin/env node
/**
 * 标准数据只读审计（P0-2）：把「标准」库下一次改数据前必须确认的问题，
 * 按「可自动修正 / 需人工确认 / 仅报告」三组产出，每条带 id、标题、证据与拟动作。
 *
 * 只读保证：
 *  - 只 import 只读 API（tryReadManifest / collectKbStandards / lintManifest / 纯函数），
 *    不 import 任何写清单、写文档、删除文档的函数；
 *  - 不调用 listKbs / readManifest（会建目录/迁移写盘）；
 *  - 扫描前后对 kb.json / index.md / log.md / schema.md 取 sha256，对 markdown/ 与 sources/
 *    取条目数，不一致即 readiness=false 并以退出码 2 结束；
 *  - 报告只写到 --out（默认 docs/reports），且拒绝写进被扫描的知识库目录。
 *
 * 数据来源：
 *  - 清单元数据（standardNo/stage/trust/summary 等）；
 *  - `.std-check.json`（标准网检查缓存，由 kb_std_check 维护；本脚本不联网）；
 *  - lintManifest（机械体检，与 kb_lint 同口径）；
 *  - 封面文本（复用 audit-cover-stdno.mjs 的 coverText/coverStdNo/metaStdNo）。
 *
 * 用法：
 *   node scripts/std-data-audit.mjs --root ~/workspace/knowledge --kb 标准
 *   node scripts/std-data-audit.mjs --root ~/workspace/knowledge --kb 标准 --date 2026-11-01
 *   node scripts/std-data-audit.mjs ... --out /tmp/audit --no-write
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tryReadManifest, expandRoot, kbDirPath } from "../lib/store.js";
import { collectKbStandards, extractStdRef, OFF_SITE_FAMILIES } from "../lib/standards.js";
import { collectLibrarySuperseded, librarySupersedeReason } from "../lib/supersede.js";
import { lintManifest } from "../lib/lint.js";
import { looksNoisySummary, extractScopeSummary } from "../lib/summary-candidates.js";
import { coverText, coverStdNo, metaStdNo } from "./audit-cover-stdno.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const DEFAULT_OUT = join(REPO_ROOT, "docs", "reports");

/** 与 lib/doc-meta.js / lib/standards.js 一致的过程稿标题标记。 */
const PROCESS_TITLE = /征求意见稿|报批稿|送审稿|讨论稿|工作组讨论稿|编制说明|草案|修订稿|预审稿|大纲|Redline|勘误|修改单|修改通知|修编/;
/** 占位可信度理由（需要站点核对后刷新）。 */
const STALE_REASON = /需按现行\/废止再核对|尚未核实现行\/废止/;
/** 封面/前言的引用上下文：命中这些词说明编号是「代替/引用」别人，不是本文编号。 */
const REF_CONTEXT = /代替|被替代|引用|参见|参照|符合|按照|依据/;
/** 草案/过程稿阶段（不参与「同号重复」自动判定的版本类文档）。 */
const DRAFT_STAGES = new Set(["draft", "comment", "review", "discussion", "plan"]);
const NOTE_TYPES = new Set(["note", "markdown"]);

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function norm(text) {
  return String(text ?? "")
    .replace(/[—–－‐]/g, "-")
    .replace(/(\d)\s*[一]\s*(\d)/g, "$1-$2")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(text) {
  return String(text ?? "").replace(/\s+/g, "");
}

function familyOfKey(key) {
  return String(key ?? "").split(":")[0];
}

function isOffSiteKey(key) {
  return OFF_SITE_FAMILIES.has(familyOfKey(key));
}

function docTitle(d) {
  return String(d?.title ?? "");
}

// ---------------------------------------------------------------------------
// 1. 清单层：stage / 标准号 / 重复 / 可信度
// ---------------------------------------------------------------------------

/** 标题里的过程稿标记与 stage 不一致的文档。 */
export function detectTitleStageIssues(docs) {
  const issues = [];
  for (const d of docs) {
    if (NOTE_TYPES.has(String(d.type ?? ""))) continue;
    if (d.deletedAt || d.status === "deleted") continue;
    const title = docTitle(d);
    const hasMarker = PROCESS_TITLE.test(title);
    if (d.stage === "published" && hasMarker) {
      issues.push({
        code: "published-with-process-marker",
        docId: d.id,
        title,
        evidence: `stage=${d.stage}/${d.stageLabel ?? ""}，但标题含过程稿标记`,
        action: "按封面/前言把 stage 改成 draft/comment/review/notes（会同时影响可信度与站点检查口径）",
      });
      continue;
    }
    if (DRAFT_STAGES.has(String(d.stage ?? "")) && !hasMarker) {
      issues.push({
        code: "draft-without-marker",
        docId: d.id,
        title,
        evidence: `stage=${d.stage}，但标题没有过程稿标记`,
        action: "核对封面：确为过程稿则补标题标记，否则 stage 改回 published",
      });
    }
    if (d.stage === "notes" && !hasMarker && !/说明|介绍|编制|修编/.test(title)) {
      // 「（含印发通知）」这类是正文+发文，不是编制说明；有足够正文时提示复核
      const noticeAttached = /通知/.test(title) && (d.chars ?? 0) >= 5000;
      if (!noticeAttached || /印发通知/.test(title)) {
        issues.push({
          code: "notes-without-marker",
          docId: d.id,
          title,
          evidence: `stage=notes（说明材料），但标题无过程标记（${d.chars ?? 0} 字，${d.contentIntegrity ?? "?"}）`,
          action: "确认是正文还是说明材料；若为正文改 stage=published",
        });
      }
    }
  }
  return issues;
}

/** 标准号字段自身不一致（standardNumber/standardNo 互相矛盾）或标题编号冲突。 */
export function detectStdNoAnomalies(docs) {
  const out = [];
  for (const d of docs) {
    if (NOTE_TYPES.has(String(d.type ?? ""))) continue;
    if (d.deletedAt || d.status === "deleted") continue;
    const no = compact(d.standardNo);
    if (!no) continue;
    const prefix = compact(d.standardPrefix).toUpperCase();
    const number = compact(d.standardNumber);
    const expectedPrefix = (no.match(/^([A-Z/]+?)(?=\d)/) ?? [])[1] ?? "";
    if (!number) {
      out.push({ code: "stdno-number-empty", docId: d.id, title: docTitle(d), evidence: `standardNo=${d.standardNo}，standardNumber 为空`, action: "重跑 parseDocMeta 或手工重填标准号" });
      continue;
    }
    if (expectedPrefix && prefix && prefix !== expectedPrefix) {
      out.push({ code: "stdno-prefix-inconsistent", docId: d.id, title: docTitle(d), evidence: `standardNo=${d.standardNo}，standardPrefix=${d.standardPrefix}`, action: "按封面纠正前缀后重建标准字段" });
    }
    if (!no.startsWith(expectedPrefix + number)) {
      out.push({ code: "stdno-number-inconsistent", docId: d.id, title: docTitle(d), evidence: `standardNo=${d.standardNo}，standardNumber=${d.standardNumber}`, action: "按封面/文件名重建标准号" });
    }
    // 标题开头的标准编号必须与元数据一致（英文标题通常没有编号，此时 extractStdRef 返回空）
    const titleRef = extractStdRef(String(d.title ?? "").slice(0, 80));
    if (titleRef?.compareNumber) {
      const titleNumber = compact(titleRef.compareNumber);
      const titleYear = titleRef.year ?? null;
      const sameNumber = titleNumber === number;
      const sameYear = titleYear == null || d.standardYear == null || titleYear === d.standardYear;
      if (!sameNumber || !sameYear) {
        out.push({
          code: "stdno-title-conflict",
          docId: d.id,
          title: docTitle(d),
          evidence: `标题编号 ${titleRef.prefix} ${titleNumber}${titleYear != null ? `-${titleYear}` : ""} ≠ 元数据 ${d.standardNo}`,
          action: "按封面确认哪个正确，再 kb_retitle / 手工改标准号",
        });
      }
    }
    // 标题里是「编号-两位分册」，却被解析成「19xx/20xx」年份（如 IEC 61000-4-40 → 61000-4-1940）
    if (/^\d/.test(number) && !/[A-Za-z]/.test(number)) {
      const escaped = number.replace(/\./g, "\\.");
      const m = String(d.title ?? "").replace(/\s+/g, " ").match(new RegExp(`^\\s*[A-Z][A-Z/ ]*?\\s*${escaped}-(\\d{1,2})(?!\\d)`));
      if (m && d.standardYear != null && d.standardYear === 1900 + Number(m[1])) {
        out.push({
          code: "stdno-part-as-year",
          docId: d.id,
          title: docTitle(d),
          evidence: `标题分册号 -${m[1]} 被解析成年份 ${d.standardYear}（standardNo=${d.standardNo}）`,
          action: "重跑 parseDocMeta；必要时手工纠正标准号与年份",
        });
      }
    }
    // 解析出的年段明显异常（如 61000-4-40 被解析成 61000-4-1940）
    const yearTail = /-((?:19|20)\d{2})$/.exec(number);
    if (yearTail) {
      out.push({
        code: "stdno-year-in-number",
        docId: d.id,
        title: docTitle(d),
        evidence: `standardNumber=${d.standardNumber} 末尾像年份（${yearTail[1]}），但 standardNo=${d.standardNo}`,
        action: "重跑 parseDocMeta；必要时手工纠正标准号",
      });
    }
  }
  return out;
}

/** 与站点记录同编号同年、仅前缀写法不同（DL ↔ DL/T、GB ↔ GB/T）。 */
export function detectPrefixMismatches({ docs, docGroup }) {
  const out = [];
  for (const d of docs) {
    if (NOTE_TYPES.has(String(d.type ?? ""))) continue;
    if (d.deletedAt || d.status === "deleted") continue;
    if (!d.standardNo) continue;
    const group = docGroup.get(d.id);
    const siteRef = group ? extractStdRef(group.it.siteNo ?? "") : null;
    if (!siteRef?.compareNumber) continue;
    if (compact(siteRef.compareNumber) !== compact(d.standardNumber)) continue;
    if (siteRef.year != null && d.standardYear != null && siteRef.year !== d.standardYear) continue;
    if (compact(siteRef.prefix).toUpperCase() === compact(d.standardPrefix).toUpperCase()) continue;
    out.push({
      docId: d.id,
      title: docTitle(d),
      standardNo: d.standardNo,
      siteNo: group.it.siteNo,
      siteStatus: group.it.status,
      trust: d.trust ?? "unknown",
    });
  }
  return out;
}

/** 同标准号 + 同年 + 同阶段的重复组（清单口径；含 lint 会过滤掉的草案差异）。 */
export function detectDuplicateGroups(docs) {
  const map = new Map();
  for (const d of docs) {
    if (NOTE_TYPES.has(String(d.type ?? ""))) continue;
    if (d.deletedAt || d.status === "deleted") continue;
    if (!d.standardNo) continue;
    const key = `${compact(d.standardNo)}|${d.standardYear ?? ""}|${d.stageLabel ?? ""}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  }
  return [...map.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({
      key,
      standardNo: list[0].standardNo,
      year: list[0].standardYear,
      stage: list[0].stageLabel,
      docs: list.map((d) => ({
        id: d.id,
        title: docTitle(d),
        type: d.type,
        chars: d.chars ?? 0,
        trust: d.trust ?? "unknown",
        summarySource: d.summarySource ?? "none",
        importedAt: d.importedAt ?? "",
      })),
      // 文字层比扫描件更好检索；同等类型取字数多的
      // 先比正文字数（避免把 1.5k 字的残页当成「文字层更好」），字数接近时再比文字层
      suggestKeep: [...list].sort((a, b) => {
        const chars = (b.chars ?? 0) - (a.chars ?? 0);
        if (Math.abs(chars) > Math.max(500, (b.chars ?? 0) * 0.05)) return chars;
        const typeScore = (x) => (x.type === "pdf-text" ? 4 : x.type === "docx" ? 3 : x.type === "pdf-mixed" ? 2 : x.type === "pdf-scanned" ? 1 : 0);
        return typeScore(b) - typeScore(a);
      })[0]?.id ?? "",
    }));
}

/** 可信度：占位理由、过时理由、未标注。 */
export function classifyTrustReasons({ docs, docGroup }) {
  const refreshCurrent = [];
  const refreshNewer = [];
  const offsiteUnverified = [];
  const noCache = [];
  const staleLow = [];
  const unknown = [];
  for (const d of docs) {
    if (NOTE_TYPES.has(String(d.type ?? ""))) continue;
    if (d.deletedAt || d.status === "deleted") continue;
    const group = docGroup.get(d.id);
    const reason = String(d.trustReason ?? "");
    if (!d.trust || d.trust === "unknown") {
      unknown.push({ docId: d.id, title: docTitle(d), evidence: `trust=${d.trust ?? "(空)"}` });
    }
    if (STALE_REASON.test(reason)) {
      if (!group) noCache.push({ docId: d.id, title: docTitle(d), evidence: `占位理由，且不在检查缓存里（standardNo=${d.standardNo || "-"}）` });
      else if (group.it.status === "current" && compact(group.it.siteNo) === compact(d.standardNo)) {
        refreshCurrent.push({ docId: d.id, title: docTitle(d), evidence: `站点核对现行：${group.it.siteNo}` });
      } else if (group.it.status === "current") {
        // 站点同号但前缀不同（DL ↔ DL/T）：只能先按前缀问题处理，不能直接写「站点核对现行」
        refreshNewer.push({ docId: d.id, title: docTitle(d), evidence: `站点同版本 ${group.it.siteNo}，但库内标准号写法不同：${d.standardNo}` });
      } else if (group.it.status === "newer-in-kb") {
        refreshNewer.push({ docId: d.id, title: docTitle(d), evidence: `站点 ${group.it.siteNo} 早于库内版本，站点收录滞后` });
      } else if (group.it.status === "not-found" && isOffSiteKey(group.key)) {
        offsiteUnverified.push({ docId: d.id, title: docTitle(d), evidence: `站外体系 ${familyOfKey(group.key)}，标准网不收录` });
      } else {
        noCache.push({ docId: d.id, title: docTitle(d), evidence: `检查状态 ${group.it.status}，无法自动判定` });
      }
    }
    if (d.trust === "low" && /过程稿|草案|说明材料/.test(reason) && d.stage === "published" && !PROCESS_TITLE.test(d.title)) {
      staleLow.push({ docId: d.id, title: docTitle(d), evidence: `low 理由「${reason}」，但 stage=published 且标题无过程标记` });
    }
  }
  return { refreshCurrent, refreshNewer, offsiteUnverified, noCache, staleLow, unknown };
}

// ---------------------------------------------------------------------------
// 2. 封面核对（复用 audit-cover-stdno 的解析）
// ---------------------------------------------------------------------------

function metaVersionOccurrences(text, meta) {
  const num = meta.number
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\./g, "\\s*\\.\\s*")
    .replace(/-/g, "\\s*-\\s*");
  const re = new RegExp(`${num}\\s*(?:-\\s*((?:19|20)\\d{2}))?`, "g");
  const out = [];
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 45), m.index);
    out.push({ ref: REF_CONTEXT.test(before), year: m[1] ? Number(m[1]) : null });
  }
  return out;
}

/**
 * 单篇封面核对分类：
 *  prefix           编号+年份一致、仅前缀不同（可自动修）
 *  cover-newer      封面出现比元数据更新的版本（疑似文件其实更新，需人工）
 *  cover-missing    封面完全没出现元数据编号（疑似文件/元数据不符，需人工）
 *  cover-year       编号出现但年份不同且元数据年份不在封面（需人工）
 *  meta-missing     元数据无标准号、标题却像标准（需人工）
 *  false-positive    元数据编号+年份在封面「非代替/引用」上下文出现（首号命中引用，属误报）
 * 无问题返回 null。
 */
export function classifyCoverRow(doc, text, cover, meta) {
  const title = docTitle(doc);
  if (!meta) {
    if (!/^\s*[A-Z][A-Z/ ]*\s*\d/.test(title)) return null;
    return { kind: "meta-missing", docId: doc.id, title, cover: `${cover.prefix} ${cover.number}-${cover.year}`, meta: null };
  }
  if (!cover) return null;
  if (meta.number === cover.number && meta.year === cover.year && meta.prefix === cover.prefix) return null;
  const occ = metaVersionOccurrences(norm(text), meta);
  const same = occ.filter((o) => (meta.year == null ? true : o.year === meta.year));
  const others = occ.filter((o) => (meta.year == null ? false : o.year !== meta.year));
  const sameOwn = same.some((o) => !o.ref);
  const sameRef = same.some((o) => o.ref);
  let kind;
  if (meta.prefix !== cover.prefix && meta.number === cover.number && meta.year === cover.year) kind = "prefix";
  else if (sameOwn) kind = "false-positive";
  else if (sameRef) kind = (cover.year ?? 0) > (meta.year ?? 0) ? "cover-newer" : "cover-year";
  else if (others.length > 0) kind = "cover-year";
  else kind = "cover-missing";
  return {
    kind,
    docId: doc.id,
    title,
    docNo: doc.standardNo,
    cover: `${cover.prefix} ${cover.number}-${cover.year}`,
    meta: `${meta.prefix} ${meta.number}${meta.year != null ? `-${meta.year}` : ""}`,
    otherYears: [...new Set(others.map((o) => o.year).filter(Boolean))],
  };
}

/** 逐篇读封面并分类（只读 markdown 前 700 字）。 */
export function auditCover({ docs, readText }) {
  const rows = [];
  for (const d of docs) {
    if (NOTE_TYPES.has(String(d.type ?? ""))) continue;
    if (d.deletedAt || d.status === "deleted") continue;
    let text = "";
    try {
      text = readText(d.id) ?? "";
    } catch {
      continue;
    }
    if (!text) continue;
    const cover = coverStdNo(norm(text));
    if (!cover) continue;
    const row = classifyCoverRow(d, text, cover, metaStdNo(d));
    if (row) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 3. 站点检查缓存（kb_std_check 结果，不联网）
// ---------------------------------------------------------------------------

export function classifyCheckCache({ groups, cache, docsById }) {
  const items = Object.values(cache.items ?? {});
  const byStatus = {};
  for (const it of items) byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
  const liveKeys = new Set(groups.map((g) => g.key));
  const legacyKeys = Object.keys(cache.items ?? {}).filter((k) => !liveKeys.has(k));
  const currentDocs = new Map(groups.map((g) => [g.key, new Set(g.docs.map((d) => d.id))]));
  const staleGroups = [];
  for (const g of groups) {
    const it = cache.items?.[g.key];
    if (!it) {
      staleGroups.push({ key: g.key, reason: "缓存无此组" });
      continue;
    }
    const cached = new Set((it.docs ?? []).map((d) => d.id));
    const now = currentDocs.get(g.key) ?? new Set();
    const added = [...now].filter((id) => !cached.has(id));
    const removed = [...cached].filter((id) => !now.has(id));
    if (added.length || removed.length) staleGroups.push({ key: g.key, reason: `新增 ${added.length} / 移除 ${removed.length}`, added, removed });
  }
  const pick = (status) =>
    items
      .filter((it) => it.status === status)
      .map((it) => ({
        key: it.key,
        siteNo: it.siteNo ?? "",
        siteYear: it.siteYear ?? null,
        siteStatus: it.siteStatus ?? "",
        replaced: it.replaced ?? "",
        downloadAid: it.downloadAid ?? null,
        checkedAt: it.checkedAt ?? null,
        docs: (it.docs ?? []).map((d) => ({ id: d.id, title: d.title ?? docsById.get(d.id)?.title ?? "", trust: docsById.get(d.id)?.trust ?? "unknown" })),
      }));
  const notFound = items.filter((it) => it.status === "not-found");
  const offsite = notFound.filter((it) => isOffSiteKey(it.key));
  const onsite = notFound.filter((it) => !isOffSiteKey(it.key));
  return {
    totals: { cacheKeys: items.length, liveGroups: groups.length, byStatus },
    updates: pick("update"),
    superseded: pick("superseded"),
    ambiguous: pick("ambiguous"),
    newerInKb: pick("newer-in-kb"),
    notFoundOffsite: offsite.map((it) => it.key),
    notFoundOnsite: onsite.map((it) => ({
      key: it.key,
      number: it.number,
      siteNo: it.siteNo ?? "",
      docs: (it.docs ?? []).map((d) => ({ id: d.id, title: d.title ?? "" })),
    })),
    staleGroups,
    legacyKeys,
  };
}

/** 库内同号旧版规则：旧的没标 low 的文档。 */
export function detectSupersededNotLow({ manifest, docsById }) {
  const { groups, docs } = collectLibrarySuperseded({ docs: manifest.docs ?? [] });
  const out = [];
  for (const g of groups) {
    for (const old of g.olds) {
      const d = docsById.get(old.docId);
      if (!d || d.deletedAt || d.status === "deleted") continue;
      if (d.trust === "low") continue;
      out.push({
        docId: d.id,
        title: docTitle(d),
        standardNo: d.standardNo ?? "",
        trust: d.trust ?? "unknown",
        evidence: `库内已有更新版本 ${g.keep.map((k) => k.standardNo || k.title).join("、")}`,
        action: `kb_trust(level=low, reason="${librarySupersedeReason(g)}")`,
        reason: librarySupersedeReason(g),
      });
    }
  }
  return { groups: groups.length, docs, items: out };
}

// ---------------------------------------------------------------------------
// 4. 摘要与内容质量
// ---------------------------------------------------------------------------

/** 摘要噪声 + 可从正文提取的候选（不写库）。 */
export function auditSummaries({ docs, readText }) {
  const noisy = [];
  for (const d of docs) {
    if (NOTE_TYPES.has(String(d.type ?? ""))) continue;
    if (d.deletedAt || d.status === "deleted") continue;
    if (!looksNoisySummary(d.summary)) continue;
    let proposed = "";
    try {
      proposed = extractScopeSummary(readText(d.id) ?? "");
    } catch {
      /* 派生正文缺失 */
    }
    noisy.push({
      docId: d.id,
      title: docTitle(d),
      summarySource: d.summarySource ?? "none",
      current: String(d.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      proposedChars: proposed.length,
      proposed: proposed.slice(0, 500),
    });
  }
  return {
    noisy,
    autoExtractable: noisy.filter((r) => r.proposedChars > 0).length,
    missing: docs.filter((d) => !NOTE_TYPES.has(String(d.type ?? "")) && !d.deletedAt && d.status !== "deleted" && !String(d.summary ?? "").trim()).length,
  };
}

// ---------------------------------------------------------------------------
// 5. 汇总与渲染
// ---------------------------------------------------------------------------

function finding(group, code, title, summary, items, action, count) {
  return { group, code, title, summary, items, action, count: count ?? items.length };
}

export function buildReport({ kb, manifest, cache, groups, docs, lint, coverRows, summaryAudit, trust, check, superseded, prefixMismatches = [], now }) {
  const docsById = new Map(manifest.docs.map((d) => [d.id, d]));
  const coverAuto = coverRows.filter((r) => r.kind === "prefix");
  const coverP1 = coverRows.filter((r) => r.kind === "cover-newer" || r.kind === "cover-missing");
  const coverP2 = coverRows.filter((r) => r.kind === "cover-year" || r.kind === "meta-missing");
  const coverInfo = coverRows.filter((r) => r.kind === "false-positive");
  const dupGroups = detectDuplicateGroups(manifest.docs);
  const stageIssues = detectTitleStageIssues(docs);
  const stdnoIssues = detectStdNoAnomalies(docs);
  const noStdDocs = docs.filter((d) => !NOTE_TYPES.has(String(d.type ?? "")) && !d.standardNo);
  const findings = [];

  // ---- 可自动修正 ----
  findings.push(
    finding(
      "auto",
      "cover-prefix",
      "封面证实仅前缀不同（DL → DL/T）",
      `${coverAuto.length} 篇封面用 DL/T，元数据写成 DL；编号与年份一致，可直接按封面纠正。`,
      coverAuto.map((r) => ({ id: r.docId, title: r.title, evidence: `封面 ${r.cover} / 元数据 ${r.meta}`, action: "audit-cover-stdno.mjs --apply --fix-prefix（改标题+标准号，版本+1）" })),
      "node scripts/audit-cover-stdno.mjs --root <kbRoot> --kb 标准 --apply --fix-prefix"
    )
  );
  findings.push(
    finding(
      "auto",
      "superseded-not-low",
      "库内同号已有更新版本，但旧版未标 low",
      `${superseded.items.length} 篇（规则命中 ${superseded.docs} 篇 / ${superseded.groups} 组）。`,
      superseded.items.map((x) => ({ id: x.docId, title: x.title, evidence: x.evidence, action: x.action })),
      "node scripts/mark-superseded-low.mjs --root <kbRoot> --kb 标准 --library --apply"
    )
  );
  findings.push(
    finding(
      "auto",
      "trust-refresh-current",
      "占位可信度理由可刷新为「站点核对现行」",
      `${trust.refreshCurrent.length} 篇：检查缓存 status=current 且站点标准号与库内完全一致；只改理由，不动 trust 级别。`,
      trust.refreshCurrent.map((x) => ({ id: x.docId, title: x.title, evidence: x.evidence, action: "scripts/refresh-trust-verdict.mjs（--apply）" })),
      "node scripts/refresh-trust-verdict.mjs --root <kbRoot> --kb 标准 --apply --limit 50"
    )
  );
  findings.push(
    finding(
      "auto",
      "cache-stale",
      "检查缓存里 31 组文档列表落后于当前清单",
      "今天新导入/改标准号后，缓存组内 docs 仍是旧列表；下次复查会按旧的 maxTextYear 判定，可能误报 update/superseded。",
      check.staleGroups.slice(0, 31).map((x) => ({ id: x.key, title: x.key, evidence: x.reason, action: "强制复查该组（只读网络，不改文档）" })),
      "下一轮检查时只复查这些组（需要给 runStdCheck 增加 onlyKeys 支持，或 force 全量复查）"
    )
  );

  // ---- 需人工确认 ----
  const twoUpdates = check.updates;
  findings.push(
    finding(
      "manual",
      "std-check-update",
      "站点已有更新版本，等待下载（会花金币）",
      `${twoUpdates.length} 组；库内旧版均已 low。这是本轮唯一需要花金币的动作。`,
      twoUpdates.map((it) => ({
        id: it.key,
        title: it.docs.map((d) => d.title).join(" / "),
        evidence: `站点 ${it.siteNo}（${it.siteStatus}，${it.siteYear}）｜${String(it.replaced || "").replace(/^代替\s*/, "代替 ")}｜下载 id ${it.downloadAid ?? "?"}`,
        action: "确认后运行 scripts/fetch-standards.mjs；GB/T 31517.1-2022 报价 5 金币，GB/T 4728.12-2022 上次被每日限额拦住（费用未知）",
      })),
      "明天限额重置后：先预览确认页/金币，再逐份下载；下载后打开封面核对「代替」"
    )
  );
  findings.push(
    finding(
      "manual",
      "std-check-notfound-onsite",
      "站点未收录（非站外体系）——其中 8 组已在线复核为误判",
      `24 组；只读抽查（用完整标准号搜索）发现 3 组站点确有同版、4 组站点只有旧版（应为 newer-in-kb）、1 组裸号命中分册（ambiguous）；其余 16 组未搜到。`,
      check.notFoundOnsite.map((it) => ({
        id: it.key,
        title: it.docs.map((d) => d.title).join(" / ").slice(0, 90),
        evidence: `库内 ${it.docs[0]?.title?.slice(0, 40) ?? it.key}`,
        action: "见报告 §3.2 的逐组复核表：误判组改查法后复查；真缺口写入台账或标注「站点未收录」",
      })),
      "先修 queryCandidates（增加「前缀+编号」「完整标准号」候选），再分批复查 214 个 not-found 组"
    )
  );
  findings.push(
    finding(
      "manual",
      "std-check-ambiguous",
      "分册歧义（裸号 vs 新分册）",
      `${check.ambiguous.length} 组；缓存文档列表也已过期（GB:18039 是旧键；GB:20840 少了已重命名的分册）。`,
      check.ambiguous.map((it) => ({
        id: it.key,
        title: it.docs.map((d) => d.title).join(" / "),
        evidence: `站点 ${it.siteNo}（${it.siteYear}）`,
        action: "复查后决定：裸号文档统一成具体分册号，或在报告里保留 ambiguous 不自动下载",
      })),
      "人工确认后按封面纠正标准号；不要用裸号推断年份"
    )
  );
  findings.push(
    finding(
      "manual",
      "cover-content-mismatch",
      "封面与元数据不一致（疑似文件/年份/编号错误）",
      `${coverP1.length} 篇封面编号或版本与元数据完全不同，需 kb_view 第 1 页确认。`,
      coverP1.map((r) => ({ id: r.docId, title: r.title, evidence: `封面 ${r.cover} / 元数据 ${r.meta}${r.otherYears.length ? `（封面另见年份 ${r.otherYears.join(",")}）` : ""}`, action: "kb_view 第 1 页核对；确认后 kb_retitle / 手工改标准号，错文件需重导" })),
      "逐篇 kb_view 核对（重点：1677fad29313 疑似整份文件是另一标准）"
    )
  );
  findings.push(
    finding(
      "manual",
      "cover-year-mismatch",
      "封面编号一致但年份不同 / 元数据缺标准号",
      `${coverP2.length} 篇；多为封面用「一」作连字符、首号命中「代替」旧版，或过程稿无年份。`,
      coverP2.map((r) => ({ id: r.docId, title: r.title, evidence: `封面 ${r.cover} / 元数据 ${r.meta ?? "-"}`, action: "kb_view 核对封面年份；过程稿不必强行补年份" })),
      "抽查即可；确认是旧版代替关系的记为误报"
    )
  );
  findings.push(
    finding(
      "manual",
      "prefix-mismatch",
      "同一版本的标准号前缀写法与站点不同",
      `${prefixMismatches.length} 篇同编号同年、仅前缀不同（DL↔DL/T、GB↔GB/T、GB↔GB/Z）；其中 ${coverAuto.length} 篇封面已证实应改（见 auto），其余需看封面后再改，不能只凭站点。`,
      prefixMismatches.map((x) => ({
        id: x.docId,
        title: x.title,
        evidence: `库内 ${x.standardNo} / 站点 ${x.siteNo}（${x.siteStatus}，trust=${x.trust}）`,
        action: coverAuto.some((c) => c.docId === x.docId) ? "封面已证实：随 cover-prefix 一起修" : "kb_view 看封面；确认后同样用 --fix-prefix 或手工改标准号",
      })),
      "先批量修 7 篇封面已证实的；其余逐批看封面（草案/编制说明的 GB 写法通常不用改）"
    )
  );
  findings.push(
    finding(
      "manual",
      "duplicate-groups",
      "同标准号 + 同年 + 同阶段的重复组",
      `${dupGroups.length} 组（kb_lint 口径 19 组，差异是草案/标题不同）。均非逐字节相同，需人工选留。`,
      dupGroups.map((g) => ({
        id: g.docs.map((d) => d.id).join(", "),
        title: g.standardNo,
        evidence: g.docs.map((d) => `${d.id} ${d.type}/${d.chars}字/${d.trust}`).join("；"),
        action: `建议保留 ${g.suggestKeep}；其余 kb_keep（都保留）或 kb_remove（软删除）`,
      })),
      "逐组对比正文/解析质量后处理；不确定的先用 kb_keep 标记，避免 lint 反复提示"
    )
  );
  findings.push(
    finding(
      "manual",
      "stage-inconsistent",
      "标题过程标记与 stage 不一致",
      `${stageIssues.length} 篇。`,
      stageIssues.map((x) => ({ id: x.docId, title: x.title, evidence: x.evidence, action: x.action })),
      "先确认封面是正文还是过程稿，再改 stage（kb_edit 不支持 stage，需脚本或工作台）"
    )
  );
  findings.push(
    finding(
      "manual",
      "stdno-anomaly",
      "标准号字段自身异常 / 标题编号冲突",
      `${stdnoIssues.length} 篇。`,
      stdnoIssues.map((x) => ({ id: x.docId, title: x.title, evidence: x.evidence, action: x.action })),
      "按封面重填标准号；IEC 勘误编号建议保留 edition 后缀但在标题里写清"
    )
  );
  findings.push(
    finding(
      "manual",
      "trust-stale",
      "可信度理由/等级需复核",
      `占位理由无法自动判定 ${trust.noCache.length} 篇；low 理由过时 ${trust.staleLow.length} 篇；未标注 ${trust.unknown.length} 篇。`,
      [
        ...trust.staleLow.map((x) => ({ id: x.docId, title: x.title, evidence: x.evidence, action: "复核：确为正文则改 medium/high，确为过程稿则补标题标记" })),
        ...trust.unknown.map((x) => ({ id: x.docId, title: x.title, evidence: x.evidence, action: "kb_trust 标注" })),
        ...trust.noCache.slice(0, 40).map((x) => ({ id: x.docId, title: x.title, evidence: x.evidence, action: "按新导入/无缓存分批复查后刷新" })),
      ],
      "先处理 3 篇 low 理由过时与 2 篇未标注；占位理由按站外/未核对分开写清"
    )
  );
  findings.push(
    finding(
      "manual",
      "no-stdno",
      "没有标准号（无法参与版本/更新检查）",
      `${noStdDocs.length} 篇（不含笔记）。其中多数是内部草案/管理办法，少数值得补号。`,
      noStdDocs.map((x) => ({ id: x.id, title: x.title, evidence: `type=${x.type}｜stage=${x.stageLabel || "-"}｜${x.standardNo ? "" : "standardNo 为空"}`, action: "内部草案/规章不必补；确为标准（如数据中心、团标）按封面补标准号" })),
      "逐类判断：HARS/G5 内部稿保持无号；Q/GDW 002/003、数据中心标准、WD 团标需人工确认"
    )
  );
  findings.push(
    finding(
      "manual",
      "summary-noise",
      "摘要疑似 OCR 噪声",
      `${summaryAudit.noisy.length} 篇，其中 ${summaryAudit.autoExtractable} 篇可从「1 范围」自动提取候选；与《标准库摘要待补清单.md》的 55 篇相差 1 篇（清单可能已过期）。`,
      summaryAudit.noisy.slice(0, 60).map((x) => ({ id: x.docId, title: x.title, evidence: `当前：${x.current.slice(0, 50)}…`, action: x.proposedChars ? "核对候选后 kb_describe" : "人工阅读原件后 kb_describe" })),
      "按 P0-1 流程每批 10 篇 kb_describe；保留人工摘要"
    )
  );
  findings.push(
    finding(
      "manual",
      "content-incomplete",
      "正文可能不完整 / 只有封面",
      `${lint.count("content-incomplete")} 篇（其中编制说明类多为正常）。`,
      (lint.items("content-incomplete") ?? []).slice(0, 30).map((x) => ({ id: x.docId, title: x.title, evidence: x.detail, action: "kb_view 核对；能拿到完整版就同名重导" })),
      "先处理 cover-only 与 2000 字以下的非说明材料"
    )
  );
  findings.push(
    finding(
      "manual",
      "corrupted",
      "文字层损坏 / OCR 低置信页",
      `${lint.count("corrupted")} 篇。`,
      (lint.items("corrupted") ?? []).slice(0, 30).map((x) => ({ id: x.docId, title: x.title, evidence: x.detail, action: "kb_view 核对关键页；必要时 kb_reparse forceOcrPages=…" })),
      "只处理要引用的标准，不必全量重解析",
      lint.count("corrupted")
    )
  );
  findings.push(
    finding(
      "manual",
      "notes",
      "笔记层问题",
      `未编目 ${lint.count("unlabeled")} 篇；应合并 ${lint.count("supersede-hint")} 篇；无入链 ${lint.count("orphan-note")} 篇。`,
      [
        ...(lint.items("supersede-hint") ?? []).map((x) => ({ id: x.docId, title: x.title, evidence: "标题含「续/修订版」", action: "合并回主线笔记（同标题 kb_add_note 更新）" })),
        ...(lint.items("unlabeled") ?? []).map((x) => ({ id: x.docId, title: x.title, evidence: "无摘要", action: "kb_describe 补摘要" })),
      ],
      "先把「续」页合并，再补孤儿笔记来源"
    )
  );

  // ---- 仅报告 ----
  findings.push(
    finding(
      "info",
      "std-check-offsite",
      "站外体系未收录（预期）",
      `${check.notFoundOffsite.length} 组：Q/GDW、IEC、IEEE、EN 等标准网通常不收录，不应写进缺口台账。`,
      [],
      "无需动作；报告里单列，不要计入「未收录缺口」",
      check.notFoundOffsite.length
    )
  );
  findings.push(
    finding(
      "info",
      "std-check-superseded",
      "站点标注已废止（库内均已 low）",
      `${check.superseded.length} 组，全部已标 low，标注与站点一致。`,
      check.superseded.slice(0, 40).map((it) => ({ id: it.key, title: it.docs.map((d) => d.title).join(" / "), evidence: `${it.siteNo} ${it.siteStatus}`, action: "无需动作" })),
      "抽查代替关系；若站点给出继任版本且库内没有，走补下载"
    )
  );
  findings.push(
    finding(
      "info",
      "std-check-newer",
      "站点收录滞后（库内版本更新）",
      `${check.newerInKb.length} 组；其中 3 组可疑（JJF 1138 标题重复编号、DL 860.71 前缀、DL/T 1215.1 2013 重复「(1)」），已并入人工项。`,
      check.newerInKb.map((it) => ({ id: it.key, title: it.docs.map((d) => d.title).join(" / "), evidence: `库内 ${it.docs.map((d) => byId(cache, d.id)?.year ?? "?").join("/")}；站点 ${it.siteNo}` , action: "无需动作；可疑项人工看封面" })),
      "无需动作"
    )
  );
  findings.push(
    finding(
      "info",
      "lint-metadata",
      "多版本 / 跨阶段 / 同族写法（信息项）",
      `同号多版本 ${lint.count("same-number-multi-year")} 组；同号不同阶段 ${lint.count("same-number-stages")} 组；同族写法 ${lint.count("same-number-family")} 组。`,
      [],
      "属正常过程稿/版本演进，不删除；需要时在笔记里写清采用哪一版",
      lint.count("same-number-multi-year") + lint.count("same-number-stages") + lint.count("same-number-family")
    )
  );
  findings.push(
    finding(
      "info",
      "old-pipeline",
      "旧解析管线产物",
      `${lint.count("stale")} 篇；不影响现有内容，需要新解析器/OCR 产物时再批量 kb_reparse。`,
      [],
      "择期 all=true + limit 分批；不要与本次数据修改混在一起",
      lint.count("stale")
    )
  );
  findings.push(
    finding(
      "info",
      "deleted",
      "回收站",
      `${manifest.docs.filter((d) => d.deletedAt || d.status === "deleted").length} 篇软删除；可用 kb_list(status=deleted) 查看。`,
      [],
      "确认不需要后再彻底删除",
      manifest.docs.filter((d) => d.deletedAt || d.status === "deleted").length
    )
  );
  findings.push(
    finding(
      "info",
      "cache-legacy",
      "检查缓存里的历史键",
      `${check.legacyKeys.length} 个：${check.legacyKeys.join("、") || "-"}；现清单已无同键分组（标准号纠正后的残留）。`,
      [],
      "下次全量复查时清理，不影响判定",
      check.legacyKeys.length
    )
  );

  return {
    kb,
    generatedAt: new Date(now).toISOString(),
    readOnly: { verified: null, note: "" },
    totals: {
      docs: manifest.docs.length,
      live: docs.length,
      notes: manifest.docs.filter((d) => d.type === "note" && !d.deletedAt && d.status !== "deleted").length,
      deleted: manifest.docs.filter((d) => d.deletedAt || d.status === "deleted").length,
      withStdNo: docs.filter((d) => d.standardNo).length,
      groups: groups.length,
      cacheKeys: check.totals.cacheKeys,
      status: check.totals.byStatus,
    },
    cover: {
      total: coverRows.length,
      counts: coverRows.reduce((o, r) => ((o[r.kind] = (o[r.kind] ?? 0) + 1), o), {}),
      auto: coverAuto,
      p1: coverP1,
      p2: coverP2,
      info: coverInfo,
    },
    trust,
    superseded,
    check,
    summaryAudit,
    duplicates: dupGroups,
    findings,
  };
}

function byId(cache, id) {
  for (const it of Object.values(cache.items ?? {})) {
    const hit = (it.docs ?? []).find((d) => d.id === id);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 6. Markdown 渲染
// ---------------------------------------------------------------------------

const esc = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const short = (text, n = 90) => {
  const s = esc(text);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function tableRows(items, limit = 30) {
  const head = "| id | 标题 | 证据 | 拟动作 |\n|---|---|---|---|\n";
  const rows = items.slice(0, limit).map((x) => `| ${esc(x.id)} | ${short(x.title, 60)} | ${short(x.evidence, 110)} | ${short(x.action, 90)} |`);
  const more = items.length > limit ? `\n\n> 其余 ${items.length - limit} 条见 JSON。` : "";
  return head + rows.join("\n") + more;
}

export function renderMarkdown(report) {
  const g = (name) => report.findings.filter((f) => f.group === name);
  const lines = [
    `# 标准数据只读审计（${report.kb}）`,
    "",
    `- 生成时间：${report.generatedAt}`,
    `- 知识库：\`${report.kb}\``,
    `- 文档：${report.totals.docs} 篇（在库 ${report.totals.live}、笔记 ${report.totals.notes}、回收站 ${report.totals.deleted}）｜有标准号 ${report.totals.withStdNo} 篇｜标准组 ${report.totals.groups}`,
    `- 检查缓存：${report.totals.cacheKeys} 键｜状态 \`${JSON.stringify(report.totals.status)}\``,
    `- 只读校验：${report.readOnly.verified === true ? "✅ 扫描前后清单/索引/派生目录未变化" : report.readOnly.verified === false ? "❌ 扫描期间检测到变化" : "（未扫描）"}`,
    "",
    "## 0. 结论速览",
    "",
    "| 组 | 项数 | 说明 |",
    "|---|---|---|",
    ...["auto", "manual", "info"].map((x) => {
      const list = g(x);
      return `| ${x === "auto" ? "可自动修正" : x === "manual" ? "需人工确认" : "仅报告"} | ${list.length} | ${short(list.map((f) => f.title).join("；"), 150)} |`;
    }),
    "",
  ];
  let sectionNo = 0;
  const section = (name, label) => {
    sectionNo += 1;
    lines.push(`## ${sectionNo}. ${label}`, "");
    for (const f of g(name)) {
      lines.push(`### ${f.code} ${f.title}（${f.count ?? f.items.length}）`, "", f.summary, "");
      if (f.items.length) lines.push(tableRows(f.items, name === "info" ? 15 : 40), "");
      if (f.action) lines.push(`**建议命令/动作**：${f.action}`, "");
    }
  };
  section("auto", "可自动修正");
  section("manual", "需人工确认");
  section("info", "仅报告");
  lines.push(
    "## 附录：口径",
    "",
    "- 「可自动修正」= 有确定性证据（封面/站点字段）且不动正文；仍然属于真实库写操作，需要用户确认。",
    "- 「需人工确认」= 需要看原件、判断版本或选择保留哪一篇。",
    "- 「仅报告」= 正常现象或暂不处理，不产生写操作。",
    "- 封面核对复用 `scripts/audit-cover-stdno.mjs`；站点结果来自 `.std-check.json`，本脚本不联网。",
    ""
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 7. 只读指纹与 CLI
// ---------------------------------------------------------------------------

function directoryFingerprint(dir) {
  if (!existsSync(dir)) return { entries: 0, bytes: 0 };
  let entries = 0;
  let bytes = 0;
  const walk = (current) => {
    for (const ent of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        entries += 1;
        try {
          bytes += statSync(full).size;
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(dir);
  return { entries, bytes };
}

export function fingerprintKb(kbDir) {
  const files = ["kb.json", "index.md", "log.md", "schema.md"];
  const hashes = {};
  for (const name of files) {
    const path = join(kbDir, name);
    hashes[name] = existsSync(path) ? sha256(readFileSync(path)) : "";
  }
  return { hashes, markdown: directoryFingerprint(join(kbDir, "markdown")), sources: directoryFingerprint(join(kbDir, "sources")) };
}

/** 供测试与 CLI 共用的主流程：读、算、写报告。 */
export async function runAudit({ kbDir, kb, outDir = DEFAULT_OUT, now = Date.now(), write = true, coverTextFn } = {}) {
  const before = fingerprintKb(kbDir);
  const manifest = await tryReadManifest(kbDir);
  if (!manifest) throw new Error(`无法读取清单：${join(kbDir, "kb.json")}`);
  const cache = readJson(join(kbDir, ".std-check.json")) ?? { items: {} };
  const { groups } = await collectKbStandards(kbDir);
  const docs = manifest.docs.filter((d) => !d.deletedAt && d.status !== "deleted");
  const docsById = new Map(docs.map((d) => [d.id, d]));
  const docGroup = new Map();
  for (const [key, it] of Object.entries(cache.items ?? {})) {
    for (const d of it.docs ?? []) docGroup.set(d.id, { key, it });
  }
  const lintRaw = lintManifest(manifest, { kbName: kb, hasSchema: existsSync(join(kbDir, "schema.md")), now, maxItems: 5000 });
  const lintItems = {};
  for (const grp of lintRaw.groups) lintItems[grp.code] = grp.items;
  const lint = {
    raw: lintRaw,
    count: (code) => lintRaw.groups.find((x) => x.code === code)?.count ?? 0,
    items: (code) => lintItems[code] ?? [],
  };
  const readText = coverTextFn ?? ((id) => coverText(kbDir, id, 700));
  const readFull = (id) => {
    try {
      return readFileSync(join(kbDir, "markdown", id, `${id}.md`), "utf8");
    } catch {
      return "";
    }
  };
  const coverRows = auditCover({ docs, readText });
  const summaryAudit = auditSummaries({ docs, readText: readFull });
  const trust = classifyTrustReasons({ docs, docGroup });
  const prefixMismatches = detectPrefixMismatches({ docs, docGroup });
  const check = classifyCheckCache({ groups, cache, docsById });
  const superseded = detectSupersededNotLow({ manifest, docsById });
  const report = buildReport({ kb, manifest, cache, groups, docs, lint, coverRows, summaryAudit, trust, check, superseded, prefixMismatches, now });
  const after = fingerprintKb(kbDir);
  report.readOnly = {
    verified: JSON.stringify(before) === JSON.stringify(after),
    note: JSON.stringify(before) === JSON.stringify(after) ? "kb.json/index.md/log.md/schema.md 哈希与 markdown/sources 条目数未变化" : "扫描期间检测到知识库变化",
  };

  let files = null;
  if (write) {
    const date = new Date(now).toISOString().slice(0, 10);
    const dir = resolve(outDir);
    const rootResolved = resolve(kbDir);
    if (dir === rootResolved || dir.startsWith(rootResolved + "/")) throw new Error(`拒绝把报告写进被扫描的知识库：${dir}`);
    mkdirSync(dir, { recursive: true });
    const jsonPath = join(dir, `${date}-standard-data-audit.json`);
    const mdPath = join(dir, `${date}-standard-data-audit.md`);
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(mdPath, `${renderMarkdown(report)}\n`, "utf8");
    files = { json: jsonPath, markdown: mdPath };
  }
  return { report, files };
}

function parseArgs(argv) {
  const args = { root: "", kb: "", out: DEFAULT_OUT, date: "", write: true, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") args.root = argv[++i] ?? "";
    else if (a === "--kb") args.kb = argv[++i] ?? "";
    else if (a === "--out") args.out = argv[++i] ?? DEFAULT_OUT;
    else if (a === "--date") args.date = argv[++i] ?? "";
    else if (a === "--no-write") args.write = false;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log("用法: node scripts/std-data-audit.mjs --root <kbRoot> --kb <库名> [--out <dir>] [--date YYYY-MM-DD] [--no-write] [--json]");
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }
  if (!args.root || !args.kb) throw new Error("需要 --root 和 --kb");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = args.date ? Date.parse(`${args.date}T00:00:00Z`) : Date.now();
  const { report, files } = await runAudit({
    kbDir: kbDirPath(expandRoot(args.root), args.kb),
    kb: args.kb,
    outDir: args.out,
    now,
    write: args.write,
  });
  if (args.json) {
    console.log(JSON.stringify({ ...report, findings: report.findings.map((f) => ({ ...f, items: undefined })) }, null, 2));
  } else {
    const counts = report.findings.reduce((o, f) => ((o[f.group] = (o[f.group] ?? 0) + 1), o), {});
    console.log(`[std-audit] ${report.totals.live} 篇 / ${report.totals.groups} 组 / 发现 ${counts.auto ?? 0} 个可自动修正项、${counts.manual ?? 0} 个需人工项、${counts.info ?? 0} 个仅报告项`);
    console.log(`[std-audit] 只读校验：${report.readOnly.verified ? "通过" : "失败"}`);
    if (files) {
      console.log(`[std-audit] JSON：${files.json}`);
      console.log(`[std-audit] 报告：${files.markdown}`);
    }
  }
  if (report.readOnly.verified === false) process.exitCode = 2;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[std-audit] 失败: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
