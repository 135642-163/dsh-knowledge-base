/**
 * 0.13.0/0.16.0 清单 v2 → v4：
 * - 文档补齐 summary/summarySource/tags；
 * - 笔记补齐 kind/sources/linksOut；
 * - 首次写入 v3 前备份为 kb.json.v2.bak（v1 仍沿用 kb.json.v1.bak）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, docSize, markImporting, readManifest } from "../lib/store.js";

async function makeV2(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "kb.json"),
    JSON.stringify(
      {
        schemaVersion: 2,
        name: "旧库",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        docs: [
          {
            id: "d1",
            title: "资料",
            type: "pdf-text",
            status: "ready",
            outline: [{ title: "第一章", level: 1, page: 1, part: 1 }],
            pages: 3,
            chars: 100,
            parts: 1,
            version: 1,
            contentSource: "text-layer",
            parserVersion: "2026-01-01.1",
          },
          {
            id: "d2",
            title: "旧笔记",
            type: "note",
            status: "ready",
            outline: [],
            chars: 20,
            parts: 1,
            version: 2,
            contentSource: "note",
            parserVersion: "2026-01-01.1",
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
}

test("v2 manifest migrates to v5 with compile-layer and trust defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-v3-"));
  try {
    await makeV2(dir);
    const manifest = await readManifest(dir);
    assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
    for (const doc of manifest.docs) {
      assert.equal(doc.summary, "");
      assert.equal(doc.summarySource, "");
      assert.deepEqual(doc.tags, []);
      assert.equal(doc.trust, "unknown");
      assert.equal(doc.trustReason, "");
    }
    const note = manifest.docs.find((d) => d.id === "d2");
    assert.equal(note.kind, "note");
    assert.deepEqual(note.sources, []);
    assert.deepEqual(note.linksOut, []);
    const info = docSize(dir, note);
    assert.equal(info.kind, "note");
    assert.equal(info.hasSummary, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first v5 write backs up the v2 manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-v3-write-"));
  try {
    await makeV2(dir);
    await markImporting(dir, {
      id: "d3",
      title: "新文档",
      type: "text",
      sourceFile: "c.txt",
      sourcePath: "/tmp/c.txt",
    });
    const raw = JSON.parse(await readFile(join(dir, "kb.json"), "utf8"));
    assert.equal(raw.schemaVersion, SCHEMA_VERSION);
    assert.equal(raw.docs.find((d) => d.id === "d2").kind, "note");
    await access(join(dir, "kb.json.v2.bak"));
    const backup = JSON.parse(await readFile(join(dir, "kb.json.v2.bak"), "utf8"));
    assert.equal(backup.schemaVersion, 2);
    assert.equal(backup.docs.find((d) => d.id === "d2").kind, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
