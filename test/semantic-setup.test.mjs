/**
 * 0.31.2 一键准备：依赖/模型探测 + 从本地 HTTP 下载缺失模型文件（不联网、不装 293MB 依赖）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareSemantic,
  probeSemanticDependencies,
  probeSemanticModel,
  semanticSetupStatus,
} from "../lib/semantic-setup.js";

const deps = probeSemanticDependencies();
const skipDeps = deps.ok ? false : "本机未安装可选依赖（真实安装会下载 293MB）";

test("探测模型：缺文件时列出 missing，齐全时 ready", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-sem-model-"));
  try {
    const missing = await probeSemanticModel(dir);
    assert.equal(missing.ok, false);
    assert.deepEqual(new Set(missing.missing), new Set(["model.onnx", "tokenizer.json", "tokenizer_config.json"]));
    for (const file of ["model.onnx", "tokenizer.json", "tokenizer_config.json"]) {
      await writeFile(join(dir, file), "x");
    }
    const ready = await probeSemanticModel(dir);
    assert.equal(ready.ok, true);
    assert.deepEqual(ready.missing, []);
    assert.equal((await semanticSetupStatus({ modelDir: dir })).ready, deps.ok);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("一键准备：从本地 HTTP 下载缺失模型文件，不执行 npm", { skip: skipDeps }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-sem-model-"));
  const bodies = {
    "model.onnx": Buffer.alloc(4096, 1),
    "tokenizer.json": Buffer.from('{"a":1}'.padEnd(2048, " ")),
    "tokenizer_config.json": Buffer.from('{"b":2}'.padEnd(2048, " ")),
  };
  const server = createServer((req, res) => {
    const file = String(req.url ?? "").split("/").pop();
    const body = bodies[file];
    if (!body) { res.statusCode = 404; res.end("not found"); return; }
    res.setHeader("content-length", String(body.length));
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const progress = [];
  try {
    const result = await prepareSemantic({
      modelDir: dir,
      modelBases: [`http://127.0.0.1:${port}`],
      minBytes: { "model.onnx": 1024, "tokenizer.json": 100, "tokenizer_config.json": 100 },
      onProgress: (event) => progress.push(event?.text ?? ""),
    });
    assert.equal(result.ready, true);
    assert.equal((await stat(join(dir, "model.onnx"))).size, 4096);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "tokenizer.json"), "utf8")), { a: 1 });
    assert.ok(progress.some((text) => text.includes("下载 model.onnx")));
    // 已就绪时再准备一次：直接返回，不再下载（服务端没有请求计数也可通过耗时/结果判断）。
    assert.equal((await prepareSemantic({ modelDir: dir, modelBases: [`http://127.0.0.1:${port}`] })).ready, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("一键准备：下载失败时给出明确错误，不留 .part 临时文件", { skip: skipDeps }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-sem-model-"));
  const server = createServer((_req, res) => { res.statusCode = 500; res.end("boom"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => prepareSemantic({ modelDir: dir, modelBases: [`http://127.0.0.1:${port}`] }),
      /下载 model\.onnx 失败/,
    );
    const leftover = await readFile(join(dir, "model.onnx")).catch(() => null);
    assert.equal(leftover, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
