/**
 * 0.40 中英跨语言检索：中文提问命中英文文献，英文提问命中中文文献；
 * 影子检索只落在另一语言的文档上，标准号查询不扩展。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { searchKb } from "../lib/query.js";

const hasSqlite = await import("node:sqlite").then(() => true).catch(() => false);

/** 真实 ripgrep 的 subprocess 薄封装：FTS 零命中时仍能回退到全文检索。 */
function realSubprocess() {
  const ctx = {
    subprocess: {
      spawn(options) {
        const child = spawnChild(options.argv[0], options.argv.slice(1), { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const done = new Promise((resolve) => {
          child.on("error", () => resolve({ exitCode: 127, signal: null }));
          child.on("close", (code, signal) => resolve({ exitCode: code, signal }));
        });
        return {
          done,
          collected: {
            stdout: { readFrom: () => ({ text: stdout, lossy: false, nextOffset: stdout.length }) },
            stderr: { readFrom: () => ({ text: stderr, lossy: false, nextOffset: stderr.length }) },
          },
        };
      },
    },
  };
  return ctx;
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "kb-bi-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [id, title, body] of [
    ["d-en", "Power quality measurement instruments", "This part specifies power quality measurement instruments and functional tests."],
    ["d-zh", "电压暂降与短时中断", "电压暂降是指供电电压有效值降至额定值的 10% 至 90%。"],
  ]) {
    await mkdir(join(root, "markdown", id), { recursive: true });
    await writeFile(join(root, "markdown", id, `${id}.md`), `# ${title}\n\n### 第 1 页\n\n${body}\n`, "utf8");
  }
  const manifest = { docs: [
    { id: "d-en", title: "Power quality measurement instruments", type: "pdf-text", status: "ready", version: 1, trust: "high" },
    { id: "d-zh", title: "电压暂降与短时中断", type: "pdf-text", status: "ready", version: 1, trust: "high" },
  ] };
  return { root, manifest };
}

test("中文提问命中英文文献", { skip: !hasSqlite }, async (t) => {
  const { root, manifest } = await setup(t);
  const result = await searchKb(realSubprocess(), { signal: new AbortController().signal }, root, manifest, {
    pattern: "电能质量测量",
    ftsPattern: "电能质量测量",
    maxMatches: 10,
  });
  assert.equal(result.bilingual?.direction, "zh-en");
  assert.ok(result.matches.some((match) => match.docId === "d-en"), "英文文献应被召回");
  assert.match(result.note ?? "", /中英术语对照/);
});

test("英文提问命中中文文献", { skip: !hasSqlite }, async (t) => {
  const { root, manifest } = await setup(t);
  const result = await searchKb(realSubprocess(), { signal: new AbortController().signal }, root, manifest, {
    pattern: "voltage dip",
    ftsPattern: "voltage dip",
    maxMatches: 10,
  });
  assert.equal(result.bilingual?.direction, "en-zh");
  assert.ok(result.matches.some((match) => match.docId === "d-zh"), "中文文献应被召回");
});

test("标准号查询不做跨语言扩展", { skip: !hasSqlite }, async (t) => {
  const { root, manifest } = await setup(t);
  const result = await searchKb(realSubprocess(), { signal: new AbortController().signal }, root, manifest, {
    pattern: "GB/T 11032",
    ftsPattern: "GB/T 11032",
    maxMatches: 10,
  });
  assert.equal(result.bilingual, undefined);
});

test("另一语言有资料但未命中时给出下一步提示", { skip: !hasSqlite }, async (t) => {
  const { root, manifest } = await setup(t);
  const result = await searchKb(realSubprocess(), { signal: new AbortController().signal }, root, manifest, {
    pattern: "变压器局部放电",
    ftsPattern: "变压器局部放电",
    maxMatches: 10,
  });
  assert.equal(result.matches.length, 0);
  assert.match(result.note ?? "", /库内有 1 篇英文资料/);
});

test("词表未命中且原语言零结果时提示库内有另一语言资料", { skip: !hasSqlite }, async (t) => {
  const { root, manifest } = await setup(t);
  const result = await searchKb(realSubprocess(), { signal: new AbortController().signal }, root, manifest, {
    pattern: "完全无关的问题",
    ftsPattern: "完全无关的问题",
    maxMatches: 10,
  });
  assert.equal(result.matches.length, 0);
  assert.match(result.note ?? "", /库内有 1 篇英文资料/);
});
