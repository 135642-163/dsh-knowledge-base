/**
 * 0.31 语义运行时（Task 3）：onnxruntime-node + @huggingface/tokenizers 的懒加载、
 * 降级（依赖/模型缺失不抛、只告警一次）与 CLS 池化。
 *
 * 绝大多数用例注入假模块，不需要模型；真实 runner 用例只在装了可选依赖与模型时跑，
 * 并用 test/fixtures 里由本机真实模型生成、且已与 0.30 fastembed 向量核对过的查询向量
 * 做余弦校验。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MODEL_DIR,
  MODEL_FILES,
  QUERY_INSTRUCTION,
  RUNTIME_DEPENDENCIES,
  createSemanticRuntime,
} from "../lib/semantic-runtime.js";

// ---------------------------------------------------------------------------
// 假模块
// ---------------------------------------------------------------------------

function makeFakeModules({ dim = 2, tokenCount = 0, runLog = [] } = {}) {
  class FakeTensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const session = {
    inputNames: ["input_ids", "attention_mask", "token_type_ids"],
    outputNames: ["last_hidden_state"],
    async run(feeds) {
      const [batch, width] = feeds.input_ids.dims;
      runLog.push({ batch, width });
      const data = new Float32Array(batch * width * dim);
      for (let row = 0; row < batch; row += 1) {
        // CLS 向量固定为 [3, 4, 0...]，便于断言 L2 归一化（dim=2 时是 [0.6, 0.8]）。
        data[row * width * dim] = 3;
        data[row * width * dim + 1] = dim > 1 ? 4 : 0;
      }
      return { last_hidden_state: { dims: [batch, width, dim], data } };
    },
    release() {},
  };
  const configs = [];
  class FakeTokenizer {
    constructor(json, config) {
      this.json = json;
      this.config = config;
      configs.push({ json, config });
    }
    encode(text) {
      const length = tokenCount > 0 ? tokenCount : [...String(text)].length + 2;
      return {
        ids: Array.from({ length }, (_value, index) => 101 + index),
        attention_mask: Array.from({ length }, () => 1),
      };
    }
  }
  const ortModule = { default: { Tensor: FakeTensor, InferenceSession: { create: async () => session } } };
  const tokenizerModule = { Tokenizer: FakeTokenizer };
  const loadModule = async (specifier) => {
    if (specifier === "onnxruntime-node") return ortModule;
    if (specifier === "@huggingface/tokenizers") return tokenizerModule;
    throw new Error(`unexpected module: ${specifier}`);
  };
  return { loadModule, session, runLog, configs };
}

async function makeModelDir() {
  const dir = await mkdtemp(join(tmpdir(), "kb-semantic-model-"));
  for (const name of MODEL_FILES) await writeFile(join(dir, name), "{}", "utf8");
  return dir;
}

async function withModelDir(run) {
  const dir = await makeModelDir();
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeLogger() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(String(message)) };
}

// ---------------------------------------------------------------------------
// 降级
// ---------------------------------------------------------------------------

test("依赖缺失：available=false / reason=runner_missing，不抛且只告警一次", async () => {
  const logger = fakeLogger();
  const runtime = createSemanticRuntime({
    modelDir: "/nonexistent-model-dir",
    loadModule: async () => { throw Object.assign(new Error("Cannot find module"), { code: "ERR_MODULE_NOT_FOUND" }); },
    logger,
  });
  const status = await runtime.status();
  assert.equal(status.available, false);
  assert.equal(status.reason, "runner_missing");
  const missing = await runtime.embedDocuments(["a"]);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "runner_missing");
  await runtime.embedQuery("b");
  assert.equal(logger.warnings.length, 1, "同一进程只告警一次");
});

test("模型缺失：fake 依赖可用也返回 model_missing，只告警一次", async () => {
  const logger = fakeLogger();
  const { loadModule } = makeFakeModules();
  const runtime = createSemanticRuntime({ modelDir: "/nonexistent-model-dir", loadModule, logger });
  const status = await runtime.status();
  assert.equal(status.available, false);
  assert.equal(status.reason, "model_missing");
  const result = await runtime.embedDocuments(["a"]);
  assert.equal(result.ok, false);
  assert.equal(logger.warnings.length, 1);
});

test("加载/推理异常降级为 runner_error，不把异常抛给检索", async () => {
  const logger = fakeLogger();
  await withModelDir(async (modelDir) => {
    const { loadModule } = makeFakeModules();
    const broken = createSemanticRuntime({
      modelDir,
      loadModule: async (specifier) => (specifier === "onnxruntime-node"
        ? { default: { Tensor: class {}, InferenceSession: { create: async () => { throw new Error("bad model"); } } } }
        : loadModule(specifier)),
      logger,
    });
    const status = await broken.status();
    assert.equal(status.available, false);
    assert.match(status.reason, /^runner_error/);
    assert.match(status.detail, /bad model/);
    assert.equal(logger.warnings.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 假模块下的嵌入
// ---------------------------------------------------------------------------

test("文档嵌入：CLS 池化 + L2 归一化，返回 dim 与向量", async () => {
  await withModelDir(async (modelDir) => {
    const { loadModule } = makeFakeModules({ dim: 2 });
    const runtime = createSemanticRuntime({ modelDir, loadModule, expectedDim: 2 });
    const result = await runtime.embedDocuments(["风电场低电压穿越"]);
    assert.equal(result.ok, true);
    assert.equal(result.dim, 2);
    assert.equal(result.vectors.length, 1);
    assert.ok(result.vectors[0] instanceof Float32Array);
    assert.ok(Math.abs(result.vectors[0][0] - 0.6) < 1e-6);
    assert.ok(Math.abs(result.vectors[0][1] - 0.8) < 1e-6);
  });
});

test("查询加中文检索指令，文档不加；单条查询走 batch=1", async () => {
  await withModelDir(async (modelDir) => {
    const seen = [];
    const { loadModule } = makeFakeModules({ dim: 2 });
    const wrapped = async (specifier) => {
      const module = await loadModule(specifier);
      if (specifier === "@huggingface/tokenizers") {
        const Original = module.Tokenizer;
        module.Tokenizer = class extends Original {
          encode(text) {
            seen.push(text);
            return super.encode(text);
          }
        };
      }
      return module;
    };
    const runtime = createSemanticRuntime({ modelDir, loadModule: wrapped, expectedDim: 2 });
    await runtime.embedQuery("电压偏差");
    assert.deepEqual(seen, [`${QUERY_INSTRUCTION}电压偏差`]);
    seen.length = 0;
    await runtime.embedDocuments(["电压偏差", "频率偏差"]);
    assert.deepEqual(seen, ["电压偏差", "频率偏差"]);
    assert.equal(runtime.status, runtime.status);
    const status = await runtime.status();
    assert.equal(status.available, true);
    assert.equal(status.dim, 2);
    assert.equal(status.model, "BAAI/bge-small-zh-v1.5");
  });
});

test("批量：8 条一批、超长 token 截断到 512", async () => {
  await withModelDir(async (modelDir) => {
    const runLog = [];
    const { loadModule } = makeFakeModules({ dim: 2, runLog });
    const runtime = createSemanticRuntime({ modelDir, loadModule, expectedDim: 2 });
    const texts = Array.from({ length: 10 }, (_value, index) => `文档 ${index}`);
    const result = await runtime.embedDocuments(texts);
    assert.equal(result.vectors.length, 10);
    assert.deepEqual(runLog.map((entry) => entry.batch), [8, 2]);
    assert.ok(runLog.every((entry) => entry.width <= 512));

    // 即使 tokenizer 返回 600 个 token，送进 session 的也截到 512。
    const long = makeFakeModules({ dim: 2, tokenCount: 600, runLog: [] });
    const runtime2 = createSemanticRuntime({ modelDir, loadModule: long.loadModule, expectedDim: 2 });
    await runtime2.embedDocuments(["x"]);
    assert.equal(long.runLog[0].width, 512);
  });
});

test("维度不符：reason=dim_mismatch，不返回半截向量", async () => {
  await withModelDir(async (modelDir) => {
    const { loadModule } = makeFakeModules({ dim: 2 });
    const runtime = createSemanticRuntime({ modelDir, loadModule, expectedDim: 3 });
    const result = await runtime.embedDocuments(["a"]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "dim_mismatch");
  });
});

test("RUNTIME_DEPENDENCIES 声明与 ADR 一致", () => {
  assert.deepEqual([...RUNTIME_DEPENDENCIES], ["onnxruntime-node", "@huggingface/tokenizers"]);
  assert.equal(DEFAULT_MODEL_DIR.endsWith(join(".dsh", "tools", "models", "bge-small-zh-v1.5")), true);
});

// ---------------------------------------------------------------------------
// 真实 runner（无依赖/模型时 skip）
// ---------------------------------------------------------------------------

async function moduleAvailable(specifier) {
  try {
    await import(specifier);
    return true;
  } catch {
    return false;
  }
}

async function modelAvailable(dir) {
  try {
    await Promise.all(MODEL_FILES.map((name) => access(join(dir, name))));
    return true;
  } catch {
    return false;
  }
}

const hasRuntime = (await moduleAvailable("onnxruntime-node")) && (await moduleAvailable("@huggingface/tokenizers"));
const hasModel = await modelAvailable(DEFAULT_MODEL_DIR);
const realSkip = hasRuntime && hasModel
  ? false
  : `可选依赖或模型未安装（${hasRuntime ? "有依赖" : "缺依赖"} / ${hasModel ? "有模型" : "缺模型"}）`;

test("真实运行时：512 维、归一化，并与 0.30 fastembed 查询向量一致", { skip: realSkip }, async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/semantic-q01-query.json", import.meta.url), "utf8"),
  );
  const runtime = createSemanticRuntime({ logger: null });
  const status = await runtime.status();
  assert.equal(status.available, true, JSON.stringify(status));
  assert.equal(status.dim, 512);
  assert.equal(status.model, "BAAI/bge-small-zh-v1.5");

  const result = await runtime.embedQuery(fixture.text);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.vector.length, 512);
  let norm = 0;
  for (const value of result.vector) norm += value * value;
  assert.ok(Math.abs(norm - 1) < 1e-4, `L2 范数应为 1，实际 ${norm}`);

  assert.equal(fixture.dim, 512);
  let dot = 0;
  for (let index = 0; index < 512; index += 1) dot += result.vector[index] * fixture.vector[index];
  assert.ok(dot > 0.999, `与 0.30 向量余弦应 >0.999，实际 ${dot}`);

  // 文档嵌入不带指令，与查询向量不同；批量 3 篇返回 3 条。
  const docs = await runtime.embedDocuments(["风电场低电压穿越要求", "电压偏差限值", "频率偏差"]);
  assert.equal(docs.ok, true);
  assert.equal(docs.vectors.length, 3);
  let same = 0;
  for (let index = 0; index < 512; index += 1) same += docs.vectors[0][index] * result.vector[index];
  assert.ok(same < 0.9999, "查询指令应让查询向量与同文本文档向量不同");
});
