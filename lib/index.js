/**
 * dsh-knowledge-base — DeepSeek Harness 知识库插件。
 *
 * 把 Word/PPT/PDF（文字版与扫描版，扫描版自动 OCR）等资料整理为适合大模型
 * 阅读的 Markdown 知识库（原始文件 + 分块 + 合并版 + 清单），并提供一组
 * kb_* 工具：导入、列表、检索、精读、修订、笔记、删除、导出、重命名。
 *
 * 大文件（如整本扫描书）导入自动转入后台任务（ctx.jobs），与内置的
 * job_list/job_output 工具联动查看进度。
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash, randomBytes } from "node:crypto";
import { access, readFile, readdir, mkdir, stat, writeFile, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { availableParallelism, cpus, homedir, tmpdir, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { importFileInto, collectSources, preScanPdfPages } from "./pipeline.js";
import { scanDuplicates } from "./dedup.js";
import { summarizeImportReport } from "./report.js";
import { tessDataStatus } from "./ocr.js";
import { PARSER_VERSION } from "./version.js";
import { sectionsFromMarkdown } from "./parsers.js";
import { searchKb } from "./query.js";
import { runStdCheck, importDownloaded, renderStdReport } from "./standards.js";
import {
  docSize,
  expandRoot,
  exportJsonl,
  exportMarkdown,
  exportZip,
  kbDirPath,
  listKbs,
  readManifest,
  readPart,
  readPartIndex,
  rebuildMerged,
  removeDoc,
  removeKbDir,
  renameKb,
  resolveDoc,
  sanitizeKbName,
  sweepStaging,
  touchDocLocked,
  withManifestLock,
  writeParts,
} from "./store.js";

const name = "knowledge-base";
const inject = ["tools", "systemPrompt", "subprocess"];

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_TESSDATA = join(pluginRoot, "data", "tessdata");
const FAST_TESSDATA = join(pluginRoot, "data", "tessdata-fast");

// ---------------------------------------------------------------------------
// 按本机性能自适应的默认值（config 未显式指定时生效）
// ---------------------------------------------------------------------------

function machineLogicalCpus() {
  try {
    if (typeof availableParallelism === "function") {
      const n = availableParallelism();
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    /* fall through */
  }
  try {
    const n = cpus()?.length;
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* fall through */
  }
  return 2;
}

const LOGICAL_CPUS = machineLogicalCpus();
/** 每 GB 内存按 1.5GB/worker 估算可容纳的 worker 数（每个 WASM worker 约需数百 MB）。 */
const TOTAL_MEM_GB = (() => {
  try {
    const gb = totalmem() / 1024 ** 3;
    return Number.isFinite(gb) && gb > 0 ? gb : 16;
  } catch {
    return 16;
  }
})();
const MEM_SAFE_WORKERS = Math.max(2, Math.floor(TOTAL_MEM_GB / 1.5));
/** OCR 并发：min(核数一半, 内存可容纳)，下限 2、上限 16。 */
const AUTO_OCR_WORKERS = Math.max(2, Math.min(16, Math.round(LOGICAL_CPUS / 2), MEM_SAFE_WORKERS));
/** tesseract best 模型设计分辨率（300 DPI）；低清扫描源可配置调低。 */
const AUTO_OCR_DPI = 300;

const Config = z.object({
  kbRoot: z.string().default("~/.dsh/knowledge"),
  defaultKb: z.string().default("default"),
  ocrLang: z.string().default("chi_sim+eng"),
  ocrWorkers: z.number().default(0).description("OCR 并行 worker 数；0 = 按 CPU 自动（约核数一半，本机自动取值）"),
  ocrDpi: z.number().default(0).description("扫描页渲染 DPI；0 = 自动（300）"),
  ocrNativeBin: z.string().default(""),
  ocrEngine: z.string().default("auto"),
  ocrPythonBin: z.string().default(""),
  ebookConvertBin: z.string().default(""),
  maxInlinePages: z.number().default(20),
  maxInlineBytes: z.number().default(10 * 1024 * 1024),
  partMaxChars: z.number().default(8000),
  readMaxChars: z.number().default(20000),
  queryMaxMatches: z.number().default(40),
  queryLineBytes: z.number().default(400),
  importTimeoutMs: z.number().default(600000),
  bzBaseUrl: z.string().default("https://www.biaozhun.org"),
  bzCookie: z.string().default(""),
  stdRateMs: z.number().default(1200),
  stdMaxAgeDays: z.number().default(7),
  stdTimeoutMs: z.number().default(1800000),
});

const TYPE_LABELS = {
  docx: "Word",
  pptx: "PPT",
  "pdf-text": "PDF(文字版)",
  "pdf-scanned": "PDF(扫描版)",
  "pdf-mixed": "PDF(混合)",
  markdown: "Markdown",
  text: "文本",
  epub: "EPUB",
  mobi: "电子书(MOBI)",
  note: "笔记",
  skipped: "已跳过",
};

function typeLabel(type) {
  return TYPE_LABELS[type] ?? String(type ?? "");
}

function execCwd(exec) {
  return exec.agent?.session?.header?.cwd ?? process.cwd();
}

