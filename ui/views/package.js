/**
 * 工作台「导入知识库包（kbpack）」弹窗：上传 → 预检（同名库三选一）→ 后台导入 → 结果。
 * 自管理 DOM 与轮询，不触发整页 render；bundle 由 build-client 打包。
 */
import { api, ApiError } from "../api.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
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

const MODE_LABELS = { merge: "合并到同名知识库", rename: "另存为新知识库", replace: "覆盖同 id 文档" };

/** 预检结果摘要（纯函数，单测可直接校验转义/字段）。 */
export function packageSummaryHtml(result = {}) {
  const pkg = result.package ?? {};
  const docs = Number(pkg.docs ?? result.total ?? 0);
  const rows = [
    `包：${escapeHtml(pkg.filename ?? "")}`,
    `包内库名：${escapeHtml(pkg.kbName ?? result.kb ?? "")}`,
    `篇数：${docs}${pkg.withSources ? "（含原件）" : "（仅正文）"}`,
    `体积：${formatBytes(pkg.bytes)}`,
  ];
  const counts = result.needsChoice
    ? ""
    : `预检：新建 ${Number(result.created ?? 0)}、覆盖 ${Number(result.replaced ?? 0)}、重映射 ${Number(result.remapped ?? 0)}、跳过 ${Number(result.skipped ?? 0)}`;
  return `<div class="package-summary">
    ${rows.map((row) => `<div class="kv">${row}</div>`).join("")}
    ${counts ? `<p class="muted">${counts}</p>` : ""}
  </div>`;
}

