/**
 * 0.4.0 kb_read：outline 返回结构化条目（含 part/page），part 读取返回页码范围。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { readManifest } from "../lib/store.js";

test("kb_read outline and part expose anchors", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-read-anchor-"));
  try {
    const kbRoot = join(root, "kb-root");
    await mkdir(kbRoot, { recursive: true });
    const tools = new Map();
    const ctx = {
      tools: { register(def) { tools.set(def.name, def); } },
      systemPrompt: { section() {} },
      get() { return undefined; },
    };
    await apply(ctx, { kbRoot, defaultKb: "测试库", partMaxChars: 10 });
    const exec = {
      agent: { session: { header: { cwd: root } } },
      signal: new AbortController().signal,
    };

    const src = join(root, "book.md");
    await writeFile(src, "# 第一章\n\nAAAA。\n\n# 第二章\n\nBBBB。\n", "utf8");
    const imported = await tools.get("kb_import").execute(
      { path: src, kb: "测试库", title: "书" },
      exec
    );
    const docId = imported.imported[0].docId;

    const outline = await tools.get("kb_read").execute(
      { kb: "测试库", doc: docId, part: "outline" },
      exec
    );
    assert.equal(typeof outline.outline[0], "object");
    assert.equal(outline.outline[0].title, "第一章");
    assert.ok(outline.outline[0].part >= 1);
    const outlineText = tools.get("kb_read").output.render(
      { kb: "测试库", doc: docId, part: "outline" },
      outline
    )[0].text;
    assert.match(outlineText, /部分 1/);

    // 给第一部分补一个页码范围，模拟 PDF 分块索引
    const manifest = await readManifest(join(kbRoot, "测试库"));
    const doc = manifest.docs.find((d) => d.id === docId);
    const indexPath = join(kbRoot, "测试库", "markdown", docId, "parts", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index[0].pageStart = 5;
    index[0].pageEnd = 6;
    await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
    await writeFile(
      join(kbRoot, "测试库", "markdown", doc.id, "pages.json"),
      JSON.stringify(
        [
          { page: 5, source: "ocr", corrupted: true, confidence: 40 },
          { page: 6, source: "ocr", corrupted: false, confidence: 50 },
        ],
        null,
        2
      ),
      "utf8"
    );

    const part = await tools.get("kb_read").execute(
      { kb: "测试库", doc: doc.id, part: 1 },
      exec
    );
    assert.equal(part.part, "1");
    assert.equal(part.pageStart, 5);
    assert.equal(part.pageEnd, 6);
    assert.equal(part.pageWarnings.length, 2);
    const partText = tools.get("kb_read").output.render(
      { kb: "测试库", doc: doc.id, part: 1 },
      part
    )[0].text;
    assert.match(partText, /第 5–6 页/);
    assert.match(partText, /文字层损坏\/OCR 低置信：第 5、6 页/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
