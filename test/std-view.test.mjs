import test from "node:test";
import assert from "node:assert/strict";
import { renderStdPanel } from "../ui/views/std.js";

const status = {
  kb: "标准",
  configured: true,
  cache: { exists: true, items: 10, lastCheckAt: "2026-10-24T00:00:00.000Z", ageDays: 1.2, ttlDays: 7, valid: true },
  pending: { update: 2, released: 1, downloadable: 3 },
  activeJobId: null,
  lastJob: null,
};

test("标准面板显示缓存/待下载/按钮状态", () => {
  const html = renderStdPanel({ std: { kb: "标准", loading: false, error: "", status, job: null } }, "标准", { escapeHtml: (v) => String(v) });
  assert.match(html, /已配置/);
  assert.match(html, /有新版 2/);
  assert.match(html, /草案转正 1/);
  assert.match(html, /data-action="std-run"/);
  assert.match(html, /data-action="std-download"/);
});

test("未配置 cookie 时下载按钮禁用", () => {
  const html = renderStdPanel(
    { std: { kb: "标准", loading: false, error: "", status: { ...status, configured: false }, job: null } },
    "标准",
    { escapeHtml: (v) => String(v) }
  );
  assert.match(html, /data-action="std-download"[^>]*disabled/);
  assert.match(html, /bzCookie/);
});
