/**
 * 后台导入 worker：由插件通过 ctx.subprocess 以 node 子进程启动。
 * 参数 = process.argv[2]（JSON）: { kbRoot, kb, files: [{path, relKey, title}], config }
 * 进度与结果经 stdout 输出（KB:START / KB:PROGRESS / KB:OK / KB:FAIL / KB:DONE），
 * 由后台任务的 readOutput 流式呈现（配合内置 job_output 工具）。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importFileInto } from "../lib/pipeline.js";
import { readManifest } from "../lib/store.js";
import { refreshIndexIfStale } from "../lib/wiki.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);
// 参数 = process.argv[2]（JSON 字符串，或 "@<json文件路径>"——Windows 下长/多行
// JSON 经命令行传参可能被截断或超出命令行长度上限，用 @file 方式最稳）
let payload = process.argv[2] ?? "{}";
if (payload.startsWith("@")) {
  const argsFile = payload.slice(1);
  payload = await readFile(argsFile, "utf8");
  await rm(argsFile, { force: true }).catch(() => {});
}
const args = JSON.parse(payload);
const { kbRoot, kb, files = [], config = {}, reportFile, progressFile } = args;

if (!kbRoot || !kb || files.length === 0) {
  process.stderr.write("worker: 缺少 kbRoot/kb/files 参数\n");
  process.exit(2);
}

const kbDir = join(kbRoot, kb);
await mkdir(kbDir, { recursive: true });
const jobConfig = { ...config, langPath: config.langPath ?? join(pluginRoot, "data", "tessdata") };

const progressFiles = files.map((f) => ({
  path: String(f.sourceFile ?? f.relKey ?? f.title ?? ""),
  status: "pending",
}));
const progress = { done: 0, total: files.length, ok: 0, fail: 0, skip: 0, current: null, files: progressFiles };

async function writeProgress() {
  if (!progressFile) return;
  const tmp = `${progressFile}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ ...progress, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    await rm(progressFile, { force: true }).catch(() => {});
    await rename(tmp, progressFile);
  } catch {
    /* 进度文件是附属产物，失败不影响导入 */
  }
}
await writeProgress();

// tesseract.js 的 worker 线程偶发在消息回调里抛异常（如内存压力下的图像解码失败），
// 未捕获会直接杀死进程。这里兜底：记录崩溃点并优雅退出，配合 resume 机制断点续跑。
process.on("uncaughtException", (error) => {
  process.stderr.write(`WORKER-CRASH(uncaught): ${String(error?.message ?? error).slice(0, 500)}\n`);
  process.exit(3);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`WORKER-CRASH(unhandledRejection): ${String(reason?.message ?? reason).slice(0, 500)}\n`);
  process.exit(3);
});

process.stdout.write(`KB:START 知识库「${kb}」开始导入 ${files.length} 个文件\n`);
let ok = 0;
let fail = 0;
let skip = 0;
const results = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const label = `${i + 1}/${files.length}`;
  progress.current = progressFiles[i].path;
  await writeProgress();
  try {
    const report = await importFileInto(kbDir, {
      sourcePath: f.sourcePath ?? f.path,
      relKey: f.relKey,
      title: f.title,
      ...(f.docId ? { docId: f.docId } : {}),
      ...(f.sourceFile !== undefined ? { sourceFile: f.sourceFile } : {}),
      ...(f.storedSourcePath !== undefined ? { storedSourcePath: f.storedSourcePath } : {}),
      ...(f.forceReparse ? { forceReparse: true } : {}),
      config: jobConfig,
      onProgress: (msg) => process.stdout.write(`KB:PROGRESS [${label}] ${msg}\n`),
    });
    if (report.skipped === true) {
      skip += 1;
      results.push({ title: f.title, docId: report.docId ?? null, status: "skipped" });
      process.stdout.write(`KB:SKIP [${label}] ${report.title}: 该文档正在导入中，已跳过\n`);
      progress.skip += 1;
      progressFiles[i].status = "skipped";
      await writeProgress();
      continue;
    }
    ok += 1;
    results.push({
      title: f.title,
      docId: report.docId ?? null,
      status: "ok",
      type: report.type,
      pages: report.pages ?? 0,
      chars: report.chars ?? 0,
      parts: report.parts ?? 0,
      warnings: report.warnings?.length ?? 0,
    });
    process.stdout.write(
      `KB:OK [${label}] ${report.title} (${report.docId}) ${report.type} ${report.pages ? report.pages + "页 " : ""}${report.chars}字 ${report.parts}部分 ${Math.round(report.ms / 1000)}s${report.warnings?.length ? ` 警告${report.warnings.length}条` : ""}\n`
    );
    progress.done += 1;
    progress.ok += 1;
    progressFiles[i].status = "ok";
    await writeProgress();
  } catch (error) {
    fail += 1;
    const message = String(error?.message ?? error);
    results.push({ title: f.title, status: "failed", error: message.slice(0, 500) });
    progress.done += 1;
    progress.fail += 1;
    progressFiles[i].status = "failed";
    progressFiles[i].error = message.slice(0, 200);
    await writeProgress();
    process.stdout.write(`KB:FAIL [${label}] ${f.title}: ${message}\n`);
  }
}

// 批量导入结束后刷新一次 index.md（不要每篇都写，避免大库重复写盘）
try {
  await refreshIndexIfStale(kbDir, await readManifest(kbDir));
} catch {
  /* 索引是附属产物，失败不影响导入结果 */
}

// 逐文件统计：宿主用它判断“完成/部分失败”，不再只看进程退出码。
const summary = { ok, fail, skip, files: results };
if (reportFile) {
  try {
    await mkdir(dirname(reportFile), { recursive: true });
    await writeFile(reportFile, JSON.stringify(summary, null, 2), "utf8");
  } catch (error) {
    process.stderr.write(`worker: 无法写入导入报告 ${reportFile}: ${String(error?.message ?? error)}\n`);
  }
}
process.stdout.write(`KB:RESULT ${JSON.stringify({ ok, fail, skip })}\n`);
process.stdout.write(`KB:DONE 完成: 成功 ${ok}，失败 ${fail}${skip > 0 ? `，跳过 ${skip}` : ""}\n`);
process.exit(ok === 0 && fail > 0 ? 1 : 0);
