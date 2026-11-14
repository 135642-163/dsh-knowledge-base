/**
 * 本地 RapidOCR 一键安装（工作台设置/上传弹窗用）。
 *
 * 实际安装逻辑在 scripts/ocr-setup.mjs（可单独在终端运行，也随 npm 包分发）；
 * 这里只负责：状态缓存、受控 spawn、把 stdout 翻成进度、超时终止。
 * 不把绝对路径/密钥带进错误 message；诊断信息只保留脱敏后的末尾几行。
 */
import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ocrEngineStatus } from "./ocr.js";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const OCR_INSTALL_SCRIPT = join(pluginRoot, "scripts", "ocr-setup.mjs");
export const OCR_INSTALL_TIMEOUT_MS = 20 * 60_000;
const STATUS_CACHE_MS = 10_000;

let statusCache = { at: 0, value: null };

/** 本机 OCR 状态（10 秒缓存，安装后 force 刷新）。 */
export async function ocrLocalStatus({ force = false, now = Date.now() } = {}) {
  if (!force && statusCache.value && now - statusCache.at < STATUS_CACHE_MS) {
    return statusCache.value;
  }
  const value = await ocrEngineStatus();
  statusCache = { at: now, value };
  return value;
}

function progressText(line) {
  const text = String(line ?? "");
  if (/下载 micromamba/i.test(text)) return "正在下载 micromamba…";
  if (/创建 Python/i.test(text)) return "正在创建 Python 环境…";
  if (/安装 rapidocr/i.test(text)) return "正在安装 RapidOCR（约 100–200 MB）…";
  if (/pip 安装失败|失败/i.test(text)) return "安装遇到错误，请查看诊断信息";
  if (/安装完成/i.test(text)) return "安装完成，正在校验…";
  return "";
}

/**
 * 运行 scripts/ocr-setup.mjs。
 * @returns {Promise<{installed: boolean, status: object}>}
 */
export function installRapidOcr({
  spawn = nodeSpawn,
  onProgress,
  timeoutMs = OCR_INSTALL_TIMEOUT_MS,
  script = OCR_INSTALL_SCRIPT,
  env = process.env,
  cwd = pluginRoot,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [script], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`无法启动本地 OCR 安装器：${error?.message ?? error}`));
      return;
    }
    let settled = false;
    let tail = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(new Error("本地 OCR 安装超时（20 分钟），请检查网络后重试"));
    }, timeoutMs);
    timer.unref?.();

    const onData = (chunk) => {
      const text = String(chunk ?? "");
      tail = (tail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) {
        const message = progressText(line);
        if (message) onProgress?.({ phase: "install", text: message });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`本地 OCR 安装器启动失败：${error?.message ?? error}`));
    });
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        // 诊断只保留脱敏后的末尾；message 固定，不把用户目录带出去。
        const safeTail = tail
          .replace(/\/Users\/[^/\s]+/g, "~")
          .replace(/[A-Za-z]:\\\\Users\\\\[^\\\\\s]+/g, "~")
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join("\n");
        const error = new Error("本地 OCR 安装失败（退出码非 0），请检查网络/代理后重试");
        error.details = { exitCode: code, logTail: safeTail };
        reject(error);
        return;
      }
      try {
        const status = await ocrLocalStatus({ force: true });
        if (!status.rapidocr?.available) {
          reject(new Error("安装完成但 RapidOCR 仍不可用，请查看安装日志"));
          return;
        }
        resolve({ installed: true, status });
      } catch (error) {
        reject(error);
      }
    });
  });
}