/** 展开路径开头的 ~（macOS 用户常写 ~/Documents/...）。 */
function expandUser(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function resolveInputPath(input, exec) {
  const p = expandUser(String(input ?? "").trim());
  if (p.length === 0) throw new Error("path 不能为空");
  return isAbsolute(p) ? p : resolve(execCwd(exec), p);
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export async function apply(ctx, config) {
  const cfg = config ?? {};
  const kbRoot = expandRoot(cfg.kbRoot ?? "~/.dsh/knowledge");
  const defaultKb = sanitizeKbName(cfg.defaultKb ?? "default");
  const ocrLang = cfg.ocrLang || "chi_sim+eng";
  const ocrWorkers = Math.min(16, Math.max(1, Math.round(Number(cfg.ocrWorkers) || AUTO_OCR_WORKERS)));
  const ocrDpi = Math.min(400, Math.max(100, Math.round(Number(cfg.ocrDpi) || AUTO_OCR_DPI)));
  const ocrEngine = ["auto", "rapidocr", "tesseract", "wasm"].includes(cfg.ocrEngine) ? cfg.ocrEngine : "auto";
  const ocrNativeBin = String(cfg.ocrNativeBin ?? "").trim();
  const ocrPythonBin = String(cfg.ocrPythonBin ?? "").trim();
  const ebookConvertBin = String(cfg.ebookConvertBin ?? "").trim();
  const partMaxChars = Math.min(60000, Math.max(500, Math.round(Number(cfg.partMaxChars) || 8000)));
  const readMaxChars = Math.min(200000, Math.max(500, Math.round(Number(cfg.readMaxChars) || 20000)));
  const queryMaxMatches = Math.min(500, Math.max(1, Math.round(Number(cfg.queryMaxMatches) || 40)));
  const queryLineBytes = Math.min(4000, Math.max(80, Math.round(Number(cfg.queryLineBytes) || 400)));
  const maxInlinePages = Math.max(1, Math.round(Number(cfg.maxInlinePages) || 20));
  const maxInlineBytes = Math.max(1024 * 1024, Math.round(Number(cfg.maxInlineBytes) || 10 * 1024 * 1024));
  const importTimeoutMs = Math.min(2 * 3600 * 1000, Math.max(10000, Math.round(Number(cfg.importTimeoutMs) || 600000)));
  const bzBaseUrl = String(cfg.bzBaseUrl ?? "https://www.biaozhun.org").replace(/\/+$/, "");
  const bzCookie = String(cfg.bzCookie ?? "").trim();
  const stdRateMs = Math.min(10000, Math.max(500, Math.round(Number(cfg.stdRateMs) || 1200)));
  const stdMaxAgeDays = Math.min(365, Math.max(0, Math.round(Number(cfg.stdMaxAgeDays) || 7)));
  const stdTimeoutMs = Math.min(2 * 3600 * 1000, Math.max(60000, Math.round(Number(cfg.stdTimeoutMs) || 1800000)));

  await mkdir(kbRoot, { recursive: true }).catch(() => {});
  // 启动自检：模型缺失时至少让日志与首次 OCR 错误都能指向真实原因
  const tessdata = await tessDataStatus(ocrLang, DEFAULT_TESSDATA).catch(() => ({ missing: [] }));
  const tessdataState = tessdata.missing.length === 0 ? "ok" : `missing:${tessdata.missing.join("+")}`;
  const logLoad = async (message) => {
    try {
      await writeFile(join(kbRoot, ".plugin-load.log"), `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* 标记文件仅用于诊断 */
    }
  };

  // 清理崩溃遗留的导入暂存目录（best-effort，失败不影响启动）
  try {
    const entries = await readdir(kbRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) {
        await sweepStaging(join(kbRoot, e.name)).catch(() => {});
      }
    }
  } catch {
    /* kbRoot 可能尚为空 */
  }

  try {
    ctx.systemPrompt.section({
      name: "tool:knowledge-base",
      order: 106,
      text: [
        "知识库工作流：用户会引用已整理进知识库的资料。需要知识库内容时，先用 kb_query 检索（中文可直接用短语或正则），再用 kb_read 按 part 精读命中的部分；回答/分析时注明来源文档与页码。",
        "导入资料用 kb_import（支持 docx/pptx/pdf/md/txt/epub/mobi/azw3，扫描版 PDF 自动 OCR，mobi/azw3 需本机 Calibre 自动转 epub，可传目录批量导入，可指定 kb 名称创建新知识库）；大文件（如整本扫描书）会自动转为后台任务，用 job_output 查看进度，不要重复发起相同导入。导入前自动与当前库及全部知识库查重（按标准号/标题）：同库重合自动跳过，跨库重合默认跳过并在结果中报告；用户确认需要时才加 allowCrossDuplicates: true 重新导入。标题仅前缀相似的低置信匹配会照常导入并提示确认。",
        "对知识的补充与修订用 kb_add_note（新增笔记/结论）与 kb_edit（精确替换已有内容）；对外交付用 kb_export（md 单文件 / jsonl 分块 / zip 完整包，供其他大模型阅读使用）。",
        "标准更新用 kb_std_check（默认检查「标准」库，在标准网 biaozhun.org 比对年份并自动下载新版 PDF 导入知识库；内置限速与 7 天增量缓存，force=true 强制全查，limit 可分批；下载需配置 bzCookie，未配置时仅报告不下载）。",
        "OCR 文本无法可靠呈现公式、原理图、电路图、图表等视觉内容；遇到这些内容（或用户询问公式/图纸时）用 kb_view 查看原始页面图片或 Word/PPT 内嵌图片，再结合图片作答并注明页码。",
      ].join(" "),
    });

    const registered = [];
    for (const register of [
      () => registerKbList(ctx, { kbRoot, defaultKb }),
      () => registerKbImport(ctx, { kbRoot, defaultKb, ocrLang, ocrWorkers, ocrDpi, ocrEngine, ocrNativeBin, ocrPythonBin, ebookConvertBin, partMaxChars, maxInlinePages, maxInlineBytes, importTimeoutMs }),
      () => registerKbReparse(ctx, { kbRoot, defaultKb, ocrLang, ocrWorkers, ocrDpi, ocrEngine, ocrNativeBin, ocrPythonBin, ebookConvertBin, partMaxChars, maxInlinePages, maxInlineBytes, importTimeoutMs }),
      () => registerKbQuery(ctx, { kbRoot, defaultKb, queryMaxMatches, queryLineBytes }),
      () => registerKbRead(ctx, { kbRoot, defaultKb, readMaxChars }),
      () => registerKbView(ctx, { kbRoot, defaultKb, ebookConvertBin }),
      () => registerKbEdit(ctx, { kbRoot, defaultKb }),
      () => registerKbAddNote(ctx, { kbRoot, defaultKb, partMaxChars }),
      () => registerKbRemove(ctx, { kbRoot, defaultKb }),
      () => registerKbExport(ctx, { kbRoot, defaultKb }),
      () => registerKbRename(ctx, { kbRoot, defaultKb }),
      () => registerKbStdCheck(ctx, { kbRoot, defaultKb, bzBaseUrl, bzCookie, stdRateMs, stdMaxAgeDays, stdTimeoutMs, ocrLang, ocrWorkers, ocrDpi, ocrEngine, ocrNativeBin, ocrPythonBin, ebookConvertBin, partMaxChars }),
    ]) {
      try {
        register();
        registered.push("ok");
      } catch (error) {
        registered.push(`FAIL:${error?.message ?? error}`);
      }
    }
    await logLoad(
      `dsh-knowledge-base applied: kbRoot=${kbRoot} cpus=${LOGICAL_CPUS} memGB=${Math.round(TOTAL_MEM_GB)} ocrWorkers=${ocrWorkers} ocrDpi=${ocrDpi} ocrEngine=${ocrEngine} tessdata=${tessdataState} registrations=[${registered.join(",")}] tools=[kb_list,kb_import,kb_reparse,kb_query,kb_read,kb_view,kb_edit,kb_add_note,kb_remove,kb_export,kb_rename,kb_std_check]`
    );
  } catch (error) {
    await logLoad(`dsh-knowledge-base apply FAILED: ${error?.message ?? error}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

function registerKbList(ctx, { kbRoot, defaultKb }) {
  const tool = defineTool({
    name: "kb_list",
    description:
      "列出知识库（或某个知识库内的文档）：名称、文档数、状态（ready/importing/failed）、字符量。导入、查询、精读前先用它确认知识库与文档 id。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略则列出所有知识库。" },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kbs: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
          docs: { type: "array", items: { type: "object", additionalProperties: true } },
          kb: { type: "string" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: renderKbList(value),
        },
      ],
    },
    async execute(args) {
      if (args.kb !== undefined) {
        const kb = sanitizeKbName(args.kb);
        const dir = kbDirPath(kbRoot, kb);
        const manifest = await readManifest(dir);
        const docs = (manifest.docs ?? []).map((d) => docSize(dir, d));
        docs.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"));
        return { kb, kbs: [], docs };
      }
      return { kbs: await listKbs(kbRoot), docs: [] };
    },
  });
  ctx.tools.register(tool);
}

function renderKbList(value) {
  const kbs = value.kbs ?? [];
  const docs = value.docs ?? [];
  if (kbs.length === 0 && docs.length === 0) {
    return "（还没有任何知识库，用 kb_import 导入资料即可自动创建）";
  }
  if (kbs.length > 0) {
    return kbs
      .map(
        (k) =>
          `${k.name} — ${k.docs} 个文档（就绪 ${k.ready}${k.importing ? `，导入中 ${k.importing}` : ""}${k.failed ? `，失败 ${k.failed}` : ""}），共 ${k.chars} 字`
      )
      .join("\n");
  }
  if (docs.length === 0) return `知识库「${value.kb}」暂无文档（用 kb_import 导入资料）`;
  return (
    `知识库「${value.kb}」共 ${docs.length} 个文档:\n` +
    docs
      .map(
        (d) =>
          `- ${d.id}  ${d.title}  [${typeLabel(d.type)}] ${d.status}${d.stale ? " [旧管线]" : ""}${d.edited ? " [已修订]" : ""}${d.error ? ` (${d.error})` : ""}  ${d.pages ? d.pages + "页 " : ""}${d.chars}字 ${d.parts}部分 v${d.version} 更新于 ${d.updatedAt}`
      )
      .join("\n")
  );
}

async function startImportJob(
  ctx,
  { kbRoot, kb, dir, files, jobConfig, exec, kind = "kb-import", label, verb = "导入", fileCount = files.length }
) {
  const jobs = ctx.get("jobs");
  if (!jobs) throw new Error("后台任务服务不可用，无法后台导入（请缩小文件规模或分批导入）");
  const workerPath = join(pluginRoot, "worker", "import-worker.mjs");
  // Windows 命令行有长度上限且多行 JSON 传参易被截断：worker 参数经 JSON 文件传递（@file 约定），worker 读后自删
  const argsFile = join(dir, "import-tmp", `worker-${randomBytes(6).toString("hex")}.json`);
  // 逐文件统计写到系统临时目录，由宿主读取后删除；worker 不依赖宿主内存。
  const reportFile = join(tmpdir(), `dsh-kb-import-${randomBytes(6).toString("hex")}.json`);
  await mkdir(join(dir, "import-tmp"), { recursive: true });
  await writeFile(argsFile, JSON.stringify({ kbRoot, kb, files, config: jobConfig, reportFile }), "utf8");
  const jobId = jobs.start({
    kind,
    label: label ?? `${kind} ${kb}: ${files.length} 个文件`,
    ...(exec.agent ? { owner: exec.agent } : {}),
    run: () => {
      const handle = ctx.subprocess.spawn({
        argv: [process.execPath, "--max-old-space-size=8192", workerPath, "@" + argsFile],
        cwd: dir,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: 2 * 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 3000,
      });
      let cursor = 0;
      let cancelled = false;
      return {
        cancel: () => {
          cancelled = true;
          void handle.terminate();
        },
        done: handle.done
          .then(async (o) => {
            if (cancelled) {
              return { status: "cancelled", detail: `知识库「${kb}」${verb}任务已取消` };
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
            await rm(reportFile, { force: true }).catch(() => {});
            const summary = summarizeImportReport(report, { fileCount, kb, verb });
            if (o.exitCode !== 0) {
              const stderrText = handle.collected.stderr?.readFrom(0)?.text?.trim() ?? "";
              const counts = summary.counts
                ? `（已完成：成功 ${summary.counts.ok}，失败 ${summary.counts.fail}）`
                : "";
              return {
                status: "failed",
                detail: `${verb}进程异常退出 (${o.exitCode ?? 0}${o.signal ? " " + o.signal : ""}): ${stderrText.slice(0, 200)}${counts}`,
              };
            }
            return { status: summary.status, detail: summary.detail };
          })
          .finally(() => {
            rm(argsFile, { force: true }).catch(() => {});
            rm(reportFile, { force: true }).catch(() => {});
          }),
        readOutput: () => {
          const r = handle.collected.stdout?.readFrom(cursor);
          if (!r) return "";
          cursor = r.nextOffset;
          return r.text;
        },
      };
    },
  });
  return { jobId };
}

function registerKbImport(ctx, opts) {
  const { kbRoot, defaultKb, ocrLang, ocrWorkers, ocrDpi, ocrEngine, ocrNativeBin, ocrPythonBin, ebookConvertBin, partMaxChars, maxInlinePages, maxInlineBytes, importTimeoutMs } = opts;
  const tool = defineTool({
    name: "kb_import",
    description:
      "把资料文件导入知识库（自动创建或更新指定名称的知识库）。支持 Word(.docx/.doc，旧版 .doc 自动转换：Windows 用本机 Word、macOS 用 textutil)、PPT(.pptx/.ppt，旧版 .ppt 自动转换：Windows 用本机 PowerPoint/LibreOffice)、PDF（文字版直接提取文字层；扫描版/图片版自动逐页 OCR 中文）、EPUB 与 MOBI/AZW3 电子书（MOBI/AZW3 自动经 Calibre ebook-convert 转 EPUB，需本机安装 Calibre）、Markdown、纯文本(.txt，自动识别 UTF-8/UTF-16/GBK)。path 可以是文件或目录（目录递归导入全部支持的文件，同名文件重复导入=原位更新并版本号+1）。小文件立即完成；大文件（如整本扫描书）或旧版 .doc/.ppt / MOBI/AZW3（需本机 Office/Calibre 转换）自动转为后台任务并返回 jobId，用 job_output 查看进度；正在导入中的同名文档会被自动跳过。导入前自动查重（按标准号/标题与当前库及全部知识库比对）：同库重合的文件直接跳过，跨库重合的文件默认跳过并在结果中报告——确认需要时给 allowCrossDuplicates: true 重新导入。标题仅前缀相似（低置信）的文件会照常导入并在结果中提示人工确认，不会静默丢弃。",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "要导入的文件或目录的绝对路径（支持 ~ 开头的用户目录路径；相对路径按当前工作目录解析）。",
      },
      kb: {
        type: "string",
        description: "知识库名称（可含中文），不存在则创建。默认 default。",
      },
      title: {
        type: "string",
        description: "文档标题（默认取文件名）。目录导入时忽略。",
      },
      ocrLang: {
        type: "string",
        description: "OCR 语言（tesseract 代码，默认 chi_sim+eng；竖排古籍可试 chi_sim_vert）。",
      },
      ocrModel: {
        type: "string",
        description: "OCR 模型精度：best（默认，最准但慢）或 fast（快 3-5 倍，印刷体准确率仍高；整本大书建议 fast）。",
      },
      runInBackground: {
        type: "boolean",
        description: "强制转入后台任务执行（默认小文件直接内联完成）。",
      },
      allowCrossDuplicates: {
        type: "boolean",
        description: "是否导入与其它知识库重合的文件。默认 false：跨库重合的文件跳过并在结果中报告（同库重合始终跳过）。",
      },
      forceOcr: {
        type: "boolean",
        description:
          "强制对 PDF 全部页面走 OCR，忽略其文字层。默认 false。用于文字层已损坏的 PDF（提取出的数字/字母变成全角或冷僻汉字、出现大量 U+FFFD 替换字符），此时文字层看似有内容但实为垃圾，需按页重新识别。",
      },
    },
    timeoutMs: importTimeoutMs,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          inline: { type: "boolean", required: true },
          files: { type: "number", required: true },
          jobId: { type: "string" },
          imported: { type: "array", items: { type: "object", additionalProperties: true } },
          skipped: { type: "number" },
          duplicates: { type: "array", items: { type: "object", additionalProperties: true } },
          similar: { type: "array", items: { type: "object", additionalProperties: true } },
          hint: { type: "string" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: renderKbImport(value),
        },
      ],
    },
    async execute(args, exec) {
      const kb = sanitizeKbName(args.kb ?? defaultKb);
      const dir = kbDirPath(kbRoot, kb);
      await mkdir(dir, { recursive: true });
      const inputPath = resolveInputPath(args.path, exec);
      const sources = await collectSources(inputPath);
      const hasLegacy = sources.some((s) => /\.(doc|ppt|mobi|azw3?)$/i.test(s.path));
      let totalPages = sources.length;
      let totalBytes = 0;
      for (const s of sources) totalBytes += s.size ?? 0;
      // 已注定后台（字节超限 / 用户强制 / 含旧版 .doc/.ppt 或 MOBI/AZW3 需外部转换）时，
      // 不再在宿主进程预扫描 PDF 页数——大 PDF 的整文件读入与页数统计交给 worker。
      let inline =
        args.runInBackground !== true &&
        !hasLegacy &&
        totalBytes <= maxInlineBytes;
      if (inline) {
        for (const s of sources) {
          if (!s.path.toLowerCase().endsWith(".pdf")) continue;
          try {
            totalPages += Math.max(0, (await preScanPdfPages(s.path)) - 1);
          } catch {
            /* 单个文件统计失败不影响导入 */
          }
          if (totalPages > maxInlinePages) {
            inline = false;
            break;
          }
        }
      }
      const jobConfig = {
        ocrLang: args.ocrLang ?? ocrLang,
        ocrWorkers,
        ocrDpi,
        ocrEngine,
        ocrNativeBin,
        ocrPythonBin,
        ebookConvertBin,
        partMaxChars,
        forceOcr: args.forceOcr === true,
        langPath: args.ocrModel === "fast" ? FAST_TESSDATA : DEFAULT_TESSDATA,
      };
      const files = sources.map((s) => ({
        sourcePath: s.path,
        relKey: s.relKey,
        title: args.title ?? basename(s.path, extname(s.path)),
      }));

      // 导入前查重：同库重合直接跳过；跨库重合默认跳过并报告（allowCrossDuplicates: true 时照常导入）。
      // 查重基于标题（标准号/核心短语），在解析与 OCR 之前完成，避免重复计算。
      const dedup = await scanDuplicates({
        root: kbRoot,
        targetKb: kb,
        files,
        allowCrossKb: args.allowCrossDuplicates === true,
      });
      files.splice(0, files.length, ...dedup.kept);
      const duplicates = dedup.duplicates;
      const similar = dedup.similar ?? [];

      if (files.length === 0) {
        return { kb, inline: true, files: 0, imported: [], skipped: 0, duplicates, similar };
      }

      if (inline) {
        const imported = [];
        for (const f of files) {
          imported.push(await importFileInto(dir, { ...f, config: jobConfig }));
        }
        return {
          kb,
          inline: true,
          files: files.length,
          imported,
          skipped: imported.filter((r) => r.skipped === true).length,
          duplicates,
          similar,
        };
      }

      const { jobId } = await startImportJob(ctx, {
        kbRoot,
        kb,
        dir,
        files,
        jobConfig,
        exec,
        kind: "kb-import",
        label: `kb-import ${kb}: ${files.length} 个文件`,
        verb: "导入",
      });
      return {
        kb,
        inline: false,
        files: files.length,
        jobId,
        imported: [],
        duplicates,
        similar,
        hint:
          `导入已作为后台任务启动（${files.length} 个文件）。用 job_output ${jobId} 查看进度；导入完成后用 kb_list ${kb} 查看结果。` +
          (duplicates.length > 0 ? `另有 ${duplicates.length} 个文件因与库内/跨库文档重合已跳过。` : "") +
          (similar.length > 0 ? `另有 ${similar.length} 个文件标题相似、已照常导入，请确认是否重复。` : ""),
      };
    },
  });
  ctx.tools.register(tool);
}

