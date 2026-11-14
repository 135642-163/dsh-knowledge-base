/**
 * 远程来源获取：把一个 http(s) 链接落成本地可导入的文件。
 * - HTML 页面：走 DeepSeek Fetch 接口转 Markdown；
 * - PDF/Office 等二进制：直接下载（限大小、校验类型、拒绝内网地址）；
 * - 临时目录放在 <kbRoot>/.url-import/ 下，导入完成后清理，残留由启动清扫兜底。
 */
import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, extname, join } from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { assertHttpUrl, deepseekFetchPage } from "./deepseek-api.js";

export const URL_STAGING_DIR = ".url-import";
export const DEFAULT_MAX_URL_BYTES = 300 * 1024 * 1024;
const STAGING_MAX_AGE_MS = 24 * 3600 * 1000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; dsh-knowledge-wiki/0.42; +https://github.com/135642-163/dsh-knowledge-base)";

/** 判断是否为 http(s) 链接。 */
export function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isPrivateAddress(address) {
  const family = net.isIP(String(address ?? ""));
  if (family === 4) {
    const parts = String(address).split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (family === 6) {
    const text = String(address).toLowerCase();
    if (text === "::1" || text === "::") return true;
    if (text.startsWith("fe80:") || text.startsWith("fc") || text.startsWith("fd")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

/**
 * 拒绝本机/内网地址，避免插件被当作 SSRF 跳板。
 * @param lookup 可注入（测试用），默认 dns.lookup
 */
export async function assertPublicUrl(rawUrl, { lookup = dns.lookup, allowPrivate = false } = {}) {
  const url = assertHttpUrl(rawUrl);
  if (allowPrivate === true) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("不允许访问本机/内网地址");
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("不允许访问内网地址");
    return url;
  }
  let addresses = [];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`无法解析域名 ${host}：${error?.message ?? error}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`无法解析域名 ${host}`);
  }
  for (const item of addresses) {
    if (isPrivateAddress(item?.address)) throw new Error("目标域名解析到内网地址，已拒绝");
  }
  return url;
}

function contentTypeOf(headers) {
  return String(headers?.get?.("content-type") ?? "").toLowerCase();
}

function isHtmlType(type) {
  return type.includes("text/html") || type.includes("application/xhtml+xml");
}

function isImageType(type) {
  return type.startsWith("image/");
}

function sanitizeFileName(name, fallback = "downloaded") {
  const base = basename(String(name ?? "").replace(/[\\/]+/g, "_"))
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (base || fallback).slice(0, 120);
}

/** 扩展名 → 支持的类型；.ofd 也按二进制下载。 */
const EXT_BY_CONTENT_TYPE = [
  ["application/pdf", ".pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/msword", ".doc"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["application/vnd.ms-powerpoint", ".ppt"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.ms-excel", ".xlsm"],
  ["application/epub+zip", ".epub"],
  ["application/ofd", ".ofd"],
  ["text/markdown", ".md"],
  ["text/plain", ".txt"],
];

const IMPORTABLE_EXTS = new Set([
  ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xlsm", ".ofd", ".epub", ".mobi", ".azw", ".azw3",
  ".md", ".markdown", ".txt",
]);

function extensionFromDisposition(value) {
  const text = String(value ?? "");
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(text);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(text);
  const name = decodeURIComponent((star?.[1] ?? plain?.[1] ?? "").trim());
  return name ? extname(name).toLowerCase() : "";
}

/** 从 Content-Type / Content-Disposition / URL 推断导入扩展名；推不出就报错。 */
export function inferExtension({ url, contentType = "", disposition = "" }) {
  const type = String(contentType).toLowerCase();
  for (const [needle, ext] of EXT_BY_CONTENT_TYPE) {
    if (type.includes(needle)) return ext;
  }
  const fromDisposition = extensionFromDisposition(disposition);
  if (IMPORTABLE_EXTS.has(fromDisposition)) return fromDisposition;
  try {
    const ext = extname(new URL(String(url)).pathname).toLowerCase();
    if (IMPORTABLE_EXTS.has(ext)) return ext;
  } catch {
    /* ignore */
  }
  return "";
}

function fileNameFromDisposition(disposition, fallback = "") {
  const text = String(disposition ?? "");
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(text);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(text);
  const raw = decodeURIComponent((star?.[1] ?? plain?.[1] ?? "").trim());
  return raw ? sanitizeFileName(raw, fallback) : fallback;
}

async function headProbe(url, { fetchImpl, timeoutMs, headers }) {
  try {
    const response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, ...headers },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 20_000)),
    });
    if (!response.ok) return null;
    return {
      contentType: contentTypeOf(response.headers),
      disposition: response.headers.get("content-disposition") ?? "",
      contentLength: Number(response.headers.get("content-length") || 0),
      finalUrl: response.url || String(url),
    };
  } catch {
    return null;
  }
}

async function saveStream(response, filePath, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
    await writeFile(filePath, buffer);
    return buffer.byteLength;
  }
  const handle = await open(filePath, "w");
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
      }
      await handle.write(value);
    }
  } finally {
    await handle.close().catch(() => {});
    if (total > maxBytes) await rm(filePath, { force: true }).catch(() => {});
  }
  return total;
}

/**
 * 把网页转成 Markdown 文件（# 标题 + 正文），文件名取页面标题。
 */
async function savePageAsMarkdown(url, { apiKey, baseUrl, dir, fetchImpl, timeoutMs, title }) {
  const page = await deepseekFetchPage({ url, apiKey, baseUrl, fetchImpl, timeoutMs });
  const pageTitle = String(title || page.title || "").trim() || "网页资料";
  let content = String(page.content ?? "").trim();
  if (!/^#\s+/.test(content)) content = `# ${pageTitle}\n\n${content}`;
  const safeName = sanitizeFileName(pageTitle, "网页资料").replace(/\.[A-Za-z0-9]{1,10}$/, "");
  const filePath = join(dir, `${safeName}.md`);
  await writeFile(filePath, content.trimEnd() + "\n", "utf8");
  return {
    path: filePath,
    title: pageTitle,
    kind: "web",
    contentType: "text/markdown",
    sourceUrl: String(url),
    size: Buffer.byteLength(content, "utf8"),
  };
}

/**
 * 获取一个远程链接，返回可交给 kb_import 的文件信息。
 * @returns {Promise<{path,title,kind,contentType,sourceUrl,size,cleanup}>}
 */
export async function acquireRemoteSource(url, {
  kbRoot,
  apiKey = "",
  baseUrl = "",
  title = "",
  fetchImpl = fetch,
  lookup = dns.lookup,
  allowPrivate = false,
  maxBytes = DEFAULT_MAX_URL_BYTES,
  timeoutMs = 120_000,
  headers = {},
} = {}) {
  const parsed = await assertPublicUrl(url, { lookup, allowPrivate });
  if (!kbRoot) throw new Error("缺少知识库根目录，无法暂存下载文件");
  const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dir = join(kbRoot, URL_STAGING_DIR, stamp);
  await mkdir(dir, { recursive: true });
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});

  try {
    const probe = await headProbe(parsed, { fetchImpl, timeoutMs, headers });
    const probeType = probe?.contentType ?? "";
    // 类型明确且是 HTML，直接走 Fetch；类型未知时也先按 HTML 试一次（失败再按下载处理）。
    if (isHtmlType(probeType) || (probe && probeType === "")) {
      if (!apiKey) throw new Error("抓取网页需要 DeepSeek API Key（宿主未配置 DEEPSEEK_API_KEY）");
      const saved = await savePageAsMarkdown(parsed, { apiKey, baseUrl, dir, fetchImpl, timeoutMs, title });
      return { ...saved, cleanup };
    }
    if (isImageType(probeType)) {
      throw new Error("不支持直接导入图片；请把图片放进 PDF/Word，或用查找功能先识别图片里的标准号/标题");
    }

    let response = null;
    let contentType = probeType;
    let disposition = probe?.disposition ?? "";
    if (probe && !isHtmlType(probeType)) {
      // 已知道是二进制时再发一次 GET；HEAD 的 content-length 只用于提前拒绝。
      if (probe.contentLength > maxBytes) {
        throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
      }
      response = await fetchImpl(parsed, {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": USER_AGENT, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } else {
      response = await fetchImpl(parsed, {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": USER_AGENT, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }
    if (response.url) await assertPublicUrl(response.url, { lookup, allowPrivate });
    contentType = contentTypeOf(response.headers) || contentType;
    disposition = response.headers.get("content-disposition") ?? disposition;
    if (isHtmlType(contentType)) {
      response.body?.cancel?.()?.catch?.(() => {});
      if (!apiKey) throw new Error("抓取网页需要 DeepSeek API Key（宿主未配置 DEEPSEEK_API_KEY）");
      const saved = await savePageAsMarkdown(parsed, { apiKey, baseUrl, dir, fetchImpl, timeoutMs, title });
      return { ...saved, cleanup };
    }
    if (isImageType(contentType)) {
      response.body?.cancel?.()?.catch?.(() => {});
      throw new Error("不支持直接导入图片；请把图片放进 PDF/Word，或用查找功能先识别图片里的标准号/标题");
    }
    const ext = inferExtension({ url: response.url || parsed, contentType, disposition });
    if (!ext) {
      response.body?.cancel?.()?.catch?.(() => {});
      throw new Error(`无法识别文件类型（Content-Type: ${contentType || "未知"}）；请确认链接指向 PDF/Word/PPT/OFD 等文件`);
    }
    let urlBase = "";
    try {
      urlBase = decodeURIComponent(basename(new URL(parsed).pathname));
    } catch {
      urlBase = basename(new URL(parsed).pathname);
    }
    const urlName = sanitizeFileName(urlBase, "downloaded");
    const fallbackName = /\.[A-Za-z0-9]{1,10}$/.test(urlName) ? urlName : `${urlName}${ext}`;
    const name = fileNameFromDisposition(disposition, fallbackName) || fallbackName;
    const finalName = /\.[A-Za-z0-9]{1,10}$/.test(name) ? name : `${name}${ext}`;
    const filePath = join(dir, finalName);
    const size = await saveStream(response, filePath, maxBytes);
    const pageTitle = String(title ?? "").trim() || basename(finalName, extname(finalName));
    return {
      path: filePath,
      title: pageTitle,
      kind: "file",
      contentType,
      sourceUrl: String(parsed),
      size,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** 启动时清理超过 24 小时的下载暂存（后台导入中断留下的文件）。 */
export async function sweepUrlStaging(kbRoot, { maxAgeMs = STAGING_MAX_AGE_MS, now = Date.now() } = {}) {
  const root = join(kbRoot, URL_STAGING_DIR);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      const info = await stat(dir);
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* 单个目录清理失败不影响启动 */
    }
  }
  return { removed };
}
