/**
 * 0.31 语义运行时（Task 3）：D1a 瘦身版。
 *
 * `onnxruntime-node`（预编译 N-API 二进制）+ `@huggingface/tokenizers`（纯 JS WordPiece）
 * 加载 bge-small-zh-v1.5 ONNX：
 *  - 查询侧加中文检索指令，文档侧不加；
 *  - BertModel：input_ids/attention_mask/token_type_ids → last_hidden_state；
 *  - CLS 池化（第 0 个 token）+ L2 归一化，与 0.30 fastembed 产物同源（cos≈0.999999）。
 *
 * 这两个依赖是可选 peer：缺席时本模块只返回 { available:false, reason }，由调用方回退 B；
 * 进程内只告警一次。这里不下载模型、不联网。
 */
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeVector } from "./semantic.js";
import { SEMANTIC_MODEL } from "./semantic-index.js";

/** 查询侧指令（与 0.30 评测 embed_queries.py 的 query_prefix 一致）。 */
export const QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";
/** bge-small-zh-v1.5 的 hidden size。 */
export const SEMANTIC_DIM = 512;
/** BERT 位置编码上限。 */
export const MAX_TOKENS = 512;
export const DEFAULT_MODEL_DIR = join(homedir(), ".dsh", "tools", "models", "bge-small-zh-v1.5");
export const MODEL_FILES = Object.freeze(["model.onnx", "tokenizer.json", "tokenizer_config.json"]);
/** 可选 peer 依赖；缺任何一个都降级。 */
export const RUNTIME_DEPENDENCIES = Object.freeze(["onnxruntime-node", "@huggingface/tokenizers"]);

function messageOf(error) {
  return String(error?.message ?? error);
}

/**
 * 创建语义运行时（懒加载：第一次 status/embed 才 import 原生模块、建 session）。
 *
 * @param {object} [options]
 * @param {string} [options.modelDir] 模型目录（model.onnx / tokenizer*.json）
 * @param {(specifier: string) => Promise<any>} [options.loadModule] 依赖注入（测试用假模块）
 * @param {(path: string) => Promise<string>} [options.readText] 读 tokenizer JSON
 * @param {{warn: (message: string) => void}} [options.logger] 降级告警（只调一次）
 * @param {number} [options.expectedDim] 期望维度（默认 512；单测用小的假维度）
 * @param {number} [options.batchSize] 批大小（默认 8）
 */
