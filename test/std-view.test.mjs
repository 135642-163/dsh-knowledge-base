import test from "node:test";
import assert from "node:assert/strict";
import { renderStdPanel, stdStatusLabel } from "../ui/views/std.js";

/** 与工作台一致的转义实现：测试必须真正校验动态文本被转义。 */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

const status = {
  kb: "标准",
  configured: true,
  cache: { exists: true, items: 10, lastCheckAt: "2026-10-24T00:00:00.000Z", ageDays: 1.2, ttlDays: 7, valid: true },
  pending: { update: 2, released: 1, downloadable: 3 },
  activeJobId: null,
  lastJob: null,
};

function withStatus(patch = {}) {
  return { ...status, ...patch };
}

function panel(stdState, kb = "标准") {
  return renderStdPanel({ std: stdState }, kb, { escapeHtml });
}

function std(overrides = {}) {
  return { kb: "标准", loading: false, error: "", warning: "", starting: false, status, job: null, ...overrides };
}

test("标准面板显示缓存/待下载/按钮状态", () => {
  const html = panel(std());
  assert.match(html, /已配置/);
  assert.match(html, /有新版 2/);
  assert.match(html, /草案转正 1/);
  assert.match(html, /data-action="std-run"/);
  assert.match(html, /data-action="std-download"/);
});

test("未配置 cookie 时下载按钮禁用", () => {
  const html = panel(std({ status: withStatus({ configured: false }) }));
  assert.match(html, /data-action="std-download"[^>]*disabled/);
  assert.match(html, /bzCookie/);
});

test("运行阶段显示中文标签且不出现 collect", () => {
  const collecting = panel(std({
    status: withStatus({ activeJobId: "job-1" }),
    job: { id: "job-1", status: "running", progress: { phase: "collect", done: 1, total: 3, current: "GB 1" } },
  }));
  assert.match(collecting, /<strong>收集<\/strong>/);
  assert.doesNotMatch(collecting, /collect/);
  assert.match(collecting, /1\/3/);
  assert.match(collecting, /data-action="std-run"[^>]*disabled/);

  const checking = panel(std({
    status: withStatus({ activeJobId: "job-2" }),
    job: { id: "job-2", status: "running", progress: { phase: "check", done: 2, total: 4, current: "" } },
  }));
  assert.match(checking, /<strong>检查<\/strong>/);
});

test("starting 状态禁用所有动作", () => {
  const html = panel(std({ starting: true }));
  assert.match(html, /data-action="std-run"[^>]*disabled/);
  assert.match(html, /data-action="std-download"[^>]*disabled/);
  assert.match(html, /id="std-force"[^>]*disabled/);
  assert.match(html, /准备中/);
});

test("downloadable 为 0 时禁用补下载", () => {
  const html = panel(std({ status: withStatus({ pending: { update: 2, released: 1, downloadable: 0 } }) }));
  assert.match(html, /data-action="std-download" data-mode="download"[^>]*disabled/);
  assert.doesNotMatch(html, /data-action="std-download" data-mode="check-download"[^>]*disabled/);
});

test("结果摘要显示导入失败计数、hint、登录失效与截断提示", () => {
  const result = {
    counts: { checked: 4, updates: 2, downloaded: 1, imported: 0, importFailed: 1, downloadFailed: 1, authOk: false },
    entries: [{ number: "GB 1", title: "标题", status: "importFailed", message: "导入失败原因" }],
    truncated: true,
    hint: "请稍后重试",
  };
  const html = panel(std({ job: { id: "job-3", status: "succeeded", result } }));
  assert.match(html, /导入失败 1/);
  assert.match(html, /导入失败原因/);
  assert.match(html, /请稍后重试/);
  assert.match(html, /登录态失效/);
  assert.match(html, /仅显示前 200 条/);
});

test("std.error 显示错误与重试按钮", () => {
  const html = panel(std({ status: null, error: "网络错误" }));
  assert.match(html, /网络错误/);
  assert.match(html, /data-action="std-reload"/);
  assert.match(html, /重试/);

  const inline = panel(std({ status, error: "刷新状态失败" }));
  assert.match(inline, /刷新状态失败/);
  assert.match(inline, /data-action="std-reload"/);
});

test("轮询警告显示在面板内", () => {
  const html = panel(std({ warning: "进度获取失败，2 秒后重试…" }));
  assert.match(html, /进度获取失败，2 秒后重试…/);
});

test("无缓存或缺少年龄记录时显示无记录而不是 0 天前", () => {
  const noCache = panel(std({ status: withStatus({ cache: { exists: false, items: 0, lastCheckAt: null, ageDays: null, ttlDays: 7, valid: false } }) }));
  assert.match(noCache, /无记录/);
  assert.match(noCache, /TTL 7 天/);
  assert.doesNotMatch(noCache, /0 天前/);

  const noAge = panel(std({ status: withStatus({ cache: { exists: true, items: 2, lastCheckAt: null, ageDays: null, ttlDays: 0, valid: false } }) }));
  assert.match(noAge, /无记录/);
  assert.match(noAge, /TTL 0 天/);
  assert.doesNotMatch(noAge, /0 天前/);
});

test("切换知识库时旧 state.std 只显示加载态", () => {
  const html = panel({ ...std(), kb: "电气" }, "标准");
  assert.match(html, /加载中/);
  assert.doesNotMatch(html, /有新版 2/);
});

test("恶意标题/说明/hint 全部转义", () => {
  const result = {
    counts: { checked: 1, importFailed: 1, authOk: true },
    entries: [{ number: "<GB>", title: '<img src=x onerror="alert(1)">', status: "failed", message: "<script>alert(2)</script>" }],
    hint: '<img src=x onerror=alert(3)>',
  };
  const html = panel(std({ job: { id: "job-4", status: "succeeded", result } }));
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test("摘要包含 TTL、可补下载，并本地化上次任务状态", () => {
  const html = panel(std({
    status: withStatus({
      lastJob: { id: "job-5", status: "succeeded", finishedAt: "2026-10-24T00:00:00.000Z", summary: {} },
    }),
    warning: "",
  }));
  assert.match(html, /TTL 7 天/);
  assert.match(html, /可补下载 3/);
  assert.match(html, /上次任务：已完成/);
  assert.doesNotMatch(html, /succeeded/);
});

test("stdStatusLabel 覆盖金币/认证/导入失败/已是最新", () => {
  assert.equal(stdStatusLabel("failed", "金币不足"), "金币不足");
  assert.equal(stdStatusLabel("failed", "认证失败"), "认证失败");
  assert.equal(stdStatusLabel("importFailed"), "导入失败");
  assert.equal(stdStatusLabel("current"), "已是最新");
});