function renderKbImport(value) {
  const dupText = renderDuplicates(value.duplicates ?? []);
  const similarText = renderSimilar(value.similar ?? []);
  const extra = [dupText, similarText].filter(Boolean).join("\n\n");
  if (value.inline) {
    const list = value.imported ?? [];
    if (list.length === 0 && (value.files ?? 0) === 0) {
      return `未导入任何文件到知识库「${value.kb}」：${dupText ? "全部与已有文档重合。" : ""}${extra ? "\n\n" + extra : ""}`;
    }
    const rows = list
      .map((r) =>
        r.skipped === true
          ? `- ${r.docId}  ${r.title}  [已跳过：该文档正在导入中]`
          : `- ${r.docId}  ${r.title}  [${typeLabel(r.type)}] ${r.pages ? r.pages + "页 " : ""}${r.chars}字 ${r.parts}部分${r.warnings?.length ? `（警告 ${r.warnings.length} 条）` : ""}`
      )
      .join("\n");
    const done = list.filter((r) => r.skipped !== true).length;
    const skipNote = (value.skipped ?? 0) > 0 ? `（${value.skipped} 个文件因正在导入中已跳过）` : "";
    return `已导入 ${done} 个文件到知识库「${value.kb}」${skipNote}:\n${rows}${extra ? "\n\n" + extra : ""}`;
  }
  const hint = value.hint ?? `已提交后台导入任务 ${value.jobId}`;
  return extra ? `${hint}\n\n${extra}` : hint;
}

