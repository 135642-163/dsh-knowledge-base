/**
 * 每日标准检查的纯函数：报告文件名/内容、是否需要提醒。
 * 脚本 scripts/std-check-daily.mjs 与单测共用，避免日期/提醒口径漂移。
 */
import { renderStdReport } from "./standards.js";

function pad2(value) {
  return String(value).padStart(2, "0");
}

/** 本地日期（脚本/launchd 都按运行机器的本地时区）。 */
export function dailyDate(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function dailyReportName(now = new Date()) {
  return `std-check-${dailyDate(now).replace(/-/g, "")}.md`;
}

export function dailyReportPath(reportsDir, now = new Date()) {
  return `${String(reportsDir).replace(/[/\\]+$/, "")}/${dailyReportName(now)}`;
}

/** 只有发现更新/草案转正才提醒；已是最新/未收录/废止不打扰。 */
export function shouldNotify(report) {
  const updates = report?.updates?.length ?? 0;
  const released = report?.draftsReleased?.length ?? 0;
  return updates + released > 0;
}

export function notificationText(report) {
  const updates = report?.updates?.length ?? 0;
  const released = report?.draftsReleased?.length ?? 0;
  const parts = [];
  if (updates > 0) parts.push(`发现更新 ${updates} 条`);
  if (released > 0) parts.push(`草案已出正式版 ${released} 条`);
  return `知识库标准检查：${parts.join("，")}`;
}

/**
 * 生成每日报告 markdown（落 docs/reports/std-check-YYYYMMDD.md）。
 * 只包含报告正文，不写绝对路径以外的机器信息；排查用。
 */
function normalizeReport(report = {}) {
  return {
    totalDocs: 0,
    stdGroups: 0,
    checked: 0,
    fresh: 0,
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
    dailyLimit: false,
    authOk: null,
    ...report,
  };
}

export function renderDailyReport(report, { now = new Date(), kb = "", action = "check" } = {}) {
  const safe = normalizeReport(report);
  const lines = [];
  lines.push(`# 标准更新检查 ${dailyDate(now)}`);
  lines.push("");
  lines.push(`- 知识库：${kb || "（未指定）"}`);
  lines.push(`- 运行时间：${now.toISOString()}`);
  lines.push(`- 动作：${action}`);
  lines.push(`- 结果：发现更新 ${safe.updates.length} 条、草案转正 ${safe.draftsReleased.length} 条、站点标注废止 ${safe.superseded.length} 条、分册歧义 ${safe.ambiguous.length} 条、未收录 ${safe.notFound.length} 条。`);
  if (report?.gaps) {
    lines.push(`- 缺口台账：未收录 ${report.gaps.notFound}、分册歧义 ${report.gaps.ambiguous}（本轮新增 ${report.gaps.added}、移除 ${report.gaps.removed}）。`);
  }
  lines.push("");
  lines.push("```text");
  lines.push(renderStdReport(safe));
  lines.push("```");
  if (!shouldNotify(safe)) {
    lines.push("");
    lines.push("> 本轮没有需要提醒的更新；本文件仅作流水留档。");
  }
  lines.push("");
  return lines.join("\n");
}
