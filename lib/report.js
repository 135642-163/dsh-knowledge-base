/**
 * 后台导入结果的归一化：把 worker 的逐文件统计转成任务状态与给人看的一句话。
 * 关键约束：只要有失败，状态就不能是 completed（部分失败也要显式说出来）。
 */

/**
 * @param report worker 写出的 {ok, fail, skip, files?}，或 null（worker 未留下统计）
 * @param meta { fileCount, kb }
 * @returns { status: "completed"|"failed", detail, counts }
 */
export function summarizeImportReport(report, { fileCount, kb } = {}) {
  const title = kb ? `知识库「${kb}」` : "知识库";
  if (report === null || typeof report !== "object") {
    return {
      status: "completed",
      detail: `${title}导入结束（未取得逐文件统计）`,
      counts: null,
    };
  }
  const ok = Number.isFinite(report.ok) ? Math.max(0, report.ok) : 0;
  const fail = Number.isFinite(report.fail) ? Math.max(0, report.fail) : 0;
  const skip = Number.isFinite(report.skip) ? Math.max(0, report.skip) : 0;
  const counts = { ok, fail, skip };
  const total = Number.isFinite(fileCount) ? fileCount : ok + fail + skip;
  const parts = [`成功 ${ok}`];
  if (fail > 0) parts.push(`失败 ${fail}`);
  if (skip > 0) parts.push(`跳过 ${skip}`);
  const status = fail > 0 ? "failed" : "completed";
  const detail = `${title}导入${fail > 0 ? "部分失败" : "完成"}：${parts.join("，")}（共 ${total} 个文件）`;
  return { status, detail, counts };
}
