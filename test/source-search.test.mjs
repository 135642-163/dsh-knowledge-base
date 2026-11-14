/**
 * 找资料：搜索词推断、标准/网页候选归一化、库内标记。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markInLibrary, queryFromOcrText, searchWeb } from "../lib/source-search.js";
import { readManifest } from "../lib/store.js";

test("queryFromOcrText extracts standard number first", () => {
  const result = queryFromOcrText("封面\nGB/T 19963.2-2024\n风电场接入电力系统技术规定");
  assert.equal(result.kind, "standard");
  assert.match(result.query, /GB\/T 19963\.2-2024/);
});

test("queryFromOcrText falls back to a title line", () => {
  const result = queryFromOcrText("某某省电力公司\n关于印发《配电网技术导则》的通知\n2025 年 3 月");
  assert.equal(result.kind, "general");
  assert.match(result.query, /配电网技术导则|某某省电力公司/);
});

test("searchWeb maps DeepSeek results to candidates", async () => {
  const candidates = await searchWeb({
    query: "配电网技术导则",
    apiKey: "k",
    count: 3,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "配电网技术导则（2024）",
              url: "https://example.com/a",
              snippet: "……",
              summary: "摘要",
              site_name: "示例站",
              date: "2024-06-01T00:00:00+00:00",
              authority: 3,
              rerank_score: 2.4,
            },
          ],
        }),
        { status: 200 }
      ),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, "web");
  assert.equal(candidates[0].date, "2024-06-01");
  assert.equal(candidates[0].authority, 3);
});

test("markInLibrary matches standard number or title", async () => {
  const root = await mkdtemp(join(tmpdir(), "kb-find-lib-"));
  try {
    const kbDir = join(root, "标准");
    await mkdir(join(kbDir, "sources"), { recursive: true });
    await writeFile(
      join(kbDir, "kb.json"),
      JSON.stringify({
        version: 1,
        name: "标准",
        docs: [
          { id: "a", status: "ready", title: "GB/T 19963.2-2024 风电场接入电力系统技术规定", standardNo: "GB/T 19963.2-2024" },
          { id: "b", status: "ready", title: "配电网技术导则", standardNo: "" },
        ],
      }),
      "utf8"
    );
    const candidates = [
      { title: "海上风电接入", stdNo: "GB/T 19963.2-2024", url: "https://a" },
      { title: "配电网技术导则（2024 版）", stdNo: "", url: "https://b" },
      { title: "无关资料", stdNo: "", url: "https://c" },
    ];
    await markInLibrary(candidates, { kbRoot: root, kbs: ["标准"] });
    assert.equal(candidates[0].inLibrary.kb, "标准");
    assert.equal(candidates[1].inLibrary.kb, "标准");
    assert.equal(candidates[2].inLibrary, undefined);
    const manifest = await readManifest(kbDir);
    assert.equal(manifest.docs.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("封面 OCR 同时保留标准号与标题，网页查询带上标题", () => {
  const result = queryFromOcrText([
    "ICS 29.240",
    "Q/GDW",
    "国家电网有限公司企业标准",
    "Q/GDW10212—202X",
    "代替Q/GDW10212—2019",
    "电力系统无功补偿配置导则",
    "20XX-XX-XX发布",
  ].join("\n"));
  assert.equal(result.kind, "standard");
  assert.equal(result.standardNo, "Q/GDW 10212");
  assert.equal(result.title, "电力系统无功补偿配置导则");
  assert.match(result.query, /Q\/GDW 10212/);
  assert.match(result.query, /电力系统无功补偿配置导则/);
});

test("网页结果按标准号/标题过滤，不同体系同号不混入", async () => {
  const candidates = await searchWeb({
    query: "Q/GDW 10212 电力系统无功补偿配置导则",
    standardNo: "Q/GDW 10212",
    title: "电力系统无功补偿配置导则",
    apiKey: "k",
    fetchImpl: async () =>
      new Response(JSON.stringify({
        results: [
          {
            title: "Q/GDW 10212-2019 电力系统无功补偿技术导则",
            url: "https://example.com/qgdw",
            summary: "标准号：Q/GDW 10212-2019",
            authority: 2,
          },
          {
            title: "TB 10212-2009 铁路钢桥制造规范",
            url: "https://example.com/tb",
            summary: "TB 10212-2009",
            authority: 3,
          },
        ],
      }), { status: 200 }),
  });
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].url, /qgdw/);
});

test("整页图片没有标准号时用关键词查询，而不是第一行正文", () => {
  const page = `用户的共同责任。建立健全政府监督管理、行业自律和企业履责的机制，强化和落实发电企业、电网企业、电力用户的主体责任，共同维护电力系统电能质量水平。第二章 组织与职责 第六条 国家能源局负责全国电能质量管理和监督工作，建立健全电能质量管理制度和行业标准；地方各级电力管理部门负责本行政区域内电能质量管理工作。`;
  const result = queryFromOcrText(page);
  assert.equal(result.kind, "general");
  assert.match(result.query, /电能质量/);
  assert.match(result.query, /电网企业|发电企业|监督管理/);
  assert.ok(result.query.length <= 128);
});

test("通用资料的网页搜索不按 OCR 首行标题过滤", async () => {
  const candidates = await searchWeb({
    query: "电能质量 国家能源局 电网企业",
    title: "第二章 组织与职责",
    apiKey: "k",
    fetchImpl: async () =>
      new Response(JSON.stringify({
        results: [{
          title: "电能质量管理办法（暂行）",
          url: "https://example.com/gov",
          summary: "国家能源局负责全国电能质量监督管理。",
          authority: 4,
        }],
      }), { status: 200 }),
  });
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].url, /gov/);
});
