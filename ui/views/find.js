/**
 * 「找资料」页：输入文字或图片 → 后端分别走标准网/网页搜索 → 候选列表 → 选择目标库导入。
 * 只做展示与事件绑定；搜索/下载/OCR 都在后端完成，页面不接触密钥。
 */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

const escapeAttr = escapeHtml;

function sourceLabel(source) {
  return source === "biaozhun" ? "标准网" : "网页";
}

function authorityLabel(item) {
  if (item.source === "biaozhun") return "标准网";
  const value = Number(item.authority);
  if (!Number.isFinite(value) || value < 0) return "";
  return `权威 ${value}`;
}

function candidateHtml(item, index, { importingUrl, importResult }) {
  const meta = [
    sourceLabel(item.source),
    item.stdNo || "",
    item.site || "",
    item.date || "",
    authorityLabel(item),
  ].filter(Boolean);
  const library = item.inLibrary
    ? `<span class="badge ok" title="库内已有：${escapeAttr(item.inLibrary.title ?? "")}">库内已有 · ${escapeHtml(item.inLibrary.kb ?? "")}</span>`
    : "";
  const isImporting = importingUrl === item.url;
  const justImported = importResult?.url === item.url && importResult?.ok === true;
  const unavailable = Boolean(item.inLibrary) || justImported;
  const done = importResult && importResult.url === item.url
    ? `<p class="muted find-import-result">${escapeHtml(importResult.detail ?? "")}</p>`
    : "";
  return `
    <article class="search-card" data-find-url="${escapeAttr(item.url)}">
      <div class="search-card-head">
        <a class="search-card-title" href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title || item.url)}</a>
        <span class="search-card-badges">${library}</span>
      </div>
      <p class="search-card-meta muted">${meta.map((text) => escapeHtml(text)).join(" · ")}</p>
      ${item.summary ? `<p class="search-card-snippet">${escapeHtml(item.summary)}</p>` : ""}
      <div class="search-card-foot">
        <div class="find-actions">
          <button type="button" class="btn primary" data-find-import="${index}" ${isImporting || unavailable ? "disabled" : ""}>
            ${isImporting ? "正在导入…" : justImported ? "已下载导入" : item.inLibrary ? "已在库内" : "下载并导入"}
          </button>
          <a class="btn" href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">打开来源</a>
        </div>
      </div>
      ${done}
    </article>`;
}

