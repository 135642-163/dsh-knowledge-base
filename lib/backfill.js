/**
 * 旧库资料身份回填：sourceHash / 标准要素 / 正文完整性 / textHash / trust / 可选 retitle。
 *
 * 默认只读（planBackfill）；applyBackfill 每库一次原子写清单。
 * 不自动删除任何文档，不修改未要求字段；retitle 仅用于解析出标准号且正文完整的资料。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { hashFile } from "./hash.js";
import {
  contentIntegrityFor,
  mergeDocMeta,
  parseContentStandard,
  parseCoverTitle,
  needsRetitle,
  parseDocMeta,
  safeRetitle,
  titleKey,
  textFingerprint,
  trustHeuristic,
} from "./doc-meta.js";
import { sectionsFromMarkdown } from "./parsers.js";
import {
  pruneHistory,
  readManifest,
  rebuildMerged,
  snapshotDocVersion,
  withManifestLock,
  writeManifestAtomic,
  isDeleted,
} from "./store.js";

function kindForBackfill(doc) {
  const type = String(doc?.type ?? "");
  if (type.startsWith("pdf")) return "pdf";
  if (["docx", "pptx", "epub", "mobi"].includes(type)) return type;
  return "text";
}

async function findSourceFile(dir, docId) {
  let entries = [];
  try {
    entries = await readdir(join(dir, "sources"));
  } catch {
    return null;
  }
  const matches = entries.filter((name) => name === docId || name.startsWith(`${docId}.`));
  if (matches.length !== 1) return null;
  const path = join(dir, "sources", matches[0]);
  try {
    const info = await stat(path);
    return info.isFile() ? path : null;
  } catch {
    return null;
  }
}

function rawTitleFor(doc) {
  const sourceFile = String(doc.sourceFile ?? "");
  if (sourceFile !== "") return basename(sourceFile, extname(sourceFile));
  return String(doc.title ?? "");
}

function hasFlag(options, name) {
  return options?.[name] === true;
}

function titleBodyOf(title, standardNo, meta = {}) {
  const value = String(title ?? "").trim();
  if (!standardNo) return value;
  const number = String(meta.standardNumber ?? "").trim();
  if (number) {
    const prefix = String(meta.standardPrefix ?? "").trim();
    const family = prefix.replace(/\/(?:T|Z)$/i, "");
    const prefixPart = prefix ? `(?:${escapeRe(prefix)}${family && family !== prefix ? `|${escapeRe(family)}` : ""})\\s*` : "";
    const year = meta.standardYear != null ? `(?:\\s*[-—–~～]\\s*(?:${meta.standardYear}|${String(meta.standardYear).slice(-2)}))?` : "";
    const re = new RegExp(`^\\s*${prefixPart}${escapeRe(number)}${year}\\s*`, "i");
    return value.replace(re, "").trim();
  }
  const escaped = String(standardNo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`^\\s*${escaped}\\s*`), "").trim() || value;
}

function escapeRe(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function goodTitleBody(body) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 3 || text.length > 50) return false;
  if (/[，。；、]/.test(text)) return false;
  if (/^(?:本标准|本文件|本规范|本导则|本部分|下列|使用本|有关|第?\s*\d+\s|[-—–])/.test(text)) return false;
  if (/本标准|本文件|本规范|本导则|本部分|引用标准|术语和定义/.test(text)) return false;
  if (/\]\(#|Toc|第\s*\d+\s*页|^\[|https?:|www\.|@/i.test(text)) return false;
  if (/[$%^&*=<>{}[\]|\\]/.test(text)) return false;
  if (/[”"'“”]/.test(text)) return false;
  if (/忻|目动|补食|顷|高讨|电讨|扩木|了网络|GBMT|GBAMT|CIEC|TEC\b|标准化工作导则|（的规）|》》/.test(text)) return false;
  if (/(?:与|使用)$/.test(text)) return false;
  if (/^\d{4,}/.test(text)) return false;
  if (/^[A-Za-z]{2,6}\s+/.test(text) && !/^(?:IEC|IEEE|ISO|GB|DL|NB|JB|TB|Q\/GDW|EN|JJF)\b/.test(text)) return false;
  if (/£|©|®|\bIRE\b|\bEND\b|委16|替代\s/.test(text)) return false;
  if (/中国国家标准化管理委员会|国家标准化管理委员会|国家能源局|国家电网有限公司|国家电网公司/.test(text)) return false;
  if (/分敢|电磁车容|补公闭置|规苞|变压希|区能|编与|本指导性/.test(text)) return false;
  if (/国家电网有限公|中国国|BRIE|SJL|#\d|得电线路|防护等级\(IP代码\)|有限公/.test(text)) return false;
  if (/^(?:第\s*\d+\s*部分|技术规范|技术要求|试验方法|检测技术规程|抗扰度试验总论)$/.test(text)) return false;
  if (/^压|骚扰$|发射$|小于或|[的或和与及]$/.test(text)) return false;
  if (/上传版|无水印|扫描件/.test(text)) return false;
  if (/第\s*\d+\s*$/.test(text)) return false;
  if (/^[A-Z]{2,6}\s+\d/.test(text) && !/^(?:IEC|IEEE|ISO|GB|DL|NB|JB|TB|Q\/GDW|EN|JJF)\b/.test(text)) return false;
  if (!/(?:技术|规范|规程|导则|标准|方法|系统|装置|设备|电网|电力|电能|电压|变压器|保护|试验|检测|设计|运行|管理|要求|条件|模型|计算|评估|测量|监测|通信|自动化|电容器|电抗器|光伏|风电|储能|配电网|变电站|控制|功率|负荷|谐波|无功|绝缘|电缆|开关|互感器|仪器|仪表|终端|平台|接口|数据|信息|安全|可靠性|规划|建设|验收|检修|维护|整定|配置|选用|使用|检验|校准|测试|建模|仿真|预测|调度|计量|营业|服务|质量)/.test(text)) return false;
  return (text.match(/[\u4e00-\u9fa5]/g) ?? []).length >= 3;
}

const TITLE_BODY_BLOCK_BASES = new Set([
  "17626.11-2023", "17626.11-2008", "17626.1-2024", "17626.7-2017",
  "14598.26-2015", "26868-2011", "18039.3-2003", "15576-2008",
  "17625.2-2007", "39260.2-2020", "4728.9-2008", "2069-2019",
  "12320.3-2023", "12230.2-2022", "5205-2011", "10289-2019",
  "32009-2013", "17626.3-2006", "5369-2011", "30427-2013",
]);
const TITLE_BODY_CORRECTION = new Map([
  ["12326-1990", "电能质量 电压允许波动和闪变"],
  ["4728.6-2008", "电气简图用图形符号 第6部分：电能的发生与转换"],
]);

function normalizationTarget(doc, mergedMeta, contentMeta, integrity, siblingBody = "") {
  const title = String(doc?.title ?? "");
  const std = String(mergedMeta?.standardNo ?? "");
  const stdBaseKey = mergedMeta?.standardNumber
    ? `${mergedMeta.standardNumber}-${mergedMeta.standardYear ?? ""}`
    : "";
  if (TITLE_BODY_BLOCK_BASES.has(stdBaseKey)) return null;
  const book = /[《》]/.test(title);
  if (!std && !book) return null;
  const currentBody = titleBodyOf(title, std, mergedMeta);
  const noisy = !currentBody || /^(?:扫描件|无水印|上传版(?:\s*\(\d+\))?|\(\d+\))$/i.test(currentBody);
  const sequenceNoise = /^\d{1,3}\s+/.test(currentBody);
  const bare = Boolean(std) && (titleKey(title) === titleKey(std) || noisy || sequenceNoise);
  if (std && !book && !bare) return null;
  let target = String(mergedMeta?.canonicalTitle ?? "");
  const contentBody = String(contentMeta?.contentTitle ?? "");
  if (std && noisy && TITLE_BODY_CORRECTION.has(stdBaseKey)) {
    target = `${std} ${TITLE_BODY_CORRECTION.get(stdBaseKey)}`;
  } else if (std && noisy && goodTitleBody(contentBody)) {
    target = `${std} ${contentBody}`;
  } else if (std && noisy && goodTitleBody(siblingBody)) {
    target = `${std} ${siblingBody}`;
  }
  target = target.replace(/\s+/g, " ").trim();
  const targetBody = titleBodyOf(target, std, mergedMeta);
  if (!targetBody || targetBody === currentBody || target === title) return null;
  if (!goodTitleBody(targetBody)) return null;
  if (std && !noisy && !book && currentBody && targetBody.length + 4 < currentBody.length) return null;
  const full = (integrity?.integrity ?? doc?.contentIntegrity) === "full";
  if (!full && std && noisy) return null;
  return target;
}

/**
 * 计算回填计划（不写盘）。
 * @param dir 知识库目录
 * @param options { hash, std, content, text, trust, retitle, normalizeTitles }
 * @returns { changes, counts, skipped, errors }
 */