function renderDuplicates(duplicates) {
  if (!duplicates?.length) return "";
  const lines = [`导入前查重：${duplicates.length} 个文件与已有文档重合，未导入：`];
  for (const d of duplicates) {
    const scope = d.scope === "same-kb" ? "同库" : "跨库";
    const matched = (d.matched ?? []).map((m) => `「${m.kb}」《${m.title}》(${m.id})`).join("、");
    lines.push(`- [${scope}重合] ${d.title} ↔ 已有 ${matched}`);
  }
  if (duplicates.some((d) => d.scope === "cross-kb")) {
    lines.push("（跨库重合的文件如需导入，请确认后重新执行 kb_import 并加 allowCrossDuplicates: true）");
  }
  return lines.join("\n");
}

function renderSimilar(similar) {
  if (!similar?.length) return "";
  const lines = [`导入前检查：${similar.length} 个文件与已有文档标题相似，已照常导入（请确认是否重复）：`];
  for (const d of similar) {
    const scope = d.scope === "same-kb" ? "同库" : "跨库";
    const matched = (d.matched ?? []).map((m) => `「${m.kb}」《${m.title}》(${m.id})`).join("、");
    lines.push(`- [${scope}相似] ${d.title} ↔ ${matched}`);
  }
  lines.push("（如确认重复，可用 kb_remove 删除本次导入的文档；相似不自动跳过是为了避免误丢文件）");
  return lines.join("\n");
}

function registerKbReparse(ctx, opts) {
  const {
    kbRoot, defaultKb, ocrLang, ocrWorkers, ocrDpi, ocrEngine, ocrNativeBin, ocrPythonBin,
    ebookConvertBin, partMaxChars, maxInlinePages, maxInlineBytes, importTimeoutMs,
  } = opts;
  const tool = defineTool({
    name: "kb_reparse",
    description:
      "从知识库内保存的 sources/ 重新解析文档（不需要重新上传），用于 OCR 引擎/解析器升级后刷新旧管线产物。doc 指定单个文档；all=true 时按 limit 批量。forceOcr 强制重 OCR；runInBackground 强制后台。会保留原 sourcePath/title，版本号+1。",
    parameters: {
      kb: { type: "string", description: "知识库名称，默认 default。" },
      doc: { type: "string", description: "文档标题（子串，需唯一）或 id；与 all 二选一。" },
      all: { type: "boolean", description: "重解析该库全部 ready 文档（默认按 limit=20 分批）。" },
      limit: { type: "number", description: "all=true 时本轮最多处理多少文档（默认 20，上限 500）。" },
      forceOcr: { type: "boolean", description: "强制对 PDF 全部页面走 OCR（忽略文字层）。" },
      ocrModel: { type: "string", description: "OCR 模型精度：best（默认）或 fast。" },
      runInBackground: { type: "boolean", description: "强制转后台任务（大文档默认自动转）。" },
    },
    timeoutMs: importTimeoutMs,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          inline: { type: "boolean", required: true },
          docs: { type: "number", required: true },
          results: { type: "array", items: { type: "object", additionalProperties: true } },
          skipped: { type: "array", items: { type: "object", additionalProperties: true } },
          jobId: { type: "string" },
          deferred: { type: "number" },
          hint: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderKbReparse(value) }],
    },
    async execute(args, exec) {
      const kb = sanitizeKbName(args.kb ?? defaultKb);
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      if (args.doc !== undefined && args.all === true) throw new Error("doc 与 all 不能同时使用");

      let docs;
      let deferred = 0;
      if (args.doc !== undefined) {
        const doc = resolveDoc(manifest, args.doc);
        if ((doc.type ?? "") === "note") throw new Error("笔记没有原始文件，无需重解析");
        docs = [doc];
      } else if (args.all === true) {
        const ready = (manifest.docs ?? []).filter((d) => d.status === "ready" && d.type !== "note");
        const limit = Math.max(1, Math.min(500, Math.round(Number(args.limit) || 20)));
        docs = ready.slice(0, limit);
        deferred = Math.max(0, ready.length - docs.length);
      } else {
        throw new Error("请指定 doc（单个文档），或传 all=true 批量重解析（建议配合 limit）");
      }
      if (docs.length === 0) {
        return { kb, inline: true, docs: 0, results: [], skipped: [], deferred: 0, hint: "没有需要重解析的文档" };
      }

      const files = [];
      const skipped = [];
      for (const doc of docs) {
        const ext = extname(doc.sourceFile || "");
        let sourcePath = join(dir, "sources", doc.id + ext);
        try {
          await access(sourcePath);
        } catch {
          let candidates = [];
          try {
            candidates = (await readdir(join(dir, "sources"))).filter((f) => f.startsWith(doc.id));
          } catch {
            candidates = [];
          }
          if (candidates.length === 1) sourcePath = join(dir, "sources", candidates[0]);
          else {
            skipped.push({ docId: doc.id, title: doc.title, error: "sources 中的原始文件缺失" });
            continue;
          }
        }
        files.push({
          sourcePath,
          relKey: doc.sourceFile || doc.id,
          title: doc.title,
          docId: doc.id,
          sourceFile: doc.sourceFile || "",
          storedSourcePath: doc.sourcePath ?? "",
          forceReparse: true,
        });
      }

      const jobConfig = {
        ocrLang,
        ocrWorkers,
        ocrDpi,
        ocrEngine,
        ocrNativeBin,
        ocrPythonBin,
        ebookConvertBin,
        partMaxChars,
        forceOcr: args.forceOcr === true,
        forceReparse: true,
        langPath: args.ocrModel === "fast" ? FAST_TESSDATA : DEFAULT_TESSDATA,
      };
      if (files.length === 0) {
        return { kb, inline: true, docs: 0, results: [], skipped, deferred, hint: "没有可重解析的来源文件" };
      }

      let totalBytes = 0;
      for (const f of files) {
        try {
          totalBytes += (await stat(f.sourcePath)).size;
        } catch {
          /* 单个文件统计失败不影响分流 */
        }
      }
      const totalPages = docs.reduce((sum, d) => sum + (Number(d.pages) || 0), 0);
      const inline =
        args.runInBackground !== true && totalPages <= maxInlinePages && totalBytes <= maxInlineBytes;

      if (inline) {
        const results = [];
        for (const f of files) {
          try {
            results.push(await importFileInto(dir, { ...f, config: jobConfig }));
          } catch (error) {
            results.push({ docId: f.docId, title: f.title, error: String(error?.message ?? error) });
          }
        }
        return {
          kb,
          inline: true,
          docs: files.length,
          results,
          skipped,
          deferred,
          hint: deferred > 0 ? `本轮达 limit，尚有 ${deferred} 个文档未处理` : "",
        };
      }

      const { jobId } = await startImportJob(ctx, {
        kbRoot,
        kb,
        dir,
        files,
        jobConfig,
        exec,
        kind: "kb-reparse",
        label: `kb-reparse ${kb}: ${files.length} 个文档`,
        verb: "重解析",
      });
      return {
        kb,
        inline: false,
        docs: files.length,
        results: [],
        skipped,
        jobId,
        deferred,
        hint:
          `重解析已作为后台任务启动（${files.length} 个文档）。用 job_output ${jobId} 查看进度；完成后用 kb_list ${kb} 查看结果。` +
          (deferred > 0 ? `另有 ${deferred} 个文档未处理。` : ""),
      };
    },
  });
  ctx.tools.register(tool);
}

