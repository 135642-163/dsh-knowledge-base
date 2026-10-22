/**
 * 0.4.0 清单 v1 → v2：
 * - outline 从 string[] 升级为 {title, level, page, part}；
 * - 给旧文档推断 contentSource；
 * - 首次写入 v2 前备份 kb.json.v1.bak。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, docSize, markImporting, readManifest, tryReadManifest } from "../lib/store.js";

async function makeV1(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "kb.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        name: "旧库",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        docs: [
          {
            id: "d1",
            title: "扫描书",
            type: "pdf-scanned",
            status: "ready",
            outline: ["第一章", "第二章"],
            sourceFile: "a.pdf",
            pages: 10,
            chars: 100,
            parts: 2,
            version: 1,
          },
          {
            id: "d2",
            title: "笔记",
            type: "note",
            status: "ready",
            outline: [],
            version: 1,
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
}

test("readManifest migrates v1 in memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-migrate-"));
  try {
    await makeV1(dir);
    const manifest = await readManifest(dir);
    assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(manifest.docs[0].outline[0], {
      title: "第一章",
      level: 1,
      page: null,
      part: null,
    });
    assert.equal(manifest.docs[0].contentSource, "ocr");
    assert.equal(manifest.docs[0].edited, false);
    assert.equal(manifest.docs[1].contentSource, "note");
    assert.equal(docSize(dir, manifest.docs[0]).stale, true, "legacy docs must be marked stale");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tryReadManifest also migrates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-migrate-try-"));
  try {
    await makeV1(dir);
    const manifest = await tryReadManifest(dir);
    assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
    assert.equal(typeof manifest.docs[0].outline[0], "object");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first v2 write backs up the v1 manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-migrate-write-"));
  try {
    await makeV1(dir);
    await markImporting(dir, {
      id: "d3",
      title: "新文档",
      type: "text",
      sourceFile: "c.txt",
      sourcePath: "/tmp/c.txt",
    });
    const raw = JSON.parse(await readFile(join(dir, "kb.json"), "utf8"));
    assert.equal(raw.schemaVersion, SCHEMA_VERSION);
    assert.equal(raw.docs[0].contentSource, "ocr");
    assert.equal(raw.docs[0].outline[0].title, "第一章");

    const backup = JSON.parse(await readFile(join(dir, "kb.json.v1.bak"), "utf8"));
    assert.equal(backup.schemaVersion, 1);
    assert.equal(backup.docs[0].outline[0], "第一章");
    await access(join(dir, "kb.json.v1.bak"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
