/**
 * 0.31 语义索引（Task 2）：<kb>/.index/doc-vectors.f32 + doc-vectors.meta.json。
 * 全部用临时 kbRoot 与注入的假 embedder，不加载模型、不碰真实库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOC_PROFILE_SUMMARY,
  DOC_PROFILE_WINDOW,
  DOC_VECTORS_FILE,
  DOC_VECTORS_META_FILE,
  SEMANTIC_MODEL,
  docEmbedText,
  docVectorsStatus,
  ensureDocVectors,
  readDocVectors,
} from "../lib/semantic-index.js";

const DIM = 8;

async function makeRoot() {
  const dir = await mkdtemp(join(tmpdir(), "kb-semantic-index-"));
  await mkdir(join(dir, "markdown"), { recursive: true });
  return dir;
}

async function writeMarkdown(dir, doc, body = "4.1 第一条正文") {
  await mkdir(join(dir, "markdown", doc.id), { recursive: true });
  await writeFile(
    join(dir, "markdown", doc.id, `${doc.id}.md`),
    `# ${doc.title}\n\n${body}\n`,
    "utf8",
  );
}

function makeDoc(id, patch = {}) {
  return {
    id,
    title: `标准 ${id}`,
    standardNo: `GB/T ${id}`,
    tags: ["电能质量"],
    summary: `摘要 ${id}`,
    status: "ready",
    version: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  };
}

function makeManifest(docs) {
  return { name: "测试库", docs };
}

/** 假 embedder：每次调用返回单位向量（按递增计数换维度），并记录每次输入。 */
function fakeEmbedder({ dim = DIM, onEmbed = null } = {}) {
  const calls = [];
  let counter = 0;
  const embedder = async (texts) => {
    calls.push([...texts]);
    if (onEmbed) onEmbed(texts);
    return texts.map(() => {
      const vector = new Float32Array(dim);
      vector[counter % dim] = 1;
      counter += 1;
      return vector;
    });
  };
  return { embedder, calls };
}

function pathOf(dir, name) {
  return join(dir, ".index", name);
}

async function filePerm(path) {
  return (await stat(path)).mode & 0o777;
}

async function withRoot(run) {
  const dir = await makeRoot();
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("首建：3 篇 → 3 行、meta 字段齐、索引文件 0600", async () => {
  await withRoot(async (dir) => {
    const docs = [makeDoc("a"), makeDoc("b"), makeDoc("c")];
    for (const doc of docs) await writeMarkdown(dir, doc);
    const { embedder, calls } = fakeEmbedder();

    const result = await ensureDocVectors({ dir, manifest: makeManifest(docs), embedder });
    assert.equal(result.ok, true);
    assert.equal(result.built, "full");
    assert.equal(result.embedded, 3);
    assert.equal(result.docs, 3);
    assert.equal(result.dim, DIM);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 3);

    const bytes = await readFile(pathOf(dir, DOC_VECTORS_FILE));
    assert.equal(bytes.byteLength, 3 * DIM * 4);
    const meta = JSON.parse(await readFile(pathOf(dir, DOC_VECTORS_META_FILE), "utf8"));
    assert.equal(meta.schemaVersion, "1");
    assert.equal(meta.model, SEMANTIC_MODEL);
    assert.equal(meta.dim, DIM);
    assert.deepEqual(meta.docs.map((entry) => entry.id), ["a", "b", "c"]);
    assert.deepEqual(meta.docs.map((entry) => entry.version), [1, 1, 1]);
    assert.match(meta.manifestStamp, /^[0-9a-f]{64}$/);
    assert.ok(Number.isFinite(Date.parse(meta.builtAt)));
    assert.equal(await filePerm(pathOf(dir, DOC_VECTORS_FILE)), 0o600);
    assert.equal(await filePerm(pathOf(dir, DOC_VECTORS_META_FILE)), 0o600);
  });
});

