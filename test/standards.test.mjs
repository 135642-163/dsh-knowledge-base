/**
 * 标准更新：结果解析（分类路径 /html|hangye|...）、多页检索、详情页下载 id、
 * 确认页防串档、状态判定（更新/最新/草案转正/废止/分册歧义）、缓存字段清理。
 * 全部用假 HTTP + 固定夹具，不连真实站点。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSearchResults,
  parseDetail,
  parseConfirmPage,
  matchKind,
  classifyStatus,
  classifyDocKind,
  collectKbStandards,
  runStdCheck,
  renderStdReport,
} from "../lib/standards.js";

const BASE = "https://example.test";

/** 一条搜索结果块；href 用分类路径或旧 /html/ 路径。 */
function resultBlock({ href, stdNo, title, status = "现行", pub = "2012-01-04" }) {
  return `<li><div class="type"><span class="line"><a href="/hangye/">行业标准</a></span></div>
  <div class="related" id="size"><div class="related_tit"><a href="${href}" title="" target="_blank">${title}</a></div>
  <div class="related_etit"><dl class="related_des"><span>标准号</span>${stdNo}</dl></div></div>
  <div class="state">${status}</div>
  <div class="panel-footer"><span class="time">发布日期:<em>${pub}</em></span></div></li>`;
}

function searchPage(blocks) {
  return `<!doctype html><html><body><ul>${blocks.join("\n")}</ul></body></html>`;
}

function detailPage({ title, stdNo, downloadAid, status = "现行", replaced = "", pub = "2012-01-04", impl = "2012-07-01" }) {
  return `<!doctype html><html><head><title>${title}_标准下载 - 标准网</title></head><body>
  <a href="/plus/download.php?aid=${downloadAid}" class="btn">下载</a>
  <div class="s-status" data-aid="${downloadAid}" data-zt="${status}" data-ssrq="${impl}"></div>
  <dl><dd><span>标准号：</span>${stdNo}</dd><dd><span>发布日期：</span>${pub}</dd>
  <dd><span>实施日期：</span>${impl}</dd><dd><span>代替标准：</span>${replaced}</dd></dl></body></html>`;
}

function confirmPage({ title, downloadAid, cost = 0 }) {
  return `<!doctype html><html><head><title>${title}_下载地址列表 - 标准网</title></head><body>
  <p>下载需要 ${cost} 金币 升级VIP会员，免费下载。</p>
  <a href="/plus/download.php?open=2&id=${downloadAid}&uhash=abc">电信下载①</a></body></html>`;
}

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const pageRes = (html) => new Response(html, { status: 200, headers: HTML_HEADERS });
const redirectRes = (loc) => new Response("", { status: 302, headers: { location: loc } });

/** 假 HTTP：routes 键是 "METHOD 路径[?qs]"；POST 搜索额外带 q=关键词。 */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    let key = `${method} ${u.pathname}${u.search}`;
    if (method === "POST" && init.body) {
      // 真实 searchStd 传的是 URLSearchParams 对象，夹具里两种形式都要认
      const params = init.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(init.body));
      const q = params.get("q");
      if (q) key = `${method} ${u.pathname}?q=${q}`;
    }
    calls.push(key);
    const handler = routes[key] ?? routes[`${method} ${u.pathname}`];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    // 同一个夹具可能被多次请求命中：Response body 只能读一次，必须 clone
    if (typeof handler === "function") return handler();
    return handler instanceof Response ? handler.clone() : handler;
  };
}

/** 造一个最小知识库：docs 直接写进 kb.json（字段与真实库一致的部分）。 */
async function makeKb(docs) {
  const dir = await mkdtemp(join(tmpdir(), "kb-std-"));
  await writeFile(
    join(dir, "kb.json"),
    JSON.stringify({ name: "标准", docs }, null, 2),
    "utf8"
  );
  return dir;
}

function doc({ id, title, stage = "published", stageLabel = "发布稿", standardNo, standardNumber, standardYear, deletedAt }) {
  return {
    id,
    title,
    stage,
    stageLabel,
    ...(standardNo ? { standardNo, standardPrefix: standardNo.split(/\s/)[0], standardNumber, standardYear } : {}),
    ...(deletedAt ? { deletedAt } : {}),
  };
}

