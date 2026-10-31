/**
 * 库级快照恢复：列快照 → 校验 zip →（可选）预演 → 恢复 manifest/markdown/可选 sources
 * → 索引重建 + log 记录。
 *
 * 安全约定：
 *  - 只接受 kb_snapshot 产出的快照（meta.json + kb.json）；
 *  - 拒绝路径穿越/符号链接/高于本插件的 schemaVersion；
 *  - 恢复前自动留一份 before-restore 快照；
 *  - prune=true 时，快照之外文档的 markdown/sources 移到 trash-restore/
 *    （不永久删除，便于人工找回）。
 */
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { KbpackError, assertSafeEntryName } from "./kbpack.js";
import { openZipReader } from "./zip-reader.js";
import { refreshKbIndex } from "./import-job.js";
import {
  SCHEMA_VERSION,
  isDeleted,
  listKbSnapshots,
  readManifest,
  snapshotKb,
  withManifestLock,
  writeManifestAtomic,
} from "./store.js";
import { buildFtsIndex, startBackgroundFtsBuild } from "./fts-index.js";
import { appendLog } from "./wiki.js";

const FTS_BACKGROUND_DOCS = 200;
/** 快照 zip 内联读取上限（与 kbpack 同一内存约束）。 */
export const SNAPSHOT_MAX_ZIP_BYTES = 8 * 1024 ** 3;
/** 超过该体积改走流式 ZipReader。 */
export const SNAPSHOT_JSZIP_MAX_BYTES = 256 * 1024 ** 2;

function isoStamp(now) {
  return now.toISOString().replace(/[:T]/g, "-").slice(0, 19);
}

function liveDocs(manifest) {
  return (manifest?.docs ?? []).filter((doc) => doc?.status === "ready" && !isDeleted(doc));
}

/** 选择快照：精确名 / 唯一子串 / latest。 */
export function pickSnapshot(snapshots, ref, { latest = false } = {}) {
  const list = Array.isArray(snapshots) ? snapshots : [];
  if (list.length === 0) {
    throw new KbpackError("SNAPSHOT_NOT_FOUND", "该知识库还没有快照（先用 kb_snapshot 创建）");
  }
  if (latest) return list[0];
  const text = String(ref ?? "").trim();
  if (text === "") {
    throw new KbpackError(
      "SNAPSHOT_REQUIRED",
      `请指定 snapshot（可用 list=true 查看），或 latest=true 恢复最新一份。现有：${list
        .slice(0, 5)
        .map((item) => item.name)
        .join("、")}`
    );
  }
  const exact = list.filter((item) => item.name === text);
  if (exact.length === 1) return exact[0];
  const partial = list.filter((item) => item.name.includes(text));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new KbpackError(
      "SNAPSHOT_AMBIGUOUS",
      `快照名「${text}」命中多份：${partial.map((item) => item.name).join("、")}`
    );
  }
  throw new KbpackError("SNAPSHOT_NOT_FOUND", `没有找到快照「${text}」`);
}

function isSymlinkEntry(entry) {
  const mode = Number(entry?.unixPermissions);
  return Number.isFinite(mode) && mode > 0 && (mode & 0o170000) === 0o120000;
}

/**
 * 读取并校验快照 zip（小快照 JSZip，大快照流式 reader）。
 * @returns {zip|null, reader|null, meta, manifest, markdownEntries:Map(id→names[]), sourceEntries:Map(id→name)}
 */