function renderKbReparse(value) {
  const results = value.results ?? [];
  const skipped = value.skipped ?? [];
  if (value.inline) {
    if (results.length === 0 && skipped.length === 0) return value.hint || "没有可重解析的文档";
    const rows = results.map((r) => {
      if (r.error) return `- ${r.docId ?? ""}  ${r.title ?? ""}  [失败] ${r.error}`;
      return `- ${r.docId}  ${r.title}  [${typeLabel(r.type)}] ${r.pages ? r.pages + "页 " : ""}${r.chars}字 ${r.parts}部分 v${r.version ?? ""}${r.contentSource ? ` [${r.contentSource}]` : ""}`;
    });
    const skipRows = skipped.map((s) => `- ${s.docId}  ${s.title}  [跳过] ${s.error}`);
    const deferred = value.deferred > 0 ? `\n（本轮达 limit，尚有 ${value.deferred} 个文档未处理）` : "";
    return `已重解析 ${results.filter((r) => !r.error).length} 个文档到知识库「${value.kb}」:\n${[...rows, ...skipRows].join("\n")}${deferred}`;
  }
  return (
    (value.hint ?? `已提交重解析任务 ${value.jobId}`) +
    (skipped.length ? `\n\n跳过 ${skipped.length} 个：${skipped.map((s) => s.title).join("、")}` : "")
  );
}

function registerKbQuery(ctx, { kbRoot, defaultKb, queryMaxMatches, queryLineBytes }) {
  const tool = defineTool({
    name: "kb_query",
    description:
      "在知识库中全文检索（ripgrep 正则，中文短语可直接用）。返回匹配行及所在文档/行号。命中后用 kb_read 读取对应部分精读；可用 doc 参数限定在某一个文档内检索。",
    parameters: {
      pattern: {
        type: "string",
        required: true,
        description: "检索正则表达式（中文短语直接写即可）。",
      },
      kb: { type: "string", description: "知识库名称，默认 default。" },
      doc: {
        type: "string",
        description: "限定检索范围：文档标题（子串）或文档 id。",
      },
      maxMatches: {
        type: "number",
        description: "最多返回的匹配数，默认 40。",
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          pattern: { type: "string", required: true },
          total: { type: "number", required: true },
          truncated: { type: "boolean", required: true },
          lossy: { type: "boolean" },
          note: { type: "string" },
          matches: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                docId: { type: "string", required: true },
                title: { type: "string", required: true },
                path: { type: "string", required: true },
                lineNumber: { type: "number", required: true },
                part: { type: "number" },
                pageStart: { type: "number" },
                pageEnd: { type: "number" },
                line: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: renderKbQuery(value),
        },
      ],
    },
    async execute(args, exec) {
      const kb = sanitizeKbName(args.kb ?? defaultKb);
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      let docDir;
      if (args.doc !== undefined) {
        const doc = resolveDoc(manifest, args.doc);
        docDir = join(dir, "markdown", doc.id);
      }
      const result = await searchKb(ctx, exec, dir, manifest, {
        pattern: String(args.pattern),
        docDir,
        maxMatches: Math.min(500, Math.max(1, Math.round(Number(args.maxMatches) || queryMaxMatches))),
        lineBytes: queryLineBytes,
      });
      return { kb, ...result };
    },
  });
  ctx.tools.register(tool);
}

function renderKbQuery(value) {
  if (value.total === 0) {
    if (value.note) {
      return `知识库「${value.kb}」检索结果超出缓冲上限，未能保留匹配：${value.note}`;
    }
    return `知识库「${value.kb}」中没有匹配 "${value.pattern}" 的内容（可换关键词或宽泛表达再试）。`;
  }
  const grouped = [];
  let currentDoc = null;
  for (const m of value.matches) {
    if (currentDoc !== m.docId) {
      currentDoc = m.docId;
      grouped.push(`### ${m.title}（${m.docId}，${m.path}）`);
    }
    const loc = m.part
      ? `（部分 ${m.part}${m.pageStart ? `，第 ${m.pageStart}${m.pageEnd && m.pageEnd !== m.pageStart ? `–${m.pageEnd}` : ""} 页` : ""}）`
      : "";
    grouped.push(`行 ${m.lineNumber}${loc}: ${m.line}`);
  }
  // --max-count 会限制每文件命中数，total 可能小于真实总数；截断时用“至少”避免误导。
  const head =
    (value.truncated
      ? `找到至少 ${value.total} 处匹配（仅显示前 ${value.matches.length} 处，请收窄检索词）:\n`
      : `找到 ${value.total} 处匹配:\n`) + (value.note ? `${value.note}\n` : "");
  const foot = `\n---\n用 kb_read 读取上下文：doc 参数填文档 id（如 ${value.matches[0]?.docId ?? "<docId>"}）或标题。`;
  return head + grouped.join("\n") + foot;
}

function registerKbRead(ctx, { kbRoot, defaultKb, readMaxChars }) {
  const tool = defineTool({
    name: "kb_read",
    description:
      "读取知识库中文档的指定部分（精读）。doc 可用文档标题（子串）或 id。part 为分块序号（从 1 开始）；part=outline 返回文档大纲（目录）；part=all 返回整篇合并版（大文档会被截断）。返回内容超出上限时提示截断位置，请按 part 逐块读取。",
    parameters: {
      kb: { type: "string", description: "知识库名称，默认 default。" },
      doc: {
        type: "string",
        required: true,
        description: "文档标题（子串，需唯一）或文档 id。",
      },
      part: {
        description: "分块序号（1 开始，可为数字）、outline（大纲）或 all（整篇，默认取第 1 块）。",
        oneOf: [{ type: "string" }, { type: "integer" }],
      },
      maxChars: {
        type: "number",
        description: "返回字符数上限，默认 20000。",
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          docId: { type: "string", required: true },
          title: { type: "string", required: true },
          type: { type: "string", required: true },
          pages: { type: "number" },
          part: { type: "string" },
          partCount: { type: "number", required: true },
          chars: { type: "number", required: true },
          truncated: { type: "boolean", required: true },
          pageStart: { type: "number" },
          pageEnd: { type: "number" },
          text: { type: "string", required: true },
          outline: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: renderKbRead(value),
        },
      ],
    },
    async execute(args) {
      const kb = sanitizeKbName(args.kb ?? defaultKb);
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      const doc = resolveDoc(manifest, args.doc);
      const cap = Math.min(200000, Math.max(500, Math.round(Number(args.maxChars) || readMaxChars)));
      const outline = doc.outline ?? [];
      let text;
      let part = String(args.part ?? "1").trim();
      let truncated = false;
      let pageStart = null;
      let pageEnd = null;
      if (part === "outline") {
        text =
          outline.length > 0
            ? outline
                .map((item, i) => {
                  const title = typeof item === "string" ? item : item.title;
                  const page = typeof item === "object" && item.page ? `（第 ${item.page} 页）` : "";
                  const partNo = typeof item === "object" && item.part ? `（部分 ${item.part}）` : "";
                  return `${i + 1}. ${title}${page}${partNo}`;
                })
                .join("\n")
            : "（本文档没有大纲）";
        part = "outline";
      } else if (part === "all") {
        const file = join(dir, "markdown", doc.id, `${doc.id}.md`);
        try {
          text = await readFile(file, "utf8");
        } catch (error) {
          if (error.code === "ENOENT") {
            throw new Error(`文档「${doc.title}」的合并版尚不存在（可能仍在导入中或数据不完整）`);
          }
          throw error;
        }
        if (text.length > cap) {
          text = text.slice(0, cap) + "\n\n…（已截断，请用 part 参数逐块读取）";
          truncated = true;
        }
      } else {
        const partCount = doc.parts ?? 1;
        const index = Math.max(0, Math.round(Number(part)) - 1);
        if (!Number.isFinite(Number(part)) || index < 0 || index >= partCount) {
          throw new Error(`part 取值无效（1..${partCount} 或 outline/all）`);
        }
        text = await readPart(dir, doc, index);
        part = String(index + 1);
        const partIndex = await readPartIndex(dir, doc);
        const entry = partIndex.find((item) => item.part === index + 1);
        pageStart = entry?.pageStart ?? null;
        pageEnd = entry?.pageEnd ?? null;
      }
      return {
        kb,
        docId: doc.id,
        title: doc.title,
        type: typeLabel(doc.type),
        pages: doc.pages,
        part,
        partCount: doc.parts ?? 1,
        pageStart,
        pageEnd,
        chars: text.length,
        truncated,
        text,
        outline,
      };
    },
  });
  ctx.tools.register(tool);
}

function renderKbRead(value) {
  const pageText = value.pageStart
    ? `，第 ${value.pageStart}${value.pageEnd && value.pageEnd !== value.pageStart ? `–${value.pageEnd}` : ""} 页`
    : "";
  const meta = `【${value.title}】（${value.docId}，${value.type}${value.pages ? `，${value.pages} 页` : ""}，共 ${value.partCount} 部分${pageText}）\n`;
  const nav = value.part !== "all" && value.part !== "outline"
    ? `\n---\n继续读取: kb_read(doc=${value.docId}, part=<序号>)；检索相关片段: kb_query`
    : "";
  return meta + value.text + nav;
}

// ---------------------------------------------------------------------------
// kb_view：把原始页面渲染成图片供模型查看（公式 / 原理图 / 电路图 / 图表）
// ---------------------------------------------------------------------------

