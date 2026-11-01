/**
 * 0.38 数据目录：工作台弹窗显示当前生效的知识库根目录。
 * 只读验证（不保存），避免改到运行 E2E 的本机 DSH_HOME。
 */
import assert from "node:assert/strict";

export const name = "数据目录：弹窗显示当前根目录";

export async function run(ctx) {
  const page = await ctx.goto("/kb/#/");
  await page.locator(".side-foot [data-action=kbroot-settings]").click();
  await page.locator(".kbroot-settings h2").waitFor();
  const current = await page.locator(".kbroot-current").textContent();
  assert.match(current, /当前生效：/, "应显示当前生效目录");
  assert.ok(current.includes(ctx.kbRoot), `应包含本次 E2E 根目录 ${ctx.kbRoot}，实际：${current}`);
  await page.locator(".overlay [data-close]").click();
}
