# 0.31 语义层运行时 ADR：D1a 瘦身版（onnxruntime-node + tokenizers.js）

> 状态：已定（用户 2026-10-30 选择 D1a 瘦身版）。本文件是 0.31 的运行时决策记录与 spike 证据。
> 关联：`docs/specs/2026-10-31-semantic-layer-design.md` §5、`docs/plans/2026-10-31-semantic-layer.md` Task 0/3。

## 1. 决策

采用 **D1a 瘦身版**：

- `onnxruntime-node`（预编译原生二进制，Node 内直接跑 ONNX）+ `@huggingface/tokenizers`
  （纯 JS，600KB，WordPiece/BERT 支持）；
- **不引入** `@huggingface/transformers`（它硬依赖 `onnxruntime-node` + `onnxruntime-web` +
  `sharp`，会多出约 160MB 与一个原生图像库）；
- 模型：`Xenova/bge-small-zh-v1.5` 的 `onnx/model.onnx`（fp32，94.8MB）+ `tokenizer.json`
  + `tokenizer_config.json`（与 0.30 评测同一套权重）；
- 打包策略：这两个依赖作为**可选 peer**（`peerDependenciesMeta.optional`）或独立伴生包，
  插件运行时 `import("onnxruntime-node")` 探测；缺失时语义层关闭、完全回退 B（默认关闭）。
  本机开发可用 `npm i -D onnxruntime-node @huggingface/tokenizers` 验证，发布包不强制安装。

## 2. Spike 证据（2026-10-30，/tmp/kb-spike031）

| 项 | 实测 |
|---|---|
| 安装体积 | `onnxruntime-node` **298MB**（bin/napi-v6 含 darwin 88MB + linux 72MB + win32 138MB 三平台）+ `@huggingface/tokenizers` 0.6MB |
| 模型 | `onnx/model.onnx` **94.8MB**；hidden 512、BertModel、max_position 512 |
| Session 加载 | **55ms** |
| **向量一致性（vs 0.30 Python/fastembed）** | 6 条查询 **cos = 0.999999**；4 篇文档 **cos = 0.999999** |
| 单条查询嵌入延迟 | p50 **2.68ms**、p95 **3.13ms**（含 tokenize + 推理 + CLS 池化 + 归一化） |
| 常驻内存 | RSS **293MB**（模型 + ORT，Node 进程内） |
| 安装脚本 | `onnxruntime-node` 有 `postinstall`；本次 npm 的 allowScripts 策略未执行它，但三平台二进制已在包内、推理正常。发布文档需提示「允许 install script」或验证无脚本环境。 |

**结论**：与 0.30 评测**同源同结果**（差异 < 1e-6），查询延迟比 fastembed（1.6ms/条）多约 1ms
（tokenize 与单条推理开销），相对 60ms 的 FTS 可忽略。D1a 瘦身版可行。

### 2.1 仓库内复核（2026-10-30，Node 26.7.0 / macOS arm64）

按 §5 安装 `onnxruntime-node@1.31.1` + `@huggingface/tokenizers@0.2.0`，模型放
`~/.dsh/tools/models/bge-small-zh-v1.5`，用与本文相同的 tokenize/CLS/L2 口径复跑：

| 项 | 复核值 |
|---|---|
| 维度 | 512（inputs `input_ids/attention_mask/token_type_ids` → 输出 `last_hidden_state`） |
| 与 0.30 fastembed 一致性 | 80 条查询余弦最小 **0.999999**；40 篇文档余弦最小 **0.999998**（门槛 >0.99） |
| session 加载 | **64ms** |
| 查询嵌入 | p50 **2.63ms** / p95 **2.92ms**（batch=1）；batch=8 时 1.59ms/条 |
| 文档嵌入 | **12.6ms/篇**（batch=8，平均 244 token）→ 911 篇约 **11.5s** |
| RSS | 加载后 **239MB**；仅查询稳态 260MB；批量嵌入文档峰值 476MB（索引构建放后台进程） |
| 体积 | onnxruntime-node **293MB**（三平台）+ tokenizers 0.6MB + 模型 **95MB** |
| install script | npm allowScripts 未执行 `postinstall`，CPU 推理正常（darwin 清单为空） |

