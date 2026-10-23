/**
 * 标准更新工作台服务：状态推导、结果裁剪、任务封装。
 * 只读 .std-check.json；bzCookie 永不出现在任何返回值里。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runStdCheck, importDownloaded, createStdImportFn } from "../standards.js";
import { refreshKbIndex } from "../import-job.js";
import { readManifest, isDeleted } from "../store.js";
import { WebError } from "./http.js";

export const STD_ENTRY_LIMIT = 200;

const STATUS_ORDER = { imported: 0, downloaded: 1, update: 2, released: 3, failed: 4, notfound: 5, newer: 6, current: 7 };

export async function readStdStatus({ kbDir, kb, configured, ttlDays = 7, now = Date.now() }) {
  let cache = null;
  try {
    cache = JSON.parse(await readFile(join(kbDir, ".std-check.json"), "utf8"));
  } catch {
    cache = null;
  }
  const items = cache?.items && typeof cache.items === "object" ? cache.items : {};
  const values = Object.values(items);
  let lastCheckAt = 0;
  for (const item of values) lastCheckAt = Math.max(lastCheckAt, Number(item?.checkedAt) || 0);
  const pending = values.filter(
    (item) => (item?.status === "update" || item?.status === "released") && !item?.downloadedAt
  );
  const update = pending.filter((item) => item.status === "update").length;
  const released = pending.filter((item) => item.status === "released").length;
  const ageDays = lastCheckAt > 0 ? (now - lastCheckAt) / 86400000 : null;
  return {
    kb,
    configured: Boolean(configured),
    cache: {
      exists: cache !== null,
      items: values.length,
      lastCheckAt: lastCheckAt > 0 ? new Date(lastCheckAt).toISOString() : null,
      ageDays: ageDays === null ? null : Math.round(ageDays * 10) / 10,
      ttlDays,
      valid: ageDays !== null && ageDays <= ttlDays,
    },
    pending: { update, released, downloadable: update + released },
  };
}

function collectStdEntries(report, imported = []) {
  const importedByNo = new Map();
  for (const item of imported) {
    if (item?.docId) importedByNo.set(String(item.stdNo ?? ""), item);
  }
  const downloadedByNo = new Map((report.downloaded ?? []).map((item) => [String(item.stdNo ?? ""), item]));
  const failedByNo = new Map((report.downloadFailed ?? []).map((item) => [String(item.stdNo ?? item.aid ?? ""), item]));

  const entries = [];
  const push = (entry) => entries.push(entry);

  for (const item of report.updates ?? []) {
    const number = String(item.siteNo ?? item.number ?? "");
    const failed = failedByNo.get(number);
    const status = importedByNo.has(number)
      ? "imported"
      : failed
        ? "failed"
        : downloadedByNo.has(number)
          ? "downloaded"
          : "update";
    push({
      number,
      title: String(item.siteTitle ?? ""),
      status,
      fromYear: String(item.docs?.map((d) => d.year).filter(Boolean).sort().reverse()[0] ?? ""),
      toYear: String(item.siteYear ?? ""),
      ...(failed ? { message: String(failed.reason ?? "") } : {}),
    });
  }
  for (const item of report.draftsReleased ?? []) {
    const number = String(item.siteNo ?? item.number ?? "");
    push({
      number,
      title: String(item.siteTitle ?? ""),
      status: importedByNo.has(number) ? "imported" : downloadedByNo.has(number) ? "downloaded" : "released",
      fromYear: "草案",
      toYear: String(item.siteYear ?? ""),
    });
  }
  for (const item of report.downloadFailed ?? []) {
    push({ number: String(item.stdNo ?? ""), title: "", status: "failed", message: String(item.reason ?? "") });
  }
  for (const item of report.notFound ?? []) {
    push({ number: String(item.siteNo ?? item.number ?? ""), title: "", status: "notfound" });
  }
  for (const item of report.newerInKb ?? []) {
    push({ number: String(item.siteNo ?? item.number ?? ""), title: String(item.siteTitle ?? ""), status: "newer" });
  }
  for (const item of report.currents ?? []) {
    push({ number: String(item.siteNo ?? item.number ?? ""), title: String(item.siteTitle ?? ""), status: "current" });
  }

  entries.sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99));
  return entries;
}

/** 对外：截断后的条目列表。 */
export function buildStdEntries(report, imported = []) {
  return collectStdEntries(report, imported).slice(0, STD_ENTRY_LIMIT);
}

