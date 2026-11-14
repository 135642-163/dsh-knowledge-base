/**
 * DeepSeek 工具 API 客户端：标记清理、请求体、错误分类、密钥解析。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  deepseekFetchPage,
  deepseekOcrImage,
  deepseekSearch,
  resolveDeepSeekApiKey,
  retryableStatus,
  stripOcrMarkup,
} from "../lib/deepseek-api.js";

test("stripOcrMarkup removes ref/box markers and keeps text", () => {
  const raw = "<｜ref｜>第一章<｜/ref｜><｜box｜>[[52, 40, 948, 96]]<｜/box｜>\n正文内容";
  assert.equal(stripOcrMarkup(raw), "第一章\n正文内容");
  assert.equal(stripOcrMarkup("<|ref|>A<|/ref|><|box|>[[1,2,3,4]]<|/box|>B"), "AB");
});

test("deepseekOcrImage parses pages and truncation", async () => {
  const fetchImpl = async (url, init) => {
    assert.match(String(url), /\/v1\/tools\/ocr$/);
    assert.equal(init.headers.authorization, "Bearer sk-test");
    return new Response(
      JSON.stringify({
        page_count: 1,
        pages: [{ index: 0, text: "<｜ref｜>标题<｜/ref｜>\n正文", finish_reason: "length" }],
      }),
      { status: 200 }
    );
  };
  const result = await deepseekOcrImage({
    png: Buffer.from("png"),
    apiKey: "sk-test",
    fetchImpl,
  });
  assert.equal(result.text, "标题\n正文");
  assert.equal(result.pageCount, 1);
  assert.equal(result.truncated, true);
});

test("deepseekSearch sends expected body and returns results", async () => {
  const fetchImpl = async (url, init) => {
    assert.match(String(url), /\/v1\/tools\/search$/);
    const body = JSON.parse(init.body);
    assert.equal(body.query, "GB/T 19963.2");
    assert.equal(body.count, 5);
    return new Response(
      JSON.stringify({ results: [{ title: "标准", url: "https://example.com/a", rerank_score: 2.1 }] }),
      { status: 200 }
    );
  };
  const results = await deepseekSearch({ query: "GB/T 19963.2", count: 5, apiKey: "k", fetchImpl });
  assert.equal(results.length, 1);
  assert.equal(results[0].rerank_score, 2.1);
});

test("search error carries status and retryable flag", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: "busy", code: "server_busy" } }), { status: 503 });
  await assert.rejects(
    () => deepseekSearch({ query: "x", apiKey: "k", fetchImpl }),
    (error) => error.status === 503 && error.retryable === true && /busy/.test(error.message)
  );
  assert.equal(retryableStatus(401), false);
  assert.equal(retryableStatus(429), true);
});

test("deepseekFetchPage returns markdown and title", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ title: "示例", content: "# 示例\n\n正文" }), { status: 200 });
  const page = await deepseekFetchPage({ url: "https://example.com/a", apiKey: "k", fetchImpl });
  assert.equal(page.title, "示例");
  assert.match(page.content, /正文/);
});

test("resolveDeepSeekApiKey prefers host credentials, then env", async () => {
  const ctx = {
    get(name) {
      assert.equal(name, "credentials");
      return { resolve: async () => ({ value: "sk-host", source: "stored" }) };
    },
  };
  assert.deepEqual(await resolveDeepSeekApiKey({ ctx, env: { DEEPSEEK_API_KEY: "sk-env" } }), {
    value: "sk-host",
    source: "credentials",
  });
  const noStore = { get: () => null };
  assert.deepEqual(await resolveDeepSeekApiKey({ ctx: noStore, env: { DEEPSEEK_API_KEY: "sk-env" } }), {
    value: "sk-env",
    source: "env",
  });
  assert.equal(await resolveDeepSeekApiKey({ ctx: noStore, env: {} }), null);
});

test("missing api key fails before network", async () => {
  await assert.rejects(() => deepseekSearch({ query: "x" }), /缺少 DeepSeek API Key/);
});
