/**
 * 上传弹窗：自管理 DOM / XHR / 轮询，上传期间不触发工作台的整页 render()。
 *
 * 流程与状态机（upload-core.nextPhase）：
 *   select --start--> uploading --uploaded--> starting --started--> importing --settled--> done
 *                                                         └--failed--> error
 * 关闭弹窗时：上传中会 abort 所有 XHR；已锁定导入的任务不取消（jobId 记在
 * localStorage，下次打开该库的上传弹窗时恢复进度）。
 */
import { api, ApiError } from "../api.js";
import { classifyFiles, createQueue, formatBytes, nextPhase, statusLabel, summarizeResults } from "../upload-core.js";

const DIRECTORY_HINT = "暂不支持拖拽文件夹，请用「选择目录」";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function errorText(error) {
  return error instanceof ApiError ? error.message : String(error?.message ?? error);
}

/** `/status.limits` 是原始字段，批次响应是归一化字段；两种都接受。 */
function mapLimits(raw) {
  if (!raw) return null;
  return {
    maxBytes: Number(raw.maxBytes ?? raw.maxUploadBytes) || 0,
    maxFiles: Number(raw.maxFiles ?? raw.maxBatchFiles) || 0,
    extensions: Array.isArray(raw.extensions) ? raw.extensions.map(String) : [],
  };
}

