/**
 * 上传弹窗的纯函数：文件分类、相对路径、并发队列、状态标签、结果汇总。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyFiles, createQueue, formatBytes, relPathFor, statusLabel, summarizeResults } from "../ui/upload-core.js";

const LIMITS = { maxBytes: 10, maxFiles: 2, extensions: [".md", ".pdf"] };

test("relPathFor 优先 webkitRelativePath 并做 NFC 归一", () => {
  assert.equal(relPathFor({ name: "a.md" }), "a.md");
  assert.equal(relPathFor({ name: "a.md", webkitRelativePath: "资料/a.md" }), "资料/a.md");
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

test("statusLabel 与 summarizeResults", () => {
  assert.equal(statusLabel("pending"), "等待");
  assert.equal(statusLabel("ok"), "成功");
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
