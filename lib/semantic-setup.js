/**
 * 0.31.2 语义检索“一键准备”：探测运行组件/模型，缺什么补什么。
 *
 * - 运行组件：在插件目录执行 npm i --no-save --save-peer（与 README 手动命令相同）；
 * - 模型：从 HuggingFace（或镜像/自定义 base）下载 model.onnx 等 3 个文件，写到
 *   `~/.dsh/tools/models/bge-small-zh-v1.5/`（可用 --model-dir/SEMANTIC_MODEL_DIR 覆盖）。
 *
 * 只由显式同意的工作台“一键准备”或 scripts/semantic-setup.mjs 调用；搜索路径不会联网。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findBundledPnpm, findOnPath, resolveSpawnSpec } from "./pkg-manager.js";
import { DEFAULT_MODEL_DIR, DEFAULT_SEMANTIC_KIT_DIR, MODEL_FILES, RUNTIME_DEPENDENCIES } from "./semantic-runtime.js";

export const SEMANTIC_MODEL_BASE = "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main";
export const SEMANTIC_MODEL_MIRROR = "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main";
/** HuggingFace 仓库内的相对路径（model.onnx 在 onnx/ 子目录）。 */
const MODEL_PATHS = Object.freeze({
  "model.onnx": "onnx/model.onnx",
  "tokenizer.json": "tokenizer.json",
  "tokenizer_config.json": "tokenizer_config.json",
});

/** 文件最小大小（字节）：防止把错误页当模型保存。 */
const MIN_BYTES = Object.freeze({ "model.onnx": 80 * 1024 * 1024, "tokenizer.json": 100 * 1024, "tokenizer_config.json": 100 });
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 探测可选依赖是否可解析（不加载原生模块，避免 293MB 的 .node 进内存）。
 * 两条安装路径都认：插件目录（系统 npm 装的老路径）与独立组件目录
 * （没有 npm 时用 DSH 自带 pnpm 装到 ~/.dsh/tools/semantic-kit）。
 */
