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
import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir, mkdir, stat, writeFile, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { availableParallelism, cpus, homedir, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { importFileInto, collectSources, preScanPdfPages } from "./pipeline.js";
import { scanDuplicates } from "./dedup.js";
import { addToDedupIndex, buildDedupIndexFromRoot } from "./dedup-index.js";
import { createImportWorkerRunner, prepareImportArgs, refreshKbIndex, tempReportFile } from "./import-job.js";
import { tessDataStatus } from "./ocr.js";
import { PARSER_VERSION, VERSION } from "./version.js";
import { sectionsFromMarkdown, SUPPORTED_EXTS } from "./parsers.js";
import { expandStdQuery, rankMatches, searchKb } from "./query.js";
import { deepLinkFor, keywordsOfQuery, pageOfClause, snippetOf, sourcesFromMatches } from "./sources.js";
import { applySemanticToResults, finishResult, groupHitsByDoc } from "./search.js";
import { createSemanticChannel, semanticStatus } from "./semantic-service.js";
import { createSemanticRuntime, DEFAULT_MODEL_DIR } from "./semantic-runtime.js";
import { readSemanticEnabled } from "./semantic-settings.js";
import { runStdCheck, importDownloaded, renderStdReport, createStdImportFn } from "./standards.js";
import { typeLabel, noteKindLabel, trustLabel, TRUST_LEVELS } from "./labels.js";
import { lintManifest, stageOf } from "./lint.js";
import { cleanTitle } from "./titles.js";
import { parseDocMeta, textFingerprint, withStandardPrefix } from "./doc-meta.js";
import { exportVault } from "./vault.js";
import { registerKbWeb } from "./web/server.js";
import {
  assertInScope,
  assertScopeEnabled,
  MAX_SCOPE_KBS,
  resolveDocTarget,
  resolveExecScope,
  resolveSingleKb,
  ScopeError,
  scopeForSessionSync,
} from "./scope.js";
import { scopePromptText } from "./scope-view.js";
import { renameScopeKb } from "./scope-store.js";
import {
  appendLog,
  backlinksFor,
  ensureLog,
  ensureSchema,
  NOTE_KINDS,
  normalizeSources,
  normalizeTags,
  readSchema,
  readVirtualDoc,
  refreshIndexIfStale,
  resolveContentLinks,
  schemaTemplate,
  splitVirtualParts,
  summarizeText,
  VIRTUAL_DOCS,
  VIRTUAL_TITLES,
  writeSchema,
} from "./wiki.js";
import {
  docSize,
  expandRoot,
  exportJsonl,
  exportMarkdown,
  exportZip,
  kbDirPath,
  listKbs,
  isDeleted,
  pruneHistory,
  readManifest,
  readPageQuality,
  restoreDoc,
  restoreDocVersion,
  readPart,
  readPartIndex,
  rebuildMerged,
  removeDoc,
  removeKbDir,
  renameKb,
  resolveDoc,
  sanitizeKbName,
  snapshotDocVersion,
  softDeleteDoc,
  sweepStaging,
  touchDocLocked,
  touchDocsLocked,
  snapshotKb,
  listKbSnapshots,
  tryReadManifest,
  withManifestLock,
  writeParts,
  updateDocMetaLocked,
  updateDocsMetaLocked,
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
  semanticSearch: z.string().default("off").description("可选语义层：off（默认）/ on；开启前需安装可选依赖并准备模型"),
  semanticModelDir: z.string().default("").description("语义模型目录；留空用 ~/.dsh/tools/models/bge-small-zh-v1.5"),
  ocrLang: z.string().default("chi_sim+eng"),
  ocrWorkers: z.number().default(0).description("OCR 并行 worker 数；0 = 按 CPU 自动（约核数一半，本机自动取值）"),
  ocrDpi: z.number().default(0).description("扫描页渲染 DPI；0 = 自动（300）"),
  ocrNativeBin: z.string().default(""),
  ocrEngine: z.string().default("auto"),
  pdfColumnReorder: z.boolean().default(true).description("文字层 PDF 是否自动检测双栏并重排阅读顺序"),
  autoDownloadModels: z.boolean().default(true).description("OCR 模型缺失时是否自动下载到 ~/.dsh/tools/tessdata（首次 OCR 会联网）"),
  ocrPythonBin: z.string().default(""),
  ebookConvertBin: z.string().default(""),
  officeKitCli: z.string().default("").description("LibreOfficeKit CLI 路径；留空自动探测（DSH_OFFICE_KIT_CLI 或默认安装）"),
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
  uiEnabled: z.boolean().default(true).description("是否启用 /kb 知识库工作台"),
  uiMaxUploadBytes: z.number().default(2147483648).description("工作台上传单文件上限（字节，默认 2 GiB）"),
  uiMaxBatchFiles: z.number().default(1000).description("工作台上传单批次文件数上限（默认 1000）"),
  scopeTtlDays: z.number().default(30).description("会话范围条目过期天数；0 = 不过期"),
  scopeLintMaxKbs: z.number().default(20).description("kb_lint 在 selected 模式下最多检查多少个库"),
  trashRetentionDays: z.number().default(0).description("回收站自动清理：已删除资料超过 N 天自动彻底删除；0 = 关闭"),
});

/** 整数配置的统一夹取：非有限值回落到默认值，再夹到 [min, max]。 */
function clampInt(value, fallback, min, max) {
  const number = Number(value);
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(number) ? number : fallback)));
}

// 类型标签统一在 lib/labels.js 维护（store/wiki 也引用）

