/**
 * 0.14.0 kb_lint：机械体检（失败/旧管线/损坏/内容重复/同号同期同阶段重复/
 * 多版本/未编目/笔记无来源/续修订版/孤页/缺 schema），且不能把
 * 征求意见稿、编制说明、不同年份误判成重复。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { lintManifest } from "../lib/lint.js";
import { PARSER_VERSION } from "../lib/version.js";

const now = Date.parse("2026-10-23T00:00:00Z");

function baseDoc(id, title, extra = {}) {
  return {
    id,
    title,
    type: "text",
    status: "ready",
    pages: 0,
    chars: 10,
    parts: 1,
    version: 1,
    contentSource: "text",
    parserVersion: PARSER_VERSION,
    outline: [],
    summary: "有摘要",
    tags: [],
    updatedAt: "2026-10-01T00:00:00.000Z",
    sourceHash: `hash-${id}`,
    ...extra,
  };
}

function makeManifest() {
  return {
    schemaVersion: 3,
    name: "体检库",
    docs: [
      baseDoc("f1", "坏文件", { status: "failed", error: "解析失败: 文件损坏" }),
      baseDoc("s1", "旧管线资料", { parserVersion: "old-pipeline" }),
      baseDoc("c1", "扫描件", {
        type: "pdf-scanned",
        contentSource: "ocr",
        corruptedPages: [2],
        lowConfidencePages: [3],
      }),
      baseDoc("h1", "完全重复 A", { sourceHash: "samehash" }),
      baseDoc("h2", "完全重复 B", { sourceHash: "samehash" }),
      baseDoc("d1", "GB/T 11032-2020 交流避雷器"),
      baseDoc("d2", "GB/T 11032-2020 交流避雷器（副本）"),
      baseDoc("d3", "GB/T 11032-2020 征求意见稿"),
      baseDoc("d4", "GB/T 11032-2020 编制说明"),
      baseDoc("d5", "GB/T 11032-2013 交流避雷器"),
      baseDoc("n1", "旧笔记（续）", {
        type: "note",
        kind: "note",
        chars: 20,
        sources: [],
        linksOut: [],
        summary: "",
      }),
      baseDoc("u1", "未编目资料", { summary: "" }),
    ],
  };
}

test("lintManifest finds mechanical problems without false duplicates", () => {
  const report = lintManifest(makeManifest(), { kbName: "体检库", hasSchema: true, now, maxItems: 20 });
  const c = report.counts;
  assert.equal(c.failed, 1);
  assert.equal(c.stale, 1);
  assert.equal(c.corrupted, 1);
  assert.equal(c.duplicateContentGroups, 1);
  assert.equal(c.sameNumberDuplicateGroups, 1, "only the two published duplicates");
  assert.equal(c.sameNumberStageGroups, 1);
  assert.equal(c.sameNumberMultiYearGroups, 1);
  assert.equal(c.notesWithoutSources, 1);
  assert.equal(c.supersedeHints, 1);
  assert.equal(c.orphanNotes, 0);
  assert.equal(c.unlabeled, 2);

  const dupGroup = report.groups.find((g) => g.code === "same-number");
  assert.ok(dupGroup);
  const dupTitles = dupGroup.items.map((i) => i.title).join(" / ");
  assert.match(dupTitles, /交流避雷器/);
  assert.doesNotMatch(dupTitles, /征求意见稿|编制说明|2013/);

  const codes = report.groups.map((g) => g.code);
  assert.ok(codes.includes("failed"));
  assert.ok(codes.includes("note-no-sources"));
  assert.ok(codes.includes("supersede-hint"));
  assert.ok(report.suggestions.some((s) => s.action === "kb_reparse"));
  assert.ok(report.suggestions.some((s) => s.action === "kb_describe"));
});

test("lintManifest reports a missing schema", () => {
  const report = lintManifest(makeManifest(), { kbName: "体检库", hasSchema: false, now });
  assert.equal(report.counts.hasSchema, false);
  assert.ok(report.groups.some((g) => g.code === "schema-missing"));
});

test("kb_lint tool renders a grouped report", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-lint-tool-"));
  try {
    const kbRoot = join(root, "kb-root");
    const kbDir = join(kbRoot, "体检库");
    await mkdir(kbDir, { recursive: true });
    await writeFile(join(kbDir, "kb.json"), JSON.stringify(makeManifest(), null, 2), "utf8");
    const tools = new Map();
    const ctx = {
      tools: { register(def) { tools.set(def.name, def); } },
      systemPrompt: { section() {} },
      get() { return undefined; },
    };
    await apply(ctx, { kbRoot, defaultKb: "体检库", partMaxChars: 500 });
    const exec = { agent: { session: { header: { cwd: root } } }, signal: new AbortController().signal };
    const result = await tools.get("kb_lint").execute({ kb: "体检库" }, exec);
    assert.equal(result.counts.failed, 1);
    assert.ok(result.groups.length > 0);
    const text = tools.get("kb_lint").output.render({ kb: "体检库" }, result)[0].text;
    assert.match(text, /体检/);
    assert.match(text, /建议动作/);
    assert.match(text, /kb_reparse/);
    assert.match(text, /同标准号/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
