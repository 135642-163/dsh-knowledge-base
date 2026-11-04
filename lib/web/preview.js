/**
 * 工作台预览基础设施：
 * - 原始资料内联预览的类型白名单（只允许 PDF / 图片 / 纯文本，绝不放行 HTML/SVG）
 * - Office 文档 → PDF 的 LibreOfficeKit 调用、缓存与并发合并
 *
 * 缓存放在知识库内的隐藏目录 .preview/，文件名带源文件 mtime+size，
 * 源文件变化自然失效；转换失败不会留下临时文件。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { openZipReader } from "../zip-reader.js";

/** 可安全内联给浏览器的类型：键为小写扩展名，值为精确的 content-type。 */
export const INLINE_TYPES = Object.freeze({
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
});

/** 需要先用 LibreOfficeKit 转成 PDF 才能预览的 Office 扩展名。 */
export const OFFICE_TYPES = Object.freeze([
  ".doc",
  ".docx",
  ".odt",
  ".xls",
  ".xlsx",
  ".ods",
  ".ppt",
  ".pptx",
  ".odp",
]);

const DEFAULT_TIMEOUT_MS = 120000;
const KIT_CLI_SUFFIX = join(
  "node_modules",
  "@deepseek-ai",
  "libreoffice-kit",
  "lib",
  "cli.js"
);
const DEFAULT_OFFICE_KIT_CLI = join(".dsh", "tools", "libreoffice-kit", KIT_CLI_SUFFIX);

/** 预览基础设施的业务错误；message 固定文案，绝不携带绝对路径。 */
export class PreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
  }
}

/** 内联预览的 content-type；不在白名单（含 html/svg）时返回 null。 */
export function inlineTypeFor(path) {
  return INLINE_TYPES[extname(String(path ?? "")).toLowerCase()] ?? null;
}

/** 是否为可用 Office 转换引擎处理的扩展名。 */
export function isOffice(path) {
  return OFFICE_TYPES.includes(extname(String(path ?? "")).toLowerCase());
}

function expandHome(path, home) {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function pathCandidates(name, env, exists) {
  const raw = String(env?.PATH ?? "");
  if (raw === "") return [];
  const names = process.platform === "win32"
    ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
    : [name];
  const found = [];
  for (const dir of raw.split(delimiter)) {
    if (dir === "") continue;
    for (const candidate of names) {
      const abs = join(dir, candidate);
      if (exists(abs)) found.push(resolve(abs));
    }
  }
  return found;
}

function resolveCandidate(raw, { env, home, exists }) {
  const value = String(raw ?? "").trim();
  if (value === "") return null;
  const expanded = expandHome(value, home);
  if (exists(expanded)) return resolve(expanded);
  const isBareName = !isAbsolute(expanded) && !expanded.includes("/") && !expanded.includes("\\");
  if (isBareName) return pathCandidates(expanded, env, exists)[0] ?? null;
  if (!isAbsolute(expanded)) {
    const abs = resolve(expanded);
    return exists(abs) ? abs : null;
  }
  return null;
}

/**
 * 解析 LibreOfficeKit CLI：
 * 显式配置 → DSH_OFFICE_KIT_CLI → DSH_OFFICE_KIT_HOME → ~/.dsh/tools/... 默认安装 → PATH 里的 dsoffice。
 * 返回绝对路径；都不存在时返回 null。
 */
export function resolveOfficeCli(configuredPath, { env = process.env, home = homedir(), exists = existsSync } = {}) {
  const explicit = resolveCandidate(configuredPath, { env, home, exists });
  if (explicit) return explicit;
  const fromEnv = resolveCandidate(env?.DSH_OFFICE_KIT_CLI, { env, home, exists });
  if (fromEnv) return fromEnv;
  // 一键安装允许 DSH_OFFICE_KIT_HOME 改安装目录，解析必须跟着走，否则装完仍找不到 CLI。
  const kitHome = String(env?.DSH_OFFICE_KIT_HOME ?? "").trim();
  if (kitHome !== "") {
    const custom = resolve(join(expandHome(kitHome, home), KIT_CLI_SUFFIX));
    if (exists(custom)) return custom;
  }
  const bundled = resolve(join(home, DEFAULT_OFFICE_KIT_CLI));
  if (exists(bundled)) return bundled;
  return pathCandidates("dsoffice", env, exists)[0] ?? null;
}

/** 流式捕获 stderr 的尾部，仅用于调试日志；不拼进对外 message。 */
function captureTail(stream) {
  let tail = "";
  if (!stream) return () => tail;
  stream.on("data", (chunk) => {
    tail = (tail + chunk.toString()).slice(-8192);
  });
  return () => tail;
}

function spawnConverter(cliPath, args) {
  const useNode = cliPath.toLowerCase().endsWith(".js");
  const command = useNode ? process.execPath : cliPath;
  const argv = useNode ? [cliPath, ...args] : args;
  return spawn(command, argv, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    // POSIX 下独立进程组，超时可连同 CLI 派生的 soffice 子进程一起杀掉。
    detached: process.platform !== "win32",
  });
}

