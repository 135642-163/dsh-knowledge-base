/**
 * 0.4.0 分块索引：
 * - writeParts 产出 parts/index.json（合并版行号范围 + 页码范围）；
 * - annotateMatches 能把命中行映射到 part/page。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFileInto } from "../lib/pipeline.js";
import { annotateMatches } from "../lib/query.js";
import { readManifest, writeParts } from "../lib/store.js";

test("import writes a parts index and a structured outline", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-parts-"));
  try {
    const kbDir = join(root, "kb");
    await mkdir(kbDir, { recursive: true });
    const src = join(root, "book.md");
    await writeFile(
      src,
      "# 第一章\n\nAAAA 正文。\n\n# 第二章\n\nBBBB 正文。\n\n# 第三章\n\nCCCC 正文。\n",
      "utf8"
    );
    await importFileInto(kbDir, {
      sourcePath: src,
      relKey: "book.md",
      title: "书",
      config: { partMaxChars: 10 },
    });

    const manifest = await readManifest(kbDir);
    const doc = manifest.docs[0];
    assert.ok(Array.isArray(doc.outline));
    assert.equal(typeof doc.outline[0], "object");
    assert.ok(doc.outline.every((item) => item.part >= 1), JSON.stringify(doc.outline));

    const indexPath = join(kbDir, "markdown", doc.id, "parts", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    assert.ok(Array.isArray(index));
    assert.ok(index.length >= 3, `expected at least 3 parts, got ${index.length}`);
    assert.equal(index[0].part, 1);
    for (let i = 1; i < index.length; i++) {
      assert.ok(index[i].startLine > index[i - 1].endLine, JSON.stringify(index));
    }

    const matches = [
      {
        docId: doc.id,
        title: doc.title,
        path: "",
        lineNumber: index[1].startLine,
        line: "BBBB 正文。",
      },
    ];
    await annotateMatches(matches, kbDir);
    assert.equal(matches[0].part, index[1].part);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("writeParts records page ranges in the index", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-parts-pages-"));
  try {
    const staged = join(root, "staged");
    await mkdir(staged, { recursive: true });
    const sections = [
      { heading: "第1页", level: 2, text: "A", page: 1 },
      { heading: "第2页", level: 2, text: "B", page: 2 },
      { heading: "第3页", level: 2, text: "C", page: 3 },
    ];
    const result = await writeParts(staged, sections, { partMaxChars: 5, docTitle: "书" });
    const index = JSON.parse(await readFile(join(staged, "parts", "index.json"), "utf8"));
    assert.equal(index.length, 3);
    assert.equal(index[0].pageStart, 1);
    assert.equal(index[0].pageEnd, 1);
    assert.equal(index[1].pageStart, 2);
    assert.equal(index[2].pageEnd, 3);
    assert.equal(result.outline.length, 3);
    assert.ok(result.outline.every((item) => item.page >= 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