export async function inspectSnapshot(path, { forceStream = false } = {}) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new KbpackError("SNAPSHOT_NOT_FOUND", `快照文件不存在: ${basename(String(path))}`);
  }
  if (!info.isFile()) throw new KbpackError("SNAPSHOT_INVALID", "快照路径不是文件");
  if (info.size > SNAPSHOT_MAX_ZIP_BYTES) {
    throw new KbpackError(
      "SNAPSHOT_TOO_LARGE",
      `快照过大（${(info.size / 1024 ** 3).toFixed(2)} GB），当前内联恢复上限 ${SNAPSHOT_MAX_ZIP_BYTES / 1024 ** 3} GB`
    );
  }
  let zip = null;
  let reader = null;
  try {
    let list = [];
    if (forceStream || info.size > SNAPSHOT_JSZIP_MAX_BYTES) {
      reader = await openZipReader(path);
      list = reader.list();
    } else {
      const { default: JSZip } = await import("jszip");
      try {
        zip = await JSZip.loadAsync(await readFile(path));
      } catch (error) {
        throw new KbpackError("SNAPSHOT_INVALID", `快照不是合法 zip: ${String(error?.message ?? error)}`);
      }
      list = Object.keys(zip.files ?? {}).map((name) => {
        const entry = zip.files[name];
        return {
          name,
          isDirectory: entry.dir === true,
          isSymlink: isSymlinkEntry(entry),
        };
      });
    }
    const names = [];
    const nameSet = new Set();
    for (const entry of list) {
      assertSafeEntryName(entry.name);
      if (entry.isSymlink) {
        throw new KbpackError("SNAPSHOT_INVALID", `快照内含符号链接，拒绝恢复: ${entry.name}`);
      }
      names.push(entry.name);
      nameSet.add(entry.name);
    }
    if (!nameSet.has("meta.json") || !nameSet.has("kb.json")) {
      throw new KbpackError("SNAPSHOT_INVALID", "不是 kb_snapshot 快照（缺 meta.json 或 kb.json）");
    }
    const readText = async (name) => {
      if (reader) return await reader.readText(name);
      const entry = zip.file(name);
      if (!entry || entry.dir) return null;
      return await entry.async("string");
    };
    let meta;
    let manifest;
    try {
      meta = JSON.parse(await readText("meta.json"));
      manifest = JSON.parse(await readText("kb.json"));
    } catch (error) {
      throw new KbpackError("SNAPSHOT_INVALID", `快照清单不是合法 JSON: ${String(error?.message ?? error)}`);
    }
    const schemaVersion = Number(manifest?.schemaVersion);
    if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) {
      throw new KbpackError("SNAPSHOT_INVALID", "快照 kb.json 缺少 schemaVersion");
    }
    if (schemaVersion > SCHEMA_VERSION) {
      throw new KbpackError(
        "SNAPSHOT_VERSION_TOO_NEW",
        `快照版本过高（schemaVersion=${schemaVersion}，本插件支持到 ${SCHEMA_VERSION}），请先升级插件`,
        { schemaVersion, supported: SCHEMA_VERSION }
      );
    }
    if (!Array.isArray(manifest.docs)) throw new KbpackError("SNAPSHOT_INVALID", "快照 kb.json 缺少 docs");
    const markdownEntries = new Map();
    const sourceEntries = new Map();
    for (const entry of list) {
      if (entry.isDirectory) continue;
      const name = entry.name;
      if (name.startsWith("markdown/")) {
        const rest = name.slice("markdown/".length);
        const slash = rest.indexOf("/");
        if (slash <= 0) continue;
        const id = rest.slice(0, slash);
        if (!markdownEntries.has(id)) markdownEntries.set(id, []);
        markdownEntries.get(id).push(name);
      } else if (name.startsWith("sources/")) {
        const file = name.slice("sources/".length);
        if (file.includes("/")) continue;
        const dot = file.indexOf(".");
        if (dot > 0) sourceEntries.set(file.slice(0, dot), name);
      }
    }
    return {
      zip,
      reader,
      meta,
      manifest,
      markdownEntries,
      sourceEntries,
      bytes: info.size,
      filename: basename(String(path)),
    };
  } catch (error) {
    if (reader) await reader.close().catch(() => {});
    throw error;
  }
}

