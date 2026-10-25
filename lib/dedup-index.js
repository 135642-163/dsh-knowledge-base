/**
 * 去重索引：把 manifest 文档与候选元数据映射成几类键，按业务规则判定是否重复。
 *
 * 关键口径：
 *  - 标准号以正文/封面为准（candidate 由 pipeline 合并），索引侧只消费字段；
 *  - 同库命中始终跳过；跨库默认跳过，allowCrossKb 才放行；
 *  - std 命中还要比较 contentIntegrity：完整版不被残缺版挡住，残缺版不覆盖完整版。
 */
import { familyOf } from "./standards.js";
import { parseDocMeta, titleKey } from "./doc-meta.js";
import { kbDirPath, listKbs, tryReadManifest } from "./store.js";

function isIndexable(doc) {
  return Boolean(doc) && (!doc.status || doc.status === "ready") && doc.type !== "note";
}

export function effectiveIntegrity(doc) {
  const value = doc?.contentIntegrity;
  if (value === "full" || value === "partial" || value === "cover-only") return value;
  const chars = Number(doc?.chars) || 0;
  if (chars >= 1000) return "full";
  if (chars >= 200) return "partial";
  return "unknown";
}

function normalizeDoc(doc, kb, dir) {
  const meta = parseDocMeta(doc.title ?? "", doc.rawTitle ?? doc.title ?? "");
  const standardNo = typeof doc.standardNo === "string" && doc.standardNo !== ""
    ? doc.standardNo
    : meta.standardNo;
  return {
    ...meta,
    ...doc,
    kb: kb ?? doc.kb ?? "",
    dir: dir ?? doc.dir ?? doc.kb ?? "",
    standardNo,
    standardPrefix: doc.standardPrefix || meta.standardPrefix,
    standardNumber: doc.standardNumber || meta.standardNumber,
    standardBase: doc.standardBase || meta.standardBase,
    standardYear: Number.isFinite(doc.standardYear) ? doc.standardYear : meta.standardYear,
    standardPart: doc.standardPart ?? meta.standardPart,
    stage: doc.stage && doc.stage !== "unknown" ? doc.stage : meta.stage,
    stageLabel: doc.stageLabel || meta.stageLabel,
    contentIntegrity: effectiveIntegrity(doc),
    titleKey: doc.titleKey || meta.titleKey,
  };
}

export function stdKey(meta) {
  if (!meta?.standardNo) return "";
  return [meta.standardPrefix, meta.standardBase, meta.standardYear ?? "", meta.standardPart ?? "", meta.stage]
    .join("\u0000");
}

export function familyStdKey(meta) {
  if (!meta?.standardNo) return "";
  return [familyOf(meta.standardPrefix), meta.standardBase, meta.standardYear ?? "", meta.standardPart ?? "", meta.stage]
    .join("\u0000");
}

