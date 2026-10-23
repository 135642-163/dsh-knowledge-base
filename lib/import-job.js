/**
 * worker 导入任务的公共启动内核。
 * - 工具路径（kb_import / kb_reparse）把 run() 注册到宿主 jobs；
 * - 工作台路径把 run() 交给 lib/web/jobs.js 注册表，并额外传 progressFile。
 * 本模块不依赖 plugin ctx，通道通过 spawn 注入，便于测试。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "./store.js";
import { refreshIndexIfStale } from "./wiki.js";
import { summarizeImportReport } from "./report.js";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKER_PATH = join(pluginRoot, "worker", "import-worker.mjs");

/** 逐文件统计写到系统临时目录，由宿主读取后删除；worker 不依赖宿主内存。 */
export function tempReportFile() {
  return join(tmpdir(), `dsh-kb-import-${randomBytes(6).toString("hex")}.json`);
}

/** 索引是附属产物：写失败不影响主流程（下一次 kb_read/export 会自愈）。 */
export async function refreshKbIndex(dir) {
  try {
    const manifest = await readManifest(dir);
    await refreshIndexIfStale(dir, manifest);
  } catch {
    /* ignore */
  }
}

/**
 * 写 worker 参数文件（Windows 命令行长度/多行 JSON 不可靠，统一走 @file）。
 * progressFile 可选：工作台任务用它提供逐文件进度，工具路径不传。
 */
export async function prepareImportArgs({ dir, kbRoot, kb, files, config, reportFile, progressFile }) {
  const argsFile = join(dir, "import-tmp", `worker-${randomBytes(6).toString("hex")}.json`);
  await mkdir(join(dir, "import-tmp"), { recursive: true });
  await writeFile(
    argsFile,
    JSON.stringify({
      kbRoot,
      kb,
      files,
      config,
      ...(reportFile ? { reportFile } : {}),
      ...(progressFile ? { progressFile } : {}),
    }),
    "utf8"
  );
  return argsFile;
}

/**
 * 返回宿主 jobs / 工作台注册表都能用的 run()。
 * run() 的结果：
 * { status: "completed"|"failed"|"cancelled", detail, report,
 *   cancelled: boolean, exitCode: number|null, signal: string|null }
 * - status/detail 保持既有文案（宿主兼容）；report 为 worker 的逐文件统计，未取得时为 null。
 * - cancelled: true 表示任务被 cancel() 取消，此时 exitCode/signal 均为 null。
 * - 其余路径 cancelled: false，exitCode/signal 原样透传（缺失为 null）。
 * - exitCode === 0 && !cancelled 表示 worker 进程正常跑完；逐文件失败仍可能发生（见 report.fail）。
 */
export function createImportWorkerRunner({ spawn, dir, argsFile, reportFile, fileCount, kb, verb = "导入" }) {
  return {
    run() {
      let cancelled = false;
      const handle = spawn({
        argv: [process.execPath, "--max-old-space-size=8192", WORKER_PATH, "@" + argsFile],
        cwd: dir,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: 2 * 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 3000,
      });
      let cursor = 0;
      const done = handle.done
        .then(async (outcome) => {
          if (cancelled) {
            return {
              status: "cancelled",
              detail: `知识库「${kb}」${verb}任务已取消`,
              report: null,
              cancelled: true,
              exitCode: null,
              signal: null,
            };
          }
          // 优先读 worker 的逐文件统计；读不到时从 stdout 的 KB:OK/KB:FAIL 行兜底。
          let report = null;
          try {
            report = JSON.parse(await readFile(reportFile, "utf8"));
          } catch {
            /* 报告文件缺失或损坏时走兜底 */
          }
          if (report === null) {
            const out = handle.collected.stdout?.readFrom(0)?.text ?? "";
            const count = (re) => (out.match(re) ?? []).length;
            const ok = count(/^KB:OK /gm);
            const fail = count(/^KB:FAIL /gm);
            const skip = count(/^KB:SKIP /gm);
            if (ok + fail + skip > 0) report = { ok, fail, skip };
          }
          const summary = summarizeImportReport(report, { fileCount, kb, verb });
          if (outcome.exitCode !== 0) {
            const stderrText = handle.collected.stderr?.readFrom(0)?.text?.trim() ?? "";
            const exitDesc =
              typeof outcome.exitCode === "number" ? String(outcome.exitCode) : outcome.signal ?? "unknown";
            const counts = summary.counts
              ? `（已完成：成功 ${summary.counts.ok}，失败 ${summary.counts.fail}）`
              : "";
            return {
              status: "failed",
              detail: `${verb}进程异常退出 (${exitDesc}): ${stderrText.slice(-200)}${counts}`,
              report,
              cancelled: false,
              exitCode: outcome.exitCode ?? null,
              signal: outcome.signal ?? null,
            };
          }
          return {
            status: summary.status,
            detail: summary.detail,
            report,
            cancelled: false,
            exitCode: outcome.exitCode ?? null,
            signal: outcome.signal ?? null,
          };
        })
        .finally(async () => {
          if (argsFile) await rm(argsFile, { force: true }).catch(() => {});
          if (reportFile) await rm(reportFile, { force: true }).catch(() => {});
          void refreshKbIndex(dir);
        });
      return {
        cancel: () => {
          if (cancelled) return;
          cancelled = true;
          void Promise.resolve(handle.terminate()).catch(() => {});
        },
        done,
        readOutput: () => {
          const chunk = handle.collected.stdout?.readFrom(cursor);
          if (!chunk) return "";
          cursor = chunk.nextOffset;
          return chunk.text;
        },
      };
    },
  };
}