/** 规划恢复：对比快照清单与当前清单。纯函数，便于测试。 */
export function planSnapshotRestore({ snapshotManifest, currentManifest } = {}) {
  const snapDocs = (snapshotManifest?.docs ?? []).filter((doc) => doc && typeof doc.id === "string");
  const curDocs = (currentManifest?.docs ?? []).filter((doc) => doc && typeof doc.id === "string");
  const snapIds = new Set(snapDocs.map((doc) => doc.id));
  const curIds = new Set(curDocs.map((doc) => doc.id));
  const added = snapDocs.filter((doc) => !curIds.has(doc.id));
  const removed = curDocs.filter((doc) => !snapIds.has(doc.id));
  const changed = [];
  const unchanged = [];
  for (const doc of snapDocs) {
    const current = curDocs.find((item) => item.id === doc.id);
    if (!current) continue;
    const same =
      Number(current.version) === Number(doc.version) &&
      String(current.updatedAt ?? "") === String(doc.updatedAt ?? "") &&
      String(current.sourceHash ?? "") === String(doc.sourceHash ?? "") &&
      String(current.textHash ?? "") === String(doc.textHash ?? "") &&
      current.status === doc.status &&
      Boolean(isDeleted(current)) === Boolean(isDeleted(doc));
    if (same) unchanged.push(doc);
    else changed.push({ snapshot: doc, current });
  }
  return {
    added,
    removed,
    changed,
    unchanged,
    counts: {
      snapshot: snapDocs.length,
      current: curDocs.length,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
    },
  };
}

async function extractFile(inspected, name, dest) {
  if (inspected.reader) {
    await inspected.reader.extractEntry(name, dest);
    return;
  }
  const entry = inspected.zip?.files?.[name];
  if (!entry || entry.dir) return;
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, await entry.async("nodebuffer"));
}

function safeExt(name) {
  const ext = extname(String(name ?? ""));
  return /^\.[a-z0-9]{1,10}$/i.test(ext) ? ext : ".bin";
}

/** 把一个目录移进回收目录（跨目录 rename；失败时退回复制后删除）。 */
async function moveAside(source, dest) {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(source, dest);
  } catch {
    await rm(dest, { recursive: true, force: true });
    await rename(source, dest);
  }
}

/**
 * 恢复快照。
 * @param {object} opts
 *  kbDir, snapshotPath, dryRun, includeSources, prune, preRestoreSnapshot
 */