const IMAGE_MEDIA_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** kb_view 旧版 .doc/.ppt 转换结果缓存（按 路径+mtime+size 键控，最多保留 4 份），
 *  避免反复查看同一文档时重复走 COM/LibreOffice 转换。 */
const LEGACY_VIEW_CACHE = new Map();
async function cachedLegacyConvert(kind, sourcePath) {
  const { stat: statLocal } = await import("node:fs/promises");
  let key = null;
  try {
    const s = await statLocal(sourcePath);
    key = `${sourcePath}|${s.mtimeMs}|${s.size}`;
  } catch {
    /* stat 失败则不缓存 */
  }
  if (key !== null && LEGACY_VIEW_CACHE.has(key)) return LEGACY_VIEW_CACHE.get(key);
  const { convertLegacyDocToBuffer, convertLegacyPptToBuffer } = await import("./parsers.js");
  const buffer =
    kind === "doc"
      ? await convertLegacyDocToBuffer(sourcePath)
      : await convertLegacyPptToBuffer(sourcePath);
  if (key !== null) {
    if (LEGACY_VIEW_CACHE.size >= 4) {
      LEGACY_VIEW_CACHE.delete(LEGACY_VIEW_CACHE.keys().next().value);
    }
    LEGACY_VIEW_CACHE.set(key, buffer);
  }
  return buffer;
}

function registerKbView(ctx, { kbRoot, defaultKb, ebookConvertBin }) {
  const tool = defineTool({
    name: "kb_view",
    description:
      "查看知识库文档的原始页面图片：PDF 按页渲染（page=页码，count=连续页数）；Word/PPT/EPUB/MOBI 提取内嵌图片（image=图片序号）。用于阅读公式、原理图、电路图、图表等 OCR 文本无法可靠呈现的视觉内容；先不带 image 参数调用可获知内嵌图片总数。返回图片内容块供模型直接查看。",
    parameters: {
      kb: { type: "string", description: "知识库名称，默认 default。" },
      doc: {
        type: "string",
        required: true,
        description: "文档标题（子串，需唯一）或文档 id。",
      },
      page: {
        type: "integer",
        description: "PDF 页码（1 开始），默认 1。",
      },
      count: {
        type: "integer",
        description: "连续渲染的页数，默认 1，最多 4。",
      },
      image: {
        type: "integer",
        description: "Word/PPT 文档内嵌图片序号（1 开始）；省略时返回图片总数及第 1 张。",
      },
      dpi: {
        type: "number",
        description: "渲染分辨率（PDF 用），默认 200；超出图片大小上限时自动降低。",
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          docId: { type: "string", required: true },
          title: { type: "string", required: true },
          kind: { type: "string", required: true },
          totalPages: { type: "number" },
          totalImages: { type: "number" },
          images: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                page: { type: "number" },
                name: { type: "string" },
                mediaType: { type: "string", required: true },
                bytes: { type: "number", required: true },
                width: { type: "number", required: true },
                height: { type: "number", required: true },
                attachmentId: { type: "string", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const text = `【${value.title}】${value.kind === "pdf-page"
          ? ` PDF 共 ${value.totalPages} 页，本次显示 ${value.images.map((i) => `第 ${i.page} 页`).join("、")}`
          : ` 内嵌图片共 ${value.totalImages} 张`}`;
        return [
          { type: "text", text },
          ...value.images.map((image) => ({
            type: "image",
            attachment: {
              attachmentId: image.attachmentId,
              mediaType: image.mediaType,
              bytes: image.bytes,
              width: image.width,
              height: image.height,
              ...(image.name === undefined ? {} : { name: image.name }),
            },
          })),
        ];
      },
    },
    async execute(args) {
      const kb = sanitizeKbName(args.kb ?? defaultKb);
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      const doc = resolveDoc(manifest, args.doc);
      const sourceFile = doc.sourceFile ?? "";
      const ext = extname(sourceFile).toLowerCase();
      const sourcePath = join(dir, "sources", doc.id + ext);
      const attachments = ctx.get("attachments");
      if (attachments === undefined) {
        throw new Error("当前部署未挂载图片附件服务，无法查看页面图片");
      }
      const limits = attachments.imageLimits ?? {};
      const byteCap = Math.min(
        limits.maxImageBytes ?? 8 * 1024 * 1024,
        limits.maxMessageImageBytes ?? 8 * 1024 * 1024
      );

      const save = async (data, mediaType, name) => {
        const ref = await attachments.saveImage({ data, mediaType, name });
        return {
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          attachmentId: ref.attachmentId,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        };
      };

      if (ext === ".pdf") {
        const { default: mupdf } = await import("mupdf");
        const { readFile: readFileLocal } = await import("node:fs/promises");
        const data = await readFileLocal(sourcePath);
        const pdfDoc = mupdf.Document.openDocument(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          "application/pdf"
        );
        try {
          const totalPages = pdfDoc.countPages();
          const start = Math.max(1, Math.round(Number(args.page) || 1));
          const count = Math.min(4, Math.max(1, Math.round(Number(args.count) || 1)));
          const end = Math.min(totalPages, start + count - 1);
          if (start > totalPages) throw new Error(`页码超出范围: 该书共 ${totalPages} 页`);
          // 每页从请求的 dpi 独立降档：某一页降档不影响后续页分辨率
          const baseDpi = Math.min(400, Math.max(72, Math.round(Number(args.dpi) || 200)));
          const images = [];
          for (let p = start; p <= end; p++) {
            let dpi = baseDpi;
            let png;
            let width = 0;
            let height = 0;
            for (let attempt = 0; attempt < 3; attempt++) {
              const page = pdfDoc.loadPage(p - 1);
              const matrix = mupdf.Matrix.scale(dpi / 72, dpi / 72);
              const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
              png = Buffer.from(pixmap.asPNG());
              width = pixmap.getWidth();
              height = pixmap.getHeight();
              if (png.length <= byteCap) break;
              dpi = Math.max(72, Math.floor(dpi * Math.sqrt(byteCap / png.length) * 0.9));
            }
            if (png.length > byteCap) throw new Error(`第 ${p} 页渲染后仍超出图片大小上限（${png.length} > ${byteCap} 字节）`);
            images.push(await save(png, "image/png", `${doc.title}-第${p}页.png`));
            images[images.length - 1].page = p;
          }
          return { kb, docId: doc.id, title: doc.title, kind: "pdf-page", totalPages, images };
        } finally {
          // WASM 对象需显式销毁，避免多次 kb_view 后堆内分配累积
          try { pdfDoc.destroy(); } catch { /* ignore */ }
        }
      }

      if (ext === ".docx" || ext === ".pptx" || ext === ".doc" || ext === ".ppt" || ext === ".epub" || ext === ".mobi" || ext === ".azw" || ext === ".azw3") {
        const { default: JSZip } = await import("jszip");
        const { readFile: readFileLocal } = await import("node:fs/promises");
        let buffer;
        if (ext === ".doc") {
          // 旧版 .doc：先经 Word/textutil 转成 .docx 再提取内嵌图片（带缓存）
          buffer = await cachedLegacyConvert("doc", sourcePath);
        } else if (ext === ".ppt") {
          // 旧版 .ppt：先经 PowerPoint/LibreOffice 转成 .pptx 再提取内嵌图片（带缓存）
          buffer = await cachedLegacyConvert("ppt", sourcePath);
        } else if (ext === ".mobi" || ext === ".azw" || ext === ".azw3") {
          // MOBI/AZW3：先经 Calibre 转成 epub 再提取内嵌图片
          const { convertMobiToEpub } = await import("./parsers.js");
          buffer = await convertMobiToEpub(sourcePath, { ebookBin: ebookConvertBin || undefined });
        } else {
          buffer = await readFileLocal(sourcePath);
        }
        const zip = await JSZip.loadAsync(buffer);
        const entries = [];
        zip.forEach((path, file) => {
          if (file.dir) return;
          const m = /\.(png|jpe?g|gif|webp)$/i.exec(path);
          if (!m) return;
          entries.push({ path, mediaType: IMAGE_MEDIA_BY_EXT[m[0].toLowerCase()] ?? "image/png" });
        });
        entries.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
        if (entries.length === 0) {
          throw new Error("该文档没有内嵌图片（图表可能是矢量绘制对象，Word 里无法直接提取）");
        }
        const picked = [];
        if (args.image !== undefined) {
          const idx = Math.round(Number(args.image)) - 1;
          if (idx < 0 || idx >= entries.length) throw new Error(`图片序号超出范围: 1..${entries.length}`);
          picked.push(idx);
        } else {
          picked.push(0);
        }
        const images = [];
        for (const idx of picked) {
          const entry = entries[idx];
          const raw = await zip.file(entry.path).async("nodebuffer");
          if (raw.length > byteCap) {
            throw new Error(`内嵌图片过大（${raw.length} > ${byteCap} 字节），无法直接查看`);
          }
          const image = await save(raw, entry.mediaType, `${doc.title}-${entry.path.split("/").pop()}`);
          images.push(image);
        }
        return { kb, docId: doc.id, title: doc.title, kind: "embedded-image", totalImages: entries.length, images };
      }

      throw new Error(
        `该文档类型（${ext || "未知"}）暂不支持图片查看（PDF 按页渲染；Word/PPT/EPUB/MOBI 提取内嵌图片）`
      );
    },
  });
  ctx.tools.register(tool);
}

function registerKbEdit(ctx, { kbRoot, defaultKb }) {
  const tool = defineTool({
    name: "kb_edit",
    description:
      "精确修订知识库文档内容：在文档所有分块中查找 old_string 的精确出现，恰好出现一次时替换为 new_string（replaceAll=true 则全部替换），并重建合并版、版本号+1。用于持续修改完善知识。",
    parameters: {
      kb: { type: "string", description: "知识库名称，默认 default。" },
      doc: {
        type: "string",
        required: true,
        description: "文档标题（子串，需唯一）或文档 id。",
      },
      old_string: {
        type: "string",
        required: true,
        description: "要替换的原文（必须与文档内容逐字一致）。",
      },
      new_string: {
        type: "string",
        required: true,
        description: "替换后的新文本（可为空字符串以删除原文）。",
      },
      replaceAll: {
        type: "boolean",
        description: "出现多次时是否全部替换（默认 false，多处出现时报错提示）。",
      },
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          docId: { type: "string", required: true },
          title: { type: "string", required: true },
          replaced: { type: "number", required: true },
          changedParts: { type: "array", items: { type: "number" } },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `已修订「${value.title}」（${value.docId}）: 替换 ${value.replaced} 处，涉及部分 ${value.changedParts.join(", ")}，合并版已重建，版本号+1。`,
        },
      ],
    },
    async execute(args) {
      const kb = sanitizeKbName(args.kb ?? defaultKb);
      const dir = kbDirPath(kbRoot, kb);
      const oldString = String(args.old_string);
      if (oldString.length === 0) throw new Error("old_string 不能为空");
      const newString = String(args.new_string);
      // 读-改-写全程持清单锁：并发 kb_edit / 同文档导入不会互相覆盖分块
      return withManifestLock(dir, async () => {
        const manifest = await readManifest(dir);
        const doc = resolveDoc(manifest, args.doc);
        const partsDir = join(dir, "markdown", doc.id, "parts");
        let partFiles;
        try {
          partFiles = (await readdir(partsDir)).filter((f) => /^\d{4}\.md$/.test(f)).sort();
        } catch (error) {
          if (error.code === "ENOENT") {
            throw new Error(`文档「${doc.title}」没有可修订的分块内容（可能仍在导入中或数据不完整）`);
          }
          throw error;
        }
        const contents = [];
        let total = 0;
        for (const f of partFiles) {
          const text = await readFile(join(partsDir, f), "utf8");
          let count = 0;
          let idx = text.indexOf(oldString);
          while (idx !== -1) {
            count += 1;
            idx = text.indexOf(oldString, idx + oldString.length);
          }
          contents.push({ file: f, text, count });
          total += count;
        }
        if (total === 0) {
          throw new Error(`文档中找不到 "${oldString.slice(0, 80)}"（注意逐字一致；可先 kb_read 查看原文）`);
        }
        if (total > 1 && args.replaceAll !== true) {
          const detail = contents
            .filter((c) => c.count > 0)
            .map((c) => `部分 ${Number(c.file.slice(0, 4))}×${c.count}`)
            .join("、");
          throw new Error(`old_string 出现 ${total} 处（${detail}）；请扩大 old_string 使其唯一，或设置 replaceAll=true`);
        }
        const changedParts = [];
        for (const c of contents) {
          if (c.count === 0) continue;
          await writeFile(join(partsDir, c.file), c.text.split(oldString).join(newString), "utf8");
          changedParts.push(Number(c.file.slice(0, 4)));
        }
        const merged = await rebuildMerged(dir, doc);
        const chars = merged.length;
        await touchDocLocked(dir, manifest, doc.id, { chars, parts: partFiles.length, edited: true });
        return { kb, docId: doc.id, title: doc.title, replaced: total, changedParts };
      });
    },
  });
  ctx.tools.register(tool);
}