test("manifest 不变（stamp 相同）→ 不重建、embedder 0 次", async () => {
  await withRoot(async (dir) => {
    const docs = [makeDoc("a"), makeDoc("b")];
    for (const doc of docs) await writeMarkdown(dir, doc);
    const manifest = makeManifest(docs);
    const { embedder, calls } = fakeEmbedder();

    await ensureDocVectors({ dir, manifest, embedder });
    calls.length = 0;
    const second = await ensureDocVectors({ dir, manifest, embedder });
    assert.equal(second.built, "none");
    assert.equal(second.embedded, 0);
    assert.equal(second.docs, 2);
    assert.equal(calls.length, 0);
  });
});

test("增量：改 1 篇（version+1）只重算 1 篇，未变行字节不变", async () => {
  await withRoot(async (dir) => {
    const docs = [makeDoc("a"), makeDoc("b"), makeDoc("c")];
    for (const doc of docs) await writeMarkdown(dir, doc);
    const first = fakeEmbedder();
    await ensureDocVectors({ dir, manifest: makeManifest(docs), embedder: first.embedder });
    const before = await readFile(pathOf(dir, DOC_VECTORS_FILE));

    const changed = docs.map((doc) => (doc.id === "b"
      ? { ...doc, version: 2, updatedAt: "2026-10-02T00:00:00.000Z", summary: "摘要 b 更新" }
      : doc));
    const second = fakeEmbedder();
    const result = await ensureDocVectors({ dir, manifest: makeManifest(changed), embedder: second.embedder });
    assert.equal(result.ok, true);
    assert.equal(result.built, "incremental");
    assert.equal(result.embedded, 1);
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].length, 1);
    assert.match(second.calls[0][0], /摘要 b 更新/);

    const after = await readFile(pathOf(dir, DOC_VECTORS_FILE));
    assert.equal(after.byteLength, before.byteLength);
    const row = DIM * 4;
    assert.deepEqual(after.subarray(0, row), before.subarray(0, row), "a 的向量应复用");
    assert.deepEqual(after.subarray(row * 2), before.subarray(row * 2), "c 的向量应复用");

    const meta = JSON.parse(await readFile(pathOf(dir, DOC_VECTORS_META_FILE), "utf8"));
    assert.deepEqual(meta.docs.map((entry) => entry.version), [1, 2, 1]);
  });
});

test("删除：删 1 篇 → 行数 2、顺序与 meta 一致、不重算", async () => {
  await withRoot(async (dir) => {
    const docs = [makeDoc("a"), makeDoc("b"), makeDoc("c")];
    for (const doc of docs) await writeMarkdown(dir, doc);
    const first = fakeEmbedder();
    await ensureDocVectors({ dir, manifest: makeManifest(docs), embedder: first.embedder });
    const before = await readFile(pathOf(dir, DOC_VECTORS_FILE));

    const kept = [docs[0], docs[2]];
    const second = fakeEmbedder();
    const result = await ensureDocVectors({ dir, manifest: makeManifest(kept), embedder: second.embedder });
    assert.equal(result.ok, true);
    assert.equal(result.built, "incremental");
    assert.equal(result.embedded, 0);
    assert.equal(result.docs, 2);
    assert.equal(second.calls.length, 0);

    const after = await readFile(pathOf(dir, DOC_VECTORS_FILE));
    const row = DIM * 4;
    assert.deepEqual(after.subarray(0, row), before.subarray(0, row));
    assert.deepEqual(after.subarray(row), before.subarray(row * 2));
    const meta = JSON.parse(await readFile(pathOf(dir, DOC_VECTORS_META_FILE), "utf8"));
    assert.deepEqual(meta.docs.map((entry) => entry.id), ["a", "c"]);
  });
});