export async function restoreKbSnapshot({
  kbDir,
  snapshotPath,
  dryRun = true,
  includeSources = false,
  prune = true,
  keepPreRestoreSnapshot = true,
  forceStream = false,
  now = new Date(),
} = {}) {
  const started = Date.now();
  const inspected = await inspectSnapshot(snapshotPath, { forceStream });
  const currentManifest = await readManifest(kbDir);
  const snapshotManifest = inspected.manifest;
  if (String(snapshotManifest.name ?? "") !== String(currentManifest.name ?? "")) {
    throw new KbpackError(
      "SNAPSHOT_KB_MISMATCH",
      `快照属于知识库「${snapshotManifest.name ?? "?"}」，当前目标库是「${currentManifest.name ?? "?"}」；拒绝跨库恢复`
    );
  }
  const plan = planSnapshotRestore({ snapshotManifest, currentManifest });
  const hasSources = inspected.sourceEntries.size > 0;
  const warnings = [];
  for (const doc of plan.added) {
    if (!inspected.markdownEntries.has(doc.id)) {
      warnings.push(`快照内文档「${doc.title}」（${doc.id}）没有派生正文，恢复后可能不可读`);
    }
  }
  const base = {
    ok: true,
    kb: currentManifest.name,
    dryRun,
    snapshot: {
      name: inspected.filename,
      createdAt: String(inspected.meta?.createdAt ?? ""),
      docs: Number(inspected.meta?.docs) || snapshotManifest.docs.length,
      includeSources: inspected.meta?.includeSources === true || hasSources,
      bytes: inspected.bytes,
    },
    counts: plan.counts,
    added: plan.added.slice(0, 20).map((doc) => ({ id: doc.id, title: doc.title })),
    removed: plan.removed.slice(0, 20).map((doc) => ({ id: doc.id, title: doc.title })),
    changed: plan.changed.slice(0, 20).map((item) => ({
      id: item.snapshot.id,
      title: item.snapshot.title,
      fromVersion: item.current.version,
      toVersion: item.snapshot.version,
    })),
    restored: { markdown: 0, sources: 0, docs: 0 },
    quarantined: { docs: 0, sources: 0, dir: "" },
    warnings,
    elapsedMs: Date.now() - started,
  };
  if (dryRun) return base;

  // 恢复前留档：默认只含清单+markdown（快照本身默认不含 sources）。
  let preRestore = null;
  if (keepPreRestoreSnapshot) {
    try {
      preRestore = await snapshotKb(kbDir, currentManifest, {
        label: `before-restore-${isoStamp(now)}`,
        includeSources: includeSources === true,
      });
    } catch (error) {
      warnings.push(`恢复前自动快照失败（继续恢复）：${String(error?.message ?? error)}`);
    }
  }

  const stamp = isoStamp(now);
  const stagingRoot = join(kbDir, "import-tmp", `restore-${randomBytes(6).toString("hex")}`);
  const quarantineRoot = join(kbDir, "trash-restore", stamp);
  let restoredMarkdown = 0;
  let restoredSources = 0;
  let quarantinedDocs = 0;
  let quarantinedSources = 0;
  try {
    await mkdir(stagingRoot, { recursive: true });
    // 解压在锁外
    for (const doc of snapshotManifest.docs ?? []) {
      const names = inspected.markdownEntries.get(doc.id) ?? [];
      for (const name of names) {
        const rel = name.slice(`markdown/${doc.id}/`.length);
        assertSafeEntryName(rel);
        await extractFile(inspected, name, join(stagingRoot, "markdown", doc.id, rel));
      }
    }
    const restoreSourceIds = includeSources ? [...inspected.sourceEntries.keys()] : [];
    for (const id of restoreSourceIds) {
      const name = inspected.sourceEntries.get(id);
      const dest = join(stagingRoot, "sources", `${id}${safeExt(name)}`);
      await extractFile(inspected, name, dest);
    }

    await withManifestLock(kbDir, async () => {
      const fresh = await readManifest(kbDir);
      const snapIds = new Set((snapshotManifest.docs ?? []).map((doc) => doc.id));
      if (prune) {
        for (const doc of fresh.docs ?? []) {
          if (snapIds.has(doc.id)) continue;
          // 快照之外的文档：markdown 与 sources 都移到 trash-restore，不永久删。
          await mkdir(join(kbDir, "markdown"), { recursive: true });
          const srcDir = join(kbDir, "markdown", doc.id);
          try {
            await access(srcDir);
            await moveAside(srcDir, join(quarantineRoot, "markdown", doc.id));
            quarantinedDocs += 1;
          } catch {
            /* 没有派生正文 */
          }
          try {
            const sourceNames = await listSourcesFor(kbDir, doc.id);
            for (const name of sourceNames) {
              await moveAside(join(kbDir, "sources", name), join(quarantineRoot, "sources", name));
              quarantinedSources += 1;
            }
          } catch {
            /* 没有原件 */
          }
        }
      }
      for (const doc of snapshotManifest.docs ?? []) {
        const staged = join(stagingRoot, "markdown", doc.id);
        let hasStaged = false;
        try {
          await access(staged);
          hasStaged = true;
        } catch {
          hasStaged = false;
        }
        if (!hasStaged) continue;
        await rm(join(kbDir, "markdown", doc.id), { recursive: true, force: true });
        await mkdir(join(kbDir, "markdown"), { recursive: true });
        await rename(staged, join(kbDir, "markdown", doc.id));
        restoredMarkdown += 1;
      }
      if (includeSources && restoreSourceIds.length > 0) {
        await mkdir(join(kbDir, "sources"), { recursive: true });
        for (const id of restoreSourceIds) {
          const staged = join(stagingRoot, "sources", `${id}${safeExt(inspected.sourceEntries.get(id))}`);
          try {
            await access(staged);
          } catch {
            continue;
          }
          for (const name of await listSourcesFor(kbDir, id)) {
            await rm(join(kbDir, "sources", name), { force: true });
          }
          await rename(staged, join(kbDir, "sources", basename(staged)));
          restoredSources += 1;
        }
      }
      // 以快照清单为准（保留库名/描述/标签等顶层字段由快照决定）。
      const next = { ...snapshotManifest, name: currentManifest.name };
      await writeManifestAtomic(kbDir, next);
    });

    await refreshKbIndex(kbDir);
    const manifest = await readManifest(kbDir);
    let fts = "skipped";
    try {
      const live = liveDocs(manifest);
      if (live.length > FTS_BACKGROUND_DOCS) {
        const startedFts = await startBackgroundFtsBuild(kbDir);
        fts = startedFts?.started ? "background" : "skipped";
      } else {
        const built = await buildFtsIndex(kbDir, manifest, { force: true });
        fts = built?.ok ? "sync" : "skipped";
      }
    } catch {
      fts = "skipped";
    }
    await appendLog(kbDir, {
      action: "snapshot-restore",
      title: inspected.filename,
      detail: `恢复 ${restoredMarkdown} 篇 markdown、${restoredSources} 份原件；隔离 ${quarantinedDocs} 篇/${quarantinedSources} 份原件${preRestore ? `；恢复前快照 ${preRestore.name}` : ""}`,
    });
    return {
      ...base,
      dryRun: false,
      restored: { markdown: restoredMarkdown, sources: restoredSources, docs: manifest.docs?.length ?? 0 },
      quarantined: {
        docs: quarantinedDocs,
        sources: quarantinedSources,
        ...(quarantinedDocs + quarantinedSources > 0
          ? { dir: `trash-restore/${stamp}` }
          : { dir: "" }),
      },
      preRestoreSnapshot: preRestore ? { name: preRestore.name, bytes: preRestore.bytes } : null,
      ftsRebuilt: fts,
      warnings,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function listSourcesFor(kbDir, docId) {
  try {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(join(kbDir, "sources"));
    return names.filter((name) => name === docId || name.startsWith(`${docId}.`));
  } catch {
    return [];
  }
}

/** 工具层渲染。 */
export function renderSnapshotRestore(value) {
  if (value?.list) {
    if (!value.snapshots?.length) return `知识库「${value.kb}」还没有快照。`;
    const lines = [`知识库「${value.kb}」快照（${value.snapshots.length} 个，按时间倒序）：`];
    for (const item of value.snapshots.slice(0, 20)) {
      lines.push(
        `- ${item.name}  ${Math.round((item.bytes ?? 0) / 1024)} KB  ${item.docs ?? 0} 篇${item.includeSources ? "（含 sources）" : ""}`
      );
    }
    return lines.join("\n");
  }
  const c = value.counts ?? {};
  const head = value.dryRun
    ? `快照恢复预演（未写入）：「${value.snapshot?.name}」→「${value.kb}」`
    : `已从快照「${value.snapshot?.name}」恢复知识库「${value.kb}」`;
  const lines = [
    `${head}：新增 ${c.added ?? 0} 篇、移除 ${c.removed ?? 0} 篇、变更 ${c.changed ?? 0} 篇、未变 ${c.unchanged ?? 0} 篇（快照 ${c.snapshot ?? 0} 篇 / 当前 ${c.current ?? 0} 篇）。`,
  ];
  if (!value.dryRun) {
    lines.push(
      `实际恢复 ${value.restored?.markdown ?? 0} 篇 markdown${value.restored?.sources ? `、${value.restored.sources} 份原件` : ""}；隔离 ${value.quarantined?.docs ?? 0} 篇/${value.quarantined?.sources ?? 0} 份原件${value.quarantined?.dir ? `（${value.quarantined.dir}）` : ""}。`
    );
    if (value.preRestoreSnapshot) lines.push(`恢复前快照：${value.preRestoreSnapshot.name}`);
    if (value.ftsRebuilt === "background") lines.push("全文索引正在后台重建。");
  }
  if (value.added?.length) lines.push(`新增示例：${value.added.slice(0, 5).map((doc) => doc.title).join("、")}`);
  if (value.removed?.length) lines.push(`移除示例：${value.removed.slice(0, 5).map((doc) => doc.title).join("、")}`);
  if (value.warnings?.length) {
    lines.push(`提示 ${value.warnings.length} 条：`);
    for (const warning of value.warnings.slice(0, 10)) lines.push(`- ${warning}`);
  }
  lines.push(`用时 ${Math.round((value.elapsedMs ?? 0) / 1000)} 秒。`);
  return lines.join("\n");
}
