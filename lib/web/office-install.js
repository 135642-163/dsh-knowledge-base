/**
 * Office 转换引擎（LibreOfficeKit）一键安装。
 *
 * 安装目录固定为 ~/.dsh/tools/libreoffice-kit（可用 DSH_OFFICE_KIT_HOME 覆盖），
 * 里面只有 package.json 与 node_modules/，与工作台数据完全隔离。安装器只做三件事：
 *  1. 探测可用的包管理器（DSH 自带 pnpm → DSH_PNPM → PATH 里的 pnpm/npm）；
 *  2. 以该目录为 cwd 执行 add/install --ignore-scripts（引擎包带可选原生二进制）；
 *  3. 跑一次 `<node> <cli> capabilities` 确认 JSON 里有 conversions，才算成功。
 *
 * 安全约定：所有抛出的 message 都是固定文案，绝不含绝对路径；诊断信息只放进
 * error.details（exitCode / logTail），由本地工作台按需展示。
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { resolveOfficeCli } from "./preview.js";
import { redactPaths } from "./redact.js";

/** 安装器锁定的引擎版本：主包与平台引擎包必须同版本。 */
export const PKG_VERSION = "0.2.2";
export const ENTRY_PACKAGE = `@deepseek-ai/libreoffice-kit@${PKG_VERSION}`;
export const INSTALL_TIMEOUT_MS = 20 * 60_000;
const VERIFY_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 10_000;
const STATUS_CACHE_MS = 5_000;
const LOG_MAX_LINES = 40;
const LOG_LINE_MAX_CHARS = 400;
const TIMEOUT = Symbol("timeout");

/** 平台 → 引擎包（不含 scope 与版本号）；Linux 统一走 wasm 包。 */
const ENGINE_NAMES = Object.freeze({
  "darwin-arm64": "libreoffice-kit-darwin-arm64",
  "darwin-x64": "libreoffice-kit-darwin-x64",
  "win32-x64": "libreoffice-kit-win32-x64",
  "win32-arm64": "libreoffice-kit-win32-arm64",
});

/** 安装目录：默认 ~/.dsh/tools/libreoffice-kit，DSH_OFFICE_KIT_HOME 可覆盖。 */
export function officeInstallDir({ env = process.env, home = homedir() } = {}) {
  const configured = String(env?.DSH_OFFICE_KIT_HOME ?? "").trim();
  if (configured === "") return join(home, ".dsh", "tools", "libreoffice-kit");
  if (configured === "~") return home;
  if (configured.startsWith("~/")) return join(home, configured.slice(2));
  return resolve(configured);
}

export const INSTALL_DIR = officeInstallDir();

/** 安装/校验失败的机器码错误；message 固定文案，details 只放本地诊断信息。 */
export class OfficeInstallError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "OfficeInstallError";
    this.code = code;
    if (details) this.details = details;
  }
}

/** 当前平台对应的引擎包名（含 scope，不含版本）。未知平台抛 OFFICE_PLATFORM_UNSUPPORTED。 */
export function enginePackageFor(platform = process.platform, arch = process.arch) {
  if (platform === "linux") return "@deepseek-ai/libreoffice-kit-wasm";
  const name = ENGINE_NAMES[`${platform}-${arch}`];
  if (!name) {
    throw new OfficeInstallError(
      "OFFICE_PLATFORM_UNSUPPORTED",
      "当前平台不支持自动安装 Office 转换引擎",
      { platform, arch },
    );
  }
  return `@deepseek-ai/${name}`;
}

/** 平台是否有可下载的引擎包；用于状态查询，不抛错。 */
export function platformSupported(platform = process.platform, arch = process.arch) {
  try {
    enginePackageFor(platform, arch);
    return true;
  } catch {
    return false;
  }
}

/** 默认安装位置里的 CLI；校验时优先检查它，避免被其它配置的 CLI 误导。 */
export function installedCliPath(installDir = INSTALL_DIR) {
  return join(installDir, "node_modules", "@deepseek-ai", "libreoffice-kit", "lib", "cli.js");
}

function whichOnPath(name, { env, exists, platform }) {
  const raw = String(env?.PATH ?? "");
  if (raw === "") return null;
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of raw.split(delimiter)) {
    if (dir === "") continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (exists(candidate)) return resolve(candidate);
    }
  }
  return null;
}

