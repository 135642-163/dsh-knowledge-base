/**
 * 预览基础设施：原件内联白名单、Office → PDF 转换缓存、笔记/文本内容接口。
 * 单元测试全部注入转换器，不依赖本机安装的 LibreOfficeKit。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { createKb } from "../lib/kbmeta.js";
import { readManifest, writeManifestAtomic } from "../lib/store.js";
import { handleApi } from "../lib/web/api.js";
import { contentTypeFor } from "../lib/web/http.js";
import {
  convertOfficeToPdf,
  getOrCreateOfficePreview,
  inlineTypeFor,
  isOffice,
  officePreviewCachePath,
  resetPreviewInFlight,
  resolveOfficeCli,
} from "../lib/web/preview.js";

const KB_NAME = "预览库";
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

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

function makeReq({ method = "GET", url = "/kb/api/status", headers = {} } = {}) {
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:55929",
      origin: "http://127.0.0.1:55929",
      "x-kb-ui": "1",
      ...headers,
    },
    async *[Symbol.asyncIterator]() {},
  };
}

async function waitForFinish(res) {
  if (res.writableFinished) return;
  await new Promise((resolvePromise, rejectPromise) => {
    if (res.writableFinished) {
      resolvePromise();
      return;
    }
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
  await handleApi(req, res, { opts, fence: () => true });
  await waitForFinish(res);
  const body = Buffer.concat(res.chunks);
  const type = String(res.headers["content-type"] ?? "");
  const json = type.includes("application/json") ? JSON.parse(body.toString("utf8")) : null;
  return { res, body, text: body.toString("utf8"), json };
}

/** 5xx 业务错误会写 stderr；测试期间静音，保持套件输出干净。 */
async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

function docRow(id, title, type) {
  return {
    id,
    title,
    type,
    status: "ready",
    pages: 1,
    chars: 10,
    parts: 1,
    summary: "",
    tags: [],
    trust: "high",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "kb-web-preview-"));
  const kbRoot = join(root, "kb");
  await createKb(kbRoot, { name: KB_NAME });
  const dir = join(kbRoot, KB_NAME);
  await mkdir(join(dir, "sources"), { recursive: true });

  const sources = {
    "pdfdoc.pdf": Buffer.from("%PDF-1.4\n%fake preview\n"),
    "txtdoc.txt": Buffer.from("第一条\n第二条\n", "utf8"),
    "svgtxt.svg": Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8"),
    "htmldoc.html": Buffer.from("<html><body>hi</body></html>", "utf8"),
    "docxdoc.docx": Buffer.from("PK\u0003\u0004fake docx", "utf8"),
    "bigtxt.txt": Buffer.alloc(MAX_CONTENT_BYTES + 16, 0x61),
  };
  for (const [name, content] of Object.entries(sources)) {
    await writeFile(join(dir, "sources", name), content);
  }

  await mkdir(join(dir, "markdown", "notedoc"), { recursive: true });
  await writeFile(join(dir, "markdown", "notedoc", "notedoc.md"), "# 笔记标题\n\n笔记正文。\n", "utf8");

  const manifest = await readManifest(dir);
  manifest.docs.push(
    docRow("pdfdoc", "PDF 语义", "pdf-text"),
    docRow("txtdoc", "纯文本", "text"),
    docRow("svgtxt", "SVG 原件", "image"),
    docRow("htmldoc", "HTML 原件", "html"),
    docRow("docxdoc", "Word 文档", "docx"),
    docRow("bigtxt", "大文本", "text"),
    docRow("notedoc", "编译笔记", "note"),
    docRow("lostnote", "丢失笔记", "note")
  );
  await writeManifestAtomic(dir, manifest);
  return { root, kbRoot, dir };
}

function apiUrl(suffix) {
  return `/kb/api/kbs/${encodeURIComponent(KB_NAME)}${suffix}`;
}

// ---------------------------------------------------------------------------
// 类型白名单 / CLI 解析 / 转换器（纯单元）
// ---------------------------------------------------------------------------

