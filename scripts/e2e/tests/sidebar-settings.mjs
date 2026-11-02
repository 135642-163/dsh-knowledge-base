/**
 * 侧栏整理：新建知识库改为搜索框左侧图标；检索设置/数据目录收进同一个「设置」菜单。
 * 同时验证菜单方向、键盘关闭和顶部入口一致性。
 */
import assert from "node:assert/strict";

export const name = "侧栏整理：新建图标与设置菜单";

export async function run(ctx) {
  const page = await ctx.goto("/kb/#/");
  const plus = page.locator(".side-search [data-action=create-kb]");
  await plus.waitFor();
  assert.equal(await plus.getAttribute("aria-label"), "新建知识库");
  assert.equal(await page.locator(".side-foot [data-action=create-kb]").count(), 0, "底栏不再保留新建按钮");
  assert.equal(await page.locator(".side-foot [data-action=semantic-settings]").count(), 0, "检索设置应收进设置菜单");
  assert.equal(await page.locator(".side-foot [data-action=kbroot-settings]").count(), 0, "数据目录应收进设置菜单");

  const trigger = page.locator(".side-foot [data-action=settings-menu]");
  await trigger.click();
  const menu = page.locator(".settings-menu");
  await menu.waitFor();
  assert.equal(await menu.locator("[role=menuitem]").count(), 2);
  assert.match(await menu.innerText(), /检索设置/);
  assert.match(await menu.innerText(), /数据目录/);
  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  assert.ok(triggerBox && menuBox);
  assert.ok(
    menuBox.y + menuBox.height <= triggerBox.y + 1,
    `菜单应在设置按钮上方：按钮 y=${triggerBox.y}，菜单底 y=${menuBox.y + menuBox.height}`,
  );
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");

  // Esc 关闭菜单并把焦点还给触发按钮。
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "数据目录");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-id")), "sidebar");

  // 顶部「设置」复用同一个菜单：空间足够时向下弹。
  const topTrigger = page.locator(".topbar [data-action=settings-menu]");
  await topTrigger.click();
  await page.locator(".settings-menu").waitFor();
  assert.equal(await page.locator(".settings-menu").getAttribute("data-side"), "down");
  await page.locator(".settings-menu [data-action=kbroot-settings]").click();
  await page.locator(".kbroot-settings h2").waitFor();
  assert.equal(await page.locator(".settings-menu").count(), 0, "选择菜单项后菜单应立即关闭");
  await page.locator(".overlay [data-close]").click();
  await page.locator(".overlay").waitFor({ state: "detached" });

  // 新建图标仍打开原来的创建弹窗。
  await plus.click();
  await page.locator(".overlay .modal-form h2").waitFor();
  assert.match(await page.locator(".overlay .modal-form h2").innerText(), /新建知识库/);
  await page.locator(".overlay [data-close]").click();
  await page.locator(".overlay").waitFor({ state: "detached" });

  // 点菜单外关闭。
  await trigger.click();
  await page.locator(".settings-menu").waitFor();
  await page.locator(".main h1").click();
  await page.locator(".settings-menu").waitFor({ state: "detached" });
}
