/**
 * 检索工作台：API（文档级结果/标准号区分）、UI（高亮/过滤/清除/示例词）与深链预览。
 * 夹具见 seed.mjs 的「检索库」：GB/T 1234-2020 与 GB 1234-2020 同号不同前缀。
 */
import assert from "node:assert/strict";
import { poll } from "../ui.mjs";
import { FIXTURES } from "../seed.mjs";

export const name = "检索：标准号区分、关键词高亮、过滤与深链预览";

function searchUrl(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  return `/search?${query.toString()}`;
}

export async function run(ctx) {
  const kb = FIXTURES.kbs.search;
  const docA = FIXTURES.docs.searchA;
  const docB = FIXTURES.docs.searchB;
  const docC = FIXTURES.docs.searchC;

  // 1) API：正文命中 + 文档级去重 + 深链字段
  const api = await ctx.api.request("GET", searchUrl({ q: "电压偏差" }));
  assert.equal(api.q, "电压偏差");
  assert.ok(["fts", "rg", "mixed"].includes(api.engine), api.engine);
  const ids = api.results.map((item) => item.docId);
  assert.equal(new Set(ids).size, ids.length, "同一文档只能出现一次");
  assert.ok(ids.includes(docA.id), `缺少 GB/T 夹具：${ids.join(",")}`);
  assert.ok(ids.includes(docB.id), `缺少 GB 夹具：${ids.join(",")}`);
  assert.ok(!ids.includes(docC.id), "无关资料不应命中电压偏差");
  const hitA = api.results.find((item) => item.docId === docA.id);
  assert.equal(hitA.standardNo, "GB/T 1234-2020");
  assert.equal(hitA.trust, "high");
  assert.ok(Number.isInteger(hitA.page) && hitA.page >= 1, String(hitA.page));
  assert.ok(String(hitA.clause).startsWith("4."), hitA.clause);
  assert.ok(String(hitA.snippet).includes("电压偏差"), hitA.snippet);
  assert.equal(hitA.deepLink, `/kb/?kb=${encodeURIComponent(kb)}&doc=${docA.id}&page=${hitA.page}&clause=${hitA.clause}`);
  assert.ok(Array.isArray(api.terms) && api.terms.length > 0, "应返回高亮词");

  // 2) 标准号：GB/T 与 GB 不互相命中
  const gbt = await ctx.api.request("GET", searchUrl({ q: "GB/T 1234" }));
  assert.deepEqual(gbt.results.map((item) => item.docId), [docA.id]);
  const gb = await ctx.api.request("GET", searchUrl({ q: "GB 1234" }));
  assert.deepEqual(gb.results.map((item) => item.docId), [docB.id]);

  // 3) 过滤：可信度与标签（facets 由服务端给出）
  const highOnly = await ctx.api.request("GET", searchUrl({ q: "电压偏差", trust: "high" }));
  assert.deepEqual(highOnly.results.map((item) => item.docId), [docA.id]);
  const tagOnly = await ctx.api.request("GET", searchUrl({ q: "电压偏差", tag: "检索" }));
  assert.deepEqual(tagOnly.results.map((item) => item.docId).sort(), [docA.id, docB.id].sort());

  // 4) UI：直接进检索页，卡片 + 安全高亮
  //    排序由 bm25 + boost 决定，不能假设 GB/T 那份一定排第一，按标题定位。
  const page = await ctx.goto(`/kb/#/search?q=${encodeURIComponent("电压偏差")}`);
  const cardA = () => page.locator(".search-card").filter({ hasText: "GB/T 1234-2020" });
  const cardB = () => page.locator(".search-card").filter({ hasText: "GB 1234-2020" });
  await page.locator(".search-card").first().waitFor();
  await poll(async () => (await page.locator(".search-card").count()) === 2, {
    message: "电压偏差应命中两篇夹具",
  });
  assert.equal(await cardA().count(), 1);
  assert.equal(await cardB().count(), 1);
  const cardText = await cardA().innerText();
  assert.ok(cardText.includes("第 4."), cardText.slice(0, 160));
  const mark = cardA().locator(".search-card-snippet mark").first();
  await mark.waitFor();
  assert.ok((await mark.innerText()).includes("电压"), await mark.innerText());
  await page.getByText(/命中 2 篇/).first().waitFor();

  // 5) UI：过滤下拉立即生效
  await page.locator("[data-search-trust]").selectOption("high");
  await poll(async () => (await page.locator(".search-card").count()) === 1, {
    message: "trust=high 后应只剩 GB/T 夹具",
  });
  assert.ok((await cardA().innerText()).includes("高可信"));
  await page.locator("[data-search-trust]").selectOption("");
  await poll(async () => (await page.locator(".search-card").count()) === 2, {
    message: "清空 trust 后应恢复 2 篇",
  });
  await page.locator("[data-search-tag]").selectOption("检索");
  await poll(async () => (await page.locator(".search-card").count()) === 2, {
    message: "tag=检索 应命中 2 篇",
  });

  // 6) UI：清除条件回到空态，示例词直接检索
  await page.locator("[data-search-clear]").click();
  const chip = page.locator(".search-examples .chip").first();
  await chip.waitFor();
  assert.ok((await chip.innerText()).includes("电压偏差"));
  await chip.click();
  await page.locator(".search-card").first().waitFor();
  assert.ok(page.url().includes("#/search?q="), page.url());

  // 7) 深链：点卡片标题复用工作台 viewer；标准号查询会把关键词带进 viewer 高亮
  const gbtApi = await ctx.api.request("GET", searchUrl({ q: "GB/T 1234" }));
  const gbtHit = gbtApi.results.find((item) => item.docId === docA.id);
  assert.ok(gbtHit, "标准号查询应命中 GB/T 夹具");
  await ctx.goto(`/kb/#/search?q=${encodeURIComponent("GB/T 1234")}`);
  await cardA().locator(".search-card-title").waitFor();
  await cardA().locator(".search-card-title").click();
  await page.locator(".preview-modal").waitFor();
  const frame = page.locator(".preview-modal iframe.preview-frame");
  await frame.waitFor();
  const src = await frame.getAttribute("src");
  assert.ok(src && src.includes(`/docs/${docA.id}/viewer.html`), String(src));
  assert.match(String(src), /q=/, "viewer URL 应带检索关键词");
  if (Number.isInteger(gbtHit.page) && gbtHit.page > 0) {
    assert.match(String(src), new RegExp(`page=${gbtHit.page}`), "viewer URL 应带结果页码");
  }
  const inner = page.locator(".preview-modal").frameLocator("iframe.preview-frame");
  await inner.locator(".hl").first().waitFor({ timeout: 20_000 });
  assert.ok((await inner.locator(".hl").count()) > 0, "关键词应在 viewer 里高亮");
  await page.locator(".preview-modal [data-close]").click();
  await page.locator(".preview-modal").waitFor({ state: "detached" });
  assert.ok(page.url().includes("#/search"), "点卡片不应导航离开检索页");

  // 8) UI：无结果空态（保留条件可清除）
  await ctx.goto(`/kb/#/search?q=${encodeURIComponent("不存在的检索词")}`);
  await page.getByText(/没有匹配/).first().waitFor();
  assert.equal(await page.locator(".search-card").count(), 0);
}
