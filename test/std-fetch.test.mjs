/**
 * 按标准号补下载：检索 → 详情下载 id → 确认页防串档 → 下载 → 导入。
 * 全部用假 HTTP，不连真实站点。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchStdNumber, renderStdFetchResult } from "../lib/std-fetch.js";

const BASE = "https://example.test";

function textResponse(body, { status = 200, headers = {} } = {}) {
  return {
    status,
    headers: { get: (key) => headers[String(key).toLowerCase()] ?? null },
    async text() { return body; },
    async arrayBuffer() { return Buffer.from(body); },
  };
}

function fileResponse(buffer) {
  return {
    status: 200,
    headers: {
      get: (key) => (String(key).toLowerCase() === "content-type" ? "application/pdf" : null),
    },
    async text() { return ""; },
    async arrayBuffer() { return buffer; },
  };
}

function searchBlock({ href = "/hangye/201984.html", stdNo = "GB/T 4728.12-2022", title = "电气简图用图形符号 第12部分", status = "现行" } = {}) {
  return `<li><div class="type"><span class="line"><a href="/guojia/">国家标准</a></span></div>
  <div class="related" id="size"><div class="related_tit"><a href="${href}" title="">${title}</a></div>
  <div class="related_etit"><dl class="related_des"><span>标准号</span>${stdNo}</dl></div></div>
  <div class="state">${status}</div>
  <div class="panel-footer"><span class="time">发布日期:<em>2022-03-09</em></span></div></li>`;
}

function searchPage(blocks) {
  return `<!doctype html><html><body><ul>${blocks.join("\n")}</ul></body></html>`;
}

function detailPage({ stdNo = "GB/T 4728.12-2022", title = "电气简图用图形符号 第12部分", aid = 147478 } = {}) {
  return `<!doctype html><html><head><title>${stdNo} ${title}</title></head><body>
    <div class="s-status" data-aid="${aid}" data-zt="现行"></div>
    <dl><dd><span>标准号：</span>${stdNo}</dd>
    <dd><span>发布日期：</span>2022-03-09</dd>
    <dd><span>实施日期：</span>2022-10-01</dd>
    <dd><span>代替标准：</span>GB/T 4728.12-2008</dd></dl>
  </body></html>`;
}

function confirmPage({ title = "GB/T 4728.12-2022 电气简图用图形符号 第12部分_下载地址列表", cost = 0, noAuth = false } = {}) {
  return `<!doctype html><html><head><title>${title}</title></head><body>
    <p>${noAuth ? "版权限制暂无下载" : `下载需要 ${cost} 金币 VIP会员免费下载`}</p>
    ${noAuth ? "" : '<a href="/plus/download.php?open=2&amp;aid=147478">下载</a>'}
  </body></html>`;
}

function makeFetch({
  search = searchBlock(),
  confirm = confirmPage(),
  file = Buffer.from("%PDF-1.4 fake"),
  fileResponseOverride = null,
  onRequest = () => {},
} = {}) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    onRequest(parsed, options);
    if (parsed.pathname === "/plus/search.php") {
      return textResponse(searchPage(search ? [search] : []));
    }
    if (/^\/(hangye|html|guojia)\//.test(parsed.pathname)) {
      return textResponse(detailPage());
    }
    // open=2 是真实下载链接；它也带 aid，必须先于确认页判断。
    if (parsed.pathname === "/plus/download.php" && parsed.searchParams.get("open")) {
      return fileResponseOverride ?? fileResponse(file);
    }
    if (parsed.pathname === "/plus/download.php" && parsed.searchParams.get("aid")) {
      return textResponse(confirm);
    }
    throw new Error(`unexpected request: ${url}`);
  };
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), "kb-std-fetch-"));
}

test("dryRun：只检索并校验确认页/金币，不下载", async () => {
  const kbDir = await tempDir();
  try {
    let downloaded = false;
    const fetchImpl = makeFetch({
      confirm: confirmPage({ cost: 2 }),
      fileResponseOverride: {
        status: 200,
        headers: { get: () => null },
        async text() { downloaded = true; return ""; },
        async arrayBuffer() { return Buffer.from(""); },
      },
    });
    const result = await fetchStdNumber({ kbDir, stdNo: "GB/T 4728.12-2022", baseUrl: BASE, cookie: "c=1", rateMs: 1, dryRun: true, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(result.siteStdNo, "GB/T 4728.12-2022");
    assert.equal(result.costCoins, 2);
    assert.equal(result.downloadAid, 147478);
    assert.equal(downloaded, false);
    assert.match(renderStdFetchResult(result), /可下载/);
  } finally {
    await rm(kbDir, { recursive: true, force: true });
  }
});

test("确认页标准号不一致：中止，不下载", async () => {
  const kbDir = await tempDir();
  try {
    const fetchImpl = makeFetch({ confirm: confirmPage({ title: "DL/T 999-2020 别的标准_下载地址列表" }) });
    const result = await fetchStdNumber({ kbDir, stdNo: "GB/T 4728.12-2022", baseUrl: BASE, rateMs: 1, dryRun: false, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, "confirm-mismatch");
    assert.match(result.reason, /不一致/);
  } finally {
    await rm(kbDir, { recursive: true, force: true });
  }
});

test("未登录/版权限制：返回 auth-required", async () => {
  const kbDir = await tempDir();
  try {
    const fetchImpl = makeFetch({ confirm: confirmPage({ noAuth: true }) });
    const result = await fetchStdNumber({ kbDir, stdNo: "GB/T 4728.12-2022", baseUrl: BASE, rateMs: 1, dryRun: false, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, "auth-required");
    assert.equal(result.noAuth, true);
  } finally {
    await rm(kbDir, { recursive: true, force: true });
  }
});

test("下载并导入：调用 importFn、写文件并回写 .std-check.json", async () => {
  const kbDir = await tempDir();
  try {
    await writeFile(join(kbDir, ".std-check.json"), JSON.stringify({
      items: {
        "GB:4728.12": { siteNo: "GB/T 4728.12-2022", number: "4728.12", prefix: "GB", status: "update" },
      },
    }), "utf8");
    let importedFile = "";
    let importedTitle = "";
    const fetchImpl = makeFetch({ confirm: confirmPage({ cost: 0 }) });
    const result = await fetchStdNumber({
      kbDir,
      stdNo: "GB/T 4728.12-2022",
      baseUrl: BASE,
      rateMs: 1,
      dryRun: false,
      fetchImpl,
      async importFn(filePath, title) {
        importedFile = filePath;
        importedTitle = title;
        return { docId: "doc123" };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "imported");
    assert.equal(result.docId, "doc123");
    assert.match(importedFile, /std-download\/GB_T 4728\.12-2022\.pdf$/);
    assert.match(importedTitle, /图形符号/);
    const cache = JSON.parse(await readFile(join(kbDir, ".std-check.json"), "utf8"));
    assert.equal(cache.items["GB:4728.12"].importedDocId, "doc123");
    assert.ok(cache.items["GB:4728.12"].downloadedAt);
    assert.equal(cache.items["GB:4728.12"].downloadedFile, "GB_T 4728.12-2022.pdf");
  } finally {
    await rm(kbDir, { recursive: true, force: true });
  }
});

test("每日上限：停止并返回 daily-limit", async () => {
  const kbDir = await tempDir();
  try {
    const fetchImpl = makeFetch({
      fileResponseOverride: textResponse("<title>提示</title><p>今日下载次数已用完</p>", {
        headers: { "content-type": "text/html" },
      }),
    });
    const result = await fetchStdNumber({ kbDir, stdNo: "GB/T 4728.12-2022", baseUrl: BASE, rateMs: 1, dryRun: false, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, "daily-limit");
    assert.equal(result.dailyLimit, true);
  } finally {
    await rm(kbDir, { recursive: true, force: true });
  }
});

test("站点未找到：not-found", async () => {
  const kbDir = await tempDir();
  try {
    const fetchImpl = makeFetch({ search: null });
    const result = await fetchStdNumber({ kbDir, stdNo: "DL/T 436-2021", baseUrl: BASE, rateMs: 1, dryRun: true, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, "not-found");
    assert.match(result.reason, /未找到/);
  } finally {
    await rm(kbDir, { recursive: true, force: true });
  }
});
