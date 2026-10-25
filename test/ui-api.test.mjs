/**
 * 工作台 API 客户端：JSON 方法映射、XHR 上传的 URL/请求头/进度/错误。
 */
import test from "node:test";
import assert from "node:assert/strict";

const calls = [];
let payload = { ok: true, jobId: "kb-import-1" };
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  return { ok: true, status: 200, json: async () => payload };
};

class FakeXhr {
  constructor() {
    globalThis.__lastXhr = this;
    this.upload = {};
    this.headers = {};
    this.status = 200;
    this.response = { path: "a.md", size: 3 };
    this.sent = false;
    this.aborted = false;
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  addEventListener() {}
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  send(body) {
    this.body = body;
    this.sent = true;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    setTimeout(() => this.onload?.(), 0);
  }
}
globalThis.XMLHttpRequest = FakeXhr;

function fakeSignal() {
  const listeners = [];
  return {
    aborted: false,
    listeners,
    addEventListener(type, fn) { if (type === "abort") listeners.push(fn); },
    removeEventListener(type, fn) {
      if (type !== "abort") return;
      const index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    },
    abort() {
      this.aborted = true;
      for (const fn of [...listeners]) fn();
    },
  };
}

const { api, ApiError } = await import("../ui/api.js");

test("docs 把 query/limit/offset 编码进查询串，空 query 不传", async () => {
  calls.length = 0;
  await api.docs("标准", { offset: 50, limit: 100, query: "继电 保护" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^\/kb\/api\/kbs\/%E6%A0%87%E5%87%86\/docs\?/);
  assert.equal(calls[0].options.method, "GET");
  const url = new URL(calls[0].url, "http://dsh.internal");
  assert.equal(url.searchParams.get("offset"), "50");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.get("query"), "继电 保护");

  calls.length = 0;
  await api.docs("标准", { offset: 0, limit: 50, query: "" });
  const empty = new URL(calls[0].url, "http://dsh.internal");
  assert.equal(empty.searchParams.get("offset"), "0");
  assert.equal(empty.searchParams.get("limit"), "50");
  assert.equal(empty.searchParams.has("query"), false);
});

test("批次与任务方法打到正确路径", async () => {
  calls.length = 0;
  await api.createBatch({ kb: "标准", create: true });
  assert.equal(calls[0].url, "/kb/api/upload-batches");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["x-kb-ui"], "1");

  await api.job("kb-import-1");
  assert.equal(calls[1].url, "/kb/api/jobs/kb-import-1");

  await api.jobs({ kb: "标准", kind: "kb-import", limit: 1 });
  assert.match(calls[2].url, /^\/kb\/api\/jobs\?/);
  assert.match(calls[2].url, /kb=%E6%A0%87%E5%87%86/);
});

test("uploadFile 用 PUT + 编码后的 path + 进度回调", async () => {
  const progress = [];
  const result = await api.uploadFile("b-0123456789ab", { file: new Blob(["abc"]), path: "资料/a.md" }, {
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(result, { path: "a.md", size: 3 });
  const xhr = globalThis.__lastXhr;
  assert.equal(xhr.method, "PUT");
  assert.match(xhr.url, /^\/kb\/api\/upload-batches\/b-0123456789ab\/files\?path=/);
  assert.match(xhr.url, /%E8%B5%84%E6%96%99%2Fa\.md/);
  assert.equal(xhr.headers["x-kb-ui"], "1");
  assert.deepEqual(progress, [0.5]);
});

test("批次详情/删除/导入/标准检查的方法与请求体", async () => {
  calls.length = 0;
  await api.batch("b-0123456789ab");
  await api.deleteBatch("b-0123456789ab");
  await api.importBatch("b-0123456789ab", { kb: "标准", create: true });
  await api.stdCheck("标准", { action: "check", force: true, limit: 1, dryRun: false });

  assert.equal(calls[0].url, "/kb/api/upload-batches/b-0123456789ab");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].url, "/kb/api/upload-batches/b-0123456789ab");
  assert.equal(calls[1].options.method, "DELETE");
  assert.equal(calls[1].options.headers["x-kb-ui"], "1");
  assert.equal(calls[2].url, "/kb/api/upload-batches/b-0123456789ab/import");
  assert.equal(calls[2].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[2].options.body), { kb: "标准", create: true });
  assert.equal(calls[3].url, "/kb/api/kbs/%E6%A0%87%E5%87%86/std-check");
  assert.equal(calls[3].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[3].options.body), { action: "check", force: true, limit: 1, dryRun: false });
});

test("预取消 signal 直接拒绝且不发送", async () => {
  const signal = fakeSignal();
  signal.aborted = true;
  await assert.rejects(
    () => api.uploadFile("b-0123456789ab", { file: new Blob(["abc"]), path: "a.md" }, { signal }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "ABORTED");
      assert.equal(error.status, 0);
      return true;
    },
  );
  assert.equal(globalThis.__lastXhr.sent, false);
  assert.equal(signal.listeners.length, 0);
});

