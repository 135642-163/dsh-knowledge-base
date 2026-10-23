/**
 * 工作台后台任务注册表（进程内 Map）。
 * 不复用宿主 jobs：宿主 jobs 归属 agent 会话，HTTP 工作台没有会话归属。
 * - start() 立即返回 id；run(ctx) 在任务结束时 resolve { status, detail, result }；
 * - import 任务的 progress 从 progressFile 读，std 任务由 setProgress 推；
 * - 已结算任务保留 1 小时；对外投影不含 progressFile/handle 等内部字段。
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_RETENTION_MS = 3600_000;
const DEFAULT_MAX_JOBS = 200;
const RUNNING = "running";

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

export function createJobRegistry({ retentionMs = DEFAULT_RETENTION_MS, maxJobs = DEFAULT_MAX_JOBS, now = Date.now } = {}) {
  const records = new Map();
  let counter = 0;

  function prune() {
    const cutoff = now() - retentionMs;
    for (const [id, rec] of records) {
      if (rec.status !== RUNNING && rec.finishedAt !== null && rec.finishedAt < cutoff) records.delete(id);
    }
    if (records.size <= maxJobs) return;
    const settled = [...records.values()]
      .filter((rec) => rec.status !== RUNNING)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const rec of settled) {
      if (records.size <= maxJobs) break;
      records.delete(rec.id);
    }
  }

  function toPublic(rec, progress) {
    return {
      id: rec.id,
      kind: rec.kind,
      kb: rec.kb,
      label: rec.label,
      status: rec.status,
      detail: rec.detail,
      startedAt: iso(rec.startedAt),
      finishedAt: iso(rec.finishedAt),
      progress: progress ?? rec.progress,
      result: rec.result,
    };
  }

  async function readProgress(rec) {
    if (!rec.progressFile) return rec.progress;
    try {
      const parsed = JSON.parse(await readFile(rec.progressFile, "utf8"));
      return { kind: "import", ...parsed };
    } catch {
      return rec.progress;
    }
  }

  async function get(id) {
    prune();
    const rec = records.get(String(id ?? ""));
    if (!rec) return null;
    return toPublic(rec, await readProgress(rec));
  }

  async function list({ kb, kind, limit = 20 } = {}) {
    prune();
    const max = Math.max(1, Math.min(50, Math.round(Number(limit) || 20)));
    return [...records.values()]
      .filter((rec) => (kb === undefined || rec.kb === kb) && (kind === undefined || rec.kind === kind))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, max)
      .map((rec) => toPublic(rec));
  }

  function start({ kind, kb, label, run, onSettle }) {
    prune();
    counter += 1;
    const id = `${kind}-${counter.toString(36)}-${randomBytes(2).toString("hex")}`;
    const rec = {
      id,
      kind,
      kb,
      label,
      status: RUNNING,
      detail: "",
      startedAt: now(),
      finishedAt: null,
      progress: null,
      result: null,
      progressFile: null,
      handle: null,
      onSettle,
    };
    records.set(id, rec);
    const ctx = {
      id,
      setProgressFile(file) { rec.progressFile = String(file); },
      setProgress(progress) { rec.progress = progress; },
      setHandle(handle) { rec.handle = handle; },
    };
    Promise.resolve()
      .then(() => run(ctx))
      .then(async (outcome) => {
        const final = outcome ?? {};
        rec.status = final.status === "failed" ? "failed" : "succeeded";
        rec.detail = String(final.detail ?? "");
        rec.result = final.result ?? null;
        rec.progress = null;
        rec.finishedAt = now();
        try {
          await onSettle?.(rec);
        } catch (error) {
          rec.detail = `${rec.detail}${rec.detail ? "；" : ""}收尾失败：${String(error?.message ?? error)}`;
        }
      })
      .catch((error) => {
        rec.status = "failed";
        rec.detail = String(error?.message ?? error);
        rec.finishedAt = now();
      });
    return id;
  }

  function cancelAll() {
    for (const rec of records.values()) {
      if (rec.status === RUNNING) rec.handle?.cancel?.();
    }
  }

  return { start, get, list, cancelAll };
}
