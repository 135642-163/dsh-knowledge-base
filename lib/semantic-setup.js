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
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL_DIR, MODEL_FILES, RUNTIME_DEPENDENCIES } from "./semantic-runtime.js";

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

/** 探测可选依赖是否可解析（不加载原生模块，避免 293MB 的 .node 进内存）。 */
export function probeSemanticDependencies({ resolveFrom = import.meta.url } = {}) {
  let requireFn;
  try {
    requireFn = createRequire(resolveFrom);
  } catch {
    return { ok: false, missing: [...RUNTIME_DEPENDENCIES] };
  }
  const missing = [];
  for (const name of RUNTIME_DEPENDENCIES) {
    try {
      requireFn.resolve(name);
    } catch {
      missing.push(name);
    }
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

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function installDependencies({ pluginRoot, onProgress = () => {} }) {
  const args = [
    "i", "--no-save", "--save-peer",
    "onnxruntime-node@^1.31.1", "@huggingface/tokenizers@^0.2.0",
  ];
  onProgress({ phase: "dependencies", text: "正在安装运行组件（约 293MB，首次较慢）…" });
  const child = spawn(npmCommand(), args, { cwd: pluginRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  const onData = (chunk) => {
    tail = `${tail}${chunk.toString()}`.slice(-4000);
    const line = tail.split("\n").map((item) => item.trim()).filter(Boolean).pop();
    if (line) onProgress({ phase: "dependencies", text: line.slice(0, 200) });
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const exitCode = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
  if (exitCode !== 0) {
    throw new Error(`npm install 失败（退出码 ${exitCode}）：${tail.slice(-300)}`);
  }
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