export function buildStdResult({ report, imported = [], importError = "", hint = "" }) {
  const all = collectStdEntries(report, imported);
  const entries = all.slice(0, STD_ENTRY_LIMIT);
  return {
    counts: {
      totalDocs: report.totalDocs ?? 0,
      stdGroups: report.stdGroups ?? 0,
      checked: report.checked ?? 0,
      fresh: report.fresh ?? 0,
      deferred: report.deferred ?? 0,
      updates: (report.updates ?? []).length,
      draftsReleased: (report.draftsReleased ?? []).length,
      currents: (report.currents ?? []).length,
      notFound: (report.notFound ?? []).length,
      newerInKb: (report.newerInKb ?? []).length,
      downloaded: (report.downloaded ?? []).length,
      downloadFailed: (report.downloadFailed ?? []).length,
      imported: imported.filter((item) => item?.docId).length,
      authOk: report.authOk ?? null,
    },
    entries,
    truncated: all.length > STD_ENTRY_LIMIT,
    hint: importError ? `${hint}导入失败：${importError}`.trim() : hint,
  };
}

export async function startStdJob({
  kb,
  kbDir,
  body,
  jobs,
  stdOpts,
  importConfig,
  runStdCheckImpl = runStdCheck,
  importDownloadedImpl = importDownloaded,
}) {
  const action =
    body?.action === "check" ? "check"
      : body?.action === "download" ? "download"
        : body?.action === "check-download" ? "check-download"
          : null;
  if (action === null) throw new WebError("STD_ACTION_INVALID", 400, "action 只能是 check / check-download / download");
  const dryRun = body?.dryRun === true;
  const wantsDownload = action !== "check" && !dryRun;
  if (wantsDownload && !stdOpts.configured) {
    throw new WebError("STD_NO_COOKIE", 400, "未配置 bzCookie，无法下载；可先只做检查");
  }
  if (await jobs.hasRunning({ kb, kind: "kb-std" })) {
    throw new WebError("STD_JOB_RUNNING", 409, "该库已有标准更新任务在运行");
  }

  const force = body?.force === true;
  const limit = Math.max(0, Math.round(Number(body?.limit) || 0));
  const jobId = jobs.start({
    kind: "kb-std",
    kb,
    label: action === "check" ? `标准检查 ${kb}` : `标准检查并下载 ${kb}`,
    run: async (job) => {
      const progress = { kind: "std", phase: "collect", done: 0, total: 0, current: "", checked: 0, updates: 0, downloaded: 0, imported: 0, failed: 0 };
      const emit = (event) => {
        Object.assign(progress, event);
        job.setProgress({ ...progress, kind: "std" });
      };
      const { report, cache } = await runStdCheckImpl({
        kbDir,
        baseUrl: stdOpts.baseUrl,
        cookie: stdOpts.cookie,
        rateMs: stdOpts.rateMs,
        maxAgeDays: stdOpts.maxAgeDays,
        force,
        limit,
        action,
        dryRun,
        onProgress: emit,
      });
      let imported = [];
      let importError = "";
      if (wantsDownload && (report.downloaded ?? []).length > 0) {
        const manifest = await readManifest(kbDir);
        const existing = new Set(
          (manifest.docs ?? []).filter((doc) => !isDeleted(doc)).map((doc) => doc.sourceFile ?? "").filter(Boolean)
        );
        const pending = Object.values(cache.items ?? {}).filter((item) => item.downloadedFile && !item.importedDocId);
        let done = 0;
        const importFile = createStdImportFn({
          kbDir,
          existing,
          config: importConfig,
          onProgress: (file, title) => {
            done += 1;
            emit({ phase: "import", done, total: pending.length, current: String(title ?? file), imported: done });
          },
        });
        try {
          imported = await importDownloadedImpl(kbDir, cache, importFile, {});
        } catch (error) {
          importError = String(error?.message ?? error);
        }
      }
      await refreshKbIndex(kbDir).catch(() => {});
      const result = buildStdResult({ report, imported, importError });
      return {
        status: "succeeded",
        detail: `检查 ${result.counts.checked} 组，更新 ${result.counts.updates}，下载 ${result.counts.downloaded}，导入 ${result.counts.imported}`,
        result,
      };
    },
  });
  return { jobId };
}