export async function planBackfill(dir, options = {}) {
  const manifest = await readManifest(dir);
  const changes = [];
  const skipped = [];
  const errors = [];
  const counts = {
    scanned: 0,
    hash: 0,
    std: 0,
    content: 0,
    text: 0,
    trust: 0,
    retitle: 0,
    normalizeTitles: 0,
    skipped: 0,
    errors: 0,
  };
  const siblingTitles = new Map();
  for (const doc of manifest.docs ?? []) {
    if (doc.status !== "ready" || isDeleted(doc) || doc.type === "note") continue;
    const meta = parseDocMeta(doc.title, doc.rawTitle ?? doc.title);
    if (!meta.standardBase || meta.standardYear == null) continue;
    const body = titleBodyOf(meta.canonicalTitle, meta.standardNo, meta);
    if (!goodTitleBody(body)) continue;
    const key = `${meta.standardBase}|${meta.standardYear}|${meta.standardPart ?? ""}|${meta.stage}`;
    if (!siblingTitles.has(key)) siblingTitles.set(key, body);
  }
  for (const doc of manifest.docs ?? []) {
    if (doc.status !== "ready" || isDeleted(doc) || doc.type === "note") continue;
    counts.scanned += 1;
    const patch = {};
    if (hasFlag(options, "hash") && !String(doc.sourceHash ?? "").trim()) {
      const sourcePath = await findSourceFile(dir, doc.id);
      if (!sourcePath) {
        skipped.push({ docId: doc.id, title: doc.title, reason: "原件缺失，无法计算 sourceHash" });
      } else {
        try {
          patch.sourceHash = await hashFile(sourcePath);
          counts.hash += 1;
        } catch (error) {
          errors.push({ docId: doc.id, title: doc.title, error: String(error?.message ?? error) });
        }
      }
    }
    const rawTitle = rawTitleFor(doc);
    const filenameMeta = parseDocMeta(doc.title, rawTitle);
    let contentMeta = null;
    let integrity = null;
    let mergedMeta = filenameMeta;
    if (hasFlag(options, "std") || hasFlag(options, "content") || hasFlag(options, "retitle") || hasFlag(options, "normalizeTitles")) {
      let sections = null;
      try {
        const mergedText = await readFile(join(dir, "markdown", doc.id, `${doc.id}.md`), "utf8");
        const body = mergedText.replace(/^#\s+.*\r?\n/, "");
        sections = sectionsFromMarkdown(body);
      } catch {
        skipped.push({ docId: doc.id, title: doc.title, reason: "合并版缺失，跳过正文解析" });
      }
      if (sections) {
        if (hasFlag(options, "content")) {
          integrity = contentIntegrityFor({ sections }, { kind: kindForBackfill(doc) });
          // 只有标准/书籍允许正文优先；其他资料只用文件名/标题（用户明确要求）。
          const standardEligible = Boolean(filenameMeta.standardNo) || ["epub", "mobi"].includes(doc.type);
          if (standardEligible) {
            contentMeta = parseContentStandard(sections, { expectedStandardNo: filenameMeta.standardNo });
            if (!contentMeta && ["epub", "mobi"].includes(doc.type)) {
              const cover = parseCoverTitle(sections);
              if (cover) contentMeta = { ...cover, standardNo: "" };
            }
            if (contentMeta?.standardNo) counts.content += 1;
          }
        }
        mergedMeta = mergeDocMeta(filenameMeta, contentMeta && contentMeta.standardNo ? contentMeta : null);
        if (hasFlag(options, "text")) {
          patch.textHash = textFingerprint(sections);
          patch.textHashAlgo = "sha256-norm-v1";
          counts.text += 1;
        }
      }
    }
    if (hasFlag(options, "std")) {
      patch.rawTitle = doc.rawTitle || rawTitle;
      patch.canonicalTitle = mergedMeta.canonicalTitle || doc.canonicalTitle || doc.title;
      patch.standardNo = mergedMeta.standardNo || "";
      patch.standardPrefix = mergedMeta.standardPrefix || "";
      patch.standardNumber = mergedMeta.standardNumber || "";
      patch.standardBase = mergedMeta.standardBase || "";
      patch.standardYear = mergedMeta.standardYear ?? null;
      patch.standardPart = mergedMeta.standardPart ?? null;
      patch.standardSource = mergedMeta.standardSource ?? "none";
      patch.filenameStandardNo = mergedMeta.filenameStandardNo || "";
      patch.contentTitle = mergedMeta.contentTitle || "";
      patch.stage = mergedMeta.stage || "unknown";
      patch.stageLabel = mergedMeta.stageLabel || "";
      if (mergedMeta.standardNo) counts.std += 1;
    }
    if (hasFlag(options, "content")) {
      if (integrity) {
        patch.contentIntegrity = integrity.integrity;
        patch.bodyChars = integrity.bodyChars;
        patch.clauseCount = integrity.clauseCount;
      }
    }
    if (hasFlag(options, "trust") && (!doc.trust || doc.trust === "unknown")) {
      const trust = trustHeuristic(mergedMeta);
      if (trust.trust !== "unknown") {
        patch.trust = trust.trust;
        patch.trustReason = trust.reason;
        patch.trustSource = "heuristic";
        counts.trust += 1;
      }
    }
    if (hasFlag(options, "normalizeTitles")) {
      const metaKey = mergedMeta.standardBase
        ? `${mergedMeta.standardBase}|${mergedMeta.standardYear}|${mergedMeta.standardPart ?? ""}|${mergedMeta.stage}`
        : "";
      const target = normalizationTarget(doc, mergedMeta, contentMeta, integrity, metaKey ? siblingTitles.get(metaKey) : "");
      if (target) {
        patch.title = target;
        patch.retitle = true;
        counts.normalizeTitles += 1;
      }
    } else if (hasFlag(options, "retitle") && mergedMeta.standardNo && mergedMeta.canonicalTitle) {
      const target = mergedMeta.canonicalTitle;
      const full = (integrity?.integrity ?? doc.contentIntegrity) === "full";
      if (full && target !== doc.title && needsRetitle(doc.title) && safeRetitle(doc.title, target)) {
        patch.title = target;
        patch.retitle = true;
        counts.retitle += 1;
      }
    }
    if (Object.keys(patch).length > 0) {
      changes.push({ docId: doc.id, title: doc.title, patch, retitle: patch.retitle === true });
    }
  }
  counts.skipped = skipped.length;
  counts.errors = errors.length;
  return { changes, counts, skipped, errors };
}

/**
 * 应用回填计划：一次锁内写 manifest；retitle 的文档同时重建合并版并保留历史。
 * @returns { applied, retitled, errors }
 */
export async function applyBackfill(dir, plan) {
  const changes = Array.isArray(plan?.changes) ? plan.changes : [];
  if (changes.length === 0) return { applied: 0, retitled: 0, errors: [] };
  const errors = [];
  let applied = 0;
  let retitled = 0;
  await withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    for (const change of changes) {
      const doc = (manifest.docs ?? []).find((item) => item.id === change.docId);
      if (!doc || doc.status !== "ready" || isDeleted(doc)) continue;
      const { retitle, ...patch } = change.patch;
      if (retitle) {
        let history = Array.isArray(doc.history) ? [...doc.history] : [];
        try {
          const snap = await snapshotDocVersion(dir, doc, "retitle-backfill");
          if (snap) history.push(snap);
        } catch {
          /* 历史快照失败不阻塞回填 */
        }
        try {
          history = await pruneHistory(dir, doc.id, history);
        } catch {
          /* 历史裁剪失败保留原历史 */
        }
        const nextTitle = String(patch.title ?? doc.title).replace(/\s+/g, " ").trim().slice(0, 200);
        delete patch.title;
        Object.assign(doc, patch, {
          title: nextTitle,
          titleSource: "auto",
          history,
          version: (doc.version ?? 0) + 1,
          metadataUpdatedAt: new Date().toISOString(),
        });
        try {
          await rebuildMerged(dir, doc);
        } catch (error) {
          errors.push({ docId: doc.id, title: doc.title, error: String(error?.message ?? error) });
        }
        retitled += 1;
      } else {
        Object.assign(doc, patch, { metadataUpdatedAt: new Date().toISOString() });
      }
      applied += 1;
    }
    await writeManifestAtomic(dir, manifest);
  });
  return { applied, retitled, errors };
}