function push(map, key, value) {
  if (!key) return;
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

export function createDedupIndex({ targetKb = "" } = {}) {
  return {
    targetKb,
    bySourceHash: new Map(),
    byTextHash: new Map(),
    byStdKey: new Map(),
    byFamilyKey: new Map(),
    byTitleKey: new Map(),
    docs: [],
  };
}

/** 把一篇文档加入索引；同一 id+dir 只加一次，便于 worker 逐文件更新。 */
export function addToDedupIndex(index, rawDoc, { kb, dir } = {}) {
  if (!isIndexable(rawDoc)) return index;
  const doc = normalizeDoc(rawDoc, kb, dir);
  const key = `${doc.dir}\u0000${doc.id}`;
  if (index.docs.some((item) => `${item.dir}\u0000${item.id}` === key)) return index;
  const entry = { ...doc, sameKb: doc.dir === index.targetKb };
  index.docs.push(entry);
  push(index.bySourceHash, entry.sourceHash, entry);
  push(index.byTextHash, entry.textHash, entry);
  push(index.byStdKey, stdKey(entry), entry);
  push(index.byFamilyKey, familyStdKey(entry), entry);
  push(index.byTitleKey, entry.titleKey || titleKey(entry.title), entry);
  return index;
}

/** docs 可传数组或 { docs, targetKb }；生产代码优先用 buildDedupIndexFromRoot。 */
export function buildDedupIndex(input, { targetKb = "" } = {}) {
  const docs = Array.isArray(input) ? input : Array.isArray(input?.docs) ? input.docs : [];
  const index = createDedupIndex({ targetKb: targetKb || input?.targetKb || "" });
  for (const doc of docs) addToDedupIndex(index, doc, { kb: doc.kb, dir: doc.dir ?? doc.kb });
  return index;
}

/** 从 kbRoot 扫描活跃库的 ready 文档；kbNames 是目录名白名单（null = 全部）。 */
export async function buildDedupIndexFromRoot({ root, targetKb, kbNames = null }) {
  const index = createDedupIndex({ targetKb });
  const allowed = kbNames ? new Set(kbNames) : null;
  for (const entry of await listKbs(root)) {
    const dir = entry.dir ?? entry.name;
    if (allowed && !allowed.has(dir) && !allowed.has(entry.name)) continue;
    if (entry.mergedInto != null) continue;
    const manifest = await tryReadManifest(kbDirPath(root, dir));
    if (!manifest) continue;
    for (const doc of manifest.docs ?? []) {
      addToDedupIndex(index, doc, { kb: manifest.name || entry.name, dir });
    }
  }
  return index;
}

function addHit(hits, seen, kind, doc) {
  if (!doc) return;
  const key = `${kind}\u0000${doc.dir}\u0000${doc.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  hits.push({
    kind,
    kb: doc.kb,
    dir: doc.dir,
    id: doc.id,
    title: doc.title,
    sameKb: doc.dir === undefined ? false : doc.sameKb === true,
    contentIntegrity: doc.contentIntegrity ?? "unknown",
  });
}

function prefixSimilar(a, b) {
  const left = titleKey(a);
  const right = titleKey(b);
  if (left.length < 6 || right.length < 6) return false;
  const [short, long] = left.length < right.length ? [left, right] : [right, left];
  return long.startsWith(short) && short.length >= 6;
}

/**
 * 候选与索引的原始命中（含 similar）。
 * candidate 可带 sourceHash/textHash/title/standard 字段/contentIntegrity/docId。
 */
export function matchCandidate(index, candidate = {}) {
  if (!index) return [];
  const meta = candidate.standardNo
    ? {
        standardNo: candidate.standardNo,
        standardPrefix: candidate.standardPrefix ?? "",
        standardBase: candidate.standardBase ?? "",
        standardYear: candidate.standardYear ?? null,
        standardPart: candidate.standardPart ?? null,
        stage: candidate.stage ?? "unknown",
        titleKey: candidate.titleKey ?? titleKey(candidate.title ?? ""),
      }
    : parseDocMeta(candidate.title ?? "", candidate.rawTitle ?? candidate.title ?? "");
  const hits = [];
  const seen = new Set();
  for (const doc of index.bySourceHash.get(candidate.sourceHash) ?? []) {
    if (doc.id !== candidate.docId) addHit(hits, seen, "source-hash", doc);
  }
  for (const doc of index.byTextHash.get(candidate.textHash) ?? []) {
    if (doc.id !== candidate.docId) addHit(hits, seen, "text-hash", doc);
  }
  const exactKey = stdKey(meta);
  const exactHits = exactKey ? index.byStdKey.get(exactKey) ?? [] : [];
  for (const doc of exactHits) {
    if (doc.id !== candidate.docId) addHit(hits, seen, "std", doc);
  }
  if (exactHits.length === 0) {
    const familyHits = familyStdKey(meta) ? index.byFamilyKey.get(familyStdKey(meta)) ?? [] : [];
    for (const doc of familyHits) {
      if (doc.id !== candidate.docId) addHit(hits, seen, "std-family", doc);
    }
  }
  if (!meta.standardNo) {
    const key = meta.titleKey || titleKey(candidate.title ?? "");
    for (const doc of index.byTitleKey.get(key) ?? []) {
      if (doc.id !== candidate.docId) addHit(hits, seen, "title-exact", doc);
    }
    if (!index.byTitleKey.get(key)?.length) {
      for (const doc of index.docs) {
        if (doc.id === candidate.docId) continue;
        if (prefixSimilar(candidate.title ?? "", doc.title ?? "")) {
          addHit(hits, seen, "title-prefix", doc);
        }
      }
    }
  }
  return hits;
}

function integrityRank(value) {
  return value === "full" ? 3 : value === "partial" ? 2 : value === "cover-only" ? 1 : 0;
}

function pickPreferred(hits) {
  return hits.find((hit) => hit.sameKb) ?? hits[0];
}

function crossAllowed(hit, allowCrossKb) {
  return hit.sameKb === false && allowCrossKb === true;
}

/**
 * 最终判定：{ skip, reason, match?, replacesIncomplete? }。
 * title-prefix 只算 similar，不跳过。
 */
export function decideDuplicate(hits, candidate = {}, { allowCrossKb = false } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0) return { skip: false, reason: "", match: null };
  const nearOnly = list.every((hit) => hit.kind === "title-prefix");
  if (nearOnly) return { skip: false, reason: "similar", match: pickPreferred(list) };

  const exactHash = list.filter((hit) => hit.kind === "source-hash" || hit.kind === "text-hash");
  if (exactHash.length > 0) {
    const hit = pickPreferred(exactHash);
    if (crossAllowed(hit, allowCrossKb)) return { skip: false, reason: "", match: hit };
    return { skip: true, reason: "duplicate", match: hit };
  }

  const stdHits = list.filter((hit) => hit.kind === "std" || hit.kind === "std-family");
  if (stdHits.length > 0) {
    const hit = pickPreferred(stdHits);
    if (crossAllowed(hit, allowCrossKb)) return { skip: false, reason: "", match: hit };
    const nextRank = integrityRank(candidate.contentIntegrity);
    const existingRank = integrityRank(hit.contentIntegrity);
    if (nextRank >= 3 && existingRank < 3) {
      return { skip: false, reason: "replaces-incomplete", replacesIncomplete: true, match: hit };
    }
    if (nextRank < 3 && existingRank >= 3) {
      return { skip: true, reason: "existing-full", match: hit };
    }
    if (nextRank < 3 && existingRank < 3) {
      return { skip: true, reason: "both-incomplete", match: hit };
    }
    return { skip: true, reason: "duplicate", match: hit };
  }

  const titleHit = pickPreferred(list.filter((hit) => hit.kind === "title-exact"));
  if (titleHit) {
    if (crossAllowed(titleHit, allowCrossKb)) return { skip: false, reason: "", match: titleHit };
    return { skip: true, reason: "duplicate", match: titleHit };
  }
  return { skip: false, reason: "similar", match: pickPreferred(list) };
}
