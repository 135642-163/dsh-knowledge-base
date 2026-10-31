#!/usr/bin/env node
/**
 * 每日标准更新检查（定时任务入口）。
 *
 * 默认只检查、不下载；结果写 docs/reports/std-check-YYYYMMDD.md，
 * 发现 update/released 时退出码 10 并在 macOS 弹通知（可 --no-notify 关闭）。
 *
 * 示例（launchd/cron）：
 *   node scripts/std-check-daily.mjs --root ~/workspace/knowledge --kb 标准
 *   node scripts/std-check-daily.mjs --root ~/workspace/knowledge --kb 标准 --action check-download
 *
 * 凭证：--cookie、环境变量 BZ_COOKIE，或从 --profile 指向的 cordis.patch.yml 读 bzCookie。
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runStdCheck } from "../lib/standards.js";
import { dailyReportPath, notificationText, renderDailyReport, shouldNotify } from "../lib/std-daily.js";
import { expandRoot, kbDirPath } from "../lib/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);

function parseArgs(argv) {
  const args = {
    root: "",
    kb: "标准",
    action: "check",
    cookie: "",
    profile: join(process.env.HOME ?? "", ".dsh", "profiles", "desktop", "cordis.patch.yml"),
    reportsDir: join(pluginRoot, "docs", "reports"),
    rateMs: 1500,
    maxAgeDays: 7,
    force: false,
    limit: 0,
    notify: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i] ?? "";
    else if (arg === "--kb") args.kb = argv[++i] ?? "标准";
    else if (arg === "--action") args.action = argv[++i] ?? "check";
    else if (arg === "--cookie") args.cookie = argv[++i] ?? "";
    else if (arg === "--profile") args.profile = argv[++i] ?? "";
    else if (arg === "--reports-dir") args.reportsDir = argv[++i] ?? args.reportsDir;
    else if (arg === "--rate") args.rateMs = Math.max(500, Number(argv[++i] ?? 1500) || 1500);
    else if (arg === "--max-age-days") args.maxAgeDays = Math.max(0, Number(argv[++i] ?? 7) || 0);
    else if (arg === "--limit") args.limit = Math.max(0, Number(argv[++i] ?? 0) || 0);
    else if (arg === "--force") args.force = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--notify") args.notify = true;
    else if (arg === "--no-notify") args.notify = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(`用法: node scripts/std-check-daily.mjs --root <kbRoot> [选项]
  --kb <库名>           默认「标准」
  --action <动作>       check（默认）| check-download | download
  --cookie <串>         标准网 Cookie；也可用 BZ_COOKIE 或 --profile 读取
  --profile <yml>       cordis.patch.yml（默认桌面 profile，读其中 bzCookie）
  --reports-dir <dir>   报告目录（默认 <插件>/docs/reports）
  --rate <ms>           请求间隔（默认 1500）
  --max-age-days <n>    增量缓存天数（默认 7）
  --limit <n>           本轮最多检查多少组（0=不限）
  --force               忽略缓存全量检查
  --no-notify           有更新也不弹通知
  --dry-run             只检查不下载`);
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (!args.root) throw new Error("需要 --root（知识库根目录）");
  return args;
}

function cookieFromProfile(text) {
  const match = /^\s*bzCookie:\s*(.+)$/m.exec(String(text ?? ""));
  if (!match) return "";
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function notifyMac(message) {
  if (process.platform !== "darwin") return;
  execFile(
    "osascript",
    ["-e", `display notification ${JSON.stringify(message)} with title "DSH 知识库标准检查"`],
    () => {}
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kbDir = kbDirPath(expandRoot(args.root), args.kb);
  let cookie = String(args.cookie || process.env.BZ_COOKIE || "").trim();
  if (!cookie && args.profile) {
    try {
      cookie = cookieFromProfile(await readFile(args.profile, "utf8"));
    } catch {
      /* profile 不可读时按未配置处理 */
    }
  }
  const started = new Date();
  const { report } = await runStdCheck({
    kbDir,
    cookie,
    rateMs: args.rateMs,
    maxAgeDays: args.maxAgeDays,
    force: args.force,
    limit: args.limit,
    action: args.action,
    dryRun: args.dryRun,
  });
  const text = renderDailyReport(report, { now: started, kb: args.kb, action: args.action });
  const outPath = dailyReportPath(args.reportsDir, started);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, text, "utf8");
  const notify = shouldNotify(report) && args.notify;
  if (notify) notifyMac(notificationText(report));
  console.log(text);
  console.log(`\n报告已写入: ${outPath}`);
  if (notify) console.log(`提醒: ${notificationText(report)}`);
  process.exitCode = notify ? 10 : 0;
}

main().catch((error) => {
  console.error(`标准检查失败: ${String(error?.message ?? error)}`);
  process.exitCode = 2;
});