export function renderFind(state, { kbs = [] } = {}) {
  const find = state.find ?? {};
  const result = find.result ?? null;
  const candidates = result?.candidates ?? [];
  const kbOptions = kbs.map((kb) => `<option value="${escapeAttr(kb.name)}"${(find.kb || kbs[0]?.name) === kb.name ? " selected" : ""}>${escapeHtml(kb.name)}</option>`).join("");
  const imageChip = find.imageName
    ? `<span class="badge" data-find-image-chip>图片：${escapeHtml(find.imageName)} <button type="button" class="linklike" data-find-clear-image aria-label="移除图片">×</button></span>`
    : "";
  return `
    <section class="find-page">
      <div class="find-hero">
        <h1>找资料</h1>
        <p class="muted">标准号/标准名优先在标准网检索；公文、规范、文献、教材等走网页搜索。也可以直接传一张封面或截图，插件会先识别出标准号/标题。</p>
      </div>
      <form data-find-form>
        <div class="search-toolbar">
          <div class="search-form">
            <input type="search" data-find-query value="${escapeAttr(find.query ?? "")}"
                   placeholder="例如：GB/T 19963.2-2024 / 配电网技术导则 / 新型电力系统蓝皮书"
                   autocomplete="off" spellcheck="false" aria-label="搜索词" />
            <button type="submit" class="btn primary">搜索</button>
          </div>
          <div class="search-filters">
            <select data-find-type aria-label="资料类型">
              <option value="auto"${(find.type ?? "auto") === "auto" ? " selected" : ""}>自动判断类型</option>
              <option value="standard"${find.type === "standard" ? " selected" : ""}>仅标准</option>
              <option value="general"${find.type === "general" ? " selected" : ""}>仅其他资料</option>
            </select>
            <select data-find-kb aria-label="导入到哪个知识库" ${kbOptions ? "" : "disabled"}>
              ${kbOptions || `<option value="">（暂无知识库）</option>`}
            </select>
            <select data-find-ocr-engine aria-label="图片识别引擎">
              <option value="auto"${(find.ocrEngine ?? "auto") === "auto" ? " selected" : ""}>图片识别：本地</option>
              <option value="deepseek"${find.ocrEngine === "deepseek" ? " selected" : ""}>图片识别：云端</option>
            </select>
            <select data-find-count aria-label="候选数量">
              ${[5, 8, 12, 20].map((n) => `<option value="${n}"${Number(find.count) === n ? " selected" : ""}>${n} 条</option>`).join("")}
            </select>
            <label class="btn find-image-btn">图片
              <input type="file" accept="image/png,image/jpeg,image/webp" data-find-image hidden />
            </label>
            ${imageChip}
          </div>
          <p class="muted search-status">图片识别默认本地；选云端会上传这张图片并计费。搜索只返回候选，确认后再下载入库。</p>
        </div>
      </form>
      ${find.error ? `<p class="form-error">${escapeHtml(find.error)}</p>` : ""}
      ${find.loading ? `<div class="state">正在查找…</div>` : ""}
      ${result && !find.loading ? `
        <div class="find-result-head">
          <h2>「${escapeHtml(result.query ?? "")}」的候选</h2>
          <span class="muted">${candidates.length} 条${result.kind === "standard" ? " · 标准" : " · 通用资料"}${result.imageOcr ? ` · 图片${result.imageOcr.cloud ? "云端" : "本地"} OCR` : ""}</span>
        </div>
        ${result.warnings?.length ? `<p class="form-error">${result.warnings.map((w) => escapeHtml(w)).join("；")}</p>` : ""}
        ${candidates.length === 0
          ? `<div class="state">没有找到候选。可换关键词、加标准号，或直接到工作台导入本机文件。</div>`
          : `<div class="search-results find-list">${candidates.map((item, index) => candidateHtml(item, index, {
              importingUrl: find.importingUrl,
              importResult: find.importResult,
            })).join("")}</div>`}
      ` : ""}
    </section>`;
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

/** 浏览器端统一转 PNG：后端（mupdf）不支持 WebP，且手机照片常见 HEIC/WebP。 */
async function readImageAsPng(file) {
  const dataUrl = await readImageFile(file);
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("无法解码这张图片"));
    img.src = dataUrl;
  });
  const maxSide = 2400;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/**
 * 事件绑定：搜索、图片选择、候选导入与任务轮询。
 * 每次 render 后重新挂载；旧 DOM 上的请求由页面卸载后自然丢弃。
 */
