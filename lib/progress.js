/**
 * 导入进度：初始状态与原子写（worker 与工作台共用）。
 */
import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** files = [{ sourceFile?, relKey?, title? }] -> progress 对象 */
export function createProgress(files = []) {
  return {
    done: 0,
    total: files.length,
    ok: 0,
    fail: 0,
    skip: 0,
    current: null,
    files: files.map((f) => ({ path: String(f.sourceFile ?? f.relKey ?? f.title ?? ""), status: "pending" })),
  };
}

/** 写临时文件后 rename 覆盖；失败时清理临时文件并抛出（调用方决定是否 best-effort）。 */
export async function writeProgressFile(progressFile, progress) {
  const tmp = `${progressFile}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ ...progress, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    await rename(tmp, progressFile);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
