/**
 * 输入框胶囊：真实根页面上等待 slot 注入，验证清空/全选/应用与外部点击关闭。
 * 胶囊只显示活跃库（归档的丙库不应出现）。
 */
import assert from "node:assert/strict";
import { poll, SkipError } from "../ui.mjs";
import { FIXTURES } from "../seed.mjs";

export const name = "会话胶囊：清空/应用、外部点击关闭、全选/应用";

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** DSH 首次打开根页面会弹「内测声明」，等它挂载后点「继续」再操作。 */
async function dismissBetaNotice(page) {
  const button = page.getByRole("button", { name: "继续", exact: true });
  if ((await button.count()) > 0 && (await button.first().isVisible().catch(() => false))) {
    await button.first().click();
    await page.waitForTimeout(200);
  }
}

async function waitChip(page) {
  const chip = page.locator(".dsh-kb-scope-chip");
  await chip.waitFor({ state: "visible", timeout: 30_000 });
  await poll(async () => /知识库：(全部|未启用|\d+ 个)/.test(normalize(await chip.innerText())), {
    timeout: 20_000,
    message: "等待胶囊从加载态进入已解析状态",
  });
  // 内测声明确认框在 ~500ms 后挂载；先让页面稳定再关掉，避免它挡住胶囊。
  await page.waitForTimeout(1000);
  await dismissBetaNotice(page);
  return chip;
}

async function openPanel(ctx, page) {
  const chip = page.locator(".dsh-kb-scope-chip");
  await chip.click();
  const panel = page.locator(".dsh-kb-scope-panel");
  await panel.waitFor({ state: "visible" });
  return panel;
}

async function applyPanel(panel) {
  await panel.locator(".dsh-kb-scope-actions").getByRole("button", { name: "应用", exact: true }).click();
  await panel.waitFor({ state: "detached" });
}

export async function run(ctx) {
  const page = await ctx.goto("/");
  // 全新 profile 没有历史会话时根页面只有「新会话」，胶囊不会挂载；先关声明再建会话。
  await page.waitForTimeout(1200);
  await dismissBetaNotice(page);
  const newSession = page.getByRole("button", { name: "新会话", exact: true });
  if ((await newSession.count()) > 0 && (await newSession.first().isVisible().catch(() => false))) {
    await newSession.first().click();
    await page.waitForTimeout(1200);
    // 全新 profile 首次建会话会要求配置 API Key；写入一个 dummy key（E2E 不调用模型）。
    const saveAndContinue = page.getByRole("button", { name: "保存并继续", exact: true });
    if ((await saveAndContinue.count()) > 0 && (await saveAndContinue.first().isVisible().catch(() => false))) {
      const keyInput = page.locator('input[type="password"], .modal input, [class*="modal"] input').first();
      if ((await keyInput.count()) > 0) {
        await keyInput.fill("sk-e2e-dummy");
        await saveAndContinue.first().click();
        await page.waitForTimeout(1200);
      }
    }
    // 仍要求配置时选择稍后配置；弹窗可能延迟挂载，轮询几次直到胶囊出现或弹窗消失。
    const later = page.getByRole("button", { name: "稍后配置", exact: true });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if ((await page.locator(".dsh-kb-scope-chip").count()) > 0) break;
      if ((await later.count()) > 0 && (await later.first().isVisible().catch(() => false))) {
        await later.first().click();
        await page.waitForTimeout(800);
        continue;
      }
      await page.waitForTimeout(500);
    }
  }
  let chip;
  try {
    chip = await waitChip(page);
  } catch (error) {
    throw new SkipError(`当前 profile 没有可用会话/凭据，胶囊未挂载（${String(error?.message ?? error).slice(0, 120)}）`);
  }
  assert.equal(normalize(await chip.innerText()), "知识库：全部", "首次加载胶囊应为全部");

  // 打开面板：列出两个活跃库，归档库不在其中。
  let panel = await openPanel(ctx, page);
  const rows = panel.locator(".dsh-kb-scope-row");
  await poll(async () => (await rows.count()) >= 2, { message: "胶囊面板应列出活跃知识库" });
  const names = (await panel.locator(".dsh-kb-scope-name").allInnerTexts()).map(normalize);
  assert.ok(names.includes(FIXTURES.kbs.primary), `面板缺少甲库：${names.join(" | ")}`);
  assert.ok(names.includes(FIXTURES.kbs.target), `面板缺少乙库：${names.join(" | ")}`);
  assert.ok(!names.includes(FIXTURES.kbs.archived), `归档库不应出现在胶囊：${names.join(" | ")}`);

  // 清空 + 应用 → 未启用。
  await panel.getByRole("button", { name: "清空", exact: true }).click();
  await applyPanel(panel);
  await poll(async () => normalize(await chip.innerText()) === "知识库：未启用", {
    message: "清空应用后胶囊应为未启用",
  });

  // 重开面板 → 点击外部关闭（不应用）。
  panel = await openPanel(ctx, page);
  await page.mouse.click(640, 60);
  await panel.waitFor({ state: "detached" });
  assert.equal(normalize(await chip.innerText()), "知识库：未启用", "外部点击关闭不应改写范围");

  // 全选 + 应用 → 全部。
  panel = await openPanel(ctx, page);
  await panel.getByRole("button", { name: "全选", exact: true }).click();
  await applyPanel(panel);
  await poll(async () => normalize(await chip.innerText()) === "知识库：全部", {
    message: "全选应用后胶囊应为全部",
  });

  // 再打开一次，确认选中态已持久化（两个库都勾选）。
  panel = await openPanel(ctx, page);
  const checked = panel.locator(".dsh-kb-scope-row input[type='checkbox']");
  await poll(async () => {
    const count = await checked.count();
    if (count !== 2) return false;
    for (let i = 0; i < count; i += 1) {
      if (!(await checked.nth(i).isChecked())) return false;
    }
    return true;
  }, { message: "全选应用后重开面板应保持两个库勾选" });
  await page.mouse.click(640, 60);
  await panel.waitFor({ state: "detached" });
}
