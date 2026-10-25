/**
 * 回收站（资料页签）：归档库/已删除资料两个分区 + 行内恢复、逐字确认彻底删除、
 * 批量删除同一库、以及详情页「清空本库已删除资料」。
 */
import assert from "node:assert/strict";
import { poll } from "../ui.mjs";
import { FIXTURES } from "../seed.mjs";

export const name = "回收站：归档库/已删除资料、恢复与两种彻底删除";

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

async function openTrashDocs(ctx) {
  const page = await ctx.goto("/kb/#/trash?tab=docs");
  await page.locator(".trash-tabs").waitFor();
  await poll(async () => (await page.locator(".trash-doc-row").count()) > 0, {
    message: "等待已删除资料列表渲染",
  });
  return page;
}

export async function run(ctx) {
  const page = await openTrashDocs(ctx);
  const helpers = {
    async toast(text) {
      const toast = page.locator("#toast");
      await toast.waitFor({ state: "visible", timeout: 15_000 });
      await poll(async () => normalize(await toast.textContent()).includes(text), {
        message: `等待 toast 包含「${text}」`,
      });
    },
  };

  // 页签计数：1 个归档库 + 4 篇已删除资料（甲库 3 + 乙库 1）。
  const tabs = (await page.locator(".trash-tabs .seg").allInnerTexts()).map(normalize);
  assert.ok(tabs.some((text) => /归档库\s*1/.test(text)), `归档库计数不是 1：${tabs.join(" | ")}`);
  assert.ok(tabs.some((text) => /已删除资料\s*4/.test(text)), `已删除资料计数不是 4：${tabs.join(" | ")}`);

  const rows = page.locator(".trash-doc-row");
  assert.equal(await rows.count(), 4, "已删除资料应有 4 行");
  const badges = (await page.locator(".trash-doc-row .trash-kb-badge").allInnerTexts()).map(normalize);
  assert.equal(badges.length, 4, "每行应有一个库徽标");
  assert.ok(badges.every((badge) => badge === FIXTURES.kbs.primary || badge === FIXTURES.kbs.target),
    `库徽标异常：${badges.join(" | ")}`);
  assert.equal(await page.getByText(FIXTURES.docs.c1.title, { exact: true }).count(), 0,
    "归档库里的资料不应出现在已删除资料列表");

  // 恢复 A1：行消失，甲库资料列表恢复 ready。
  const restoreRow = rows.filter({ hasText: FIXTURES.docs.a1.title });
  await restoreRow.locator('button[data-action="trash-doc-restore"]').click();
  await helpers.toast("已恢复");
  await poll(async () => (await rows.count()) === 3, { message: "恢复后已删除资料应剩 3 行" });
  assert.equal(await page.getByText(FIXTURES.docs.a1.title, { exact: true }).count(), 0,
    "恢复后回收站不应再出现 A1");

  await ctx.goto(`/kb/#/kb/${encodeURIComponent(FIXTURES.kbs.primary)}/docs`);
  await page.locator(".docs-table").waitFor();
  const restoredRow = page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.a1.title });
  await restoredRow.waitFor();
  const restoredText = normalize(await restoredRow.innerText());
  assert.ok(!restoredText.includes("已删除"), `A1 恢复后仍显示已删除：${restoredText}`);
  assert.ok(!restoredText.includes("失败"), `A1 恢复后误显示失败：${restoredText}`);
  const a1 = await ctx.api.doc(FIXTURES.kbs.primary, FIXTURES.docs.a1.id);
  assert.equal(a1.status, "ready", "A1 服务端状态应为 ready");
  assert.equal(a1.deleted, false, "A1 服务端不应处于删除状态");

  // 跨库批量彻底删除 A2（甲库）+ B1（乙库）：逐字输入「彻底删除 2 篇」。
  await openTrashDocs(ctx);
  for (const title of [FIXTURES.docs.a2.title, FIXTURES.docs.b1.title]) {
    await page.locator(".trash-doc-row").filter({ hasText: title })
      .locator('input[data-action="trash-doc-select"]').check();
  }
  const bulk = page.locator(".trash-bulk");
  await bulk.waitFor();
  assert.ok((await bulk.innerText()).includes("已选 2 篇"), "跨库选择应显示 2 篇");
  await bulk.locator('button[data-action="trash-docs-purge-selected"]').click();
  let modal = await ctx.helpers.modal();
  await modal.locator('input[name="confirm"]').fill("彻底删除 2 篇");
  await modal.locator('button[type="submit"]').click();
  await modal.waitFor({ state: "detached" });
  await poll(async () => {
    const rows = page.locator(".trash-doc-row");
    return (await rows.count()) === 1
      && (await rows.filter({ hasText: FIXTURES.docs.a2.title }).count()) === 0
      && (await rows.filter({ hasText: FIXTURES.docs.b1.title }).count()) === 0;
  }, { message: "跨库批量删除后应只剩 A4" });
  const a2Doc = await ctx.api.doc(FIXTURES.kbs.primary, FIXTURES.docs.a2.id).catch(() => null);
  assert.equal(a2Doc, null, "A2 应已被彻底删除");
  const b1Doc = await ctx.api.doc(FIXTURES.kbs.target, FIXTURES.docs.b1.id).catch(() => null);
  assert.equal(b1Doc, null, "B1 应已被彻底删除");

  // 详情页「已删除」筛选 → 清空本库已删除资料（A4）。
  await ctx.goto(`/kb/#/kb/${encodeURIComponent(FIXTURES.kbs.primary)}/docs`);
  await page.locator(".docs-table").waitFor();
  await page.locator('button[data-docs-status="deleted"]').click();
  await poll(async () => (await page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.a4.title }).count()) === 1, {
    message: "已删除筛选应显示 A4",
  });
  await page.locator('button[data-action="docs-purge-all"]').click();
  modal = await ctx.helpers.modal();
  await modal.locator('input[name="confirm"]').fill(FIXTURES.kbs.primary);
  await modal.locator('button[type="submit"]').click();
  await modal.waitFor({ state: "detached" });
  await poll(async () => (await page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.a4.title }).count()) === 0, {
    message: "清空后 A4 不应再出现",
  });
  await page.getByText("没有已删除的资料").waitFor();

  const finalTrash = await ctx.api.trashDocs();
  assert.equal(Number(finalTrash.total), 0, `回收站应已清空，实际剩 ${finalTrash.total} 篇`);
}
