/**
 * 工作台后台任务注册表（进程内 Map）。
 * 不复用宿主 jobs：宿主 jobs 归属 agent 会话，HTTP 工作台没有会话归属。
 * - start() 立即返回 id；run(ctx) 在任务结束时 resolve { status, detail, result }；
 * - import 任务的 progress 从 progressFile 读，std 任务由 setProgress 推；
 * - 结算契约：成功、失败、取消（cancelled）与 run() 抛错都走同一条 finish 路径，
 *   onSettle(settleView) 恰好调用一次，且在任务对 get()/list() 可见为已结算之前调用；
 *   settleView = { id, kind, kb, status, detail, result }；hook 抛错只追加到 detail；
 * - 已结算任务保留 1 小时；对外投影不含 progressFile/handle 等内部字段，
 *   结算时把最后一份 progress 快照留在 progressCache，供后续 get() 读取。
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_RETENTION_MS = 3600_000;
const DEFAULT_MAX_JOBS = 200;
const RUNNING = "running";
const SUCCEEDED_STATUSES = new Set(["succeeded", "completed"]);
const FAILED_STATUSES = new Set(["failed", "cancelled"]);

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 只接受 { status, detail, result } 形态；runner handle 等一律判为无效结果。 */
function normalizeOutcome(outcome) {
  if (isObject(outcome) && typeof outcome.status === "string") {
    if (SUCCEEDED_STATUSES.has(outcome.status)) {
      return { status: "succeeded", detail: String(outcome.detail ?? ""), result: outcome.result ?? null };
    }
    if (FAILED_STATUSES.has(outcome.status)) {
      return { status: "failed", detail: String(outcome.detail ?? ""), result: outcome.result ?? null };
    }
  }
  const base = isObject(outcome) ? String(outcome.detail ?? "") : "";
  const shown = isObject(outcome) ? outcome.status : outcome;
  const marker = `run() 未返回有效结果（status=${String(shown)}）`;
  return { status: "failed", detail: base ? `${base}；${marker}` : marker, result: null };
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
      progress,
      result: rec.result,
    };
  }

  async function readProgress(rec) {
    if (!rec.progressFile) return rec.progress;
    try {
      const parsed = JSON.parse(await readFile(rec.progressFile, "utf8"));
      if (!isObject(parsed)) return rec.progress;
      rec.progress = { ...parsed, kind: "import" };
      return rec.progress;
    } catch {
      return rec.progress;
    }
  }

  async function get(id) {
    prune();
    const rec = records.get(String(id ?? ""));
    if (!rec) return null;
    const progress = rec.status === RUNNING ? await readProgress(rec) : rec.progressCache;
    return toPublic(rec, progress);
  }

  async function list({ kb, kind, limit = 20 } = {}) {
    prune();
    const max = Math.max(1, Math.min(50, Math.round(Number(limit) || 20)));
    const selected = [...records.values()]
      .filter((rec) => (kb === undefined || rec.kb === kb) && (kind === undefined || rec.kind === kind))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, max);
    return Promise.all(
      selected.map(async (rec) => {
        const progress = rec.status === RUNNING ? await readProgress(rec) : null;
        return toPublic(rec, progress);
      }),
    );
  }

  async function finish(rec, outcome) {
    const final = normalizeOutcome(outcome);
    rec.detail = final.detail;
    rec.result = final.result;

    // 结算前抓取最后一份进度；之后只保留内存快照，不再持有或读取 progressFile。
    rec.progressCache = (await readProgress(rec)) ?? null;
    rec.progress = null;
    rec.progressFile = null;

    const hook = rec.onSettle;
    rec.onSettle = null;
    if (hook) {
      try {
        await hook({
          id: rec.id,
          kind: rec.kind,
          kb: rec.kb,
          status: final.status,
          detail: rec.detail,
          result: rec.result,
        });
      } catch (error) {
        rec.detail = `${rec.detail}${rec.detail ? "；" : ""}收尾失败：${String(error?.message ?? error)}`;
      }
    }

    rec.status = final.status;
    rec.finishedAt = now();
    rec.handle = null;
    rec.cancelRequested = false;
    rec.onSettle = null;
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
      progressCache: null,
      result: null,
      progressFile: null,
      handle: null,
      cancelRequested: false,
      onSettle,
    };
    records.set(id, rec);
    const ctx = {
      id,
      setProgressFile(file) { rec.progressFile = String(file); },
      setProgress(progress) { rec.progress = progress; },
      setHandle(handle) {
        rec.handle = handle;
        if (!rec.cancelRequested) return;
        rec.cancelRequested = false;
        try {
          handle?.cancel?.();
        } catch {
          /* 取消是尽力而为，不能打断 run() 的结算。 */
        }
      },
    };
    Promise.resolve()
      .then(() => run(ctx))
      .then(
        (outcome) => finish(rec, outcome),
        (error) => finish(rec, { status: "failed", detail: String(error?.message ?? error), result: null }),
      );
    return id;
  }

  function cancelAll() {
    for (const rec of records.values()) {
      if (rec.status !== RUNNING) continue;
      if (!rec.handle) {
        rec.cancelRequested = true;
        continue;
      }
      try {
        rec.handle.cancel?.();
      } catch {
        /* 单个 handle 抛错不能中断其他任务的取消。 */
      }
    }
  }

  function hasRunning({ kb, kind } = {}) {
    for (const rec of records.values()) {
      if (rec.status !== RUNNING) continue;
      if (kb !== undefined && rec.kb !== kb) continue;
      if (kind !== undefined && rec.kind !== kind) continue;
      return true;
    }
    return false;
  }

  return { start, get, list, cancelAll, hasRunning };
}