function killProcessTree(child) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      /* 进程/进程组已退出时回退到单进程 kill */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already exited */
  }
}

async function pdfHeaderOf(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const head = Buffer.alloc(5);
    const { bytesRead } = await handle.read(head, 0, 5, 0);
    return bytesRead === 5 ? head.toString("latin1") : "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertPdfFile(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new PreviewError("PREVIEW_OUTPUT_MISSING", "Office 转换未生成文件");
  }
  if (!info.isFile() || info.size <= 0) {
    throw new PreviewError("PREVIEW_OUTPUT_MISSING", "Office 转换未生成文件");
  }
  if ((await pdfHeaderOf(path)) !== "%PDF-") {
    throw new PreviewError("PREVIEW_OUTPUT_INVALID", "Office 转换输出不是 PDF");
  }
  return info;
}

async function isUsablePdf(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0) return false;
    return (await pdfHeaderOf(path)) === "%PDF-";
  } catch {
    return false;
  }
}

/**
 * 调用 LibreOfficeKit 把 Office 文档转成 PDF。
 * cliPath 以 .js 结尾时用当前 Node 进程执行（npm 侧车形态），否则直接执行。
 * 退出码非 0、超时、输出缺失或不是 PDF 都抛 PreviewError（message 不含路径）。
 */
export async function convertOfficeToPdf({ cliPath, input, output, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof cliPath !== "string" || cliPath.trim() === "") {
    throw new PreviewError("PREVIEW_ENGINE_MISSING", "未安装 Office 转换引擎（LibreOfficeKit），请安装后重试");
  }
  if (typeof input !== "string" || input === "" || typeof output !== "string" || output === "") {
    throw new PreviewError("PREVIEW_INVALID_INPUT", "预览转换参数无效");
  }
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const args = ["convert", "--input", input, "--output", output];
  let child;
  try {
    child = spawnConverter(cliPath, args);
  } catch {
    throw new PreviewError("PREVIEW_ENGINE_SPAWN_FAILED", "Office 转换引擎启动失败");
  }
  const stderrTail = captureTail(child.stderr);
  let timedOut = false;
  let settled = false;
  await new Promise((resolvePromise, rejectPromise) => {
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      // 立刻拒绝，不等 close：CLI 派生进程可能短暂占住 stdio 管道。
      finish(rejectPromise, new PreviewError("PREVIEW_TIMEOUT", "Office 转换超时"));
    }, timeout);
    timer.unref?.();
    child.once("error", () => {
      finish(rejectPromise, new PreviewError("PREVIEW_ENGINE_SPAWN_FAILED", "Office 转换引擎启动失败"));
    });
    child.once("close", (code) => {
      if (timedOut) return;
      if (code !== 0) {
        const error = new PreviewError("PREVIEW_CONVERT_FAILED", "Office 转换失败");
        error.stderrTail = stderrTail();
        finish(rejectPromise, error);
        return;
      }
      finish(resolvePromise);
    });
  });
  await assertPdfFile(output);
  return { output };
}

function safeDocId(docId) {
  const cleaned = String(docId ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return cleaned === "" ? "doc" : cleaned;
}

/** 缓存路径：<kbDir>/.preview/<docId>-<mtimeMs>-<size>.pdf。 */
export function officePreviewCachePath(kbDir, docId, st = {}) {
  const mtime = Number(st?.mtimeMs);
  const size = Number(st?.size);
  const mtimeMs = Number.isFinite(mtime) ? mtime : 0;
  const bytes = Number.isFinite(size) ? size : 0;
  return join(kbDir, ".preview", `${safeDocId(docId)}-${mtimeMs}-${bytes}.pdf`);
}

async function removeOlderPreviews(previewDir, safeId, keep) {
  let names;
  try {
    names = await readdir(previewDir);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      if (name === keep || !name.endsWith(".pdf") || !name.startsWith(`${safeId}-`)) return;
      await rm(join(previewDir, name), { force: true }).catch(() => {});
    })
  );
}

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const LEGACY_OFFICE_EXTS = new Set([".doc", ".xls", ".ppt"]);
const OOXML_BY_DIR = Object.freeze([
  ["word/", "docx"],
  ["xl/", "xlsx"],
  ["ppt/", "pptx"],
]);