export function mountFind({ app, state, api, render, showToast }) {
  const form = app.querySelector("[data-find-form]");
  if (!form) return;
  const queryInput = form.querySelector("[data-find-query]");
  const typeSelect = form.querySelector("[data-find-type]");
  const kbSelect = form.querySelector("[data-find-kb]");
  const countSelect = form.querySelector("[data-find-count]");
  const ocrEngineSelect = form.querySelector("[data-find-ocr-engine]");
  const imageInput = form.querySelector("[data-find-image]");
  const chip = form.querySelector("[data-find-image-chip]");

  const currentFind = () => state.find;

  async function runSearch() {
    const find = currentFind();
    find.query = String(queryInput?.value ?? "").trim();
    find.type = String(typeSelect?.value ?? "auto");
    find.count = Number(countSelect?.value) || 8;
    find.ocrEngine = String(ocrEngineSelect?.value ?? "auto") === "deepseek" ? "deepseek" : "auto";
    find.kb = String(kbSelect?.value ?? find.kb ?? "");
    if (find.query === "" && !find.imageData) {
      find.error = "请输入搜索词，或选择一张图片";
      render();
      return;
    }
    find.loading = true;
    find.error = "";
    find.importResult = null;
    render();
    try {
      const result = await api.findSources({
        query: find.query,
        type: find.type,
        count: find.count,
        ...(find.imageData
          ? { image: { name: find.imageName, dataUrl: find.imageData }, ocrEngine: find.ocrEngine }
          : {}),
      });
      Object.assign(currentFind(), {
        loading: false,
        result,
        imageData: "",
        imageName: "",
        kb: find.kb || kbSelect?.value || "",
      });
    } catch (error) {
      Object.assign(currentFind(), { loading: false, error: error?.message ?? String(error) });
    }
    render();
  }

  form.onsubmit = (event) => {
    event.preventDefault();
    void runSearch();
  };

  imageInput?.addEventListener("change", async () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      currentFind().error = "图片不能超过 8 MB";
      render();
      return;
    }
    try {
      const dataUrl = await readImageAsPng(file);
      const find = currentFind();
      // 选图会触发重渲染：先把输入框里“已删除关键词”后的真实值同步回 state，
      // 否则 render() 会用旧 query 把输入框填回去，搜索也继续用旧关键词。
      find.query = String(queryInput?.value ?? "").trim();
      find.type = String(typeSelect?.value ?? find.type ?? "auto");
      find.count = Number(countSelect?.value) || find.count || 8;
      find.kb = String(kbSelect?.value ?? find.kb ?? "");
      find.imageData = dataUrl;
      find.imageName = file.name || "图片";
      find.error = "";
      if (chip) {
        chip.outerHTML = `<span class="badge" data-find-image-chip>图片：${escapeHtml(find.imageName)} <button type="button" class="linklike" data-find-clear-image aria-label="移除图片">×</button></span>`;
      } else {
        render();
      }
    } catch (error) {
      currentFind().error = error?.message ?? String(error);
      render();
    }
  });

  form.addEventListener("click", (event) => {
    if (event.target.closest("[data-find-clear-image]")) {
      event.preventDefault();
      const find = currentFind();
      find.imageData = "";
      find.imageName = "";
      render();
    }
  });

  const list = app.querySelector(".find-list") ?? app.querySelector(".find-page");
  list?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-find-import]");
    if (!button) return;
    event.preventDefault();
    const find = currentFind();
    const index = Number(button.dataset.findImport);
    const item = find.result?.candidates?.[index];
    if (!item) return;
    const kb = String(kbSelect?.value ?? find.kb ?? "");
    if (!kb) {
      showToast?.("请先选择要导入的知识库", "error");
      return;
    }
    find.importingUrl = item.url;
    find.importResult = null;
    find.error = "";
    render();
    try {
      const { jobId } = await api.findImport({
        url: item.url,
        kb,
        stdNo: item.stdNo || "",
        source: item.source || "",
        title: item.title || "",
      });
      if (!jobId) throw new Error("后端没有返回任务 id");
      const job = await waitJob(jobId);
      const ok = job?.status === "succeeded";
      const detail = job?.detail || (ok ? "已下载并导入" : "导入失败");
      if (ok) item.inLibrary = { kb, title: item.title };
      Object.assign(currentFind(), {
        importingUrl: "",
        importResult: { url: item.url, ok, detail },
      });
      showToast?.(detail, ok ? "info" : "error");
    } catch (error) {
      Object.assign(currentFind(), {
        importingUrl: "",
        importResult: { url: item.url, ok: false, detail: error?.message ?? String(error) },
      });
      showToast?.(error?.message ?? String(error), "error");
    }
    if (window.location.hash.includes("/find")) render();
  });

  async function waitJob(jobId) {
    const started = Date.now();
    for (;;) {
      const job = await api.job(jobId);
      if (job?.status !== "running") return job;
      if (Date.now() - started > 30 * 60 * 1000) throw new Error("导入超时，请到知识库列表查看结果");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

}