/**
 * 包管理器探测：优先用 DSH 自带的 pnpm（node <pnpm.mjs>），
 * 其次 DSH_PNPM，最后 PATH 里的 pnpm / npm / npm.cmd。
 * 返回 { kind, command, argsPrefix }；都没有时返回 null。
 */
export function detectToolchain({
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
  which,
  platform = process.platform,
} = {}) {
  const find = typeof which === "function"
    ? which
    : (name) => whichOnPath(name, { env, exists, platform });

  const bundledPnpm = join(dirname(execPath), "..", "..", "pnpm", "bin", "pnpm.mjs");
  if (exists(bundledPnpm)) {
    return { kind: "pnpm", command: execPath, argsPrefix: [resolve(bundledPnpm)] };
  }

  const configured = String(env?.DSH_PNPM ?? "").trim();
  if (configured !== "") return { kind: "pnpm", command: configured, argsPrefix: [] };

  for (const name of ["pnpm", "npm", "npm.cmd"]) {
    const found = find(name);
    if (found) return { kind: name.startsWith("pnpm") ? "pnpm" : "npm", command: String(found), argsPrefix: [] };
  }
  return null;
}

/**
 * 纯函数安装计划（测试直接断言）：
 * pnpm 用 `add`，npm 用 `install`；两者都带 --ignore-scripts，
 * 避免第三方 postinstall 在用户机器上执行任意脚本。
 */
export function buildInstallPlan({
  platform = process.platform,
  arch = process.arch,
  toolchain = null,
  installDir = INSTALL_DIR,
} = {}) {
  const enginePackage = enginePackageFor(platform, arch);
  const packages = [ENTRY_PACKAGE, `${enginePackage}@${PKG_VERSION}`];
  const action = toolchain?.kind === "npm" ? "install" : "add";
  const argsPrefix = Array.isArray(toolchain?.argsPrefix) ? toolchain.argsPrefix : [];
  const args = [...argsPrefix, action, "--ignore-scripts", ...packages];
  return {
    platform,
    arch,
    installDir,
    enginePackage,
    toolchain,
    command: toolchain?.command ?? null,
    action,
    args,
    packages,
  };
}

function resolveDeps(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const execPath = deps.execPath ?? process.execPath;
  const exists = deps.exists ?? existsSync;
  const toolchain = deps.toolchain !== undefined
    ? deps.toolchain
    : detectToolchain({ env, execPath, exists, which: deps.which, platform });
  const installDir = deps.installDir ?? officeInstallDir({ env, home });
  const spawn = deps.spawn ?? nodeSpawn;
  const resolveCli = typeof deps.resolveCli === "function"
    ? deps.resolveCli
    : (configured) => resolveOfficeCli(configured, { env, home, exists });
  const capabilities = typeof deps.capabilities === "function"
    ? deps.capabilities
    : (cliPath, options) => probeCapabilities(cliPath, {
      spawn,
      exists,
      execPath,
      platform,
      timeoutMs: options?.timeoutMs ?? VERIFY_TIMEOUT_MS,
    });
  return {
    platform,
    arch,
    env,
    home,
    execPath,
    exists,
    toolchain,
    installDir,
    spawn,
    resolveCli,
    capabilities,
    now: deps.now ?? Date.now,
    installTimeoutMs: deps.installTimeoutMs,
    verifyTimeoutMs: deps.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS,
    spawnEnv: deps.spawnEnv ?? { ...process.env, ...env },
  };
}

function createLogTail({ maxLines = LOG_MAX_LINES, maxChars = LOG_LINE_MAX_CHARS } = {}) {
  const lines = [];
  let pending = "";
  const push = (line) => {
    const clean = String(line).replace(/\r$/, "").trim();
    if (clean === "") return;
    lines.push(clean.length > maxChars ? clean.slice(0, maxChars) : clean);
    if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
  };
  return {
    lines,
    write(chunk) {
      pending += String(chunk ?? "");
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        push(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
      // 无换行的超长输出（npm 进度条等）只保留前 maxChars，避免无限增长。
      if (pending.length > maxChars * 2) {
        push(pending.slice(0, maxChars));
        pending = "";
      }
    },
    flush() {
      if (pending.trim() !== "") push(pending);
      pending = "";
    },
  };
}

function killProcessTree(child, platform = process.platform) {
  if (!child) return;
  if (platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      /* 进程组已退出时回退到单进程 kill */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already exited */
  }
}

function waitForExit(child, timeoutMs, platform) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(code);
    };
    timer = setTimeout(() => {
      killProcessTree(child, platform);
      finish(TIMEOUT);
    }, timeoutMs);
    child.once("error", () => finish(-1));
    child.once("close", (code) => finish(Number.isInteger(code) ? code : -1));
  });
}

