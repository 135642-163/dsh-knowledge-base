/**
 * 质量 tab（0.36 P3）端到端：筛选、证据、dry-run 预览零写入、
 * 元数据动作执行、只读禁用。
 *
 * 独立建一个「质量库」并直接写清单（不跑解析），避免影响其它用例的固定数据。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { poll } from "../ui.mjs";
import { kbDirPath, readManifest, writeManifestAtomic } from "../../../lib/store.js";
import { parseDocMeta } from "../../../lib/doc-meta.js";
import { PARSER_VERSION } from "../../../lib/version.js";

export const name = "质量队列：筛选/预览/执行/只读";

const KB = "质量库";

function makeDoc(id, title, extra = {}) {
  // 与真实导入一致：standardNo 与结构化字段一起写，否则 lint 的同号分组
  // 会因为 prefix/base/year 全空而把所有文档判成同一组。
  const meta = parseDocMeta(title, title);
  return {
    id,
    title,
    type: "pdf-mixed",
    status: "ready",
    pages: 5,
    chars: 800,
    parts: 1,
    version: 1,
    contentSource: "text",
    parserVersion: PARSER_VERSION,
    outline: [],
    summary: "范围句：本文件规定了试验方法。",
    tags: [],
    trust: "high",
    updatedAt: "2026-11-01T00:00:00.000Z",
    sourceHash: `hash-${id}`,
    sourceFile: `${id}.pdf`,
    standardNo: meta.standardNo,
    standardPrefix: meta.standardPrefix,
    standardBase: meta.standardBase,
    standardNumber: meta.standardNumber,
    standardYear: meta.standardYear,
    standardPart: meta.standardPart,
    stage: meta.stage,
    stageLabel: meta.stageLabel,
    ...extra,
  };
}

function fixtureDocs() {
  return [
    makeDoc("q1", "GB/T 31517.1-2022 固定式海上风力发电机组", { corruptedPages: [2, 3] }),
    makeDoc("q2", "IEC 61000-4-30-2015 电能质量测量方法", { lowConfidencePages: [2] }),
    makeDoc("q3", "GB/T 3000-2019 未编目资料", { summary: "" }),
    makeDoc("q4", "IEC 61000-4-11-2004 电压暂降", {
      summary: "Copyright © 2004 IEC. All rights reserved.",
    }),
    // 同号同期同阶段：给「标记保留」批处理用
    makeDoc("d1", "GB/T 9999-2020 重复样本甲"),
    makeDoc("d2", "GB/T 9999-2020 重复样本乙"),
  ];
}

async function setupKb(ctx) {
  try {
    await ctx.api.createKb(KB, { description: "E2E 质量队列" });
  } catch (error) {
    if (String(error?.code ?? "") !== "KB_EXISTS") throw error;
  }
  const dir = kbDirPath(ctx.kbRoot, KB);
  const manifest = await readManifest(dir);
  manifest.docs = fixtureDocs();
  await writeManifestAtomic(dir, manifest);
  // 让 kb_view / 预览不因为缺原件报 500（本轮不点「查看原页」，仅保持数据自洽）。
  await mkdir(join(dir, "sources"), { recursive: true });
  for (const doc of manifest.docs) {
    await writeFile(join(dir, "sources", `${doc.id}.pdf`), "%PDF-1.4 e2e\n", "utf8");
  }
  return dir;
}

export async function run(ctx) {
  await setupKb(ctx);
  const page = await ctx.goto(`/kb/#/kb/${encodeURIComponent(KB)}/quality`);
  await page.locator(".quality-panel").waitFor();

  // 分组与证据
  const corrupted = page.locator('.quality-group[data-code="corrupted"]');
  await corrupted.waitFor();
  assert.equal(await corrupted.locator(".badge").first().textContent(), "2");
  assert.match(await corrupted.innerText(), /坏页 2,3/);
  assert.equal(await page.locator('.quality-group[data-code="same-number"]').count(), 1);
  assert.equal(await page.locator('.quality-group[data-code="unlabeled"]').count(), 1);
  assert.equal(await page.locator('.quality-group[data-code="summary-noise"]').count(), 1);

  // 快捷筛选：仅坏页 → 只剩一组；返回全部 → 多组
  await page.locator('[data-action="quality-filter"][data-filter="corrupted"]').click();
  await poll(async () => (await page.locator(".quality-group").count()) === 1, { message: "仅坏页应只显示一组" });
  assert.equal(await page.locator('.quality-group[data-code="corrupted"]').count(), 1);
  await page.locator('[data-action="quality-filter"][data-filter=""]').click();
  await poll(async () => (await page.locator(".quality-group").count()) > 1, { message: "返回全部组" });

  // 单选坏页行 → dry-run 预览（零写入）
  const before = await ctx.api.quality(KB, { maxItems: 50 });
  await corrupted.locator('[data-action="quality-select"]').first().check();
  await page.locator(".quality-bulk").waitFor();
  assert.match(await page.locator(".quality-bulk").textContent(), /已选 1 篇/);
  await page.locator('[data-action="quality-preview"]').click();
  const modal = page.locator(".quality-modal");
  await modal.waitFor();
  const modalText = await modal.innerText();
  assert.match(modalText, /执行质量动作：重解析坏页/);
  assert.match(modalText, /页码 2,3/);
  assert.match(modalText, /确认执行（写入）/);
  await modal.locator("[data-close]").first().click();
  await modal.waitFor({ state: "detached" });
  const afterPreview = await ctx.api.quality(KB, { maxItems: 50 });
  assert.equal(afterPreview.summary.warning, before.summary.warning, "dry-run 预览不得写入");
  assert.equal(await page.locator('.quality-group[data-code="corrupted"]').count(), 1);

  // 批量标记保留：同步元数据动作，逐项结果写进「上次执行」
  await page.locator('.quality-group[data-code="same-number"] [data-action="quality-select-group"]').click();
  assert.match(await page.locator(".quality-bulk").textContent(), /已选 2 篇/);
  await page.locator('[data-action="quality-preview"]').click();
  await modal.waitFor();
  assert.match(await modal.innerText(), /执行质量动作：标记保留/);
  await modal.locator('button[type="submit"]').click();
  await ctx.helpers.toast("标记保留：2 篇完成");
  await page.locator(".quality-result").waitFor();
  assert.match(await page.locator(".quality-result").innerText(), /成功 2 篇/);

  // 组消失 + 清单落盘
  await poll(async () => (await page.locator('.quality-group[data-code="same-number"]').count()) === 0, {
    message: "标记保留后同号组应消失",
  });
  const manifest = await readManifest(kbDirPath(ctx.kbRoot, KB));
  assert.equal(manifest.docs.find((doc) => doc.id === "d1").dedupKeep, true);
  assert.equal(manifest.docs.find((doc) => doc.id === "d2").dedupKeep, true);
  assert.equal(await page.locator('.quality-group[data-code="corrupted"]').count(), 1, "坏页组不受元数据动作影响");

  // 只读库：可查看、动作与勾选禁用
  await ctx.api.request("PATCH", `/kbs/${encodeURIComponent(KB)}`, { readOnly: true });
  await page.reload();
  await page.locator(".quality-panel").waitFor();
  await page.locator(".quality-readonly").waitFor();
  assert.equal(await page.locator('[data-action="quality-act"]').count(), 0, "只读库不应渲染动作按钮");
  assert.equal(await page.locator('[data-action="quality-select"]').count(), 0, "只读库不应渲染勾选框");
  await ctx.api.request("PATCH", `/kbs/${encodeURIComponent(KB)}`, { readOnly: false });
}
