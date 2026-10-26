/**
 * viewer.html / page.png 路由：参数夹取、旋转、页图缓存、扫描件降级、格式拒绝。
 * 用真实最小 PDF（文字页/空白页）跑 mupdf，不依赖本机知识库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createKb } from "../lib/kbmeta.js";
import { readManifest, writeManifestAtomic } from "../lib/store.js";
import { handleApi } from "../lib/web/api.js";
import { configurePageCache, resetPageCache } from "../lib/web/pdf-pages.js";

const KB_NAME = "预览库";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function buildPdf(pageStreams) {
  const total = pageStreams.length;
  const kids = pageStreams.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  const fontId = 3 + total * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`,
  ];
  for (const stream of pageStreams) {
    const contentId = objects.length + 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "binary");
}

const textPage = (value) => `BT /F1 14 Tf 20 100 Td (${value}) Tj ET\n`;
const blankPage = "0 0 1 rg 10 10 100 100 re f\n";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(PNG_SIGNATURE), "不是 PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function makeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.status = 0;
  res.headers = {};
  res.chunks = chunks;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers ?? {};
  };
  return res;
}

function makeReq(url) {
  return {
    method: "GET",
    url,
    headers: { host: "127.0.0.1:55929", origin: "http://127.0.0.1:55929", "x-kb-ui": "1" },
    async *[Symbol.asyncIterator]() {},
  };
}

async function waitForFinish(res) {
  if (res.writableFinished) return;
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("response did not finish")), 10000);
    res.once("finish", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    res.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

async function call(opts, req) {
  const res = makeRes();
  const original = console.error;
  console.error = () => {};
  try {
    await handleApi(req, res, { opts, fence: () => true });
  } finally {
    console.error = original;
  }
  await waitForFinish(res);
  const body = Buffer.concat(res.chunks);
  const type = String(res.headers["content-type"] ?? "");
  return { res, body, text: body.toString("utf8"), json: type.includes("application/json") ? JSON.parse(body.toString("utf8")) : null };
}

function docRow(id, title, pages) {
  return {
    id, title, type: "pdf-text", status: "ready", pages, chars: 10, parts: 1,
    summary: "", tags: [], trust: "high", updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-web-viewer-"));
  const kbRoot = join(root, "kb");
  const cacheDir = join(root, "cache");
  await createKb(kbRoot, { name: KB_NAME });
  const dir = join(kbRoot, KB_NAME);
  await mkdir(join(dir, "sources"), { recursive: true });
  await writeFile(join(dir, "sources", "textpdf.pdf"), buildPdf([textPage("VOLTAGE 7 PERCENT"), textPage("HARMONIC CURRENT")]));
  await writeFile(join(dir, "sources", "scanpdf.pdf"), buildPdf([blankPage]));
  await writeFile(join(dir, "sources", "plain.txt"), "不是 PDF\n", "utf8");
  const manifest = await readManifest(dir);
  manifest.docs.push(docRow("textpdf", "文字 PDF", 2), docRow("scanpdf", "扫描 PDF", 1), { ...docRow("plain", "纯文本", 1), type: "text" });
  await writeManifestAtomic(dir, manifest);
  configurePageCache({ dir: cacheDir });
  resetPageCache();
  return {
    root, kbRoot, dir, cacheDir,
    cleanup: async () => {
      resetPageCache();
      configurePageCache({ dir: "" });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(root, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((done) => setTimeout(done, 50));
        }
      }
    },
  };
}

const url = (id, suffix = "") => `/kb/api/kbs/${encodeURIComponent(KB_NAME)}/docs/${id}${suffix}`;

// ---------------------------------------------------------------------------
// viewer.html
// ---------------------------------------------------------------------------

test("viewer.html 返回自包含 HTML（CSP、逐页图、工具栏）", async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const { res, text } = await call({ kbRoot: env.kbRoot }, makeReq(url("textpdf", "/viewer.html")));
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
  assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
  assert.match(text, /<figure class="page" id="p1">/);
  assert.match(text, /page\.png\?page=1&amp;dpi=144&amp;rotate=0/);
  assert.match(text, /value="1"/, "没有命中时应从第 1 页开始");
  assert.doesNotMatch(text, /id="notice"/);
});

test("viewer.html 夹取页码、按 q 高亮、按 rotate 旋转页图", async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const { res, text } = await call(
    { kbRoot: env.kbRoot },
    makeReq(url("textpdf", "/viewer.html?page=99&q=VOLTAGE%7CVOLTAGE&rotate=90")),
  );
  assert.equal(res.status, 200);
  assert.match(text, /<input id="pageno" value="2"/, "越界页码应夹到末页");
  assert.match(text, /<span class="hl"/, "应渲染高亮框");
  assert.match(text, /高亮 \d+ 处/);
  assert.match(text, /page\.png\?page=1&amp;dpi=144&amp;rotate=90/);
  assert.match(text, /id="rotate"/);
});

test("没有 page 参数时 viewer 自动落到命中最多的页", async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const { text } = await call({ kbRoot: env.kbRoot }, makeReq(url("textpdf", "/viewer.html?q=HARMONIC")));
  assert.match(text, /<input id="pageno" value="2"/);
});

test("扫描件：无文字层提示，不渲染高亮", async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const { text } = await call({ kbRoot: env.kbRoot }, makeReq(url("scanpdf", "/viewer.html?q=%E7%94%B5%E5%8E%8B")));
  assert.match(text, /id="notice"/);
  assert.match(text, /没有文字层/);
  assert.doesNotMatch(text, /<span class="hl"/);
});

test("非 PDF 源拒绝逐页预览（415）", async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const { res, json } = await call({ kbRoot: env.kbRoot }, makeReq(url("plain", "/viewer.html")));
  assert.equal(res.status, 415);
  assert.equal(json.error.code, "PREVIEW_UNSUPPORTED");
});

// ---------------------------------------------------------------------------
// page.png 与缓存
// ---------------------------------------------------------------------------

test("page.png 返回 PNG 并命中内存缓存", async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const first = await call({ kbRoot: env.kbRoot }, makeReq(url("textpdf", "/page.png?page=1")));
  assert.equal(first.res.status, 200);
  assert.equal(first.res.headers["content-type"], "image/png");
  assert.equal(first.res.headers["x-cache"], "miss");
  assert.equal(first.res.headers["x-total-pages"], "2");
  const size = pngSize(first.body);
  assert.ok(size.width > 0 && size.height > 0);
  const second = await call({ kbRoot: env.kbRoot }, makeReq(url("textpdf", "/page.png?page=1")));
  assert.equal(second.res.headers["x-cache"], "hit");
  assert.ok(second.body.equals(first.body), "缓存命中应返回同一份字节");
});

test("page.png 清空内存后命中临时目录磁盘缓存", async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  await call({ kbRoot: env.kbRoot }, makeReq(url("textpdf", "/page.png?page=2")));
  resetPageCache();
  const again = await call({ kbRoot: env.kbRoot }, makeReq(url("textpdf", "/page.png?page=2")));
  assert.equal(again.res.status, 200);
  assert.equal(again.res.headers["x-cache"], "hit");
});

test("page.png 旋转 90° 后宽高互换", async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const normal = pngSize((await call({ kbRoot: env.kbRoot }, makeReq(url("textpdf", "/page.png?page=1&dpi=72")))).body);
  const rotated = pngSize((await call({ kbRoot: env.kbRoot }, makeReq(url("textpdf", "/page.png?page=1&dpi=72&rotate=90")))).body);
  assert.equal(rotated.width, normal.height);
  assert.equal(rotated.height, normal.width);
});

test("page.png 越界页码夹到末页", async (t) => {
  const env = await setup();
  t.after(env.cleanup);
  const last = (await call({ kbRoot: env.kbRoot }, makeReq(url("textpdf", "/page.png?page=2&dpi=72")))).body;
  const clamped = (await call({ kbRoot: env.kbRoot }, makeReq(url("textpdf", "/page.png?page=999&dpi=72")))).body;
  assert.ok(clamped.equals(last), "越界页码应渲染末页");
});
