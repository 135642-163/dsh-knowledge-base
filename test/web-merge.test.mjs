import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/web/api.js";
import { createKb } from "../lib/kbmeta.js";
import { createJobRegistry } from "../lib/web/jobs.js";
import { kbDirPath, readManifest, writeManifestAtomic } from "../lib/store.js";

function makeRes() {
  return { status: 0, headers: {}, body: "", writeHead(s, h) { this.status = s; this.headers = h; }, end(b = "") { this.body += b; } };
}
function makeReq(body, method = "POST", url = "/kb/api/merge") {
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
async function addDoc(root, kb, id, title) {
  const dir = kbDirPath(root, kb);
  const manifest = await readManifest(dir);
  manifest.docs.push({ id, title, type: "text", status: "ready", sourceHash: id, chars: 100, parts: 1, version: 1 });
  await writeManifestAtomic(dir, manifest);
  await mkdir(join(dir, "markdown", id), { recursive: true });
  await writeFile(join(dir, "markdown", id, `${id}.md`), `# ${title}\n\n正文\n`, "utf8");
}
async function waitJob(jobs, id, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) {
    const job = await jobs.get(id);
    if (job && job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job timeout");
}

test("merge API：preview 只读、execute 需确认并后台完成", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-merge-api-"));
  try {
    await createKb(root, { name: "A" });
    await createKb(root, { name: "B" });
    await addDoc(root, "A", "a1", "GB/T 1-2020 甲");
    await addDoc(root, "B", "b1", "GB/T 2-2020 乙");
    const jobs = createJobRegistry();
    const opts = { kbRoot: root, jobs, limits: { maxUploadBytes: 1024, maxBatchFiles: 10, extensions: [".md"] } };
    const body = { sources: ["A", "B"], target: { name: "C", create: true } };

    const preview = await call(opts, makeReq(body, "POST", "/kb/api/merge/preview"));
    assert.equal(preview.res.status, 200);
    assert.equal(preview.json.plan.summary.move, 2);
    const before = await readManifest(kbDirPath(root, "A"));
    assert.equal(before.mergedInto, null);

    const noConfirm = await call(opts, makeReq(body));
    assert.equal(noConfirm.res.status, 400);
    assert.match(noConfirm.json.error.message, /确认/);

    const started = await call(opts, makeReq({ ...body, confirm: true }));
    assert.equal(started.res.status, 202);
    assert.ok(started.json.jobId);
    const done = await waitJob(jobs, started.json.jobId);
    assert.equal(done.status, "succeeded");
    const c = await readManifest(kbDirPath(root, "C"));
    assert.equal(c.docs.length, 2);
    const a = await readManifest(kbDirPath(root, "A"));
    assert.equal(a.mergedInto, "C");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
