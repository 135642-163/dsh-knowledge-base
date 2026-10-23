/**
 * 工作台 API 客户端：JSON 方法映射、XHR 上传的 URL/请求头/进度/错误。
 */
import test from "node:test";
import assert from "node:assert/strict";

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  return { ok: true, status: 200, json: async () => ({ ok: true, jobId: "kb-import-1" }) };
};

class FakeXhr {
  constructor() {
    globalThis.__lastXhr = this;
    this.upload = {};
    this.headers = {};
    this.status = 200;
    this.response = { path: "a.md", size: 3 };
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  addEventListener() {}
  send(body) {
    this.body = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    setTimeout(() => this.onload?.(), 0);
  }
}
globalThis.XMLHttpRequest = FakeXhr;

const { api } = await import("../ui/api.js");

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
