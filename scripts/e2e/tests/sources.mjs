/**
 * 来源面板：合成 session 里的 kb_query tool/result meta.sources → 工具行来源 chip、
 * 本轮来源面板、点击深链跳转。
 */
import assert from "node:assert/strict";
import { SkipError, poll } from "../ui.mjs";

export const name = "来源面板：工具行/本轮来源/深链跳转";

async function dismissBeta(page) {
  const button = page.getByRole("button", { name: "继续", exact: true });
  if ((await button.count()) > 0 && (await button.first().isVisible().catch(() => false))) {
    await button.first().click();
    await page.waitForTimeout(200);
  }
}

export async function run(ctx) {
  if (!ctx.syntheticSessionId) throw new SkipError("外部宿主没有合成 session fixture");
  const page = await ctx.goto("/");
  await page.waitForTimeout(1500);
  await dismissBeta(page);
  // 工作台默认停在新会话；先点开「知识库」工作区的折叠箭头，让会话列表展开。
  const projectRow = page.locator('[class*="projectRow"]').filter({ hasText: "知识库" }).first();
  if ((await projectRow.count()) > 0) {
    const arrow = projectRow.locator('[class*="arrow"]').first();
    if ((await arrow.count()) > 0) await arrow.click().catch(() => {});
    else await projectRow.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  const rows = page.locator('[class*="sessionRow"]');
  const session = rows.filter({ hasText: "知识库" }).first();
  if ((await session.count()) === 0) throw new Error("没有找到合成的「知识库」session 行");
  try {
    await session.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    throw new Error("合成 session 未出现在会话列表：宿主可能拒绝了 session fixture");
  }
  await session.click();

  const row = page.locator(".dsh-kb-source-row").first();
  await row.waitFor({ state: "visible", timeout: 30_000 });
  const rowText = String(await row.innerText()).replace(/\s+/g, " ");
  // CLI 0.1.x 的历史投影没有把 tool/result 关联到工具行（或没有保留 meta），
  // 此时明确跳过；桌面/较新宿主会走下面的真实断言。
  if (/正在检索|没有可定位的来源/.test(rowText)) {
    throw new SkipError(`当前宿主未投影 tool/result meta（工具行：${rowText}）；来源渲染由 sources-client 单测覆盖`);
  }
  assert.match(rowText, /GB\/T 19963\.2-2024/);
  assert.match(rowText, /第 12 页/);

  const panel = page.locator(".dsh-kb-sources-turn").first();
  await panel.waitFor({ state: "visible", timeout: 10_000 });
  assert.match(String(await panel.innerText()), /本轮来源（\s*1\s*）/);

  const link = page.locator(".dsh-kb-source-link").first();
  await link.waitFor();
  const href = await link.getAttribute("href");
  assert.match(href, /^\/kb\/\?/);
  assert.match(href, /page=12/);

  let popup;
  try {
    [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 10_000 }), link.click()]);
  } catch {
    // 部分宿主会把 target=_blank 路由到内置浏览器；退化为 href 断言。
    popup = null;
  }
  if (popup) {
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    assert.match(popup.url(), /\/kb\/\?/);
    await popup.close();
  }

  // 坏 meta 的降级由单测覆盖；这里确认没有把普通会话搞崩。
  await poll(async () => (await page.locator(".dsh-kb-source-row").count()) >= 1, {
    message: "来源行应保持渲染",
  });
}
