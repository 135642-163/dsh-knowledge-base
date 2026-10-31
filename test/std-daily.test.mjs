/**
 * 每日标准检查：报告文件名/内容与“仅 update/released 提醒”的口径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  dailyDate, dailyReportName, dailyReportPath, notificationText,
  renderDailyReport, shouldNotify,
} from "../lib/std-daily.js";

function report(overrides = {}) {
  return {
    totalDocs: 919,
    stdGroups: 720,
    checked: 0,
    fresh: 720,
    deferred: 0,
    updates: [],
    draftsReleased: [],
    currents: [],
    notFound: [],
    newerInKb: [],
    superseded: [],
    ambiguous: [],
    unknown: [],
    downloaded: [],
    downloadFailed: [],
    librarySuperseded: { groups: [], docs: 0 },
    ...overrides,
  };
}

test("报告文件名/路径按本地日期", () => {
  const now = new Date(2026, 9, 31, 9, 10, 0);
  assert.equal(dailyDate(now), "2026-10-31");
  assert.equal(dailyReportName(now), "std-check-20261031.md");
  assert.equal(dailyReportPath("/tmp/reports/", now), "/tmp/reports/std-check-20261031.md");
});

test("只有 update/released 才提醒", () => {
  assert.equal(shouldNotify(report()), false);
  assert.equal(shouldNotify(report({ currents: [{ number: "1" }] })), false);
  assert.equal(shouldNotify(report({ notFound: [{ number: "2" }] })), false);
  assert.equal(shouldNotify(report({ updates: [{ number: "3" }] })), true);
  assert.equal(shouldNotify(report({ draftsReleased: [{ number: "4" }] })), true);
  assert.equal(notificationText(report({ updates: [{ number: "3" }], draftsReleased: [{ number: "4" }] })), "知识库标准检查：发现更新 1 条，草案已出正式版 1 条");
});

test("每日报告包含日期/知识库/结果与报告正文", () => {
  const now = new Date(2026, 9, 31, 9, 10, 0);
  const text = renderDailyReport(report({
    checked: 3,
    fresh: 717,
    updates: [{ number: "12326", siteNo: "GB/T 12326-2026", siteYear: 2026, kbYears: [2008] }],
    gaps: { notFound: 24, ambiguous: 1, added: 2, removed: 0 },
  }), { now, kb: "标准", action: "check" });
  assert.match(text, /# 标准更新检查 2026-10-31/);
  assert.match(text, /知识库：标准/);
  assert.match(text, /发现更新 1 条/);
  assert.match(text, /缺口台账：未收录 24/);
  assert.match(text, /【发现更新 1 条】/);
  assert.doesNotMatch(text, /本轮没有需要提醒的更新/);
});

test("没有更新时明确写“仅留档”", () => {
  const text = renderDailyReport(report(), { now: new Date(2026, 9, 31), kb: "标准" });
  assert.match(text, /本轮没有需要提醒的更新/);
});