test("parseSearchResults: 分类路径与旧 /html/ 路径都解析，并带出 href", () => {
  const html = searchPage([
    resultBlock({ href: "/hangye/201984.html", stdNo: "DL/T 250-2012", title: "DL/T 250-2012 并联补偿电容器保护装置通用技术条件" }),
    resultBlock({ href: "/html/31857.html", stdNo: "GB/T 29250-2012", title: "GB/T 29250-2012 远红外线干燥箱" }),
    resultBlock({ href: "/guojia/315485.html", stdNo: "GB 32032-2024", title: "GB 32032-2024 金矿开采能耗限额" }),
  ]);
  const items = parseSearchResults(html);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.href), ["/hangye/201984.html", "/html/31857.html", "/guojia/315485.html"]);
  assert.deepEqual(items.map((i) => i.aid), [201984, 31857, 315485]);
  assert.equal(items[0].stdNo, "DL/T250-2012");
  assert.equal(items[0].status, "现行");
  assert.equal(items[0].pubDate, "2012-01-04");
});

test("parseSearchResults: ref 只留同号（分册 partial 不进命中）", () => {
  const html = searchPage([
    resultBlock({ href: "/hangye/1.html", stdNo: "DL/T 250-2012", title: "DL/T 250-2012 A" }),
    resultBlock({ href: "/hangye/2.html", stdNo: "DL/T 250.1-2019", title: "DL/T 250.1-2019 B" }),
  ]);
  const hits = parseSearchResults(html, { compareNumber: "250" });
  assert.equal(hits.length, 2, "分册也带出，交给 pickFound 排序与 ambiguous 兜底");
  assert.equal(matchKind("250", "250"), "exact");
  assert.equal(matchKind("250", "250.1"), "partial");
});

test("matchKind: exact / partial / null", () => {
  assert.equal(matchKind("19963", "19963"), "exact");
  assert.equal(matchKind("19963", "19963.1"), "partial");
  assert.equal(matchKind("19963.1", "19963.11"), null);
  assert.equal(matchKind("", "1"), null);
});

test("classifyStatus: 更新/最新/草案转正/库内更新/未知/歧义", () => {
  assert.equal(classifyStatus({ siteYear: 2024, kind: "exact", maxTextYear: 2011 }), "update");
  assert.equal(classifyStatus({ siteYear: 2008, kind: "exact", maxTextYear: 2008 }), "current");
  assert.equal(classifyStatus({ siteYear: 2008, kind: "exact", maxTextYear: null }), "released");
  assert.equal(classifyStatus({ siteYear: 2001, kind: "exact", maxTextYear: 2008 }), "newer-in-kb");
  assert.equal(classifyStatus({ siteYear: null, kind: "exact", maxTextYear: 2008 }), "unknown");
  assert.equal(classifyStatus({ siteYear: 2024, kind: "partial", maxTextYear: 2008 }), "ambiguous");
  assert.equal(classifyStatus({ siteYear: 2024, kind: null, maxTextYear: 2008 }), null);
});

test("classifyDocKind: 草案 / 编制说明 / 正文（stage 标错也能识别）", () => {
  assert.equal(classifyDocKind({ stage: "draft", title: "GB 12326-2000" }), "draft");
  assert.equal(classifyDocKind({ stage: "published", title: "GB 14549-2019 送审稿" }), "draft");
  assert.equal(classifyDocKind({ stage: "notes", title: "GB 32880.1-2016 征求意见稿-编制说明" }), "draft");
  assert.equal(classifyDocKind({ stage: "notes", title: "GB/T 12326-2008 电能质量 电压波动和闪变" }), "text");
  assert.equal(classifyDocKind({ stage: "notes", title: "GB/T 9999-2020 某某标准编制说明" }), "companion");
});