async function readPrefix(path, length) {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * 旧版 .doc/.xls/.ppt 的实际格式可能与扩展名不符：
 * - 网页下载常把 .docx 改名成 .doc（内容是 zip）；
 * - 下载被截断时，OLE 复合文档末尾会少若干字节，LibreOfficeKit 会直接拒绝
 *   “invalid or truncated compound-file header”，而 Word/textutil 其实还能打开。
 *
 * 这里只对“需要修复”的输入做一份临时副本（补零到扇区边界 / 换成正确的 OOXML 扩展名），
 * 原件永不修改；转换结束由 cleanup 删除副本。
 */
export async function prepareOfficeInput({
  sourcePath,
  previewDir,
  docId = "doc",
  ext = extname(String(sourcePath ?? "")).toLowerCase(),
} = {}) {
  const noop = async () => {};
  if (typeof sourcePath !== "string" || sourcePath === "") {
    return { inputPath: sourcePath, repaired: "", cleanup: noop };
  }
  const suffix = String(ext ?? "").toLowerCase();
  let info;
  try {
    info = await stat(sourcePath);
  } catch {
    return { inputPath: sourcePath, repaired: "", cleanup: noop };
  }
  if (!info.isFile()) return { inputPath: sourcePath, repaired: "", cleanup: noop };
  const head = await readPrefix(sourcePath, 512);
  if (head.length < 8) return { inputPath: sourcePath, repaired: "", cleanup: noop };

  const isOle = head.subarray(0, 8).equals(OLE_MAGIC);
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  let repaired = "";
  let nextExt = "";
  let padding = 0;

  if (isZip) {
    let kind = "";
    try {
      const reader = await openZipReader(sourcePath);
      const names = reader.list().map((entry) => entry.name);
      for (const [prefix, candidate] of OOXML_BY_DIR) {
        if (names.some((name) => name.startsWith(prefix))) {
          kind = candidate;
          break;
        }
      }
    } catch {
      kind = "";
    }
    if (kind === "" || `.${kind}` === suffix) {
      return { inputPath: sourcePath, repaired: "", cleanup: noop };
    }
    nextExt = `.${kind}`;
    repaired = "ooxml-extension";
  } else if (isOle && LEGACY_OFFICE_EXTS.has(suffix)) {
    const shift = head.length >= 32 ? head.readUInt16LE(30) : 0;
    const sector = shift === 9 ? 512 : shift === 12 ? 4096 : 0;
    if (sector > 0 && info.size % sector !== 0) {
      // 至少补到 2 个扇区：LibreOfficeKit 要求头部 + 一个完整扇区。
      const target = Math.max(info.size + (sector - (info.size % sector)), sector * 2);
      padding = target - info.size;
      repaired = "zero-padding";
    }
  }

  if (repaired === "") return { inputPath: sourcePath, repaired: "", cleanup: noop };
  tempCounter += 1;
  const tempPath = join(
    previewDir,
    `.tmp-input-${safeDocId(docId)}-${process.pid}-${tempCounter}-${Date.now().toString(36)}${nextExt || suffix || ".bin"}`
  );
  await copyFile(sourcePath, tempPath);
  if (padding > 0) {
    let handle;
    try {
      handle = await open(tempPath, "r+");
      await handle.truncate(info.size + padding);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return {
    inputPath: tempPath,
    repaired,
    cleanup: async () => {
      await rm(tempPath, { force: true }).catch(() => {});
    },
  };
}

/**
 * 预览失败时给 iframe 的 HTML（浏览器直接打开 preview.pdf 时不再显示生 JSON）。
 * 只放固定文案与同源下载链接，不反射任何路径/错误细节。
 */
export function previewFailureHint(code) {
  switch (String(code ?? "")) {
    case "PREVIEW_ENGINE_MISSING":
      return "未安装 Office 转换引擎（LibreOfficeKit）。请回到预览弹窗点「安装转换引擎」，或下载原件查看。";
    case "PREVIEW_TIMEOUT":
      return "转换超时。文件可能过大或本机资源不足，请稍后重试，或下载原件查看。";
    case "PREVIEW_ENGINE_SPAWN_FAILED":
      return "转换引擎启动失败。可尝试重启 DSH；仍失败请下载原件查看。";
    case "PREVIEW_SOURCE_MISSING":
      return "原件已不存在（可能被移动或删除）。请重新导入该资料，或在资料列表里确认原件状态。";
    case "PREVIEW_INVALID_INPUT":
      return "预览参数无效。请关闭弹窗后重试；仍失败可下载原件查看。";
    case "PREVIEW_OUTPUT_MISSING":
    case "PREVIEW_OUTPUT_INVALID":
      return "转换引擎没有生成有效的 PDF。请下载原件查看；如果原件能正常打开，可把文件反馈给插件维护者。";
    default:
      return "这台电脑无法转换该旧版/损坏的 Office 文件。插件已尝试修复文件尾部缺失或扩展名不符，但仍失败；请下载原件查看。";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function renderPreviewErrorPage({ title = "原件预览", code = "PREVIEW_FAILED", message = "", downloadUrl = "source" } = {}) {
  const hint = previewFailureHint(code);
  const detail = String(message ?? "").trim();
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · 预览失败</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px; font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f7f7f8; color: #1f2329; }
  main { max-width: 620px; margin: 0 auto; background: #fff; border: 1px solid #e5e6eb; border-radius: 12px; padding: 24px 26px; }
  h1 { margin: 0 0 12px; font-size: 18px; }
  p { margin: 10px 0; }
  .hint { color: #4e5969; }
  .detail { color: #86909c; font-size: 12px; word-break: break-all; }
  .actions { margin-top: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
  a.btn { display: inline-block; padding: 8px 14px; border-radius: 8px; background: #1664ff; color: #fff; text-decoration: none; }
  a.link { color: #1664ff; text-decoration: none; padding: 8px 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #17181a; color: #e5e6eb; }
    main { background: #232427; border-color: #33343a; }
    .hint { color: #a9aeb8; }
    .detail { color: #7a7f8a; }
  }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p>原件预览转换失败。</p>
  <p class="hint">${escapeHtml(hint)}</p>
  <p class="detail">错误码：${escapeHtml(code)}${detail ? ` · ${escapeHtml(detail)}` : ""}</p>
  <div class="actions">
    <a class="btn" href="${escapeHtml(downloadUrl)}" download>下载原件</a>
    <a class="link" href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener">在新窗口打开原件</a>
  </div>
</main>
</body>
</html>`;
}

/** 进程内按缓存路径合并并发转换：同一份文档同时只跑一次 LibreOfficeKit。 */
const inflight = new Map();
let tempCounter = 0;

/**
 * 获取（或生成）Office 文档的 PDF 预览：
 * 缓存有效直接返回；并发请求共享同一个 in-flight Promise；
 * 转换先写 .preview/ 内的临时文件，校验 PDF 后原子 rename 到最终名，失败清临时文件。
 */
export async function getOrCreateOfficePreview({
  kbDir,
  docId,
  sourcePath,
  cliPath,
  convert = convertOfficeToPdf,
} = {}) {
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) {
    throw new PreviewError("PREVIEW_SOURCE_MISSING", "原件不存在");
  }
  const target = officePreviewCachePath(kbDir, docId, sourceStat);
  if (await isUsablePdf(target)) return target;
  const pending = inflight.get(target);
  if (pending) return pending;

  const task = (async () => {
    const previewDir = join(kbDir, ".preview");
    await mkdir(previewDir, { recursive: true });
    const safeId = safeDocId(docId);
    tempCounter += 1;
    const tempPath = join(
      previewDir,
      `.tmp-${safeId}-${process.pid}-${tempCounter}-${Date.now().toString(36)}.pdf`
    );
    let prepared = { inputPath: sourcePath, repaired: "", cleanup: async () => {} };
    try {
      prepared = await prepareOfficeInput({ sourcePath, previewDir, docId });
      await convert({ cliPath, input: prepared.inputPath, output: tempPath });
      await assertPdfFile(tempPath);
      // 最终名可能残留一个损坏的旧缓存；先清掉再 rename（Windows 上 rename 不覆盖）。
      await rm(target, { force: true }).catch(() => {});
      await rename(tempPath, target);
      await removeOlderPreviews(previewDir, safeId, target.split(/[\\/]/).pop());
      return target;
    } finally {
      await prepared.cleanup?.().catch(() => {});
      await rm(tempPath, { force: true }).catch(() => {});
    }
  })();
  inflight.set(target, task);
  try {
    return await task;
  } finally {
    if (inflight.get(target) === task) inflight.delete(target);
  }
}

/** 测试用：清空 in-flight 表，避免跨用例持有旧 Promise。 */
export function resetPreviewInFlight() {
  inflight.clear();
}
