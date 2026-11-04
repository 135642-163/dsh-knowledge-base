/**
 * 导出包下载：进度计算、流式读取与「大文件写盘 / 退回浏览器下载」分支。
 * 不依赖真实网络与 DOM（fetch/document/文件选择器全部注入）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOB_DOWNLOAD_LIMIT,
  downloadExportFile,
  formatBytes,
  progressPercent,
  progressText,
  readBodyWithProgress,
} from "../ui/download-progress.js";

function fakeResponse(chunks, { contentLength } = {}) {
  let index = 0;
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-length"
          ? String(contentLength ?? total)
          : null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
        };
      },
    },
    async arrayBuffer() {
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out.buffer;
    },
  };
}

function fakeDocument() {
  const clicked = [];
  const doc = {
    body: { appendChild() {} },
    createElement() {
      const link = {
        href: "",
        download: "",
        rel: "",
        click() {
          clicked.push({ href: link.href, download: link.download });
        },
        remove() {},
      };
      return link;
    },
  };
  return { doc, clicked };
}

test("formatBytes / progressPercent / progressText 口径稳定", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB");
  assert.equal(progressPercent(0, 100), 0);
  assert.equal(progressPercent(50, 100), 50);
  assert.equal(progressPercent(200, 100), 100);
  assert.equal(progressPercent(10, 0), null);
  assert.equal(progressText(50, 100), "50% · 50 B / 100 B");
  assert.equal(progressText(512, 0), "512 B 已下载");
});

test("readBodyWithProgress 逐块回调并拼出完整内容", async () => {
  const seen = [];
  const bytes = await readBodyWithProgress(
    fakeResponse([new TextEncoder().encode("abc"), new TextEncoder().encode("def")]),
    ({ loaded, total }) => seen.push([loaded, total])
  );
  assert.equal(Buffer.from(bytes).toString("utf8"), "abcdef");
  assert.deepEqual(seen, [[3, 6], [6, 6]]);
});

test("小文件走 fetch + Blob 下载并报告进度", async () => {
  const { doc, clicked } = fakeDocument();
  const progress = [];
  const outcome = await downloadExportFile({
    url: "/kb/api/export.zip",
    fileName: "库.zip",
    totalBytes: 6,
    fetchImpl: async () => fakeResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]),
    documentImpl: doc,
    urlImpl: {
      createObjectURL: () => "blob:fake",
      revokeObjectURL: () => {},
    },
    onProgress: ({ loaded, total }) => progress.push([loaded, total]),
  });
  assert.equal(outcome.mode, "blob");
  assert.equal(outcome.bytes, 6);
  assert.equal(clicked.length, 1);
  assert.equal(clicked[0].download, "库.zip");
  assert.equal(progress.at(-1)[0], 6);
});

test("大文件且支持文件选择器时流式写盘，不整包进内存", async () => {
  const writes = [];
  let closed = false;
  const outcome = await downloadExportFile({
    url: "/kb/api/big.zip",
    fileName: "big.zip",
    totalBytes: BLOB_DOWNLOAD_LIMIT + 1,
    fetchImpl: async () => fakeResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
    windowImpl: {
      showSaveFilePicker: async () => ({
        async createWritable() {
          return {
            async write(chunk) { writes.push(Buffer.from(chunk).toString("hex")); },
            async close() { closed = true; },
            async abort() {},
          };
        },
      }),
    },
  });
  assert.equal(outcome.mode, "file");
  assert.equal(outcome.bytes, 4);
  assert.equal(closed, true);
  assert.deepEqual(writes, ["0102", "0304"]);
});

test("大文件不支持文件选择器时退回浏览器原生下载", async () => {
  const { doc, clicked } = fakeDocument();
  const outcome = await downloadExportFile({
    url: "/kb/api/big.zip",
    fileName: "big.zip",
    totalBytes: BLOB_DOWNLOAD_LIMIT + 1,
    fetchImpl: async () => {
      throw new Error("不应发起 fetch");
    },
    windowImpl: {},
    documentImpl: doc,
  });
  assert.equal(outcome.mode, "browser");
  assert.equal(clicked.length, 1);
  assert.equal(clicked[0].download, "big.zip");
});