test("collectKbStandards: 正文年份排除草案/编制说明，且不把软删文档计入", async () => {
  const dir = await makeKb([
    doc({ id: "a", title: "GB 12326-1990 电能质量", standardNo: "GB 12326-1990", standardNumber: "12326", standardYear: 1990 }),
    doc({ id: "b", title: "GB 12326-2000 电能质量", standardNo: "GB 12326-2000", standardNumber: "12326", standardYear: 2000 }),
    // stage 被标成说明材料，但标题就是标准本身 → 算正文
    doc({ id: "c", title: "GB/T 12326-2008 电能质量 电压波动和闪变", stage: "notes", stageLabel: "说明材料", standardNo: "GB/T 12326-2008", standardNumber: "12326", standardYear: 2008 }),
    // 真·编制说明 → 不算正文
    doc({ id: "d", title: "GB 32880.1-2016 征求意见稿-编制说明", stage: "notes", stageLabel: "说明材料", standardNo: "GB 32880.1-2016", standardNumber: "32880.1", standardYear: 2016 }),
    doc({ id: "e", title: "GB/T 19963-2011 风电场接入", standardNo: "GB/T 19963-2011", standardNumber: "19963", standardYear: 2011, deletedAt: "2026-10-01T00:00:00.000Z" }),
  ]);
  const { groups, totalDocs } = await collectKbStandards(dir);
  assert.equal(totalDocs, 4, "软删除文档不计入 totalDocs");
  const g12326 = groups.find((g) => g.key === "GB:12326");
  assert.equal(g12326.maxTextYear, 2008, "正文最新年份应取 2008");
  const g32880 = groups.find((g) => g.key === "GB:32880.1");
  assert.equal(g32880.maxTextYear, null, "只有编制说明时不能当作已有正文");
  assert.notEqual(g32880.docs[0].kind, "text", "征求意见稿-编制说明不能算正文");
  assert.equal(groups.some((g) => g.key === "GB:19963"), false, "软删除文档不生成组");
});

test("collectKbStandards: 同号不同体系不合并成一组（GB 311 vs DL/T 311）", async () => {
  const dir = await makeKb([
    doc({ id: "a", title: "GB 311-1997 高压输变电设备的绝缘配合", stageLabel: "发布稿" }),
    doc({ id: "b", title: "DL/T 311-2024 1100kV气体绝缘金属封闭开关设备检修导则", stageLabel: "发布稿" }),
    doc({ id: "c", title: "GB/T 311.1-2012 绝缘配合 第1部分：定义、原则和规则", stageLabel: "发布稿" }),
  ]);
  const { groups } = await collectKbStandards(dir);
  const gb = groups.find((g) => g.key === "GB:311");
  const dl = groups.find((g) => g.key === "DL:311");
  assert.ok(gb && dl, "GB 与 DL 必须各自成组");
  assert.equal(gb.docs.length, 1);
  assert.equal(dl.docs.length, 1);
  assert.equal(groups.some((g) => g.key === "GB:311.1"), true);
});

test("parseDetail: 取下载 id（与详情页 id 不同源）与站点状态", () => {
  const d = parseDetail(detailPage({ title: "DL/T 250-2012 并联补偿电容器", stdNo: "DL/T 250-2012", downloadAid: 147478, replaced: "DL/T 250-2001" }));
  assert.equal(d.stdNo, "DL/T 250-2012");
  assert.equal(d.downloadAid, 147478);
  assert.equal(d.status, "现行");
  assert.equal(d.replaced, "DL/T 250-2001");
  assert.equal(d.notFoundPage, false);
  const notFound = parseDetail(`<html><head><title>很抱歉，此页面暂时找不到！</title></head><body></body></html>`);
  assert.equal(notFound.notFoundPage, true);
  assert.equal(notFound.stdNo, "");
});

test("parseConfirmPage: 确认页标题反查标准号 + 金币/下载链接", () => {
  const p = parseConfirmPage(confirmPage({ title: "DL/T 250-2012 并联补偿电容器保护装置通用技术条件", downloadAid: 147478, cost: 0 }));
  assert.equal(p.ref.prefix, "DL/T");
  assert.equal(p.ref.year, 2012);
  assert.equal(p.costCoins, 0);
  assert.match(p.fileLink, /open=2&id=147478/);
});