function hasConversions(payload) {
  return Array.isArray(payload?.conversions) && payload.conversions.length > 0;
}

/** 跑 `<node> <cli> capabilities`，成功且输出 JSON 时返回对象；失败/超时返回 null。 */
export function probeCapabilities(
  cliPath,
  {
    spawn = nodeSpawn,
    exists = existsSync,
    execPath = process.execPath,
    platform = process.platform,
    timeoutMs = VERIFY_TIMEOUT_MS,
  } = {},
) {
  if (typeof cliPath !== "string" || cliPath === "" || !exists(cliPath)) {
    return Promise.resolve(null);
  }
  const useNode = cliPath.toLowerCase().endsWith(".js");
  const command = useNode ? execPath : cliPath;
  const args = useNode ? [cliPath, "capabilities"] : ["capabilities"];
  let child;
  try {
    child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: platform !== "win32",
    });
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolvePromise) => {
    let output = "";
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(value);
    };
    child.stdout?.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-200_000);
    });
    child.stderr?.on("data", () => {});
    timer = setTimeout(() => {
      killProcessTree(child, platform);
      finish(null);
    }, timeoutMs);
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      if (code !== 0) return finish(null);
      try {
        const parsed = JSON.parse(output);
        finish(parsed !== null && typeof parsed === "object" ? parsed : null);
      } catch {
        finish(null);
      }
    });
  });
}

