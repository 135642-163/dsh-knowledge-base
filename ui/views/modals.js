import { api, ApiError } from "../api.js";
import { formatBytes } from "../upload-core.js";
import { DOC_TRUST_LEVELS, docMetaUnchanged, parseDocTagsInput, summarySourceLabel, trustLevelLabel } from "./doc-meta.js";
import { clampPage, withPageFragment } from "../deep-link.js";

// 弹窗关闭统一走 closeOverlay：同时摘掉 Esc 监听并从栈里移除。
// 预览弹窗叠在资料详情弹窗上时，只有最上层响应 Esc。
const overlayStack = [];
const overlayClosers = new WeakMap();

function overlay(html, { className = "" } = {}) {
  const node = document.createElement("div");
  node.className = "overlay";
  node.innerHTML = `<div class="modal${className ? ` ${className}` : ""}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(node);

  const onKeydown = (event) => {
    if (event.key !== "Escape") return;
    if (overlayStack.at(-1) !== node) return;
    close();
  };
  const close = () => {
    overlayClosers.delete(node);
    const index = overlayStack.indexOf(node);
    if (index >= 0) overlayStack.splice(index, 1);
    document.removeEventListener("keydown", onKeydown);
    node.remove();
  };

  overlayStack.push(node);
  overlayClosers.set(node, close);
  document.addEventListener("keydown", onKeydown);
  node.addEventListener("mousedown", (event) => { if (event.target === node) close(); });
  node.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));
  return node;
}

/** 关闭 overlay 创建的弹窗；对已被外部移除的节点是安全的空操作。 */
function closeOverlay(node) {
  const close = overlayClosers.get(node);
  if (close) {
    close();
    return;
  }
  node?.remove?.();
}

/**
 * 逐字确认输入是否匹配（去首尾空白）。
 * 永久删除/归档这类不可恢复操作共用同一判定，按钮在输入匹配前保持禁用。
 * @returns {{ok: boolean, expected: string}}
 */
export function deleteConfirmCheck(value, expected) {
  const want = String(expected ?? "").trim();
  return { ok: want !== "" && String(value ?? "").trim() === want, expected: want };
}

/**
 * 「移入回收站」确认正文：固定说明 + 标题清单（最多 20 条）。
 * 多选批量时只列前 20 条，避免确认弹窗无限长。
 */
export function deleteConfirmBody(docs = []) {
  const list = Array.isArray(docs) ? docs : [];
  const titles = list.map((doc) => `· ${String(doc?.title ?? doc?.id ?? "")}`);
  const shown = titles.slice(0, 20);
  return [
    "移入回收站，可在『已删除』中恢复；原件与解析内容保留",
    "",
    ...shown,
    ...(titles.length > shown.length ? [`…等 ${titles.length} 篇`] : []),
  ].join("\n");
}

/**
 * 通用确认弹窗。body 按纯文本渲染（内部统一 escapeHtml），
 * requireCheckbox=true 时需勾选确认才能提交；
 * requireText 传入库名/标题时需逐字输入，textLabel 定制输入提示，danger 用危险色确认按钮。
 * onConfirm 可同步或异步；抛错时错误信息内联显示、弹窗不关闭。
 */
export function openConfirmModal({
  title,
  body = "",
  confirmText = "确认",
  requireCheckbox = false,
  requireText,
  textLabel = "输入库名",
  danger = false,
  onConfirm,
} = {}) {
  const required = requireText === undefined || requireText === null ? "" : String(requireText);
  const needsText = required !== "";
  const node = overlay(`
    <form class="modal-form">
      <h2>${escapeHtml(title)}</h2>
      <div class="confirm-body"><p class="muted">${escapeHtml(body)}</p></div>
      ${requireCheckbox ? `<label class="check"><input type="checkbox" name="ack" /> 我已知晓</label>` : ""}
      ${needsText ? `<label class="field"><span>${escapeHtml(textLabel)}「${escapeHtml(required)}」以确认</span><input name="confirm" autocomplete="off" /></label>` : ""}
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn ${danger ? "danger" : "primary"}"${needsText ? " disabled" : ""}>${escapeHtml(confirmText)}</button>
      </div>
    </form>
  `);
  const form = node.querySelector("form");
  const error = node.querySelector(".form-error");
  const button = form.querySelector("button[type=submit]");
  const confirmInput = form.querySelector("input[name='confirm']");
  const syncConfirmState = () => {
    if (!needsText) {
      button.disabled = false;
      return;
    }
    button.disabled = !deleteConfirmCheck(confirmInput?.value, required).ok;
  };
  if (needsText) {
    confirmInput?.addEventListener("input", () => {
      syncConfirmState();
      if (!button.disabled) error.hidden = true;
    });
    syncConfirmState();
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (requireCheckbox && !form.querySelector("input[name='ack']")?.checked) {
      error.textContent = "请先勾选「我已知晓」";
      error.hidden = false;
      return;
    }
    if (needsText && !deleteConfirmCheck(new FormData(form).get("confirm"), required).ok) {
      error.textContent = "输入不匹配，请逐字输入以确认";
      error.hidden = false;
      return;
    }
    button.disabled = true;
    try {
      await onConfirm?.();
      closeOverlay(node);
    } catch (failure) {
      error.textContent = failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
      error.hidden = false;
      syncConfirmState();
    }
  };
  return node;
}

/** 知识库选择弹窗：标准更新入口用；只返回库名，具体跳转由调用方决定。 */
export function openKbPickerModal({ kbs = [], onPick } = {}) {
  const node = overlay(`
    <div class="modal-form">
      <h2>选择知识库</h2>
      <p class="muted">对哪个库检查标准更新？</p>
      <div class="uplist">
        ${kbs.length === 0 ? `<p class="muted">还没有知识库</p>` : kbs.map((kb) => {
          const docs = kb?.docs ?? {};
          const live = Number(docs.ready ?? 0) + Number(docs.importing ?? 0) + Number(docs.failed ?? 0);
          return `<button type="button" class="btn" data-kb="${escapeAttr(kb?.name ?? "")}">${escapeHtml(kb?.name ?? "")} <span class="muted">${live} 篇</span></button>`;
        }).join("")}
      </div>
      <div class="modal-actions"><button type="button" class="btn" data-close>取消</button></div>
    </div>
  `);
  node.querySelectorAll("[data-kb]").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.dataset.kb;
      closeOverlay(node);
      if (name) onPick?.(name);
    });
  });
  return node;
}

export function openCreateModal({ onCreated }) {
  const node = overlay(`
    <form class="modal-form">
      <h2>新建知识库</h2>
      <label class="field"><span>名称</span><input name="name" required maxlength="64" placeholder="例如：电气" /></label>
      <label class="field"><span>简介（可选）</span><textarea name="description" rows="3" maxlength="500" placeholder="这个库收录什么？"></textarea></label>
      <label class="field"><span>标签（可选，逗号分隔）</span><input name="tags" placeholder="电气, 一次, 二次" /></label>
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn primary">创建</button>
      </div>
    </form>
  `);
  const form = node.querySelector("form");
  const error = node.querySelector(".form-error");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    if (name === "") { error.textContent = "请输入名称"; error.hidden = false; return; }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await api.createKb({
        name,
        description: String(data.get("description") ?? ""),
        tags: String(data.get("tags") ?? "").split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      });
      closeOverlay(node);
      onCreated?.(name);
    } catch (failure) {
      error.textContent = failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
      error.hidden = false;
      button.disabled = false;
    }
  };
}

export function openArchiveModal({ name, onArchived }) {
  const node = overlay(`
    <form class="modal-form">
      <h2>归档「${escapeHtml(name)}」</h2>
      <p class="muted">目录会移动到 <code>.trash/</code>，不会删除文件；可在侧栏“回收站”恢复。</p>
      <label class="field"><span>输入库名确认</span><input name="confirm" autocomplete="off" placeholder="${escapeAttr(name)}" /></label>
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn danger">归档</button>
      </div>
    </form>
  `);
  const form = node.querySelector("form");
  const error = node.querySelector(".form-error");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const confirm = String(new FormData(form).get("confirm") ?? "");
    if (confirm !== name) { error.textContent = "库名不匹配"; error.hidden = false; return; }
    try {
      await api.archiveKb(name, confirm);
      closeOverlay(node);
      onArchived?.();
    } catch (failure) {
      error.textContent = failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
      error.hidden = false;
    }
  };
}

const PREVIEW_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const PREVIEW_TEXT_EXTENSIONS = new Set(["txt", "md"]);
const PREVIEW_OFFICE_EXTENSIONS = new Set(["doc", "docx", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "odp"]);

function extensionOf(file) {
  const name = String(file ?? "");
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 决定用哪种方式内嵌预览：
 * - note 走 /content 的合并版 markdown；txt/md 走 /content 原文；
 * - pdf 走 source?inline=1，图片直接 inline；
 * - Office 走 preview.pdf（首次请求会触发转换）；
 * - 其余格式（含电子书/压缩包等）下载原件。
 */
export function previewKindFor(doc) {
  const type = String(doc?.type ?? "").trim().toLowerCase();
  if (type === "note") return "note";
  const ext = extensionOf(doc?.sourceFile);
  if (ext === "pdf") return "pdf";
  if (PREVIEW_IMAGE_EXTENSIONS.has(ext)) return "image";
  if (PREVIEW_TEXT_EXTENSIONS.has(ext)) return "text";
  if (PREVIEW_OFFICE_EXTENSIONS.has(ext)) return "office";
  // 列表项可能没有 sourceFile：退回 api.doc 的类型字段。
  if (type === "pdf" || type.startsWith("pdf-")) return "pdf";
  if (type === "text" || type === "markdown") return "text";
  if (PREVIEW_OFFICE_EXTENSIONS.has(type)) return "office";
  return "unsupported";
}

/**
 * 预览弹窗正文（纯函数，便于单测）。urls = { inline, pdf, download }，
 * content 仅 note/text 需要：{ markdown, truncated } 或 { error }；
 * loadingText 覆盖 Office 转换中的提示（安装完成重新载入时用）。
 */
export function renderPreviewBody({ kind, urls = {}, content, loadingText, page = null } = {}) {
  const download = escapeAttr(urls.download ?? "");
  const pageNo = Number.isInteger(page) && page > 0 ? page : null;
  if (kind === "pdf") {
    // 0.28：PDF 走服务端逐页 viewer（页码在 viewer 内定位，不再用 #page fragment）。
    // 没有 viewer URL 时回退到内联原件 + fragment，兼容旧调用方。
    const src = escapeAttr(urls.viewer ?? withPageFragment(urls.inline ?? "", pageNo));
    const pageNote = pageNo ? `<p class="muted preview-page">已定位到第 ${pageNo} 页</p>` : "";
    return `${pageNote}<iframe class="preview-frame" src="${src}" title="原件预览"></iframe>`;
  }
  if (kind === "office") {
    const src = escapeAttr(withPageFragment(urls.pdf ?? "", pageNo));
    const loading = `<p class="muted preview-loading">${escapeHtml(loadingText ?? "正在转换原件，首次可能需要几秒…")}</p>`;
    const pageNote = pageNo ? `<p class="muted preview-page">已定位到第 ${pageNo} 页</p>` : "";
    return `${pageNote}${loading}<iframe class="preview-frame" src="${src}" title="原件预览"></iframe><p class="muted preview-hint">若这里一直空白，说明这台电脑无法转换该旧版/损坏的 Office 文件，请点「下载原件」查看。</p>`;
  }
  if (kind === "image") {
    return `<img class="preview-image" src="${escapeAttr(urls.inline ?? "")}" alt="原件预览" />`;
  }
  if (kind === "note" || kind === "text") {
    if (content?.error) {
      // 笔记没有原件：错误分支不再渲染「下载原件」（点了也是死链），只留弹窗底部的「关闭」。
      const fallback = kind === "note"
        ? ""
        : `<p class="muted">请下载原件后查看。</p>
          <a class="btn" href="${download}">下载原件</a>`;
      return `
        <div class="preview-content-error">
          <p class="form-error">${escapeHtml(content.error)}</p>
          ${fallback}
        </div>
      `;
    }
    const truncated = content?.truncated ? `<p class="muted">内容较长，仅显示前 2 MB。</p>` : "";
    const pageNote = pageNo ? `<p class="muted preview-page">该资料没有页码，已打开正文。</p>` : "";
    return `${pageNote}<pre class="preview-text">${escapeHtml(content?.markdown ?? "")}</pre>${truncated}`;
  }
  return `
    <div class="state preview-unsupported">
      <p>该格式暂不支持内嵌预览，请下载原件</p>
      <a class="btn" href="${download}">下载原件</a>
    </div>
  `;
}

/**
 * Office 引擎未安装 / 安装中 / 安装失败的正文（纯函数，便于单测）。
 * status 来自 GET /office/status，installing 为 { phase, text }，error 为字符串。
 * 初始 HTML 的安装按钮一律 disabled：勾选同意后由 DOM 事件解锁（交互不在纯函数里）。
 */
export function renderOfficeInstallState({ status, installing, error } = {}) {
  const canInstall = status?.canInstall !== false;
  const busy = Boolean(installing);
  const failure = String(error ?? "").trim();
  const phase = typeof installing === "object" && installing?.phase ? String(installing.phase) : "";
  const phaseText = String(
    (typeof installing === "object" && installing?.text) || "正在下载并安装…",
  );
  const progress = busy
    ? `<div class="preview-install-progress" role="progressbar" aria-valuetext="${escapeAttr(phaseText)}" data-office-progress data-office-phase="${escapeAttr(phase)}">
        <div class="preview-install-bar" aria-hidden="true"></div>
        <p class="muted" data-office-progress-text>${escapeHtml(phaseText)}</p>
      </div>`
    : "";
  const errorLine = failure
    ? `<p class="form-error preview-install-error" data-office-error>${escapeHtml(failure)}</p>`
    : "";
  // 安装失败后保留同意状态（勾选 + 可点重试）；首次安装则必须由用户手动勾选。
  const actions = !canInstall || busy
    ? ""
    : `<label class="check"><input type="checkbox" data-office-consent${failure ? " checked" : ""} /> 我同意下载并安装（约 300 MB）</label>
      <div class="preview-install-actions">
        <button type="button" class="btn primary" data-office-install${failure ? "" : " disabled"}>${failure ? "重试" : "安装转换引擎"}</button>
      </div>`;
  const manual = canInstall
    ? ""
    : `<p class="muted preview-install-hint" data-office-manual>缺少 Node/npm，无法自动安装，请按 README 手动安装</p>`;
  return `
    <div class="preview-install" data-office-state="${busy ? "installing" : failure ? "error" : "ready"}">
      <p class="muted preview-install-desc">未安装 Office 转换引擎（LibreOfficeKit）。安装后可在此直接预览 docx/pptx/xlsx；约 300 MB，转换只在本机进行。</p>
      ${errorLine}
      ${progress}
      ${actions}
      ${manual}
    </div>
  `;
}

export function cacheBustUrl(url, version) {
  const raw = String(url ?? "");
  if (raw === "") return raw;
  return `${raw}${raw.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(version))}`;
}

/** Office 预览分支：只有状态明确可用才直接画 iframe，否则先走安装面板。 */
export function officePreviewMode(status) {
  return status?.available === true ? "frame" : "install";
}

/**
 * 启动安装并轮询后台任务，直到成功（并复查 /office/status）、失败或超时。
 * 纯逻辑 + 可注入 api/计时器，便于单测；onState 收到
 * {phase: "starting"|"installing"|"verifying"|"done"|"error"} 状态。
 */
export async function installOfficeEngineAndWait({
  api: apiClient,
  onState = () => {},
  pollMs = 1500,
  maxWaitMs = 1200000,
  timers = {},
} = {}) {
  const client = apiClient ?? api;
  const setTimeoutFn = typeof timers.setTimeout === "function" ? timers.setTimeout : setTimeout;
  const now = typeof timers.now === "function" ? timers.now : Date.now;
  const interval = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 1500;
  const waitLimit = Number.isFinite(maxWaitMs) && maxWaitMs > 0 ? maxWaitMs : 1200000;
  // 不依赖 Date.now 也一定会终止：轮询次数上限与截止时间双重兜底。
  const maxPolls = Math.max(1, Math.ceil(waitLimit / interval));
  const sleep = (ms) => new Promise((resolvePromise) => {
    let handle;
    try {
      handle = setTimeoutFn(resolvePromise, ms);
    } catch {
      resolvePromise();
      return;
    }
    handle?.unref?.();
  });
  const fail = (message, extra = {}) => {
    const state = { phase: "error", error: message, ...extra };
    onState(state);
    return { ok: false, error: message, ...extra };
  };

  onState({ phase: "starting", text: "正在启动安装…" });
  let started;
  try {
    started = await client.installOffice();
  } catch (failure) {
    return fail(errorText(failure), { failure });
  }
  const jobId = typeof started === "string" ? started : started?.jobId;
  if (!jobId) return fail("安装任务启动失败，请重试");

  onState({ phase: "installing", text: "正在下载并安装…", jobId });
  const deadline = now() + waitLimit;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (now() >= deadline) break;
    await sleep(interval);
    let job;
    try {
      job = await client.job(jobId);
    } catch (failure) {
      return fail(`无法获取安装进度：${errorText(failure)}`, { jobId });
    }
    if (!job || job.status === "running") {
      const progress = job?.progress !== null && typeof job?.progress === "object" ? job.progress : null;
      const text = String(progress?.text ?? progress?.message ?? "正在下载并安装…");
      onState({ phase: "installing", text, jobId, job });
      continue;
    }
    if (job.status === "succeeded" || job.status === "completed") {
      onState({ phase: "verifying", text: "正在确认安装结果…", jobId, job });
      let status = null;
      try {
        status = await client.officeStatus();
      } catch {
        status = null;
      }
      if (status?.available === true) {
        onState({ phase: "done", status, jobId, job });
        return { ok: true, status, job };
      }
      return fail("安装已完成，但引擎仍不可用，请重试", { status, job });
    }
    const detail = String(job.detail ?? "").trim();
    return fail(detail || "安装失败，请重试", { job });
  }
  return fail("安装超时，请稍后重试", { timedOut: true });
}

/**
 * 打开原件预览。note/text 先拉 /content；pdf/image 直接内嵌；
 * Office 先查引擎状态，已安装才内嵌 preview.pdf，未安装则显示一键安装面板。
 * 弹窗在请求返回前被关闭时，结果直接丢弃（不再写 DOM）。
 */
export function openPreviewModal({ name, doc, icons, initialPage = null, terms = [] } = {}) {
  const kind = previewKindFor(doc);
  const requestedPage = Number.isInteger(initialPage) && initialPage > 0 ? initialPage : null;
  const page = requestedPage ? clampPage(requestedPage, doc?.pages) : null;
  const keywords = Array.isArray(terms)
    ? terms.map((term) => String(term ?? "").trim()).filter((term) => term.length >= 2).slice(0, 8)
    : [];
  const pageNote = requestedPage && Number(doc?.pages) > 0 && page !== requestedPage
    ? `<p class="muted preview-page">页码超出范围，已定位到第 ${page} 页。</p>`
    : "";
  const urls = {
    inline: api.sourceInlineUrl(name, doc?.id ?? ""),
    viewer: api.viewerUrl(name, doc?.id ?? "", { page, terms: keywords }),
    pdf: api.previewPdfUrl(name, doc?.id ?? ""),
    download: api.sourceUrl(name, doc?.id ?? ""),
  };
  const downloadAction = kind === "note"
    ? ""
    : `<a class="btn" href="${escapeAttr(urls.download)}">下载原件</a>`;
  const node = overlay(`
    <div class="modal-form preview-form">
      <h2>${escapeHtml(doc?.title ?? "原件预览")}</h2>
      ${pageNote}
      <div class="preview-body"><p class="state">加载中…</p></div>
      <div class="modal-actions">
        ${downloadAction}
        <button type="button" class="btn" data-close>关闭</button>
      </div>
    </div>
  `, { className: "preview-modal" });
  const body = node.querySelector(".preview-body");
  const paint = (html) => {
    if (!node.isConnected || !body) return;
    body.innerHTML = html;
  };
  const paintOfficeFrame = ({ loadingText, version } = {}) => {
    const pdf = version === undefined ? urls.pdf : cacheBustUrl(urls.pdf, version);
    paint(renderPreviewBody({ kind: "office", urls: { ...urls, pdf }, loadingText, page }));
    // 转换/载入提示在 iframe 真正载入后隐藏。
    body?.querySelector("iframe")?.addEventListener("load", () => {
      body.querySelector(".preview-loading")?.remove();
    }, { once: true });
  };
  const wireOfficeInstall = (status, { onRetry } = {}) => {
    const checkbox = body?.querySelector("[data-office-consent]");
    const button = body?.querySelector("[data-office-install]");
    const sync = () => {
      if (button) button.disabled = !checkbox?.checked;
    };
    checkbox?.addEventListener("change", sync);
    sync();
    button?.addEventListener("click", () => {
      if (!checkbox?.checked) return;
      if (typeof onRetry === "function") {
        onRetry();
        return;
      }
      void startOfficeInstall(status);
    });
  };
  const paintOfficeState = (status, extra = {}, options = {}) => {
    paint(renderOfficeInstallState({ status, ...extra }));
    wireOfficeInstall(status, options);
  };
  const startOfficeInstall = async (status) => {
    const onState = (state) => {
      if (!node.isConnected) return;
      if (state.phase === "done") {
        // 装完用带时间戳的 URL 重新载入，绕过浏览器/宿主对旧 501 的缓存。
        paintOfficeFrame({ loadingText: "已安装，正在载入预览…", version: Date.now() });
        return;
      }
      if (state.phase === "error") {
        paintOfficeState(status, { error: state.error });
        return;
      }
      paint(renderOfficeInstallState({
        status,
        installing: { phase: state.phase, text: state.text },
      }));
    };
    try {
      await installOfficeEngineAndWait({ api, onState });
    } catch (failure) {
      if (node.isConnected) paintOfficeState(status, { error: errorText(failure) });
    }
  };
  const checkOfficeEngine = async () => {
    let status;
    try {
      status = await api.officeStatus();
    } catch (failure) {
      if (!node.isConnected) return;
      paintOfficeState(null, { error: `无法获取引擎状态：${errorText(failure)}` }, {
        onRetry: () => void checkOfficeEngine(),
      });
      return;
    }
    if (!node.isConnected) return;
    if (officePreviewMode(status) === "frame") {
      paintOfficeFrame();
      return;
    }
    paintOfficeState(status);
  };

  if (kind === "note" || kind === "text") {
    api.docContent(name, doc?.id ?? "").then((content) => {
      paint(renderPreviewBody({ kind, urls, content, page }));
    }).catch((failure) => {
      paint(renderPreviewBody({ kind, urls, content: { error: failure?.message ?? String(failure) }, page }));
    });
  } else if (kind === "office") {
    void checkOfficeEngine();
  } else {
    paint(`${pageNote}${renderPreviewBody({ kind, urls, page })}`);
    body?.querySelector("iframe")?.addEventListener("load", () => {
      body.querySelector(".preview-loading")?.remove();
    }, { once: true });
  }
  return node;
}

/** 失败文档详情正文（纯函数，便于单测）。 */
export function renderDocModalBody({ name, id, doc } = {}) {
  const failed = doc?.status === "failed";
  const importing = doc?.status === "importing";
  const warnings = Array.isArray(doc?.warnings) ? doc.warnings : [];
  const deleted = doc?.deleted === true || doc?.status === "deleted";
  const editable = !deleted && !importing;
  const tagsValue = (doc?.tags ?? []).join(", ");
  return `
    <div class="modal-form">
      <h2>${escapeHtml(doc?.title ?? "文档")}</h2>
      ${deleted ? `<p class="muted">该文档已移入回收站，恢复后才能编辑摘要/标签。</p>` : ""}
      ${importing ? `<p class="muted">文档正在导入，解析完成后才能编辑摘要/标签。</p>` : ""}
      <div class="kv"><span>ID</span><strong>${escapeHtml(doc?.id ?? id ?? "")}</strong></div>
      <div class="kv"><span>类型</span><strong>${escapeHtml(doc?.type ?? "")}</strong></div>
      <div class="kv"><span>页数 / 字数</span><strong>${doc?.pages ?? 0} / ${doc?.chars ?? 0}</strong></div>
      <div class="kv"><span>可信度</span><strong>${escapeHtml(doc?.trust ?? "unknown")}</strong></div>
      <div class="kv"><span>来源文件</span><strong>${escapeHtml(doc?.sourceFile || "—")}</strong></div>
      ${!editable && doc?.standardNo ? `<div class="kv"><span>标准号</span><strong>${escapeHtml(doc.standardNo)}${doc.stageLabel ? `（${escapeHtml(doc.stageLabel)}）` : ""}</strong></div>` : ""}
      ${editable ? `
        <div class="doc-meta-editor">
          <label class="field"><span>标题 <span class="muted">（人工修改后重新导入也会保留）</span></span>
            <input name="doc-title" maxlength="200" value="${escapeAttr(doc?.title ?? "")}" placeholder="资料名称" autocomplete="off" />
          </label>
          <label class="field"><span>标准号 <span class="muted">（可选，如 GB/T 20001.10-2014；留空=非标准资料）</span></span>
            <input name="doc-standard-no" maxlength="80" value="${escapeAttr(doc?.standardNo ?? "")}" placeholder="GB/T 20001.10-2014" autocomplete="off" />
          </label>
          <label class="field"><span>摘要 <span class="muted">（来源：${escapeHtml(summarySourceLabel(doc?.summarySource))}）</span></span>
            <textarea name="doc-summary" maxlength="500" rows="3" placeholder="一句话说明这篇资料…">${escapeHtml(doc?.summary || "")}</textarea>
          </label>
          <label class="field"><span>标签（逗号分隔，最多 20 个）</span>
            <input name="doc-tags" value="${escapeAttr(tagsValue)}" placeholder="并网, 海上风电" autocomplete="off" />
          </label>
          <label class="field"><span>可信度 <span class="muted">（人工选择后检索会优先标注，不再被自动推断覆盖）</span></span>
            <select name="doc-trust">
              ${DOC_TRUST_LEVELS.map((level) => `<option value="${level}"${(doc?.trust ?? "unknown") === level ? " selected" : ""}>${escapeHtml(trustLevelLabel(level))}</option>`).join("")}
            </select>
          </label>
          <div class="modal-actions meta-actions">
            <button type="button" class="btn primary" data-save-meta disabled>保存名称/摘要/标签/标准号/可信度</button>
          </div>
        </div>` : `
        <div class="kv"><span>摘要</span><strong>${escapeHtml(doc?.summary || "—")}</strong></div>
        <div class="kv"><span>标签</span><strong>${escapeHtml((doc?.tags ?? []).join("、") || "—")}</strong></div>`}
      ${failed ? `
        <div class="doc-error">
          <pre class="doc-error-text">${escapeHtml(doc?.error || "导入失败")}</pre>
          ${warnings.length > 0 ? `<ul class="doc-warnings">
            ${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}
          </ul>` : ""}
          <p class="muted doc-retry-state" data-retry-state hidden></p>
        </div>` : ""}
      <p class="form-error" data-doc-error hidden></p>
      <div class="modal-actions">
        ${failed ? `<button type="button" class="btn primary" data-retry>重新导入</button>` : ""}
        <button type="button" class="btn" data-preview>查看原件</button>
        <a class="btn" href="${escapeAttr(api.sourceUrl(name, id))}">下载原件</a>
        ${failed ? `<button type="button" class="btn danger" data-remove>移入回收站</button>` : ""}
        <button type="button" class="btn" data-close>关闭</button>
      </div>
    </div>
  `;
}

export const REPARSE_POLL_INTERVAL_MS = 1000;
export const REPARSE_POLL_TIMEOUT_MS = 120000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询任务直到结算（running 之外都算结算）。
 * 按 1 秒间隔查询；超过 timeoutMs 抛 REPARSE_TIMEOUT，让调用方提示稍后再看。
 * getJob/sleep 可注入，单测不需要真实计时器。
 */
export async function waitForJob({
  jobId,
  getJob,
  sleep = defaultSleep,
  intervalMs = REPARSE_POLL_INTERVAL_MS,
  timeoutMs = REPARSE_POLL_TIMEOUT_MS,
} = {}) {
  if (!jobId) throw new Error("缺少任务 id");
  if (typeof getJob !== "function") throw new Error("缺少任务查询函数");
  const wait = Math.max(1, Math.round(Number(intervalMs) || REPARSE_POLL_INTERVAL_MS));
  const limit = Math.max(0, Number(timeoutMs) || 0);
  let waited = 0;
  for (;;) {
    const job = await getJob(jobId);
    if (!job || job.status !== "running") return job;
    if (waited >= limit) {
      const error = new Error("重试超时：任务仍在运行，稍后可在资料列表查看结果");
      error.code = "REPARSE_TIMEOUT";
      throw error;
    }
    await sleep(wait);
    waited += wait;
  }
}

/**
 * 重新解析失败的文档：启动任务 → 每 1 秒轮询 → 结算后刷新列表并提示结果。
 * notify(message, kind) 由调用方注入（工作台用 showToast），避免弹窗模块依赖 app.js。
 */
export async function retryFailedDoc({
  name,
  id,
  notify = () => {},
  onSettled,
  reparse = (kb, docId) => api.reparseDoc(kb, docId),
  getJob = (jobId) => api.job(jobId),
  sleep = defaultSleep,
  intervalMs = REPARSE_POLL_INTERVAL_MS,
  timeoutMs = REPARSE_POLL_TIMEOUT_MS,
} = {}) {
  const started = await reparse(name, id);
  const jobId = started?.jobId;
  if (!jobId) throw new Error("重试任务没有返回 jobId");
  notify("已开始重试解析");
  const job = await waitForJob({ jobId, getJob, sleep, intervalMs, timeoutMs });
  try {
    await onSettled?.(job);
  } catch {
    /* 刷新失败不改变重试已经结算的事实 */
  }
  if (job?.status === "succeeded") {
    notify(job.detail || "重试完成");
  } else {
    notify(`重试失败${job?.detail ? `：${job.detail}` : ""}`, "error");
  }
  return job;
}

export function openDocModal({ name, id, icons, notify = () => {}, onChanged } = {}) {
  const node = overlay(`<div class="modal-form"><h2>加载中…</h2></div>`);
  let doc = null;
  let retrying = false;
  let removing = false;
  let savingMeta = false;

  function showError(message) {
    const error = node.querySelector("[data-doc-error]");
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
  }

  function bind() {
    node.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeOverlay(node)));
    node.querySelector("[data-preview]")?.addEventListener("click", () => {
      if (doc) openPreviewModal({ name, doc, icons });
    });
    node.querySelector("[data-retry]")?.addEventListener("click", () => { void retry(); });
    node.querySelector("[data-remove]")?.addEventListener("click", () => { void remove(); });

    const titleInput = node.querySelector('[name="doc-title"]');
    const standardNoInput = node.querySelector('[name="doc-standard-no"]');
    const summaryInput = node.querySelector('[name="doc-summary"]');
    const tagsInput = node.querySelector('[name="doc-tags"]');
    const trustInput = node.querySelector('[name="doc-trust"]');
    const saveButton = node.querySelector("[data-save-meta]");
    if (saveButton && (titleInput || summaryInput || tagsInput || standardNoInput || trustInput)) {
      const refreshDirty = () => {
        if (savingMeta) return;
        saveButton.disabled = docMetaUnchanged(doc, {
          title: titleInput?.value ?? "",
          summary: summaryInput?.value ?? "",
          tags: tagsInput?.value ?? "",
          standardNo: standardNoInput?.value ?? "",
          trust: trustInput?.value ?? "unknown",
        });
      };
      titleInput?.addEventListener("input", refreshDirty);
      standardNoInput?.addEventListener("input", refreshDirty);
      summaryInput?.addEventListener("input", refreshDirty);
      tagsInput?.addEventListener("input", refreshDirty);
      trustInput?.addEventListener("change", refreshDirty);
      saveButton.addEventListener("click", () => { void saveMeta(); });
      refreshDirty();
    }
  }

  async function saveMeta() {
    if (!doc || savingMeta) return;
    const saveButton = node.querySelector("[data-save-meta]");
    const title = node.querySelector('[name="doc-title"]')?.value ?? doc.title ?? "";
    const summary = node.querySelector('[name="doc-summary"]')?.value ?? doc.summary ?? "";
    const tags = node.querySelector('[name="doc-tags"]')?.value ?? (doc.tags ?? []).join(", ");
    const standardNo = node.querySelector('[name="doc-standard-no"]')?.value ?? doc.standardNo ?? "";
    const trust = node.querySelector('[name="doc-trust"]')?.value ?? doc.trust ?? "unknown";
    if (docMetaUnchanged(doc, { title, summary, tags, standardNo, trust })) return;
    if (!String(title).trim()) {
      showError("标题不能为空");
      return;
    }
    savingMeta = true;
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = "保存中…";
    }
    try {
      const saved = await api.patchDocMetadata(name, id, {
        title: String(title).replace(/\s+/g, " ").trim().slice(0, 200),
        summary,
        tags: parseDocTagsInput(tags),
        standardNo: String(standardNo).replace(/\s+/g, " ").trim(),
        trust: String(trust),
      });
      if (!node.isConnected) return;
      paint(saved.doc);
      notify("已保存名称/摘要/标签/标准号");
      try {
        await onChanged?.();
      } catch {
        /* 列表刷新失败不影响保存结果 */
      }
    } catch (failure) {
      if (node.isConnected) {
        if (saveButton) {
          saveButton.disabled = false;
          saveButton.textContent = "保存名称/摘要/标签/标准号";
        }
        showError(errorText(failure));
      }
    } finally {
      savingMeta = false;
    }
  }

  function paint(next) {
    doc = next;
    if (!node.isConnected) return;
    node.querySelector(".modal").innerHTML = renderDocModalBody({ name, id, doc });
    bind();
  }

  async function load() {
    try {
      paint(await api.doc(name, id));
    } catch (failure) {
      if (!node.isConnected) return;
      node.querySelector(".modal").innerHTML = `<div class="modal-form"><p class="form-error">${escapeHtml(errorText(failure))}</p><button class="btn" data-close>关闭</button></div>`;
      bind();
    }
  }

  async function retry() {
    if (retrying) return;
    retrying = true;
    const button = node.querySelector("[data-retry]");
    if (button) {
      button.disabled = true;
      button.textContent = "正在重试…";
    }
    const stateText = node.querySelector("[data-retry-state]");
    if (stateText) {
      stateText.hidden = false;
      stateText.textContent = "正在重新解析，最长等待约 2 分钟…";
    }
    try {
      await retryFailedDoc({
        name,
        id,
        notify,
        onSettled: async () => {
          await onChanged?.();
          await load();
        },
      });
    } catch (failure) {
      notify(errorText(failure), "error");
    } finally {
      retrying = false;
      if (node.isConnected) paint(doc);
    }
  }

  async function remove() {
    if (removing) return;
    removing = true;
    const button = node.querySelector("[data-remove]");
    if (button) {
      button.disabled = true;
      button.textContent = "正在移入…";
    }
    try {
      await api.deleteDoc(name, id);
      closeOverlay(node);
      notify("已移入回收站");
      try {
        await onChanged?.();
      } catch {
        /* 列表刷新失败不影响删除结果 */
      }
    } catch (failure) {
      removing = false;
      if (button) {
        button.disabled = false;
        button.textContent = "移入回收站";
      }
      showError(errorText(failure));
    }
  }

  void load();
  return node;
}

/**
 * 重命名输入校验（纯函数）：trim 后不能为空，也不能与原名相同。
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function normalizeRenameValue(value, current) {
  const next = String(value ?? "").trim();
  if (next === "") return { ok: false, error: "请输入名称" };
  if (next === String(current ?? "")) return { ok: false, error: "名称没有变化" };
  return { ok: true, value: next };
}

/** 页头/设置页共用的重命名弹窗；成功后回调新库名。 */
export function openRenameModal({ name, onRenamed } = {}) {
  const node = overlay(`
    <form class="modal-form">
      <h2>重命名「${escapeHtml(name)}」</h2>
      <label class="field"><span>新名称</span><input name="name" value="${escapeAttr(name)}" maxlength="64" autocomplete="off" /></label>
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn primary">重命名</button>
      </div>
    </form>
  `);
  const form = node.querySelector("form");
  const error = node.querySelector(".form-error");
  const input = form.querySelector("input[name='name']");
  input?.focus?.();
  input?.select?.();
  input?.addEventListener("input", () => { error.hidden = true; });
  form.onsubmit = async (event) => {
    event.preventDefault();
    const check = normalizeRenameValue(new FormData(form).get("name"), name);
    if (!check.ok) {
      error.textContent = check.error;
      error.hidden = false;
      return;
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const result = await api.patchKb(name, { name: check.value });
      closeOverlay(node);
      try {
        await onRenamed?.(result?.kb?.name ?? check.value);
      } catch {
        /* 改名已经成功；页面级刷新失败不回滚，也不恢复弹窗。 */
      }
    } catch (failure) {
      error.textContent = failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
      error.hidden = false;
      button.disabled = false;
    }
  };
  return node;
}


export function openRestoreModal({ name, dir, onRestored }) {
  const node = overlay(`
    <form class="modal-form">
      <h2>恢复「${escapeHtml(name)}」</h2>
      <p class="muted">原名称被占用时，换一个名称再恢复。</p>
      <label class="field"><span>恢复后的名称</span><input name="name" value="${escapeAttr(name)}" maxlength="64" /></label>
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn primary">恢复</button>
      </div>
    </form>
  `);
  const form = node.querySelector("form");
  const error = node.querySelector(".form-error");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const next = String(new FormData(form).get("name") ?? "").trim();
    if (next === "") { error.textContent = "请输入名称"; error.hidden = false; return; }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const result = await api.restoreKb(dir, next === name ? undefined : next);
      closeOverlay(node);
      onRestored?.(result.restoredTo);
    } catch (failure) {
      error.textContent = failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
      error.hidden = false;
      button.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// 跨库移动
// ---------------------------------------------------------------------------

export const MOVE_CONFLICT_KINDS = Object.freeze([
  { kind: "id", label: "同 ID" },
  { kind: "hash", label: "同内容" },
  { kind: "title", label: "同标题" },
]);

/** 把预检结果里的冲突按 同 ID/同内容/同标题 分组（无冲突时返回空数组）。 */
export function conflictGroups(preflight) {
  const docs = Array.isArray(preflight)
    ? preflight
    : Array.isArray(preflight?.docs)
      ? preflight.docs
      : [];
  const groups = [];
  for (const { kind, label } of MOVE_CONFLICT_KINDS) {
    const items = [];
    for (const doc of docs) {
      if (doc?.conflict?.kind !== kind) continue;
      items.push({
        id: String(doc?.id ?? ""),
        title: String(doc?.title ?? ""),
        targetTitle: String(doc?.conflict?.withTitle ?? ""),
      });
    }
    if (items.length > 0) groups.push({ kind, label, count: items.length, items });
  }
  return groups;
}

/** 「开始移动」按钮是否可用；reason 供弹窗内提示。 */
export function moveConfirmState({ target = "", ack = false, loading = false, busy = false, preflight = null, error = "" } = {}) {
  if (!target) return { disabled: true, reason: "请选择目标知识库" };
  if (loading) return { disabled: true, reason: "正在预检…" };
  if (error) return { disabled: true, reason: "预检失败，无法移动" };
  if (!preflight) return { disabled: true, reason: "请等待预检完成" };
  if (busy) return { disabled: true, reason: "正在移动…" };
  if (!ack) return { disabled: true, reason: "请先勾选确认移动说明" };
  return { disabled: false, reason: "" };
}

/**
 * 切换目标库后返回新的表单状态：目标变了必须重新勾选确认（ack=false），
 * 避免把对甲库的确认沿用到乙库。纯函数，便于单测。
 */
export function moveTargetChange({ target = "", previousTarget = "", ack = false } = {}) {
  const nextTarget = String(target ?? "");
  return { target: nextTarget, ack: nextTarget !== String(previousTarget ?? "") ? false : ack === true };
}

/** 预检摘要：将移动 N 篇（约 X MB）到「目标」。 */
export function renderMoveSummary({ target = "", ids = [], loading = false, error = "", preflight = null } = {}) {
  if (!target) return `<p class="muted move-summary">请选择目标知识库</p>`;
  if (loading) return `<p class="muted move-summary">正在预检…</p>`;
  if (error) return `<p class="form-error move-summary">${escapeHtml(error)}</p>`;
  const docs = Array.isArray(preflight?.docs) ? preflight.docs : null;
  const count = docs ? docs.length : (Array.isArray(ids) ? ids.length : 0);
  const bytes = Number(preflight?.totalBytes) || 0;
  return `<p class="move-summary">将移动 ${count} 篇（约 ${escapeHtml(formatBytes(bytes))}）到「${escapeHtml(target)}」</p>`;
}

function skipReason(item) {
  if (item?.reason) return String(item.reason);
  const kind = item?.conflict?.kind;
  if (kind === "id") return "目标库已有相同 id 的文档";
  if (kind === "hash") return "目标库已有相同内容的文档";
  if (kind === "title") return "目标库已有相同标题的文档";
  return "目标库存在冲突";
}

/** 移动结果正文：已移动 / 已跳过 / 失败 三组逐条说明。 */
export function renderMoveResult({ result = null, target = "" } = {}) {
  if (!result) return `<p class="muted">尚无移动结果。</p>`;
  const results = Array.isArray(result?.results) ? result.results : [];
  const moved = results.filter((item) => item?.status === "moved");
  const skipped = results.filter((item) => item?.status === "skipped");
  const failed = results.filter((item) => item?.status === "failed");
  const numberOf = (key, fallback) => (Number.isFinite(Number(result?.[key])) ? Number(result[key]) : fallback);
  const movedCount = numberOf("moved", moved.length);
  const skippedCount = numberOf("skipped", skipped.length);
  const failedCount = numberOf("failed", failed.length);
  const total = movedCount + skippedCount + failedCount;
  const groups = [];
  if (moved.length > 0) {
    groups.push(`
      <div class="result-group">
        <h3>已移动 ${movedCount} 篇${target ? ` → 「${escapeHtml(target)}」` : ""}</h3>
        <ul class="result-list">
          ${moved.map((item) => {
            const title = String(item?.title ?? item?.id ?? "");
            const nextTitle = String(item?.newTitle ?? "");
            const renamed = nextTitle !== "" && nextTitle !== title
              ? `<span class="muted">→ ${escapeHtml(nextTitle)}</span>`
              : "";
            return `<li><span class="result-name">${escapeHtml(title)}</span>${renamed}</li>`;
          }).join("")}
        </ul>
      </div>
    `);
  }
  if (skipped.length > 0) {
    groups.push(`
      <div class="result-group">
        <h3>已跳过 ${skippedCount} 篇</h3>
        <ul class="result-list">
          ${skipped.map((item) => `<li><span class="result-name">${escapeHtml(item?.title ?? item?.id ?? "")}</span><span class="muted result-reason">${escapeHtml(skipReason(item))}</span></li>`).join("")}
        </ul>
      </div>
    `);
  }
  if (failed.length > 0) {
    groups.push(`
      <div class="result-group">
        <h3>失败 ${failedCount} 篇</h3>
        <ul class="result-list">
          ${failed.map((item) => `<li><span class="result-name">${escapeHtml(item?.title ?? item?.id ?? "")}</span><span class="form-error result-reason">${escapeHtml(item?.error || "移动失败")}</span></li>`).join("")}
        </ul>
      </div>
    `);
  }
  return `
    <p class="move-result-summary">共 ${total} 篇：成功 ${movedCount} · 跳过 ${skippedCount} · 失败 ${failedCount}</p>
    ${groups.join("")}
  `;
}

function conflictSection(groups) {
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return `
    <div class="conflict-groups">
      <p class="conflict-title">目标库已有重复（${total} 篇）：</p>
      ${groups.map((group) => `
        <div class="conflict-group">
          <div class="conflict-head">${escapeHtml(group.label)} · ${group.count} 篇</div>
          <ul class="conflict-list">
            ${group.items.map((item) => `<li class="conflict-row"><span class="conflict-name">${escapeHtml(item.title)}</span><span class="muted conflict-target" title="${escapeAttr(item.targetTitle)}">目标库已有「${escapeHtml(item.targetTitle)}」</span></li>`).join("")}
          </ul>
        </div>`).join("")}
    </div>
  `;
}

/**
 * 跨库移动表单（纯渲染，便于单测）：目标库选择 + 预检摘要 + 冲突分组。
 * 只有预检发现重复时才出现「遇到重复」单选；没有冲突时直接说明将直接移动。
 */
export function renderMoveForm({
  sourceIds = [],
  targets = [],
  target = "",
  ack = false,
  loading = false,
  busy = false,
  preflight = null,
  error = "",
  onConflict = "skip",
} = {}) {
  const confirm = moveConfirmState({ target, ack, loading, busy, preflight, error });
  const groups = conflictGroups(preflight);
  return `
    <form class="modal-form">
      <h2>移动 ${sourceIds.length} 篇资料</h2>
      <label class="field"><span>目标知识库</span>
        <select name="target" ${busy ? "disabled" : ""}>
          ${targets.length === 0
            ? `<option value="">没有可移动到的目标库</option>`
            : targets.map((candidate) => `<option value="${escapeAttr(candidate)}"${candidate === target ? " selected" : ""}>${escapeHtml(candidate)}</option>`).join("")}
        </select>
      </label>
      <p class="muted">同一篇资料不能移到自己所在的库；已合并的库不能作为移动目标。</p>
      <div class="move-preflight">${renderMoveSummary({ target, ids: sourceIds, loading, error, preflight })}</div>
      ${groups.length > 0 ? conflictSection(groups) : ""}
      ${groups.length > 0
        ? `<div class="move-conflict-mode">
          <span class="muted">遇到重复：</span>
          <label class="check"><input type="radio" name="on-conflict" value="skip"${onConflict === "skip" ? " checked" : ""}${busy ? " disabled" : ""} /> 跳过</label>
          <label class="check"><input type="radio" name="on-conflict" value="rename"${onConflict === "rename" ? " checked" : ""}${busy ? " disabled" : ""} /> 重命名为副本</label>
        </div>`
        : `<p class="muted move-no-conflict">没有重复冲突，将直接移动。</p>`}
      ${groups.some((group) => group.kind === "hash") ? `<p class="muted">同内容重复始终跳过（重命名只会制造真正的重复）。</p>` : ""}
      <label class="check move-ack"><input type="checkbox" name="ack"${ack ? " checked" : ""}${busy ? " disabled" : ""} /> 我已了解：移动=复制到目标库并软删除源库文档，可在源库回收站撤销</label>
      ${confirm.disabled ? `<p class="muted move-hint">${escapeHtml(confirm.reason)}</p>` : ""}
      <div class="modal-actions">
        <button type="button" class="btn" data-close>取消</button>
        <button type="submit" class="btn primary"${confirm.disabled ? " disabled" : ""}>开始移动</button>
      </div>
    </form>
  `;
}

/**
 * 跨库移动弹窗：选目标库 → 预检（摘要 + 冲突分组）→ 确认移动 → 结果页（可撤销全部）。
 * onDone 在移动/撤销完成后调用，用于刷新资料列表与侧栏计数。
 */
export function openMoveModal({ name, ids = [], kbs = [], notify = () => {}, onDone } = {}) {
  const sourceIds = (Array.isArray(ids) ? ids : []).filter(Boolean);
  const targets = (Array.isArray(kbs) ? kbs : [])
    .filter((kb) => kb && kb.name !== name && !kb.mergedInto)
    .map((kb) => String(kb.name));
  const state = {
    target: targets[0] ?? "",
    preflight: null,
    loading: false,
    error: "",
    ack: false,
    busy: false,
    onConflict: "skip",
    result: null,
    undoing: false,
    undoProgress: "",
    undo: null,
  };
  const node = overlay(`<div class="modal-form"><h2>移动资料</h2></div>`, { className: "move-modal" });
  let requestSeq = 0;

  function formView() {
    return renderMoveForm({ ...state, sourceIds, targets });
  }

  function resultView() {
    const result = state.result ?? { results: [], moved: 0, skipped: 0, failed: 0 };
    const movedCount = Number.isFinite(Number(result.moved)) ? Number(result.moved) : 0;
    const undo = state.undo;
    return `
      <div class="modal-form">
        <h2>移动结果</h2>
        ${renderMoveResult({ result, target: state.target })}
        ${state.undoProgress ? `<p class="muted move-progress">${escapeHtml(state.undoProgress)}</p>` : ""}
        ${undo ? `<p class="muted move-undo-report">已撤销 ${undo.ok} 篇${undo.failures.length > 0 ? ` · 失败 ${undo.failures.length} 篇` : ""}</p>` : ""}
        ${undo && undo.failures.length > 0 ? `<ul class="result-list">${undo.failures.map((failure) => `<li><span class="result-name">${escapeHtml(failure.title)}</span><span class="form-error result-reason">${escapeHtml(failure.error)}</span></li>`).join("")}</ul>` : ""}
        <div class="modal-actions">
          ${movedCount > 0 && !undo ? `<button type="button" class="btn" data-undo${state.undoing ? " disabled" : ""}>${state.undoing ? "正在撤销…" : "撤销全部已移动"}</button>` : ""}
          <button type="button" class="btn primary" data-finish>完成</button>
        </div>
      </div>
    `;
  }

  function paint() {
    if (!node.isConnected) return;
    node.querySelector(".modal").innerHTML = state.result ? resultView() : formView();
    bind();
  }

  function bind() {
    node.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeOverlay(node)));
    node.querySelector("form.modal-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void submit();
    });
    const select = node.querySelector("select[name='target']");
    select?.addEventListener("change", () => {
      if (state.busy) return;
      const next = moveTargetChange({
        target: select.value,
        previousTarget: state.target,
        ack: state.ack,
      });
      state.target = next.target;
      state.ack = next.ack;
      state.preflight = null;
      state.error = "";
      void loadPreflight();
    });
    node.querySelectorAll("input[name='on-conflict']").forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        state.onConflict = input.value === "rename" ? "rename" : "skip";
        paint();
      });
    });
    node.querySelector("input[name='ack']")?.addEventListener("change", (event) => {
      state.ack = event.target.checked === true;
      paint();
    });
    node.querySelector("[data-undo]")?.addEventListener("click", () => { void undoAll(); });
    node.querySelector("[data-finish]")?.addEventListener("click", () => { void finish(); });
  }

  async function loadPreflight() {
    const seq = (requestSeq += 1);
    if (!state.target) {
      state.preflight = null;
      state.loading = false;
      state.error = "";
      paint();
      return;
    }
    state.loading = true;
    state.preflight = null;
    state.error = "";
    paint();
    try {
      const preflight = await api.movePreflight(name, { ids: sourceIds, target: state.target });
      if (seq !== requestSeq || !node.isConnected) return;
      state.preflight = preflight;
    } catch (failure) {
      if (seq !== requestSeq || !node.isConnected) return;
      state.preflight = null;
      state.error = errorText(failure);
    } finally {
      if (seq === requestSeq && node.isConnected) {
        state.loading = false;
        paint();
      }
    }
  }

  async function finish() {
    closeOverlay(node);
    try {
      await onDone?.();
    } catch {
      /* 刷新失败不影响已经完成的移动 */
    }
  }

  async function submit() {
    const confirm = moveConfirmState({
      target: state.target,
      ack: state.ack,
      loading: state.loading,
      busy: state.busy,
      preflight: state.preflight,
      error: state.error,
    });
    if (confirm.disabled || state.busy) return;
    state.busy = true;
    state.error = "";
    paint();
    try {
      const result = await api.moveDocs(name, { ids: sourceIds, target: state.target, onConflict: state.onConflict });
      state.result = result ?? { results: [], moved: 0, skipped: 0, failed: 0 };
      state.busy = false;
      const moved = Number(state.result.moved) || 0;
      const skipped = Number(state.result.skipped) || 0;
      const failed = Number(state.result.failed) || 0;
      notify(`移动完成：成功 ${moved} · 跳过 ${skipped} · 失败 ${failed}`, failed > 0 ? "error" : "info");
      if (node.isConnected) paint();
      try {
        await onDone?.();
      } catch {
        /* 刷新失败不影响已经完成的移动 */
      }
    } catch (failure) {
      state.busy = false;
      state.error = errorText(failure);
      if (node.isConnected) {
        paint();
      } else {
        notify(errorText(failure), "error");
      }
    }
  }

  async function undoAll() {
    if (state.undoing || !state.result) return;
    const moved = (Array.isArray(state.result.results) ? state.result.results : [])
      .filter((item) => item?.status === "moved");
    if (moved.length === 0) return;
    state.undoing = true;
    state.undo = null;
    paint();
    let ok = 0;
    const failures = [];
    for (let index = 0; index < moved.length; index += 1) {
      const item = moved[index];
      state.undoProgress = `正在撤销 ${index + 1}/${moved.length}：${item.title}`;
      paint();
      try {
        await api.undoMove(name, item.id, { target: state.target });
        ok += 1;
      } catch (failure) {
        failures.push({ title: String(item.title ?? item.id ?? ""), error: errorText(failure) });
      }
    }
    state.undoing = false;
    state.undoProgress = "";
    state.undo = { ok, failures };
    paint();
    try {
      await onDone?.();
    } catch {
      /* 刷新失败不影响撤销结果 */
    }
    notify(`已撤销 ${ok} 篇${failures.length > 0 ? `，${failures.length} 篇失败` : ""}`, failures.length > 0 ? "error" : "info");
  }

  paint();
  if (state.target) void loadPreflight();
  return node;
}

/**
 * 0.31.2 检索设置：语义检索开关 + 组件/模型状态 + 一键准备。
 * 开关持久化在 <kbRoot>/.semantic.json；准备 = 安装可选依赖 + 下载模型（需勾选同意）。
 */
export function openSemanticModal({ notify = () => {} } = {}) {
  const node = overlay(`
    <div class="modal-form semantic-settings">
      <h2>检索设置</h2>
      <label class="check-row"><input type="checkbox" name="semantic-enabled" /> <span>启用语义检索</span></label>
      <p class="muted">开启后，用不同说法（比如「灯一直闪」）也能找到写「闪变」的资料。组件和模型放在本机，只需准备一次（约 390MB）；关闭时只按关键词检索，行为和现在完全一样。</p>
      <div class="semantic-status muted">读取状态中…</div>
      <label class="check-row" data-consent-row hidden><input type="checkbox" data-consent /> <span>我同意安装运行组件并下载模型（约 390MB，只做一次）</span></label>
      <p class="form-error" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>关闭</button>
        <button type="button" class="btn primary" data-prepare hidden>一键准备</button>
      </div>
    </div>
  `);
  const enabled = node.querySelector("[name=semantic-enabled]");
  const statusBox = node.querySelector(".semantic-status");
  const error = node.querySelector(".form-error");
  const consentRow = node.querySelector("[data-consent-row]");
  const consent = node.querySelector("[data-consent]");
  const prepare = node.querySelector("[data-prepare]");

  function showError(text) {
    error.textContent = text;
    error.hidden = !text;
  }

  /** 把服务端的机器码翻译成用户能看懂的状态（不直接显示 disabled/missing）。 */
  function indexLine(status) {
    if (status?.enabled !== true) return "索引：未开启（开启后第一次检索会自动建立）";
    if (status?.index?.indexReady === true) return `索引：已就绪（${status.index.docs} 篇）`;
    const reason = String(status?.index?.reason ?? "");
    if (reason === "index_stale") return "索引：资料有变化，下次检索会自动更新";
    if (reason === "index_empty") return "索引：当前库还没有可索引的资料";
    return "索引：尚未建立（开启后第一次检索自动建立，大库可能需要几十秒）";
  }

  function lines(status) {
    statusBox.textContent = "";
    const add = (text) => {
      const line = document.createElement("div");
      line.textContent = text;
      statusBox.appendChild(line);
    };
    add(`运行组件：${status?.dependencies?.ok ? "已安装" : "未安装"}`);
    add(`模型：${status?.model?.ok ? "已下载" : "未下载"}`);
    add(indexLine(status));
    if (status?.preparing) {
      add("正在准备组件与模型…（进度会显示在这里）");
    } else if (status?.ready === true) {
      add("组件与模型已就绪，打开上面的开关即可使用。");
    } else {
      const missing = [];
      if (!status?.dependencies?.ok) missing.push("运行组件");
      if (!status?.model?.ok) missing.push("模型文件");
      add(`还需要准备：${missing.join("、") || "组件与模型"}（点下方「一键准备」，只做一次）`);
    }
    if (status?.enabled === true && status?.ready !== true) {
      add("注意：组件未就绪时，检索会自动回退到关键词模式。");
    }
  }

  function paint(status) {
    enabled.checked = status?.enabled === true;
    const ready = status?.ready === true;
    consentRow.hidden = ready;
    prepare.hidden = ready;
    prepare.disabled = status?.preparing === true;
    prepare.textContent = status?.preparing ? "正在准备…" : "一键准备";
    lines(status);
  }

  async function refresh() {
    try {
      paint(await api.semantic());
    } catch (failure) {
      showError(errorText(failure));
    }
  }

  enabled.onchange = async () => {
    showError("");
    try {
      const status = await api.setSemantic(enabled.checked);
      paint(status);
      if (enabled.checked && status?.ready !== true) {
        notify("已开启；组件未就绪时会先按关键词检索");
      } else {
        notify(enabled.checked ? "已开启语义检索" : "已关闭语义检索");
      }
    } catch (failure) {
      enabled.checked = !enabled.checked;
      showError(errorText(failure));
    }
  };
  consent.onchange = () => { showError(""); };
  prepare.onclick = async () => {
    if (consent.checked !== true) {
      showError("请先勾选上面的同意，再点「一键准备」。");
      return;
    }
    showError("");
    prepare.disabled = true;
    prepare.textContent = "正在准备…";
    try {
      const response = await api.prepareSemantic();
      if (response?.alreadyReady === true) {
        notify("组件与模型已就绪，无需再准备");
        await refresh();
        return;
      }
      if (!response?.jobId) throw new Error("准备任务没有返回任务号，请重试");
      await pollPrepare(response.jobId);
    } catch (failure) {
      showError(errorText(failure));
      prepare.textContent = "一键准备";
      prepare.disabled = false;
    }
  };

  async function pollPrepare(jobId) {
    while (node.isConnected) {
      const job = await api.job(jobId).catch(() => null);
      if (!job) break;
      if (job.progress?.text) statusBox.textContent = job.progress.text;
      if (job.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      prepare.textContent = "一键准备";
      if (job.status === "succeeded") {
        notify("组件与模型已就绪");
        await refresh();
        return;
      }
      showError(job.detail || "准备失败");
      prepare.disabled = false;
      return;
    }
    prepare.textContent = "一键准备";
  }

  void refresh();
  return node;
}

function errorText(failure) {
  return failure instanceof ApiError ? failure.message : String(failure?.message ?? failure);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
