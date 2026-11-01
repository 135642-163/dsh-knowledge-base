/**
 * 知识库存储保留策略：只清理插件自己管理的 snapshots/ 与 exports/。
 *
 * - 按文件名倒序（快照/导出名含 ISO 时间戳）保留最近 N 份；
 * - 只删已知扩展名（snapshots: .zip 及其 .zip.json；exports: .md/.jsonl/.zip）；
 * - 不碰目录、其他文件、trash-restore/ 等；
 * - keep <= 0 表示不限制。
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

async function listManaged(dir, pattern) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const path = join(dir, entry.name);
    let bytes = 0;
    try {
      bytes = (await stat(path)).size;
    } catch {
      /* 文件刚被删/不可读 */
    }
    files.push({ name: entry.name, path, bytes });
  }
  return files.sort((a, b) => b.name.localeCompare(a.name, "en"));
}

async function pruneManaged(dir, pattern, keep, dryRun, kind) {
  const files = await listManaged(dir, pattern);
  const limit = Math.max(0, Math.round(Number(keep) || 0));
  if (limit === 0 || files.length <= limit) {
    return { kind, keep: limit, total: files.length, kept: files.length, deleted: [], bytes: 0, dryRun };
  }
  const victims = files.slice(limit);
  let bytes = 0;
  const deleted = [];
  for (const file of victims) {
    if (!dryRun) {
      await rm(file.path, { force: true }).catch(() => {});
      if (kind === "snapshots") await rm(`${file.path}.json`, { force: true }).catch(() => {});
    }
    bytes += file.bytes;
    deleted.push(file.name);
  }
  return { kind, keep: limit, total: files.length, kept: files.length - victims.length, deleted, bytes, dryRun };
}

export async function pruneSnapshots(kbDir, { keep = 20, dryRun = false } = {}) {
  return await pruneManaged(join(kbDir, "snapshots"), /\.zip$/i, keep, dryRun, "snapshots");
}

export async function pruneExports(kbDir, { keep = 20, dryRun = false } = {}) {
  return await pruneManaged(join(kbDir, "exports"), /\.(md|jsonl|zip)$/i, keep, dryRun, "exports");
}