test("传输中 abort 只结算一次并清掉监听", async () => {
  const signal = fakeSignal();
  const promise = api.uploadFile("b-0123456789ab", { file: new Blob(["abc"]), path: "资料/a.md" }, { signal });
  const xhr = globalThis.__lastXhr;
  const staleOnload = xhr.onload;
  assert.equal(xhr.sent, true);
  assert.equal(signal.listeners.length, 1);

  signal.abort();
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "ABORTED");
    return true;
  });
  assert.equal(xhr.aborted, true);
  assert.equal(signal.listeners.length, 0);
  assert.equal(xhr.onabort, null);
  assert.equal(xhr.onload, null);

  staleOnload();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(xhr.onload, null);
});

test("网络错误映射成 NETWORK_ERROR", async () => {
  const promise = api.uploadFile("b-0123456789ab", { file: new Blob(["abc"]), path: "a.md" });
  const xhr = globalThis.__lastXhr;
  xhr.onerror();
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "NETWORK_ERROR");
    assert.equal(error.status, 0);
    return true;
  });
  assert.equal(xhr.sent, true);
  assert.equal(xhr.onload, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(xhr.onload, null);
});

test("job/jobs 解包信封", async () => {
  payload = { job: { id: "j1", status: "running" } };
  assert.deepEqual(await api.job("j1"), { id: "j1", status: "running" });
  payload = { jobs: [{ id: "j1" }, { id: "j2" }] };
  assert.deepEqual(await api.jobs({ kb: "标准", kind: "kb-import" }), [{ id: "j1" }, { id: "j2" }]);
});

