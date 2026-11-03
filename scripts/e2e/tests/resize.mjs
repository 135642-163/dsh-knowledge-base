/**
 * 弹窗拖拽调大小：拖外框不触发「点外部关闭」，尺寸写进 localStorage、
 * 关掉重开后恢复。覆盖宿主里的工作台弹窗与 /kb/ 里的原件预览弹窗。
 *
 * 这里的核心断言是「拖完弹窗还开着」——如果把手的事件冒泡到遮罩，或者
 * 松手后的 click 落到遮罩上，弹窗会当场消失，后续断言全部拿不到元素。
 */
import assert from "node:assert/strict";
import { FIXTURES } from "../seed.mjs";

export const name = "弹窗拖拽调大小：拖边框不关闭、尺寸记忆";

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

async function dismissBetaNotice(page) {
  const button = page.getByRole("button", { name: "继续", exact: true });
  if ((await button.count()) > 0 && (await button.first().isVisible().catch(() => false))) {
    await button.first().click();
    await page.waitForTimeout(200);
  }
}

/** 按住指定方向的把手拖 dx/dy；真鼠标事件才会走 pointer capture 那条路径。 */
async function dragHandle(page, dir, dx, dy) {
  const handle = page.locator(`.kb-resize-handle[data-dir="${dir}"]`).first();
  const box = await handle.boundingBox();
  assert.ok(box, `${dir} 方向的把手应该挂在遮罩上`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** 拖右边收窄 → 弹窗仍开着 → 尺寸写进 localStorage。返回拖完的矩形。 */
async function assertResizable(page, dialog, storageKey, checkLayout = null) {
  assert.equal(await page.locator(".kb-resize-handle").count(), 8, "八向把手应挂在遮罩上");
  const before = await dialog.boundingBox();
  assert.ok(before && before.width > 200, `弹窗应有正常尺寸：${JSON.stringify(before)}`);

  await dragHandle(page, "e", -140, 0);

  assert.equal(await dialog.count(), 1, "拖拽不应触发「点外部关闭」");
  const after = await dialog.boundingBox();
  assert.ok(after, "拖完弹窗应仍然可见");
  assert.ok(after.width <= before.width - 120, `拖右边应明显收窄：${before.width} -> ${after.width}`);
  assert.ok(Math.abs(after.x - before.x) <= 2, `拖右边时左边不应移动：${before.x} -> ${after.x}`);
  assert.ok(Math.abs(after.y - before.y) <= 2, "拖右边时上边不应移动");

  const stored = await page.evaluate((key) => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  }, `dsh-kb:size:${storageKey}`);
  assert.ok(stored, `尺寸应写入 localStorage：${storageKey}`);
  assert.ok(Math.abs(stored.width - after.width) <= 4, `记忆宽度应等于拖完的宽度：${stored.width} vs ${after.width}`);

  if (checkLayout) await checkLayout(dialog, after);

  // 拖完再点遮罩：关闭行为必须还在（把手不能把遮罩的点击全吃掉）。
  await page.mouse.click(Math.max(8, after.x - 40), after.y + after.height / 2);
  await dialog.waitFor({ state: "detached", timeout: 5_000 });
  return after;
}

export async function run(ctx) {
  const page = await ctx.goto("/");
  await page.waitForTimeout(1200);
  await dismissBetaNotice(page);

  // 1) 宿主里的知识库工作台弹窗（侧栏入口由 slot 注入；没注入就只测 /kb/ 内的预览）。
  const entry = page.locator(".dsh-kb-entry").first();
  if ((await entry.count()) > 0) {
    await entry.click();
    const workbench = page.locator(".dsh-kb-modal");
    await workbench.waitFor({ state: "visible", timeout: 20_000 });
    assert.match(normalize(await workbench.locator(".dsh-kb-modal-head").innerText()), /知识库工作台/);
    const sized = await assertResizable(page, workbench, "workbench");

    // 重新打开：按记忆尺寸恢复（工作台默认 1180 宽，缩过之后应明显更窄）。
    await entry.click();
    await workbench.waitFor({ state: "visible", timeout: 20_000 });
    const reopened = await workbench.boundingBox();
    assert.ok(Math.abs(reopened.width - sized.width) <= 4, `重开应恢复记忆宽度：${reopened.width} vs ${sized.width}`);
    await page.keyboard.press("Escape");
    await workbench.waitFor({ state: "detached", timeout: 5_000 });
  }

  // 2) /kb/ 工作台里的「查看原件」预览弹窗。
  const kb = encodeURIComponent(FIXTURES.kbs.primary);
  await ctx.goto(`/kb/#/kb/${kb}/docs`);
  await page.locator(".docs-table").waitFor();
  const row = page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.pdf.title });
  await row.locator('button[data-action="open-doc"]').click();
  const docModal = page.locator(".overlay .modal").last();
  await docModal.waitFor();
  await docModal.locator("button[data-preview]").click();

  const preview = page.locator(".overlay .modal.preview-modal");
  await preview.waitFor();
  const sized = await assertResizable(page, preview, "preview", async (dialog) => {
    const layout = await dialog.evaluate((node) => {
      const body = node.querySelector(".preview-body");
      return { client: node.clientHeight, scroll: node.scrollHeight, body: body?.clientHeight ?? 0 };
    });
    assert.ok(layout.body > 150, `预览正文应跟随弹窗高度伸缩：${JSON.stringify(layout)}`);
    assert.ok(layout.scroll <= layout.client + 2, `调整尺寸后弹窗内不应溢出：${JSON.stringify(layout)}`);
  });

  await docModal.locator("button[data-preview]").click();
  const reopened = page.locator(".overlay .modal.preview-modal");
  await reopened.waitFor();
  const reopenedBox = await reopened.boundingBox();
  assert.ok(Math.abs(reopenedBox.width - sized.width) <= 4, `预览重开应恢复记忆宽度：${reopenedBox.width} vs ${sized.width}`);
  await reopened.locator("button[data-close]").click();
  await reopened.waitFor({ state: "detached" });
  await docModal.locator("button[data-close]").click();
  await docModal.waitFor({ state: "detached" });
}
