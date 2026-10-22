/**
 * 检索输出上限：高频词不能因为超过 16MB 缓冲就整体失败。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotateMatches, buildRgArgs, parseRgOutput, searchKb } from "../lib/query.js";

const KB_DIR = "/tmp/kb-query-test";
const MANIFEST = { docs: [{ id: "doc1", title: "文档一" }] };

function matchLine(path, lineNumber, text) {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      line_number: lineNumber,
      lines: { text: `${text}\n` },
    },
  });
}

function fakeContext({ text = "", lossy = false, exitCode = 0, stderr = "" } = {}) {
  const calls = [];
  const ctx = {
    subprocess: {
      spawn(options) {
        calls.push(options);
        return {
          done: Promise.resolve({ exitCode, signal: null }),
          collected: {
            stdout: {
              readFrom: () => ({ text, lossy, nextOffset: text.length }),
            },
            stderr: {
              readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }),
            },
          },
        };
      },
    },
  };
  return { ctx, calls };
}

const exec = { signal: { aborted: false } };

test("buildRgArgs caps matches per file", () => {
  const args = buildRgArgs("/bin/rg", "电压", `${KB_DIR}/markdown`, {
    maxMatches: 40,
    lineBytes: 400,
  });
  assert.ok(args.includes("--max-count=5"), `missing --max-count: ${args.join(" ")}`);
  assert.equal(args[args.length - 1], `${KB_DIR}/markdown`);
});

test("buildRgArgs raises the per-file cap for a single-document search", () => {
  const args = buildRgArgs("/bin/rg", "电压", `${KB_DIR}/markdown/doc1`, {
    maxMatches: 40,
    scoped: true,
  });
  assert.ok(args.includes("--max-count=40"), `scoped search was capped: ${args.join(" ")}`);
});

test("parseRgOutput reports total and truncation", () => {
  const text = [
    matchLine(`${KB_DIR}/markdown/doc1/doc1.md`, 10, "电压偏差"),
    matchLine(`${KB_DIR}/markdown/doc1/doc1.md`, 20, "电压波动"),
    matchLine(`${KB_DIR}/markdown/doc1/doc1.md`, 30, "电压闪变"),
    matchLine(`${KB_DIR}/markdown/doc1/doc1.md`, 2, "<!-- doc: 书 | 部分 1/2 -->"),
  ].join("\n");
  const r = parseRgOutput(text, {
    manifest: MANIFEST,
    kbDir: KB_DIR,
    maxMatches: 2,
    lineBytes: 400,
  });
  assert.equal(r.total, 3, "part header comments must not count as content matches");
  assert.equal(r.matches.length, 2);
  assert.equal(r.truncated, true);
  assert.equal(r.matches[0].docId, "doc1");
  assert.equal(r.matches[0].path, "markdown/doc1/doc1.md");
});

test("searchKb keeps partial results when stdout is lossy", async () => {
  const text = matchLine(`${KB_DIR}/markdown/doc1/doc1.md`, 10, "电压偏差");
  const { ctx, calls } = fakeContext({ text, lossy: true });
  const r = await searchKb(ctx, exec, KB_DIR, MANIFEST, {
    pattern: "电压",
    maxMatches: 10,
    lineBytes: 400,
  });
  assert.equal(r.matches.length, 1);
  assert.equal(r.truncated, true);
  assert.equal(r.lossy, true);
  assert.ok(calls[0].argv.some((a) => a.startsWith("--max-count=")));
});

test("searchKb still rejects a ripgrep regex error", async () => {
  const { ctx } = fakeContext({ exitCode: 2, stderr: "regex parse error: unclosed group" });
  await assert.rejects(
    () =>
      searchKb(ctx, exec, KB_DIR, MANIFEST, {
        pattern: "(",
        maxMatches: 10,
        lineBytes: 400,
      }),
    /正则表达式被 ripgrep 拒绝/
  );
});


test("annotateMatches maps a line to its part and page range", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-annotate-"));
  try {
    const partsDir = join(dir, "markdown", "d1", "parts");
    await mkdir(partsDir, { recursive: true });
    await writeFile(
      join(partsDir, "index.json"),
      JSON.stringify([
        { part: 1, startLine: 1, endLine: 10, pageStart: 1, pageEnd: 3 },
        { part: 2, startLine: 12, endLine: 20, pageStart: 4, pageEnd: 5 },
      ]),
      "utf8"
    );
    const matches = [{ docId: "d1", lineNumber: 15 }];
    await annotateMatches(matches, dir);
    assert.equal(matches[0].part, 2);
    assert.equal(matches[0].pageStart, 4);
    assert.equal(matches[0].pageEnd, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
