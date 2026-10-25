/**
 * 回收站搜索/排序：只读校验（不改变种子数据），确保筛选计数、空态与排序落到真实 DOM。
 */
import assert from "node:assert/strict";
import { poll } from "../ui.mjs";
import { FIXTURES } from "../seed.mjs";

export const name = "回收站：搜索、排序与筛选空态";

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export async function run(ctx) {
  const page = await ctx.goto("/kb/#/trash?tab=docs");
  await page.locator(".trash-tabs").waitFor();
  const rows = page.locator(".trash-doc-row");
  await poll(async () => (await rows.count()) === 4, { message: "等待 4 篇已删除资料" });

  // 默认按删除时间新→旧：B1（最早删除的反而在最后，见 seed 的 ago）。
  const firstDefault = normalize(await rows.first().innerText());
  assert.ok(firstDefault.includes(FIXTURES.docs.b1.title), `默认排序首行应为最近删除的 B1：${firstDefault}`);

  // 升序后首行应是最早删除的 A1。
  const sort = page.locator("[data-trash-sort]");
  await sort.selectOption("deleted_asc");
  await poll(async () => normalize(await rows.first().innerText()).includes(FIXTURES.docs.a1.title), {
    message: "按删除时间升序后首行应为 A1",
  });

  // 搜索库名/标题；清空搜索恢复 4 行。
  const search = page.locator("[data-trash-query]");
  await search.fill("乙库");
  await poll(async () => (await rows.count()) === 1 && normalize(await rows.first().innerText()).includes(FIXTURES.docs.b1.title), {
    message: "搜索「乙库」应只剩 B1",
  });

  await search.fill("不存在的资料");
  await page.getByText("没有匹配的已删除资料").waitFor();
  await page.locator('button[data-action="trash-docs-clear-query"]').click();
  await poll(async () => (await rows.count()) === 4, { message: "清除搜索后应恢复 4 行" });
  assert.ok(normalize(await rows.first().innerText()).includes(FIXTURES.docs.a1.title), "清除搜索后仍保持升序");

  // 跨库批量删除的选择条件在 UI 上应保持可用（真正删除由 trash 用例覆盖）。
  await rows.filter({ hasText: FIXTURES.docs.a4.title }).locator('input[data-action="trash-doc-select"]').check();
  await rows.filter({ hasText: FIXTURES.docs.b1.title }).locator('input[data-action="trash-doc-select"]').check();
  const bulk = page.locator(".trash-bulk");
  await bulk.waitFor();
  assert.equal(await bulk.locator('button[data-action="trash-docs-purge-selected"]').isDisabled(), false,
    "跨库批量彻底删除按钮应可用");
  assert.ok((await bulk.innerText()).includes("已选 2 篇"), "批量条应显示跨库选择数");
}