test("文件截断 / 维度不符 → status ready=false，ensure 全量重建且不抛", async () => {
  await withRoot(async (dir) => {
    const docs = [makeDoc("a"), makeDoc("b"), makeDoc("c")];
    for (const doc of docs) await writeMarkdown(dir, doc);
    const manifest = makeManifest(docs);
    const first = fakeEmbedder();
    await ensureDocVectors({ dir, manifest, embedder: first.embedder });

    await truncate(pathOf(dir, DOC_VECTORS_FILE), 6);
    const broken = await docVectorsStatus({ dir, manifest });
    assert.equal(broken.ready, false);
    assert.ok(broken.reason);
    const read = await readDocVectors({ dir, manifest });
    assert.equal(read.ok, false);
    assert.ok(read.reason);

    const second = fakeEmbedder();
    const rebuilt = await ensureDocVectors({ dir, manifest, embedder: second.embedder });
    assert.equal(rebuilt.ok, true);
    assert.equal(rebuilt.built, "full");
    assert.equal(rebuilt.embedded, 3);
    assert.equal((await docVectorsStatus({ dir, manifest })).ready, true);

    // meta 的 dim 与文件大小不符：同样视为损坏并重建。
    const metaPath = pathOf(dir, DOC_VECTORS_META_FILE);
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    await writeFile(metaPath, JSON.stringify({ ...meta, dim: DIM * 2 }), "utf8");
    const status = await docVectorsStatus({ dir, manifest });
    assert.equal(status.ready, false);
    const third = fakeEmbedder();
    assert.equal((await ensureDocVectors({ dir, manifest, embedder: third.embedder })).built, "full");
  });
});

test("embedder 失败：返回 ok=false，不写坏旧索引", async () => {
  await withRoot(async (dir) => {
    const docs = [makeDoc("a"), makeDoc("b")];
    for (const doc of docs) await writeMarkdown(dir, doc);
    await ensureDocVectors({ dir, manifest: makeManifest(docs), embedder: fakeEmbedder().embedder });

    const changed = docs.map((doc) => ({ ...doc, version: 2, updatedAt: "2026-10-03T00:00:00.000Z" }));
    const boom = async () => { throw new Error("模型炸了"); };
    const result = await ensureDocVectors({ dir, manifest: makeManifest(changed), embedder: boom });
    assert.equal(result.ok, false);
    assert.match(result.reason, /模型炸了/);

    // 旧索引仍可读（只是 stale），没有被半写坏。
    const read = await readDocVectors({ dir, manifest: makeManifest(changed) });
    assert.equal(read.ok, true);
    assert.equal(read.fresh, false);
    assert.deepEqual(read.ids, ["a", "b"]);
  });
});

test("readDocVectors：按 meta 顺序返回归一化前的行视图与 fresh 标记", async () => {
  await withRoot(async (dir) => {
    const docs = [makeDoc("a"), makeDoc("b")];
    for (const doc of docs) await writeMarkdown(dir, doc);
    const manifest = makeManifest(docs);
    await ensureDocVectors({ dir, manifest, embedder: fakeEmbedder().embedder });

    const read = await readDocVectors({ dir, manifest });
    assert.equal(read.ok, true);
    assert.equal(read.fresh, true);
    assert.equal(read.dim, DIM);
    assert.deepEqual(read.ids, ["a", "b"]);
    assert.equal(read.vectors.length, 2);
    assert.equal(read.vectors[0].length, DIM);
    assert.equal(read.vectors[0][0], 1);

    const changed = [docs[0], { ...docs[1], version: 9 }];
    assert.equal((await readDocVectors({ dir, manifest: makeManifest(changed) })).fresh, false);
    assert.equal((await docVectorsStatus({ dir, manifest: makeManifest(changed) })).fresh, false);
  });
});

test("空清单：不写索引文件，也不调用 embedder", async () => {
  await withRoot(async (dir) => {
    const { embedder, calls } = fakeEmbedder();
    const result = await ensureDocVectors({ dir, manifest: makeManifest([]), embedder });
    assert.equal(result.ok, true);
    assert.equal(result.docs, 0);
    assert.equal(calls.length, 0);
    assert.equal((await docVectorsStatus({ dir, manifest: makeManifest([]) })).ready, false);
  });
});

