/**
 * 0.31.2 检索设置：语义开关的 API 与工作台「设置」弹窗。
 * 只验证开关往返与状态展示，不点「一键准备」（会下载 390MB）。
 */
import assert from "node:assert/strict";
import { poll } from "../ui.mjs";

export const name = "检索设置：语义开关与组件状态展示";

export async function run(ctx) {
  const initial = await ctx.api.request("GET", "/semantic");
  assert.equal(initial.enabled, false);
  assert.equal(typeof initial.ready, "boolean");
  assert.ok(Array.isArray(initial.dependencies?.missing));
  assert.ok(Array.isArray(initial.model?.missing));
  assert.equal(initial.preparing, false);

  const page = await ctx.goto("/kb/#/");
  await page.locator("[data-action=semantic-settings]").click();
  await page.getByText("检索设置").waitFor();
  const toggle = page.locator("[name=semantic-enabled]");
  await toggle.check();
  await poll(async () => (await ctx.api.request("GET", "/semantic")).enabled === true, {
    message: "勾选后开关应立即写入设置",
  });
  assert.match(await page.locator(".semantic-status").innerText(), /运行组件|模型/);

  await toggle.uncheck();
  await poll(async () => (await ctx.api.request("GET", "/semantic")).enabled === false, {
    message: "取消勾选后应关闭",
  });
  await page.locator(".overlay [data-close]").click();
}