test("runStdCheck: 多页检索 + 分类路径详情 → 命中并判 current", async () => {
  const dir = await makeKb([
    doc({ id: "a", title: "TB/T 2797-1997 电气化铁道 负序电流计算条件和方法", stageLabel: "发布稿" }),
  ]);
  const items1 = Array.from({ length: 15 }, (_, i) =>
    resultBlock({ href: `/hangye/9000${i}.html`, stdNo: `DL/T ${2797 + i}-2024`, title: `DL/T ${2797 + i}-2024 别的标准` })
  );
  const routes = {
    "POST /plus/search.php?q=2797-1997": pageRes(searchPage([])),
    "POST /plus/search.php?q=2797": pageRes(searchPage(items1)),
    "GET /plus/search.php?q=2797&PageNo=1": pageRes(searchPage(items1)),
    "GET /plus/search.php?q=2797&PageNo=2": pageRes(searchPage(items1)),
    "GET /plus/search.php?q=2797&PageNo=3": pageRes(
      searchPage([resultBlock({ href: "/hangye/68740.html", stdNo: "TB/T 2797-1997", title: "TB/T 2797-1997 电气化铁道. 负序电流计算条件和方法" })])
    ),
    "GET /hangye/68740.html": pageRes(detailPage({ title: "TB/T 2797-1997 电气化铁道. 负序电流计算条件和方法", stdNo: "TB/T 2797-1997", downloadAid: 68740, pub: "1997-05-01", impl: "1997-10-01" })),
  };
  const calls = [];
  const { report, cache } = await runStdCheck({
    kbDir: dir,
    baseUrl: BASE,
    cookie: "x",
    rateMs: 0,
    action: "check",
    fetchImpl: fakeFetch(routes, calls),
  });
  assert.equal(report.checked, 1);
  assert.equal(report.notFound.length, 0, "第 3 页的命中必须被找到");
  assert.equal(report.currents.length, 1);
  assert.equal(report.currents[0].siteNo, "TB/T 2797-1997");
  assert.equal(report.currents[0].downloadAid, 68740);
  assert.equal(cache.items["TB:2797"].siteHref, "/hangye/68740.html");
  assert.ok(calls.some((c) => c.includes("PageNo=3")), "应当翻页");
});

test("runStdCheck: 结果页链接是分类路径时不再误判未收录", async () => {
  const dir = await makeKb([doc({ id: "a", title: "GB/Z 26854-2011 电特性的标准化", stageLabel: "发布稿" })]);
  const routes = {
    "POST /plus/search.php": pageRes(
      searchPage([resultBlock({ href: "/guojia/23661.html", stdNo: "GB/Z 26854-2011", title: "GB/Z 26854-2011 电特性的标准化" })])
    ),
    "GET /guojia/23661.html": pageRes(detailPage({ title: "GB/Z 26854-2011 电特性的标准化", stdNo: "GB/Z 26854-2011", downloadAid: 23661, pub: "2011-12-30", impl: "2012-06-01" })),
  };
  const { report } = await runStdCheck({ kbDir: dir, baseUrl: BASE, cookie: "x", rateMs: 0, action: "check", fetchImpl: fakeFetch(routes) });
  assert.equal(report.notFound.length, 0);
  assert.equal(report.currents.length, 1);
  assert.equal(report.currents[0].siteNo, "GB/Z 26854-2011");
});

test("runStdCheck: 站内别的标准同号（不同体系）不算命中", async () => {
  const dir = await makeKb([doc({ id: "a", title: "NB/T 31005-2022 风电场电能质量测试方法", stageLabel: "发布稿" })]);
  const routes = {
    "POST /plus/search.php?q=31005-2022": pageRes(searchPage([])),
    "POST /plus/search.php?q=31005": pageRes(
      searchPage([resultBlock({ href: "/guojia/44104.html", stdNo: "GB/T 31005-2014", title: "GB/T 31005-2014 托盘编码及条码表示" })])
    ),
    "GET /plus/search.php?q=31005&PageNo=2": pageRes(searchPage([])),
  };
  const { report } = await runStdCheck({ kbDir: dir, baseUrl: BASE, cookie: "x", rateMs: 0, action: "check", fetchImpl: fakeFetch(routes) });
  assert.equal(report.notFound.length, 1);
  assert.equal(report.currents.length, 0);
});

