/**
 * 工作台「导出知识库」弹窗：正文包 / 完整包 / 单文件 Markdown。
 * 后端后台生成，前端轮询 job；完成后给下载链接。
 */
import { api, ApiError } from "../api.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function errorText(error) {
  return error instanceof ApiError ? error.message : String(error?.message ?? error);
}

const OPTIONS = [
  { id: "zip", label: "正文包（.zip，不含原件）", detail: "最小、最快；换机后原件需另行准备", includeSources: false },
  { id: "zip-sources", label: "完整包（.zip，含原件）", detail: "可完整迁移；库大时可能有数 GB", includeSources: true },
  { id: "md", label: "单文件 Markdown", detail: "适合直接上传给对话产品阅读", includeSources: false },
];

export function exportOptionBody(option) {
  if (option === "md") return { format: "md" };
  return { format: "zip", includeSources: option === "zip-sources" };
}

export function openExportModal({ name, notify = () => {}, onFinished = () => {} } = {}) {
  const node = document.createElement("div");
  node.className = "overlay";
  node.innerHTML = `<div class="modal" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(node);
  const modal = node.querySelector(".modal");

  const state = {
    phase: "choose",
    choice: "zip",
    job: null,
    jobId: "",
    error: "",
    timer: null,
    closed: false,
  };

  function close() {
    if (state.closed) return;
    state.closed = true;
    if (state.timer) clearTimeout(state.timer);
    document.removeEventListener("keydown", onKeydown);
    node.remove();
    onFinished();
  }

  function onKeydown(event) {
    if (event.key === "Escape") close();
  }
  document.addEventListener("keydown", onKeydown);

  function render() {
    if (state.closed) return;
    if (state.phase === "choose") modal.innerHTML = chooseHtml();
    else if (state.phase === "running") modal.innerHTML = runningHtml();
    else modal.innerHTML = doneHtml();
    bind();
  }

  function chooseHtml() {
    return `<div class="modal-form">
      <h2>导出「${escapeHtml(name)}」</h2>
      <p class="muted">导出在后台生成，完成后点下载；文件会保存在知识库 exports/ 目录。</p>
      <div class="package-modes">
        ${OPTIONS.map((option) => `<label class="package-mode">
          <input type="radio" name="export-choice" value="${option.id}" ${state.choice === option.id ? "checked" : ""} />
          <span><strong>${escapeHtml(option.label)}</strong><br /><span class="muted">${escapeHtml(option.detail)}</span></span>
        </label>`).join("")}
      </div>
      ${state.error ? `<p class="form-error">${escapeHtml(state.error)}</p>` : ""}
      <div class="modal-actions">
        <button type="button" class="btn primary" data-start>开始导出</button>
        <button type="button" class="btn" data-close>取消</button>
      </div>
    </div>`;
  }

  function runningHtml() {
    const progress = state.job?.progress ?? {};
    const phase = progress.phase === "done" ? "收尾" : "正在生成";
    return `<div class="modal-form">
      <h2>正在导出「${escapeHtml(name)}」</h2>
      <div class="progress-line"><strong>${escapeHtml(phase)}</strong>
        <span class="muted">${Number(progress.done) || 0}/${Number(progress.total) || 1}</span>
      </div>
      <p class="muted">大库（含原件）可能需要几十秒，可关闭弹窗；导出任务会继续。</p>
      <div class="modal-actions"><button type="button" class="btn" data-close>关闭</button></div>
    </div>`;
  }

  function doneHtml() {
    const job = state.job ?? {};
    const result = job.result ?? {};
    if (job.status !== "succeeded") {
      return `<div class="modal-form">
        <h2>导出失败</h2>
        <p class="form-error">${escapeHtml(job.detail || "未知错误")}</p>
        <div class="modal-actions"><button type="button" class="btn" data-close>关闭</button></div>
      </div>`;
    }
    const href = result.url ? api.exportUrl(name, result.fileName) : "#";
    return `<div class="modal-form">
      <h2>导出完成</h2>
      <p>${escapeHtml(result.docs ?? 0)} 篇 · ${formatBytes(result.bytes)} · ${escapeHtml(result.fileName ?? "")}</p>
      <div class="modal-actions">
        <a class="btn primary" href="${escapeHtml(href)}" download>下载文件</a>
        <button type="button" class="btn" data-close>关闭</button>
      </div>
    </div>`;
  }

  function bind() {
    modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
    modal.querySelectorAll("input[name='export-choice']").forEach((input) => input.addEventListener("change", () => {
      state.choice = input.value;
    }));
    modal.querySelector("[data-start]")?.addEventListener("click", () => { void start(); });
  }

  async function start() {
    state.phase = "running";
    state.error = "";
    render();
    try {
      const started = await api.exportKb(name, exportOptionBody(state.choice));
      state.jobId = started?.jobId;
      if (!state.jobId) throw new Error("导出任务没有返回 jobId");
      await poll();
    } catch (error) {
      state.phase = "choose";
      state.error = errorText(error);
      render();
    }
  }

  async function poll() {
    if (state.closed) return;
    try {
      const job = await api.job(state.jobId);
      state.job = job;
      if (state.closed) return;
      if (job?.status === "running") {
        render();
        state.timer = setTimeout(() => { void poll(); }, 1000);
        return;
      }
      state.phase = "done";
      notify(job?.status === "succeeded" ? "导出完成" : "导出失败", job?.status === "succeeded" ? "info" : "error");
      render();
    } catch (error) {
      state.phase = "done";
      state.job = { status: "failed", detail: errorText(error) };
      render();
    }
  }

  render();
}
