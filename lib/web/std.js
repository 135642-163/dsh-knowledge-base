/**
 * 标准更新工作台服务：状态推导、结果裁剪、任务封装。
 * 只读 .std-check.json；bzCookie 永不出现在任何返回值里。
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runStdCheck, importDownloaded, createStdImportFn } from "../standards.js";
import { refreshKbIndex } from "../import-job.js";
import { readManifest, isDeleted } from "../store.js";
import { WebError } from "./http.js";
import { redactPaths } from "./redact.js";

export const STD_ENTRY_LIMIT = 200;

const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MAX_MESSAGE_CHARS = 300;
const CANCEL_HINT = "任务已取消：已完成的部分保留，未检查/未下载的标准未执行。";
const CANCEL_DETAIL = "已取消（未完成部分未执行）";

// importFailed 与 failed 同属失败组（priority 4），紧邻声明便于 UI 归类。
const STATUS_ORDER = { imported: 0, downloaded: 1, update: 2, released: 3, ambiguous: 3.5, superseded: 3.6, failed: 4, importFailed: 4, notfound: 5, newer: 6, current: 7 };

/** 面向客户端的文本统一净化 + 截断：绝对路径与超长消息都不出工作台。 */
function cleanText(text, prefixes) {
  const out = redactPaths(String(text ?? ""), prefixes);
  return out.length > MAX_MESSAGE_CHARS ? out.slice(0, MAX_MESSAGE_CHARS) : out;
}

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
  const importFailedByNo = new Map();
  for (const item of imported) {
    const number = String(item?.stdNo ?? "");
    if (item?.error) importFailedByNo.set(number, item);
    else if (item?.docId) importedByNo.set(number, item);
  }
  const downloadedByNo = new Map((report.downloaded ?? []).map((item) => [String(item.stdNo ?? ""), item]));
  const failedByNo = new Map(
    (report.downloadFailed ?? []).map((item) => [String(item.stdNo ?? item.aid ?? item.number ?? ""), item])
  );

  const entries = [];
  const represented = new Set();
  const push = (entry) => {
    entries.push(entry);
    represented.add(entry.number);
  };

  for (const item of report.updates ?? []) {
    const number = String(item.siteNo ?? item.number ?? "");
    const importFailed = importFailedByNo.get(number);
    const failed = failedByNo.get(number);
    const status = importedByNo.has(number)
      ? "imported"
      : importFailed
        ? "importFailed"
        : failed
          ? "failed"
          : downloadedByNo.has(number)
            ? "downloaded"
            : "update";
    const message = importFailed ? String(importFailed.error ?? "") : failed ? String(failed.reason ?? "") : "";
    push({
      number,
      title: String(item.siteTitle ?? ""),
      status,
      fromYear: String(item.docs?.map((d) => d.year).filter(Boolean).sort().reverse()[0] ?? ""),
      toYear: String(item.siteYear ?? ""),
      ...(message ? { message } : {}),
    });
  }
  for (const item of report.draftsReleased ?? []) {
    const number = String(item.siteNo ?? item.number ?? "");
    const importFailed = importFailedByNo.get(number);
    const failed = failedByNo.get(number);
    const status = importedByNo.has(number)
      ? "imported"
      : importFailed
        ? "importFailed"
        : failed
          ? "failed"
          : downloadedByNo.has(number)
            ? "downloaded"
            : "released";
    const message = importFailed ? String(importFailed.error ?? "") : failed ? String(failed.reason ?? "") : "";
    push({
      number,
      title: String(item.siteTitle ?? ""),
      status,
      fromYear: "草案",
      toYear: String(item.siteYear ?? ""),
      ...(message ? { message } : {}),
    });
  }
  for (const item of report.downloadFailed ?? []) {
    const number = String(item.stdNo ?? item.aid ?? item.number ?? "");
    if (number && represented.has(number)) continue;
    push({ number, title: "", status: "failed", message: String(item.reason ?? "") });
  }
  for (const item of report.superseded ?? []) {
    push({
      number: String(item.siteNo ?? item.number ?? ""),
      title: String(item.siteTitle ?? ""),
      status: "superseded",
      message: String(item.siteStatus ?? ""),
    });
  }
  for (const item of report.ambiguous ?? []) {
    push({ number: String(item.siteNo ?? item.number ?? ""), title: String(item.siteTitle ?? ""), status: "ambiguous" });
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
  const importFailed = imported.filter((item) => item?.error);
  let outHint = String(hint ?? "");
  if (importError) {
    outHint = `${outHint}${outHint ? "；" : ""}导入失败：${importError}`;
  } else if (importFailed.length > 0) {
    outHint = `${outHint}${outHint ? "；" : ""}有 ${importFailed.length} 份下载文件导入失败：${String(importFailed[0]?.error ?? "")}`;
  }
  return {
    counts: {
      totalDocs: report.totalDocs ?? 0,
      stdGroups: report.stdGroups ?? 0,
      checked: report.checked ?? 0,
      fresh: report.fresh ?? 0,
      deferred: report.deferred ?? 0,
      updates: (report.updates ?? []).length,
      draftsReleased: (report.draftsReleased ?? []).length,
      superseded: (report.superseded ?? []).length,
      ambiguous: (report.ambiguous ?? []).length,
      currents: (report.currents ?? []).length,
      notFound: (report.notFound ?? []).length,
      newerInKb: (report.newerInKb ?? []).length,
      downloaded: (report.downloaded ?? []).length,
      downloadFailed: (report.downloadFailed ?? []).length,
      imported: imported.filter((item) => item?.docId).length,
      importFailed: importFailed.length,
      coinsSpent: report.coinsSpent ?? 0,
      dailyLimit: report.dailyLimit === true,
      authOk: report.authOk ?? null,
    },
    entries,
    truncated: all.length > STD_ENTRY_LIMIT,
    hint: outHint.trim(),
  };
}