test("runStdCheck: 站点标废止 → superseded（不是“已是最新”）", async () => {
  const dir = await makeKb([doc({ id: "a", title: "GB/T 19963-2011 风电场接入电力系统技术规定", stageLabel: "发布稿" })]);
  const routes = {
    "POST /plus/search.php": pageRes(searchPage([resultBlock({ href: "/guojia/28071.html", stdNo: "GB/T 19963-2011", title: "GB/T 19963-2011 风电场接入电力系统技术规定", status: "废止" })])),
    "GET /guojia/28071.html": pageRes(detailPage({ title: "GB/T 19963-2011 风电场接入电力系统技术规定", stdNo: "GB/T 19963-2011", downloadAid: 28071, status: "废止" })),
  };
  const { report } = await runStdCheck({ kbDir: dir, baseUrl: BASE, cookie: "x", rateMs: 0, action: "check", fetchImpl: fakeFetch(routes) });
  assert.equal(report.superseded.length, 1);
  assert.equal(report.currents.length, 0);
  const text = renderStdReport(report);
  assert.match(text, /库内版本已被站点标注废止/);
});

test("runStdCheck: 站外体系（Q/GDW/IEC…）不发任何请求直接判未收录", async () => {
  const dir = await makeKb([doc({ id: "a", title: "Q/GDW 10878-2023 风电场无功配置及电压控制技术规定", stageLabel: "发布稿" })]);
  const routes = {}; // 任何请求都会抛错 = 证明没有发请求
  const { report } = await runStdCheck({ kbDir: dir, baseUrl: BASE, cookie: "x", rateMs: 0, action: "check", fetchImpl: fakeFetch(routes) });
  assert.equal(report.notFound.length, 1);
  assert.equal(report.notFound[0].offSite, true);
  assert.equal(report.checked, 1);
});

test("runStdCheck: 第 1 页没有同数字条目时不再翻到第 3 页", async () => {
  const dir = await makeKb([doc({ id: "a", title: "DL/T 2193-2020 电力系统安全稳定控制系统设计及应用技术规范", stageLabel: "发布稿" })]);
  const unrelated = Array.from({ length: 15 }, (_, i) =>
    resultBlock({ href: `/hangye/91${i}.html`, stdNo: `GB/T 70${i}0-2021`, title: `GB/T 70${i}0-2021 别的标准` })
  );
  const calls = [];
  const routes = {
    "POST /plus/search.php": pageRes(searchPage(unrelated)),
  };
  const { report } = await runStdCheck({ kbDir: dir, baseUrl: BASE, cookie: "x", rateMs: 0, action: "check", fetchImpl: fakeFetch(routes, calls) });
  assert.equal(report.notFound.length, 1);
  assert.equal(calls.filter((c) => c.includes("PageNo=")).length, 0, "本页没有同数字条目就不应翻页");
});

test("runStdCheck: 库内已有更新正文时，站点旧记录标废止不算“库内版本已废止”", async () => {
  const dir = await makeKb([
    doc({ id: "a", title: "DL/T 5002-2005 地区电网调度自动化设计规程", stageLabel: "发布稿" }),
    doc({ id: "b", title: "DL/T 5002-2021 地区电网调度自动化设计规程", stageLabel: "发布稿" }),
  ]);
  const routes = {
    "POST /plus/search.php": pageRes(searchPage([resultBlock({ href: "/hangye/2.html", stdNo: "DL/T 5002-2005", title: "DL/T 5002-2005 地区电网调度自动化设计规程", status: "废止" })])),
    "GET /hangye/2.html": pageRes(detailPage({ title: "DL/T 5002-2005 地区电网调度自动化设计规程", stdNo: "DL/T 5002-2005", downloadAid: 2, status: "废止", pub: "2005-06-01", impl: "2005-12-01" })),
  };
  const { report } = await runStdCheck({ kbDir: dir, baseUrl: BASE, cookie: "x", rateMs: 0, action: "check", fetchImpl: fakeFetch(routes) });
  assert.equal(report.superseded.length, 0, "库内 2021 版仍在，不能报“库内版本已废止”");
  assert.equal(report.newerInKb.length, 1);
});

