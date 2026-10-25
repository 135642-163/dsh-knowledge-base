/**
 * 知识库体检（lint）：只做机械可判定的检查，把语义判断（矛盾/陈旧结论）留给模型。
 *
 * 检查项：
 *  - 导入失败、旧管线（需要 kb_reparse）；
 *  - 文字层损坏 / OCR 低置信页；
 *  - 内容完全相同（sourceHash 重复）；
 *  - 同标准号 + 年份 + 阶段重复（复用 standards.extractStdRef 的分阶段口径，
 *    征求意见稿/报批稿/发布稿不互判重复）；
 *  - 同标准号多版本（信息项，提示可检查更新）；
 *  - 没有摘要（未编目）、笔记没有来源、笔记长期未复核、无入链笔记、
 *    标题带「续/修订版」等需要合并的提示；
 *  - 缺少 schema.md。
 */
import { PARSER_VERSION } from "./version.js";
import { extractStdRef, familyOf } from "./standards.js";
import { parseDocMeta, stageOf } from "./doc-meta.js";
import { isTempFileName } from "./temp-files.js";
import { backlinksFor } from "./wiki.js";

const SUPERSEDE_HINT = /（续）|\(续\)|续篇|修订版|更新版|补充版|增补版|再版|第[二三四五]版/;

const DAY_MS = 86_400_000;

function addGroup(groups, severity, code, label, items, hint) {
  if (!Array.isArray(items) || items.length === 0) return;
  groups.push({ severity, code, label, count: items.length, items, hint: hint ?? "" });
}

function ageDays(iso, now) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / DAY_MS);
}

/**
 * @param manifest 知识库清单
 * @param options { kbName, hasSchema, now, staleDays, maxItems }
 */
