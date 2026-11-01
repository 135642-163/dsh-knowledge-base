/**
 * 标准网 Cookie 的安全存储。
 *
 * - macOS: Keychain（security add/find/delete-generic-password）
 * - Linux: Secret Service（secret-tool）
 * - Windows: DPAPI（CurrentUser）加密文件 ~/.dsh/knowledge-wiki/bzCookie.dpapi
 *
 * Cookie 不写日志、不出现在工具返回值里；读取失败返回 null（没有条目/后端不可用），
 * 保存失败抛出错误，由调用方决定是否回退旧配置。
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
export const COOKIE_SERVICE = "dsh-knowledge-wiki";
export const COOKIE_ACCOUNT = "biaozhun.org";

export function secureStorageKind(platform = process.platform) {
  if (platform === "darwin") return "macos-keychain";
  if (platform === "linux") return "secret-service";
  if (platform === "win32") return "windows-dpapi";
  return "unsupported";
}

function defaultDpapiPath() {
  return join(homedir(), ".dsh", "knowledge-wiki", "bzCookie.dpapi");
}

export function secureCookieMarkerPath() {
  return join(homedir(), ".dsh", "knowledge-wiki", "bzCookie.enabled");
}

/** 是否已经通过 set-bz-cookie 脚本启用安全存储（避免每次启动都访问钥匙串）。 */
export async function hasSecureCookie(markerPath = secureCookieMarkerPath()) {
  try {
    await access(markerPath);
    return true;
  } catch {
    return false;
  }
}

async function runWithInput(command, args, input, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`));
    });
    child.stdin?.end(String(input ?? ""));
  });
}

async function runCommand(command, args, options = {}) {
  const { input, ...rest } = options;
  if (input !== undefined) return await runWithInput(command, args, input, rest);
  const { stdout } = await execFileAsync(command, args, {
    timeout: 8000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    ...rest,
  });
  return String(stdout ?? "").trim();
}

/** 读取；没有条目或后端不可用时返回 null。 */
export async function readSecureCookie({ platform = process.platform, run = runCommand, dpapiPath = defaultDpapiPath() } = {}) {
  try {
    if (platform === "darwin") {
      return String(await run("security", ["find-generic-password", "-s", COOKIE_SERVICE, "-a", COOKIE_ACCOUNT, "-w"]) ?? "").trim() || null;
    }
    if (platform === "linux") {
      return String(await run("secret-tool", ["lookup", "service", COOKIE_SERVICE, "account", COOKIE_ACCOUNT]) ?? "").trim() || null;
    }
    if (platform === "win32") {
      const script = [
        "$p = Join-Path $env:USERPROFILE '.dsh\\knowledge-wiki\\bzCookie.dpapi'",
        "if (-not (Test-Path -LiteralPath $p)) { exit 3 }",
        "$e = [Convert]::FromBase64String((Get-Content -LiteralPath $p -Raw))",
        "$b = [Security.Cryptography.ProtectedData]::Unprotect($e, $null, 'CurrentUser')",
        "[Text.Encoding]::UTF8.GetString($b)",
      ].join("; ");
      return String(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]) ?? "").trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

async function markEnabled(markerPath = secureCookieMarkerPath()) {
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, "1\n", { mode: 0o600 });
}

/** 保存；空 Cookie 拒绝；后端不可用/命令失败时抛错。 */
export async function saveSecureCookie(cookie, { platform = process.platform, run = runCommand, markerPath = secureCookieMarkerPath() } = {}) {
  const value = String(cookie ?? "").trim();
  if (!value) throw new Error("bzCookie 为空，拒绝写入安全存储");
  if (platform === "darwin") {
    await run("security", ["add-generic-password", "-s", COOKIE_SERVICE, "-a", COOKIE_ACCOUNT, "-w", value, "-U"]);
    await markEnabled(markerPath);
    return { backend: "macos-keychain" };
  }
  if (platform === "linux") {
    await run("secret-tool", ["store", "--label", "DSH knowledge-wiki biaozhun.org", "service", COOKIE_SERVICE, "account", COOKIE_ACCOUNT], {
      input: value,
    });
    await markEnabled(markerPath);
    return { backend: "secret-service" };
  }
  if (platform === "win32") {
    const script = [
      "$dir = Join-Path $env:USERPROFILE '.dsh\\knowledge-wiki'",
      "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
      "$p = Join-Path $dir 'bzCookie.dpapi'",
      "$b = [Text.Encoding]::UTF8.GetBytes($env:DSH_SECURE_COOKIE)",
      "$e = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')",
      "[IO.File]::WriteAllText($p, [Convert]::ToBase64String($e))",
    ].join("; ");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, DSH_SECURE_COOKIE: value },
    });
    await markEnabled(markerPath);
    return { backend: "windows-dpapi" };
  }
  throw new Error(`当前平台不支持安全存储 bzCookie（${platform}）`);
}

/** 删除；不存在视为成功。 */
export async function clearSecureCookie({ platform = process.platform, run = runCommand, dpapiPath = defaultDpapiPath(), markerPath = secureCookieMarkerPath() } = {}) {
  try {
    if (platform === "darwin") {
      await run("security", ["delete-generic-password", "-s", COOKIE_SERVICE, "-a", COOKIE_ACCOUNT]);
    } else if (platform === "linux") {
      await run("secret-tool", ["clear", "service", COOKIE_SERVICE, "account", COOKIE_ACCOUNT]);
    } else if (platform === "win32") {
      await rm(dpapiPath, { force: true });
    }
    await rm(markerPath, { force: true }).catch(() => {});
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function secureCookieStatus({ platform = process.platform } = {}) {
  const backend = secureStorageKind(platform);
  return { backend, available: backend !== "unsupported", platform };
}
