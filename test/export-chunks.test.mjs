/**
 * 0.7.0 RAG 小块导出：jsonl + chunkSize/chunkOverlap。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJsonl } from "../lib/store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kb-export-chunks-"));
  const kbDir = join(root, "RAG");
  const docId = "abc123";
  const partsDir = join(kbDir, "markdown", docId, "parts");
  await mkdir(partsDir, { recursive: true });
  await writeFile(
    join(partsDir, "0001.md"),
    [
      "<!-- doc: 测试文档 | 部分 1/1 -->",
      "### 第一章",
      "",
      "第一段内容。".repeat(20),
      "",
      "第二段内容。".repeat(20),
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(partsDir, "index.json"),
    JSON.stringify([{ part: 1, file: "0001.md", pageStart: 3, pageEnd: 4 }]),
    "utf8"
  );
  const manifest = {
    name: "RAG",
    docs: [
      {
        id: docId,
        title: "测试文档",
        type: "pdf-text",
        status: "ready",
        parts: 1,
        contentSource: "text-layer",
      },
    ],
  };
  return { root, kbDir, manifest };
}

test("jsonl chunks carry part/page metadata and respect maxChars", async () => {
  const { root, kbDir, manifest } = await fixture();
  try {
    const out = join(root, "chunks.jsonl");
    const r = await exportJsonl(kbDir, manifest, out, { chunkSize: 40, chunkOverlap: 8 });
    const lines = (await readFile(out, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(lines.length > 1);
    assert.equal(r.chunks, lines.length);
    const partChunks = lines.filter((line) => line.part === 1);
    assert.equal(partChunks.length, lines.length);
    for (const line of lines) {
      assert.equal(line.docId, "abc123");
      assert.equal(line.title, "测试文档");
      assert.equal(line.type, "pdf-text");
      assert.equal(line.pageStart, 3);
      assert.equal(line.pageEnd, 4);
      assert.equal(line.contentSource, "text-layer");
      assert.equal(line.chunks, lines.length);
      assert.equal(line.chars, line.text.length);
      assert.ok(line.text.length <= 40);
      assert.doesNotMatch(line.text, /<!-- doc:/);
    }
    assert.deepEqual(
      lines.map((line) => line.chunk),
      Array.from({ length: lines.length }, (_, i) => i + 1)
    );
    assert.ok(lines.some((line) => line.text.includes("第一段")));
    assert.ok(lines.some((line) => line.text.includes("第二段")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("jsonl without chunkSize keeps one line per part", async () => {
  const { root, kbDir, manifest } = await fixture();
  try {
    const out = join(root, "parts.jsonl");
    const r = await exportJsonl(kbDir, manifest, out, {});
    const lines = (await readFile(out, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(r.chunks, 0);
    assert.equal(lines[0].part, 1);
    assert.match(lines[0].text, /<!-- doc: 测试文档/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