function registerKbAddNote(ctx, { kbRoot, defaultKb, partMaxChars }) {
  const tool = defineTool({
    name: "kb_add_note",
    description:
      "向知识库添加一篇笔记（markdown 格式，单篇上限 2MB）。用于沉淀分析结论、补充资料、持续完善知识库；笔记可被 kb_query 检索、kb_read 阅读、kb_edit 修订、kb_export 导出。",
    parameters: {
      kb: { type: "string", description: "知识库名称，默认 default。" },
      title: {
        type: "string",
        required: true,
        description: "笔记标题。",
      },
      content: {
        type: "string",
        required: true,
        description: "笔记内容（markdown）。",
      },
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          docId: { type: "string", required: true },
          title: { type: "string", required: true },
          chars: { type: "number", required: true },
          parts: { type: "number", required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `已添加笔记「${value.title}」（${value.docId}）到知识库「${value.kb}」: ${value.chars} 字，${value.parts} 部分。`,
        },
      ],
    },
    async execute(args) {
      const kb = sanitizeKbName(args.kb ?? defaultKb);
      const dir = kbDirPath(kbRoot, kb);
      const title = String(args.title ?? "").trim().slice(0, 200);
      if (title.length === 0) throw new Error("笔记标题不能为空");
      const content = String(args.content ?? "");
      const NOTE_MAX_CHARS = 2 * 1024 * 1024;
      if (content.length > NOTE_MAX_CHARS) {
        throw new Error(`笔记内容过长（${content.length} 字符，上限 ${NOTE_MAX_CHARS}），请拆分为多篇笔记或先精简`);
      }
      const docId = createHash("sha1")
        .update(`note:${Date.now().toString(36)}:${randomBytes(6).toString("hex")}`)
        .digest("hex")
        .slice(0, 12);
      const staged = join(dir, "import-tmp", `note-${docId}-${randomBytes(3).toString("hex")}`);
      await mkdir(staged, { recursive: true });
      const sections = sectionsFromMarkdown(content);
      const { parts, chars, outline } = await writeParts(staged, sections, { partMaxChars, docTitle: title });
      const partsDir = join(staged, "parts");
      const partFiles = (await readdir(partsDir)).filter((f) => /^\d{4}\.md$/.test(f)).sort();
      let merged = `# ${title}\n\n`;
      for (const f of partFiles) {
        merged += (await readFile(join(partsDir, f), "utf8")).trimEnd() + "\n\n";
      }
      await writeFile(join(staged, `${docId}.md`), merged.trimEnd() + "\n", "utf8");
      const { commitDoc } = await import("./store.js");
      await commitDoc(dir, {
        docId,
        sourcePath: undefined,
        sourceExt: undefined,
        stagedDir: staged,
        title,
        type: "note",
        pages: 0,
        chars,
        parts,
        outline,
        warnings: [],
        sourceHash: "",
        parserVersion: PARSER_VERSION,
        contentSource: "note",
        ocrPages: 0,
        ocrEngine: "",
        ocrDpi: 0,
        ocrLang: "",
        ocrModel: "best",
        edited: false,
      });
      return { kb, docId, title, chars, parts };
    },
  });
  ctx.tools.register(tool);
}

function registerKbRemove(ctx, { kbRoot, defaultKb }) {
  const tool = defineTool({
    name: "kb_remove",
    description:
      "删除知识库中的单个文档（doc 参数），或删除整个知识库（必须显式 removeKb=true 且 confirm 等于知识库名称）。删除不可恢复，请谨慎。",
    parameters: {
      kb: { type: "string", description: "知识库名称，默认 default。" },
      doc: {
        type: "string",
        description: "要删除的文档标题（子串）或 id。",
      },
      removeKb: {
        type: "boolean",
        description: "显式确认删除整个知识库（doc 为空时必填 true）。",
      },
      confirm: {
        type: "string",
        description: "删除整个知识库时的安全确认：必须逐字等于知识库名称（removeKb=true 时必填）。",
      },
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          removed: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.removed }],
    },
    async execute(args) {
      const kb = sanitizeKbName(args.kb ?? defaultKb);
      if (args.doc !== undefined) {
        const dir = kbDirPath(kbRoot, kb);
        const manifest = await readManifest(dir);
        const doc = resolveDoc(manifest, args.doc);
        await removeDoc(dir, doc.id);
        return { kb, removed: `已从知识库「${kb}」删除文档「${doc.title}」（${doc.id}）` };
      }
      if (args.removeKb === true) {
        const confirm = String(args.confirm ?? "").trim();
        if (confirm !== kb) {
          throw new Error(`删除整个知识库「${kb}」不可恢复。请确认后重试：同时传 removeKb=true 和 confirm="${kb}"（逐字一致）`);
        }
        await removeKbDir(kbRoot, kb);
        return { kb, removed: `已删除整个知识库「${kb}」` };
      }
      throw new Error("未指定 doc 时删除整个知识库需要显式传 removeKb=true 且 confirm 等于知识库名称");
    },
  });
  ctx.tools.register(tool);
}