打包收口：**可选 peer**（`peerDependencies` + `peerDependenciesMeta.optional`），`npm ci` 不安装；
启用命令、体积与 install script 限制见 README「0.31.0」段。

## 3. 运行时接口（Task 3 直接照此实现）

```js
// lib/semantic-runtime.js（示意）
import { readFile } from "node:fs/promises";

const INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";
let cache = null; // { ort, tokenizer, session, dim }

async function loadRunner({ modelDir }) {
  if (cache) return cache;
  const ort = (await import("onnxruntime-node")).default;
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(`${modelDir}/tokenizer.json`, "utf8")),
    JSON.parse(await readFile(`${modelDir}/tokenizer_config.json`, "utf8")),
  );
  const session = await ort.InferenceSession.create(`${modelDir}/model.onnx`);
  cache = { ort, tokenizer, session, dim: 512 };
  return cache;
}

// BertModel：input_ids/attention_mask/token_type_ids → last_hidden_state
// 池化：取 CLS（第 0 个 token）；归一化：L2；文档不加指令，查询加 INSTRUCTION。
export async function embed(texts, { modelDir, batch = 8, isQuery = false }) { ... }
```

实现细节（spike 已验证）：

- `tokenizer.encode(text)` 返回 `{ ids, attention_mask }`，自带 `[CLS]/[SEP]`（101/102）；
- 张量：`new ort.Tensor("int64", BigInt64Array, [batch, seq])`，注意补 0、`attention_mask` 补 0；
- 输出只有 `last_hidden_state`（`[batch, seq, 512]`），取 `row * seq * dim` 起始的 CLS 向量；
- L2 归一化后与 0.30 的 `.f32` 可直接点积；
- 批处理 8 条最稳；查询单条走 batch=1。

## 4. 与 D1c / 完整版对比（决策依据）

| | D1a 瘦身版（本 ADR） | D1a 完整版（transformers.js） | D1c（外部 Python worker） |
|---|---|---|---|
| 安装体积 | ~298MB + 模型 95MB | ~330MB+（含 onnxruntime-web 150MB、sharp） | 0（Python 侧另装） |
| 原生依赖 | 1 个（onnxruntime-node，预编译） | 3 个（ort-node、sharp、平台包） | 插件无 |
| 查询延迟 | 2.7ms | 约 1.6–3ms | 10–25ms（IPC） |
| 开箱即用 | 装可选 peer 即可 | 装 npm 即可 | 需 Python + fastembed |
| 与评测一致性 | **0.999999** | 需自证（同模型不同前后处理） | 完全同源 |
| 主要风险 | 298MB 体积 + install script | 体积更大 + sharp 原生 | 用户环境/进程管理 |

## 5. 影响

- 0.31 的 Task 1/2/4/5（纯函数、索引、接入、回归）不变；只有 Task 3 与本 ADR 相关。
- README 需要写清：默认关闭 → 如何安装可选依赖与模型 → 模型下载需同意 → 体积与内存占用。
- CI：没有 onnxruntime-node 的环境必须能 skip 语义用例（用注入假 embedder），真实 runner 用例
  只在装了可选依赖时跑。
- 本机验证命令（新对话可直接复用）：

```bash
# 可选依赖（只在本机装，不默认进发布依赖）
npm i -D onnxruntime-node @huggingface/tokenizers
# 模型（94.8MB，代理按需）
mkdir -p ~/.dsh/tools/models/bge-small-zh-v1.5
curl -L -o ~/.dsh/tools/models/bge-small-zh-v1.5/model.onnx \
  https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model.onnx
curl -L -o ~/.dsh/tools/models/bge-small-zh-v1.5/tokenizer.json \
  https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json
curl -L -o ~/.dsh/tools/models/bge-small-zh-v1.5/tokenizer_config.json \
  https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer_config.json
```
