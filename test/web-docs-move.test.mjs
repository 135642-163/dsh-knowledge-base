/**
 * 跨库移动 HTTP 路由：预检/移动/撤销、鉴权、404/400/409/413 映射与错误脱敏。
 * 全部走 handleApi，写请求带 x-kb-ui + 同源头，与工作台真实请求一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { readManifest, writeManifestAtomic } from "../lib/store.js";

const KB = "源库";
const TARGET = "目标库";
const HOST = "127.0.0.1:55929";

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body += body;
    },
  };
}

function makeReq({ method = "GET", url = "/kb/api/status", headers = {}, body } = {}) {
  return {
    method,
    url,
    headers: {
      host: HOST,
      origin: `http://${HOST}`,
      "x-kb-ui": "1",
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

function moveUrl(action = "") {
  return `/kb/api/kbs/${encodeURIComponent(KB)}/docs/move${action ? `/${action}` : ""}`;
}

function undoUrl(id) {
  return `/kb/api/kbs/${encodeURIComponent(KB)}/docs/${encodeURIComponent(id)}/undo-move`;
}

async function addDoc(kbDir, options = {}) {
  const {
    id,
    title = `文档 ${id}`,
    status = "ready",
    sourceHash = "",
    sourceBytes = 16,
    extra = {},
  } = options;
  const sourceName = `${id}.pdf`;
  await mkdir(join(kbDir, "sources"), { recursive: true });
  await writeFile(join(kbDir, "sources", sourceName), Buffer.alloc(sourceBytes, 0x61));
  await mkdir(join(kbDir, "markdown", id), { recursive: true });
  await writeFile(join(kbDir, "markdown", id, `${id}.md`), `# ${title}\n\n正文 ${id}\n`, "utf8");
  await mkdir(join(kbDir, "markdown", id, "parts"), { recursive: true });
  await writeFile(join(kbDir, "markdown", id, "parts", "0001.md"), `正文 ${id}\n`, "utf8");
  const manifest = await readManifest(kbDir);
  manifest.docs.push({
    id,
    title,
    type: "pdf-text",
    status,
    pages: 1,
    chars: 10,
    parts: 1,
    sourceFile: sourceName,
    sourcePath: `/outside/${sourceName}`,
    sourceHash,
    version: 1,
    ...extra,
  });
  await writeManifestAtomic(kbDir, manifest);
  return manifest.docs.at(-1);
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-move-api-"));
  const kbRoot = join(root, "kb");
  const source = await createKb(kbRoot, { name: KB });
  const target = await createKb(kbRoot, { name: TARGET });
  return { root, kbRoot, sourceDir: source.dir, targetDir: target.dir };
}

async function docOf(kbDir, id) {
  const manifest = await readManifest(kbDir);
  return (manifest.docs ?? []).find((doc) => doc.id === id) ?? null;
}

function assertNoRoot(body, kbRoot) {
  assert.equal(String(body).includes(kbRoot), false, "错误响应不能包含知识库根目录");
}

test("preflight, move and undo round-trip through HTTP", async () => {
  const env = await setup();
  try {
    await addDoc(env.sourceDir, { id: "d1", title: "电压偏差", sourceHash: "h1" });

    const pre = await call(
      { kbRoot: env.kbRoot },
      makeReq({
        method: "POST",
        url: moveUrl("preflight"),
        body: { ids: ["d1"], target: TARGET },
      })
    );
    assert.equal(pre.res.status, 200);
    assert.equal(pre.json.docs.length, 1);
    assert.equal(pre.json.docs[0].title, "电压偏差");
    assert.equal(pre.json.docs[0].conflict, null);
    assert.equal(pre.json.totalBytes, 16);
    // 预检只读：两库清单都没变。
    assert.equal((await docOf(env.sourceDir, "d1")).status, "ready");
    assert.equal(await docOf(env.targetDir, "d1"), null);

    const moved = await call(
      { kbRoot: env.kbRoot },
      makeReq({
        method: "POST",
        url: moveUrl(),
        body: { ids: ["d1"], target: TARGET },
      })
    );
    assert.equal(moved.res.status, 200);
    assert.equal(moved.json.moved, 1);
    assert.equal(moved.json.skipped, 0);
    assert.equal(moved.json.failed, 0);
    assert.ok(moved.json.transferId);

    const targetDoc = await docOf(env.targetDir, "d1");
    assert.equal(targetDoc.status, "ready");
    assert.equal(targetDoc.movedFrom.kb, KB);
    assert.equal((await docOf(env.sourceDir, "d1")).status, "deleted");
    assert.equal(
      await readFile(join(env.targetDir, "sources", "d1.pdf"), "utf8"),
      "a".repeat(16)
    );

    const undone = await call(
      { kbRoot: env.kbRoot },
      makeReq({
        method: "POST",
        url: undoUrl("d1"),
        body: { target: TARGET },
      })
    );
    assert.equal(undone.res.status, 200);
    assert.equal(undone.json.source.status, "ready");
    assert.equal(undone.json.source.deleted, false);
    assert.equal(undone.json.target.status, "deleted");
    assert.equal(undone.json.target.deleted, true);
    assert.equal((await docOf(env.sourceDir, "d1")).status, "ready");
    assert.equal((await docOf(env.targetDir, "d1")).status, "deleted");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("move routes map TransferError codes and never leak the kb root", async () => {
  const env = await setup();
  try {
    await addDoc(env.sourceDir, { id: "d1", title: "可移动" });
    await addDoc(env.sourceDir, { id: "bad1", title: "失败资料", status: "failed" });

    const cases = [
      {
        url: moveUrl("preflight"),
        body: { ids: ["d1"], target: "没有这个库" },
        status: 404,
        code: "TRANSFER_KB_NOT_FOUND",
      },
      {
        url: moveUrl("preflight"),
        body: { ids: ["d1"], target: KB },
        status: 400,
        code: "TRANSFER_SAME_KB",
      },
      {
        url: moveUrl("preflight"),
        body: { ids: ["nope"], target: TARGET },
        status: 404,
        code: "TRANSFER_DOC_NOT_FOUND",
      },
      {
        url: moveUrl("preflight"),
        body: { ids: ["bad1"], target: TARGET },
        status: 409,
        code: "TRANSFER_DOC_NOT_READY",
      },
      {
        url: moveUrl(),
        body: { ids: ["d1"], target: TARGET, onConflict: "explode" },
        status: 400,
        code: "TRANSFER_INVALID_REQUEST",
      },
      {
        url: moveUrl(),
        body: { target: TARGET },
        status: 400,
        code: "TRANSFER_INVALID_REQUEST",
      },
      {
        url: undoUrl("d1"),
        body: { target: TARGET },
        status: 409,
        code: "TRANSFER_UNDO_UNAVAILABLE",
      },
    ];
    for (const item of cases) {
      const result = await call(
        { kbRoot: env.kbRoot },
        makeReq({ method: "POST", url: item.url, body: item.body })
      );
      assert.equal(result.res.status, item.status, `${item.code} status`);
      assert.equal(result.json.error.code, item.code);
      assertNoRoot(result.res.body, env.kbRoot);
    }

    // 未知源知识库由 ensureKb 统一返回 404。
    const missingKb = await call(
      { kbRoot: env.kbRoot },
      makeReq({
        method: "POST",
        url: "/kb/api/kbs/%E4%B8%8D%E5%AD%98%E5%9C%A8/docs/move/preflight",
        body: { ids: ["d1"], target: TARGET },
      })
    );
    assert.equal(missingKb.res.status, 404);
    assert.equal(missingKb.json.error.code, "KB_NOT_FOUND");
    assertNoRoot(missingKb.res.body, env.kbRoot);

    // 已合并的库不能作为目标。
    const targetManifest = await readManifest(env.targetDir);
    targetManifest.mergedInto = KB;
    await writeManifestAtomic(env.targetDir, targetManifest);
    const merged = await call(
      { kbRoot: env.kbRoot },
      makeReq({
        method: "POST",
        url: moveUrl("preflight"),
        body: { ids: ["d1"], target: TARGET },
      })
    );
    assert.equal(merged.res.status, 409);
    assert.equal(merged.json.error.code, "TRANSFER_TARGET_MERGED");
    assertNoRoot(merged.res.body, env.kbRoot);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("move endpoints enforce the 50-doc cap with HTTP 413", async () => {
  const env = await setup();
  try {
    const ids = [];
    for (let i = 0; i < 51; i += 1) {
      const id = `c${String(i).padStart(2, "0")}`;
      ids.push(id);
      await addDoc(env.sourceDir, { id, sourceBytes: 8 });
    }
    for (const url of [moveUrl("preflight"), moveUrl()]) {
      const result = await call(
        { kbRoot: env.kbRoot },
        makeReq({ method: "POST", url, body: { ids, target: TARGET } })
      );
      assert.equal(result.res.status, 413);
      assert.equal(result.json.error.code, "TRANSFER_TOO_MANY");
      assert.match(result.json.error.message, /最多移动 50 篇/);
      assertNoRoot(result.res.body, env.kbRoot);
    }
    // 被拒绝的批次没有动任何清单/文件。
    assert.equal((await readManifest(env.targetDir)).docs.length, 0);
    assert.equal((await docOf(env.sourceDir, "c00")).status, "ready");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test("move/undo POSTs require x-kb-ui and same-origin", async () => {
  const env = await setup();
  try {
    await addDoc(env.sourceDir, { id: "d1", title: "鉴权" });
    const cases = [
      { url: moveUrl("preflight"), body: { ids: ["d1"], target: TARGET } },
      { url: moveUrl(), body: { ids: ["d1"], target: TARGET } },
      { url: undoUrl("d1"), body: { target: TARGET } },
    ];
    for (const item of cases) {
      const noHeader = await call(
        { kbRoot: env.kbRoot },
        makeReq({
          method: "POST",
          url: item.url,
          headers: { "x-kb-ui": "" },
          body: item.body,
        })
      );
      assert.equal(noHeader.res.status, 403, `${item.url} without x-kb-ui`);
      const crossOrigin = await call(
        { kbRoot: env.kbRoot },
        makeReq({
          method: "POST",
          url: item.url,
          headers: { origin: "http://evil.example", host: HOST },
          body: item.body,
        })
      );
      assert.equal(crossOrigin.res.status, 403, `${item.url} cross-origin`);
    }
    assert.equal((await docOf(env.sourceDir, "d1")).status, "ready");
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});
