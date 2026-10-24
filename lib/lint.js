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
import { extractStdRef } from "./standards.js";
import { isTempFileName } from "./temp-files.js";
import { backlinksFor } from "./wiki.js";

const SUPERSEDE_HINT = /（续）|\(续\)|续篇|修订版|更新版|补充版|增补版|再版|第[二三四五]版/;

/** 版本阶段：编制说明优先（它是草案的配套文件，不是同一份文档）。 */
export function stageOf(title) {
  const t = String(title ?? "");
  // 配套材料/变体版本：与正式发布版不是重复关系
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

  // 6) 同标准号分组：同号同年同阶段 = 疑似重复；同年不同阶段/不同年 = 信息项
  const byStd = new Map();
  for (const d of sources) {
    let ref = null;
    try {
      ref = extractStdRef(d.title);
    } catch {
      ref = null;
    }
    if (!ref) continue;
    const key = `${ref.prefix}\u0000${ref.compareNumber}`;
    const arr = byStd.get(key) ?? [];
    arr.push({ doc: d, ref });
    byStd.set(key, arr);
  }
  const stdDuplicates = [];
  const sameYearStages = [];
  let dedupKeptGroups = 0;
  const multiYear = [];
  for (const arr of byStd.values()) {
    if (arr.length < 2) continue;
    const stageBuckets = new Map();
    for (const item of arr) {
      const stage = stageOf(item.doc.title);
      const bucket = `${item.ref.year ?? "?"}\u0000${stage}`;
      const list = stageBuckets.get(bucket) ?? [];
      list.push(item);
      stageBuckets.set(bucket, list);
    }
    for (const [bucket, list] of stageBuckets) {
      if (list.length < 2) continue;
      const pending = list.filter((x) => x.doc.dedupKeep !== true);
      const kept = list.filter((x) => x.doc.dedupKeep === true);
      if (pending.length > 1) {
        stdDuplicates.push({
          docId: pending.map((x) => x.doc.id).join(","),
          title: pending.map((x) => x.doc.title).join(" / "),
          detail: `同号同期同阶段（${bucket.replace("\u0000", " ")}）`,
        });
      } else if (kept.length >= 2) {
        dedupKeptGroups += 1;
      }
    }
    const years = new Set(arr.map((x) => x.ref.year ?? "?"));
    if (years.size > 1) {
      multiYear.push({
        docId: arr.map((x) => x.doc.id).join(","),
        title: `${arr[0].ref.prefix} ${arr[0].ref.compareNumber}`,
        detail: `库内 ${arr.length} 个版本：${arr.map((x) => x.doc.title).join(" / ")}`,
      });
    }
    const stagesByYear = new Map();
    for (const item of arr) {
      const y = item.ref.year ?? "?";
      const set = stagesByYear.get(y) ?? new Set();
      set.add(stageOf(item.doc.title));
      stagesByYear.set(y, set);
    }
    for (const [y, set] of stagesByYear) {
      if (set.size > 1) {
        sameYearStages.push({
          docId: arr.map((x) => x.doc.id).join(","),
          title: `${arr[0].ref.prefix} ${arr[0].ref.compareNumber}（${y}）`,
          detail: [...set].join(" / "),
        });
      }
    }
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
  if (stdDuplicates.length > 0 || hashDups.length > 0) {
    suggestions.push({
      action: "kb_remove",
      count: stdDuplicates.length + hashDups.length,
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
    duplicateContentGroups: hashDups.length,
    sameNumberDuplicateGroups: stdDuplicates.length,
    dedupKeptGroups,
    sameNumberStageGroups: sameYearStages.length,
    sameNumberMultiYearGroups: multiYear.length,
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
