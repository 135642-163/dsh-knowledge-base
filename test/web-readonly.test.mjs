import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { importFileInto } from "../lib/pipeline.js";
import { kbDirPath, readManifest, writeManifestAtomic } from "../lib/store.js";

function makeRes() {
  return { status: 0, headers: {}, body: "", writeHead(s, h) { this.status = s; this.headers = h; }, end(b = "") { this.body += b; } };
}
function makeReq({ method = "GET", url = "/kb/api/status", body } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1" },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
  };
}
async function call(opts, req) {
  const res = makeRes();
  await handleApi(req, res, { opts, fence: () => true });
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

test("web readOnly：状态可见、写操作 409、可关闭只读", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-readonly-web-"));
  try {
    await createKb(root, { name: "共享库" });
    const file = join(root, "a.txt");
    await writeFile(file, "只读共享正文。\n", "utf8");
    const dir = kbDirPath(root, "共享库");
    const imported = await importFileInto(dir, { sourcePath: file, relKey: "a.txt", title: "共享资料", config: { partMaxChars: 500 } });
    const manifest = await readManifest(dir);
    manifest.readOnly = true;
    await writeManifestAtomic(dir, manifest);

    const opts = { kbRoot: root };
    const status = await call(opts, makeReq({ url: "/kb/api/kbs/共享库" }));
    assert.equal(status.json.kb.readOnly, true);
    const del = await call(opts, makeReq({ method: "POST", url: `/kb/api/kbs/共享库/docs/${imported.docId}/delete` }));
    assert.equal(del.res.status, 409);
    assert.equal(del.json.error.code, "KB_READONLY");
    const badMeta = await call(opts, makeReq({ method: "PATCH", url: "/kb/api/kbs/共享库", body: { description: "改简介" } }));
    assert.equal(badMeta.res.status, 409);
    const off = await call(opts, makeReq({ method: "PATCH", url: "/kb/api/kbs/共享库", body: { readOnly: false } }));
    assert.equal(off.res.status, 200);
    assert.equal(off.json.kb.readOnly, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
