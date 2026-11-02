/**
 * 跨平台包管理器启动：Windows 的 .cmd/.bat 垫片必须翻译成 node + CLI js，
 * 否则 Node ≥20.12 直接 spawn 会抛 EINVAL（0.39.0 在 Windows 上的
 * 「Office 转换引擎安装失败」「一键准备 spawn EINVAL」就是这个原因）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import {
  findBundledPnpm,
  findOnPath,
  npmCliEntry,
  resolveSpawnSpec,
} from "../lib/pkg-manager.js";

const slashes = (value) => String(value).replace(/\\/g, "/");

/** 跨平台假文件系统：把 Windows 反斜杠与 POSIX 斜杠都归一化后比较。 */
function fakeFs(paths) {
  const set = new Set(paths.map(slashes));
  return (candidate) => set.has(slashes(candidate));
}

test("findOnPath 在 Windows 上跳过无扩展名的 npm sh 脚本", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkg-path-"));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npm"), "#!/bin/sh\n", "utf8");
  await writeFile(join(bin, "npm.cmd"), "@echo off\n", "utf8");

  assert.equal(findOnPath("npm", { env: { PATH: bin }, platform: "win32" }), join(bin, "npm.cmd"));
  assert.equal(findOnPath("npm", { env: { PATH: bin }, platform: "linux" }), join(bin, "npm"));
});

test("findOnPath 兼容 Windows 的 Path 变量大小写", async () => {
  const root = await mkdtemp(join(tmpdir(), "pkg-path-case-"));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "pnpm.cmd"), "@echo off\n", "utf8");
  assert.equal(findOnPath("pnpm", { env: { Path: bin }, platform: "win32" }), join(bin, "pnpm.cmd"));
});

test("findBundledPnpm 认得 DSH 的 Windows / macOS 安装布局", () => {
  const winExec = "C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe";
  const winPnpm = win32.join(
    "C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness",
    "resources", "runtime", "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.cjs",
  );
  assert.equal(findBundledPnpm({ execPath: winExec, exists: fakeFs([winPnpm]) }), winPnpm);

  const macExec = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
  const macPnpm = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs";
  assert.equal(findBundledPnpm({ execPath: macExec, exists: fakeFs([macPnpm]) }), macPnpm);

  assert.equal(findBundledPnpm({ execPath: "/usr/local/bin/node", exists: () => false }), null);
});

test("npmCliEntry 从 npm.cmd 找到标准 Node 安装里的 npm-cli.js", () => {
  const shim = "C:\\Program Files\\nodejs\\npm.cmd";
  const cli = win32.join("C:\\Program Files\\nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  assert.equal(npmCliEntry(shim, { exists: fakeFs([cli]) }), cli);
});

test("resolveSpawnSpec：非 Windows / .exe 原样返回", () => {
  assert.deepEqual(
    resolveSpawnSpec({ platform: "darwin", command: "npm", args: ["i", "x"] }),
    { command: "npm", args: ["i", "x"] },
  );
  assert.deepEqual(
    resolveSpawnSpec({ platform: "win32", command: "C:\\node\\node.exe", args: ["x.js"], exists: () => false }),
    { command: "C:\\node\\node.exe", args: ["x.js"] },
  );
});

test("resolveSpawnSpec：Windows 的 npm.cmd 变成 node + npm-cli.js（不再 spawn .cmd）", () => {
  const shim = "C:\\Program Files\\nodejs\\npm.cmd";
  const cli = win32.join("C:\\Program Files\\nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  const spec = resolveSpawnSpec({
    platform: "win32",
    command: shim,
    args: ["i", "--ignore-scripts", "@deepseek-ai/libreoffice-kit@0.2.2"],
    execPath: "C:\\app\\DeepSeek Harness.exe",
    exists: fakeFs([shim, cli]),
  });
  assert.equal(spec.command, "C:\\app\\DeepSeek Harness.exe");
  assert.equal(spec.args[0], cli);
  assert.deepEqual(spec.args.slice(1), ["i", "--ignore-scripts", "@deepseek-ai/libreoffice-kit@0.2.2"]);
  assert.equal(spec.windowsVerbatimArguments, undefined);
});

test("resolveSpawnSpec：找不到 CLI js 时退回 cmd.exe，参数加引号且保留 ^", () => {
  const spec = resolveSpawnSpec({
    platform: "win32",
    command: "npm.cmd",
    args: ["i", "--save-peer", "onnxruntime-node@^1.31.1"],
    execPath: "C:\\node\\node.exe",
    exists: () => false,
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  });
  assert.equal(spec.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(spec.args[3], '""npm.cmd" "i" "--save-peer" "onnxruntime-node@^1.31.1""');
  assert.equal(spec.windowsVerbatimArguments, true);
});

test("resolveSpawnSpec：无扩展名的 npm 先找同名 .cmd", () => {
  const shim = "C:\\nodejs\\npm";
  const cmd = "C:\\nodejs\\npm.cmd";
  const cli = win32.join("C:\\nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  const spec = resolveSpawnSpec({
    platform: "win32",
    command: shim,
    args: ["i"],
    execPath: "C:\\node\\node.exe",
    exists: fakeFs([cmd, cli]),
  });
  assert.equal(spec.command, "C:\\node\\node.exe");
  assert.equal(spec.args[0], cli);
  assert.deepEqual(spec.args.slice(1), ["i"]);
});
