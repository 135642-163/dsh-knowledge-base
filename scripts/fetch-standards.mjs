#!/usr/bin/env node
/**
 * 按标准号从标准网补下载某几个版本并导入知识库（补全「库内只有旧版」的缺口）。
 *
 * 与 kb_std_check 的自动下载共用同一套防护：
 *   结果解析（分类路径/翻页）→ 详情页取站点下载 id → 确认页反查标准号 → 下载 → 导入。
 * 区别只是入口不同：这里指定「要哪个编号」，而不是由检查缓存推导。
 *
 * 默认 dry-run：只做检索 + 确认页校验并报出金币，不下载文件；--apply 才真正下载并导入。
 * 名额/金币：每份金币以确认页为准（0–6 金币），站点提示每日上限时立即停止。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  findStdOnSite,
  fetchDownloadPage,
  downloadFile,
  extractStdRef,
  matchKind,
  createStdImportFn,
} from "../lib/standards.js";
import { readManifest, expandRoot, kbDirPath, isDeleted } from "../lib/store.js";
import { successorsOf, libraryHolds } from "../lib/supersede.js";

function parseArgs(argv) {
  const args = {
    root: "", kb: "", stds: [], fromSuperseded: false, cookie: "", rate: 1500,
    apply: false, limit: 20, report: "", ocrLang: "chi_sim+eng", ocrWorkers: 4, ocrDpi: 300,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--root") args.root = argv[++i] ?? "";
    else if (arg === "--kb") args.kb = argv[++i] ?? "";
    else if (arg === "--std") args.stds.push(String(argv[++i] ?? "").trim());
    else if (arg === "--from-superseded") args.fromSuperseded = true;
    else if (arg === "--cookie") args.cookie = argv[++i] ?? "";
    else if (arg === "--rate") args.rate = Math.max(500, Number(argv[++i] ?? 1500) || 1500);
    else if (arg === "--limit") args.limit = Math.max(1, Number(argv[++i] ?? 20) || 20);
    else if (arg === "--report") args.report = argv[++i] ?? "";
    else if (arg === "--ocr-lang") args.ocrLang = argv[++i] ?? args.ocrLang;
    else if (arg === "--ocr-workers") args.ocrWorkers = Math.max(1, Number(argv[++i] ?? 4) || 4);
    else if (arg === "--ocr-dpi") args.ocrDpi = Math.max(72, Number(argv[++i] ?? 300) || 300);
    else if (arg === "--help" || arg === "-h") {
      console.log(`用法: node scripts/fetch-standards.mjs --root <kbRoot> --kb <库名> [选项]
  --std <标准号>        要抓的编号，可重复（如 "GB/T 4728.6-2022"）
  --from-superseded     从 .std-check.json 里「站点标注废止且写明被 X 代替、库内没有 X」推导目标
  --cookie <串>          站点登录 Cookie（也可用环境变量 BZ_COOKIE）
  --dry-run | --apply   默认 dry-run（只校验确认页、报金币）；--apply 才下载并导入
  --limit <n>           本轮最多处理多少个编号（默认 20）
  --rate <ms>           请求间隔（默认 1500，最小 500）
  --report <path>       把结果写成 JSON
  --ocr-lang/--ocr-workers/--ocr-dpi  导入时的 OCR 参数`);
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (!args.root || !args.kb) throw new Error("需要 --root 和 --kb");
  args.cookie = String(args.cookie || process.env.BZ_COOKIE || "").trim();
  return args;
}

/** 从检查缓存推导目标：站点说「被 X 代替」但库里没有 X 的那些 X。 */
function targetsFromCache(kbDir, manifest, limit) {
  let cache = { items: {} };
  try {
    cache = JSON.parse(readFileSync(join(kbDir, ".std-check.json"), "utf8"));
  } catch {
    /* 没缓存就只用 --std */
  }
  const out = [];
  for (const item of Object.values(cache.items ?? {})) {
    if (item.status !== "superseded") continue;
    for (const succ of successorsOf(item.replaced)) {
      if (libraryHolds(manifest, succ)) continue;
      if (!out.includes(succ)) out.push(succ);
    }
  }
  return out.slice(0, limit);
}

