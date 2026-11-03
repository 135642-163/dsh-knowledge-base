/**
 * 宿主原生文件选择器：工作台「导入知识库包」用它直接取本机 .zip 绝对路径，
 * 大包不需要先上传、也不需要用户手输路径。
 *
 * 选择器以子进程运行，不阻塞宿主事件循环；命令边界可注入（单测用假 run），
 * 平台事实可注入（platform/scriptPath）。取消返回 { canceled: true }。
 *
 * 平台实现：
 *  - macOS：osascript `choose file`，只显示 .zip；
 *  - Windows：PowerShell + WinForms OpenFileDialog（见 data/win/pick-zip.ps1）；
 *  - Linux：优先 zenity，缺失时回退 kdialog。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const WINDOWS_PICKER_SCRIPT = join(PLUGIN_ROOT, "data", "win", "pick-zip.ps1");
export const DEFAULT_PICKER_TITLE = "选择知识库压缩包 (.zip)";
export const DEFAULT_PICKER_TIMEOUT_MS = 5 * 60 * 1000;

function escapeAppleScript(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 某平台的命令规格；Windows 走随包脚本，Linux 由 pickLocalFile 负责 zenity→kdialog 回退。 */
export function pickerCommand(platform, {
  title = DEFAULT_PICKER_TITLE,
  scriptPath = WINDOWS_PICKER_SCRIPT,
} = {}) {
  if (platform === "darwin") {
    const script = `POSIX path of (choose file with prompt "${escapeAppleScript(title)}" of type {"zip"})`;
    return { command: "osascript", args: ["-e", script] };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    };
  }
  if (platform === "linux") {
    return {
      command: "zenity",
      args: ["--file-selection", `--title=${title}`, "--file-filter=知识库包 (*.zip) | *.zip"],
    };
  }
  return null;
}

export function kdialogCommand({ title = DEFAULT_PICKER_TITLE } = {}) {
  return { command: "kdialog", args: ["--title", title, "--getopenfilename", ".", "*.zip"] };
}

/** 命令输出 → 绝对路径；空输出表示用户取消。 */
export function normalizePickedPath(stdout) {
  let text = String(stdout ?? "").trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
  if (text === "") return "";
  // 防御：mac 的 POSIX path 偶尔带尾部换行；Windows 路径即使包含空格也按整行处理。
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
}

/** 子进程错误是否表示“用户取消”，而不是选择器不可用/启动失败。 */
export function isPickerCancel(error) {
  const code = error?.code ?? error?.exitCode;
  if (code !== 1 && code !== "1") return false;
  const text = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? ""}`;
  if (!text.trim()) return true; // zenity/kdialog 取消时通常只有退出码 1
  return /cancel|取消|-128|user canceled/i.test(text);
}

function isMissingCommand(error) {
  return error?.code === "ENOENT";
}

async function defaultRun(command, args, { timeoutMs }) {
  return await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}

/**
 * 打开原生文件选择器。
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.title]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.scriptPath] Windows 脚本路径（测试注入）
 * @param {(command:string,args:string[],opts:object)=>Promise<{stdout:string,stderr?:string}>} [options.run]
 * @returns {Promise<{canceled:boolean,path?:string}>}
 */
export async function pickLocalFile({
  platform = process.platform,
  title = DEFAULT_PICKER_TITLE,
  timeoutMs = DEFAULT_PICKER_TIMEOUT_MS,
  scriptPath = WINDOWS_PICKER_SCRIPT,
  run = defaultRun,
} = {}) {
  const primary = pickerCommand(platform, { title, scriptPath });
  if (!primary) throw new Error(`当前平台（${platform}）不支持原生文件选择器`);
  const attempts = [primary];
  if (platform === "linux") attempts.push(kdialogCommand({ title }));

  let lastError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const spec = attempts[index];
    try {
      const result = await run(spec.command, spec.args, { timeoutMs });
      const path = normalizePickedPath(result?.stdout);
      if (path === "") return { canceled: true };
      return { canceled: false, path };
    } catch (error) {
      if (isPickerCancel(error)) return { canceled: true };
      lastError = error;
      // Linux：zenity 未安装时回退 kdialog；其它错误（含对话框启动失败）直接上抛。
      if (isMissingCommand(error) && index + 1 < attempts.length) continue;
      throw error;
    }
  }
  throw lastError ?? new Error("无法打开原生文件选择器");
}