test("inlineTypeFor only allows PDF, bitmap images and plain text", () => {
  assert.equal(inlineTypeFor("a.pdf"), "application/pdf");
  assert.equal(inlineTypeFor("a.PDF"), "application/pdf");
  assert.equal(inlineTypeFor("a.png"), "image/png");
  assert.equal(inlineTypeFor("a.jpg"), "image/jpeg");
  assert.equal(inlineTypeFor("a.jpeg"), "image/jpeg");
  assert.equal(inlineTypeFor("a.webp"), "image/webp");
  assert.equal(inlineTypeFor("a.gif"), "image/gif");
  assert.equal(inlineTypeFor("a.txt"), "text/plain; charset=utf-8");
  assert.equal(inlineTypeFor("a.md"), "text/plain; charset=utf-8");
  assert.equal(inlineTypeFor("a.svg"), null);
  assert.equal(inlineTypeFor("a.html"), null);
  assert.equal(inlineTypeFor("a.docx"), null);
  assert.equal(inlineTypeFor(""), null);
});

test("isOffice recognises the converter input extensions", () => {
  for (const ext of [".doc", ".docx", ".odt", ".xls", ".xlsx", ".ods", ".ppt", ".pptx", ".odp"]) {
    assert.equal(isOffice(`file${ext}`), true, ext);
    assert.equal(isOffice(`file${ext.toUpperCase()}`), true, ext);
  }
  assert.equal(isOffice("file.pdf"), false);
  assert.equal(isOffice("file.txt"), false);
  assert.equal(isOffice(""), false);
});

test("contentTypeFor covers preview and download formats", () => {
  assert.equal(contentTypeFor("a.pdf"), "application/pdf");
  assert.equal(contentTypeFor("a.jpg"), "image/jpeg");
  assert.equal(contentTypeFor("a.jpeg"), "image/jpeg");
  assert.equal(contentTypeFor("a.webp"), "image/webp");
  assert.equal(contentTypeFor("a.gif"), "image/gif");
  assert.equal(contentTypeFor("a.txt"), "text/plain; charset=utf-8");
  assert.equal(contentTypeFor("a.md"), "text/plain; charset=utf-8");
  assert.equal(contentTypeFor("a.doc"), "application/msword");
  assert.match(contentTypeFor("a.docx"), /wordprocessingml\.document$/);
  assert.match(contentTypeFor("a.xlsx"), /spreadsheetml\.sheet$/);
  assert.match(contentTypeFor("a.pptx"), /presentationml\.presentation$/);
});

async function makeExecutable(path, content) {
  await writeFile(path, content, { mode: 0o755 });
  await chmod(path, 0o755);
}

test("resolveOfficeCli: explicit → env → bundled install → PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-preview-cli-"));
  const explicit = join(root, "explicit-cli.js");
  const envCli = join(root, "env-cli.js");
  const home = join(root, "home");
  const bundled = join(
    home,
    ".dsh/tools/libreoffice-kit/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js"
  );
  const bin = join(root, "bin");
  await mkdir(dirname(bundled), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(explicit, "// explicit\n", "utf8");
  await writeFile(envCli, "// env\n", "utf8");
  await writeFile(bundled, "// bundled\n", "utf8");
  await makeExecutable(join(bin, "dsoffice"), "#!/bin/sh\nexit 0\n");

  const env = { PATH: bin, DSH_OFFICE_KIT_CLI: envCli };
  assert.equal(resolveOfficeCli(explicit, { env, home }), resolve(explicit));
  assert.equal(resolveOfficeCli("", { env, home }), resolve(envCli));
  assert.equal(resolveOfficeCli("", { env: { PATH: bin }, home }), resolve(bundled));
  assert.equal(resolveOfficeCli("dsoffice", { env: { PATH: bin }, home: join(root, "empty") }), resolve(join(bin, "dsoffice")));

  const emptyHome = join(root, "empty-home");
  assert.equal(
    resolveOfficeCli("", { env: { PATH: bin }, home: emptyHome }),
    resolve(join(bin, "dsoffice"))
  );
  assert.equal(resolveOfficeCli("", { env: { PATH: "" }, home: emptyHome }), null);
  assert.equal(resolveOfficeCli(undefined, { env: {}, home: emptyHome }), null);
});

