/**
 * 工作台深链：?kb=&doc=&page= 打开预览并定位页码；越界/缺页/缺失降级。
 */
import assert from "node:assert/strict";
import { poll } from "../ui.mjs";
import { FIXTURES } from "../seed.mjs";

export const name = "深链预览：?doc=&page= 定位与降级";

async function srcOf(frame) {
  return (await frame.getAttribute("src")) ?? "";
}

export async function run(ctx) {
  const kb = FIXTURES.kbs.primary;
  const doc = FIXTURES.docs.pdf;

  let page = await ctx.goto(`/kb/?kb=${encodeURIComponent(kb)}&doc=${doc.id}&page=1`);
  await page.locator(".preview-modal").waitFor();
  let frame = page.locator(".preview-modal iframe");
  await frame.waitFor();
  assert.match(await srcOf(frame), /page=1/, "PDF iframe 应带页码 fragment");
  await page.locator(".preview-modal [data-close]").click();
  await page.locator(".preview-modal").waitFor({ state: "detached" });

  page = await ctx.goto(`/kb/?kb=${encodeURIComponent(kb)}&doc=${doc.id}&page=999`);
  await page.locator(".preview-modal").waitFor();
  frame = page.locator(".preview-modal iframe");
  await frame.waitFor();
  assert.match(await srcOf(frame), /page=1/, "超界页码应收敛到末页/第 1 页");
  await page.getByText(/页码超出范围/).first().waitFor();

  page = await ctx.goto(`/kb/?kb=${encodeURIComponent(kb)}&doc=${doc.id}`);
  await page.locator(".preview-modal").waitFor();
  frame = page.locator(".preview-modal iframe");
  await frame.waitFor();
  assert.doesNotMatch(await srcOf(frame), /page=/, "缺省页码不应追加 fragment");

  page = await ctx.goto(`/kb/?kb=${encodeURIComponent(kb)}&doc=missing-doc`);
  await poll(async () => (await page.locator("#toast").textContent() ?? "").includes("资料不存在"), {
    message: "缺失资料应 toast 降级",
  });
  assert.equal(await page.locator(".preview-modal").count(), 0);
}
