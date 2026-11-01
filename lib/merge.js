/**
 * 本地知识库合并（P0 后端）：planMerge / executeMerge / sweepMergedSources。
 *
 * 设计见 docs/specs/2026-11-01-kb-merge-design.md：
 * - 物理移动文档：复制到目标 → 校验/提交清单 → 源库移入归档；
 * - 源库全空才写 mergedInto/mergePurgeAfter（A 方案懒清理 7 天）；
 * - 同 id 同内容跳过；同 id 异内容改名；同号同版本按 duplicatePolicy；
 * - 同号不同年/阶段保留并警告；笔记引用只提示，不改写。
 */
import { randomBytes } from "node:crypto";
import { cp, copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { titleKeys } from "./dedup.js";
import { createKb } from "./kbmeta.js";
import {
  expandRoot, isDeleted, kbDirPath, listKbs, readManifest, sanitizeKbName,
  snapshotKb, tryReadManifest, withManifestLock, writeManifestAtomic,
} from "./store.js";
import { refreshKbIndex } from "./import-job.js";
import { appendLog } from "./wiki.js";

export const MERGE_RETENTION_DAYS = 7;
const MERGE_LOCK = new Map();

export class MergeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "MergeError";
    this.code = code;
    if (details) this.details = details;
  }
}

function rootOf(kbRoot) {
  const raw = String(kbRoot ?? "").trim();
  if (!raw) throw new MergeError("MERGE_INVALID", "缺少知识库根目录");
  return expandRoot(raw);
}

function iso(now) {
  const value = typeof now === "function" ? now() : now;
  return new Date(Number.isFinite(Number(value)) ? Number(value) : Date.now()).toISOString();
}

function addDays(isoText, days) {
  return new Date(Date.parse(isoText) + Math.max(0, Number(days) || 0) * 86400000).toISOString();
}