test("convertOfficeToPdf passes convert args and accepts a %PDF output (node CLI)", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-preview-convert-"));
  const log = join(root, "args.log");
  const cli = join(root, "fake-cli.js");
  await writeFile(
    cli,
    [
      'import { writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      `writeFileSync(${JSON.stringify(log)}, args.join("\\n") + "\\n");`,
      "let output = \"\";",
      'for (let index = 0; index < args.length; index += 1) {',
      '  if (args[index] === "--output") output = args[index + 1];',
      "}",
      'writeFileSync(output, "%PDF-1.7\\n");',
    ].join("\n"),
    "utf8"
  );
  const input = join(root, "in.docx");
  const output = join(root, "out.pdf");
  await writeFile(input, "fake office bytes", "utf8");

  const result = await convertOfficeToPdf({ cliPath: cli, input, output, timeoutMs: 10000 });
  assert.deepEqual(result, { output });
  assert.equal(await readFile(output, "utf8"), "%PDF-1.7\n");
  const args = (await readFile(log, "utf8")).trim().split("\n");
  assert.deepEqual(args, ["convert", "--input", input, "--output", output]);
});

test(
  "convertOfficeToPdf spawns an executable CLI directly (POSIX)",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "kb-preview-shell-"));
    const log = join(root, "args.log");
    const cli = join(root, "fake-convert");
    const quotedLog = log.replace(/'/g, "'\\''");
    await makeExecutable(
      cli,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > '${quotedLog}'`,
        'while [ $# -gt 0 ]; do',
        '  case "$1" in',
        '    --input) input="$2"; shift 2 ;;',
        '    --output) output="$2"; shift 2 ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        "printf '%%PDF-1.4\\n' > \"$output\"",
        "",
      ].join("\n")
    );
    const input = join(root, "in.xlsx");
    const output = join(root, "out.pdf");
    await writeFile(input, "fake office bytes", "utf8");
    await convertOfficeToPdf({ cliPath: cli, input, output });
    assert.match(await readFile(output, "latin1"), /^%PDF-/);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "convert",
      "--input",
      input,
      "--output",
      output,
    ]);
  }
);

test(
  "convertOfficeToPdf rejects non-PDF output with a path-free message (POSIX)",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "kb-preview-invalid-"));
    const cli = join(root, "fake-convert");
    await makeExecutable(
      cli,
      ["#!/bin/sh", 'output=""', 'while [ $# -gt 0 ]; do [ "$1" = "--output" ] && output="$2"; shift; done', 'printf "not a pdf" > "$output"', ""].join("\n")
    );
    const input = join(root, "in.docx");
    const output = join(root, "out.pdf");
    await writeFile(input, "x", "utf8");
    await assert.rejects(
      convertOfficeToPdf({ cliPath: cli, input, output }),
      (error) => {
        assert.equal(error.name, "PreviewError");
        assert.equal(error.code, "PREVIEW_OUTPUT_INVALID");
        assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      }
    );
  }
);

test(
  "convertOfficeToPdf enforces the timeout and kills the child (POSIX)",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "kb-preview-timeout-"));
    const cli = join(root, "fake-convert");
    await makeExecutable(cli, "#!/bin/sh\nsleep 5\n");
    const input = join(root, "in.docx");
    const output = join(root, "out.pdf");
    await writeFile(input, "x", "utf8");
    const started = Date.now();
    await assert.rejects(
      convertOfficeToPdf({ cliPath: cli, input, output, timeoutMs: 120 }),
      (error) => {
        assert.equal(error.code, "PREVIEW_TIMEOUT");
        return true;
      }
    );
    assert.ok(Date.now() - started < 3000, "timeout should not wait for the child");
  }
);

test("officePreviewCachePath encodes doc id, mtime and size", () => {
  assert.equal(
    officePreviewCachePath("/kb", "abc123", { mtimeMs: 1700000000123, size: 4096 }),
    join("/kb", ".preview", "abc123-1700000000123-4096.pdf")
  );
  const unsafe = officePreviewCachePath("/kb", "../../etc/passwd", { mtimeMs: 1, size: 2 });
  assert.equal(unsafe, join("/kb", ".preview", "______etc_passwd-1-2.pdf"));
  assert.equal(officePreviewCachePath("/kb", "", {}), join("/kb", ".preview", "doc-0-0.pdf"));
});

test("getOrCreateOfficePreview converts once, reuses cache and drops older files", async () => {
  resetPreviewInFlight();
  const root = await mkdtemp(join(tmpdir(), "kb-preview-cache-"));
  const kbDir = join(root, "kb");
  const previewDir = join(kbDir, ".preview");
  await mkdir(previewDir, { recursive: true });
  const source = join(root, "source.docx");
  await writeFile(source, "office source bytes", "utf8");
  const sourceStat = await stat(source);
  const expected = officePreviewCachePath(kbDir, "doc1", sourceStat);
  const older = join(previewDir, "doc1-1-1.pdf");
  await writeFile(older, "%PDF-1.4 old", "utf8");

  let calls = 0;
  const convert = async ({ output }) => {
    calls += 1;
    await writeFile(output, "%PDF-1.7\nconverted\n", "utf8");
  };
  const first = await getOrCreateOfficePreview({ kbDir, docId: "doc1", sourcePath: source, cliPath: "fake", convert });
  assert.equal(first, expected);
  assert.equal(calls, 1);
  assert.equal(await readFile(expected, "utf8"), "%PDF-1.7\nconverted\n");
  assert.equal(existsSync(older), false);
  assert.deepEqual((await readdir(previewDir)).filter((name) => name.startsWith(".tmp-")), []);

  const second = await getOrCreateOfficePreview({ kbDir, docId: "doc1", sourcePath: source, cliPath: "fake", convert });
  assert.equal(second, expected);
  assert.equal(calls, 1);
});

test("getOrCreateOfficePreview removes its temp file when conversion fails", async () => {
  resetPreviewInFlight();
  const root = await mkdtemp(join(tmpdir(), "kb-preview-fail-"));
  const kbDir = join(root, "kb");
  const source = join(root, "source.docx");
  await writeFile(source, "office source bytes", "utf8");
  await assert.rejects(
    getOrCreateOfficePreview({
      kbDir,
      docId: "doc2",
      sourcePath: source,
      cliPath: "fake",
      convert: async ({ input }) => {
        throw new Error(`convert failed for ${input}`);
      },
    }),
    /convert failed/
  );
  assert.deepEqual((await readdir(join(kbDir, ".preview"))).filter((name) => name.startsWith(".tmp-")), []);
});

test("concurrent preview requests share one in-flight conversion", async () => {
  resetPreviewInFlight();
  const root = await mkdtemp(join(tmpdir(), "kb-preview-inflight-"));
  const kbDir = join(root, "kb");
  const source = join(root, "source.docx");
  await writeFile(source, "office source bytes", "utf8");
  let calls = 0;
  let release;
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const convert = async ({ output }) => {
    calls += 1;
    await gate;
    await writeFile(output, "%PDF-1.4\nshared\n", "utf8");
  };
  const args = { kbDir, docId: "doc3", sourcePath: source, cliPath: "fake", convert };
  const first = getOrCreateOfficePreview(args);
  const second = getOrCreateOfficePreview(args);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// API：原件内联 / 拒绝不安全类型
// ---------------------------------------------------------------------------

test("GET source?inline=1 serves PDFs inline with strict headers", async () => {
  const { kbRoot } = await setup();
  const { res, body } = await call(
    { kbRoot },
    makeReq({ url: apiUrl("/docs/pdfdoc/source?inline=1") })
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/pdf");
  assert.match(res.headers["content-disposition"], /^inline; filename\*=UTF-8''/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(res.headers["cache-control"], /no-store/);
  assert.match(body.toString("latin1"), /^%PDF-/);
});

test("GET source?inline=1 serves txt/md as UTF-8 plain text", async () => {
  const { kbRoot } = await setup();
  const { res, body } = await call(
    { kbRoot },
    makeReq({ url: apiUrl("/docs/txtdoc/source?inline=1") })
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
  assert.match(res.headers["content-disposition"], /^inline;/);
  assert.match(body.toString("utf8"), /第一条\n第二条/);
});

test("GET source?inline=1 rejects SVG and HTML with 415", async () => {
  const { kbRoot } = await setup();
  for (const [id, marker] of [
    ["svgtxt", /<script>/],
    ["htmldoc", /<body>/],
  ]) {
    const { res, text, json } = await call(
      { kbRoot },
      makeReq({ url: apiUrl(`/docs/${id}/source?inline=1`) })
    );
    assert.equal(res.status, 415, id);
    assert.equal(json.error.code, "SOURCE_NOT_PREVIEWABLE", id);
    assert.match(json.error.message, /不支持内联预览/);
    assert.doesNotMatch(text, marker, id);
  }
});

test("GET source without inline still downloads the original bytes", async () => {
  const { kbRoot } = await setup();
  const { res, text } = await call(
    { kbRoot },
    makeReq({ url: apiUrl("/docs/svgtxt/source") })
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "image/svg+xml");
  assert.match(res.headers["content-disposition"], /^attachment;/);
  assert.match(text, /<svg/);
});

test("GET source returns SOURCE_NOT_FOUND for unknown docs and rejects traversal", async () => {
  const { kbRoot, dir } = await setup();
  const sentinel = join(kbRoot, "sentinel.txt");
  await writeFile(sentinel, "outside-sources", "utf8");

  const missing = await call({ kbRoot }, makeReq({ url: apiUrl("/docs/nope/source?inline=1") }));
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error.code, "SOURCE_NOT_FOUND");

  for (const suffix of ["/docs/../source?inline=1", "/docs/%2e%2e/source?inline=1"]) {
    const { res, json, text } = await call(
      { kbRoot },
      makeReq({ url: `/kb/api/kbs/${encodeURIComponent(KB_NAME)}${suffix}` })
    );
    assert.equal(res.status, 404, suffix);
    assert.match(json.error.code, /^(SOURCE_NOT_FOUND|NOT_FOUND)$/, suffix);
    assert.doesNotMatch(text, /outside-sources/, suffix);
  }
  // 穿越未读到 sources 之外的文件
  assert.equal(await readFile(join(dir, "sources", "txtdoc.txt"), "utf8"), "第一条\n第二条\n");
});

// ---------------------------------------------------------------------------
// API：Office preview.pdf
// ---------------------------------------------------------------------------

function injectedConverter(contents = "%PDF-1.7\nrendered\n") {
  const calls = [];
  return {
    calls,
    convert: async ({ cliPath, input, output }) => {
      calls.push({ cliPath, input, output });
      await writeFile(output, contents, "utf8");
    },
  };
}

test("GET preview.pdf converts once, serves inline PDF and reuses the cache", async () => {
  resetPreviewInFlight();
  const { kbRoot, dir } = await setup();
  const engine = injectedConverter();
  const opts = {
    kbRoot,
    officeKitCli: "/should/not/be/used/cli.js",
    previewEngine: { cliPath: "/injected/cli.js", convert: engine.convert },
  };

  const first = await call(opts, makeReq({ url: apiUrl("/docs/docxdoc/preview.pdf") }));
  assert.equal(first.res.status, 200);
  assert.equal(first.res.headers["content-type"], "application/pdf");
  assert.match(first.res.headers["content-disposition"], /^inline; filename\*=UTF-8''/);
  assert.match(first.res.headers["cache-control"], /no-store/);
  assert.equal(first.res.headers["x-content-type-options"], "nosniff");
  assert.equal(first.body.toString("utf8"), "%PDF-1.7\nrendered\n");
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].input, join(dir, "sources", "docxdoc.docx"));

  const cached = (await readdir(join(dir, ".preview"))).filter((name) => name.endsWith(".pdf"));
  assert.equal(cached.length, 1);
  assert.match(cached[0], /^docxdoc-[\d.]+-\d+\.pdf$/);

  const second = await call(opts, makeReq({ url: apiUrl("/docs/docxdoc/preview.pdf") }));
  assert.equal(second.res.status, 200);
  assert.equal(second.body.toString("utf8"), first.body.toString("utf8"));
  assert.equal(engine.calls.length, 1, "second request must hit the cache");
});

test("GET preview.pdf serves native PDF sources inline without Office conversion", async () => {
  const { kbRoot } = await setup();
  const engine = injectedConverter();
  const { res } = await call(
    { kbRoot, previewEngine: { cliPath: "/injected/cli.js", convert: engine.convert } },
    makeReq({ url: apiUrl("/docs/pdfdoc/preview.pdf") })
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/pdf");
  assert.match(res.headers["content-disposition"], /^inline; /);
  assert.equal(engine.calls.length, 0);
});

test("GET preview.pdf returns 501 when no engine is available", async () => {
  const { kbRoot } = await setup();
  const engine = injectedConverter();
  const { res, json } = await quietly(() => call(
    { kbRoot, previewEngine: { cliPath: null, convert: engine.convert } },
    makeReq({ url: apiUrl("/docs/docxdoc/preview.pdf") })
  ));
  assert.equal(res.status, 501);
  assert.equal(json.error.code, "PREVIEW_ENGINE_MISSING");
  assert.match(json.error.message, /未安装 Office 转换引擎/);
  assert.equal(engine.calls.length, 0);
});

test("GET preview.pdf maps converter failures to a generic 500 without paths", async () => {
  resetPreviewInFlight();
  const { kbRoot } = await setup();
  const { res, text, json } = await quietly(() => call(
    {
      kbRoot,
      previewEngine: {
        cliPath: "/injected/cli.js",
        convert: async ({ input }) => {
          throw new Error(`conversion exploded at ${input}`);
        },
      },
    },
    makeReq({ url: apiUrl("/docs/docxdoc/preview.pdf") })
  ));
  assert.equal(res.status, 500);
  assert.equal(json.error.code, "PREVIEW_FAILED");
  assert.equal(json.error.message, "原件预览转换失败");
  assert.doesNotMatch(text, new RegExp(kbRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text, /conversion exploded/);
});

// ---------------------------------------------------------------------------
// API：笔记 / 文本内容
// ---------------------------------------------------------------------------

test("GET content returns the merged markdown for notes", async () => {
  const { kbRoot } = await setup();
  const { res, json } = await call({ kbRoot }, makeReq({ url: apiUrl("/docs/notedoc/content") }));
  assert.equal(res.status, 200);
  assert.equal(json.title, "编译笔记");
  assert.match(json.markdown, /^# 笔记标题/);
  assert.match(json.markdown, /笔记正文/);
  assert.equal(json.truncated, undefined);
});

test("GET content returns source text for txt/md docs", async () => {
  const { kbRoot } = await setup();
  const { res, json } = await call({ kbRoot }, makeReq({ url: apiUrl("/docs/txtdoc/content") }));
  assert.equal(res.status, 200);
  assert.equal(json.markdown, "第一条\n第二条\n");
});

test("GET content returns 404 when the note markdown is missing", async () => {
  const { kbRoot } = await setup();
  const { res, json } = await call({ kbRoot }, makeReq({ url: apiUrl("/docs/lostnote/content") }));
  assert.equal(res.status, 404);
  assert.equal(json.error.code, "SOURCE_NOT_FOUND");
});

test("GET content returns 415 for binary sources", async () => {
  const { kbRoot } = await setup();
  const { res, json } = await call({ kbRoot }, makeReq({ url: apiUrl("/docs/pdfdoc/content") }));
  assert.equal(res.status, 415);
  assert.equal(json.error.code, "SOURCE_NOT_PREVIEWABLE");
});

test("GET content truncates text over 2 MB and flags it", async () => {
  const { kbRoot } = await setup();
  const { res, json } = await call({ kbRoot }, makeReq({ url: apiUrl("/docs/bigtxt/content") }));
  assert.equal(res.status, 200);
  assert.equal(json.truncated, true);
  assert.equal(Buffer.byteLength(json.markdown, "utf8"), MAX_CONTENT_BYTES);
});

test("GET content returns 404 for an unknown document", async () => {
  const { kbRoot } = await setup();
  const { res, json } = await call({ kbRoot }, makeReq({ url: apiUrl("/docs/missing/content") }));
  assert.equal(res.status, 404);
  assert.equal(json.error.code, "DOC_NOT_FOUND");
});
