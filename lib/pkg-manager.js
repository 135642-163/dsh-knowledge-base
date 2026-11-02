/**
 * 跨平台包管理器定位与启动（0.39.1）。
 *
 * 背景：Node ≥ 20.12（CVE-2024-27980 的修复）在 Windows 上直接 spawn 一个
 * `.cmd`/`.bat` 会抛 `EINVAL`，不再隐式走 shell；而 npm / pnpm 在 Windows 上恰好
 * 都是 `.cmd` 垫片（npm.cmd、pnpm.cmd），Node 安装目录里还同时有一个给 sh 用的
 * 无扩展名 `npm`。直接 spawn 这两类文件就会得到 `spawn EINVAL`，表现为
 * 「Office 转换引擎安装失败」「一键准备报 spawn EINVAL」。
 *
 * 这里的做法是**不经过 shell**，把垫片翻译成「用 node 执行 CLI js」：
 *   npm.cmd  → <node> <…/node_modules/npm/bin/npm-cli.js>  <args>
 *   pnpm.cmd → <node> <…/node_modules/pnpm/bin/pnpm.cjs>   <args>
 * 只有实在找不到 CLI js 时才退回 `cmd.exe /d /s /c`，并把每个 token 都加双引号
 * （引号内的 `^` 不参与 cmd 转义，`onnxruntime-node@^1.31.1` 这类参数能原样保留）。
 *
 * 同时提供 DSH 自带 pnpm 的定位：DSH 只随包提供 node + pnpm（没有 npm），
 * 位置随安装形态不同（Windows 在 <app>/resources/runtime/…，macOS 在
 * <app>/Contents/Resources/runtime/…）。找到后一律用 `process.execPath`（DSH 的
 * Electron 进程带 ELECTRON_RUN_AS_NODE=1）执行 pnpm.cjs，不依赖系统 PATH。
 */
import { existsSync } from "node:fs";
import { delimiter, extname, posix, win32 } from "node:path";

const WINDOWS_SHIM = /\.(cmd|bat)$/i;
const PNPM_CLI_NAMES = ["pnpm.cjs", "pnpm.mjs"];

/** 按路径风格选 path 实现：Windows 盘符/反斜杠走 win32，其余走 posix（便于跨平台单测）。 */
function pathFor(value) {
  const text = String(value ?? "");
  return /^[a-zA-Z]:[\\/]/.test(text) || text.includes("\\") ? win32 : posix;
}

/**
 * PATH 查找可执行文件。
 * Windows 只认 .exe/.cmd/.bat：Node 安装目录里的无扩展名 `npm` 是 sh 脚本，
 * 在 Windows 上不可执行，返回它会让 spawn 直接失败。
 */
export function findOnPath(name, { env = process.env, exists = existsSync, platform = process.platform } = {}) {
  const raw = String(env?.PATH ?? env?.Path ?? "");
  if (raw === "") return null;
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of raw.split(delimiter)) {
    if (dir === "") continue;
    const paths = pathFor(dir);
    for (const extension of extensions) {
      const candidate = paths.resolve(paths.join(dir, `${name}${extension}`));
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** DSH 自带 pnpm 的 pnpm.cjs/pnpm.mjs 绝对路径；没有安装包时返回 null。 */
export function findBundledPnpm({ execPath = process.execPath, exists = existsSync } = {}) {
  const paths = pathFor(execPath);
  const base = paths.dirname(String(execPath ?? ""));
  const roots = [
    // Windows / Linux：<app>/resources/runtime/primary-runtime/dependencies/pnpm/bin
    paths.join(base, "resources", "runtime", "primary-runtime", "dependencies", "pnpm", "bin"),
    // macOS：<app>/Contents/MacOS/../../../Resources/runtime/...（dirname 是 Contents/MacOS）
    paths.join(base, "..", "Resources", "runtime", "primary-runtime", "dependencies", "pnpm", "bin"),
    // 开发态 / 旧包布局
    paths.join(base, "runtime", "primary-runtime", "dependencies", "pnpm", "bin"),
    paths.join(base, "..", "..", "pnpm", "bin"),
  ];
  for (const root of roots) {
    for (const name of PNPM_CLI_NAMES) {
      const candidate = paths.resolve(paths.join(root, name));
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** npm 垫片 → npm-cli.js（标准 Node 安装布局 / POSIX 全局安装布局）。 */
export function npmCliEntry(shimPath, { exists = existsSync } = {}) {
  const paths = pathFor(shimPath);
  const dir = paths.dirname(String(shimPath ?? ""));
  const candidates = [
    paths.resolve(paths.join(dir, "node_modules", "npm", "bin", "npm-cli.js")),
    paths.resolve(paths.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** pnpm 垫片 → pnpm.cjs（npm 全局安装的 pnpm 布局）。 */
export function pnpmCliEntry(shimPath, { exists = existsSync } = {}) {
  const paths = pathFor(shimPath);
  const dir = paths.dirname(String(shimPath ?? ""));
  const candidates = [
    paths.resolve(paths.join(dir, "node_modules", "pnpm", "bin", "pnpm.cjs")),
    paths.resolve(paths.join(dir, "node_modules", "pnpm", "bin", "pnpm.mjs")),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

function quoteForCmd(token) {
  return `"${String(token ?? "").replace(/"/g, '""')}"`;
}

/** 兜底：整个命令行交给 cmd.exe，每个 token 都加引号，避免 ^ % 被 cmd 解释。 */
function windowsCmdSpec(command, args, env = process.env) {
  const comspec = String(env?.ComSpec || env?.COMSPEC || "cmd.exe");
  const line = [command, ...args].map(quoteForCmd).join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * 把「要执行的包管理器命令」翻译成可安全 spawn 的 { command, args }。
 * - 非 Windows：原样返回；
 * - Windows + .exe：原样返回；
 * - Windows + .cmd/.bat：优先 node + CLI js，其次 cmd.exe；
 * - Windows + 无扩展名（Node 安装目录里的 npm/pnpm sh 脚本）：先找同名 .cmd。
 */
export function resolveSpawnSpec({
  platform = process.platform,
  command,
  args = [],
  execPath = process.execPath,
  exists = existsSync,
  env = process.env,
} = {}) {
  const cmd = String(command ?? "");
  const argv = Array.isArray(args) ? [...args] : [];
  if (platform !== "win32") return { command: cmd, args: argv };
  const ext = extname(cmd).toLowerCase();
  if (WINDOWS_SHIM.test(cmd)) {
    const cli = npmCliEntry(cmd, { exists }) ?? pnpmCliEntry(cmd, { exists });
    if (cli) return { command: execPath, args: [cli, ...argv] };
    return windowsCmdSpec(cmd, argv, env);
  }
  if (ext === "") {
    const withCmd = `${cmd}.cmd`;
    if (exists(withCmd)) {
      return resolveSpawnSpec({ platform, command: withCmd, args: argv, execPath, exists, env });
    }
    return windowsCmdSpec(cmd, argv, env);
  }
  return { command: cmd, args: argv };
}
