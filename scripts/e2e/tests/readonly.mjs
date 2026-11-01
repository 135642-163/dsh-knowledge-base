/** 只读共享：库标记、UI 写入口禁用、读取/检索可用、可关闭。 */
import assert from "node:assert/strict";
import { poll } from "../ui.mjs";
import { FIXTURES } from "../seed.mjs";

export const name = "只读共享：标记/写入口/关闭";

export async function run(ctx) {
  const kb = FIXTURES.kbs.primary;
  await ctx.api.request("PATCH", `/kbs/${encodeURIComponent(kb)}`, { readOnly: true });
  const page = await ctx.goto(`/kb/#/kb/${encodeURIComponent(kb)}/docs`);
  await page.locator(".badge.warn", { hasText: "只读共享" }).waitFor();
  const upload = page.locator('[data-action="upload"]').first();
  assert.equal(await upload.isDisabled(), true, "只读库的上传按钮应禁用");
  const docs = await ctx.api.docs(kb, { limit: 20 });
  assert.ok(docs.docs.length > 0, "只读库仍可读取资料");
  const deleteResult = await ctx.api.request("POST", `/kbs/${encodeURIComponent(kb)}/docs/${encodeURIComponent(docs.docs[0].id)}/delete`, {}).then(
    () => "ok",
    (error) => error.status
  );
  assert.equal(deleteResult, 409, "只读库删除应返回 409");

  await ctx.api.request("PATCH", `/kbs/${encodeURIComponent(kb)}`, { readOnly: false });
  await page.reload();
  await page.locator('[data-action="upload"]').first().waitFor();
  await poll(async () => (await page.locator(".badge.warn", { hasText: "只读共享" }).count()) === 0, {
    message: "关闭只读后不应再显示只读徽标",
  });
}
