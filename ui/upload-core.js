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

/**
 * 临时/锁文件判定：与服务端 lib/temp-files.js 同一规则。工作台是零构建静态
 * 目录（/kb/ 只服务 ui/），不能直接 import lib/，因此保留这份无依赖实现；
 * test/temp-files.test.mjs 会校验两份实现一致。
 */
export function isTempFileName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop().toLowerCase();
  if (base === "") return false;
  if (base.startsWith("~$")) return true;
  if (base.startsWith(".~lock.")) return true;
  return base === "thumbs.db" || base === "desktop.ini" || base === ".ds_store";
}

export function classifyFiles(entries, limits = {}) {
  const maxBytes = Number(limits.maxBytes) || 0;
  const maxFiles = Number(limits.maxFiles) || 0;
  const extensions = Array.isArray(limits.extensions) ? limits.extensions.map((ext) => ext.toLowerCase()) : [];
  const accepted = [];
  const rejected = [];
  const skipped = [];

  for (const entry of entries) {
    const file = entry?.file ?? entry;
    const path = relPathFor(file);
    const size = Number(entry?.size ?? file?.size ?? 0);
    // 临时/锁文件不进入 rejected：目录上传时静默跳过并汇总数量，避免逐文件报错。
    if (isTempFileName(path)) {
      skipped.push({ path, size });
      continue;
    }
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
  return { accepted, rejected, skipped };
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
  uploaded: "已上传，待解析",
  queued: "等待解析",
  parsing: "解析中",
  parsed: "已解析",
  failed: "失败",
  rejected: "已跳过",
  ok: "已解析",
  skipped: "跳过",
};

/** 逐文件状态文案：上传阶段与解析阶段分开，不能把“已上传”说成“已完成”。 */
export function fileStageLabel(item, phase = "") {
  const stage = String(item?.stage ?? "");
  if (stage === "parsing") return "解析中";
  if (stage === "parsed") return "已解析";
  if (stage === "skipped") {
    return item?.reason === "duplicate" || /duplicate|重复/.test(String(item?.reason ?? ""))
      ? "重复跳过"
      : "导入中跳过";
  }
  if (stage === "failed") return "解析失败";
  const status = String(item?.status ?? "");
  if (status === "skipped") {
    return item?.reason === "duplicate" || /duplicate|重复/.test(String(item?.reason ?? ""))
      ? "重复跳过"
      : "导入中跳过";
  }
  if (status === "failed" && phase === "uploading") return "上传失败";
  if (status === "failed") return "解析失败";
  return statusLabel(status);
}

/** 顶部阶段标题：明确“上传”与“解析”的边界。 */
export function uploadPhaseTitle(state = {}) {
  const phase = String(state.phase ?? "");
  const kb = state.kb ? ` · ${state.kb}` : "";
  if (phase === "uploading") return "上传中（文件尚未解析）";
  if (phase === "starting") return "文件已上传，正在启动解析…";
  if (phase === "importing") return `解析中${kb}`;
  if (phase === "done") return `解析完成${kb}`;
  if (phase === "empty") return "没有新资料（全部重复）";
  if (phase === "error") {
    const files = Array.isArray(state.files) ? state.files : [];
    const uploadFailed = files.some((item) => item.status === "failed" && !item.stage);
    const uploaded = files.filter((item) => item.status === "uploaded").length;
    return uploadFailed && uploaded === 0 ? "上传失败" : "上传完成，解析未完成";
  }
  return "上传资料";
}

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
  starting: { started: "importing", empty: "empty", failed: "error" },
  importing: { settled: "done", failed: "error" },
};

export function nextPhase(phase, event) {
  return TRANSITIONS[phase]?.[event] ?? phase;
}
