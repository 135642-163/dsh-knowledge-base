/**
 * 标准更新面板：DOM-free 纯渲染（可在 node:test 直接跑）。
 * 轮询、请求与 state.std 生命周期由 app.js 管理；这里只输出 HTML 与动作标记。
 * 所有动态文本都走 escapeHtml；bzCookie 的实际值永远不进入渲染。
 */

const STATUS_LABELS = {
  imported: "导入成功",
  downloaded: "下载成功",
  update: "有新版",
  released: "草案转正",
  failed: "失败",
  importFailed: "导入失败",
  notfound: "未找到",
  newer: "库内已有更新",
  current: "已是最新",
};

export function stdStatusLabel(status, message = "") {
  if (status !== "failed") return STATUS_LABELS[status] ?? String(status ?? "");
  if (/金币/.test(message)) return "金币不足";
  if (/认证|登录|cookie/i.test(message)) return "认证失败";
  return "下载失败";
}

export function renderStdPanel(state, kb, { escapeHtml = defaultEscapeHtml } = {}) {
  const escape = escapeHtml;
  const std = state.std ?? { loading: true };
  // 切库瞬间 state.std 可能还是空/上一个库的：宁可显示加载态，也不要把旧缓存/旧结果画到新库下。
  if (kb && std.kb !== kb) return `<div class="state">加载中…</div>`;
  if (std.loading && !std.status) return `<div class="state">加载中…</div>`;
  if (std.error && !std.status) {
    return `<div class="state error">${escape(std.error)}<button class="btn" data-action="std-reload">重试</button></div>`;
  }

  const status = std.status ?? {};
  const cache = status.cache ?? {};
  const pending = status.pending ?? {};
  const job = std.job ?? null;
  const progress = job?.progress ?? null;
  const result = job?.result ?? null;
  const running = std.starting === true || status.activeJobId != null || job?.status === "running";
  const configured = status.configured === true;
  const downloadable = Number(pending.downloadable ?? 0);

  return `
    <section class="std-panel">
      <div class="panel">
        <h3>更新状态</h3>
        <div class="kv"><span>登录状态</span><strong>${configured ? "已配置" : "未配置（在 profile 的 cordis.patch.yml 填 bzCookie）"}</strong></div>
        <div class="kv"><span>上次检查</span><strong>${cache.lastCheckAt ? escape(formatDateTime(cache.lastCheckAt)) : "从未检查"}</strong></div>
        <div class="kv"><span>缓存</span><strong>${cache.exists ? `${count(cache.items)} 条 · ${ageText(cache.ageDays)} 天前 · ${cache.valid ? "有效" : "已过期"}` : "无缓存"}</strong></div>
        <div class="kv"><span>待下载</span><strong>有新版 ${count(pending.update)} · 草案转正 ${count(pending.released)}</strong></div>
      </div>
      <div class="panel wide">
        <h3>运行</h3>
        <div class="form-row">
          <button class="btn" data-action="std-run" data-mode="check" ${running ? "disabled" : ""}>仅检查</button>
          <button class="btn primary" data-action="std-download" data-mode="check-download" ${running || !configured ? "disabled" : ""}>检查并下载</button>
          <button class="btn" data-action="std-download" data-mode="download" ${running || !configured || !(downloadable > 0) ? "disabled" : ""}>补下载</button>
          <label class="check"><input type="checkbox" id="std-force" ${running ? "disabled" : ""} /> 强制全查</label>
          <label class="check">本轮上限 <input id="std-limit" type="number" min="0" step="1" value="0" style="width:70px" ${running ? "disabled" : ""} /></label>
        </div>
        ${running ? `<div class="progress-line"><strong>${escape(progress?.phase ?? "准备中")}</strong>
          <span class="muted">${count(progress?.done)}/${count(progress?.total)} · ${escape(progress?.current ?? "")}</span></div>` : ""}
        ${std.error ? `<p class="form-error">${escape(std.error)} <button class="btn" data-action="std-reload">重试</button></p>` : ""}
        ${job?.status === "failed" ? `<p class="form-error">任务失败：${escape(job.detail || "未知错误")}</p>` : ""}
        ${result ? stdResultHtml(result, { escape }) : ""}
        ${status.lastJob && !result && job?.status !== "failed" ? `<p class="muted">上次任务：${escape(status.lastJob.status)} · ${escape(status.lastJob.finishedAt ?? "")}</p>` : ""}
      </div>
    </section>`;
}

function stdResultHtml(result, { escape }) {
  const counts = result.counts ?? {};
  const entries = Array.isArray(result.entries) ? result.entries : [];
  return `
    <div class="progress-line">
      <strong>检查 ${count(counts.checked)} 组 · 更新 ${count(counts.updates)} · 下载 ${count(counts.downloaded)} · 导入 ${count(counts.imported)} · 导入失败 ${count(counts.importFailed)} · 下载失败 ${count(counts.downloadFailed)}</strong>
    </div>
    ${counts.authOk === false ? `<p class="form-error">登录态失效：请更新 bzCookie 后重试。</p>` : ""}
    ${entries.length === 0 ? `<p class="muted">没有结果</p>` : `
      <table class="table">
        <thead><tr><th>标准号</th><th>标题</th><th>状态</th><th>说明</th></tr></thead>
        <tbody>
          ${entries.map((entry) => `<tr>
            <td>${escape(entry?.number ?? "")}</td>
            <td>${escape(entry?.title ?? "")}</td>
            <td>${escape(stdStatusLabel(entry?.status, entry?.message))}</td>
            <td class="muted">${escape(entry?.message || (entry?.fromYear ? `${entry.fromYear} → ${entry.toYear ?? ""}` : ""))}</td>
          </tr>`).join("")}
        </tbody>
      </table>`}
    ${result.truncated ? `<p class="muted">仅显示前 200 条；完整报告用 kb_std_check 查看。</p>` : ""}
    ${result.hint ? `<p class="muted">${escape(result.hint)}</p>` : ""}`;
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "0";
}

function ageText(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "?";
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  return date.toLocaleString("zh-CN");
}

function defaultEscapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}