export function openUploadModal({ kbs = [], kb = "", onFinished } = {}) {
  const node = document.createElement("div");
  node.className = "overlay";
  node.innerHTML = `<div class="modal modal-wide" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(node);
  const modal = node.querySelector(".modal");

  const state = {
    phase: "select",
    limits: null,
    kb: kb || kbs[0]?.name || "",
    files: [],
    rejected: [],
    batchId: null,
    jobId: null,
    job: null,
    error: "",
    timer: null,
    abort: null,
    closed: false,
    importStarted: false,
    allowCrossDuplicates: false,
    ocrModel: "best",
  };

  const resumeKey = () => `kb.upload.job.${state.kb}`;
  function remember(jobId) {
    try { localStorage.setItem(resumeKey(), jobId); } catch { /* 隐私模式下忽略 */ }
  }
  function forget() {
    try { localStorage.removeItem(resumeKey()); } catch { /* ignore */ }
  }

  function stopPolling() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function close() {
    if (state.closed) return;
    state.closed = true;
    stopPolling();
    state.abort?.abort();
    // 只丢弃还没开始导入的 open 批次；导入中的批次由后端保留（失败/跳过时供重试）。
    if (state.batchId && !state.importStarted) {
      api.deleteBatch(state.batchId).catch(() => {});
    }
    // 仍在后台跑的任务记下来，下次打开时恢复；已结算的任务不再恢复。
    if (state.jobId && (state.phase === "importing" || state.job?.status === "running")) remember(state.jobId);
    node.remove();
    onFinished?.();
  }

  function render() {
    if (state.closed) return;
    modal.innerHTML = state.phase === "select" ? selectHtml() : progressHtml();
    bind();
  }

  function limitsHint() {
    const limits = state.limits;
    if (!limits) return "读取上传限制中…";
    if (limits.maxBytes > 0 && limits.maxFiles > 0) {
      return `单文件 ≤ ${formatBytes(limits.maxBytes)}，最多 ${limits.maxFiles} 个文件`;
    }
    if (limits.maxBytes > 0) return `单文件 ≤ ${formatBytes(limits.maxBytes)}`;
    if (limits.maxFiles > 0) return `最多 ${limits.maxFiles} 个文件`;
    return "读取上传限制中…";
  }

  function selectHtml() {
    return `
      <div class="modal-form">
        <h2>上传资料</h2>
        <label class="field"><span>目标库</span>
          <select id="upload-kb" ${kb ? "disabled" : ""}>
            ${kbs.map((item) => `<option value="${escapeAttr(item.name)}" ${item.name === state.kb ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
          </select>
        </label>
        <div class="dropzone" id="upload-drop">
          <p>把文件拖到这里</p>
          <div class="dropzone-actions">
            <button type="button" class="btn" data-pick="files">选择文件</button>
            <button type="button" class="btn" data-pick="dir">选择目录</button>
          </div>
          <p class="muted">${escapeHtml(limitsHint())}</p>
        </div>
        <div class="uplist">
          ${state.files.map((item) => `<div class="uprow"><span class="upname" title="${escapeAttr(item.path)}">${escapeHtml(item.path)}</span><span class="muted">${formatBytes(item.size)}</span></div>`).join("")}
          ${state.rejected.map((item) => `<div class="uprow rejected"><span class="upname" title="${escapeAttr(item.path)}">${escapeHtml(item.path)}</span><span class="badge warn">${escapeHtml(item.reason)}</span></div>`).join("")}
        </div>
        <div class="form-row">
          <label class="check"><input type="checkbox" id="upload-dup" ${state.allowCrossDuplicates ? "checked" : ""} /> 允许跨库重复</label>
          <span class="muted">OCR</span>
          <label class="check"><input type="radio" name="ocr" value="best" ${state.ocrModel === "best" ? "checked" : ""} /> best</label>
          <label class="check"><input type="radio" name="ocr" value="fast" ${state.ocrModel === "fast" ? "checked" : ""} /> fast</label>
        </div>
        <p class="form-error" ${state.error ? "" : "hidden"}>${escapeHtml(state.error)}</p>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>取消</button>
          <button type="button" class="btn primary" data-start ${state.files.length === 0 ? "disabled" : ""}>开始上传</button>
        </div>
      </div>`;
  }

  function progressHtml() {
    const done = state.job?.progress ?? null;
    const result = state.job?.result ?? null;
    const summary = summarizeResults(result);
    const phaseText = {
      uploading: "上传中",
      starting: "正在启动导入",
      importing: "导入中",
      done: "导入完成",
      error: "出错",
    }[state.phase] ?? state.phase;
    const failedUploads = state.files.filter((item) => item.status === "failed");
    const duplicates = Array.isArray(result?.duplicates) ? result.duplicates : [];
    const similar = Array.isArray(result?.similar) ? result.similar : [];
    const retryable = retryCandidates();
    const jobRunning = state.job?.status === "running";

    const actions = [];
    if (state.phase === "uploading" || state.phase === "starting") {
      actions.push(`<button type="button" class="btn" data-close>取消上传</button>`);
    } else if (state.phase === "importing") {
      actions.push(`<button type="button" class="btn" data-close>关闭（后台继续导入）</button>`);
    } else if (state.phase === "done" || state.phase === "error") {
      if (!jobRunning && retryable.length > 0) {
        const retryLabel = summary.skipped > 0 ? "重试失败/跳过项" : "重试失败项";
        actions.push(`<button type="button" class="btn" data-retry>${retryLabel}</button>`);
      }
      if (state.phase === "done") {
        actions.push(`<button type="button" class="btn" data-action="view">刷新并查看资料</button>`);
      }
      actions.push(`<button type="button" class="btn${state.phase === "done" ? " primary" : ""}" data-close>关闭</button>`);
    }

    return `
      <div class="modal-form">
        <h2>${escapeHtml(phaseText)} · ${escapeHtml(state.kb)}</h2>
        ${state.error ? `<p class="form-error">${escapeHtml(state.error)}</p>` : ""}
        ${state.phase === "uploading" ? `<div class="uplist">${state.files.map((item) => `
          <div class="uprow bar">
            <span class="upname" title="${escapeAttr(item.path)}">${escapeHtml(item.path)}</span>
            <span class="upbar"><i style="width:${Math.max(0, Math.min(100, Math.round((item.percent ?? 0) * 100)))}%"></i></span>
            <span class="muted">${escapeHtml(statusLabel(item.status))}${item.error ? `：${escapeHtml(item.error)}` : ""}</span>
          </div>`).join("")}</div>` : ""}
        ${state.phase === "starting" ? `<p class="muted">正在创建导入任务…</p>` : ""}
        ${state.phase === "importing" && done ? `
          <div class="progress-line"><strong>${done.done ?? 0}/${done.total ?? 0}</strong>
            <span class="muted">成功 ${done.ok ?? 0} · 失败 ${done.fail ?? 0} · 跳过 ${done.skip ?? 0}</span></div>
          <p class="muted">${escapeHtml(done.current ?? "")}</p>
          <div class="uplist">${(done.files ?? []).map((item) => `
            <div class="uprow"><span class="upname" title="${escapeAttr(item.path)}">${escapeHtml(item.path)}</span><span class="muted">${escapeHtml(statusLabel(item.status))}</span></div>`).join("")}</div>
          <p class="muted">可关闭窗口，导入会在后台继续；重新打开会自动恢复进度。</p>` : ""}
        ${state.phase === "importing" && !done ? `<p class="muted">正在读取进度…</p>` : ""}
        ${(state.phase === "done" || state.phase === "error") ? `
          ${summary.files.length > 0 ? `
            <div class="progress-line"><strong>成功 ${summary.ok} · 失败 ${summary.failed} · 跳过 ${summary.skipped}</strong></div>
            <div class="uplist">${summary.files.map((item) => `
              <div class="uprow"><span class="upname" title="${escapeAttr(item.path ?? item.title ?? "")}">${escapeHtml(item.title || item.path || "")}</span>
                <span class="muted">${escapeHtml(statusLabel(item.status))}${item.status === "skipped" ? "（文档正在导入中）" : ""}${item.error ? `：${escapeHtml(item.error)}` : ""}</span></div>`).join("")}</div>` : ""}
          ${summary.skipped > 0 ? `<p class="muted">${summary.skipped} 个文件因文档正在导入中已跳过，可稍后重试。</p>` : ""}
          ${failedUploads.length > 0 ? `
            <p class="form-error">${failedUploads.length} 个文件上传失败，可用「重试失败项」重新上传。</p>
            <div class="uplist">${failedUploads.map((item) => `
              <div class="uprow"><span class="upname" title="${escapeAttr(item.path)}">${escapeHtml(item.path)}</span>
                <span class="muted">${escapeHtml(item.error || "上传失败")}</span></div>`).join("")}</div>` : ""}
          ${duplicates.length > 0 ? `<p class="muted">重合跳过 ${duplicates.length} 个：${duplicates.map((item) => escapeHtml(item.title ?? "")).join("、")}</p>` : ""}
          ${similar.length > 0 ? `<p class="muted">相似资料 ${similar.length} 个（已照常导入，请留意是否重复）：${similar.map((item) => escapeHtml(item.title ?? "")).join("、")}</p>` : ""}
        ` : ""}
        ${state.phase === "error" && jobRunning ? `<p class="muted">任务仍在后台运行；关闭后重新打开可从本地记录恢复进度。</p>` : ""}
        <div class="modal-actions">${actions.join("")}</div>
      </div>`;
  }

  function retryCandidates() {
    const resultFiles = Array.isArray(state.job?.result?.files) ? state.job.result.files : [];
    const rerun = new Set(
      resultFiles
        .filter((item) => item.status === "failed" || item.status === "skipped")
        .map((item) => String(item.path ?? "")),
    );
    return state.files.filter((item) => item.status === "failed" || rerun.has(item.path));
  }

  function bind() {
    modal.querySelector("[data-close]")?.addEventListener("click", close);
    const kbSelect = modal.querySelector("#upload-kb");
    if (kbSelect) kbSelect.addEventListener("change", (event) => { state.kb = event.target.value; });
    modal.querySelectorAll("[data-pick]").forEach((button) => {
      button.addEventListener("click", () => pick({ directory: button.dataset.pick === "dir" }));
    });
    modal.querySelector("[data-start]")?.addEventListener("click", () => { void startUpload(); });
    modal.querySelector("[data-retry]")?.addEventListener("click", () => retryFailed());
    modal.querySelector("[data-action='view']")?.addEventListener("click", () => {
      close();
      window.location.hash = `#/kb/${encodeURIComponent(state.kb)}/docs`;
    });

    const duplicate = modal.querySelector("#upload-dup");
    if (duplicate) duplicate.addEventListener("change", (event) => { state.allowCrossDuplicates = event.target.checked; });
    modal.querySelectorAll("input[name='ocr']").forEach((input) => {
      input.addEventListener("change", (event) => { if (event.target.checked) state.ocrModel = event.target.value; });
    });

    const dropzone = modal.querySelector("#upload-drop");
    if (dropzone) {
      dropzone.addEventListener("dragover", (event) => { event.preventDefault(); });
      dropzone.addEventListener("drop", (event) => {
        event.preventDefault();
        const items = Array.from(event.dataTransfer?.items ?? []);
        const hasDirectory = items.some((item) => {
          const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
          return entry?.isDirectory === true;
        });
        if (hasDirectory) {
          state.error = DIRECTORY_HINT;
          render();
          return;
        }
        addFiles(Array.from(event.dataTransfer?.files ?? []));
      });
    }
  }

  function pick({ directory }) {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    if (directory) input.webkitdirectory = true;
    const remove = () => input.remove();
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      remove();
      addFiles(files);
    };
    input.addEventListener("cancel", remove, { once: true });
    modal.appendChild(input);
    input.click();
  }

  function addFiles(files) {
    if (state.phase !== "select" || files.length === 0) return;
    const limits = state.limits ?? { maxBytes: 0, maxFiles: 0, extensions: [] };
    const { accepted, rejected } = classifyFiles(files, limits);
    if (accepted.length > 0) state.error = "";
    state.files.push(...accepted.map((item) => ({ ...item, status: "pending", percent: 0, error: "" })));
    state.rejected.push(...rejected);
    if (limits.maxFiles > 0 && state.files.length > limits.maxFiles) {
      const overflow = state.files.splice(limits.maxFiles);
      for (const item of overflow) {
        state.rejected.push({ path: item.path, size: item.size, reason: `超过单批文件数上限 ${limits.maxFiles}` });
      }
    }
    render();
  }

  function applyLimits(raw) {
    state.limits = mapLimits(raw);
    // 限制晚于选文件返回时，按最终限制重筛一遍，避免用户在白名单未知时选中不支持的文件。
    if (state.phase === "select" && state.limits && state.files.length > 0) {
      const { accepted, rejected } = classifyFiles(state.files.map((item) => item.file), state.limits);
      state.files = accepted.map((item) => ({ ...item, status: "pending", percent: 0, error: "" }));
      state.rejected.push(...rejected);
    }
    render();
  }

  async function startUpload() {
    if (state.phase !== "select" || state.importStarted) return;
    if (state.files.length === 0) return;
    if (!state.kb) {
      state.error = "请先选择目标知识库";
      render();
      return;
    }
    state.error = "";
    state.phase = nextPhase(state.phase, "start");
    render();
    try {
      if (!state.batchId) {
        const created = await api.createBatch({ kb: state.kb });
        if (state.closed) {
          api.deleteBatch(created.batch.id).catch(() => {});
          return;
        }
        state.batchId = created.batch.id;
        state.limits = mapLimits(created.limits) ?? state.limits;
      }
      const allowCrossDuplicates = state.allowCrossDuplicates;
      const ocrModel = state.ocrModel;
      const queue = createQueue(2);
      state.abort = new AbortController();
      let lastPaint = 0;
      const paintProgress = () => {
        const now = Date.now();
        if (now - lastPaint < 200) return;
        lastPaint = now;
        render();
      };
      await Promise.all(state.files.map((item) => queue.run(async () => {
        if (state.closed) return;
        if (item.status === "uploaded") return;
        item.status = "uploading";
        item.error = "";
        render();
        try {
          await api.uploadFile(state.batchId, { file: item.file, path: item.path }, {
            onProgress: (value) => { item.percent = value; paintProgress(); },
            signal: state.abort?.signal,
          });
          item.status = "uploaded";
          item.percent = 1;
        } catch (error) {
          item.status = "failed";
          item.error = errorText(error);
        }
        render();
      })));
      if (state.closed) return;
      const failedUploads = state.files.filter((item) => item.status !== "uploaded");
      if (failedUploads.length === state.files.length) {
        state.phase = "error";
        state.error = "全部文件上传失败";
        render();
        return;
      }
      state.phase = nextPhase(state.phase, "uploaded");
      render();
      const imported = await api.importBatch(state.batchId, { allowCrossDuplicates, ocrModel });
      if (state.closed) {
        // 关闭发生在导入请求期间：任务可能已经启动，记下来供下次恢复。
        if (imported.jobId) remember(imported.jobId);
        return;
      }
      if (!imported.jobId) {
        state.importStarted = false;
        state.phase = "done";
        state.job = {
          result: {
            ok: 0,
            fail: 0,
            skip: 0,
            files: [],
            duplicates: imported.duplicates ?? [],
            similar: imported.similar ?? [],
          },
        };
        render();
        onFinished?.();
        return;
      }
      state.importStarted = true;
      state.jobId = imported.jobId;
      remember(state.jobId);
      state.phase = nextPhase(state.phase, "started");
      render();
      void pollJob();
    } catch (error) {
      if (state.closed) return;
      state.phase = "error";
      state.error = errorText(error);
      render();
    }
  }

  async function pollJob() {
    if (state.closed) return;
    stopPolling();
    try {
      const job = await api.job(state.jobId);
      if (state.closed) return;
      state.job = job;
      if (job.status === "running") {
        state.timer = setTimeout(() => { void pollJob(); }, 1000);
        render();
      } else if (job.status === "failed") {
        state.phase = nextPhase(state.phase, "failed");
        state.error = job.detail || "导入任务失败";
        forget();
        render();
        onFinished?.();
      } else {
        state.phase = nextPhase(state.phase, "settled");
        forget();
        render();
        onFinished?.();
      }
    } catch (error) {
      if (state.closed) return;
      state.phase = "error";
      state.error = errorText(error);
      render();
    }
  }

  function retryFailed() {
    const failed = retryCandidates();
    if (failed.length === 0) {
      state.error = "没有可重试的失败文件";
      render();
      return;
    }
    stopPolling();
    state.batchId = null;
    state.jobId = null;
    state.job = null;
    state.phase = "select";
    state.abort = null;
    state.importStarted = false;
    state.files = failed.map((item) => ({ ...item, status: "pending", percent: 0, error: "" }));
    state.rejected = [];
    state.error = "";
    render();
  }

  api.status().then((status) => {
    applyLimits(status?.limits ?? null);
  }).catch(() => {
    applyLimits({ maxBytes: 0, maxFiles: 1000, extensions: [] });
  });

  node.addEventListener("mousedown", (event) => {
    if (event.target === node && state.phase === "select") close();
  });
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.phase === "select") close();
  });

  // 页面刷新/重开后恢复最近一次导入任务（结果保留 1 小时）。
  let resumeId = null;
  try { resumeId = localStorage.getItem(resumeKey()); } catch { resumeId = null; }
  if (resumeId) {
    api.job(resumeId).then((job) => {
      if (state.closed) return;
      state.jobId = job.id;
      state.job = job;
      state.phase = job.status === "running" ? "importing" : job.status === "failed" ? "error" : "done";
      state.error = job.status === "failed" ? (job.detail || "导入任务失败") : "";
      if (job.status === "running") {
        render();
        void pollJob();
      } else {
        forget();
        render();
      }
    }).catch(() => { forget(); });
  }
  render();
}
