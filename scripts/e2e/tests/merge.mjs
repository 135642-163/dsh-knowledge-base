/**
 * 本地库合并：预览 → 后台任务 → 目标/源库状态 → 撤销。
 * 使用 seed 的甲库/乙库（本用例固定放最后），避免另建空库再上传的慢路径。
 */
import assert from "node:assert/strict";
import { poll } from "../ui.mjs";
import { FIXTURES } from "../seed.mjs";

export const name = "合并：预览/执行/撤销";

export async function run(ctx) {
  const a = FIXTURES.kbs.primary;
  const b = FIXTURES.kbs.target;
  const target = `合并目标E2E-${Date.now().toString(16).slice(-6)}`;

  const page = await ctx.goto("/kb/#/");
  await page.locator(".overview").waitFor();
  await page.locator('[data-action="merge-kb"]').click();
  const modal = await ctx.helpers.modal();
  await modal.getByText("合并知识库").waitFor();
  await modal.locator(`input[name="source"][value="${a}"]`).check();
  await modal.locator(`input[name="source"][value="${b}"]`).check();
  await modal.locator('select[name="targetMode"]').selectOption("new");
  await modal.locator('input[name="targetName"]').fill(target);
  await modal.locator("[data-preview-btn]").click();
  await modal.locator("[data-preview]").waitFor({ state: "visible" });
  assert.match(await modal.locator("[data-preview]").innerText(), /将移动/, "预览应显示移动数量");
  const submit = modal.locator('button[type="submit"]');
  await poll(async () => submit.isEnabled().catch(() => false), { message: "预览后确认按钮应启用" });
  await submit.click();
  await modal.locator("[data-undo]").waitFor({ timeout: 60_000 });
  assert.match(await modal.innerText(), /已合并到/, "应显示合并结果");
  const targetDocs = await ctx.api.docs(target, { limit: 200 });
  assert.ok(targetDocs.docs.length > 0, "目标库应有文档");
  const sourceA = await ctx.api.kb(a);
  assert.equal(sourceA.kb.mergedInto, target, "源库应标记 mergedInto");

  await modal.locator("[data-undo]").click();
  await modal.waitFor({ state: "detached", timeout: 60_000 });
  await poll(async () => (await ctx.api.docs(target, { limit: 200 })).docs.length === 0, {
    message: "撤销后目标库应为空",
  });
  assert.ok((await ctx.api.docs(a, { limit: 200 })).docs.length > 0, "撤销后源库应恢复文档");
  assert.equal((await ctx.api.kb(a)).kb.mergedInto, null, "撤销后源库不应再是 mergedInto");
}
