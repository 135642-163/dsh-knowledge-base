/**
 * 上传弹窗的纯逻辑（不碰 DOM），供工作台与 node:test 共用。
 */

export function relPathFor(file) {
  const relative = String(file?.webkitRelativePath ?? "");
  if (relative !== "") return relative.normalize("NFC");
  return String(file?.name ?? "").normalize("NFC");
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function extOf(path) {
  const name = String(path ?? "").split("/").pop().toLowerCase();
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}

export function classifyFiles(entries, limits = {}) {
  const maxBytes = Number(limits.maxBytes) || 0;
  const maxFiles = Number(limits.maxFiles) || 0;
  const extensions = Array.isArray(limits.extensions) ? limits.extensions.map((ext) => ext.toLowerCase()) : [];
  const accepted = [];
  const rejected = [];

  for (const entry of entries) {
    const file = entry?.file ?? entry;
    const path = relPathFor(file);
    const size = Number(entry?.size ?? file?.size ?? 0);
    const ext = extOf(path);
    let reason = "";
    if (extensions.length > 0 && !extensions.includes(ext)) {
      reason = `不支持的文件类型（${ext || "无扩展名"}）`;
    } else if (maxBytes > 0 && size > maxBytes) {
      reason = `超过单文件上限 ${formatBytes(maxBytes)}`;
    }
    if (reason) rejected.push({ path, size, reason });
    else accepted.push({ file, path, size });
  }

  if (maxFiles > 0 && accepted.length > maxFiles) {
    for (const item of accepted.splice(maxFiles)) {
      rejected.push({ path: item.path, size: item.size, reason: `超过单批文件数上限 ${maxFiles}` });
    }
  }
  return { accepted, rejected };
}

/** 固定并发队列：download/upload 都按 FIFO 取任务。 */
export function createQueue(concurrency = 2) {
  const limit = Math.max(1, Math.round(Number(concurrency) || 1));
  let active = 0;
  const waiting = [];

  const run = (job) => {
    active += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        const next = waiting.shift();
        if (next) run(next);
      });
  };

  return {
    run(task) {
      return new Promise((resolve, reject) => {
        const job = { task, resolve, reject };
        if (active < limit) run(job);
        else waiting.push(job);
      });
    },
    get active() { return active; },
    get pending() { return waiting.length; },
  };
}

const STATUS_LABELS = {
  pending: "等待",
  uploading: "上传中",
  uploaded: "已上传",
  failed: "失败",
  rejected: "已跳过",
  ok: "成功",
  skipped: "跳过",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status ?? "");
}

export function summarizeResults(result) {
  const files = Array.isArray(result?.files) ? result.files : [];
  const ok = Number(result?.ok) || 0;
  const fail = Number(result?.fail) || 0;
  const skip = Number(result?.skip) || 0;
  return { total: ok + fail + skip, ok, failed: fail, skipped: skip, files };
}

/** 上传弹窗状态机：未声明的 (phase, event) 保持原状态，避免非法跳转把弹窗卡死。 */
const TRANSITIONS = {
  select: { start: "uploading" },
  uploading: { uploaded: "starting" },
  starting: { started: "importing", failed: "error" },
  importing: { settled: "done", failed: "error" },
};

export function nextPhase(phase, event) {
  return TRANSITIONS[phase]?.[event] ?? phase;
}
