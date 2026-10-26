/**
 * 原件预览与重命名：预览类型判定、弹窗正文 HTML、URL 构造与重命名校验。
 * 全部是纯函数/客户端方法，不需要 DOM。
 */
import test from "node:test";
import assert from "node:assert/strict";

const calls = [];
let payload = { title: "笔记", markdown: "# 标题\n正文" };
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  return { ok: true, status: 200, json: async () => payload };
};

const { api } = await import("../ui/api.js");
const {
  cacheBustUrl,
  installOfficeEngineAndWait,
  normalizeRenameValue,
  officePreviewMode,
  previewKindFor,
  renderOfficeInstallState,
  renderPreviewBody,
} = await import("../ui/views/modals.js");

const URLS = {
  inline: "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/d1/source?inline=1",
  viewer: "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/d1/viewer.html?page=3&q=%E7%94%B5%E5%8E%8B",
  pdf: "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/d1/preview.pdf",
  download: "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/d1/source",
};

test("原件 URL 构造区分下载 / 内联 / Office PDF 预览并编码库名与文档 id", () => {
  assert.equal(
    api.sourceUrl("标准/库", "id 1"),
    "/kb/api/kbs/%E6%A0%87%E5%87%86%2F%E5%BA%93/docs/id%201/source",
  );
  assert.equal(
    api.sourceInlineUrl("标准/库", "id 1"),
    "/kb/api/kbs/%E6%A0%87%E5%87%86%2F%E5%BA%93/docs/id%201/source?inline=1",
  );
  assert.equal(
    api.previewPdfUrl("标准/库", "id 1"),
    "/kb/api/kbs/%E6%A0%87%E5%87%86%2F%E5%BA%93/docs/id%201/preview.pdf",
  );
});

test("docContent 用 GET 打 /content 并解包 JSON", async () => {
  calls.length = 0;
  const content = await api.docContent("标准", "n1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/n1/content");
  assert.equal(calls[0].options.method, "GET");
  assert.deepEqual(content, { title: "笔记", markdown: "# 标题\n正文" });
});

test("previewKindFor 按类型与原件扩展名判定预览方式", () => {
  const cases = [
    [{ type: "note" }, "note"],
    [{ type: "note", sourceFile: "note.pdf" }, "note"],
    [{ type: "pdf-text", sourceFile: "DL 478-2013.pdf" }, "pdf"],
    [{ type: "pdf-scanned", sourceFile: "扫描.PDF" }, "pdf"],
    [{ type: "pdf-mixed" }, "pdf"],
    [{ type: "image", sourceFile: "接线图.PNG" }, "image"],
    [{ type: "unknown", sourceFile: "照片.jpeg" }, "image"],
    [{ type: "unknown", sourceFile: "图标.webp" }, "image"],
    [{ type: "text", sourceFile: "说明.txt" }, "text"],
    [{ type: "markdown", sourceFile: "笔记.MD" }, "text"],
    [{ type: "text" }, "text"],
    [{ type: "docx", sourceFile: "说明书.docx" }, "office"],
    [{ type: "xlsx", sourceFile: "台账.xlsx" }, "office"],
    [{ type: "pptx" }, "office"],
    [{ type: "unknown", sourceFile: "归档.tar.gz" }, "unsupported"],
    [{ type: "epub", sourceFile: "书.epub" }, "unsupported"],
    [{ type: "unknown", sourceFile: "没有扩展名" }, "unsupported"],
    [undefined, "unsupported"],
    [{}, "unsupported"],
  ];
  for (const [doc, kind] of cases) {
    assert.equal(previewKindFor(doc), kind, JSON.stringify(doc));
  }
});

test("PDF 用服务端 viewer iframe，Office 用转换后的 PDF 并提示首次较慢", () => {
  const pdf = renderPreviewBody({ kind: "pdf", urls: URLS });
  assert.match(pdf, /<iframe class="preview-frame" src="\/kb\/api\/kbs\/%E6%A0%87%E5%87%86\/docs\/d1\/viewer\.html\?page=3&amp;q=%E7%94%B5%E5%8E%8B"/);
  assert.doesNotMatch(pdf, /source\?inline=1/, "PDF 不再直连原生 iframe");
  assert.doesNotMatch(pdf, /正在转换原件/);

  const office = renderPreviewBody({ kind: "office", urls: URLS });
  assert.match(office, /<iframe class="preview-frame" src="\/kb\/api\/kbs\/%E6%A0%87%E5%87%86\/docs\/d1\/preview\.pdf"/);
  assert.match(office, /正在转换原件，首次可能需要几秒…/);
});

