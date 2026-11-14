/**
 * 链接入库：类型推断、内网拒绝、网页转 Markdown、二进制下载与清理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRemoteSource,
  inferExtension,
  isPrivateAddress,
} from "../lib/url-source.js";

const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

test("inferExtension uses content type, disposition, then URL", () => {
  assert.equal(inferExtension({ url: "https://x/a" , contentType: "application/pdf" }), ".pdf");
  assert.equal(
    inferExtension({
      url: "https://x/download",
      contentType: "application/octet-stream",
      disposition: 'attachment; filename="GB-T 19963.2-2024.pdf"',
    }),
    ".pdf"
  );
  assert.equal(inferExtension({ url: "https://x/a.docx", contentType: "application/octet-stream" }), ".docx");
  assert.equal(inferExtension({ url: "https://x/a", contentType: "text/html" }), "");
});

test("isPrivateAddress covers loopback/private ranges", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.0.1", "::1", "fd00::1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["93.184.216.34", "8.8.8.8", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("HTML link becomes a Markdown file with page title", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-url-"));
  try {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      assert.match(String(url), /\/v1\/tools\/fetch$/);
      return new Response(
        JSON.stringify({ title: "某标准全文", content: "正文第一段。" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const acquired = await acquireRemoteSource("https://example.com/gb-1", {
      kbRoot: root,
      apiKey: "sk-test",
      fetchImpl,
      lookup: PUBLIC_LOOKUP,
    });
    assert.equal(acquired.kind, "web");
    assert.equal(acquired.title, "某标准全文");
    assert.match(acquired.path, /\.md$/);
    const text = await readFile(acquired.path, "utf8");
    assert.match(text, /^# 某标准全文/);
    assert.match(text, /正文第一段/);
    await acquired.cleanup();
    await assert.rejects(() => stat(acquired.path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PDF link is downloaded with extension and size", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-url-pdf-"));
  try {
    const fetchImpl = async (url, init) => {
      if (init?.method === "HEAD") {
        return new Response("", {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": "9" },
        });
      }
      return new Response(Buffer.from("%PDF-1.4\n"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    };
    const acquired = await acquireRemoteSource("https://example.com/standard.pdf", {
      kbRoot: root,
      apiKey: "sk-test",
      fetchImpl,
      lookup: PUBLIC_LOOKUP,
    });
    assert.equal(acquired.kind, "file");
    assert.match(acquired.path, /standard\.pdf$/);
    assert.equal(acquired.size, 9);
    await acquired.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private URLs are rejected by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-url-private-"));
  try {
    await assert.rejects(
      () => acquireRemoteSource("http://127.0.0.1:8080/a.pdf", { kbRoot: root }),
      /不允许访问内网地址/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("从网页正文中找 PDF 链接（绝对/相对）", async () => {
  const { findPdfLink } = await import("../lib/url-source.js");
  assert.equal(
    findPdfLink("[下载 PDF](/files/a.pdf)", "https://example.com/page"),
    "https://example.com/files/a.pdf"
  );
  assert.equal(
    findPdfLink('<a href="/x/y.pdf?x=1">下载</a>', "https://example.com/a/b"),
    "https://example.com/x/y.pdf?x=1"
  );
  assert.equal(findPdfLink("没有链接", "https://example.com"), "");
});

test("preferPdf 时优先下载网页里的 PDF 链接", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-url-prefer-pdf-"));
  try {
    const fetchImpl = async (url, init) => {
      const target = String(url);
      if (init?.method === "HEAD") {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      if (target.endsWith("/v1/tools/fetch")) {
        return new Response(JSON.stringify({
          title: "关于印发《电能质量管理办法》的通知",
          content: "[下载 PDF](/files/rule.pdf)\n\n正文摘要",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.endsWith("/files/rule.pdf")) {
        return new Response(Buffer.from("%PDF-1.7\n"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      throw new Error(`unexpected ${target}`);
    };
    const acquired = await acquireRemoteSource("https://example.com/notice", {
      kbRoot: root,
      apiKey: "sk-test",
      fetchImpl,
      lookup: PUBLIC_LOOKUP,
      preferPdf: true,
    });
    assert.equal(acquired.kind, "file");
    assert.match(acquired.path, /\.pdf$/);
    assert.equal(acquired.contentType, "application/pdf");
    await acquired.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
