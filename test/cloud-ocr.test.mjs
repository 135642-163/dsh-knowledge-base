/**
 * 云端 OCR：逐页调用、失败回退、元数据记录。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ocrImageBatch } from "../lib/ocr.js";
import { importFileInto } from "../lib/pipeline.js";
import { readManifest } from "../lib/store.js";

test("engine=deepseek posts each page and maps results back", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    assert.match(String(url), /\/v1\/tools\/ocr$/);
    seen.push(init.body);
    return new Response(
      JSON.stringify({
        page_count: 1,
        pages: [{ index: 0, text: `<｜ref｜>第${seen.length}页<｜/ref｜>` }],
      }),
      { status: 200 }
    );
  };
  const jobs = [
    { png: Buffer.from("a"), page: 1 },
    { png: Buffer.from("b"), page: 2 },
  ];
  const results = await ocrImageBatch(jobs, {
    engine: "deepseek",
    deepseek: { apiKey: "sk-test", baseUrl: "https://api.deepseek.com", fetchImpl, concurrency: 2 },
  });
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.page), [1, 2]);
  assert.deepEqual(results.map((r) => r.text), ["第1页", "第2页"]);
  assert.ok(results.every((r) => r.engine === "deepseek"));
  assert.equal(seen.length, 2);
});

test("cloud failure without fallback surfaces the error", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
  await assert.rejects(
    () => ocrImageBatch([{ png: Buffer.from("a"), page: 1 }], {
      engine: "deepseek",
      cloudFallback: false,
      deepseek: { apiKey: "sk-bad", fetchImpl },
    }),
    /unauthorized/
  );
});

test("import persists sourceUrl and cloud defaults to false", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-cloud-meta-"));
  try {
    const dir = join(root, "kb");
    const src = join(root, "a.md");
    await writeFile(src, "# 标题\n\n正文。\n", "utf8");
    const report = await importFileInto(dir, {
      sourcePath: src,
      relKey: "a.md",
      title: "资料",
      sourceUrl: "https://example.com/a",
      config: { partMaxChars: 4000 },
    });
    const manifest = await readManifest(dir);
    const doc = manifest.docs.find((item) => item.id === report.docId);
    assert.equal(doc.sourceUrl, "https://example.com/a");
    assert.equal(doc.ocrCloud, false);
    assert.equal(doc.ocrCloudPages, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