test("cancelJob 用 POST 打 /jobs/:id/cancel 并解包 job", async () => {
  calls.length = 0;
  payload = { job: { id: "kb-std-1", status: "running" } };
  const job = await api.cancelJob("kb-std-1");
  assert.deepEqual(job, { id: "kb-std-1", status: "running" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/kb/api/jobs/kb-std-1/cancel");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["x-kb-ui"], "1");
});

test("patchDocMetadata 用 PATCH 打 metadata 路径并带 x-kb-ui", async () => {
  calls.length = 0;
  await api.patchDocMetadata("标准", "d1", { summary: "人工摘要", tags: ["并网"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/d1/metadata");
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(calls[0].options.headers["x-kb-ui"], "1");
  assert.deepEqual(JSON.parse(calls[0].options.body), { summary: "人工摘要", tags: ["并网"] });
});

test("docs 把 tag 放进查询串，空 tag 不传", async () => {
  calls.length = 0;
  await api.docs("标准", { tag: "并网", offset: 0, limit: 50 });
  const url = new URL(calls[0].url, "http://dsh.internal");
  assert.equal(url.searchParams.get("tag"), "并网");
  calls.length = 0;
  await api.docs("标准", { tag: "", offset: 0, limit: 50 });
  const empty = new URL(calls[0].url, "http://dsh.internal");
  assert.equal(empty.searchParams.has("tag"), false);
});

test("文档删除/恢复/重试与跨库移动方法：POST + 编码路径 + JSON 体", async () => {
  calls.length = 0;
  await api.deleteDoc("标准", "d1");
  await api.deleteDoc("标准", "d1", { permanent: true, confirm: "电压偏差" });
  await api.restoreDoc("标准", "d1");
  await api.reparseDoc("标准", "d1");
  await api.movePreflight("标准", { ids: ["d1", "d2"], target: "目标" });
  await api.moveDocs("标准", { ids: ["d1"], target: "目标", onConflict: "rename" });
  await api.undoMove("标准", "d1", { target: "目标" });

  assert.equal(calls.length, 7);
  const encoded = "/kb/api/kbs/%E6%A0%87%E5%87%86/docs";
  assert.deepEqual(calls.map((call) => [call.url, call.options.method]), [
    [`${encoded}/d1/delete`, "POST"],
    [`${encoded}/d1/delete`, "POST"],
    [`${encoded}/d1/restore`, "POST"],
    [`${encoded}/d1/reparse`, "POST"],
    [`${encoded}/move/preflight`, "POST"],
    [`${encoded}/move`, "POST"],
    [`${encoded}/d1/undo-move`, "POST"],
  ]);
  for (const call of calls) {
    assert.equal(call.options.headers["content-type"], "application/json");
    assert.equal(call.options.headers["x-kb-ui"], "1");
  }
  assert.deepEqual(JSON.parse(calls[0].options.body), { permanent: false });
  assert.deepEqual(JSON.parse(calls[1].options.body), { permanent: true, confirm: "电压偏差" });
  assert.deepEqual(JSON.parse(calls[2].options.body), {});
  assert.deepEqual(JSON.parse(calls[3].options.body), {});
  assert.deepEqual(JSON.parse(calls[4].options.body), { ids: ["d1", "d2"], target: "目标" });
  assert.deepEqual(JSON.parse(calls[5].options.body), { ids: ["d1"], target: "目标", onConflict: "rename" });
  assert.deepEqual(JSON.parse(calls[6].options.body), { target: "目标" });
});

test("全局回收站搜索/排序：URL 编码、空 query 省略、sort 始终下发", async () => {
  calls.length = 0;
  await api.trashDocs();
  await api.trashDocs({ query: "继电 保护", sort: "title_asc" });
  await api.trashDocs({ query: "", sort: "kb_desc" });
  // 空 sort 回落到默认 deleted_desc；query 与 sort 都支持中文/空格编码。
  await api.trashDocs({ query: "台账", sort: "" });

  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    // 只读接口不带工作台写请求标记。
    assert.equal(call.options.headers["x-kb-ui"], undefined);
    assert.equal(call.options.body, undefined);
  }
  assert.equal(calls[0].url, "/kb/api/trash/docs?sort=deleted_desc");
  const searched = new URL(calls[1].url, "http://dsh.internal");
  assert.equal(searched.pathname, "/kb/api/trash/docs");
  assert.equal(searched.searchParams.get("query"), "继电 保护");
  assert.equal(searched.searchParams.get("sort"), "title_asc");
  assert.match(calls[1].url, /query=%E7%BB%A7%E7%94%B5\+%E4%BF%9D%E6%8A%A4/);

  assert.equal(calls[2].url, "/kb/api/trash/docs?sort=kb_desc");
  const defaulted = new URL(calls[3].url, "http://dsh.internal");
  assert.equal(defaulted.searchParams.get("query"), "台账");
  assert.equal(defaulted.searchParams.get("sort"), "deleted_desc");
});

test("跨库批量彻底删除与新库级彻底删除：URL、方法与请求体", async () => {
  calls.length = 0;
  await api.purgeTrashDocs([
    { kb: "标准", id: "d1" },
    { kb: "乙库", id: "d2", title: "忽略的额外字段" },
  ], "彻底删除 2 篇");
  await api.purgeDocs("标准", { ids: ["d1", "d2"], confirm: "标准" });
  await api.purgeDocs("标准", { all: true, confirm: "标准" });
  await api.purgeDocs("标准", { ids: ["d1"], all: true, confirm: "标准" });

  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, "/kb/api/trash/docs/purge");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["x-kb-ui"], "1");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  // 客户端只上传 kb/id，标题等展示字段不进入请求体。
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    items: [{ kb: "标准", id: "d1" }, { kb: "乙库", id: "d2" }],
    confirm: "彻底删除 2 篇",
  });

  const purgeUrl = "/kb/api/kbs/%E6%A0%87%E5%87%86/docs/purge";
  for (const call of calls.slice(1)) {
    assert.equal(call.url, purgeUrl);
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers["x-kb-ui"], "1");
    assert.equal(call.options.headers["content-type"], "application/json");
  }
  assert.deepEqual(JSON.parse(calls[1].options.body), { ids: ["d1", "d2"], confirm: "标准" });
  assert.deepEqual(JSON.parse(calls[2].options.body), { all: true, confirm: "标准" });
  // all=true 时即使同时给了 ids 也只发 all，避免服务端二选一校验被误触。
  assert.deepEqual(JSON.parse(calls[3].options.body), { all: true, confirm: "标准" });
});

test("错误响应映射成 ApiError", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 413,
    json: async () => ({ error: { code: "UPLOAD_TOO_LARGE", message: "太大" } }),
  });
  await assert.rejects(() => api.stdStatus("标准"), (error) => {
    assert.equal(error.code, "UPLOAD_TOO_LARGE");
    assert.equal(error.status, 413);
    return true;
  });
});

test("search 把条件编码进查询串，空值不传", async () => {
  // 上一个用例把 fetch 替换成了失败桩，这里恢复成记录调用的成功桩。
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  calls.length = 0;
  await api.search({ q: "电压偏差", kb: "标准", tag: "并网", type: "pdf-text", trust: "high", limit: 20, offset: 40 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.match(calls[0].url, /^\/kb\/api\/search\?/);
  const url = new URL(calls[0].url, "http://dsh.internal");
  assert.equal(url.searchParams.get("q"), "电压偏差");
  assert.equal(url.searchParams.get("kb"), "标准");
  assert.equal(url.searchParams.get("tag"), "并网");
  assert.equal(url.searchParams.get("type"), "pdf-text");
  assert.equal(url.searchParams.get("trust"), "high");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.equal(url.searchParams.get("offset"), "40");

  calls.length = 0;
  await api.search({ q: "电压", kb: "", tag: "", type: "", trust: "" });
  const empty = new URL(calls[0].url, "http://dsh.internal");
  for (const key of ["kb", "tag", "type", "trust"]) {
    assert.equal(empty.searchParams.has(key), false, key);
  }
});