export function probeSemanticDependencies({ resolveFrom = import.meta.url, kitDir = DEFAULT_SEMANTIC_KIT_DIR } = {}) {
  const resolvers = [];
  try {
    resolvers.push(createRequire(resolveFrom));
  } catch {
    /* 相对解析器坏了还有组件目录 */
  }
  try {
    resolvers.push(createRequire(join(kitDir, "package.json")));
  } catch {
    /* 组件目录不可用就只看插件目录 */
  }
  if (resolvers.length === 0) return { ok: false, missing: [...RUNTIME_DEPENDENCIES] };
  const missing = [];
  for (const name of RUNTIME_DEPENDENCIES) {
    let found = false;
    for (const requireFn of resolvers) {
      try {
        requireFn.resolve(name);
        found = true;
        break;
      } catch {
        /* 换下一个安装位置 */
      }
    }
    if (!found) missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}

export async function probeSemanticModel(modelDir = DEFAULT_MODEL_DIR) {
  const missing = [];
  for (const file of MODEL_FILES) {
    try {
      await access(join(modelDir, file));
    } catch {
      missing.push(file);
    }
  }
  return { ok: missing.length === 0, missing, dir: modelDir };
}

/** 工作台展示用：依赖/模型是否就绪（纯只读探测）。 */
export async function semanticSetupStatus({ modelDir = DEFAULT_MODEL_DIR, resolveFrom } = {}) {
  const dependencies = probeSemanticDependencies(resolveFrom ? { resolveFrom } : {});
  const model = await probeSemanticModel(modelDir);
  return { dependencies, model, ready: dependencies.ok && model.ok, modelDir };
}

/** 可选运行组件（版本与 package.json 的 peer 声明一致）。 */
const SEMANTIC_PACKAGES = Object.freeze(["onnxruntime-node@^1.31.1", "@huggingface/tokenizers@^0.2.0"]);

/** 组件目录的 package.json（pnpm add 需要一个工程根；只写一次）。 */
async function ensureKitProject(kitDir) {
  await mkdir(kitDir, { recursive: true });
  try {
    await writeFile(
      join(kitDir, "package.json"),
      `${JSON.stringify({ name: "dsh-semantic-kit", private: true }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

/** 跑一次安装器：收集输出尾巴、把 spawn 失败（EINVAL 等）翻译成可读错误。 */
async function runInstaller({ command, args, cwd, onProgress, label }) {
  const launch = resolveSpawnSpec({
    platform: process.platform,
    command,
    args,
    execPath: process.execPath,
    exists: existsSync,
    env: process.env,
  });
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  let tail = "";
  let spawnError = "";
  const onData = (chunk) => {
    tail = `${tail}${chunk.toString()}`.slice(-4000);
    const line = tail.split("\n").map((item) => item.trim()).filter(Boolean).pop();
    if (line) onProgress({ phase: "dependencies", text: line.slice(0, 200) });
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  // spawn 失败只会触发 error（不会有 close）；不监听会变成未捕获异常，界面只剩 "spawn EINVAL"。
  child.on("error", (error) => {
    spawnError = String(error?.message ?? error);
  });
  const exitCode = await new Promise((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", (code) => resolve(Number.isInteger(code) ? code : -1));
  });
  if (exitCode !== 0) {
    throw new Error(
      spawnError
        ? `${label} 启动失败：${spawnError}`
        : `${label} 失败（退出码 ${exitCode}）：${tail.slice(-300)}`,
    );
  }
}

/**
 * 安装可选运行组件。
 * - 有系统 npm：沿用老路径，`npm i --no-save --save-peer` 装进插件目录；
 * - 没有 npm（DSH 桌面版只带 node + pnpm）：用自带 pnpm 装到独立组件目录
 *   ~/.dsh/tools/semantic-kit，运行时由 semantic-runtime 回落解析。
 */
async function installDependencies({ pluginRoot, onProgress = () => {}, kitDir = DEFAULT_SEMANTIC_KIT_DIR }) {
  const npm = findOnPath("npm", { env: process.env, exists: existsSync, platform: process.platform });
  if (npm) {
    onProgress({ phase: "dependencies", text: "正在安装运行组件（约 293MB，首次较慢）…" });
    await runInstaller({
      command: npm,
      args: ["i", "--no-save", "--save-peer", ...SEMANTIC_PACKAGES],
      cwd: pluginRoot,
      onProgress,
      label: "npm install",
    });
    return;
  }

  const pnpm = findBundledPnpm({ execPath: process.execPath, exists: existsSync });
  if (!pnpm) {
    throw new Error("未找到 npm，也没有 DSH 自带 pnpm：请安装 Node.js（含 npm）后重试");
  }
  onProgress({ phase: "dependencies", text: "未找到 npm，改用 DSH 自带 pnpm 安装运行组件（约 293MB）…" });
  await ensureKitProject(kitDir);
  await runInstaller({
    // process.execPath 是 DSH 的 Electron 可执行文件；DSH 进程带 ELECTRON_RUN_AS_NODE=1，
    // 子进程会以 node 身份运行 pnpm.cjs，因此机器上不需要装 Node.js。
    command: process.execPath,
    args: [pnpm, "add", "--ignore-scripts", ...SEMANTIC_PACKAGES],
    cwd: kitDir,
    onProgress,
    label: "pnpm add",
  });
}

async function downloadFile(url, dest, { fetchImpl, onProgress, file, minBytes = MIN_BYTES[file] ?? 1 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    onProgress({ phase: "model", file, loaded: 0, total: 0, text: `下载 ${file}…` });
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < minBytes) throw new Error(`文件过小（${bytes.length} bytes）`);
    const tmp = `${dest}.${process.pid}.part`;
    try {
      await writeFile(tmp, bytes, { mode: 0o644 });
      await rename(tmp, dest);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
    onProgress({ phase: "model", file, loaded: bytes.length, total: bytes.length, text: `下载 ${file} 完成` });
  } catch (error) {
    throw new Error(`下载 ${file} 失败：${String(error?.message ?? error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function downloadModel({ modelDir, onProgress, fetchImpl = fetch, modelBases = [SEMANTIC_MODEL_BASE, SEMANTIC_MODEL_MIRROR], minBytes }) {
  const model = await probeSemanticModel(modelDir);
  if (model.ok) return;
  await mkdir(modelDir, { recursive: true });
  for (const file of model.missing) {
    let lastError = null;
    for (const base of modelBases) {
      try {
        await downloadFile(`${base.replace(/\/+$/, "")}/${MODEL_PATHS[file] ?? file}`, join(modelDir, file), { fetchImpl, onProgress, file, ...(minBytes ? { minBytes: minBytes[file] } : {}) });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
  }
}

/**
 * 一键准备：缺依赖装依赖、缺模型下模型；已就绪时直接返回。
 * @returns {Promise<ReturnType<typeof semanticSetupStatus>>}
 */
export async function prepareSemantic({
  modelDir = DEFAULT_MODEL_DIR,
  pluginRoot = dirname(dirname(fileURLToPath(import.meta.url))),
  onProgress = () => {},
  fetchImpl = fetch,
  modelBases,
  minBytes,
} = {}) {
  if (!probeSemanticDependencies({ resolveFrom: new URL("../lib/semantic-setup.js", import.meta.url).href }).ok) {
    await installDependencies({ pluginRoot, onProgress });
    const after = probeSemanticDependencies();
    if (!after.ok) throw new Error(`运行组件安装后仍缺失：${after.missing.join("、")}`);
  }
  await downloadModel({
    modelDir,
    onProgress,
    fetchImpl,
    ...(Array.isArray(modelBases) && modelBases.length > 0 ? { modelBases } : {}),
    ...(minBytes ? { minBytes } : {}),
  });
  const status = await semanticSetupStatus({ modelDir });
  onProgress({ phase: "done", text: "准备完成" });
  return status;
}