test("PDF 的 viewer URL 自带页码与关键词，不再追加 #page fragment", () => {
  const html = renderPreviewBody({ kind: "pdf", urls: { viewer: "/x/viewer.html?page=3&q=%E7%94%B5" }, page: 3 });
  assert.match(html, /src="\/x\/viewer\.html\?page=3&amp;q=%E7%94%B5"/);
  assert.doesNotMatch(html, /#page=/);
  assert.match(html, /已定位到第 3 页/);
});

test("没有 viewer URL 时 PDF 回退到内联 + 页码 fragment（旧调用方）", () => {
  const html = renderPreviewBody({
    kind: "pdf",
    urls: { inline: "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/d1/source?inline=1" },
    page: 2,
  });
  assert.match(html, /src="[^"]*source\?inline=1#page=2&amp;zoom=page-fit"/);
});

test("图片用 <img>，笔记/文本用转义后的 pre", () => {
  const image = renderPreviewBody({ kind: "image", urls: URLS });
  assert.match(image, /<img class="preview-image" src="\/kb\/api\/kbs\/%E6%A0%87%E5%87%86\/docs\/d1\/source\?inline=1"/);

  const note = renderPreviewBody({
    kind: "note",
    urls: URLS,
    content: { markdown: "<script>alert(1)</script>\n第二行", truncated: true },
  });
  assert.match(note, /<pre class="preview-text">&lt;script&gt;alert\(1\)&lt;\/script&gt;\n第二行<\/pre>/);
  assert.match(note, /仅显示前 2 MB/);
  assert.doesNotMatch(note, /<script>/);

  const text = renderPreviewBody({ kind: "text", urls: URLS, content: { markdown: "aa & bb" } });
  assert.match(text, /<pre class="preview-text">aa &amp; bb<\/pre>/);
});

test("内容读取失败显示错误与下载入口；未知格式提示下载原件", () => {
  const failed = renderPreviewBody({ kind: "text", urls: URLS, content: { error: "原件不存在" } });
  assert.match(failed, /原件不存在/);
  assert.match(failed, /href="\/kb\/api\/kbs\/%E6%A0%87%E5%87%86\/docs\/d1\/source"/);
  assert.match(failed, /下载原件/);

  const unsupported = renderPreviewBody({ kind: "unsupported", urls: URLS });
  assert.match(unsupported, /该格式暂不支持内嵌预览，请下载原件/);
  assert.match(unsupported, /下载原件/);
});

test("笔记预览失败不渲染死链「下载原件」（笔记没有原件）", () => {
  const failed = renderPreviewBody({ kind: "note", urls: URLS, content: { error: "读取失败" } });
  assert.match(failed, /class="preview-content-error"/);
  assert.match(failed, /读取失败/);
  assert.doesNotMatch(failed, /下载原件/);
  assert.doesNotMatch(failed, /请下载原件后查看/);
  assert.doesNotMatch(failed, /href=/);
});

test("预览正文里的 URL 属性按 HTML 转义", () => {
  const html = renderPreviewBody({ kind: "pdf", urls: { inline: "/x?a=1&b=\"2\"", download: "/x" } });
  assert.match(html, /src="\/x\?a=1&amp;b=&quot;2&quot;"/);
  assert.doesNotMatch(html, /b="2"/);
});

test("normalizeRenameValue 拒绝空值与原名，返回 trim 后的新名", () => {
  assert.deepEqual(normalizeRenameValue("", "标准"), { ok: false, error: "请输入名称" });
  assert.deepEqual(normalizeRenameValue("   ", "标准"), { ok: false, error: "请输入名称" });
  assert.deepEqual(normalizeRenameValue(null, "标准"), { ok: false, error: "请输入名称" });
  assert.deepEqual(normalizeRenameValue(" 标准 ", "标准"), { ok: false, error: "名称没有变化" });
  assert.deepEqual(normalizeRenameValue("  新标准  ", "标准"), { ok: true, value: "新标准" });
  assert.deepEqual(normalizeRenameValue("标准 2", "标准"), { ok: true, value: "标准 2" });
});

// ---------------------------------------------------------------------------
// Office 引擎一键安装（0.23.0）
// ---------------------------------------------------------------------------

test("renderOfficeInstallState 未安装：说明、同意勾选、初始禁用的安装按钮", () => {
  const html = renderOfficeInstallState({ status: { canInstall: true } });
  assert.match(html, /data-office-state="ready"/);
  assert.match(html, /未安装 Office 转换引擎（LibreOfficeKit）/);
  assert.match(html, /安装后可在此直接预览 docx\/pptx\/xlsx；约 300 MB，转换只在本机进行/);
  assert.match(html, /data-office-consent/);
  assert.match(html, /我同意下载并安装（约 300 MB）/);
  assert.match(html, /data-office-install/);
  assert.match(html, /安装转换引擎/);
  assert.match(html, /data-office-install disabled/);
  assert.doesNotMatch(html, /data-office-progress/);
  assert.doesNotMatch(html, /缺少 Node\/npm/);
  assert.doesNotMatch(html, /data-office-error/);
});

test("renderOfficeInstallState 安装中：不确定进度与阶段文案，隐藏勾选/按钮", () => {
  const html = renderOfficeInstallState({
    status: { canInstall: true },
    installing: { phase: "download", text: "正在下载并安装…" },
  });
  assert.match(html, /data-office-state="installing"/);
  assert.match(html, /data-office-progress/);
  assert.match(html, /data-office-progress-text>正在下载并安装…/);
  assert.match(html, /data-office-phase="download"/);
  assert.match(html, /aria-valuetext="正在下载并安装…"/);
  assert.match(html, /preview-install-bar/);
  assert.doesNotMatch(html, /data-office-consent/);
  assert.doesNotMatch(html, /data-office-install/);
});

test("renderOfficeInstallState 失败：错误转义、勾选保留、按钮变为重试", () => {
  const html = renderOfficeInstallState({
    status: { canInstall: true },
    error: "安装包下载失败 <网络>",
  });
  assert.match(html, /data-office-state="error"/);
  assert.match(html, /安装包下载失败 &lt;网络&gt;/);
  assert.doesNotMatch(html, /<网络>/);
  assert.match(html, /data-office-consent checked/);
  assert.match(html, /data-office-install>重试</);
  assert.doesNotMatch(html, /data-office-install disabled/);
});

test("renderOfficeInstallState canInstall=false：提示缺少 Node/npm，不渲染安装入口", () => {
  const html = renderOfficeInstallState({ status: { canInstall: false, toolchain: null } });
  assert.match(html, /缺少 Node\/npm，无法自动安装，请按 README 手动安装/);
  assert.doesNotMatch(html, /data-office-install/);
  assert.doesNotMatch(html, /data-office-consent/);
  assert.doesNotMatch(html, /data-office-progress/);
});

// 勾选解锁按钮只存在于 openPreviewModal 的 DOM 事件里（本套件没有 DOM）；
// 纯函数保证“未勾选时按钮初始 disabled”，交互部分由浏览器冒烟测试覆盖。
test("installOfficeEngineAndWait 成功：轮询 running → 复查状态 → done", async () => {
  const events = [];
  const jobs = [
    { id: "office-install-1", status: "running", progress: { phase: "download", text: "正在下载并安装…" } },
    { id: "office-install-1", status: "succeeded", detail: "已安装 Office 转换引擎" },
  ];
  let statusCalls = 0;
  const fakeApi = {
    installOffice: async () => ({ jobId: "office-install-1" }),
    job: async () => jobs.shift(),
    officeStatus: async () => {
      statusCalls += 1;
      return { available: true, canInstall: true, running: false, version: "0.2.2" };
    },
  };
  const result = await installOfficeEngineAndWait({
    api: fakeApi,
    onState: (state) => events.push(state),
    pollMs: 5,
    maxWaitMs: 1000,
    timers: { setTimeout: (fn) => { fn(); return { unref() {} }; }, now: () => 0 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status.available, true);
  assert.equal(statusCalls, 1, "成功结算后应复查一次 /office/status");
  assert.deepEqual(events.map((state) => state.phase), [
    "starting",
    "installing",
    "installing",
    "verifying",
    "done",
  ]);
  assert.equal(events.at(-1).status.available, true);
});

test("installOfficeEngineAndWait 成功但复查仍不可用 → error", async () => {
  const events = [];
  const fakeApi = {
    installOffice: async () => ({ jobId: "j1" }),
    job: async () => ({ id: "j1", status: "succeeded", detail: "已安装 Office 转换引擎" }),
    officeStatus: async () => ({ available: false, canInstall: true, running: false }),
  };
  const result = await installOfficeEngineAndWait({
    api: fakeApi,
    onState: (state) => events.push(state),
    timers: { setTimeout: (fn) => { fn(); return { unref() {} }; }, now: () => 0 },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /引擎仍不可用/);
  assert.deepEqual(events.map((state) => state.phase), ["starting", "installing", "verifying", "error"]);
});

test("installOfficeEngineAndWait 任务失败：错误文案来自 job.detail", async () => {
  const events = [];
  const fakeApi = {
    installOffice: async () => ({ jobId: "j1" }),
    job: async () => ({ id: "j1", status: "failed", detail: "安装包下载失败" }),
    officeStatus: async () => {
      throw new Error("失败任务不应复查状态");
    },
  };
  const result = await installOfficeEngineAndWait({
    api: fakeApi,
    onState: (state) => events.push(state),
    timers: { setTimeout: (fn) => { fn(); return { unref() {} }; }, now: () => 0 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "安装包下载失败");
  assert.deepEqual(events.map((state) => state.phase), ["starting", "installing", "error"]);
});

test("installOfficeEngineAndWait 安装入口被拒（缺同意）→ error", async () => {
  const events = [];
  const fakeApi = {
    installOffice: async () => {
      const failure = new Error("安装需要用户确认");
      failure.code = "CONSENT_REQUIRED";
      throw failure;
    },
    job: async () => {
      throw new Error("不应轮询");
    },
    officeStatus: async () => null,
  };
  const result = await installOfficeEngineAndWait({
    api: fakeApi,
    onState: (state) => events.push(state),
    timers: { setTimeout: (fn) => { fn(); return { unref() {} }; }, now: () => 0 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "安装需要用户确认");
  assert.deepEqual(events.map((state) => state.phase), ["starting", "error"]);
});

test("installOfficeEngineAndWait 轮询超时：有次数上限并返回超时错误", async () => {
  const events = [];
  let polls = 0;
  const fakeApi = {
    installOffice: async () => ({ jobId: "j1" }),
    job: async () => {
      polls += 1;
      return { id: "j1", status: "running", progress: { text: "正在下载并安装…" } };
    },
    officeStatus: async () => null,
  };
  const result = await installOfficeEngineAndWait({
    api: fakeApi,
    onState: (state) => events.push(state),
    pollMs: 10,
    maxWaitMs: 35,
    timers: { setTimeout: (fn) => { fn(); return { unref() {} }; }, now: () => 0 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.error, /超时/);
  assert.equal(polls, Math.ceil(35 / 10), "超时期间按 pollMs 轮询且不无限循环");
  assert.equal(events.at(-1).phase, "error");
});

test("officeStatus/installOffice 打到 /office 路由并自动带确认体", async () => {
  calls.length = 0;
  payload = { available: true, canInstall: true };
  assert.deepEqual(await api.officeStatus(), { available: true, canInstall: true });
  assert.equal(calls[0].url, "/kb/api/office/status");
  assert.equal(calls[0].options.method, "GET");

  payload = { jobId: "office-install-1" };
  assert.deepEqual(await api.installOffice(), { jobId: "office-install-1" });
  assert.equal(calls[1].url, "/kb/api/office/install");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers["x-kb-ui"], "1");
  assert.deepEqual(JSON.parse(calls[1].options.body), { confirm: true });
});

test("officePreviewMode 未确认可用时先走安装面板；cacheBustUrl 兼容有无查询串", () => {
  assert.equal(officePreviewMode({ available: true }), "frame");
  assert.equal(officePreviewMode({ available: false }), "install");
  assert.equal(officePreviewMode({}), "install");
  assert.equal(officePreviewMode(undefined), "install");
  assert.equal(cacheBustUrl(URLS.pdf, 123), `${URLS.pdf}?v=123`);
  assert.equal(cacheBustUrl("/x?a=1", 9), "/x?a=1&v=9");
  assert.equal(cacheBustUrl("", 9), "");
});

test("Office 安装完成后的载入提示可覆盖默认转换文案", () => {
  const html = renderPreviewBody({
    kind: "office",
    urls: { ...URLS, pdf: cacheBustUrl(URLS.pdf, 42) },
    loadingText: "已安装，正在载入预览…",
  });
  assert.match(html, /src="[^"]*preview\.pdf\?v=42"/);
  assert.match(html, /已安装，正在载入预览…/);
  assert.doesNotMatch(html, /正在转换原件/);
});