export function openPackageImportModal({ onFinished = () => {}, notify = () => {} } = {}) {
  const node = document.createElement("div");
  node.className = "overlay";
  node.innerHTML = `<div class="modal modal-wide" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(node);
  const modal = node.querySelector(".modal");

  const state = {
    phase: "select",
    file: null,
    progress: 0,
    result: null,
    target: "",
    mode: "merge",
    confirmedReplace: false,
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

  function finish() {
    state.settled = true;
  }

  function onKeydown(event) {
    if (event.key === "Escape") close();
  }
  document.addEventListener("keydown", onKeydown);

  function render() {
    if (state.closed) return;
    if (state.phase === "select" || state.phase === "uploading") modal.innerHTML = selectHtml();
    else if (state.phase === "choose") modal.innerHTML = chooseHtml();
    else if (state.phase === "importing") modal.innerHTML = importingHtml();
    else modal.innerHTML = doneHtml();
    bind();
  }

  function selectHtml() {
    const busy = state.phase === "uploading";
    return `<div class="modal-form">
      <h2>导入知识库包</h2>
      <p class="muted">选择 kbpack 包（kb_export format=zip 产出的 .zip）。上传后先预检；同名库会请你选择合并/另存/覆盖，确认前不写入。</p>
      <label class="field"><span>知识库包（.zip）</span>
        <input type="file" id="pkg-file" accept=".zip,application/zip" ${busy ? "disabled" : ""} />
      </label>
      ${state.file ? `<p class="muted">已选择：${escapeHtml(state.file.name)}（${formatBytes(state.file.size)}）</p>` : ""}
      ${busy ? `<div class="progress-line"><strong>上传中</strong> ${Math.round(state.progress * 100)}%</div>` : ""}
      ${state.error ? `<p class="form-error">${escapeHtml(state.error)}</p>` : ""}
      <div class="modal-actions">
        <button type="button" class="btn primary" data-upload ${!state.file || busy ? "disabled" : ""}>上传并预检</button>
        <button type="button" class="btn" data-close>取消</button>
      </div>
    </div>`;
  }

  function chooseHtml() {
    const result = state.result ?? {};
    const needsChoice = result.needsChoice === true;
    const choices = Array.isArray(result.choices) && result.choices.length > 0
      ? result.choices
      : ["merge", "rename", "replace"].map((mode) => ({ mode, label: MODE_LABELS[mode], description: "" }));
    return `<div class="modal-form">
      <h2>确认导入</h2>
      ${packageSummaryHtml(result)}
      ${needsChoice ? `<p class="muted">本机已存在同名知识库「${escapeHtml(result.kb ?? "")}」，请选择导入方式：</p>` : ""}
      <div class="package-modes">
        ${choices.map((choice) => `<label class="package-mode">
          <input type="radio" name="pkg-mode" value="${escapeAttr(choice.mode)}" ${state.mode === choice.mode ? "checked" : ""} />
          <span><strong>${escapeHtml(choice.label ?? MODE_LABELS[choice.mode] ?? choice.mode)}</strong>
          ${choice.description ? `<br /><span class="muted">${escapeHtml(choice.description)}</span>` : ""}</span>
        </label>`).join("")}
      </div>
      <label class="field"><span>目标知识库名 <span class="muted">（留空 = 用包内库名；rename 冲突自动加后缀）</span></span>
        <input id="pkg-target" maxlength="64" value="${escapeAttr(state.target)}" placeholder="${escapeAttr(result.package?.kbName ?? result.kb ?? "")}" autocomplete="off" />
      </label>
      ${state.mode === "replace" ? `<label class="check"><input type="checkbox" id="pkg-confirm-replace" ${state.confirmedReplace ? "checked" : ""} /> 我确认：同 id 文档将被包内版本覆盖（旧版进 history，包外文档保留）</label>` : ""}
      ${state.error ? `<p class="form-error">${escapeHtml(state.error)}</p>` : ""}
      <div class="modal-actions">
        <button type="button" class="btn primary" data-start ${state.mode === "replace" && !state.confirmedReplace ? "disabled" : ""}>开始导入</button>
        <button type="button" class="btn" data-close>取消</button>
      </div>
    </div>`;
  }

  function importingHtml() {
    const progress = state.job?.progress ?? {};
    const phase = { prepare: "准备", extract: "解压", commit: "落盘", commitDocs: "落盘" }[progress.phase] ?? "导入";
    return `<div class="modal-form">
      <h2>正在导入</h2>
      ${packageSummaryHtml(state.result ?? {})}
      <div class="progress-line"><strong>${escapeHtml(phase)}</strong>
        <span class="muted">${Number(progress.done) || 0}/${Number(progress.total) || 0}${progress.current ? ` · ${escapeHtml(progress.current)}` : ""}</span>
      </div>
      <p class="muted">导入在后台执行，可关闭弹窗稍后在资料列表查看结果。</p>
      <div class="modal-actions"><button type="button" class="btn" data-close>关闭</button></div>
    </div>`;
  }

  function doneHtml() {
    const job = state.job ?? {};
    const result = job.result ?? {};
    const ok = job.status === "succeeded";
    const counts = result.created !== undefined
      ? `新建 ${Number(result.created) || 0}、覆盖 ${Number(result.replaced) || 0}、重映射 ${Number(result.remapped) || 0}、跳过 ${Number(result.skipped) || 0}${result.reparsed ? `、重解析 ${result.reparsed}` : ""}`
      : "";
    return `<div class="modal-form">
      <h2>${ok ? "导入完成" : "导入失败"}</h2>
      <p>${escapeHtml(job.detail ?? "")}</p>
      ${counts ? `<p class="muted">${escapeHtml(counts)}</p>` : ""}
      ${Array.isArray(result.warnings) && result.warnings.length > 0 ? `<ul class="doc-warnings">${result.warnings.slice(0, 10).map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : ""}
      <div class="modal-actions"><button type="button" class="btn primary" data-close>关闭</button></div>
    </div>`;
  }

  function bind() {
    modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
    const fileInput = modal.querySelector("#pkg-file");
    fileInput?.addEventListener("change", () => {
      state.file = fileInput.files?.[0] ?? null;
      state.error = "";
      render();
    });
    modal.querySelector("[data-upload]")?.addEventListener("click", () => { void upload(); });
    modal.querySelectorAll("input[name='pkg-mode']").forEach((input) => input.addEventListener("change", () => {
      state.mode = input.value;
      state.confirmedReplace = false;
      render();
    }));
    modal.querySelector("#pkg-target")?.addEventListener("input", (event) => { state.target = event.target.value; });
    modal.querySelector("#pkg-confirm-replace")?.addEventListener("change", (event) => {
      state.confirmedReplace = event.target.checked;
      render();
    });
    modal.querySelector("[data-start]")?.addEventListener("click", () => { void startImport(); });
  }

  async function upload() {
    if (!state.file) return;
    state.phase = "uploading";
    state.progress = 0;
    state.error = "";
    render();
    try {
      const result = await api.uploadPackage(state.file, {
        onProgress: (value) => {
          state.progress = value;
          if (state.phase === "uploading" && state.closed === false) {
            const line = modal.querySelector(".progress-line");
            if (line) line.innerHTML = `<strong>上传中</strong> ${Math.round(value * 100)}%`;
          }
        },
      });
      state.result = result;
      state.mode = "merge";
      state.target = "";
      state.confirmedReplace = false;
      state.phase = "choose";
      render();
    } catch (error) {
      state.phase = "select";
      state.error = errorText(error);
      render();
    }
  }

  async function startImport() {
    const result = state.result ?? {};
    if (state.mode === "replace" && !state.confirmedReplace) return;
    state.phase = "importing";
    state.error = "";
    render();
    try {
      const body = { mode: state.mode };
      const target = String(state.target ?? "").trim();
      if (target) body.kb = target;
      if (state.mode === "replace") body.confirm = "replace";
      const started = await api.importPackage(result.uploadId, body);
      state.jobId = started?.jobId;
      if (!state.jobId) throw new Error("导入任务没有返回 jobId");
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
        if (state.phase !== "importing") state.phase = "importing";
        render();
        state.timer = setTimeout(() => { void poll(); }, 1000);
        return;
      }
      state.phase = "done";
      notify(job?.status === "succeeded" ? "知识库包导入完成" : "知识库包导入失败", job?.status === "succeeded" ? "info" : "error");
      render();
    } catch (error) {
      state.phase = "done";
      state.job = { status: "failed", detail: errorText(error) };
      render();
    }
  }

  render();
}

export const PACKAGE_MODAL_MODE_LABELS = MODE_LABELS;