async function ensureProjectDir(installDir) {
  await mkdir(installDir, { recursive: true });
  try {
    await writeFile(
      join(installDir, "package.json"),
      `${JSON.stringify({ name: "dsh-office-kit", private: true }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function safeTail(log, installDir, home) {
  const prefixes = [installDir, home].filter(Boolean);
  return log.lines.map((line) => redactPaths(line, prefixes));
}

async function runInstall({ onProgress, timeoutMs, deps } = {}) {
  const d = resolveDeps(deps);
  const plan = buildInstallPlan({
    platform: d.platform,
    arch: d.arch,
    toolchain: d.toolchain,
    installDir: d.installDir,
  });
  if (!plan.command) {
    throw new OfficeInstallError(
      "OFFICE_TOOLCHAIN_MISSING",
      "未找到 Node/npm，无法自动安装 Office 转换引擎；请先安装 Node.js（含 npm）后重试",
    );
  }

  try {
    await ensureProjectDir(plan.installDir);
  } catch {
    throw new OfficeInstallError("OFFICE_INSTALL_FAILED", "Office 转换引擎安装失败");
  }

  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : d.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
  const log = createLogTail();
  onProgress?.({ phase: "download", text: "正在下载并安装…" });

  let child;
  try {
    child = d.spawn(plan.command, plan.args, {
      cwd: plan.installDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: d.platform !== "win32",
      env: d.spawnEnv,
    });
  } catch {
    throw new OfficeInstallError("OFFICE_INSTALL_FAILED", "Office 转换引擎安装失败");
  }
  child.stdout?.on("data", (chunk) => log.write(chunk));
  child.stderr?.on("data", (chunk) => log.write(chunk));

  const exitCode = await waitForExit(child, timeout, d.platform);
  log.flush();
  if (exitCode === TIMEOUT) {
    throw new OfficeInstallError("OFFICE_INSTALL_TIMEOUT", "Office 转换引擎安装超时", {
      logTail: safeTail(log, plan.installDir, d.home),
    });
  }
  if (exitCode !== 0) {
    throw new OfficeInstallError("OFFICE_INSTALL_FAILED", "Office 转换引擎安装失败", {
      exitCode,
      logTail: safeTail(log, plan.installDir, d.home),
    });
  }

  onProgress?.({ phase: "verify", text: "正在校验安装…" });
  const expectedCli = installedCliPath(plan.installDir);
  let cliPath = d.exists(expectedCli) ? resolve(expectedCli) : null;
  if (!cliPath) {
    // 默认 resolveOfficeCli 只返回真实存在的路径；注入实现由 capabilities 再做最终确认。
    const resolved = d.resolveCli("");
    if (resolved) cliPath = resolve(resolved);
  }
  if (!cliPath) {
    throw new OfficeInstallError("OFFICE_VERIFY_FAILED", "Office 转换引擎安装后校验失败", {
      logTail: safeTail(log, plan.installDir, d.home),
    });
  }

  let payload = null;
  try {
    payload = await d.capabilities(cliPath, { timeoutMs: d.verifyTimeoutMs });
  } catch {
    payload = null;
  }
  if (!hasConversions(payload)) {
    throw new OfficeInstallError("OFFICE_VERIFY_FAILED", "Office 转换引擎安装后校验失败", {
      logTail: safeTail(log, plan.installDir, d.home),
    });
  }

  // 安装成功：清掉状态探测的负缓存，下一次 /office/status 立即看到新引擎。
  statusCache.clear();
  return {
    cliPath,
    version: typeof payload?.runtime?.version === "string" ? payload.runtime.version : PKG_VERSION,
    logTail: safeTail(log, plan.installDir, d.home),
  };
}

/** 模块级单飞：并发的安装请求共享同一个 Promise，避免两个包管理器同时写 node_modules。 */
let installPromise = null;
const installListeners = new Set();

/**
 * 一键安装引擎。成功返回 { cliPath, version, logTail }；
 * 失败抛 OfficeInstallError（message 固定文案，details.logTail 供本地排查）。
 */
export async function installOfficeKit({ onProgress, timeoutMs, deps } = {}) {
  if (installPromise) return installPromise;
  if (typeof onProgress === "function") installListeners.add(onProgress);
  const report = (progress) => {
    for (const listener of installListeners) {
      try {
        listener(progress);
      } catch {
        /* 进度回调失败不能打断安装 */
      }
    }
  };
  let task;
  task = (async () => {
    try {
      return await runInstall({ onProgress: report, timeoutMs, deps });
    } finally {
      if (installPromise === task) installPromise = null;
      installListeners.delete(onProgress);
    }
  })();
  installPromise = task;
  return task;
}

/** 进程内状态能力缓存：5 秒内重复查询不重复拉起 CLI。 */
const statusCache = new Map();

/**
 * 引擎状态：
 * available = 解析到的 CLI 存在且 capabilities 里有 conversions（5 秒缓存）；
 * running    = 当前进程有一次安装在进行；
 * canInstall = 平台受支持且探测到 pnpm/npm。
 */
export async function officeEngineStatus({ cliPath, deps } = {}) {
  const d = resolveDeps(deps);
  const running = installPromise !== null;
  const toolchain = d.toolchain;
  const platformOk = platformSupported(d.platform, d.arch);
  const canInstall = platformOk && toolchain !== null;
  const base = {
    running,
    installDir: d.installDir,
    platform: d.platform,
    arch: d.arch,
    canInstall,
    toolchain: toolchain?.kind ?? null,
  };

  if (running) return { available: false, ...base, reason: "installing" };

  const configured = typeof cliPath === "string" && cliPath.trim() !== "" ? cliPath : undefined;
  let engineCli = null;
  try {
    if (configured !== undefined) {
      engineCli = d.resolveCli(configured);
    } else {
      // 未显式配置时优先看「本安装器写入的目录」：自定义 DSH_OFFICE_KIT_HOME 也能被状态接口看到。
      const expected = installedCliPath(d.installDir);
      engineCli = d.exists(expected) ? resolve(expected) : d.resolveCli(undefined);
    }
  } catch {
    engineCli = null;
  }
  if (!engineCli || !d.exists(engineCli)) {
    const reason = platformOk ? (canInstall ? "engine-missing" : "toolchain-missing") : "unsupported-platform";
    return { available: false, ...base, reason };
  }

  const cached = statusCache.get(engineCli);
  if (cached && cached.expiresAt > d.now()) {
    return cached.ok
      ? { available: true, ...base, version: cached.version }
      : { available: false, ...base, reason: "engine-broken" };
  }

  let payload = null;
  try {
    payload = await d.capabilities(engineCli, { timeoutMs: STATUS_TIMEOUT_MS });
  } catch {
    payload = null;
  }
  const ok = hasConversions(payload);
  const version = typeof payload?.runtime?.version === "string" ? payload.runtime.version : undefined;
  statusCache.set(engineCli, { ok, version, expiresAt: d.now() + STATUS_CACHE_MS });
  return ok
    ? { available: true, ...base, version }
    : { available: false, ...base, reason: "engine-broken" };
}

/** 测试用：清空单飞 Promise、进度监听与状态缓存。 */
export function resetOfficeInstallForTests() {
  installPromise = null;
  installListeners.clear();
  statusCache.clear();
}
