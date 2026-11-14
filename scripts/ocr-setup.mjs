#!/usr/bin/env node
/**
 * 本地 OCR 一键安装（其他机器首次使用）。
 *
 * 目标：在任意 macOS / Linux / Windows 机器上把 RapidOCR 装到
 * `~/.dsh/tools/rapidocr-env`，装好后插件 `ocrEngine=auto` 会自动优先用它；
 * 未装时插件仍能用内置 WASM 引擎，只是慢一些。
 *
 * 用法：
 *   node scripts/ocr-setup.mjs            # 安装（已就绪则直接退出）
 *   node scripts/ocr-setup.mjs --check    # 只检查，不下载
 *   node scripts/ocr-setup.mjs --force    # 删除旧环境后重装
 *
 * 实现：优先用现成 micromamba；没有则从 micro.mamba.pm 下载官方静态包，
 * 创建 Python 3.11 环境并 pip 安装 rapidocr_onnxruntime（含 ONNX Runtime 与模型）。
 * 不修改系统 Python，不需要管理员权限；网络失败会给出明确错误。
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HOME = process.env.HOME || homedir();
const TOOLS = join(HOME, ".dsh", "tools");
const ENV_DIR = join(TOOLS, "rapidocr-env");
const BIN_DIR = join(TOOLS, "bin");
const MAMBA_ROOT = join(TOOLS, "mamba");
const VERIFY_CODE = "from rapidocr_onnxruntime import RapidOCR; import onnxruntime; print('ok')";

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
const FORCE = args.has("--force");

function log(message) {
  console.log(`[ocr-setup] ${message}`);
}

function fail(message) {
  console.error(`[ocr-setup] 失败：${message}`);
  process.exit(1);
}

function pythonCandidates() {
  return [
    join(ENV_DIR, "bin", "python"),
    join(ENV_DIR, "python"),
    join(ENV_DIR, "python.exe"),
    join(ENV_DIR, "Scripts", "python.exe"),
  ];
}

function findPython() {
  for (const candidate of pythonCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function run(command, argv, { env = process.env, quiet = false } = {}) {
  const result = spawnSync(command, argv, {
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    env,
    timeout: 30 * 60 * 1000,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error ?? null,
  };
}

function isReady(python) {
  if (!python) return false;
  const result = run(python, ["-c", VERIFY_CODE], { quiet: true });
  return result.ok;
}

function platformKey() {
  if (process.platform === "darwin" && process.arch === "arm64") return "osx-arm64";
  if (process.platform === "darwin") return "osx-64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-aarch64";
  if (process.platform === "linux") return "linux-64";
  if (process.platform === "win32") return "win-64";
  return "";
}

function findExecutableOnPath(name) {
  const pathValue = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

async function downloadMicromamba() {
  const key = platformKey();
  if (!key) fail(`不支持的平台：${process.platform}/${process.arch}，请手动安装 RapidOCR 到 ${ENV_DIR}`);
  mkdirSync(BIN_DIR, { recursive: true });
  const url = `https://micro.mamba.pm/api/micromamba/${key}/latest`;
  log(`下载 micromamba（${key}）…`);
  let response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (error) {
    fail(`下载 micromamba 失败：${error?.message ?? error}（可手动安装 micromamba 后重试）`);
  }
  if (!response.ok) fail(`下载 micromamba 失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const archive = join(tmpdir(), `micromamba-${Date.now()}.tar.bz2`);
  writeFileSync(archive, buffer);
  const extractDir = join(tmpdir(), `micromamba-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });
  const tar = run("tar", ["-xjf", archive, "-C", extractDir], { quiet: true });
  rmSync(archive, { force: true });
  if (!tar.ok) fail(`解压 micromamba 失败：${tar.stderr || tar.error?.message || "tar 不可用"}`);

  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (name === "micromamba" || name === "micromamba.exe") found.push(full);
    }
  };
  walk(extractDir);
  if (found.length === 0) fail("下载包里没有 micromamba 可执行文件");
  const target = join(BIN_DIR, process.platform === "win32" ? "micromamba.exe" : "micromamba");
  writeFileSync(target, readFileSync(found[0]));
  try { chmodSync(target, 0o755); } catch { /* Windows 不需要 */ }
  rmSync(extractDir, { recursive: true, force: true });
  log(`micromamba 已就绪：${target}`);
  return target;
}

function resolveMicromamba() {
  const local = join(BIN_DIR, process.platform === "win32" ? "micromamba.exe" : "micromamba");
  if (existsSync(local)) return local;
  const onPath = findExecutableOnPath("micromamba");
  if (onPath) return onPath;
  return "";
}

async function install() {
  if (FORCE && existsSync(ENV_DIR)) {
    log(`删除旧环境：${ENV_DIR}`);
    rmSync(ENV_DIR, { recursive: true, force: true });
  }
  mkdirSync(TOOLS, { recursive: true });
  mkdirSync(MAMBA_ROOT, { recursive: true });

  let micromamba = resolveMicromamba();
  if (!micromamba) micromamba = await downloadMicromamba();
  const env = { ...process.env, MAMBA_ROOT_PREFIX: MAMBA_ROOT };

  log("创建 Python 3.11 环境（首次约 1–3 分钟）…");
  const create = run(micromamba, [
    "create", "-y", "-p", ENV_DIR, "-c", "conda-forge", "python=3.11", "pip",
  ], { env });
  if (!create.ok) fail(`创建环境失败（exit ${create.status}）。可直接看上面的 micromamba 输出`);

  let python = findPython();
  if (!python) fail(`环境已创建但找不到 python（${ENV_DIR}）`);
  log(`Python：${python}`);

  log("安装 rapidocr_onnxruntime（含 ONNX Runtime 与中文模型，约 100–200 MB）…");
  const pip = run(python, ["-m", "pip", "install", "--upgrade", "pip"], { env, quiet: true });
  if (!pip.ok) log(`pip 升级失败，继续尝试安装：${pip.stderr.slice(0, 300)}`);
  const install = run(python, ["-m", "pip", "install", "rapidocr_onnxruntime", "pillow"], { env });
  if (!install.ok) fail("pip 安装失败；请检查网络/代理后重试");

  python = findPython();
  if (!isReady(python)) fail("安装完成但导入校验失败；请查看上面的 pip 输出");
  log("安装完成，RapidOCR 已可用。");
  log("插件默认 ocrEngine=auto 会自动优先使用它；无需重启 DSH（下一次 OCR 即生效）。");
}

async function main() {
  log(`目标环境：${ENV_DIR}`);
  const existing = findPython();
  if (isReady(existing)) {
    log("本地 OCR 已就绪（RapidOCR 可导入），无需安装。");
    return;
  }
  if (CHECK_ONLY) {
    log(existing ? "环境存在但 RapidOCR 不可用，需要重装。" : "尚未安装本地 OCR；运行 node scripts/ocr-setup.mjs 安装。");
    process.exit(2);
  }
  await install();
}

main().catch((error) => fail(String(error?.message ?? error)));
