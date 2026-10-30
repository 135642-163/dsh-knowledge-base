/**
 * 语义检索一键准备（终端入口）：缺运行组件就装，缺模型就下，已就绪直接返回。
 *
 * 用法：
 *   node scripts/semantic-setup.mjs [--model-dir <目录>]
 * 环境变量：
 *   SEMANTIC_MODEL_DIR        模型目录（默认 ~/.dsh/tools/models/bge-small-zh-v1.5）
 *   SEMANTIC_MODEL_BASE_URL   模型下载地址前缀（默认 HuggingFace，失败回退 hf-mirror）
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSemantic, semanticSetupStatus } from "../lib/semantic-setup.js";
import { DEFAULT_MODEL_DIR } from "../lib/semantic-runtime.js";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
let modelDir = String(process.env.SEMANTIC_MODEL_DIR ?? "").trim();
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--model-dir") modelDir = args[++i] ?? modelDir;
}
const target = modelDir || DEFAULT_MODEL_DIR;
const configuredBase = String(process.env.SEMANTIC_MODEL_BASE_URL ?? "").trim();

try {
  const before = await semanticSetupStatus({ modelDir: target });
  if (before.ready) {
    process.stdout.write(`${JSON.stringify({ ok: true, alreadyReady: true, modelDir: target })}\n`);
    process.exit(0);
  }
  const result = await prepareSemantic({
    modelDir: target,
    pluginRoot,
    ...(configuredBase ? { modelBases: [configuredBase] } : {}),
    onProgress: (progress) => {
      const label = progress?.text ?? progress?.phase ?? "准备中";
      process.stdout.write(`[semantic] ${label}\n`);
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, alreadyReady: false, modelDir: target, status: result })}\n`);
} catch (error) {
  process.stderr.write(`[semantic] 准备失败：${String(error?.message ?? error)}\n`);
  process.exit(1);
}