const sanitize = (s) => String(s ?? "").replace(/[\\/:*?"<>|]/g, "_");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kbDir = kbDirPath(expandRoot(args.root), args.kb);
  const manifest = await readManifest(kbDir);

  let targets = [...new Set(args.stds.filter(Boolean))];
  if (args.fromSuperseded) targets = [...new Set([...targets, ...targetsFromCache(kbDir, manifest, args.limit)])];
  targets = targets.slice(0, args.limit);
  if (targets.length === 0) throw new Error("没有目标：用 --std 指定编号，或 --from-superseded 从检查缓存推导");

  const existing = new Set((manifest.docs ?? []).map((d) => d.sourceFile ?? "").filter(Boolean));
  const importFn = createStdImportFn({
    kbDir,
    existing,
    config: { ocrLang: args.ocrLang, ocrWorkers: args.ocrWorkers, ocrDpi: args.ocrDpi },
  });

  const baseUrl = "https://www.biaozhun.org";
  const results = [];
  let coins = 0;
  let dailyLimit = false;

  for (const target of targets) {
    const row = { stdNo: target };
    try {
      const hit = await findStdOnSite({ baseUrl, stdNo: target, cookie: args.cookie, rateMs: args.rate });
      if (!hit.found) {
        row.status = "not-found";
        row.reason = hit.reason;
        results.push(row);
        console.log(`✗ ${target}：${hit.reason}`);
        continue;
      }
      row.site = { stdNo: hit.stdNo, title: hit.title, year: hit.year, status: hit.status, href: hit.href, replaced: hit.replaced };
      if (!hit.downloadAid) {
        row.status = "no-download-id";
        row.reason = "详情页未解析到站点下载 id";
        results.push(row);
        console.log(`✗ ${target}：详情页没有下载 id`);
        continue;
      }
      const page = await fetchDownloadPage(baseUrl, hit.downloadAid, args.cookie);
      const expect = extractStdRef(hit.stdNo);
      const kind = expect && page.ref ? matchKind(expect.compareNumber, page.ref.compareNumber) : null;
      row.confirm = { title: page.title, cost: page.costCoins, noAuth: page.noAuth, match: kind };
      if (!kind) {
        row.status = "confirm-mismatch";
        row.reason = `确认页与目标不一致（确认页：${page.title || "无法解析"}）`;
        results.push(row);
        console.log(`✗ ${target}：确认页不一致（${page.title}）`);
        continue;
      }
      if (!args.apply) {
        row.status = "ready";
        results.push(row);
        console.log(`○ ${target}：可下载（${page.title}），金币 ${page.costCoins ?? "?"}${page.costCoins > 0 ? "" : "（免费）"}`);
        continue;
      }
      if (page.noAuth) {
        row.status = "auth-required";
        row.reason = "登录态失效或需要登录";
        results.push(row);
        break;
      }
      const file = await downloadFile(baseUrl, page, args.cookie);
      if (file.error === "DAILY_LIMIT") {
        row.status = "daily-limit";
        row.reason = "今日下载次数已用完";
        results.push(row);
        dailyLimit = true;
        break;
      }
      if (file.error) {
        row.status = "download-failed";
        row.reason = file.error;
        results.push(row);
        console.log(`✗ ${target}：下载失败 ${file.error}`);
        continue;
      }
      const safeNo = sanitize(hit.stdNo || target);
      const fileName = `${safeNo}.${file.ext}`;
      const dlDir = join(kbDir, "import-tmp", "std-download");
      await mkdir(dlDir, { recursive: true });
      const filePath = join(dlDir, fileName);
      await writeFile(filePath, file.buffer);
      if (page.costCoins) coins += page.costCoins;
      row.file = { name: fileName, bytes: file.buffer.length, cost: page.costCoins ?? 0 };

      const title = String(hit.title || hit.stdNo || target).slice(0, 200);
      const imported = await importFn(filePath, title);
      row.import = imported;
      row.status = imported?.docId ? "imported" : imported?.skipped ? "skipped-existing" : "import-failed";
      results.push(row);
      console.log(`✓ ${target} → ${fileName}（${file.buffer.length} B，${page.costCoins ?? 0} 金币）→ 导入 ${imported?.docId ?? "（跳过）"}`);
    } catch (error) {
      row.status = "error";
      row.reason = String(error?.message ?? error);
      results.push(row);
      console.log(`✗ ${target}：${row.reason}`);
    }
    await new Promise((r) => setTimeout(r, args.rate));
  }

  const summary = {
    kb: args.kb,
    apply: args.apply,
    targets: targets.length,
    imported: results.filter((r) => r.status === "imported").length,
    ready: results.filter((r) => r.status === "ready").length,
    failed: results.filter((r) => !["imported", "ready", "skipped-existing"].includes(r.status)).length,
    coins,
    dailyLimit,
    results,
  };
  if (args.report) writeFileSync(args.report, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n汇总：目标 ${targets.length}，导入 ${summary.imported}，可下载(dry-run) ${summary.ready}，失败 ${summary.failed}，金币 ${coins}${dailyLimit ? "（已触发每日上限）" : ""}`);
}

await main();