test("runStdCheck: 裸号命中分册 → ambiguous，不判更新也不下载", async () => {
  const dir = await makeKb([doc({ id: "a", title: "GB/T 19963 风电场接入电力系统技术规定", stageLabel: "发布稿" })]);
  const routes = {
    "POST /plus/search.php": pageRes(searchPage([resultBlock({ href: "/guojia/50001.html", stdNo: "GB/T 19963.1-2021", title: "GB/T 19963.1-2021 风电场接入电力系统技术规定 第1部分" })])),
    "GET /guojia/50001.html": pageRes(detailPage({ title: "GB/T 19963.1-2021 风电场接入电力系统技术规定 第1部分", stdNo: "GB/T 19963.1-2021", downloadAid: 50001, pub: "2021-10-11", impl: "2022-05-01" })),
  };
  const { report } = await runStdCheck({ kbDir: dir, baseUrl: BASE, cookie: "x", rateMs: 0, action: "check", fetchImpl: fakeFetch(routes) });
  assert.equal(report.ambiguous.length, 1);
  assert.equal(report.updates.length, 0);
  assert.equal(report.draftsReleased.length, 0);
});

test("runStdCheck: not-found 会清掉上一轮残留的站点字段", async () => {
  const dir = await makeKb([doc({ id: "a", title: "TB/T 2798-1997 交流电气化铁道", stageLabel: "发布稿" })]);
  await writeFile(
    join(dir, ".std-check.json"),
    JSON.stringify({
      items: {
        "TB:2798": {
          key: "TB:2798", number: "2798", prefix: "TB",
          status: "update", checkedAt: 1,
          siteNo: "GB/T 27982-2026", siteTitle: "GB/T 27982-2026 小反刍兽疫诊断技术",
          siteYear: 2026, siteStatus: "即将实施", replaced: "代替GB/T 27982-2011", downloadAid: 383575,
        },
      },
    }),
    "utf8"
  );
  const routes = { "POST /plus/search.php": pageRes(searchPage([])) };
  const { cache } = await runStdCheck({ kbDir: dir, baseUrl: BASE, cookie: "x", rateMs: 0, action: "check", force: true, fetchImpl: fakeFetch(routes) });
  const entry = cache.items["TB:2798"];
  assert.equal(entry.status, "not-found");
  for (const field of ["siteNo", "siteTitle", "siteYear", "siteStatus", "replaced", "downloadAid", "siteAid"]) {
    assert.equal(entry[field], undefined, `${field} 应被清掉`);
  }
});

test("runStdCheck: 下载前用确认页反查标准号，不一致则中止（防串档）", async () => {
  const dir = await makeKb([doc({ id: "a", title: "DL/T 250-2012 并联补偿电容器保护装置通用技术条件", stageLabel: "发布稿", standardNo: "DL/T 250-2012", standardNumber: "250", standardYear: 2012 })]);
  const routes = {
    "POST /plus/search.php": pageRes(searchPage([resultBlock({ href: "/hangye/201984.html", stdNo: "DL/T 250-2019", title: "DL/T 250-2019 并联补偿电容器保护装置通用技术条件" })])),
    "GET /hangye/201984.html": pageRes(detailPage({ title: "DL/T 250-2019 并联补偿电容器保护装置通用技术条件", stdNo: "DL/T 250-2019", downloadAid: 147478, pub: "2019-06-03", impl: "2019-10-01" })),
    // 下载 id 147478 对应的是别的标准（站点两套编号的真实坑）
    "GET /plus/download.php?aid=147478": pageRes(confirmPage({ title: "DB65/T 3931-2016 风力发电场防雷技术规范", downloadAid: 147478 })),
  };
  const { report } = await runStdCheck({ kbDir: dir, baseUrl: BASE, cookie: "x", rateMs: 0, action: "check-download", fetchImpl: fakeFetch(routes) });
  assert.equal(report.updates.length, 1, "检查阶段应判出更新");
  assert.equal(report.downloaded.length, 0, "确认页不一致时不能下载");
  assert.equal(report.downloadFailed.length, 1);
  assert.match(report.downloadFailed[0].reason, /确认页与目标标准不一致/);
  assert.equal(existsSync(join(dir, "import-tmp", "std-download")), false, "不应落盘任何文件");
});