export async function startStdJob({
  kb,
  kbDir,
  kbRoot,
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
  // 成功路径必须同步：hasRunning 与 start 之间一旦 await，两个并发 POST 会各自启动任务。
  if (jobs.hasRunning({ kb, kind: "kb-std" })) {
    const running = (await jobs.list({ kb, kind: "kb-std", limit: 50 })).find((job) => job.status === "running");
    throw new WebError(
      "STD_JOB_RUNNING",
      409,
      "该库已有标准更新任务在运行",
      running ? { jobId: running.id } : undefined
    );
  }

  const force = body?.force === true;
  const limit = Math.max(0, Math.round(Number(body?.limit) || 0));
  const redactPrefixes = [kbDir, kbRoot, PLUGIN_ROOT, tmpdir()];
  const clean = (text) => cleanText(text, redactPrefixes);

  // 取消请求只置标记，由 runStdCheck 的 shouldStop 在下一个网络请求前协作停止；
  // handle 注册前就到来的取消，注册表会在 setHandle() 时补调一次。
  let cancelRequested = false;

  const jobId = jobs.start({
    kind: "kb-std",
    kb,
    label: action === "check" ? `标准检查 ${kb}` : `标准检查并下载 ${kb}`,
    run: async (job) => {
      job.setHandle({ cancel() { cancelRequested = true; } });
      try {
        const progress = {
          kind: "std", phase: "collect", done: 0, total: 0, current: "",
          checked: 0, updates: 0, downloaded: 0, imported: 0, processed: 0, skipped: 0, failed: 0,
        };
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
          shouldStop: () => cancelRequested,
        });
        // 检查阶段被取消：保留已产出的 report/缓存，但不再进入导入（下载已由 runStdCheck 拦住）。
        const cancelledAfterCheck = cancelRequested || report.cancelled === true;
        let imported = [];
        let importError = "";
        if (wantsDownload && !cancelledAfterCheck && (report.downloaded ?? []).length > 0) {
          const manifest = await readManifest(kbDir);
          const existing = new Set(
            (manifest.docs ?? []).filter((doc) => !isDeleted(doc)).map((doc) => doc.sourceFile ?? "").filter(Boolean)
          );
          const pending = Object.values(cache.items ?? {}).filter((item) => item.downloadedFile && !item.importedDocId);
          let processed = 0;
          let skipped = 0;
          const importFile = createStdImportFn({
            kbDir,
            existing,
            config: importConfig,
            onProgress: (file, title, meta) => {
              processed += 1;
              if (meta?.skipped) skipped += 1;
              emit({
                phase: "import",
                done: processed,
                total: pending.length,
                current: String(title ?? file),
                imported: processed - skipped,
                processed,
                skipped,
              });
            },
          });
          try {
            imported = await importDownloadedImpl(kbDir, cache, importFile, {});
          } catch (error) {
            importError = String(error?.message ?? error);
          }
          // 先净化逐文件错误：条目 message 与 hint 都从这份数据生成。
          imported = imported.map((item) => (item?.error ? { ...item, error: clean(item.error) } : item));
          if (importError) importError = clean(importError);
        }
        const cancelled = cancelRequested || report.cancelled === true;
        // 取消且没有实际导入时跳过索引刷新，让取消尽快结算；有导入则仍刷新索引。
        if (!cancelled || imported.length > 0) await refreshKbIndex(kbDir).catch(() => {});
        const hint = cancelled
          ? CANCEL_HINT
          : report.deferred > 0
            ? `本轮达 limit 上限，尚有 ${report.deferred} 组未检查（并非已查完），请再次检查续查`
            : "";
        const result = buildStdResult({ report, imported, importError, hint });
        result.entries = result.entries.map((entry) =>
          entry?.message ? { ...entry, message: clean(entry.message) } : entry
        );
        result.hint = clean(result.hint);
        const detail = cancelled
          ? CANCEL_DETAIL
          : clean(
              `检查 ${result.counts.checked} 组，更新 ${result.counts.updates}，下载 ${result.counts.downloaded}，导入 ${result.counts.imported}`
            );
        return { status: cancelled ? "cancelled" : "succeeded", detail, result };
      } catch (error) {
        // 注册表直接用 Error.message 作为失败详情：先净化再抛，避免绝对路径泄漏。
        throw new Error(clean(String(error?.message ?? error)));
      }
    },
  });
  return { jobId };
}