export function createSemanticRuntime({
  modelDir = DEFAULT_MODEL_DIR,
  loadModule = (specifier) => import(specifier),
  readText = (path) => readFile(path, "utf8"),
  logger = null,
  expectedDim = SEMANTIC_DIM,
  batchSize = 8,
} = {}) {
  const dimension = Number.isInteger(expectedDim) && expectedDim > 0 ? expectedDim : SEMANTIC_DIM;
  const batch = Math.max(1, Math.round(Number(batchSize) || 8));
  let loadPromise = null;
  let state = null;
  let warned = false;
  let queue = Promise.resolve();

  function announce(message) {
    if (warned) return;
    warned = true;
    try {
      logger?.warn?.(message);
    } catch {
      /* 告警失败不影响检索 */
    }
  }

  function unavailable(reason, detail = "") {
    state = { available: false, reason, detail };
    announce(`语义检索不可用（${reason}${detail ? `：${detail}` : ""}），已回退词面检索`);
    return state;
  }

  async function load() {
    let ort;
    let tokenizerModule;
    try {
      ort = (await loadModule("onnxruntime-node")).default ?? (await loadModule("onnxruntime-node"));
      tokenizerModule = await loadModule("@huggingface/tokenizers");
    } catch (error) {
      return unavailable("runner_missing", messageOf(error));
    }
    for (const name of MODEL_FILES) {
      try {
        await access(join(modelDir, name));
      } catch {
        return unavailable("model_missing", join(modelDir, name));
      }
    }
    try {
      const tokenizerJson = JSON.parse(await readText(join(modelDir, "tokenizer.json")));
      const tokenizerConfig = JSON.parse(await readText(join(modelDir, "tokenizer_config.json")));
      const tokenizer = new tokenizerModule.Tokenizer(tokenizerJson, tokenizerConfig);
      const session = await ort.InferenceSession.create(join(modelDir, "model.onnx"));
      state = { available: true, reason: "", detail: "", ort, tokenizer, session };
      return state;
    } catch (error) {
      return unavailable("runner_error", messageOf(error));
    }
  }

  function ensure() {
    loadPromise ??= load();
    return loadPromise;
  }

  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function embed(texts, { isQuery = false } = {}) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text ?? ""));
    if (list.length === 0) return { ok: true, vectors: [], dim: dimension };
    const loaded = await ensure();
    if (!loaded.available) return { ok: false, reason: loaded.reason, vectors: [], dim: 0 };
    return serialize(async () => {
      const vectors = [];
      for (let start = 0; start < list.length; start += batch) {
        const chunk = list.slice(start, start + batch);
        const encoded = chunk.map((text) => {
          const value = isQuery ? `${QUERY_INSTRUCTION}${text}` : text;
          const result = loaded.tokenizer.encode(value, { add_special_tokens: true });
          return {
            ids: (result.ids ?? []).slice(0, MAX_TOKENS),
            mask: (result.attention_mask ?? []).slice(0, MAX_TOKENS),
          };
        });
        const width = Math.max(1, ...encoded.map((entry) => entry.ids.length));
        const count = encoded.length;
        const ids = new BigInt64Array(count * width);
        const mask = new BigInt64Array(count * width);
        const types = new BigInt64Array(count * width);
        encoded.forEach((entry, row) => {
          for (let column = 0; column < entry.ids.length; column += 1) {
            ids[row * width + column] = BigInt(entry.ids[column]);
            mask[row * width + column] = BigInt(entry.mask[column] ?? 1);
          }
        });
        const feeds = {
          input_ids: new loaded.ort.Tensor("int64", ids, [count, width]),
          attention_mask: new loaded.ort.Tensor("int64", mask, [count, width]),
        };
        if (Array.isArray(loaded.session.inputNames) && loaded.session.inputNames.includes("token_type_ids")) {
          feeds.token_type_ids = new loaded.ort.Tensor("int64", types, [count, width]);
        }
        let output;
        try {
          output = await loaded.session.run(feeds);
        } catch (error) {
          return { ok: false, reason: `embed_failed: ${messageOf(error)}`, vectors: [], dim: 0 };
        }
        const tensor = output?.last_hidden_state ?? output?.[loaded.session.outputNames?.[0]];
        const dim = Number(tensor?.dims?.[2] ?? 0);
        if (dim !== dimension) {
          const failed = unavailable("dim_mismatch", `期望 ${dimension}，模型输出 ${dim || "未知"}`);
          return { ok: false, reason: failed.reason, vectors: [], dim: 0 };
        }
        const stride = width * dim;
        for (let row = 0; row < count; row += 1) {
          const base = row * stride;
          const cls = new Float32Array(dim);
          for (let column = 0; column < dim; column += 1) cls[column] = tensor.data[base + column];
          const vector = normalizeVector(cls);
          if (!vector) return { ok: false, reason: "embed_empty", vectors: [], dim: 0 };
          vectors.push(vector);
        }
      }
      return { ok: true, vectors, dim: dimension };
    });
  }

  return {
    /** 运行时状态；首次调用会加载原生模块与模型（默认关闭时调用方不应调用）。 */
    async status() {
      const loaded = await ensure();
      return {
        available: loaded.available === true,
        reason: loaded.reason ?? "",
        detail: loaded.detail ?? "",
        model: SEMANTIC_MODEL,
        modelDir,
        dim: loaded.available ? dimension : 0,
      };
    },
    /** 文档嵌入（不加指令）。 */
    embedDocuments(texts) {
      return embed(texts, { isQuery: false });
    },
    /** 查询嵌入（加中文检索指令）。 */
    async embedQuery(text) {
      const result = await embed([text], { isQuery: true });
      if (!result.ok) return { ok: false, reason: result.reason, vector: null, dim: 0 };
      return { ok: true, reason: "", vector: result.vectors[0], dim: result.dim };
    },
    /** 释放 session（测试/重载用）；之后可重新加载。 */
    async dispose() {
      try {
        await state?.session?.release?.();
      } catch {
        /* ignore */
      }
      state = null;
      loadPromise = null;
      queue = Promise.resolve();
    },
  };
}
