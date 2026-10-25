/**
 * 上传弹窗的纯函数：文件分类、相对路径、并发队列、状态标签、结果汇总。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFiles, createQueue, extOf, fileStageLabel, formatBytes, nextPhase, relPathFor, statusLabel,
  summarizeResults, uploadPhaseTitle,
} from "../ui/upload-core.js";

const LIMITS = { maxBytes: 10, maxFiles: 2, extensions: [".md", ".pdf"] };

test("relPathFor 优先 webkitRelativePath 并做 NFC 归一", () => {
  assert.equal(relPathFor({ name: "a.md" }), "a.md");
  assert.equal(relPathFor({ name: "a.md", webkitRelativePath: "资料/a.md" }), "资料/a.md");
  assert.equal(relPathFor({ name: "e\u0301.md" }), "é.md");
  assert.equal(relPathFor({ name: "fallback.md", webkitRelativePath: "cafe\u0301/é.md" }), "café/é.md");
});

test("extOf 与 server path.extname 语义对齐", () => {
  assert.equal(extOf(".gitignore"), "");
  assert.equal(extOf(".md"), "");
  assert.equal(extOf("v1.2/README"), "");
  assert.equal(extOf("v1.2/a.MD"), ".md");
  assert.equal(extOf("A.PDF"), ".pdf");
});

test("classifyFiles 拒绝非法扩展名/超大小/超数量并给出原因", () => {
  const files = [
    { name: "a.md", size: 5 },
    { name: "b.exe", size: 5 },
    { name: "c.pdf", size: 50 },
    { name: "d.pdf", size: 5 },
  ];
  const { accepted, rejected } = classifyFiles(files, { ...LIMITS, maxFiles: 1 });
  assert.deepEqual(accepted.map((item) => item.path), ["a.md"]);
  assert.equal(rejected.length, 3);
  assert.match(rejected.find((item) => item.path === "b.exe").reason, /不支持/);
  assert.match(rejected.find((item) => item.path === "c.pdf").reason, /上限/);
  assert.match(rejected.find((item) => item.path === "d.pdf").reason, /文件数/);
});

test("classifyFiles 把点文件与无扩展名路径判为不支持", () => {
  const files = [
    { name: ".md", size: 5 },
    { name: "README", size: 5, webkitRelativePath: "v1.2/README" },
  ];
  const { accepted, rejected } = classifyFiles(files, { ...LIMITS, maxFiles: 10 });
  assert.deepEqual(accepted, []);
  assert.equal(rejected.length, 2);
  assert.match(rejected.find((item) => item.path === ".md").reason, /无扩展名/);
  assert.match(rejected.find((item) => item.path === "v1.2/README").reason, /无扩展名/);
});

test("createQueue 并发不超过上限且全部完成", async () => {
  const queue = createQueue(2);
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 5 }, (_, i) => queue.run(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return i;
  }));
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test("createQueue 并发 1 时按 FIFO 启动", async () => {
  const queue = createQueue(1);
  const started = [];
  const tasks = ["a", "b", "c"].map((name) => queue.run(async () => {
    started.push(name);
    await new Promise((resolve) => setTimeout(resolve, 1));
    return name;
  }));
  assert.deepEqual(await Promise.all(tasks), ["a", "b", "c"]);
  assert.deepEqual(started, ["a", "b", "c"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(queue.active, 0);
  assert.equal(queue.pending, 0);
});

test("createQueue 单个任务失败不阻塞后续任务并排空", async () => {
  const queue = createQueue(1);
  const first = queue.run(async () => { throw new Error("boom"); });
  const second = queue.run(async () => "ok");
  await assert.rejects(first, /boom/);
  assert.equal(await second, "ok");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(queue.active, 0);
  assert.equal(queue.pending, 0);
});

test("statusLabel 与 summarizeResults", () => {
  assert.equal(statusLabel("pending"), "等待");
  assert.equal(statusLabel("ok"), "已解析");
  assert.equal(statusLabel("uploaded"), "已上传，待解析");
  const summary = summarizeResults({ ok: 1, fail: 1, skip: 1, files: [{ status: "ok" }, { status: "failed" }, { status: "skipped" }] });
  assert.equal(summary.total, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
});

test("formatBytes 人类可读", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(2 * 1024 ** 3), "2.0 GB");
});

test("阶段文案区分上传/解析/全重复/失败", () => {
  assert.equal(fileStageLabel({ status: "uploaded" }, "starting"), "已上传，待解析");
  assert.equal(fileStageLabel({ status: "ok", stage: "parsing" }, "importing"), "解析中");
  assert.equal(fileStageLabel({ status: "skipped", reason: "duplicate" }, "done"), "重复跳过");
  assert.equal(fileStageLabel({ status: "failed", stage: "failed" }, "importing"), "解析失败");
  assert.equal(fileStageLabel({ status: "failed" }, "uploading"), "上传失败");
  assert.equal(uploadPhaseTitle({ phase: "uploading" }), "上传中（文件尚未解析）");
  assert.equal(uploadPhaseTitle({ phase: "starting" }), "文件已上传，正在启动解析…");
  assert.equal(uploadPhaseTitle({ phase: "empty" }), "没有新资料（全部重复）");
  assert.equal(uploadPhaseTitle({ phase: "done", kb: "标准" }), "解析完成 · 标准");
  assert.equal(uploadPhaseTitle({ phase: "error", files: [{ status: "failed" }] }), "上传失败");
  assert.equal(uploadPhaseTitle({ phase: "error", files: [{ status: "uploaded" }] }), "上传完成，解析未完成");
});

test("nextPhase 覆盖上传/导入状态机", () => {
  assert.equal(nextPhase("select", "start"), "uploading");
  assert.equal(nextPhase("uploading", "uploaded"), "starting");
  assert.equal(nextPhase("starting", "started"), "importing");
  assert.equal(nextPhase("starting", "empty"), "empty");
  assert.equal(nextPhase("importing", "settled"), "done");
  assert.equal(nextPhase("importing", "failed"), "error");
  assert.equal(nextPhase("uploading", "unexpected"), "uploading");
});
