/**
 * 按标准号补下载（工作台入口 / 脚本共用）：
 *   检索精确同号 → 详情页下载 id → 确认页反查标准号（防串档）→ 下载 → 导入知识库。
 *
 * 与 kb_std_check 的自动下载共用同一套防护：
 *  - 只接受与目标同体系、同编号（exact）的命中；
 *  - 下载前确认页标准号必须回指目标，不一致立即中止；
 *  - 站点提示每日上限/金币不足/未登录时返回结构化原因，不抛底层异常。
 *
 * 默认 dryRun=true：只校验到确认页并报金币，不下载文件。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createStdImportFn,
  downloadFile,
  extractStdRef,
  fetchDownloadPage,
  findStdOnSite,
  matchKind,
} from "./standards.js";
import { isDeleted, readManifest } from "./store.js";

const DEFAULT_BASE = "https://www.biaozhun.org";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function sanitizeFileName(value) {
  return String(value ?? "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** 站点编号 → 缓存键查找：优先同标准号，其次同裸号。 */
function findCacheItem(cache, siteNo) {
  const items = cache?.items ?? {};
  for (const [key, item] of Object.entries(items)) {
    if (String(item?.siteNo ?? "") === String(siteNo ?? "")) return { key, item };
  }
  const ref = extractStdRef(siteNo ?? "");
  if (!ref) return { key: "", item: null };
  for (const [key, item] of Object.entries(items)) {
    if (String(item?.number ?? "") !== String(ref.compareNumber ?? "")) continue;
    if (item?.status === "update" || item?.status === "released" || item?.status === "not-found") {
      return { key, item };
    }
  }
  return { key: "", item: null };
}

/** 下载/导入结果写回 .std-check.json（工作台后续不会再把已导入项算成待下载）。 */
async function markCacheDownloaded(kbDir, { siteNo, fileName, imported, error }) {
  const cachePath = join(kbDir, ".std-check.json");
  let cache;
  try {
    cache = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    return;
  }
  const found = findCacheItem(cache, siteNo);
  if (!found.item) return;
  if (error) {
    found.item.downloadError = String(error).slice(0, 300);
  } else {
    found.item.downloadedAt = new Date().toISOString();
    found.item.downloadedFile = fileName;
    delete found.item.downloadError;
    if (imported?.docId) {
      found.item.importedDocId = imported.docId;
      found.item.importedAt = new Date().toISOString();
    }
    if (imported?.error) found.item.importError = String(imported.error).slice(0, 300);
  }
  cache.items[found.key] = found.item;
  await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8").catch(() => {});
}