test("docEmbedText：标准号+标题+标签+摘要+首条款，总长 ≤600", async () => {
  await withRoot(async (dir) => {
    const doc = makeDoc("a", { tags: ["电能质量", "电压"], summary: "一句话摘要" });
    await writeMarkdown(dir, doc, "4.1 供电电压偏差限值");
    const text = await docEmbedText({ dir, doc });
    assert.equal(text, "GB/T a 标准 a 电能质量 电压 一句话摘要 供电电压偏差限值");
    assert.ok(text.length <= 600);

    const huge = makeDoc("b", { summary: "长".repeat(900) });
    await writeMarkdown(dir, huge);
    assert.equal((await docEmbedText({ dir, doc: huge })).length, 600);

    // 原件缺失时退回元数据，不抛错。
    const missing = makeDoc("c");
    assert.equal(await docEmbedText({ dir, doc: missing }), "GB/T c 标准 c 电能质量 摘要 c");
  });
});

test("window 画像：多窗口取质心、meta.profile 可区分，切换画像会判 stale", async () => {
  await withRoot(async (dir) => {
    const doc = makeDoc("w1");
    const body = [
      "### 第 1 页", "第一页范围。", "### 第 2 页", `${"中段条款内容。".repeat(60)}`,
      "### 第 3 页", "第三页限值。",
    ].join("\n\n");
    await writeMarkdown(dir, doc, body);
    const { embedder, calls } = fakeEmbedder();
    const result = await ensureDocVectors({
      dir,
      manifest: makeManifest([doc]),
      embedder,
      profile: DOC_PROFILE_WINDOW,
    });
    assert.equal(result.ok, true);
    assert.equal(result.profile, DOC_PROFILE_WINDOW);
    assert.equal(result.docs, 1);
    assert.ok(calls[0].length > 1, "window profile must embed multiple windows per doc");
    const meta = JSON.parse(await readFile(pathOf(dir, DOC_VECTORS_META_FILE), "utf8"));
    assert.equal(meta.profile, DOC_PROFILE_WINDOW);
    const windowRead = await readDocVectors({ dir, manifest: makeManifest([doc]), profile: DOC_PROFILE_WINDOW });
    assert.equal(windowRead.ok, true);
    assert.equal(windowRead.ids.length, 1);
    assert.ok(Math.abs(windowRead.vectors[0].reduce((sum, value) => sum + value * value, 0) - 1) < 1e-5);
    const summaryRead = await readDocVectors({ dir, manifest: makeManifest([doc]), profile: DOC_PROFILE_SUMMARY });
    assert.equal(summaryRead.ok, false);
    assert.equal(summaryRead.reason, "profile");
    const status = await docVectorsStatus({ dir, manifest: makeManifest([doc]), profile: DOC_PROFILE_WINDOW });
    assert.equal(status.ready, true);
    assert.equal(status.profile, DOC_PROFILE_WINDOW);
  });
});

test("summary 画像摘要变化必须重算；window 画像不依赖摘要可复用", async () => {
  await withRoot(async (dir) => {
    const doc = makeDoc("s1", { summary: "旧摘要" });
    await writeMarkdown(dir, doc, "正文内容");
    const first = fakeEmbedder();
    await ensureDocVectors({
      dir,
      manifest: makeManifest([doc]),
      embedder: first.embedder,
      profile: DOC_PROFILE_SUMMARY,
    });
    const next = { ...doc, summary: "新摘要" };
    const second = fakeEmbedder();
    const changed = await ensureDocVectors({
      dir,
      manifest: makeManifest([next]),
      embedder: second.embedder,
      profile: DOC_PROFILE_SUMMARY,
    });
    assert.equal(changed.embedded, 1, "summary changed -> must re-embed");

    const firstWindow = fakeEmbedder();
    await ensureDocVectors({
      dir,
      manifest: makeManifest([next]),
      embedder: firstWindow.embedder,
      profile: DOC_PROFILE_WINDOW,
    });
    const nextWindow = fakeEmbedder();
    const unchanged = await ensureDocVectors({
      dir,
      manifest: makeManifest([{ ...next, summary: "又一个摘要" }]),
      embedder: nextWindow.embedder,
      profile: DOC_PROFILE_WINDOW,
    });
    assert.equal(unchanged.embedded, 0, "window profile must not re-embed for summary-only change");
  });
});