function parsePageList(value) {
  return String(value ?? "")
    .split(/[,\s，、]+/)
    .map((part) => Number(part))
    .filter((pageNo) => Number.isInteger(pageNo) && pageNo > 0);
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

/** 启动时确保 kbRoot 可建可写；失败只记录原因（状态页可见），不阻塞其它注册。 */
export async function ensureWritableRoot(root) {
  try {
    await mkdir(root, { recursive: true });
    await access(root, fsConstants.W_OK);
    return "";
  } catch (error) {
    return String(error?.message ?? error);
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export async function apply(ctx, config) {
  const cfg = config ?? {};
  // 绝对路径（相对路径按启动时的工作目录落盘，避免运行中 cwd 变化导致换库）。
  const kbRoot = resolve(expandRoot(cfg.kbRoot ?? "~/.dsh/knowledge"));
  const defaultKb = sanitizeKbName(cfg.defaultKb ?? "default");
  const semanticSearch = String(cfg.semanticSearch ?? "off").trim().toLowerCase() === "on";
  const semanticModelDir = String(cfg.semanticModelDir ?? "").trim();
  // 默认关闭：关闭时连 runtime 对象都不建，更不会加载原生模块/模型。
  const semanticModelDirPath = semanticModelDir ? resolve(expandRoot(semanticModelDir)) : "";
  // 0.31.2：开关可在工作台里改（<kbRoot>/.semantic.json），运行时按需懒加载；
  // 配置里的 semanticSearch 只作为默认值，关闭时不会创建 runtime、不加载原生模块。
  let semanticRuntimeInstance = null;
  const getSemanticRuntime = () => {
    if (cfg.semanticRuntime) return cfg.semanticRuntime;
    semanticRuntimeInstance ??= createSemanticRuntime({
      ...(semanticModelDirPath ? { modelDir: semanticModelDirPath } : {}),
      logger: {
        warn: (message) => {
          try {
            ctx.logger?.warn?.(message);
          } catch {
            /* 日志失败不影响检索 */
          }
        },
      },
    });
    return semanticRuntimeInstance;
  };
  const isSemanticEnabled = () => readSemanticEnabled(kbRoot, semanticSearch);
  const ocrLang = cfg.ocrLang || "chi_sim+eng";
  const ocrWorkers = Math.min(16, Math.max(1, Math.round(Number(cfg.ocrWorkers) || AUTO_OCR_WORKERS)));
  const ocrDpi = Math.min(400, Math.max(100, Math.round(Number(cfg.ocrDpi) || AUTO_OCR_DPI)));
  const ocrEngine = ["auto", "rapidocr", "tesseract", "wasm"].includes(cfg.ocrEngine) ? cfg.ocrEngine : "auto";
  const pdfColumnReorder = cfg.pdfColumnReorder !== false;
  const autoDownloadModels = cfg.autoDownloadModels !== false;
  const ocrNativeBin = String(cfg.ocrNativeBin ?? "").trim();
  const ocrPythonBin = String(cfg.ocrPythonBin ?? "").trim();
  const ebookConvertBin = String(cfg.ebookConvertBin ?? "").trim();
  const officeKitCli = String(cfg.officeKitCli ?? "").trim();
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
  const uiEnabled = cfg.uiEnabled !== false;
  const uiMaxUploadBytes = Math.min(16 * 1024 ** 3, Math.max(1024 * 1024, Math.round(Number(cfg.uiMaxUploadBytes) || 2147483648)));
  const uiMaxBatchFiles = Math.min(5000, Math.max(1, Math.round(Number(cfg.uiMaxBatchFiles) || 1000)));
  const scopeTtlDays = clampInt(cfg.scopeTtlDays ?? 30, 30, 0, 3650);
  const scopeLintMaxKbs = clampInt(cfg.scopeLintMaxKbs ?? 20, 20, 1, MAX_SCOPE_KBS);
  const trashRetentionDays = clampInt(cfg.trashRetentionDays ?? 0, 0, 0, 3650);

  // worker 导入配置的唯一组装点：工具路径（kb_import / kb_reparse / kb_std_check）
  // 与工作台（上传 / 标准导入）共用，避免 OCR/langPath 多份拷贝漂移。
  const buildImportConfig = (options = {}) => ({
    ocrLang,
    ocrWorkers,
    ocrDpi,
    ocrEngine,
    pdfColumnReorder,
    autoDownloadModels,
    ocrNativeBin,
    ocrPythonBin,
    ebookConvertBin,
    partMaxChars,
    langPath: options.ocrModel === "fast" ? FAST_TESSDATA : DEFAULT_TESSDATA,
  });

  const kbRootError = await ensureWritableRoot(kbRoot);
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

  // 清理崩溃遗留的导入暂存目录；顺带给旧库补 schema.md / log.md 并刷新 index.md
  try {
    const entries = await readdir(kbRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) {
        const dir = join(kbRoot, e.name);
        await sweepStaging(dir).catch(() => {});
        const manifest = await tryReadManifest(dir);
        if (!manifest) continue;
        await ensureSchema(dir, e.name).catch(() => {});
        await ensureLog(dir).catch(() => {});
        await refreshIndexIfStale(dir, manifest).catch(() => {});
      }
    }
  } catch {
    /* kbRoot 可能尚为空 */
  }

  try {
    ctx.systemPrompt.section({
      name: "tool:knowledge-wiki",
      order: 106,
      text: [
        "知识库工作流：用户会引用已整理进知识库的资料。需要知识库内容时，先用 kb_query 检索（中文可直接用短语或正则），再用 kb_read 按 part 精读命中的部分；回答/分析时注明来源文档与页码。",
        "导入资料用 kb_import（支持 docx/pptx/xlsx/pdf/md/txt/epub/mobi/azw3，扫描版 PDF 自动 OCR，Excel 按工作表转 Markdown 表格，mobi/azw3 需本机 Calibre 自动转 epub，可传目录批量导入，可指定 kb 名称创建新知识库）；大文件（如整本扫描书）会自动转为后台任务，用 job_output 查看进度，不要重复发起相同导入。导入前自动与当前库及本会话范围内的知识库（未限定范围时为全部）查重（按标准号/标题）：同库重合自动跳过，跨库重合默认跳过并在结果中报告；用户确认需要时才加 allowCrossDuplicates: true 重新导入。标题仅前缀相似的低置信匹配会照常导入并提示确认。导入完成后先用 kb_retitle(all=true) 预览标题清洗（站点后缀、GB_T、序号等），确认后再 dryRun=false 应用；随后用 kb_describe 补摘要、kb_trust 标可信度。",
        "知识库分三层：sources/ 原始资料（只读）、markdown/ 派生分块、笔记（kb_add_note 沉淀的编译页）。每个库有维护规范 schema.md（kb_read doc=\"schema\" 查看，kb_edit doc=\"schema\" 修订）；内容索引 index.md 与操作日志 log.md 由插件自动维护（kb_read doc=\"index\" / doc=\"log\"），不要手改。",
        "沉淀知识用 kb_add_note：kind=summary|entity|concept|topic，可写 tags 与 sources（docId#页码 或 [[标题]]）；同一标题再次调用=更新该笔记，不要用「续」「修订版」另起新页。给已有文档写一行摘要/标签用 kb_describe（index.md 会随之更新）；修订原文用 kb_edit。检索命中里笔记是已编译的结论，回答优先参考并注明 docId 与页码。",
        "定期用 kb_lint 做机械体检（失败/旧管线/损坏页/内容重复/同号多版本/未编目/无来源笔记/孤页）；标题带站点域名、GB_T、序号等噪声时用 kb_retitle（all=true 默认只预览，确认后 dryRun=false 应用）。检索标准号可直接写 GBT / GB∕T / GB_T，插件会自动扩展为兼容写法。文档可用 kb_trust 标可信度（high/medium/low）：检索会优先高可信并标注低可信；多份资料矛盾时采用高可信版本，并提醒用户低可信来源。重复组人工核对后可用 kb_keep 标记「已核对保留」，kb_lint 不再报该组。同号不同年时，若新版封面写明“代替 <旧版号-年>”，把旧版 kb_trust 标 low（已废止）；报批/征求意见稿不能作为废止依据。批量跨文档修订用 kb_edit_batch（先全量校验，失败整批回滚）；重要操作前用 kb_snapshot 留库级快照；需要 Obsidian 双链/图谱时用 kb_export format=vault。",
        "对外交付用 kb_export（md 单文件 / jsonl 分块（可 chunkSize 切 RAG 小块）/ zip 完整包，供其他大模型阅读使用；笔记带 YAML frontmatter）。删除文档默认软删除，可用 kb_restore 恢复；查看历次版本用 kb_history，恢复历史版本用 kb_restore(version=N)；只有明确要永久删除时才传 soft=false；删除整库不可恢复。",
        "标准更新用 kb_std_check（默认检查「标准」库，在标准网 biaozhun.org 比对年份并自动下载新版 PDF 导入知识库；内置限速与 7 天增量缓存，force=true 强制全查，limit 可分批；下载需配置 bzCookie，未配置时仅报告不下载）。",
        "OCR 文本无法可靠呈现公式、原理图、电路图、图表等视觉内容；遇到这些内容（或用户询问公式/图纸时）用 kb_view 查看原始页面图片或 Word/PPT 内嵌图片，再结合图片作答并注明页码。kb_read 会标出文字层损坏/OCR 低置信页，遇到这些页优先用 kb_view 核对。",
        "引用与高亮：先从用户问题提炼 2–6 个检索关键词，kb_query 用这些词检索；随后调用 kb_read 精读时把同一组关键词填入 keywords，界面会按这些词在原件预览中高亮（不要把条款号当关键词）。引用格式：结论处写（《标题》GB/T 19963.2-2024 第 5.2.2 条，第 12 页）；标题已含标准号时省略书名号；多处用分号分隔。kb_query/kb_read 返回的 sources[].deepLink 仅供界面跳转，正文不要输出 URL；没有页码时省略“第 N 页”，没有条款时用“第 N 部分”。",
      ].join(" "),
    });

    try {
      ctx.systemPrompt.section({
        name: "kb:scope",
        order: 120,
        text: (context) => {
          try {
            const session = context?.agent?.session;
            if (session?.id === undefined) return "";
            const scope = scopeForSessionSync(kbRoot, session.id, session.header?.parentSession, scopeTtlDays);
            return scopePromptText(scope);
          } catch {
            return "";
          }
        },
      });
    } catch (error) {
      await logLoad(`scope prompt section failed: ${error?.message ?? error}`);
    }

    const registered = [];
    for (const register of [
      () => registerKbList(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbImport(ctx, { kbRoot, defaultKb, ocrLang, buildImportConfig, maxInlinePages, maxInlineBytes, importTimeoutMs, scopeTtlDays }),
      () => registerKbReparse(ctx, { kbRoot, defaultKb, buildImportConfig, maxInlinePages, maxInlineBytes, importTimeoutMs, scopeTtlDays }),
      () => registerKbQuery(ctx, { kbRoot, defaultKb, queryMaxMatches, queryLineBytes, scopeTtlDays, semanticEnabled: isSemanticEnabled, getSemanticRuntime }),
      () => registerKbRead(ctx, { kbRoot, defaultKb, readMaxChars, partMaxChars, scopeTtlDays }),
      () => registerKbView(ctx, { kbRoot, defaultKb, ebookConvertBin, scopeTtlDays }),
      () => registerKbEdit(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbDescribe(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbRetitle(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbLint(ctx, { kbRoot, defaultKb, scopeTtlDays, scopeLintMaxKbs }),
      () => registerKbTrust(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbKeep(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbEditBatch(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbSnapshot(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbAddNote(ctx, { kbRoot, defaultKb, partMaxChars, scopeTtlDays }),
      () => registerKbRemove(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbRestore(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbHistory(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbExport(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbRename(ctx, { kbRoot, defaultKb, scopeTtlDays }),
      () => registerKbStdCheck(ctx, { kbRoot, defaultKb, scopeTtlDays, bzBaseUrl, bzCookie, stdRateMs, stdMaxAgeDays, stdTimeoutMs, buildImportConfig }),
    ]) {
      try {
        register();
        registered.push("ok");
      } catch (error) {
        registered.push(`FAIL:${error?.message ?? error}`);
      }
    }
    try {
      registerKbWeb(ctx, {
        kbRoot,
        kbRootError,
        defaultKb,
        uiEnabled,
        version: VERSION,
        officeKitCli,
        limits: { maxUploadBytes: uiMaxUploadBytes, maxBatchFiles: uiMaxBatchFiles, extensions: SUPPORTED_EXTS },
        semanticSearch,
        semanticEnabled: isSemanticEnabled,
        getSemanticRuntime,
        semanticModelDir: semanticModelDirPath || DEFAULT_MODEL_DIR,
        semanticPluginRoot: pluginRoot,
        semanticStatus: async () => semanticStatus({ enabled: await isSemanticEnabled(), kbRoot }),
        importConfig: buildImportConfig,
        scope: { ttlDays: scopeTtlDays },
        trashRetentionDays,
        std: {
          configured: bzCookie !== "",
          baseUrl: bzBaseUrl,
          cookie: bzCookie,
          rateMs: stdRateMs,
          maxAgeDays: stdMaxAgeDays,
          importConfig: buildImportConfig(),
        },
      });
    } catch (error) {
      await logLoad(`web ui failed: ${error?.message ?? error}`);
    }
    await logLoad(
      `dsh-knowledge-wiki applied: kbRoot=${kbRoot}${kbRootError ? ` kbRootError=${kbRootError}` : ""} cpus=${LOGICAL_CPUS} memGB=${Math.round(TOTAL_MEM_GB)} ocrWorkers=${ocrWorkers} ocrDpi=${ocrDpi} ocrEngine=${ocrEngine} tessdata=${tessdataState} registrations=[${registered.join(",")}] tools=[kb_list,kb_import,kb_reparse,kb_query,kb_read,kb_view,kb_edit,kb_describe,kb_retitle,kb_lint,kb_trust,kb_keep,kb_edit_batch,kb_snapshot,kb_add_note,kb_remove,kb_restore,kb_history,kb_export,kb_rename,kb_std_check]`
    );
  } catch (error) {
    await logLoad(`dsh-knowledge-base apply FAILED: ${error?.message ?? error}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

/** doc 工具入口：有 doc 时跨库解析唯一目标；批量模式（无 doc）退化为单库策略。 */
async function resolveDocOrSingleKb(exec, args, config) {
  if (args.doc !== undefined) return resolveDocTarget(exec, args.kb, args.doc, config);
  return resolveSingleKb(exec, args.kb, config);
}

function registerKbList(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_list",
    description:
      "列出知识库（或某个知识库内的文档）：名称、文档数、状态（ready/importing/failed）、字符量、一行摘要与标签；文字层损坏/OCR 低置信会标注页数。指定 kb 时支持 limit/offset/query/status/kind 分页过滤（默认最多 50 条，用 offset 继续）；kind=note 只看笔记、kind=source 只看原始资料。导入、查询、精读前先用它确认知识库与文档 id；本库有 schema.md 时会提示。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时列出本会话范围内的知识库。" },
      limit: { type: "number", description: "最多返回多少文档（默认 50，上限 500）。" },
      offset: { type: "number", description: "跳过前 N 个文档，默认 0。" },
      query: { type: "string", description: "按标题子串过滤（不区分大小写）。" },
      status: { type: "string", description: "按状态过滤：ready / importing / failed / deleted（软删除）。" },
      kind: { type: "string", description: "按种类过滤：all（默认）/ note（笔记/编译页）/ source（原始资料）。" },
      trust: { type: "string", description: "按可信度过滤：high / medium / low / unknown。" },
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
          total: { type: "number" },
          totalAll: { type: "number" },
          offset: { type: "number" },
          limit: { type: "number" },
          hasMore: { type: "boolean" },
          schema: { type: "object", additionalProperties: true },
          scope: { type: "object", additionalProperties: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: renderKbList(value),
        },
      ],
    },
    async execute(args, exec) {
      const scope = await resolveExecScope(exec, { kbRoot, ttlDays: scopeTtlDays });
      assertScopeEnabled(scope);
      const scopeField = { mode: scope.mode, kbs: [...scope.kbs] };
      if (args.kb !== undefined) {
        const kb = sanitizeKbName(args.kb);
        assertInScope(scope, kb);
        const dir = kbDirPath(kbRoot, kb);
        const manifest = await readManifest(dir);
        const schema = await readSchema(dir);
        let docs = (manifest.docs ?? []).map((d) => docSize(dir, d));
        const totalAll = docs.length;

        const status = String(args.status ?? "").trim();
        if (status !== "") docs = docs.filter((d) => d.status === status);
        const query = String(args.query ?? "").trim().toLowerCase();
        if (query !== "") {
          docs = docs.filter((d) => String(d.title ?? "").toLowerCase().includes(query));
        }
        const kind = String(args.kind ?? "").trim().toLowerCase();
        if (kind === "note" || kind === "notes") docs = docs.filter((d) => d.type === "note");
        else if (kind === "source" || kind === "sources") docs = docs.filter((d) => d.type !== "note");
        const trust = String(args.trust ?? "").trim().toLowerCase();
        if (["high", "medium", "low", "unknown"].includes(trust)) {
          docs = docs.filter((d) => (d.trust ?? "unknown") === trust);
        }
        docs.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"));

        const total = docs.length;
        const limit = Math.max(1, Math.min(500, Math.round(Number(args.limit) || 50)));
        const offset = Math.max(0, Math.round(Number(args.offset) || 0));
        const page = docs.slice(offset, offset + limit);
        return {
          kb,
          kbs: [],
          docs: page,
          total,
          totalAll,
          offset,
          limit,
          hasMore: offset + page.length < total,
          schema: { exists: schema.exists, chars: schema.chars },
          scope: scopeField,
        };
      }
      const entries = await listKbs(kbRoot);
      const visible = scope.mode === "selected" ? entries.filter((kb) => scope.kbs.includes(kb.dir ?? kb.name)) : entries;
      return { kbs: visible, docs: [], scope: scopeField };
    },
  });
  ctx.tools.register(tool);
}

function renderKbList(value) {
  const kbs = value.kbs ?? [];
  const docs = value.docs ?? [];
  if (value.kb === undefined && kbs.length === 0) {
    const scoped = value.scope?.mode === "selected" ? (value.scope.kbs ?? []) : [];
    if (scoped.length > 0) {
      return `本会话范围（${scoped.join("、")}）内的知识库当前不可用（可能已归档、删除或 manifest 损坏）；请调整范围或检查该库。`;
    }
    return "（还没有任何知识库，用 kb_import 导入资料即可自动创建）";
  }
  if (kbs.length > 0) {
    return kbs
      .map(
        (k) =>
          `${k.name} — ${k.docs} 个文档（就绪 ${k.ready}${k.notes ? `，笔记 ${k.notes}` : ""}${k.importing ? `，导入中 ${k.importing}` : ""}${k.failed ? `，失败 ${k.failed}` : ""}${k.deleted ? `，已删除 ${k.deleted}` : ""}），共 ${k.chars} 字${k.hasSchema ? "，有维护规范" : ""}`
      )
      .join("\n");
  }
  const total = value.total ?? docs.length;
  const totalAll = value.totalAll ?? total;
  if (docs.length === 0) {
    if (totalAll === 0) return `知识库「${value.kb}」暂无文档（用 kb_import 导入资料）`;
    return `知识库「${value.kb}」没有匹配的文档（共 ${totalAll} 个；可调整 query/status/offset）。`;
  }
  const offset = value.offset ?? 0;
  const summary = total === totalAll ? `共 ${totalAll} 个文档` : `筛选后 ${total} / 共 ${totalAll} 个文档`;
  const schemaText = value.schema?.exists
    ? `｜维护规范 schema.md（${value.schema.chars} 字，kb_read doc="schema" 查看）`
    : `｜（本库还没有 schema.md）`;
  const footer = value.hasMore
    ? `\n\n还有 ${total - (offset + docs.length)} 个，可用 offset=${offset + docs.length} 继续；或用 query/status/kind 过滤。`
    : "";
  return (
    `知识库「${value.kb}」${summary}（显示 ${offset + 1}–${offset + docs.length}）${schemaText}\n` +
    docs
      .map((d) => {
        const label = d.type === "note" ? `笔记·${noteKindLabel(d.kind)}` : typeLabel(d.type);
        const short = String(d.summary ?? "").replace(/\s+/g, " ").trim();
        const summaryPart = short
          ? ` — ${short.length > 80 ? short.slice(0, 79) + "…" : short}`
          : " — （未编目，可用 kb_describe 补摘要）";
        const tags = Array.isArray(d.tags) && d.tags.length > 0 ? ` #${d.tags.slice(0, 6).join(" #")}` : "";
        const trustTag = d.trust && d.trust !== "unknown" ? ` [可信度:${trustLabel(d.trust)}]` : "";
        const keepTag = d.dedupKeep ? " [已核对保留]" : "";
        return `- ${d.id}  ${d.title}  [${label}]${trustTag}${keepTag} ${d.status}${d.deleted ? " [已删除]" : ""}${d.stale ? " [旧管线]" : ""}${d.edited ? " [已修订]" : ""}${d.corruptedCount ? ` [文字层损坏 ${d.corruptedCount}页]` : ""}${d.lowConfidenceCount ? ` [OCR低置信 ${d.lowConfidenceCount}页]` : ""}${d.historyCount ? ` [历史 ${d.historyCount}]` : ""}${d.error ? ` (${d.error})` : ""}  ${d.pages ? d.pages + "页 " : ""}${d.chars}字 ${d.parts}部分 v${d.version} 更新于 ${d.updatedAt}${summaryPart}${tags}`;
      })
      .join("\n") +
    footer
  );
}

/** 编辑后的正文指纹：与导入侧尽量同口径（去掉 H1，按 Markdown 段落重切）。 */
function textHashFromMerged(merged) {
  const body = String(merged ?? "").replace(/^#\s+.*\r?\n/, "");
  return textFingerprint(sectionsFromMarkdown(body));
}

/**
 * 单篇改标题：快照历史 → 重建合并版（H1 用新标题）→ 版本号+1。
 * 只改标题，不动正文内容；调用方负责写日志与刷新索引。
 */
async function applyRetitle(dir, docId, newTitle) {
  return withManifestLock(dir, async () => {
    const manifest = await readManifest(dir);
    const doc = manifest.docs.find((d) => d.id === docId);
    if (!doc) throw new Error(`文档不存在: ${docId}`);
    if (doc.status !== "ready") {
      throw new Error(`文档状态为 ${doc.status}，暂不能改名（请先重试导入/重解析）`);
    }
    const from = String(doc.title ?? "");
    if (from === newTitle) return { changed: false, from, to: newTitle, version: doc.version ?? 0 };
    let history = Array.isArray(doc.history) ? [...doc.history] : [];
    try {
      const snap = await snapshotDocVersion(dir, doc, "retitle");
      if (snap) history.push(snap);
    } catch {
      /* 历史快照失败不阻塞改名 */
    }
    history = await pruneHistory(dir, docId, history);
    doc.title = newTitle;
    await rebuildMerged(dir, doc);
    const meta = parseDocMeta(newTitle, newTitle);
    await touchDocLocked(dir, manifest, docId, {
      title: newTitle,
      history,
      rawTitle: doc.rawTitle || newTitle,
      titleSource: "auto",
      canonicalTitle: meta.canonicalTitle || newTitle,
      standardNo: meta.standardNo,
      standardPrefix: meta.standardPrefix,
      standardNumber: meta.standardNumber,
      standardBase: meta.standardBase,
      standardYear: meta.standardYear,
      standardPart: meta.standardPart,
      standardSource: meta.standardNo ? "filename" : "none",
      filenameStandardNo: meta.standardNo,
      stage: meta.standardNo ? meta.stage : "unknown",
      stageLabel: meta.standardNo ? meta.stageLabel : "",
    });
    return { changed: true, from, to: newTitle, version: doc.version ?? 0 };
  });
}

async function startImportJob(
  ctx,
  { kbRoot, kb, dir, files, jobConfig, exec, kind = "kb-import", label, verb = "导入", fileCount = files.length, dedup = null }
) {
  const jobs = ctx.get("jobs");
  if (!jobs) throw new Error("后台任务服务不可用，无法后台导入（请缩小文件规模或分批导入）");
  const reportFile = tempReportFile();
  const argsFile = await prepareImportArgs({ dir, kbRoot, kb, files, config: jobConfig, reportFile, dedup });
  const runner = createImportWorkerRunner({
    spawn: (spec) => ctx.subprocess.spawn(spec),
    dir,
    argsFile,
    reportFile,
    fileCount,
    kb,
    verb,
  });
  let jobId;
  try {
    jobId = jobs.start({
      kind,
      label: label ?? `${kind} ${kb}: ${files.length} 个文件`,
      ...(exec.agent ? { owner: exec.agent } : {}),
      run: runner.run,
    });
  } catch (error) {
    // 后台任务创建失败（如并发上限）时 worker 不会启动，清掉已写的 @file 参数再上抛。
    await rm(argsFile, { force: true }).catch(() => {});
    throw error;
  }
  return { jobId };
}

function registerKbImport(ctx, opts) {
  const { kbRoot, defaultKb, ocrLang, buildImportConfig, maxInlinePages, maxInlineBytes, importTimeoutMs, scopeTtlDays } = opts;
  const tool = defineTool({
    name: "kb_import",
    description:
      "把资料文件导入知识库（自动创建或更新指定名称的知识库）。支持 Word(.docx/.doc，旧版 .doc 自动转换：Windows 用本机 Word、macOS 用 textutil；OMML 公式转 LaTeX)、PPT(.pptx/.ppt，旧版 .ppt 自动转换：Windows 用本机 PowerPoint/LibreOffice)、Excel(.xlsx/.xlsm，按工作表转为 Markdown 表格；公式取缓存值/公式文本)、PDF（文字版直接提取文字层；扫描版/图片版自动逐页 OCR 中文；自动识别文字层损坏页并只对问题页 OCR，可用 forceOcrPages/skipOcrPages 精细控制）、EPUB 与 MOBI/AZW3 电子书（MOBI/AZW3 自动经 Calibre ebook-convert 转 EPUB，需本机安装 Calibre）、Markdown、纯文本(.txt，自动识别 UTF-8/UTF-16/GBK)。path 可以是文件或目录（目录递归导入全部支持的文件，同名文件重复导入=原位更新并版本号+1）。小文件立即完成；大文件（如整本扫描书）或旧版 .doc/.ppt / MOBI/AZW3（需本机 Office/Calibre 转换）自动转为后台任务并返回 jobId，用 job_output 查看进度；正在导入中的同名文档会被自动跳过。导入前自动查重（按标准号/标题与当前库及全部知识库比对）：同库重合的文件直接跳过，跨库重合的文件默认跳过并在结果中报告——确认需要时给 allowCrossDuplicates: true 重新导入。标题仅前缀相似（低置信）的文件会照常导入并在结果中提示人工确认，不会静默丢弃。",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "要导入的文件或目录的绝对路径（支持 ~ 开头的用户目录路径；相对路径按当前工作目录解析）。",
      },
      kb: {
        type: "string",
        description: "知识库名称（可含中文，不存在则创建）；省略时按本会话范围解析（单库直接用，多库时必须指定）。",
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
      forceOcrPages: {
        type: "string",
        description: "逗号分隔页码，只强制这些页走 OCR（如 \"12,48\"）。空白页仍会跳过。",
      },
      skipOcrPages: {
        type: "string",
        description: "逗号分隔页码，跳过这些页的自动/强制 OCR（如 \"1,2\"）。",
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
          skippedTempFiles: { type: "number" },
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
      const { scope, kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const dir = kbDirPath(kbRoot, kb);
      await mkdir(dir, { recursive: true });
      const inputPath = resolveInputPath(args.path, exec);
      // 临时/锁文件由 collectSources 跳过并回调计数；不因它们中断导入。
      let skippedTempFiles = 0;
      const sources = await collectSources(inputPath, {
        onSkip: () => {
          skippedTempFiles += 1;
        },
      });
      const skippedTemp = skippedTempFiles > 0 ? { skippedTempFiles } : {};
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
        ...buildImportConfig({ ocrModel: args.ocrModel }),
        ocrLang: args.ocrLang ?? ocrLang,
        forceOcr: args.forceOcr === true,
        forceOcrPages: parsePageList(args.forceOcrPages),
        skipOcrPages: parsePageList(args.skipOcrPages),
      };
      const files = sources.map((s) => ({
        sourcePath: s.path,
        relKey: s.relKey,
        title: args.title ?? basename(s.path, extname(s.path)),
        rawTitle: basename(s.path, extname(s.path)),
      }));

      // 导入前查重：同库重合直接跳过；跨库重合默认跳过并报告（allowCrossDuplicates: true 时照常导入）。
      // 查重基于标题（标准号/核心短语），在解析与 OCR 之前完成，避免重复计算。
      const dedup = await scanDuplicates({
        root: kbRoot,
        targetKb: kb,
        files,
        allowCrossKb: args.allowCrossDuplicates === true,
        kbNames: scope.mode === "selected" ? scope.kbs : null,
      });
      files.splice(0, files.length, ...dedup.kept);
      const duplicates = dedup.duplicates;
      const similar = dedup.similar ?? [];

      if (files.length === 0) {
        return { kb, inline: true, files: 0, imported: [], skipped: 0, duplicates, similar, ...skippedTemp };
      }

      if (inline) {
        const dedupIndex = await buildDedupIndexFromRoot({ root: kbRoot, targetKb: kb, kbNames: scope.mode === "selected" ? scope.kbs : null }).catch(() => null);
        const imported = [];
        for (const f of files) {
          const report = await importFileInto(dir, {
            ...f,
            config: jobConfig,
            ...(dedupIndex ? { dedupIndex, allowCrossKb: args.allowCrossDuplicates === true } : {}),
          });
          imported.push(report);
          if (dedupIndex && report?.docId && report.skipped !== true) {
            try {
              const manifest = await readManifest(dir);
              const doc = (manifest.docs ?? []).find((item) => item.id === report.docId);
              if (doc) addToDedupIndex(dedupIndex, doc, { kb, dir: kb });
            } catch {
              /* 同批后续去重失败不影响本次导入 */
            }
          }
        }
        await refreshKbIndex(dir);
        return {
          kb,
          inline: true,
          files: files.length,
          imported,
          skipped: imported.filter((r) => r.skipped === true).length,
          duplicates,
          similar,
          ...skippedTemp,
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
        dedup: { kbNames: scope.mode === "selected" ? scope.kbs : null, allowCrossKb: args.allowCrossDuplicates === true },
      });
      return {
        kb,
        inline: false,
        files: files.length,
        jobId,
        imported: [],
        duplicates,
        similar,
        ...skippedTemp,
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
  const tempNote =
    Number(value.skippedTempFiles) > 0 ? `已跳过 ${value.skippedTempFiles} 个临时/锁文件` : "";
  const withTempNote = (text) => (tempNote ? `${text}；${tempNote}` : text);
  if (value.inline) {
    const list = value.imported ?? [];
    if (list.length === 0 && (value.files ?? 0) === 0) {
      return withTempNote(
        `未导入任何文件到知识库「${value.kb}」：${dupText ? "全部与已有文档重合。" : ""}${extra ? "\n\n" + extra : ""}`
      );
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
    return withTempNote(`已导入 ${done} 个文件到知识库「${value.kb}」${skipNote}:\n${rows}${extra ? "\n\n" + extra : ""}`);
  }
  const hint = value.hint ?? `已提交后台导入任务 ${value.jobId}`;
  return withTempNote(extra ? `${hint}\n\n${extra}` : hint);
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
    kbRoot, defaultKb, buildImportConfig, maxInlinePages, maxInlineBytes, importTimeoutMs, scopeTtlDays,
  } = opts;
  const tool = defineTool({
    name: "kb_reparse",
    description:
      "从知识库内保存的 sources/ 重新解析文档（不需要重新上传），用于 OCR 引擎/解析器升级后刷新旧管线产物。doc 指定单个文档；all=true 时按 limit 批量。默认只对文字层损坏/低置信页重新 OCR，forceOcr 强制全部；forceOcrPages/skipOcrPages 可精细指定页；runInBackground 强制后台。会保留原 sourcePath/title，版本号+1。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时必须指定）。" },
      doc: { type: "string", description: "文档标题（子串，需唯一）或 id；与 all 二选一。" },
      all: { type: "boolean", description: "重解析该库全部 ready 文档（默认按 limit=20 分批）。" },
      limit: { type: "number", description: "all=true 时本轮最多处理多少文档（默认 20，上限 500）。" },
      forceOcr: { type: "boolean", description: "强制对 PDF 全部页面走 OCR（忽略文字层）。" },
      forceOcrPages: { type: "string", description: "逗号分隔页码，只强制这些页走 OCR（如 \"12,48\"）。" },
      skipOcrPages: { type: "string", description: "逗号分隔页码，跳过这些页的 OCR。" },
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
      const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
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
        ...buildImportConfig({ ocrModel: args.ocrModel }),
        forceOcr: args.forceOcr === true,
        forceOcrPages: parsePageList(args.forceOcrPages),
        skipOcrPages: parsePageList(args.skipOcrPages),
        forceReparse: true,
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
        await refreshKbIndex(dir);
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

/**
 * kb_query 的语义重排（Task 4）：匹配行 → 文档归组 → 文档级 RRF → 摊平回匹配行。
 * dense 独有文档补一条合成匹配；页码来自两阶段 FTS，找不到时不伪造 pageStart。
 * 关闭语义或任何一步失败时返回 applied=false，调用方保持原 matches。
 */
async function reorderMatchesSemantically({ matches, targets, query, semantic }) {
  if (!semantic?.enabled) return null;
  const terms = keywordsOfQuery(query).slice(0, 8);
  const primary = targets[0] ?? {};
  const groups = groupHitsByDoc(matches, { docs: primary.docs, kb: primary.kb ?? "" });
  const pseudo = groups.map((group) => finishResult(group, { terms }));
  const outcome = await applySemanticToResults({ results: pseudo, targets, query, terms, semantic });
  const note = [outcome.note, outcome.applied ? "" : (semantic.note ?? "")].filter(Boolean).join("；");
  if (!outcome.applied) return { applied: false, matches, note, reason: outcome.reason };
  const byDoc = new Map();
  for (const match of matches) {
    const key = `${match.kb ?? primary.kb ?? ""}\u0000${match.docId}`;
    if (!byDoc.has(key)) byDoc.set(key, []);
    byDoc.get(key).push(match);
  }
  const out = [];
  for (const result of outcome.results) {
    const key = `${result.kb ?? ""}\u0000${result.docId}`;
    const original = byDoc.get(key);
    if (original) {
      out.push(...original);
      continue;
    }
    const target = targets.find((entry) => (entry.kb ?? "") === (result.kb ?? ""));
    out.push({
      docId: result.docId,
      title: result.title,
      path: `markdown/${result.docId}/${result.docId}.md`,
      kb: target?.kb,
      lineNumber: 1,
      updatedAt: result.updatedAt,
      ...(Number.isInteger(result.page) && result.page > 0 ? { pageStart: result.page } : {}),
      ...(Number.isInteger(result.pageEnd) && result.pageEnd > 0 ? { pageEnd: result.pageEnd } : {}),
      ...(result.clause ? { clause: result.clause } : {}),
      ...(result.type ? { type: result.type } : {}),
      trust: result.trust,
      line: result.line || result.snippet || "",
    });
  }
  return { applied: true, matches: out, note, reason: "" };
}

function registerKbQuery(ctx, { kbRoot, defaultKb, queryMaxMatches, queryLineBytes, scopeTtlDays, semanticEnabled = null, getSemanticRuntime = null }) {
  const tool = defineTool({
    name: "kb_query",
    description:
      "在知识库中全文检索（纯文本优先 SQLite FTS5/BM25 条款索引，正则/索引不可用时回退 ripgrep；中文短语可直接用）。标准号查询会自动兼容常见写法（GB/T=GBT=GB_T=GB∕T、年份分隔符 -—–~～、全半角）；返回匹配行及所在文档/行号，笔记命中会标注类型。命中后用 kb_read 读取对应部分精读；可用 doc 参数限定在某一个文档内检索。",
    parameters: {
      pattern: {
        type: "string",
        required: true,
        description: "检索正则表达式（中文短语直接写即可）。",
      },
      kb: { type: "string", description: "知识库名称；省略时按本会话范围检索（单库直接用，多库时逐库检索）；传 \"*\" 检索范围内全部库。" },
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
          expandedPattern: { type: "string" },
          searchedKbs: { type: "array", items: { type: "string" } },
          scope: { type: "object", additionalProperties: true },
          total: { type: "number", required: true },
          truncated: { type: "boolean", required: true },
          lossy: { type: "boolean" },
          // 0.27：检索引擎与「索引构建中」标记（additive；工作台 /search 也复用同一字段）
          engine: { type: "string" },
          indexBuilding: { type: "boolean" },
          note: { type: "string" },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kb: { type: "string", required: true },
                docId: { type: "string", required: true },
                title: { type: "string", required: true },
                page: { type: "number" },
                pageEnd: { type: "number" },
                clause: { type: "string" },
                snippet: { type: "string", required: true },
                keywords: { type: "array", items: { type: "string" } },
                deepLink: { type: "string", required: true },
              },
            },
          },
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
                kb: { type: "string" },
                lineNumber: { type: "number", required: true },
                updatedAt: { type: "string" },
                part: { type: "number" },
                pageStart: { type: "number" },
                pageEnd: { type: "number" },
                type: { type: "string" },
                kind: { type: "string" },
                trust: { type: "string" },
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
      presentationMeta: (_args, value) => ({ sources: value.sources ?? [] }),
    },
    async execute(args, exec) {
      const pattern = String(args.pattern);
      const effectivePattern = expandStdQuery(pattern) ?? pattern;
      const expandedPattern = effectivePattern !== pattern ? effectivePattern : undefined;
      const maxMatches = Math.min(500, Math.max(1, Math.round(Number(args.maxMatches) || queryMaxMatches)));
      const scope = await resolveExecScope(exec, { kbRoot, ttlDays: scopeTtlDays });
      assertScopeEnabled(scope);
      const scopeField = { mode: scope.mode, kbs: [...scope.kbs] };
      const semanticOn = typeof semanticEnabled === "function" ? await semanticEnabled() : false;
      const semanticRuntime = semanticOn && typeof getSemanticRuntime === "function" ? getSemanticRuntime() : null;

      const star = args.kb === "*";
      const explicit = !star && typeof args.kb === "string" && args.kb.trim() !== "";
      // selected 且只选了一个库时，doc 检索直接落到该库，无需再要求 kb 参数
      const routeDoc = !star && args.doc !== undefined && scope.mode === "selected" && !explicit && scope.kbs.length === 1;
      const crossKb = star || (scope.mode === "selected" && !explicit && !routeDoc);
      if (crossKb && args.doc !== undefined) {
        throw new ScopeError("doc 只能用于单个知识库；跨库检索请去掉 doc 参数，或用 kb 指定一个库", "KB_REQUIRED");
      }
      if (crossKb) {
        const allStar = star && scope.mode !== "selected";
        const entries = allStar ? await listKbs(kbRoot) : [];
        const targets = allStar
          ? entries.map((kb) => ({ name: kb.name, dir: kb.dir ?? kb.name }))
          : scope.kbs.map((name) => ({ name, dir: name }));
        const searchedKbs = [];
        const combined = [];
        const semanticTargets = [];
        let total = 0;
        let lossy = false;
        for (const target of targets) {
          const dir = kbDirPath(kbRoot, target.dir);
          const manifest = await tryReadManifest(dir);
          if (!manifest) continue;
          const result = await searchKb(ctx, exec, dir, manifest, {
            pattern: effectivePattern,
            ftsPattern: pattern,
            backgroundIndex: true,
            maxMatches: Math.max(20, Math.min(200, maxMatches * 2)),
            lineBytes: queryLineBytes,
          });
          total += result.total;
          lossy = lossy || result.lossy === true;
          searchedKbs.push(target.name);
          semanticTargets.push({ kb: target.name, dir, docs: manifest.docs ?? [] });
          for (const match of result.matches) combined.push({ ...match, kb: target.name });
        }
        const ranked = rankMatches(combined, { pattern: effectivePattern, maxMatches, perDocMax: 5 });
        const semantic = semanticOn && semanticRuntime && semanticTargets.length > 0
          ? createSemanticChannel({ runtime: semanticRuntime, targets: semanticTargets })
          : null;
        const reranked = semantic
          ? await reorderMatchesSemantically({ matches: ranked, targets: semanticTargets, query: pattern, semantic })
          : null;
        const finalMatches = reranked?.applied ? reranked.matches : ranked;
        const note = [
          lossy ? "部分知识库结果超出缓冲上限，已保留缓冲区内的匹配" : "",
          reranked?.note ?? "",
        ].filter(Boolean).join("；");
        return {
          kb: "*",
          pattern,
          ...(expandedPattern ? { expandedPattern } : {}),
          total,
          truncated: total > finalMatches.length || lossy,
          lossy,
          matches: finalMatches,
          ...(reranked?.applied ? { engine: "hybrid" } : {}),
          sources: sourcesFromMatches(finalMatches, "*", { query: pattern }),
          searchedKbs,
          scope: scopeField,
          ...(note ? { note } : {}),
        };
      }

      const kb = routeDoc ? scope.kbs[0] : sanitizeKbName(args.kb ?? defaultKb);
      assertInScope(scope, kb);
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      let docDir;
      if (args.doc !== undefined) {
        const doc = resolveDoc(manifest, args.doc);
        docDir = join(dir, "markdown", doc.id);
      }
      const result = await searchKb(ctx, exec, dir, manifest, {
        pattern: effectivePattern,
        ftsPattern: pattern,
        backgroundIndex: true,
        docDir,
        maxMatches,
        lineBytes: queryLineBytes,
      });
      // 单文档检索（doc=...）不做语义重排：排序只影响文档间顺序，单文档内没有收益。
      const semantic = !docDir && semanticOn && semanticRuntime
        ? createSemanticChannel({ runtime: semanticRuntime, targets: [{ kb, dir, docs: manifest.docs ?? [] }] })
        : null;
      const reranked = semantic
        ? await reorderMatchesSemantically({
            matches: result.matches,
            targets: [{ kb, dir, docs: manifest.docs ?? [] }],
            query: pattern,
            semantic,
          })
        : null;
      const finalMatches = reranked?.applied ? reranked.matches : result.matches;
      const note = [result.note, reranked?.note ?? ""].filter(Boolean).join("；");
      return {
        kb,
        ...result,
        ...(reranked?.applied ? { matches: finalMatches, engine: "hybrid" } : {}),
        ...(note ? { note } : {}),
        sources: sourcesFromMatches(finalMatches, kb, { query: pattern }),
        pattern,
        ...(expandedPattern ? { expandedPattern } : {}),
        scope: scopeField,
      };
    },
  });
  ctx.tools.register(tool);
}

function renderKbQuery(value) {
  const scope = value.kb === "*" ? `在 ${value.searchedKbs?.length ?? 0} 个知识库中` : `知识库「${value.kb}」`;
  if (value.total === 0) {
    if (value.note) {
      return `${scope}检索结果超出缓冲上限，未能保留匹配：${value.note}`;
    }
    return `${scope}没有匹配 "${value.pattern}" 的内容（可换关键词或宽泛表达再试）。`;
  }
  const grouped = [];
  let currentDoc = null;
  for (const m of value.matches) {
    const groupKey = m.kb ? `${m.kb}\u0000${m.docId}` : m.docId;
    if (currentDoc !== groupKey) {
      currentDoc = groupKey;
      const kbLabel = m.kb ? `${m.kb}，` : "";
      const kindLabel = m.type === "note" ? `  [笔记·${noteKindLabel(m.kind)}]` : "";
      const trustTag = m.trust && m.trust !== "unknown" ? `  [可信度:${trustLabel(m.trust)}]` : "";
      grouped.push(`### ${m.title}（${kbLabel}${m.docId}，${m.path}）${kindLabel}${trustTag}`);
    }
    const loc = m.part
      ? `（部分 ${m.part}${m.pageStart ? `，第 ${m.pageStart}${m.pageEnd && m.pageEnd !== m.pageStart ? `–${m.pageEnd}` : ""} 页` : ""}）`
      : "";
    grouped.push(`行 ${m.lineNumber}${loc}: ${m.line}`);
  }
  // --max-count 会限制每文件命中数，total 可能小于真实总数；截断时用“至少”避免误导。
  const head =
    (value.truncated
      ? `${scope}找到至少 ${value.total} 处匹配（仅显示前 ${value.matches.length} 处，请收窄检索词）:\n`
      : `${scope}找到 ${value.total} 处匹配:\n`) +
    (value.expandedPattern ? "（标准号已按 GB/T=GBT、-—–~～ 等变体扩展检索）\n" : "") +
    (value.note ? `${value.note}\n` : "");
  const lowTrust = (value.matches ?? []).some((m) => m.trust === "low");
  const trustNote = lowTrust
    ? "\n⚠ 命中中包含「低可信度」文件（草案/已废止等）；引用时请注明，并与高可信版本交叉核对。"
    : "";
  const sources = value.sources ?? [];
  const sourceLines = sources.slice(0, 5).map((source) =>
    `来源：${source.kb ? `${source.kb} / ` : ""}${source.title}${source.clause ? ` / 第 ${source.clause} 条` : ""}${source.page ? ` / 第 ${source.page} 页` : ""}`
  );
  const foot = `${trustNote}${sourceLines.length > 0 ? `\n${sourceLines.join("\n")}` : ""}\n---\n用 kb_read 读取上下文：doc 参数填文档 id（如 ${value.matches[0]?.docId ?? "<docId>"}）或标题。`;
  return head + grouped.join("\n") + foot;
}

function registerKbRead(ctx, { kbRoot, defaultKb, readMaxChars, partMaxChars, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_read",
    description:
      "读取知识库中文档的指定部分（精读）。doc 可用文档标题（子串）或 id。part 为分块序号（从 1 开始）；part=outline 返回文档大纲（目录）；part=all 返回整篇合并版（大文档会被截断）。返回内容超出上限时提示截断位置，请按 part 逐块读取。PDF 会返回页码范围、OCR 平均置信度，并提示文字层损坏/低置信页（建议 kb_view 核对）。keywords 填从用户问题提炼的检索关键词，用于原件预览高亮；不要填条款号。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时跨库解析，命中多个需指定）。" },
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
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "从用户问题提炼的检索关键词（2–6 个），用于原件预览高亮；不要填条款号。",
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
          ocrConfidence: { type: "number" },
          lowConfidencePages: { type: "array", items: { type: "number" } },
          corruptedPages: { type: "array", items: { type: "number" } },
          pageWarnings: { type: "array", items: { type: "object", additionalProperties: true } },
          text: { type: "string", required: true },
          outline: { type: "array", items: { type: "object", additionalProperties: true } },
          virtual: { type: "boolean" },
          summary: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          kind: { type: "string" },
          trust: { type: "string" },
          trustReason: { type: "string" },
          dedupKeep: { type: "boolean" },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kb: { type: "string", required: true },
                docId: { type: "string", required: true },
                title: { type: "string", required: true },
                page: { type: "number" },
                pageEnd: { type: "number" },
                clause: { type: "string" },
                snippet: { type: "string", required: true },
                keywords: { type: "array", items: { type: "string" } },
                deepLink: { type: "string", required: true },
              },
            },
          },
          noteSources: { type: "array", items: { type: "object", additionalProperties: true } },
          backlinks: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: renderKbRead(value),
        },
      ],
      presentationMeta: (_args, value) => ({ sources: value.sources ?? [] }),
    },
    async execute(args, exec) {
      const target = await resolveDocTarget(exec, args.kb, args.doc, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const kb = target.kb;
      const dir = kbDirPath(kbRoot, kb);
      const cap = Math.min(200000, Math.max(500, Math.round(Number(args.maxChars) || readMaxChars)));
      const rawKeywords = Array.isArray(args.keywords) ? args.keywords : typeof args.keywords === "string" ? args.keywords.split(/[\s,，;；|]+/) : [];
      const keywords = [...new Set(rawKeywords.map((word) => String(word).trim().slice(0, 40)).filter((word) => word.length >= 2))].slice(0, 8);
      let part = String(args.part ?? "1").trim();
      let truncated = false;

      // 虚拟文档：schema / index / log（由插件维护，不占用清单条目）
      const virtualKind = VIRTUAL_DOCS.get(String(args.doc ?? "").trim().toLowerCase());
      if (virtualKind) {
        const manifest = await readManifest(dir);
        const { title, text: full } = await readVirtualDoc(dir, virtualKind, manifest);
        const parts = splitVirtualParts(full, partMaxChars);
        let text;
        let outline = [];
        if (part === "outline") {
          outline = full
            .split("\n")
            .filter((line) => /^#{1,3}\s+\S/.test(line))
            .map((line) => ({
              title: line.replace(/^#{1,3}\s+/, "").trim(),
              level: (line.match(/^#+/) ?? ["#"])[0].length,
              page: null,
              part: null,
            }));
          text = outline.length
            ? outline
                .map((item, i) => `${i + 1}. ${"  ".repeat(Math.max(0, item.level - 1))}${item.title}`)
                .join("\n")
            : "（没有小标题）";
          part = "outline";
        } else if (part === "all") {
          text = full;
          if (text.length > cap) {
            text = text.slice(0, cap) + "\n\n…（已截断，请用 part 参数逐块读取）";
            truncated = true;
          }
        } else {
          const index = Math.max(0, Math.round(Number(part)) - 1);
          if (!Number.isFinite(Number(part)) || index < 0 || index >= parts.length) {
            throw new Error(`part 取值无效（1..${parts.length} 或 outline/all）`);
          }
          text = parts[index];
          part = String(index + 1);
        }
        return {
          kb,
          docId: virtualKind,
          title,
          type: "虚拟页",
          part,
          partCount: parts.length,
          chars: text.length,
          truncated,
          text,
          outline,
          sources: [],
          virtual: true,
        };
      }

      const manifest = await readManifest(dir);
      const doc = target.doc ?? resolveDoc(manifest, args.doc);
      const outline = doc.outline ?? [];
      let text;
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
      let pageWarnings = [];
      if (pageStart !== null) {
        const quality = await readPageQuality(dir, doc);
        pageWarnings = quality.filter(
          (item) =>
            item.page >= pageStart &&
            item.page <= (pageEnd ?? pageStart) &&
            (item.corrupted === true ||
              (Number.isFinite(item.confidence) && item.confidence < 65))
        );
      }
      // 编译层：笔记的依据来源 + 谁引用了这篇文档。sources 让给结构化引用，
      // 笔记自身的依据放在 noteSources（保持旧字段可读）。
      const noteSources = (Array.isArray(doc.sources) ? doc.sources : []).map((ref) => {
        const [idPart, pagePart] = String(ref).split("#");
        const page = pagePart ? Number(String(pagePart).replace(/^p/i, "")) : null;
        const target = (manifest.docs ?? []).find((item) => item.id === idPart);
        return {
          ref: String(ref),
          docId: idPart,
          title: target?.title ?? idPart,
          ...(Number.isInteger(page) && page > 0 ? { page } : {}),
        };
      });
      const clauseMatch = String(text ?? "").match(/^\s*#{0,6}\s*(\d+(?:\.\d+){1,5})(?:\s+|$)/m);
      const citationPage = clauseMatch ? pageOfClause(text, clauseMatch[1]) ?? pageStart : pageStart;
      const citationSources = part === "outline"
        ? []
        : [{
            kb,
            docId: doc.id,
            title: doc.title,
            ...(Number.isInteger(citationPage) ? { page: citationPage } : {}),
            ...(pageEnd !== null && citationPage !== pageEnd ? { pageEnd } : {}),
            ...(clauseMatch ? { clause: clauseMatch[1] } : {}),
            ...(keywords.length > 0 ? { keywords } : {}),
            snippet: snippetOf(text, 160),
            deepLink: deepLinkFor({ kb, docId: doc.id, page: citationPage, clause: clauseMatch?.[1] ?? "" }),
          }];
      const backlinks = backlinksFor(manifest, doc.id);
      return {
        kb,
        docId: doc.id,
        title: doc.title,
        type: typeLabel(doc.type),
        pages: doc.pages,
        part,
        partCount: doc.parts ?? 1,
        ...(pageStart !== null
          ? { pageStart, ...(pageEnd !== null ? { pageEnd } : {}) }
          : {}),
        ...(Number.isFinite(doc.ocrConfidence) ? { ocrConfidence: doc.ocrConfidence } : {}),
        lowConfidencePages: Array.isArray(doc.lowConfidencePages) ? doc.lowConfidencePages : [],
        corruptedPages: Array.isArray(doc.corruptedPages) ? doc.corruptedPages : [],
        pageWarnings,
        chars: text.length,
        truncated,
        text,
        outline,
        ...(doc.summary ? { summary: doc.summary } : {}),
        ...(Array.isArray(doc.tags) && doc.tags.length > 0 ? { tags: doc.tags } : {}),
        ...(doc.kind ? { kind: doc.kind } : {}),
        ...(doc.trust ? { trust: doc.trust } : {}),
        ...(doc.trustReason ? { trustReason: doc.trustReason } : {}),
        ...(doc.dedupKeep ? { dedupKeep: true } : {}),
        sources: citationSources,
        ...(noteSources.length > 0 ? { noteSources } : {}),
        ...(backlinks.length > 0 ? { backlinks } : {}),
      };
    },
  });
  ctx.tools.register(tool);
}

function renderKbRead(value) {
  const pageText = value.pageStart
    ? `，第 ${value.pageStart}${value.pageEnd && value.pageEnd !== value.pageStart ? `–${value.pageEnd}` : ""} 页`
    : "";
  const confidence = Number.isFinite(value.ocrConfidence)
    ? `，OCR 平均置信度 ${value.ocrConfidence}%`
    : "";
  const trustText = value.trust && value.trust !== "unknown" ? `，可信度:${trustLabel(value.trust)}` : "";
  const keepText = value.dedupKeep ? "，已核对保留" : "";
  const meta = `【${value.title}】（${value.docId}，${value.type}${value.pages ? `，${value.pages} 页` : ""}，共 ${value.partCount} 部分${pageText}${confidence}${trustText}${keepText}）\n`;
  const pagedPart = value.part !== "all" && value.part !== "outline" && value.pageStart !== null;
  const warningPages = pagedPart
    ? (value.pageWarnings ?? []).map((item) => item.page)
    : [...new Set([...(value.corruptedPages ?? []), ...(value.lowConfidencePages ?? [])])];
  const warn = warningPages.length
    ? `\n⚠ 文字层损坏/OCR 低置信：第 ${warningPages.slice(0, 10).join("、")}${warningPages.length > 10 ? ` 等 ${warningPages.length} 页` : ""} 页；建议 kb_view 核对。\n`
    : "";
  const noteSources = value.noteSources ?? [];
  const backlinks = value.backlinks ?? [];
  const relation = [
    noteSources.length > 0
      ? `依据来源：${noteSources.map((s) => `${s.title}${s.page ? `（第 ${s.page} 页）` : ""}`).join("；")}`
      : "",
    backlinks.length > 0
      ? `被引用：${backlinks.map((b) => `${b.title}（${noteKindLabel(b.kind)}）`).join("；")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const nav = value.part !== "all" && value.part !== "outline"
    ? `\n---\n继续读取: kb_read(doc="${value.docId}", part=<序号>)；检索相关片段: kb_query`
    : "";
  return meta + value.text + warn + (relation ? `\n---\n${relation}\n` : "") + nav;
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

function registerKbView(ctx, { kbRoot, defaultKb, ebookConvertBin, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_view",
    description:
      "查看知识库文档的原始页面图片：PDF 按页渲染（page=页码，count=连续页数）；Word/PPT/EPUB/MOBI 提取内嵌图片（image=图片序号）。用于阅读公式、原理图、电路图、图表等 OCR 文本无法可靠呈现的视觉内容；先不带 image 参数调用可获知内嵌图片总数。返回图片内容块供模型直接查看。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时跨库解析，命中多个需指定）。" },
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
    async execute(args, exec) {
      const target = await resolveDocTarget(exec, args.kb, args.doc, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const kb = target.kb;
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      const doc = target.doc ?? resolveDoc(manifest, args.doc);
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

function registerKbEdit(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_edit",
    description:
      "精确修订知识库文档内容：在文档所有分块中查找 old_string 的精确出现，恰好出现一次时替换为 new_string（replaceAll=true 则全部替换），并重建合并版、版本号+1。用于持续修改完善知识。传 doc=\"schema\" 可修订该库的维护规范（不涉及文档与版本号）。index.md / log.md 由插件自动维护，不能编辑。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时跨库解析，命中多个需指定）。" },
      doc: {
        type: "string",
        required: true,
        description: "文档标题（子串，需唯一）或文档 id；传 \"schema\" 修订维护规范。",
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
          text:
            value.docId === "schema"
              ? `已修订「维护规范」: 替换 ${value.replaced} 处，schema.md 已更新。`
              : `已修订「${value.title}」（${value.docId}）: 替换 ${value.replaced} 处，涉及部分 ${value.changedParts.join(", ")}，合并版已重建，版本号+1。`,
        },
      ],
    },
    async execute(args, exec) {
      const target = await resolveDocTarget(exec, args.kb, args.doc, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const kb = target.kb;
      const dir = kbDirPath(kbRoot, kb);
      const oldString = String(args.old_string);
      if (oldString.length === 0) throw new Error("old_string 不能为空");
      const newString = String(args.new_string);

      // 虚拟文档：只允许修订 schema.md（index/log 是自动产物）
      const virtualKind = VIRTUAL_DOCS.get(String(args.doc ?? "").trim().toLowerCase());
      if (virtualKind) {
        if (virtualKind !== "schema") {
          throw new Error(
            `「${VIRTUAL_TITLES[virtualKind]}」（${virtualKind}.md）由插件自动维护：index 随清单生成、log 只追加，不能 kb_edit`
          );
        }
        const { text } = await readSchema(dir);
        const base = text || schemaTemplate(kb);
        let total = 0;
        let idx = base.indexOf(oldString);
        while (idx !== -1) {
          total += 1;
          idx = base.indexOf(oldString, idx + oldString.length);
        }
        if (total === 0) {
          throw new Error(`schema.md 中找不到 "${oldString.slice(0, 80)}"（可先 kb_read doc="schema" 查看）`);
        }
        if (total > 1 && args.replaceAll !== true) {
          throw new Error(`old_string 在 schema.md 中出现 ${total} 处；请扩大 old_string 使其唯一，或设置 replaceAll=true`);
        }
        const next =
          args.replaceAll === true
            ? base.split(oldString).join(newString)
            : base.replace(oldString, () => newString);
        await writeSchema(dir, next);
        await appendLog(dir, {
          action: "schema",
          title: "维护规范",
          docId: "schema",
          detail: `替换 ${total} 处`,
        });
        await refreshKbIndex(dir);
        return { kb, docId: "schema", title: "维护规范", replaced: total, changedParts: [] };
      }

      // 读-改-写全程持清单锁：并发 kb_edit / 同文档导入不会互相覆盖分块
      return withManifestLock(dir, async () => {
        const manifest = await readManifest(dir);
        const doc = target.doc ?? resolveDoc(manifest, args.doc);
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
        let historyEntry = null;
        try {
          historyEntry = await snapshotDocVersion(dir, doc, "edit");
        } catch {
          /* 历史快照失败不阻塞修订 */
        }
        const changedParts = [];
        for (const c of contents) {
          if (c.count === 0) continue;
          await writeFile(join(partsDir, c.file), c.text.split(oldString).join(newString), "utf8");
          changedParts.push(Number(c.file.slice(0, 4)));
        }
        const merged = await rebuildMerged(dir, doc);
        const chars = merged.length;
        const patch = {
          chars,
          parts: partFiles.length,
          edited: true,
          textHash: textHashFromMerged(merged),
          textHashAlgo: "sha256-norm-v1",
        };
        if (historyEntry) {
          patch.history = await pruneHistory(dir, doc.id, [
            ...(Array.isArray(doc.history) ? doc.history : []),
            historyEntry,
          ]);
        }
        await touchDocLocked(dir, manifest, doc.id, patch);
        await appendLog(dir, {
          action: "edit",
          title: doc.title,
          docId: doc.id,
          version: (doc.version ?? 0) + 1,
          detail: `替换 ${total} 处`,
        });
        await refreshKbIndex(dir);
        return { kb, docId: doc.id, title: doc.title, replaced: total, changedParts };
      });
    },
  });
  ctx.tools.register(tool);
}

function registerKbEditBatch(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_edit_batch",
    description:
      "批量精确修订（事务语义）：一次提交多条 {doc, old_string, new_string, replaceAll?}，先全部校验再写入；任一条校验或写入失败，整批不改并回滚已写入的分块。同一文档一次只允许一条编辑。dryRun=true 只校验并报告。适合“一次改 10–15 页”的跨文档维护。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（仅单库事务，多库时必须指定）。" },
      edits: {
        type: "array",
        required: true,
        items: { type: "object", additionalProperties: true },
        description: "编辑列表（1–50 条）：{doc: 标题或 id, old_string, new_string, replaceAll?}",
      },
      dryRun: { type: "boolean", description: "只校验并返回将替换的处数，不写入。" },
    },
    timeoutMs: 300000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          dryRun: { type: "boolean", required: true },
          total: { type: "number", required: true },
          applied: { type: "number", required: true },
          results: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderKbEditBatch(value) }],
    },
    async execute(args, exec) {
      const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const dir = kbDirPath(kbRoot, kb);
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (edits.length === 0) throw new Error("edits 不能为空");
      if (edits.length > 50) throw new Error("一次最多 50 条编辑，请分批");
      const dryRun = args.dryRun === true;

      const outcome = await withManifestLock(dir, async () => {
        const manifest = await readManifest(dir);
        const seen = new Set();
        const plans = [];
        for (const [index, edit] of edits.entries()) {
          const doc = resolveDoc(manifest, edit?.doc);
          if (seen.has(doc.id)) {
            throw new Error(`第 ${index + 1} 条：同一文档「${doc.title}」在一批里只能出现一次`);
          }
          seen.add(doc.id);
          if (doc.status !== "ready") {
            throw new Error(`第 ${index + 1} 条：文档「${doc.title}」状态为 ${doc.status}，暂不能修订`);
          }
          const oldString = String(edit?.old_string ?? "");
          if (oldString.length === 0) throw new Error(`第 ${index + 1} 条：old_string 不能为空`);
          const newString = String(edit?.new_string ?? "");
          const partsDir = join(dir, "markdown", doc.id, "parts");
          let partFiles;
          try {
            partFiles = (await readdir(partsDir)).filter((f) => /^\d{4}\.md$/.test(f)).sort();
          } catch {
            throw new Error(`第 ${index + 1} 条：文档「${doc.title}」没有可修订的分块`);
          }
          const files = [];
          let total = 0;
          for (const file of partFiles) {
            const text = await readFile(join(partsDir, file), "utf8");
            let count = 0;
            let at = text.indexOf(oldString);
            while (at !== -1) {
              count += 1;
              at = text.indexOf(oldString, at + oldString.length);
            }
            files.push({ file, text, count });
            total += count;
          }
          if (total === 0) {
            throw new Error(`第 ${index + 1} 条：文档「${doc.title}」中找不到 "${oldString.slice(0, 60)}"`);
          }
          if (total > 1 && edit?.replaceAll !== true) {
            throw new Error(
              `第 ${index + 1} 条：old_string 在「${doc.title}」中出现 ${total} 处；请扩大 old_string 或设置 replaceAll=true`
            );
          }
          plans.push({ doc, files, total, oldString, newString, replaceAll: edit?.replaceAll === true });
        }

        const results = plans.map((p) => ({
          docId: p.doc.id,
          title: p.doc.title,
          replaced: p.total,
          changedParts: p.files.filter((f) => f.count > 0).map((f) => Number(f.file.slice(0, 4))),
          version: p.doc.version ?? 0,
        }));
        if (dryRun) return { dryRun: true, applied: 0, results, logs: [] };

        const written = [];
        const logs = [];
        try {
          for (const plan of plans) {
            let history = Array.isArray(plan.doc.history) ? [...plan.doc.history] : [];
            try {
              const snap = await snapshotDocVersion(dir, plan.doc, "edit-batch");
              if (snap) history.push(snap);
            } catch {
              /* 快照失败不阻塞 */
            }
            history = await pruneHistory(dir, plan.doc.id, history);
            const partsDir = join(dir, "markdown", plan.doc.id, "parts");
            for (const file of plan.files) {
              if (file.count === 0) continue;
              await writeFile(join(partsDir, file.file), file.text.split(plan.oldString).join(plan.newString), "utf8");
            }
            written.push(plan);
            const merged = await rebuildMerged(dir, plan.doc);
            plan.history = history;
            plan.chars = merged.length;
            plan.parts = plan.files.length;
            plan.textHash = textHashFromMerged(merged);
            logs.push({
              docId: plan.doc.id,
              title: plan.doc.title,
              replaced: plan.total,
              changedParts: plan.files.filter((f) => f.count > 0).map((f) => Number(f.file.slice(0, 4))),
            });
          }
          // 所有正文写成功后再一次性更新清单（版本号+1）
          const versions = await touchDocsLocked(
            dir,
            manifest,
            plans.map((p) => ({
              docId: p.doc.id,
              patch: {
                chars: p.chars,
                parts: p.parts,
                edited: true,
                history: p.history,
                textHash: p.textHash,
                textHashAlgo: "sha256-norm-v1",
              },
            }))
          );
          for (const result of results) result.version = versions.get(result.docId);
          return { dryRun: false, applied: plans.length, results, logs };
        } catch (error) {
          // 回滚已写入的分块（清单尚未更新，版本号不会前进）
          for (const plan of written) {
            const partsDir = join(dir, "markdown", plan.doc.id, "parts");
            for (const file of plan.files) {
              if (file.count === 0) continue;
              await writeFile(join(partsDir, file.file), file.text, "utf8").catch(() => {});
            }
            await rebuildMerged(dir, plan.doc).catch(() => {});
          }
          throw new Error(`批量修订失败，已回滚（${error?.message ?? error}）`);
        }
      });

      for (const log of outcome.logs) {
        await appendLog(dir, {
          action: "edit-batch",
          title: log.title,
          docId: log.docId,
          detail: `替换 ${log.replaced} 处`,
        });
      }
      if (outcome.applied > 0) await refreshKbIndex(dir);
      return { kb, ...outcome };
    },
  });
  ctx.tools.register(tool);
}

function renderKbEditBatch(value) {
  const head = `批量修订${value.dryRun ? "（仅校验）" : ""}：${value.applied}/${value.total} 篇已写入。`;
  const lines = [head];
  for (const r of (value.results ?? []).slice(0, 30)) {
    lines.push(`- ${r.docId}  ${r.title}  替换 ${r.replaced} 处（部分 ${r.changedParts.join(", ") || "-"}）v${r.version}`);
  }
  if ((value.results ?? []).length > 30) lines.push(`- …还有 ${value.results.length - 30} 篇`);
  if (value.dryRun) lines.push("校验通过；传 dryRun=false 执行（全部成功才写清单，失败会回滚分块）。");
  return lines.join("\n");
}

/** 从合并版 markdown 抽取第一段可读正文，作为存量文档的兜底摘要。 */
/** 从合并版 markdown 抽取第一段可读正文；无可靠文字层时给出可解释的兜底说明。 */
function autoSummaryFromMarkdown(text, title = "") {
  const raw = String(text ?? "");
  const lines = raw.split("\n");
  const paragraphs = [];
  const tableRows = [];
  let current = [];
  let sheet = "";
  let placeholder = false;
  let tableMarkup = /<table/i.test(raw);
  const flush = () => {
    if (current.length > 0) paragraphs.push(current.join(" ").trim());
    current = [];
  };
  const BAD = /(https?:\/\/|www\.|下载|会员|制作|影印|无法自动识别|本页无文字内容|扫码|公众号|微信|QQ群|={2,}|_{3,})/i;
  for (const line0 of lines) {
    const line = line0.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("<!-- doc:")) continue;
    if (/影印|无法自动识别|本页无文字内容/.test(line)) {
      placeholder = true;
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      const sheetHit = /工作表[:：]\s*(.+)$/.exec(line);
      if (sheetHit) sheet = sheetHit[1].trim();
      flush();
      continue;
    }
    if (/^\|/.test(line)) {
      if (tableRows.length < 5 && !/^\|[\s\-:|]+\|$/.test(line)) tableRows.push(line);
      flush();
      continue;
    }
    if (/^!\[/.test(line)) {
      tableMarkup = true;
      continue;
    }
    current.push(line);
  }
  flush();
  for (const paragraph of paragraphs) {
    const clean = paragraph
      .replace(/^[>\-*+\d.、\s]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (BAD.test(clean)) continue;
    if (clean.length < 20) continue;
    if (/^附\s*录/.test(clean) && clean.length < 80) continue;
    if (/^(目\s*次|前\s*言)/.test(clean) && clean.length < 90) continue;
    const letters = (clean.match(/[\u4e00-\u9fa5A-Za-z]/g) ?? []).length;
    if (letters / clean.length < 0.35) continue;
    const digits = (clean.match(/\d/g) ?? []).length;
    if (digits / clean.length > 0.3) continue;
    if (/^(ICS|中华人民共和国国家标准)/.test(clean) && clean.length < 90) continue;
    return clean.slice(0, 160);
  }
  for (const row of tableRows) {
    const content = row
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(" / ");
    if (BAD.test(content)) continue;
    const letters = (content.match(/[\u4e00-\u9fa5A-Za-z]/g) ?? []).length;
    if (content.length >= 6 && letters / content.length >= 0.3) {
      return `${sheet ? `表格「${sheet}」：` : "表格："}${content}`.slice(0, 160);
    }
  }
  const cjk = (raw.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const domainHits = (raw.match(/www\.|https?:\/\//g) ?? []).length;
  if (placeholder || (raw.length > 200 && (cjk / raw.length < 0.05 || domainHits >= 5))) {
    return `《${title}》——扫描/影印资料，正文无可靠文字层，建议用 kb_view 查看原始页面`.slice(0, 160);
  }
  if (tableMarkup || raw.includes("<table")) {
    return `表格资料《${title}》——正文以表格为主，建议用 kb_read 查看`.slice(0, 160);
  }
  return "";
}

function registerKbDescribe(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_describe",
    description:
      "给知识库文档写一行摘要与标签（编目）：摘要会出现在 kb_list 与 index.md；模型写的摘要不会被重新导入/重解析覆盖。传 clear=true 清空。存量文档可用 all=true + auto=true 从已解析正文批量回填缺失摘要（抽取式，不调用模型，不递增版本号；可配 limit 分批）。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时跨库解析，命中多个需指定）。" },
      doc: {
        type: "string",
        description: "文档标题（子串，需唯一）或文档 id；批量回填时省略。",
      },
      summary: {
        type: "string",
        description: "一行摘要（建议 40–160 字，最长 500 字）。",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "标签（可选，最多 20 个）。",
      },
      clear: {
        type: "boolean",
        description: "清空该文档的摘要与标签。",
      },
      all: {
        type: "boolean",
        description: "批量回填所有没有摘要的 ready 文档（需同时传 auto=true）。",
      },
      auto: {
        type: "boolean",
        description: "批量模式：从合并版正文抽取第一段作为摘要（summarySource=auto）。",
      },
      limit: {
        type: "number",
        description: "批量模式本轮最多处理多少篇（默认 200，上限 5000）。",
      },
    },
    timeoutMs: 300000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          mode: { type: "string" },
          docId: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          changed: { type: "boolean" },
          total: { type: "number" },
          updated: { type: "number" },
          remaining: { type: "number" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            value.mode === "auto"
              ? `已从正文回填 ${value.updated} 篇摘要（本轮候选 ${value.total}，剩余 ${value.remaining}）；index.md 已刷新。剩余较多时可调大 limit 或再次调用。`
              : `已编目「${value.title}」（${value.docId}）: ` +
                (value.summary ? `摘要「${value.summary}」` : "摘要已清空") +
                (value.tags?.length ? `；标签 ${value.tags.join("、")}` : "") +
                "。index.md 与 kb_list 会显示这些信息。",
        },
      ],
    },
    async execute(args, exec) {
      const target = await resolveDocOrSingleKb(exec, args, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const kb = target.kb;
      const dir = kbDirPath(kbRoot, kb);
      const all = args.all === true;
      const hasSummary = args.summary !== undefined;
      const hasTags = args.tags !== undefined;

      if (all) {
        if (args.auto !== true) throw new Error("批量回填摘要需要同时传 auto=true（抽取式，不调用模型）");
        const limit = Math.min(5000, Math.max(1, Math.round(Number(args.limit) || 200)));
        const manifest = await readManifest(dir);
        const candidates = (manifest.docs ?? []).filter(
          (d) => d.status === "ready" && !isDeleted(d) && !String(d.summary ?? "").trim()
        );
        const picked = candidates.slice(0, limit);
        const plans = [];
        for (const doc of picked) {
          let text = "";
          try {
            text = await readFile(join(dir, "markdown", doc.id, `${doc.id}.md`), "utf8");
          } catch {
            continue;
          }
          const summary = autoSummaryFromMarkdown(text, doc.title);
          if (summary) plans.push({ docId: doc.id, summary });
        }
        let updated = 0;
        if (plans.length > 0) {
          await withManifestLock(dir, async () => {
            const fresh = await readManifest(dir);
            const patches = [];
            for (const plan of plans) {
              const doc = (fresh.docs ?? []).find((d) => d.id === plan.docId);
              if (doc && doc.status === "ready" && !String(doc.summary ?? "").trim()) {
                patches.push({ docId: plan.docId, patch: { summary: plan.summary, summarySource: "auto" } });
              }
            }
            updated = await updateDocsMetaLocked(dir, fresh, patches);
          });
        }
        await appendLog(dir, {
          action: "describe-auto",
          title: `回填 ${updated} 篇摘要`,
          detail: `候选 ${candidates.length}，剩余 ${Math.max(0, candidates.length - updated)}`,
        });
        await refreshKbIndex(dir);
        return {
          kb,
          mode: "auto",
          total: picked.length,
          updated,
          remaining: Math.max(0, candidates.length - updated),
        };
      }

      if (args.doc === undefined) {
        throw new Error("请提供 doc；存量批量回填请传 all=true + auto=true");
      }
      if (!hasSummary && !hasTags && args.clear !== true) {
        throw new Error("请提供 summary 或 tags（或 clear=true 清空）");
      }
      const summary = hasSummary
        ? String(args.summary).replace(/\s+/g, " ").trim().slice(0, 500)
        : undefined;
      const tags = hasTags ? normalizeTags(args.tags) : undefined;
      let result = null;
      await withManifestLock(dir, async () => {
        const manifest = await readManifest(dir);
        const doc = target.doc ?? resolveDoc(manifest, args.doc);
        const patch = {};
        if (args.clear === true) {
          patch.summary = "";
          patch.summarySource = "";
          patch.tags = [];
        } else {
          if (summary !== undefined) {
            patch.summary = summary;
            patch.summarySource = summary ? "model" : "";
          }
          if (tags !== undefined) patch.tags = tags;
        }
        await updateDocMetaLocked(dir, manifest, doc.id, patch);
        result = {
          kb,
          docId: doc.id,
          title: doc.title,
          summary: doc.summary ?? "",
          tags: Array.isArray(doc.tags) ? doc.tags : [],
          changed: true,
        };
      });
      await appendLog(dir, {
        action: "describe",
        title: result.title,
        docId: result.docId,
        detail: result.summary ? `摘要：${result.summary.slice(0, 40)}` : "清空摘要",
      });
      await refreshKbIndex(dir);
      return result;
    },
  });
  ctx.tools.register(tool);
}

function registerKbKeep(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_keep",
    description:
      "把文档标记为「已核对保留」：同一标准号/年份/阶段的重复组经人工核对后决定都保留（如中英译本、不同分册、不同修订版）时使用，kb_lint 不再对这一组报重复。可单篇 doc 或批量 docs；clear=true 取消标记。只改元数据，不递增版本号。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时跨库解析，命中多个需指定）。" },
      doc: { type: "string", description: "单篇：文档标题（子串，需唯一）或 id。" },
      docs: {
        type: "array",
        items: { type: "string" },
        description: "批量：文档标题或 id 列表（最多 200）。",
      },
      note: { type: "string", description: "保留理由（如“中英译本”“不同修订版”“不同分册”）。" },
      clear: { type: "boolean", description: "清除标记（取消“已核对保留”）。" },
      dryRun: { type: "boolean", description: "只预览不写入。" },
    },
    timeoutMs: 120000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          clear: { type: "boolean", required: true },
          dryRun: { type: "boolean", required: true },
          total: { type: "number", required: true },
          updated: { type: "number", required: true },
          docs: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderKbKeep(value) }],
    },
    async execute(args, exec) {
      const target = await resolveDocOrSingleKb(exec, args, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const kb = target.kb;
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      const refs = [];
      if (args.doc !== undefined) refs.push(args.doc);
      if (Array.isArray(args.docs)) refs.push(...args.docs);
      if (refs.length === 0) throw new Error("请提供 doc 或 docs");
      if (args.docs && args.docs.length > 200) throw new Error("docs 一次最多 200 个");
      const selected = [];
      const seen = new Set();
      for (const ref of refs) {
        const doc = (ref === args.doc ? target.doc : undefined) ?? resolveDoc(manifest, ref);
        if (doc.status !== "ready") throw new Error(`文档「${doc.title}」状态为 ${doc.status}，暂不能标记`);
        if (seen.has(doc.id)) continue;
        selected.push(doc);
        seen.add(doc.id);
      }
      const clear = args.clear === true;
      const note = String(args.note ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      const dryRun = args.dryRun === true;
      const now = new Date().toISOString();
      const results = selected.map((doc) => ({
        docId: doc.id,
        title: doc.title,
        note: clear ? "" : note,
      }));
      if (dryRun) {
        return { kb, clear, dryRun: true, total: results.length, updated: 0, docs: results };
      }
      let updated = 0;
      await withManifestLock(dir, async () => {
        const fresh = await readManifest(dir);
        const patches = [];
        for (const item of results) {
          const doc = (fresh.docs ?? []).find((d) => d.id === item.docId);
          if (!doc || doc.status !== "ready") continue;
          patches.push({
            docId: item.docId,
            patch: {
              dedupKeep: !clear,
              dedupNote: clear ? "" : note,
              dedupReviewedAt: now,
            },
          });
        }
        updated = await updateDocsMetaLocked(dir, fresh, patches);
      });
      await appendLog(dir, {
        action: "keep",
        title: `${clear ? "取消" : "标记"}已核对保留：${updated} 篇`,
        detail: note.slice(0, 80),
      });
      await refreshKbIndex(dir);
      return { kb, clear, dryRun: false, total: results.length, updated, docs: results };
    },
  });
  ctx.tools.register(tool);
}

function renderKbKeep(value) {
  const head = `${value.clear ? "取消" : "标记"}「已核对保留」${value.dryRun ? "（预览，未写入）" : ""}：${value.updated}/${value.total} 篇。`;
  const lines = [head];
  for (const item of (value.docs ?? []).slice(0, 30)) {
    lines.push(`- ${item.docId}  ${item.title}${item.note ? `（${item.note}）` : ""}`);
  }
  if ((value.docs ?? []).length > 30) lines.push(`- …还有 ${value.docs.length - 30} 篇`);
  if (value.dryRun) lines.push("确认后传 dryRun=false 写入。");
  return lines.join("\n");
}

function registerKbTrust(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_trust",
    description:
      "给文档标注来源可信度：high（已发布现行标准、正式出版教材等）/ medium（企业文件、培训资料、报批稿等）/ low（草案、征求意见稿、已废止标准等）/ unknown（清除标注）。可单篇 doc、批量 docs、或 all=true 配合 query/stage 过滤；批量默认 dryRun=true 先预览。检索会优先高可信并标注低可信，矛盾时提醒用户。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时跨库解析，命中多个需指定）。" },
      doc: { type: "string", description: "单篇：文档标题（子串，需唯一）或 id。" },
      docs: {
        type: "array",
        items: { type: "string" },
        description: "批量：文档标题或 id 列表（最多 200）。",
      },
      all: { type: "boolean", description: "批量选择：与 query/stage 配合；不带过滤时为全部 ready 文档。" },
      query: { type: "string", description: "批量过滤：标题包含该子串。" },
      stage: {
        type: "string",
        description: "批量过滤：published（发布稿）/ draft（征求意见、报批、送审、讨论、草案）/ material（编制说明、修编说明等）/ any。",
      },
      level: {
        type: "string",
        required: true,
        description: "可信度：high / medium / low / unknown（清除标注）。",
      },
      reason: { type: "string", description: "标注理由（建议写清依据，如“现行版”“2024 征求意见稿”）。" },
      dryRun: { type: "boolean", description: "只预览不写入；批量为 2 篇及以上时默认 true。" },
      limit: { type: "number", description: "批量最多处理多少篇（默认 200，上限 5000）。" },
    },
    timeoutMs: 120000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          level: { type: "string", required: true },
          dryRun: { type: "boolean", required: true },
          total: { type: "number", required: true },
          updated: { type: "number", required: true },
          docs: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderKbTrust(value) }],
    },
    async execute(args, exec) {
      const target = await resolveDocOrSingleKb(exec, args, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const kb = target.kb;
      const dir = kbDirPath(kbRoot, kb);
      const level = String(args.level ?? "").trim().toLowerCase();
      if (!TRUST_LEVELS.includes(level)) {
        throw new Error(`level 取值无效: ${args.level}（应为 ${TRUST_LEVELS.join(" / ")}）`);
      }
      const reason = String(args.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      const manifest = await readManifest(dir);
      const ready = (manifest.docs ?? []).filter((d) => d.status === "ready" && !isDeleted(d));
      let selected = [];
      let bulk = false;

      if (args.doc !== undefined) {
        const doc = target.doc ?? resolveDoc(manifest, args.doc);
        if (doc.status !== "ready") throw new Error(`文档「${doc.title}」状态为 ${doc.status}，暂不能标注`);
        selected = [doc];
      } else if (Array.isArray(args.docs) && args.docs.length > 0) {
        if (args.docs.length > 200) throw new Error("docs 一次最多 200 个");
        const seen = new Set();
        for (const ref of args.docs) {
          const doc = resolveDoc(manifest, ref);
          if (!seen.has(doc.id)) {
            selected.push(doc);
            seen.add(doc.id);
          }
        }
        bulk = selected.length > 1;
      } else if (args.all === true || args.query !== undefined || args.stage !== undefined) {
        bulk = true;
        const query = String(args.query ?? "").trim().toLowerCase();
        const stage = String(args.stage ?? "any").trim().toLowerCase();
        const stageBuckets = {
          published: ["发布稿"],
          draft: ["征求意见稿", "报批稿", "送审稿", "讨论稿", "草案"],
          material: ["说明材料"],
        };
        selected = ready.filter((doc) => {
          if (query && !String(doc.title ?? "").toLowerCase().includes(query)) return false;
          if (stage !== "any") {
            const bucket = stageBuckets[stage];
            if (!bucket || !bucket.includes(stageOf(doc.title))) return false;
          }
          return true;
        });
        const limit = Math.max(1, Math.min(5000, Math.round(Number(args.limit) || 200)));
        selected = selected.slice(0, limit);
      } else {
        throw new Error("请提供 doc、docs，或 all=true 配合 query/stage 批量选择");
      }

      if (selected.length === 0) {
        return { kb, level, dryRun: true, total: 0, updated: 0, docs: [] };
      }
      const dryRun = args.dryRun !== undefined ? args.dryRun === true : bulk;
      const now = new Date().toISOString();
      const results = selected.map((doc) => ({
        docId: doc.id,
        title: doc.title,
        stage: stageOf(doc.title),
        trust: level,
        reason,
      }));
      if (dryRun) {
        return { kb, level, dryRun: true, total: results.length, updated: 0, docs: results };
      }
      let updated = 0;
      await withManifestLock(dir, async () => {
        const fresh = await readManifest(dir);
        const patches = [];
        for (const item of results) {
          const doc = (fresh.docs ?? []).find((d) => d.id === item.docId);
          if (!doc || doc.status !== "ready") continue;
          patches.push({
            docId: item.docId,
            patch: {
              trust: level,
              trustReason: reason,
              trustUpdatedAt: now,
              trustSource: level === "unknown" ? "unknown" : "manual",
            },
          });
        }
        updated = await updateDocsMetaLocked(dir, fresh, patches);
      });
      await appendLog(dir, {
        action: "trust",
        title: `标注可信度 ${level}：${updated} 篇`,
        detail: reason.slice(0, 80),
      });
      await refreshKbIndex(dir);
      return { kb, level, dryRun: false, total: results.length, updated, docs: results };
    },
  });
  ctx.tools.register(tool);
}

function renderKbTrust(value) {
  const head = `可信度标注 ${trustLabel(value.level)}${value.dryRun ? "（预览，未写入）" : ""}：${value.updated}/${value.total} 篇。`;
  const lines = [head];
  for (const item of (value.docs ?? []).slice(0, 30)) {
    lines.push(`- ${item.docId}  ${item.title}（${item.stage}）`);
  }
  if ((value.docs ?? []).length > 30) lines.push(`- …还有 ${value.docs.length - 30} 篇`);
  if (value.dryRun && value.total > 0) lines.push("确认后传 dryRun=false 写入。");
  return lines.join("\n");
}

function registerKbRetitle(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_retitle",
    description:
      "修正文档/笔记标题。单篇传 doc（可不传 title，默认按 cleanTitle 去掉站点域名、GB_T、序号前缀等噪声）；批量传 all=true 清洗全库标题（默认 dryRun=true 只预览，确认后传 dryRun=false）；加 standardPrefix=true 把有标准号的中文资料统一成「标准号 + 名称」（英文标题暂不动）。会重建合并版首行标题、保留历史版本并版本号+1。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时跨库解析，命中多个需指定）。" },
      doc: { type: "string", description: "单篇：文档标题（子串，需唯一）或文档 id。" },
      title: { type: "string", description: "新标题；省略则用 cleanTitle 自动清洗。" },
      all: { type: "boolean", description: "批量清洗该库所有可自动改善的标题。" },
      dryRun: { type: "boolean", description: "只预览不修改；all=true 时默认 true，单篇默认 false。" },
      standardPrefix: { type: "boolean", description: "把有标准号的资料统一成「标准号 + 名称」（编号来自规范 standardNo，不含“（发布稿）”等阶段）。" },
      limit: { type: "number", description: "all=true 时本轮最多处理多少篇（默认 200，上限 1000）。" },
    },
    timeoutMs: 300000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          dryRun: { type: "boolean", required: true },
          total: { type: "number", required: true },
          totalAll: { type: "number" },
          applied: { type: "number", required: true },
          changes: { type: "array", items: { type: "object", additionalProperties: true } },
          errors: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderKbRetitle(value) }],
    },
    async execute(args, exec) {
      const target = await resolveDocOrSingleKb(exec, args, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const kb = target.kb;
      const dir = kbDirPath(kbRoot, kb);
      if (args.doc === undefined && args.all !== true) {
        throw new Error("请传 doc（单篇改名）或 all=true（批量清洗）");
      }
      if (args.doc !== undefined && args.all === true) {
        throw new Error("doc 与 all 不能同时使用");
      }
      const dryRun = args.dryRun !== undefined ? args.dryRun === true : args.all === true;

      if (args.doc !== undefined) {
        const manifest = await readManifest(dir);
        const doc = target.doc ?? resolveDoc(manifest, args.doc);
        const base = String(args.title ?? cleanTitle(doc.title)).replace(/\s+/g, " ").trim();
        // standardPrefix 只处理中文标题：英文标题保持原样（用户 0.31.5 明确要求）。
        const cjk = /[\u4e00-\u9fa5]/.test(base);
        const next = (args.standardPrefix === true && doc.standardNo && cjk
          ? withStandardPrefix(base, doc.standardNo)
          : (args.title === undefined && args.standardPrefix === true && !cjk ? String(doc.title ?? "") : base)).slice(0, 200);
        if (!next) throw new Error("新标题不能为空");
        if (next === doc.title) {
          return { kb, dryRun, total: 0, totalAll: 0, applied: 0, changes: [{ docId: doc.id, title: doc.title, from: doc.title, to: next, changed: false }], errors: [] };
        }
        if (dryRun) {
          return { kb, dryRun: true, total: 1, totalAll: 1, applied: 0, changes: [{ docId: doc.id, title: doc.title, from: doc.title, to: next, changed: false }], errors: [] };
        }
        const result = await applyRetitle(dir, doc.id, next);
        await appendLog(dir, {
          action: "retitle",
          title: result.to,
          docId: doc.id,
          version: result.version,
          detail: `原题：${result.from.slice(0, 40)}`,
        });
        await refreshKbIndex(dir);
        return {
          kb,
          dryRun: false,
          total: 1,
          totalAll: 1,
          applied: result.changed ? 1 : 0,
          changes: [{ docId: doc.id, title: result.to, from: result.from, to: result.to, changed: result.changed, version: result.version }],
          errors: [],
        };
      }

      const manifest = await readManifest(dir);
      const limit = Math.max(1, Math.min(1000, Math.round(Number(args.limit) || 200)));
      const allCandidates = (manifest.docs ?? [])
        .filter((d) => d.status === "ready" && !isDeleted(d))
        .map((doc) => {
          // standardPrefix 迁移只动中文标题；英文标题整条跳过（连 cleanTitle 也不做）。
          if (args.standardPrefix === true && !/[\u4e00-\u9fa5]/.test(String(doc.title ?? ""))) {
            return { doc, to: String(doc.title ?? "") };
          }
          const base = cleanTitle(doc.title).replace(/\s+/g, " ").trim();
          const cjk = /[\u4e00-\u9fa5]/.test(base);
          const to = (args.standardPrefix === true && doc.standardNo && cjk
            ? withStandardPrefix(base, doc.standardNo)
            : base).slice(0, 200);
          return { doc, to };
        })
        .filter((x) => x.to && x.to !== x.doc.title);
      const candidates = allCandidates.slice(0, limit);
      const changes = candidates.map((x) => ({
        docId: x.doc.id,
        title: x.doc.title,
        from: x.doc.title,
        to: x.to,
        changed: false,
      }));
      if (dryRun) {
        return { kb, dryRun: true, total: changes.length, totalAll: allCandidates.length, applied: 0, changes, errors: [] };
      }
      let applied = 0;
      const errors = [];
      for (const c of candidates) {
        try {
          const result = await applyRetitle(dir, c.doc.id, c.to);
          if (result.changed) {
            applied += 1;
            await appendLog(dir, {
              action: "retitle",
              title: result.to,
              docId: c.doc.id,
              version: result.version,
              detail: `原题：${result.from.slice(0, 40)}`,
            });
          }
        } catch (error) {
          errors.push({ docId: c.doc.id, title: c.doc.title, error: String(error?.message ?? error).slice(0, 200) });
        }
      }
      await refreshKbIndex(dir);
      return { kb, dryRun: false, total: changes.length, totalAll: allCandidates.length, applied, changes, errors };
    },
  });
  ctx.tools.register(tool);
}

function renderKbRetitle(value) {
  const head = `知识库「${value.kb}」标题清洗${value.dryRun ? "（预览，未修改）" : ""}：可修改 ${value.totalAll ?? value.total} 篇${value.applied ? `，已修改 ${value.applied} 篇` : ""}${(value.totalAll ?? 0) > value.total ? `（本轮处理前 ${value.total} 篇，可调大 limit）` : ""}。`;
  const lines = [head];
  for (const c of (value.changes ?? []).slice(0, 20)) {
    lines.push(`- ${c.docId}  ${c.from}  →  ${c.to}`);
  }
  if ((value.changes ?? []).length > 20) lines.push(`- …还有 ${value.changes.length - 20} 项`);
  if (value.dryRun && value.total > 0) lines.push("确认后传 dryRun=false 应用（会保留历史版本，版本号+1）。");
  if ((value.errors ?? []).length > 0) {
    lines.push(`失败 ${value.errors.length} 项：`);
    for (const e of value.errors.slice(0, 10)) lines.push(`- ${e.docId} ${e.title}: ${e.error}`);
  }
  return lines.join("\n");
}

function registerKbLint(ctx, { kbRoot, defaultKb, scopeTtlDays, scopeLintMaxKbs }) {
  const tool = defineTool({
    name: "kb_lint",
    description:
      "知识库体检（机械项）：导入失败、旧管线、文字层损坏/OCR 低置信、内容重复、同标准号同期同阶段重复、同号多版本、未编目、笔记无来源、续/修订版提示、孤页、缺少 schema；输出分组问题与建议动作（kb_reparse / kb_describe / kb_remove / kb_edit）。语义层面的矛盾与陈旧结论仍需自己核对。选中范围时省略 kb 会逐库体检（每次最多 scopeLintMaxKbs 个，超出会标记 truncated 并列出未检查的库）。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围逐库体检（全部模式下用 default）。" },
      maxItems: { type: "number", description: "每组最多列出多少条（默认 20，上限 200）。" },
      staleDays: { type: "number", description: "笔记超过多少天未更新算“待复核”（默认 90，0=不检查）。" },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          generatedAt: { type: "string" },
          totals: { type: "object", additionalProperties: true },
          counts: { type: "object", additionalProperties: true },
          groups: { type: "array", items: { type: "object", additionalProperties: true } },
          suggestions: { type: "array", items: { type: "object", additionalProperties: true } },
          kbs: { type: "array", items: { type: "object", additionalProperties: true } },
          truncated: { type: "boolean" },
          omittedKbs: { type: "array", items: { type: "string" } },
          error: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderKbLint(value) }],
    },
    async execute(args, exec) {
      const scope = await resolveExecScope(exec, { kbRoot, ttlDays: scopeTtlDays });
      assertScopeEnabled(scope);
      const maxItems = Math.min(200, Math.max(1, Math.round(Number(args.maxItems) || 20)));
      const staleDays = Math.min(3650, Math.max(0, Math.round(Number(args.staleDays ?? 90))));
      const lintOne = async (kb) => {
        const dir = kbDirPath(kbRoot, kb);
        const manifest = await readManifest(dir);
        const schema = await readSchema(dir);
        return { kb, ...lintManifest(manifest, { kbName: kb, hasSchema: schema.exists, staleDays, maxItems }) };
      };
      const requested = typeof args.kb === "string" && args.kb.trim() !== "";
      if (requested) {
        const kb = sanitizeKbName(args.kb);
        assertInScope(scope, kb);
        return lintOne(kb);
      }
      if (scope.mode === "selected") {
        const names = scope.kbs;
        const results = [];
        for (const name of names.slice(0, scopeLintMaxKbs)) {
          try {
            results.push(await lintOne(name));
          } catch (error) {
            results.push({ kb: name, error: String(error?.message ?? error) });
          }
        }
        if (results.length === 1 && names.length <= scopeLintMaxKbs) return results[0];
        return {
          kb: "scope",
          kbs: results,
          ...(names.length > scopeLintMaxKbs
            ? { truncated: true, omittedKbs: names.slice(scopeLintMaxKbs) }
            : {}),
        };
      }
      return lintOne(sanitizeKbName(defaultKb));
    },
  });
  ctx.tools.register(tool);
}

function renderKbLint(value) {
  if (value.error !== undefined) return `知识库「${value.kb}」体检失败：${value.error}`;
  if (Array.isArray(value.kbs)) {
    const note = value.truncated === true
      ? [`范围共 ${value.kbs.length + (value.omittedKbs?.length ?? 0)} 个库，本轮只检查了前 ${value.kbs.length} 个（scopeLintMaxKbs）。`]
      : [];
    return [...note, ...value.kbs.map((entry) => renderKbLint(entry))].join("\n\n");
  }
  const c = value.counts ?? {};
  const lines = [
    `知识库「${value.kb}」体检：${c.docs ?? 0} 篇（就绪 ${c.ready ?? 0}，笔记 ${c.notes ?? 0}，资料 ${c.sources ?? 0}${c.failed ? `，失败 ${c.failed}` : ""}）`,
  ];
  const groups = value.groups ?? [];
  if (groups.length === 0) lines.push("未发现明显问题。");
  for (const g of groups) {
    const icon = g.severity === "error" ? "❌" : g.severity === "warning" ? "⚠" : "ℹ";
    lines.push("", `${icon} ${g.label}（${g.count}）`);
    for (const item of (g.items ?? []).slice(0, 10)) {
      const detail = item.detail ? `：${item.detail}` : "";
      lines.push(`- ${item.title}（${item.docId}）${detail}`);
    }
    if (g.count > 10) lines.push(`- …还有 ${g.count - 10} 项`);
    if (g.hint) lines.push(`  → ${g.hint}`);
  }
  if ((value.suggestions ?? []).length > 0) {
    lines.push("", "建议动作：");
    for (const s of value.suggestions) {
      lines.push(`- ${s.action}${s.count ? ` ×${s.count}` : ""}：${s.reason}`);
    }
  }
  return lines.join("\n");
}

function registerKbAddNote(ctx, { kbRoot, defaultKb, partMaxChars, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_add_note",
    description:
      "向知识库写入编译页/笔记（markdown，单篇上限 2MB）：kind=summary|entity|concept|topic|note，可用 tags 打标签、sources 写来源（docId#页码 或 [[标题]]）。同一标题再次调用会更新该笔记（保留历史版本），不要用「续」「修订版」另起新页。笔记可被 kb_query 检索、kb_read 阅读、kb_edit 修订、kb_export 导出（导出带 YAML frontmatter）。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库笔记，多库时必须指定）。" },
      title: {
        type: "string",
        required: true,
        description: "笔记标题（同一标题=同一篇笔记，重复调用即更新）。",
      },
      content: {
        type: "string",
        required: true,
        description: "笔记内容（markdown）。",
      },
      kind: {
        type: "string",
        description: "笔记类型：summary（来源摘要）/ entity（实体）/ concept（概念）/ topic（专题）/ note（普通笔记，默认）。",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "标签（可选，最多 20 个，索引与列表会显示）。",
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description: "依据来源（可选）：docId、docId#页码 或 [[标题]]；写进清单后可被反查（谁引用了原文）。",
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
          updated: { type: "boolean" },
          kind: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          sources: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            `${value.updated ? "已更新笔记" : "已添加笔记"}「${value.title}」（${value.docId}，${noteKindLabel(value.kind)}）` +
            `到知识库「${value.kb}」: ${value.chars} 字，${value.parts} 部分` +
            `${value.sources?.length ? `，来源 ${value.sources.length} 处` : ""}` +
            (value.warnings?.length ? `\n注意：${value.warnings.join("；")}` : ""),
        },
      ],
    },
    async execute(args, exec) {
      const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const dir = kbDirPath(kbRoot, kb);
      const title = String(args.title ?? "").trim().slice(0, 200);
      if (title.length === 0) throw new Error("笔记标题不能为空");
      const content = String(args.content ?? "");
      const NOTE_MAX_CHARS = 2 * 1024 * 1024;
      if (content.length > NOTE_MAX_CHARS) {
        throw new Error(`笔记内容过长（${content.length} 字符，上限 ${NOTE_MAX_CHARS}），请拆分为多篇笔记或先精简`);
      }
      const kindArg = String(args.kind ?? "").trim().toLowerCase();
      if (kindArg && !NOTE_KINDS.includes(kindArg)) {
        throw new Error(`kind 取值无效: ${kindArg}（应为 ${NOTE_KINDS.join(" / ")}）`);
      }
      const tags = normalizeTags(args.tags);
      const manifest = await readManifest(dir);

      // 同标题 = 同一篇笔记（更新而不是新建），避免「续」「修订版」无限增生
      const normalizeTitle = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const wanted = normalizeTitle(title);
      const existing = (manifest.docs ?? []).find(
        (doc) => doc.type === "note" && !isDeleted(doc) && normalizeTitle(doc.title) === wanted
      );
      // kind 省略时沿用旧笔记的类型（更新专题页不该把它降级成普通笔记）
      const kind = kindArg || existing?.kind || "note";

      const sourcesProvided = args.sources !== undefined;
      const sourceInfo = normalizeSources(args.sources, manifest);
      const prevSources = Array.isArray(existing?.sources) ? existing.sources : [];
      const prevLinks = Array.isArray(existing?.linksOut) ? existing.linksOut : [];
      const linksOut = [
        ...new Set([
          ...(sourcesProvided ? sourceInfo.linksOut : prevLinks),
          ...resolveContentLinks(content, manifest),
        ]),
      ];
      const warnings = sourcesProvided ? [...sourceInfo.warnings] : [];

      const docId = existing?.id ?? createHash("sha1")
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
        kind,
        tags,
        sources: sourcesProvided ? sourceInfo.sources : undefined,
        linksOut,
        summary: summarizeText(content, 160),
        summarySource: "auto",
        snapshotReason: "note-update",
      });
      const version = (existing?.version ?? 0) + 1;
      const finalSources = sourcesProvided ? sourceInfo.sources : prevSources;
      await appendLog(dir, {
        action: existing ? "note-update" : "note",
        title,
        docId,
        version,
        detail: `${kind}${finalSources.length ? `，来源 ${finalSources.length} 处` : ""}`,
      });
      await refreshKbIndex(dir);
      return {
        kb,
        docId,
        title,
        chars,
        parts,
        updated: Boolean(existing),
        kind,
        tags,
        sources: finalSources,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  });
  ctx.tools.register(tool);
}

function registerKbRemove(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_remove",
    description:
      "删除知识库中的单个文档（doc 参数），或删除整个知识库（必须显式 removeKb=true 且 confirm 等于知识库名称）。单个文档默认软删除（保留原始文件与分块，可用 kb_restore 恢复）；只有 soft=false 才永久删除。删除整个知识库不可恢复。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时必须指定）；删除整库时必填。" },
      doc: {
        type: "string",
        description: "要删除的文档标题（子串）或 id。",
      },
      soft: {
        type: "boolean",
        description: "软删除（默认 true）：保留原始文件与分块，可用 kb_restore 恢复；false=永久删除，不可恢复。",
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
          soft: { type: "boolean" },
          deletedAt: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.removed }],
    },
    async execute(args, exec) {
      // 先过范围门：mode:"none" 时连「参数不完整」的调用也必须回 KB_DISABLED，
      // 不能因为参数校验先抛错而泄露「这个库/文档可能存在」的信息。
      assertScopeEnabled(await resolveExecScope(exec, { kbRoot, ttlDays: scopeTtlDays }));
      if (args.doc === undefined) {
        if (args.removeKb !== true) {
          throw new Error("未指定 doc 时删除整个知识库需要显式传 removeKb=true 且 confirm 等于知识库名称");
        }
        if (typeof args.kb !== "string" || args.kb.trim() === "") {
          throw new ScopeError("删除整个知识库必须显式指定 kb", "KB_REQUIRED");
        }
        const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays }, { policy: "kbAdmin" });
        const confirm = String(args.confirm ?? "").trim();
        if (confirm !== kb) {
          throw new Error(`删除整个知识库「${kb}」不可恢复。请确认后重试：同时传 removeKb=true 和 confirm="${kb}"（逐字一致）`);
        }
        await removeKbDir(kbRoot, kb);
        return { kb, removed: `已删除整个知识库「${kb}」`, soft: false };
      }
      const target = await resolveDocTarget(exec, args.kb, args.doc, {
        kbRoot,
        defaultKb,
        ttlDays: scopeTtlDays,
        includeDeleted: args.soft === false,
      });
      const kb = target.kb;
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      const soft = args.soft !== false;
      const doc = target.doc ?? resolveDoc(manifest, args.doc, { includeDeleted: !soft });
      if (soft) {
        const r = await softDeleteDoc(dir, doc.id);
        await appendLog(dir, { action: "remove", title: doc.title, docId: doc.id, detail: "软删除" });
        await refreshKbIndex(dir);
        return {
          kb,
          removed: `已软删除知识库「${kb}」的文档「${doc.title}」（${doc.id}），可用 kb_restore 恢复`,
          soft: true,
          deletedAt: r.deletedAt,
        };
      }
      await removeDoc(dir, doc.id);
      await appendLog(dir, { action: "remove", title: doc.title, docId: doc.id, detail: "永久删除" });
      await refreshKbIndex(dir);
      return {
        kb,
        removed: `已永久删除知识库「${kb}」的文档「${doc.title}」（${doc.id}），不可恢复`,
        soft: false,
      };
    },
  });
  ctx.tools.register(tool);
}

function registerKbRestore(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_restore",
    description:
      "恢复文档：不传 version 时恢复 kb_remove 软删除的文档；传 version=N 时恢复 kb_history 中的历史版本（恢复前会把当前版本再存一份）。永久删除的文档无法恢复。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时跨库解析，含软删除文档）。" },
      doc: { type: "string", required: true, description: "文档标题（子串）或 id。" },
      version: {
        type: "number",
        description: "要恢复的历史版本号（来自 kb_history）；省略则只恢复软删除状态。",
      },
    },
    timeoutMs: 120000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          docId: { type: "string", required: true },
          restored: { type: "string", required: true },
          version: { type: "number" },
          fromVersion: { type: "number" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.restored }],
    },
    async execute(args, exec) {
      const target = await resolveDocTarget(exec, args.kb, args.doc, {
        kbRoot,
        defaultKb,
        ttlDays: scopeTtlDays,
        includeDeleted: true,
      });
      const kb = target.kb;
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      const doc = target.doc ?? resolveDoc(manifest, args.doc, { includeDeleted: true });
      if (args.version !== undefined) {
        const fromVersion = Number(args.version);
        if (!Number.isInteger(fromVersion) || fromVersion < 1) {
          throw new Error("version 必须是正整数（可用 kb_history 查看）");
        }
        const restored = await restoreDocVersion(dir, doc.id, fromVersion);
        await appendLog(dir, {
          action: "restore",
          title: doc.title,
          docId: doc.id,
          version: restored.version,
          detail: `恢复历史版本 v${fromVersion}`,
        });
        await refreshKbIndex(dir);
        return {
          kb,
          docId: doc.id,
          restored: `已恢复知识库「${kb}」文档「${doc.title}」的历史版本 v${fromVersion}（当前 v${restored.version}）`,
          version: restored.version,
          fromVersion,
        };
      }
      if (!isDeleted(doc)) throw new Error(`文档「${doc.title}」未处于删除状态，无需恢复`);
      await restoreDoc(dir, doc.id);
      await appendLog(dir, { action: "restore", title: doc.title, docId: doc.id, detail: "恢复软删除" });
      await refreshKbIndex(dir);
      return {
        kb,
        docId: doc.id,
        restored: `已恢复知识库「${kb}」的文档「${doc.title}」（${doc.id}）`,
        version: doc.version,
      };
    },
  });
  ctx.tools.register(tool);
}

function registerKbHistory(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_history",
    description:
      "列出一个文档保存过的历史版本（覆盖导入/重解析/kb_edit 前的快照，最多 10 个）。用 kb_restore(version=N) 恢复某个版本。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时跨库解析，含软删除文档）。" },
      doc: { type: "string", required: true, description: "文档标题（子串）或 id。" },
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          docId: { type: "string", required: true },
          title: { type: "string", required: true },
          currentVersion: { type: "number", required: true },
          history: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderKbHistory(value) }],
    },
    async execute(args, exec) {
      const target = await resolveDocTarget(exec, args.kb, args.doc, {
        kbRoot,
        defaultKb,
        ttlDays: scopeTtlDays,
        includeDeleted: true,
      });
      const kb = target.kb;
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      const doc = target.doc ?? resolveDoc(manifest, args.doc, { includeDeleted: true });
      const history = [...(Array.isArray(doc.history) ? doc.history : [])].sort(
        (a, b) => Number(a.version) - Number(b.version)
      );
      return {
        kb,
        docId: doc.id,
        title: doc.title,
        currentVersion: doc.version ?? 0,
        history,
      };
    },
  });
  ctx.tools.register(tool);
}

function renderKbHistory(value) {
  const lines = [`文档「${value.title}」（${value.docId}）当前版本 v${value.currentVersion}。`];
  if (!value.history || value.history.length === 0) {
    lines.push("暂无历史版本；覆盖导入/重解析/编辑前会自动保存快照。");
  } else {
    lines.push(`历史版本（最近 ${value.history.length} 个）:`);
    for (const h of [...value.history].reverse()) {
      const when = h.savedAt ? new Date(h.savedAt).toISOString().replace("T", " ").slice(0, 19) : "";
      lines.push(
        `- v${h.version}  ${when}  ${h.reason ?? ""}  ${h.chars ?? 0}字 ${h.parts ?? 0}部分`
      );
    }
    lines.push("用 kb_restore(version=N) 恢复某个版本；恢复前会自动保存当前版本。");
  }
  return lines.join("\n");
}

function registerKbSnapshot(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_snapshot",
    description:
      "库级快照：把清单、schema/index/log 与派生 markdown（可选 sources）打包到知识库 snapshots/ 目录，用于批量编辑/重解析前留档；list=true 列出已有快照。恢复方式见快照内 meta.json（解压覆盖 kb.json 与 markdown/）。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时必须指定）。" },
      label: { type: "string", description: "快照标签（写入文件名，可选）。" },
      list: { type: "boolean", description: "只列出已有快照，不创建。" },
      includeSources: { type: "boolean", description: "是否包含原始文件（默认 false，体积可能很大）。" },
    },
    timeoutMs: 600000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          created: { type: "boolean" },
          name: { type: "string" },
          path: { type: "string" },
          bytes: { type: "number" },
          docs: { type: "number" },
          includeSources: { type: "boolean" },
          snapshots: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderKbSnapshot(value) }],
    },
    async execute(args, exec) {
      const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const dir = kbDirPath(kbRoot, kb);
      if (args.list === true) {
        return { kb, created: false, snapshots: await listKbSnapshots(dir) };
      }
      await refreshKbIndex(dir);
      const manifest = await readManifest(dir);
      const result = await snapshotKb(dir, manifest, {
        label: args.label,
        includeSources: args.includeSources === true,
      });
      await appendLog(dir, {
        action: "snapshot",
        title: result.name,
        detail: `${Math.round(result.bytes / 1024)} KB`,
      });
      return { kb, created: true, ...result };
    },
  });
  ctx.tools.register(tool);
}

function renderKbSnapshot(value) {
  if (!value.created) {
    const list = value.snapshots ?? [];
    if (list.length === 0) return `知识库「${value.kb}」还没有快照。`;
    const lines = [`知识库「${value.kb}」快照（${list.length} 个）:`];
    for (const s of list.slice(0, 20)) {
      lines.push(`- ${s.name}  ${Math.round((s.bytes ?? 0) / 1024)} KB  ${s.docs ?? 0} 篇${s.includeSources ? "（含 sources）" : ""}`);
    }
    return lines.join("\n");
  }
  return `已创建快照 ${value.name}（${value.docs ?? 0} 篇，${Math.round((value.bytes ?? 0) / 1024)} KB）: ${value.path}`;
}

function registerKbExport(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_export",
    description:
      "导出知识库，供其他大模型/应用阅读使用：format=md 合并为单个 markdown 文件（含目录，适合直接上传对话产品）；format=jsonl 每行一个分块（适合 RAG 管道；chunkSize>0 时按段落/句子切成小块，默认按 part 导出）；format=zip 打包整个知识库（markdown+清单，includeSources=true 时包含原始文件，可迁移到其他机器）；format=vault 导出 Obsidian Vault（index.md + wiki/ 笔记与资料页 + 双链，includeSources=true 时带 raw/ 原始文件）。out 省略时写到知识库 exports/ 目录。",
    parameters: {
      kb: { type: "string", description: "知识库名称；省略时按本会话范围解析（单库直接用，多库时必须指定）。" },
      format: {
        type: "string",
        description: "md | jsonl | zip | vault（默认 md）。",
      },
      out: {
        type: "string",
        description: "输出文件绝对路径（支持 ~ 开头的用户目录路径；相对路径按当前工作目录解析）；省略时写入知识库 exports/ 目录。",
      },
      includeSources: {
        type: "boolean",
        description: "zip 导出时是否包含原始文件（默认 false，可显著减小体积）。",
      },
      chunkSize: {
        type: "number",
        description:
          "jsonl RAG 分块大小（字符）；>0 时按段落/句子切成小块，每行一块；0=按 part 导出（默认 0，建议 600–800）。",
      },
      chunkOverlap: {
        type: "number",
        description:
          "jsonl RAG 相邻小块的重叠字符数（默认 0，建议 50–120；仅 chunkSize>0 时生效）。",
      },
    },
    timeoutMs: 600000,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kb: { type: "string", required: true },
          path: { type: "string", required: true },
          format: { type: "string", required: true },
          bytes: { type: "number", required: true },
          docs: { type: "number", required: true },
          chunks: { type: "number" },
          notes: { type: "number" },
          sources: { type: "number" },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `已导出知识库（${value.format}${value.chunks ? `，${value.chunks} 个 RAG 小块` : ""}，${value.docs} 个文档，${Math.round(value.bytes / 1024)} KB）: ${value.path}`,
        },
      ],
    },
    async execute(args, exec) {
      const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays });
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await readManifest(dir);
      const format = String(args.format ?? "md").toLowerCase();
      if (!["md", "jsonl", "zip", "vault"].includes(format)) {
        throw new Error(`format 取值无效: ${args.format}（应为 md / jsonl / zip / vault）`);
      }
      const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      const suffix = randomBytes(2).toString("hex");
      const ext = format === "zip" || format === "vault" ? ".zip" : format === "jsonl" ? ".jsonl" : ".md";
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
        return { kb, path: outPath, format, bytes: r.bytes, docs: r.docs };
      }
      if (format === "jsonl") {
        const chunkSize = Math.min(4000, Math.max(0, Math.round(Number(args.chunkSize) || 0)));
        const chunkOverlap = Math.min(300, Math.max(0, Math.round(Number(args.chunkOverlap) || 0)));
        const r = await exportJsonl(dir, manifest, outPath, { chunkSize, chunkOverlap });
        return {
          kb,
          path: outPath,
          format,
          bytes: r.bytes,
          docs: r.docs,
          ...(r.chunks > 0 ? { chunks: r.chunks } : {}),
        };
      }
      if (format === "vault") {
        const r = await exportVault(dir, manifest, outPath, {
          includeSources: args.includeSources === true,
        });
        return {
          kb,
          path: outPath,
          format,
          bytes: r.bytes,
          docs: r.docs,
          notes: r.notes,
          sources: r.sources,
        };
      }
      const r = await exportZip(dir, manifest, outPath, args.includeSources === true);
      return { kb, path: outPath, format, bytes: r.bytes, docs: r.docs };
    },
  });
  ctx.tools.register(tool);
}

function registerKbRename(ctx, { kbRoot, defaultKb, scopeTtlDays }) {
  const tool = defineTool({
    name: "kb_rename",
    description: "重命名知识库（目录与清单同步更新）；kb 与 newName 都必填。",
    parameters: {
      kb: { type: "string", description: "当前知识库名称（必填，须在本会话范围内）。" },
      // 不能标 required：工具框架在 execute 之前做参数校验，none 模式下
      // kb_rename({}) 会先报 INVALID_ARGS 而看不到 KB_DISABLED。缺参校验放到
      // execute 里、范围门之后。
      newName: { type: "string", description: "新名称（必填，可含中文）。" },
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
    async execute(args, exec) {
      // 范围门先于参数校验：mode:"none" 时 kb_rename({}) 也必须回 KB_DISABLED。
      assertScopeEnabled(await resolveExecScope(exec, { kbRoot, ttlDays: scopeTtlDays }));
      if (typeof args.kb !== "string" || args.kb.trim() === "") {
        throw new ScopeError("重命名必须显式指定 kb", "KB_REQUIRED");
      }
      if (typeof args.newName !== "string" || args.newName.trim() === "") {
        throw new Error("重命名必须提供新名称 newName");
      }
      const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays }, { policy: "kbAdmin" });
      const dir = await renameKb(kbRoot, kb, args.newName);
      const next = sanitizeKbName(args.newName);
      await renameScopeKb(kbRoot, kb, next).catch(() => {});
      return { kb: next, dir };
    },
  });
  ctx.tools.register(tool);
}

function registerKbStdCheck(ctx, opts) {
  const {
    kbRoot, defaultKb, scopeTtlDays, bzBaseUrl, bzCookie, stdRateMs, stdMaxAgeDays, stdTimeoutMs, buildImportConfig,
  } = opts;
  const tool = defineTool({
    name: "kb_std_check",
    description:
      "标准更新检查：从知识库（默认「标准」库）的文档标题提取标准号，逐条在标准网(biaozhun.org)多页检索比对年份，发现更新（新版本/草案已出正式版）时用登录会话自动下载 PDF 并直接导入知识库。结果分「发现更新 / 草案已有正式版 / 库内版本已被站点标注废止 / 编号分册歧义 / 已是最新 / 站点未收录」。内置请求限速与增量缓存（7 天内已查过的编号跳过，force=true 强制全查；中断后再次调用自动续查）。下载用详情页里的站点下载 id 并在确认页反查标准号，对不上就中止（防串档）；每次下载都会记录金币消耗，站点提示每日上限时立即停止。下载需要 bzCookie（用户在浏览器登录 biaozhun.org 后提供的 Cookie 串，写入插件配置）；未提供时仅做检查报告。",
    parameters: {
      kb: { type: "string", description: "要检查的知识库名称；省略时用「标准」（须在本会话范围内）。" },
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
      const { kb } = await resolveSingleKb(exec, args.kb, { kbRoot, defaultKb, ttlDays: scopeTtlDays }, { policy: "std" });
      const dir = kbDirPath(kbRoot, kb);
      const manifest = await tryReadManifest(dir).catch(() => null);
      if (manifest === null) {
        throw new Error(`知识库「${kb}」不存在或缺少 kb.json；请先创建该库（或把资料导入「${kb}」）后再检查标准更新`);
      }
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
        const existing = new Set(
          (manifest.docs ?? [])
            .filter((d) => !isDeleted(d))
            .map((d) => d.sourceFile ?? "")
            .filter(Boolean)
        );
        imported = await importDownloaded(
          dir,
          cache,
          createStdImportFn({
            kbDir: dir,
            existing,
            config: buildImportConfig(),
          }),
          {}
        );
        const importedOk = imported.filter((i) => i.docId).length;
        if (importedOk > 0) hint = `已导入 ${importedOk} 份新标准到「${kb}」库`;
        // 导入结果（importedDocId/importError）要落回缓存：否则下次启动工作台会
        // 把已下载未登记的条目再算一次“待下载”，也无法追溯导入到哪篇文档。
        await writeFile(join(dir, ".std-check.json"), JSON.stringify(cache, null, 2), "utf8").catch(() => {});
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
        superseded: report.superseded.length,
        ambiguous: report.ambiguous.length,
        currents: report.currents.length,
        notFound: report.notFound.length,
        newerInKb: report.newerInKb.length,
        downloaded: report.downloaded.length,
        downloadFailed: report.downloadFailed.length,
        coinsSpent: report.coinsSpent,
        dailyLimit: report.dailyLimit === true,
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