function normalizeTitle(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function docTitle(doc) {
  return String(doc?.title ?? doc?.standardNo ?? "");
}

function stdKey(doc) {
  const keys = titleKeys(`${docTitle(doc)} ${String(doc?.standardNo ?? "")}`);
  if (!keys.code) return "";
  return `${keys.code}|${keys.year ?? "?"}|${keys.edition}|${keys.part}`;
}

function stdCode(doc) {
  const keys = titleKeys(`${docTitle(doc)} ${String(doc?.standardNo ?? "")}`);
  return keys.code ?? "";
}

function sameContent(a, b) {
  if (a?.sourceHash && b?.sourceHash) return a.sourceHash === b.sourceHash;
  return normalizeTitle(a?.title) === normalizeTitle(b?.title)
    && String(a?.type ?? "") === String(b?.type ?? "")
    && Number(a?.chars ?? 0) === Number(b?.chars ?? 0);
}

function freshId(used) {
  for (;;) {
    const id = randomBytes(6).toString("hex");
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

function noteRefs(doc) {
  const refs = [];
  for (const key of ["sources", "linksOut"]) {
    if (!Array.isArray(doc?.[key])) continue;
    for (const value of doc[key]) if (typeof value === "string" && value) refs.push(value);
  }
  return refs;
}

async function loadKb(root, name, label) {
  let clean;
  try {
    clean = sanitizeKbName(name);
  } catch {
    throw new MergeError("MERGE_INVALID", `${label}名称无效: ${name}`);
  }
  const dir = kbDirPath(root, clean);
  const manifest = await tryReadManifest(dir);
  if (!manifest) throw new MergeError("MERGE_KB_NOT_FOUND", `${label}不存在: ${clean}`);
  if (manifest.mergedInto != null) {
    throw new MergeError("MERGE_SOURCE_MERGED", `${label}「${clean}」已合并到「${manifest.mergedInto}」`);
  }
  return { name: clean, dir, manifest };
}

function buildMaps(docs) {
  const byId = new Map();
  const byStd = new Map();
  const byCode = new Map();
  const byCore = new Map();
  for (const doc of docs ?? []) {
    byId.set(doc.id, doc);
    const key = stdKey(doc);
    if (key) {
      if (!byStd.has(key)) byStd.set(key, doc);
      const code = stdCode(doc);
      if (code && !byCode.has(code)) byCode.set(code, doc);
    } else {
      const core = normalizeTitle(docTitle(doc));
      if (core && !byCore.has(core)) byCore.set(core, doc);
    }
  }
  return { byId, byStd, byCode, byCore };
}

function uniqueStartTarget(kbRoot, target) {
  const requested = target?.name;
  if (!requested) throw new MergeError("MERGE_INVALID", "缺少目标库名");
  let name;
  try {
    name = sanitizeKbName(requested);
  } catch {
    throw new MergeError("MERGE_INVALID", `目标库名无效: ${requested}`);
  }
  const dir = kbDirPath(rootOf(kbRoot), name);
  return { name, dir, create: target?.create === true, description: String(target?.description ?? ""), tags: Array.isArray(target?.tags) ? target.tags : [] };
}

/** 预览：只读，不创建目标库、不写任何文件。 */
export async function planMerge({ kbRoot, sources, target, duplicatePolicy = "skip", now = Date.now() } = {}) {
  const root = rootOf(kbRoot);
  const srcNames = [...new Set((Array.isArray(sources) ? sources : []).map((name) => {
    try { return sanitizeKbName(name); } catch { throw new MergeError("MERGE_INVALID", `源库名无效: ${name}`); }
  }))];
  if (srcNames.length === 0) throw new MergeError("MERGE_INVALID", "至少需要一个源库");
  if (srcNames.length > 10) throw new MergeError("MERGE_TOO_MANY", "一次最多合并 10 个库");
  const targetInfo = uniqueStartTarget(root, target);
  if (srcNames.includes(targetInfo.name)) {
    throw new MergeError("MERGE_INVALID", "目标库不能同时是源库");
  }
  const sourceKbs = [];
  for (const name of srcNames) sourceKbs.push(await loadKb(root, name, "源库"));
  const targetDir = kbDirPath(root, targetInfo.name);
  let targetManifest = await tryReadManifest(targetDir);
  if (!targetManifest) {
    if (targetInfo.create !== true) {
      throw new MergeError("MERGE_TARGET_NOT_FOUND", `目标库不存在: ${targetInfo.name}；如需新建请传 target.create=true`);
    }
    targetManifest = { name: targetInfo.name, description: targetInfo.description, tags: targetInfo.tags, docs: [] };
  }
  if (targetManifest.mergedInto != null) {
    throw new MergeError("MERGE_TARGET_MERGED", `目标库「${targetInfo.name}」已合并到「${targetManifest.mergedInto}」`);
  }
  const policy = duplicatePolicy === "keep" ? "keep" : "skip";
  const actions = [];
  const conflicts = [];
  const warnings = [];
  const targetDocs = [...(targetManifest.docs ?? [])].map((doc) => ({ ...doc }));
  const usedIds = new Set(targetDocs.map((doc) => doc.id));
  for (const kb of sourceKbs) for (const doc of kb.manifest.docs ?? []) usedIds.add(doc.id);
  const notes = [];
  for (const kb of sourceKbs) {
    for (const doc of kb.manifest.docs ?? []) {
      if (!doc || doc.status !== "ready" || isDeleted(doc)) continue;
      const maps = buildMaps(targetDocs);
      let action = "move";
      let newId = doc.id;
      const existingId = maps.byId.get(doc.id);
      if (existingId) {
        if (sameContent(doc, existingId)) {
          action = "skip-same";
        } else {
          action = "rename";
          newId = freshId(usedIds);
          conflicts.push({ fromKb: kb.name, docId: doc.id, title: doc.title, action, newId, reason: "same-id-different-content" });
        }
      } else {
        const key = stdKey(doc);
        if (key && maps.byStd.has(key)) {
          if (policy === "skip") {
            action = "skip-duplicate";
            conflicts.push({ fromKb: kb.name, docId: doc.id, title: doc.title, action, reason: "same-standard-same-stage" });
          } else {
            action = "rename";
            newId = freshId(usedIds);
            warnings.push({ code: "DUPLICATE_KEPT", message: `同号同版本保留两份: ${doc.title}` });
          }
        } else if (!key) {
          const core = normalizeTitle(docTitle(doc));
          if (core && maps.byCore.has(core)) {
            if (policy === "skip") {
              action = "skip-duplicate";
              conflicts.push({ fromKb: kb.name, docId: doc.id, title: doc.title, action, reason: "same-title" });
            } else {
              action = "rename";
              newId = freshId(usedIds);
            }
          }
        } else {
          const code = stdCode(doc);
          if (code && maps.byCode.has(code)) {
            warnings.push({ code: "MULTI_VERSION", message: `同号不同版本/阶段，两份都保留: ${doc.title}` });
          }
        }
      }
      actions.push({ fromKb: kb.name, docId: doc.id, newId, title: doc.title, action, doc });
      if (action === "move" || action === "rename") {
        targetDocs.push({ ...doc, id: newId });
      }
      if (action === "rename") {
        for (const note of [...(kb.manifest.docs ?? []), ...(targetManifest.docs ?? [])]) {
          if (note?.type !== "note") continue;
          if (noteRefs(note).includes(doc.id)) notes.push({ kb: kb.name, docId: note.id, title: note.title, references: [doc.id] });
        }
      }
    }
  }
  const summary = {
    move: actions.filter((a) => a.action === "move").length,
    rename: actions.filter((a) => a.action === "rename").length,
    skipSame: actions.filter((a) => a.action === "skip-same").length,
    skipDuplicate: actions.filter((a) => a.action === "skip-duplicate").length,
    skippedFailed: sourceKbs.reduce((n, kb) => n + (kb.manifest.docs ?? []).filter((d) => d.status === "failed").length, 0),
    skippedDeleted: sourceKbs.reduce((n, kb) => n + (kb.manifest.docs ?? []).filter((d) => isDeleted(d)).length, 0),
    notesAffected: notes.length,
  };
  return {
    sources: sourceKbs.map((kb) => ({ name: kb.name, docs: (kb.manifest.docs ?? []).filter((d) => d.status === "ready" && !isDeleted(d)).length })),
    target: { name: targetInfo.name, exists: Boolean(await tryReadManifest(targetDir)), create: targetInfo.create, description: targetInfo.description, tags: targetInfo.tags },
    duplicatePolicy: policy,
    summary,
    conflicts,
    warnings,
    notesAffected: notes.slice(0, 100),
    actions: actions.map(({ doc, ...rest }) => rest),
  };
}

async function copyDocFiles(sourceDir, targetDir, oldId, newId, sourceFile = "") {
  const created = [];
  let sourceEntries = [];
  try { sourceEntries = await readdir(join(sourceDir, "sources")); } catch { /* 无原件 */ }
  const sourceName = sourceEntries.find((name) => name === `${oldId}${extname(sourceFile)}` || name.startsWith(`${oldId}.`));
  if (sourceName) {
    const ext = extname(sourceName) || ".bin";
    const targetPath = join(targetDir, "sources", `${newId}${ext}`);
    await mkdir(join(targetDir, "sources"), { recursive: true });
    await copyFile(join(sourceDir, "sources", sourceName), targetPath);
    created.push(targetPath);
  }
  for (const sub of ["markdown", "history"]) {
    try {
      await stat(join(sourceDir, sub, oldId));
      await cp(join(sourceDir, sub, oldId), join(targetDir, sub, newId), { recursive: true });
      created.push(join(targetDir, sub, newId));
    } catch {
      /* 该文档没有这部分 */
    }
  }
  return created;
}

async function withMergeLock(root, fn) {
  const key = rootOf(root);
  const prev = MERGE_LOCK.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  MERGE_LOCK.set(key, run.catch(() => {}));
  try {
    return await run;
  } finally {
    if (MERGE_LOCK.get(key) === run.catch(() => {})) { /* 保留链，下一次会串行 */ }
  }
}

/** 执行合并；失败时按已记录动作清理目标副本并恢复清单。 */
export async function executeMerge({ kbRoot, sources, target, duplicatePolicy = "skip", retentionDays = MERGE_RETENTION_DAYS, now = Date.now, snapshot = true } = {}) {
  const root = rootOf(kbRoot);
  return await withMergeLock(root, async () => {
    const plan = await planMerge({ kbRoot: root, sources, target, duplicatePolicy, now });
    const targetDir = kbDirPath(root, plan.target.name);
    const sourceNames = plan.sources.map((item) => item.name);
    const snapshots = [];
    if (snapshot) {
      for (const name of [...sourceNames, ...(plan.target.exists ? [plan.target.name] : [])]) {
        const dir = kbDirPath(root, name);
        const manifest = await readManifest(dir);
        snapshots.push({ kb: name, ...(await snapshotKb(dir, manifest, { label: "pre-merge" })) });
      }
    }
    if (plan.target.create && !plan.target.exists) {
      await createKb(root, { name: plan.target.name, description: plan.target.description, tags: plan.target.tags });
    }
    const createdAt = iso(now);
    const targetManifest = await readManifest(targetDir);
    const beforeTargetDocs = targetManifest.docs ?? [];
    const beforeSources = new Map();
    for (const name of sourceNames) beforeSources.set(name, await readManifest(kbDirPath(root, name)));
    const createdFiles = [];
    const movedBySource = new Map(sourceNames.map((name) => [name, []]));
    try {
      for (const action of plan.actions) {
        if (action.action !== "move" && action.action !== "rename") continue;
        const sourceDir = kbDirPath(root, action.fromKb);
        const sourceManifest = beforeSources.get(action.fromKb);
        const doc = (sourceManifest?.docs ?? []).find((item) => item.id === action.docId);
        if (!doc) continue;
        createdFiles.push(...(await copyDocFiles(sourceDir, targetDir, doc.id, action.newId, doc.sourceFile)));
        targetManifest.docs.push({
          ...doc,
          id: action.newId,
          sourcePath: "",
          updatedAt: createdAt,
        });
        sourceManifest.docs = (sourceManifest.docs ?? []).filter((item) => item.id !== action.docId);
        movedBySource.get(action.fromKb).push({ oldId: doc.id, newId: action.newId, sourceFile: doc.sourceFile });
      }
      await withManifestLock(targetDir, async () => {
        await writeManifestAtomic(targetDir, targetManifest);
      });
      for (const name of sourceNames) {
        const manifest = beforeSources.get(name);
        const active = (manifest.docs ?? []).filter((doc) => doc.status === "ready" && !isDeleted(doc));
        if (active.length === 0) {
          manifest.mergedInto = plan.target.name;
          manifest.mergedAt = createdAt;
          manifest.mergePurgeAfter = addDays(createdAt, retentionDays);
          manifest.mergePurgedAt = null;
        }
        await withManifestLock(kbDirPath(root, name), async () => {
          await writeManifestAtomic(kbDirPath(root, name), manifest);
        });
      }
      // 部分合并的源库仍活跃：移走已搬走的原件，避免孤儿文件；全空的源库保留 7 天供 purge。
      for (const name of sourceNames) {
        const manifest = beforeSources.get(name);
        const active = (manifest.docs ?? []).filter((doc) => doc.status === "ready" && !isDeleted(doc));
        if (active.length > 0) {
          for (const item of movedBySource.get(name)) {
            try {
              const entries = await readdir(join(kbDirPath(root, name), "sources"));
              const hit = entries.find((entry) => entry === `${item.oldId}${extname(item.sourceFile)}` || entry.startsWith(`${item.oldId}.`));
              if (hit) await rm(join(kbDirPath(root, name), "sources", hit), { force: true });
              await rm(join(kbDirPath(root, name), "markdown", item.oldId), { recursive: true, force: true });
              await rm(join(kbDirPath(root, name), "history", item.oldId), { recursive: true, force: true });
            } catch { /* 清理失败不阻塞 */ }
          }
        }
      }
      await refreshKbIndex(targetDir);
      for (const name of sourceNames) await refreshKbIndex(kbDirPath(root, name));
      const journal = {
        version: 1,
        createdAt,
        sources: sourceNames,
        target: plan.target.name,
        snapshots: snapshots.map((item) => ({ kb: item.kb, name: item.name, path: item.path })),
        actions: plan.actions,
        summary: plan.summary,
        conflicts: plan.conflicts,
        warnings: plan.warnings,
      };
      await mkdir(join(targetDir, "snapshots"), { recursive: true });
      const journalName = `merge-${createdAt.replace(/[:T]/g, "-").slice(0, 19)}.json`;
      await import("node:fs/promises").then(({ writeFile }) => writeFile(join(targetDir, "snapshots", journalName), JSON.stringify(journal, null, 2), "utf8"));
      await appendLog(targetDir, { action: "merge", title: sourceNames.join("、"), detail: `合并到 ${plan.target.name}：移动 ${plan.summary.move + plan.summary.rename} 篇，跳过 ${plan.summary.skipSame + plan.summary.skipDuplicate} 篇` });
      for (const name of sourceNames) {
        await appendLog(kbDirPath(root, name), { action: "merge", title: plan.target.name, detail: `并入 ${plan.target.name}` });
      }
      return { ...plan, journal: journalName, snapshots };
    } catch (error) {
      // 清单/文件回滚：恢复执行前清单，删除目标副本；源库文件在成功前未删除。
      try {
        targetManifest.docs = beforeTargetDocs;
        await withManifestLock(targetDir, async () => writeManifestAtomic(targetDir, targetManifest));
      } catch { /* 尽力 */ }
      for (const file of createdFiles) await rm(file, { recursive: true, force: true }).catch(() => {});
      for (const name of sourceNames) {
        const manifest = beforeSources.get(name);
        await withManifestLock(kbDirPath(root, name), async () => writeManifestAtomic(kbDirPath(root, name), manifest)).catch(() => {});
      }
      throw error;
    }
  });
}

/** A 方案：启动时懒清理到期的已合并源库（只删大目录，保留墓碑清单）。 */
export async function sweepMergedSources({ kbRoot, now = Date.now } = {}) {
  const root = rootOf(kbRoot);
  const at = iso(now);
  const nowMs = Date.parse(at);
  const purged = [];
  for (const kb of await listKbs(root)) {
    if (!kb.mergedInto) continue;
    const dir = kbDirPath(root, kb.dir ?? kb.name);
    const manifest = await readManifest(dir);
    const due = Date.parse(manifest.mergePurgeAfter ?? "");
    if (!Number.isFinite(due) || due > nowMs || manifest.mergePurgedAt) continue;
    for (const sub of ["sources", "markdown", "history", "import-tmp"]) {
      await rm(join(dir, sub), { recursive: true, force: true }).catch(() => {});
    }
    manifest.mergePurgedAt = at;
    await withManifestLock(dir, async () => writeManifestAtomic(dir, manifest));
    await appendLog(dir, { action: "merge-purge", title: kb.name, detail: `清理已合并源文件（${manifest.mergedInto}）` });
    purged.push({ kb: kb.name, mergedInto: manifest.mergedInto, purgedAt: at });
  }
  return { purged };
}