function registerKbExport(ctx, { kbRoot, defaultKb }) {
  const tool = defineTool({
    name: "kb_export",
    description:
      "导出知识库，供其他大模型/应用阅读使用：format=md 合并为单个 markdown 文件（含目录，适合直接上传对话产品）；format=jsonl 每行一个分块（适合 RAG 管道）；format=zip 打包整个知识库（markdown+清单，includeSources=true 时包含原始文件，可迁移到其他机器）。out 省略时写到知识库 exports/ 目录。",
    parameters: {
      kb: { type: "string", description: "知识库名称，默认 default。" },
      format: {
        type: "string",
        description: "md | jsonl | zip（默认 md）。",
      },
      out: {
        type: "string",
        description: "输出文件绝对路径（支持 ~ 开头的用户目录路径；相对路径按当前工作目录解析）；省略时写入知识库 exports/ 目录。",
      },
      includeSources: {
        type: "boolean",
        description: "zip 导出时是否包含原始文件（默认 false，可显著减小体积）。",
      },
    },
    timeoutMs: 600000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          format: { type: "string", required: true },
          bytes: { type: "number", required: true },
          docs: { type: "number", required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `已导出知识库（${value.format}，${value.docs} 个文档，${Math.round(value.bytes / 1024)} KB）: ${value.path}`,
        },
      ],
    },
    async execute(args, exec) {
      const kb = sanitizeKbName(args.kb ?? defaultKb);
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      const format = String(args.format ?? "md").toLowerCase();
      if (!["md", "jsonl", "zip"].includes(format)) {
        throw new Error(`format 取值无效: ${args.format}（应为 md / jsonl / zip）`);
      }
      const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const suffix = randomBytes(2).toString("hex");
      const ext = format === "zip" ? ".zip" : format === "jsonl" ? ".jsonl" : ".md";
      let outPath;
      if (args.out !== undefined) {
        const out = expandUser(String(args.out).trim());
        outPath = isAbsolute(out) ? out : resolve(execCwd(exec), out);
      } else {
        const exportsDir = join(dir, "exports");
        await mkdir(exportsDir, { recursive: true });
        outPath = join(exportsDir, `${kb}-${ts}-${suffix}${ext}`);
      }
      if (format === "md") {
        const r = await exportMarkdown(dir, manifest, outPath);
        return { path: outPath, format, bytes: r.bytes, docs: r.docs };
      }
      if (format === "jsonl") {
        const r = await exportJsonl(dir, manifest, outPath);
        return { path: outPath, format, bytes: r.bytes, docs: r.docs };
      }
      const r = await exportZip(dir, manifest, outPath, args.includeSources === true);
      return { path: outPath, format, bytes: r.bytes, docs: r.docs };
    },
  });
  ctx.tools.register(tool);
}

function registerKbRename(ctx, { kbRoot, defaultKb }) {
  const tool = defineTool({
    name: "kb_rename",
    description: "重命名知识库（目录与清单同步更新）。",
    parameters: {
      kb: { type: "string", description: "当前知识库名称。" },
      newName: { type: "string", required: true, description: "新名称（可含中文）。" },
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          dir: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: `知识库已重命名为「${value.kb}」（${value.dir}）` }],
    },
    async execute(args) {
      const kb = sanitizeKbName(args.kb ?? defaultKb);
      const dir = await renameKb(kbRoot, kb, args.newName);
      return { kb: sanitizeKbName(args.newName), dir };
    },
  });
  ctx.tools.register(tool);
}

function registerKbStdCheck(ctx, opts) {
  const {
    kbRoot, defaultKb, bzBaseUrl, bzCookie, stdRateMs, stdMaxAgeDays, stdTimeoutMs,
    ocrLang, ocrWorkers, ocrDpi, ocrEngine, ocrNativeBin, ocrPythonBin, ebookConvertBin, partMaxChars,
  } = opts;
  const tool = defineTool({
    name: "kb_std_check",
    description:
      "标准更新检查：从知识库（默认「标准」库）的文档标题提取标准号，逐条在标准网(biaozhun.org)检索比对年份，发现更新（新版本/草案已出正式版）时用登录会话自动下载 PDF 并直接导入知识库。内置请求限速与增量缓存（7 天内已查过的编号跳过，force=true 强制全查；中断后再次调用自动续查）。下载需要 bzCookie（用户在浏览器登录 biaozhun.org 后提供的 Cookie 串，写入插件配置）；未提供时仅做检查报告。站点每次下载消耗 6 金币（VIP 免金币），金币不足的标准会列出失败原因。",
    parameters: {
      kb: { type: "string", description: "要检查的知识库名称，默认「标准」。" },
      action: {
        type: "string",
        description: "check（只检查报告，不下载）| check-download（默认，检查并自动下载更新）| download（跳过检查，按缓存补下载未完成的更新，金币充值后使用）。",
      },
      force: { type: "boolean", description: "强制重新检查全部编号（忽略 7 天缓存），默认 false。" },
      limit: { type: "number", description: "本轮最多检查的标准编号数（0=不限制；用于分轮执行，默认 0）。" },
      dryRun: { type: "boolean", description: "只模拟不实际下载（默认 false）。" },
    },
    timeoutMs: stdTimeoutMs,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          report: { type: "string", required: true },
          summary: { type: "object", additionalProperties: true, required: true },
          imported: { type: "array", items: { type: "object", additionalProperties: true } },
          cacheFile: { type: "string" },
          hint: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.report }],
    },
    async execute(args, exec) {
      const kb = sanitizeKbName(args.kb ?? defaultKb);
      const dir = kbDirPath(kbRoot, kb);
      await mkdir(dir, { recursive: true });
      const action = args.action === "check" ? "check" : args.action === "download" ? "download" : "check-download";
      const { report, cache } = await runStdCheck({
        kbDir: dir,
        baseUrl: bzBaseUrl,
        cookie: bzCookie,
        rateMs: stdRateMs,
        maxAgeDays: stdMaxAgeDays,
        force: args.force === true,
        limit: Math.max(0, Math.round(Number(args.limit) || 0)),
        action,
        dryRun: args.dryRun === true,
      });

      // 下载完成后导入知识库
      let imported = [];
      let hint = "";
      if ((action === "check-download" || action === "download") && args.dryRun !== true && report.downloaded.length > 0) {
        const manifest = await readManifest(dir);
        const existing = new Set((manifest.docs ?? []).map((d) => d.sourceFile ?? "").filter(Boolean));
        imported = await importDownloaded(dir, cache, async (filePath, title) => {
          const fileName = basename(filePath);
          if (existing.has(fileName)) {
            return { docId: null, skipped: true };
          }
          existing.add(fileName);
          return importFileInto(dir, {
            sourcePath: filePath,
            relKey: `std-download/${fileName}`,
            stableKey: true,
            title,
            config: {
              ocrLang, ocrWorkers, ocrDpi, ocrEngine, ocrNativeBin, ocrPythonBin,
              ebookConvertBin, partMaxChars,
              langPath: DEFAULT_TESSDATA,
            },
          });
        }, {});
        const importedOk = imported.filter((i) => i.docId).length;
        if (importedOk > 0) hint = `已导入 ${importedOk} 份新标准到「${kb}」库`;
      }
      // 因 limit 顺延时必须明确告知未查完，避免把部分结果当作“已核对完成”
      if (report.deferred > 0) {
        const more = `本轮达 limit 上限，尚有 ${report.deferred} 组未检查（并非已查完），请再次调用续查`;
        hint = hint ? `${hint}；${more}` : more;
      }

      const cacheFile = join(dir, ".std-check.json");
      const summary = {
        totalDocs: report.totalDocs,
        stdGroups: report.stdGroups,
        checked: report.checked,
        fresh: report.fresh,
        deferred: report.deferred,
        updates: report.updates.length,
        draftsReleased: report.draftsReleased.length,
        currents: report.currents.length,
        notFound: report.notFound.length,
        newerInKb: report.newerInKb.length,
        downloaded: report.downloaded.length,
        downloadFailed: report.downloadFailed.length,
        authOk: report.authOk,
      };
      return {
        kb,
        report: renderStdReport(report),
        summary,
        imported,
        cacheFile,
        hint,
      };
    },
  });
  ctx.tools.register(tool);
}

export { Config, inject, name };

// (noop) ripgrep-win32-x64 platform package installed alongside @vscode/ripgrep