export async function fetchStdNumber({
  kbDir,
  stdNo,
  baseUrl = DEFAULT_BASE,
  cookie = "",
  rateMs = 1200,
  dryRun = true,
  importConfig = {},
  fetchImpl,
  importFn,
  shouldStop = null,
  onProgress = null,
} = {}) {
  const emit = typeof onProgress === "function" ? onProgress : () => {};
  const stopped = () => shouldStop?.() === true;
  const cancelled = (base) => ({ ...base, ok: false, status: "cancelled", reason: "已取消" });
  const target = String(stdNo ?? "").trim();
  if (target === "") throw new Error("标准号不能为空");
  emit({ phase: "search", current: target });

  const hit = await findStdOnSite({ baseUrl, stdNo: target, cookie, rateMs, fetchImpl });
  if (!hit.found) {
    return { ok: false, found: false, stdNo: target, status: "not-found", reason: hit.reason ?? "站点未找到该编号" };
  }
  const siteStdNo = String(hit.stdNo ?? "");
  const title = String(hit.title || siteStdNo || target).slice(0, 200);
  if (!hit.downloadAid) {
    return {
      ok: false,
      found: true,
      stdNo: target,
      siteStdNo,
      title,
      status: "no-download-id",
      reason: "详情页未解析到站点下载 id（不能拿详情页 id 冒险下载）",
    };
  }
  emit({ phase: "confirm", current: siteStdNo || target });
  await sleep(rateMs);
  const page = await fetchDownloadPage(baseUrl, hit.downloadAid, cookie, { fetchImpl });
  const expect = extractStdRef(siteStdNo);
  const kind = expect && page.ref ? matchKind(expect.compareNumber, page.ref.compareNumber) : null;
  const base = {
    found: true,
    stdNo: target,
    siteStdNo: siteStdNo || hit.stdNo || "",
    title: page.title || title,
    year: hit.year ?? null,
    siteStatus: hit.status ?? "",
    replaced: hit.replaced ?? "",
    downloadAid: hit.downloadAid,
    costCoins: page.costCoins ?? null,
    vipFree: page.vipFree === true,
    confirmMatch: kind,
  };
  if (!kind) {
    return {
      ...base,
      ok: false,
      status: "confirm-mismatch",
      reason: `下载确认页与目标标准不一致（目标 ${siteStdNo || target} / 确认页 ${page.title || "无法解析"}），已中止`,
    };
  }
  if (page.noAuth) {
    return {
      ...base,
      ok: false,
      status: "auth-required",
      noAuth: true,
      reason: "未登录或版权限制（Cookie 缺失/失效）",
    };
  }
  if (stopped()) return cancelled(base);
  if (dryRun) {
    return { ...base, ok: true, status: "ready", dryRun: true };
  }

  emit({ phase: "download", current: siteStdNo || target });
  if (stopped()) return cancelled(base);
  const file = await downloadFile(baseUrl, page, cookie, { fetchImpl });
  if (file.error === "DAILY_LIMIT") {
    return {
      ...base,
      ok: false,
      status: "daily-limit",
      dailyLimit: true,
      reason: "站点提示今日下载次数已用完，明日继续",
    };
  }
  if (file.error) {
    return { ...base, ok: false, status: "download-failed", reason: file.error };
  }
  const safeNo = sanitizeFileName(siteStdNo || target) || "standard";
  const ext = /^[a-z0-9]{1,6}$/i.test(String(file.ext ?? "")) ? String(file.ext).toLowerCase() : "pdf";
  const fileName = `${safeNo}.${ext}`;
  const dlDir = join(kbDir, "import-tmp", "std-download");
  await mkdir(dlDir, { recursive: true });
  const filePath = join(dlDir, fileName);
  await writeFile(filePath, file.buffer);

  emit({ phase: "import", current: fileName });
  if (stopped()) return cancelled(base);
  let imported;
  try {
    let fn = importFn;
    if (typeof fn !== "function") {
      const manifest = await readManifest(kbDir);
      const existing = new Set(
        (manifest.docs ?? [])
          .filter((doc) => !isDeleted(doc))
          .map((doc) => doc.sourceFile ?? "")
          .filter(Boolean)
      );
      fn = createStdImportFn({ kbDir, existing, config: importConfig });
    }
    imported = await fn(filePath, title);
  } catch (error) {
    const reason = String(error?.message ?? error);
    await markCacheDownloaded(kbDir, { siteNo: base.siteStdNo, error: reason });
    return {
      ...base,
      ok: false,
      status: "import-failed",
      file: { name: fileName, bytes: file.buffer.length },
      reason,
    };
  }
  const skipped = imported?.skipped === true;
  await markCacheDownloaded(kbDir, {
    siteNo: base.siteStdNo,
    fileName,
    imported: imported ?? {},
  });
  return {
    ...base,
    ok: true,
    status: skipped ? "skipped-existing" : "imported",
    downloaded: true,
    file: { name: fileName, bytes: file.buffer.length },
    docId: imported?.docId ?? null,
    skipped,
  };
}

/** 工具/工作台展示用的短文本。 */
export function renderStdFetchResult(value) {
  if (!value) return "";
  if (value.status === "ready") {
    const cost = value.costCoins === null ? "未知" : value.costCoins > 0 ? `${value.costCoins} 金币` : "免费";
    return `可下载 ${value.siteStdNo || value.stdNo}「${value.title}」：${cost}${value.vipFree ? "（VIP 免费）" : ""}。确认后开始下载。`;
  }
  if (value.status === "imported") {
    return `已下载并导入 ${value.siteStdNo || value.stdNo}「${value.title}」→ ${value.docId}（${value.bytes ?? value.file?.bytes ?? 0} B）${value.costCoins ? `，${value.costCoins} 金币` : ""}`;
  }
  if (value.status === "skipped-existing") {
    return `${value.siteStdNo || value.stdNo}「${value.title}」已下载过且库内存在同名来源，已跳过导入。`;
  }
  return `${value.siteStdNo || value.stdNo || ""}：${value.reason || value.status || "失败"}`;
}