test("runStdCheck: 确认页一致时正常下载并记录金币", async () => {
  const dir = await makeKb([doc({ id: "a", title: "DL/T 250-2012 并联补偿电容器保护装置通用技术条件", stageLabel: "发布稿", standardNo: "DL/T 250-2012", standardNumber: "250", standardYear: 2012 })]);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 1)]);
  const routes = {
    "POST /plus/search.php": pageRes(searchPage([resultBlock({ href: "/hangye/201984.html", stdNo: "DL/T 250-2019", title: "DL/T 250-2019 并联补偿电容器保护装置通用技术条件" })])),
    "GET /hangye/201984.html": pageRes(detailPage({ title: "DL/T 250-2019 并联补偿电容器保护装置通用技术条件", stdNo: "DL/T 250-2019", downloadAid: 147478, pub: "2019-06-03", impl: "2019-10-01", replaced: "DL/T 250-2012" })),
    "GET /plus/download.php?aid=147478": pageRes(confirmPage({ title: "DL/T 250-2019 并联补偿电容器保护装置通用技术条件", downloadAid: 147478, cost: 6 })),
    "GET /plus/download.php?open=2&id=147478&uhash=abc": new Response(pdf, { status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'filename="DLT250-2019.pdf"' } }),
  };
  const { report } = await runStdCheck({ kbDir: dir, baseUrl: BASE, cookie: "x", rateMs: 0, action: "check-download", fetchImpl: fakeFetch(routes) });
  assert.equal(report.downloaded.length, 1);
  assert.equal(report.downloadFailed.length, 0);
  assert.equal(report.coinsSpent, 6);
  const file = join(dir, "import-tmp", "std-download", "DL_T 250-2019.pdf");
  assert.ok(existsSync(file), "下载文件应落在 import-tmp/std-download");
  const buf = await readFile(file);
  assert.equal(buf[0], 0x25);
  assert.match(renderStdReport(report), /本轮消耗金币合计 6/);
});

test("runStdCheck: 站点提示每日上限时停止后续下载", async () => {
  const dir = await makeKb([doc({ id: "a", title: "DL/T 250-2012 A", stageLabel: "发布稿", standardNo: "DL/T 250-2012", standardNumber: "250", standardYear: 2012 })]);
  const routes = {
    "POST /plus/search.php": pageRes(searchPage([resultBlock({ href: "/hangye/1.html", stdNo: "DL/T 250-2019", title: "DL/T 250-2019 A" })])),
    "GET /hangye/1.html": pageRes(detailPage({ title: "DL/T 250-2019 A", stdNo: "DL/T 250-2019", downloadAid: 11 })),
    "GET /plus/download.php?aid=11": pageRes(confirmPage({ title: "DL/T 250-2019 A", downloadAid: 11 })),
    "GET /plus/download.php?open=2&id=11&uhash=abc": pageRes("<html><body>今日下载次数已用完，明日再来</body></html>"),
  };
  const { report } = await runStdCheck({ kbDir: dir, baseUrl: BASE, cookie: "x", rateMs: 0, action: "check-download", fetchImpl: fakeFetch(routes) });
  assert.equal(report.dailyLimit, true);
  assert.match(report.downloadFailed[0].reason, /今日下载次数已用完/);
  assert.match(renderStdReport(report), /今日下载次数已用完/);
});

test("renderStdReport: 更新行用“库内正文”口径，不再出现 2008 → 2008 的自相矛盾", () => {
  const report = {
    kbDir: "/tmp/kb", totalDocs: 10, stdGroups: 3, checked: 3, fresh: 0, deferred: 0,
    updates: [{ siteNo: "GB/T 12326-2008", siteYear: 2008, siteStatus: "现行", siteTitle: "GB/T 12326-2008 电能质量", maxTextYear: 2000, docs: [{ year: 2000 }, { year: 2008 }], replaced: "代替GB 12326-2000", downloadAid: 65092 }],
    draftsReleased: [], superseded: [], ambiguous: [], currents: [], notFound: [], newerInKb: [], unknown: [],
    downloaded: [], downloadFailed: [], coinsSpent: 0, dailyLimit: false, authOk: null,
  };
  const text = renderStdReport(report);
  assert.match(text, /库内正文 2000 → 站点 2008/);
  assert.match(text, /代替标准: 代替GB 12326-2000/);
});