export function lintManifest(manifest, options = {}) {
  const {
    kbName = manifest?.name ?? "",
    hasSchema = true,
    now = Date.now(),
    staleDays = 90,
    maxItems = 20,
  } = options;
  const docs = Array.isArray(manifest?.docs) ? manifest.docs : [];
  const ready = docs.filter((d) => d.status === "ready" && !d.deletedAt);
  const notes = ready.filter((d) => d.type === "note");
  const sources = ready.filter((d) => d.type !== "note");
  const failed = docs.filter((d) => d.status === "failed");

  const groups = [];
  const suggestions = [];

  // 1) 导入失败
  addGroup(
    groups,
    "error",
    "failed",
    "导入失败",
    failed.map((d) => ({ docId: d.id, title: d.title, detail: d.error ?? "" })),
    "原始文件已保存在 sources/，可用 kb_reparse 重试"
  );

  // 2) 旧管线
  const stale = sources.filter((d) => (d.parserVersion ?? "") !== PARSER_VERSION);
  addGroup(
    groups,
    "info",
    "stale",
    "旧管线产物（可选刷新）",
    stale.map((d) => ({ docId: d.id, title: d.title, detail: d.parserVersion ?? "无管线版本" })),
    "不影响现有内容；需要新解析器/OCR 产物时再 kb_reparse（all=true 分批）"
  );

  // 3) 文字层损坏 / OCR 低置信
  const corrupted = sources.filter(
    (d) => (Array.isArray(d.corruptedPages) && d.corruptedPages.length > 0) ||
      (Array.isArray(d.lowConfidencePages) && d.lowConfidencePages.length > 0)
  );
  addGroup(
    groups,
    "warning",
    "corrupted",
    "文字层损坏 / OCR 低置信",
    corrupted.map((d) => {
      const c = Array.isArray(d.corruptedPages) ? d.corruptedPages.length : 0;
      const l = Array.isArray(d.lowConfidencePages) ? d.lowConfidencePages.length : 0;
      return { docId: d.id, title: d.title, detail: `损坏 ${c} 页，低置信 ${l} 页` };
    }),
    "关键页用 kb_view 核对；必要时 kb_reparse forceOcrPages=… 重识别"
  );

  // 4) 内容完全相同（不同路径导入的同一份文件）
  const byHash = new Map();
  for (const d of sources) {
    const hash = String(d.sourceHash ?? "").trim();
    if (!hash) continue;
    const arr = byHash.get(hash) ?? [];
    arr.push(d);
    byHash.set(hash, arr);
  }
  const hashDups = [...byHash.values()].filter((arr) => arr.length > 1);
  addGroup(
    groups,
    "warning",
    "duplicate-content",
    "内容完全相同的文档",
    hashDups.map((arr) => ({
      docId: arr.map((d) => d.id).join(","),
      title: arr.map((d) => d.title).join(" / "),
      detail: `同一文件导入 ${arr.length} 次`,
    })),
    "确认后保留一份，其余 kb_remove（默认软删除，可恢复）"
  );

  // 5) 临时/锁文件（旧版本导入可能已把 Office 所有者文件/系统垃圾收进库）
  const tempFiles = ready.filter((d) => isTempFileName(d.sourceFile || d.title));
  addGroup(
    groups,
    "warning",
    "temp-files",
    "临时/锁文件",
    tempFiles.map((d) => ({ docId: d.id, title: d.title, detail: d.sourceFile || d.title })),
    "用 kb_remove 删除（soft=false 可彻底删除）"
  );

  // 6) 资料身份：结构化标准号优先，旧清单回退标题解析
  const metadataMissing = [];
  const contentIncomplete = [];
  const filenameMismatch = [];
  const byStd = new Map();
  const byFamily = new Map();
  for (const d of sources) {
    const meta = d.standardNo
      ? {
          standardPrefix: d.standardPrefix ?? "",
          standardBase: d.standardBase ?? "",
          standardNumber: d.standardNumber ?? "",
          standardYear: Number.isFinite(d.standardYear) ? d.standardYear : null,
          standardPart: d.standardPart ?? null,
          standardNo: d.standardNo,
          stage: d.stage ?? "unknown",
          stageLabel: d.stageLabel ?? "",
        }
      : parseDocMeta(d.title, d.rawTitle ?? d.title);
    if (!String(d.sourceHash ?? "").trim()) {
      metadataMissing.push({ docId: d.id, title: d.title, detail: "缺 sourceHash" });
    } else if (!d.standardNo && meta.standardNo) {
      metadataMissing.push({ docId: d.id, title: d.title, detail: "缺结构化标准号" });
    }
    if (d.standardSource === "content" && d.filenameStandardNo && d.filenameStandardNo !== d.standardNo) {
      // GB 与 GB/T 同主编号属于同族写法，交给 same-number-family；这里只报
      // 主编号/年份/部分真正不一致，避免 200+ 条“GB → GB/T”噪声。
      const fileMeta = parseDocMeta(d.filenameStandardNo, d.filenameStandardNo);
      const sameIdentity = String(fileMeta.standardBase) === String(d.standardBase)
        && Number(fileMeta.standardYear ?? 0) === Number(d.standardYear ?? 0)
        && String(fileMeta.standardPart ?? "") === String(d.standardPart ?? "");
      if (!sameIdentity) {
        filenameMismatch.push({
          docId: d.id,
          title: d.title,
          detail: `文件名 ${d.filenameStandardNo} → 正文 ${d.standardNo}`,
        });
      }
    }
    if (meta.standardNo && ["partial", "cover-only"].includes(d.contentIntegrity)) {
      contentIncomplete.push({
        docId: d.id,
        title: d.title,
        detail: `${d.contentIntegrity}（正文 ${d.bodyChars ?? 0} 字，条款 ${d.clauseCount ?? 0} 条）`,
      });
    }
    if (!meta.standardNo) continue;
    const stageKey = meta.stage && meta.stage !== "unknown" ? meta.stage : stageOf(d.title);
    const stageLabel = meta.stageLabel || (stageKey === "unknown" ? stageOf(d.title) : stageKey);
    const ref = {
      prefix: meta.standardPrefix,
      number: meta.standardNumber || meta.standardBase,
      base: meta.standardBase,
      year: meta.standardYear,
      part: meta.standardPart,
      stage: stageKey,
      stageLabel,
    };
    const key = `${ref.prefix}\u0000${ref.base}\u0000${ref.part ?? ""}`;
    const arr = byStd.get(key) ?? [];
    arr.push({ doc: d, ref });
    byStd.set(key, arr);
    const family = `${familyOf(ref.prefix)}\u0000${ref.base}\u0000${ref.part ?? ""}`;
    const familyArr = byFamily.get(family) ?? [];
    familyArr.push({ doc: d, ref });
    byFamily.set(family, familyArr);
  }
  addGroup(
    groups,
    "warning",
    "metadata-missing",
    "元数据缺失（可回填）",
    metadataMissing,
    "运行 scripts/backfill-doc-meta.mjs --apply --hash --std --content 补齐 sourceHash/标准号"
  );
  addGroup(
    groups,
    "info",
    "filename-standard-mismatch",
    "文件名与封面/正文标准号不一致",
    filenameMismatch,
    "已按正文处理；核对后可 kb_retitle 统一显示标题"
  );
  addGroup(
    groups,
    "warning",
    "content-incomplete",
    "正文可能不完整（封面/目录可用但正文缺失）",
    contentIncomplete,
    "重新导入完整版或 kb_view 核对；不自动删除"
  );

  const stdDuplicates = [];
  const sameYearStages = [];
  const familyVariants = [];
  let dedupKeptGroups = 0;
  const multiYear = [];
  for (const arr of byStd.values()) {
    if (arr.length < 2) continue;
    const stageBuckets = new Map();
    for (const item of arr) {
      const bucket = `${item.ref.year ?? "?"}\u0000${item.ref.stage}`;
      const list = stageBuckets.get(bucket) ?? [];
      list.push(item);
      stageBuckets.set(bucket, list);
    }
    for (const [bucket, list] of stageBuckets) {
      if (list.length < 2) continue;
      const pending = list.filter((x) => x.doc.dedupKeep !== true);
      const kept = list.filter((x) => x.doc.dedupKeep === true);
      if (pending.length > 1) {
        const [year, stage] = bucket.split("\u0000");
        stdDuplicates.push({
          docId: pending.map((x) => x.doc.id).join(","),
          title: pending.map((x) => x.doc.title).join(" / "),
          detail: `同号同期同阶段（${year} ${pending[0].ref.stageLabel || stage}）`,
        });
      } else if (kept.length >= 2) {
        dedupKeptGroups += 1;
      }
    }
    const years = new Set(arr.map((x) => x.ref.year ?? "?"));
    if (years.size > 1) {
      const label = `${arr[0].ref.prefix} ${arr[0].ref.base}${arr[0].ref.part ? `.${arr[0].ref.part}` : ""}`;
      multiYear.push({
        docId: arr.map((x) => x.doc.id).join(","),
        title: label,
        detail: `库内 ${arr.length} 个版本：${arr.map((x) => x.doc.title).join(" / ")}`,
      });
    }
    const stagesByYear = new Map();
    for (const item of arr) {
      const y = item.ref.year ?? "?";
      const set = stagesByYear.get(y) ?? new Set();
      set.add(item.ref.stageLabel || item.ref.stage);
      stagesByYear.set(y, set);
    }
    for (const [y, set] of stagesByYear) {
      if (set.size > 1) {
        sameYearStages.push({
          docId: arr.map((x) => x.doc.id).join(","),
          title: `${arr[0].ref.prefix} ${arr[0].ref.base}${arr[0].ref.part ? `.${arr[0].ref.part}` : ""}（${y}）`,
          detail: [...set].join(" / "),
        });
      }
    }
  }
  for (const arr of byFamily.values()) {
    if (arr.length < 2) continue;
    const prefixes = new Set(arr.map((x) => x.ref.prefix));
    if (prefixes.size < 2) continue;
    const years = new Set(arr.map((x) => x.ref.year ?? "?"));
    if (years.size > 1) continue;
    familyVariants.push({
      docId: arr.map((x) => x.doc.id).join(","),
      title: arr.map((x) => x.doc.title).join(" / "),
      detail: `同族写法：${[...prefixes].join(" / ")}`,
    });
  }
  addGroup(
    groups,
    "warning",
    "same-number",
    "同标准号同期同阶段疑似重复",
    stdDuplicates,
    "核对后 kb_remove 其一，或 kb_keep 标记已核对保留；不同阶段（征求意见/报批/发布）不算重复"
  );
  addGroup(
    groups,
    "info",
    "same-number-stages",
    "同标准号同期不同阶段",
    sameYearStages,
    "属正常过程稿，无需删除；可在笔记里说明采用哪一版"
  );
  addGroup(
    groups,
    "info",
    "same-number-multi-year",
    "同标准号多版本",
    multiYear,
    "可用 kb_std_check 检查是否已有更新版本"
  );
  addGroup(
    groups,
    "info",
    "same-number-family",
    "同标准号不同写法（GB vs GB/T 等）",
    familyVariants,
    "核对封面后保留正确写法；需求确认后可 kb_keep"
  );

  // 正文指纹相同的独立文件（旧文档需要 --text 回填后才会出现）
  const byText = new Map();
  for (const d of sources) {
    const hash = String(d.textHash ?? "").trim();
    if (!hash) continue;
    const arr = byText.get(hash) ?? [];
    arr.push(d);
    byText.set(hash, arr);
  }
  const textDups = [...byText.values()].filter((arr) => arr.length > 1);
  addGroup(
    groups,
    "warning",
    "duplicate-text",
    "正文完全相同的文档",
    textDups.map((arr) => ({
      docId: arr.map((d) => d.id).join(","),
      title: arr.map((d) => d.title).join(" / "),
      detail: `同一正文导入 ${arr.length} 次`,
    })),
    "确认后保留一份，其余 kb_remove（默认软删除，可恢复）"
  );

  // 7) 未编目（没有摘要）
  const unlabeled = ready.filter((d) => !String(d.summary ?? "").trim());
  addGroup(
    groups,
    "warning",
    "unlabeled",
    "未编目（没有一行摘要）",
    unlabeled.map((d) => ({ docId: d.id, title: d.title })),
    "用 kb_describe 补摘要与标签，index.md 会随之更新"
  );

  // 8) 笔记没有来源
  const notesNoSources = notes.filter(
    (d) => (Array.isArray(d.sources) ? d.sources.length : 0) === 0 &&
      (Array.isArray(d.linksOut) ? d.linksOut.length : 0) === 0
  );
  addGroup(
    groups,
    "warning",
    "note-no-sources",
    "笔记没有来源",
    notesNoSources.map((d) => ({ docId: d.id, title: d.title, detail: d.kind ?? "note" })),
    "用 kb_add_note 同一标题更新并补 sources（docId#页码），避免没有出处的结论"
  );

  // 9) 标题提示应合并（续/修订版）
  const supersedeHints = notes.filter((d) => SUPERSEDE_HINT.test(String(d.title ?? "")));
  addGroup(
    groups,
    "warning",
    "supersede-hint",
    "疑似应合并的笔记（续/修订版）",
    supersedeHints.map((d) => ({ docId: d.id, title: d.title })),
    "合并到主线笔记（同标题 kb_add_note 更新），旧页 kb_remove 软删除"
  );

  // 10) 无入链笔记（有来源/出链，但没有任何别的笔记引用它）
  const orphans = notes.filter((d) => {
    const out = (Array.isArray(d.sources) ? d.sources.length : 0) +
      (Array.isArray(d.linksOut) ? d.linksOut.length : 0);
    if (out === 0) return false;
    return backlinksFor(manifest, d.id).length === 0;
  });
  addGroup(
    groups,
    "info",
    "orphan-note",
    "无入链笔记（有来源但没被其他笔记引用）",
    orphans.map((d) => ({ docId: d.id, title: d.title })),
    "补来源或并入主题页，否则以后很难被找到"
  );

  // 11) 笔记长期未复核
  const staleNotes = staleDays > 0
    ? notes.filter((d) => {
        const age = ageDays(d.updatedAt, now);
        return age !== null && age > staleDays;
      })
    : [];
  addGroup(
    groups,
    "info",
    "note-stale",
    `笔记超过 ${staleDays} 天未更新`,
    staleNotes.map((d) => {
      const age = ageDays(d.updatedAt, now);
      return { docId: d.id, title: d.title, detail: `${Math.floor(age ?? 0)} 天前` };
    }),
    "复核关键结论是否已被新资料推翻（不需要改动的可忽略）"
  );

  // 12) 未标注可信度
  const trustUnknown = ready.filter((d) => !["high", "medium", "low"].includes(d.trust));
  addGroup(
    groups,
    "info",
    "trust-unknown",
    "未标注可信度",
    trustUnknown.map((d) => ({ docId: d.id, title: d.title })),
    "用 kb_trust 标为 high/medium/low；检索时会优先高可信、并标注低可信"
  );

  // 13) 缺少维护规范
  if (!hasSchema) {
    addGroup(groups, "warning", "schema-missing", "缺少维护规范 schema.md", [
      { docId: "schema", title: "schema.md", detail: "新库会自动创建，旧库可手动补" },
    ], '用 kb_edit doc="schema" 创建/修订');
  }

  // 建议动作（聚合，避免逐篇刷屏）
  if (failed.length > 0 || corrupted.length > 0) {
    suggestions.push({
      action: "kb_reparse",
      count: failed.length + corrupted.length,
      reason: "失败/损坏页文档从 sources/ 重新解析（损坏页可加 forceOcrPages）",
    });
  }
  if (stale.length > 0) {
    suggestions.push({
      action: "kb_reparse",
      count: stale.length,
      reason: "旧管线产物可选刷新（择期用 all=true + limit 分批，不影响现有内容）",
    });
  }
  if (unlabeled.length > 0) {
    suggestions.push({
      action: "kb_describe",
      count: unlabeled.length,
      reason: "给未编目文档补摘要；旧文档也可先 kb_reparse 重新生成抽取式摘要",
    });
  }
  if (notesNoSources.length > 0) {
    suggestions.push({
      action: "kb_add_note",
      count: notesNoSources.length,
      reason: "同标题更新笔记并补 sources（docId#页码）",
    });
  }
  if (metadataMissing.length > 0) {
    suggestions.push({
      action: "kb_edit",
      count: metadataMissing.length,
      reason: "运行 scripts/backfill-doc-meta.mjs --apply --hash --std --content 补齐资料身份元数据",
    });
  }
  if (stdDuplicates.length > 0 || hashDups.length > 0 || textDups.length > 0) {
    suggestions.push({
      action: "kb_remove",
      count: stdDuplicates.length + hashDups.length + textDups.length,
      reason: "核对后软删除重复项（默认软删除，可恢复）",
    });
  }
  if (trustUnknown.length > 0) {
    suggestions.push({
      action: "kb_trust",
      count: trustUnknown.length,
      reason: "给未标注文档打可信度（high/medium/low），检索时可按可信度提醒",
    });
  }
  if (supersedeHints.length > 0) {
    suggestions.push({
      action: "kb_add_note",
      count: supersedeHints.length,
      reason: "把「续/修订版」合并回主线笔记（同标题=更新）",
    });
  }
  if (!hasSchema) {
    suggestions.push({ action: "kb_edit", reason: 'doc="schema" 创建维护规范' });
  }

  const counts = {
    docs: docs.length,
    ready: ready.length,
    notes: notes.length,
    sources: sources.length,
    failed: failed.length,
    stale: stale.length,
    corrupted: corrupted.length,
    tempFiles: tempFiles.length,
    metadataMissing: metadataMissing.length,
    contentIncomplete: contentIncomplete.length,
    filenameMismatch: filenameMismatch.length,
    duplicateContentGroups: hashDups.length,
    duplicateTextGroups: textDups.length,
    sameNumberDuplicateGroups: stdDuplicates.length,
    dedupKeptGroups,
    sameNumberStageGroups: sameYearStages.length,
    sameNumberMultiYearGroups: multiYear.length,
    sameNumberFamilyGroups: familyVariants.length,
    unlabeled: unlabeled.length,
    notesWithoutSources: notesNoSources.length,
    supersedeHints: supersedeHints.length,
    orphanNotes: orphans.length,
    staleNotes: staleNotes.length,
    trustHigh: ready.filter((d) => d.trust === "high").length,
    trustMedium: ready.filter((d) => d.trust === "medium").length,
    trustLow: ready.filter((d) => d.trust === "low").length,
    trustUnknown: trustUnknown.length,
    hasSchema: Boolean(hasSchema),
  };

  return {
    kb: kbName,
    generatedAt: new Date(now).toISOString(),
    totals: { docs: docs.length, ready: ready.length, notes: notes.length, sources: sources.length },
    counts,
    groups: groups.map((g) => ({ ...g, items: g.items.slice(0, maxItems) })),
    suggestions: suggestions.slice(0, maxItems),
  };
}

/** 兼容旧调用方：阶段判定已迁到 doc-meta.js。 */
export { stageOf };
