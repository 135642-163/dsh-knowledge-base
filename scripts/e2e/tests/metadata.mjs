/**
 * 资料编目：弹窗改摘要/标签 → 列表标签筛选 → 服务端 summarySource=manual。
 */
import assert from "node:assert/strict";
import { poll } from "../ui.mjs";
import { FIXTURES } from "../seed.mjs";

export const name = "资料编目：名称/摘要/标签编辑与标签筛选";

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export async function run(ctx) {
  const kb = FIXTURES.kbs.primary;
  const title = FIXTURES.docs.pdf.title;
  const nextTitle = "E2E 预览资料（人工名）";
  const page = await ctx.goto(`/kb/#/kb/${encodeURIComponent(kb)}/docs`);
  await page.locator(".docs-table").waitFor();

  const row = page.locator("tr.doc-row").filter({ hasText: title });
  await row.waitFor();
  await row.locator("button[data-action='open-doc']").click();
  const modal = await ctx.helpers.modal();
  const titleInput = modal.locator('[name="doc-title"]');
  const summary = modal.locator('[name="doc-summary"]');
  const tags = modal.locator('[name="doc-tags"]');
  await titleInput.waitFor();
  await titleInput.fill(nextTitle);
  await summary.fill("E2E 人工摘要：预览资料");
  await tags.fill("并网, 验收标签");
  const save = modal.locator("[data-save-meta]");
  await poll(async () => !(await save.isDisabled()), { message: "填写后保存按钮应启用" });
  await save.click();
  await ctx.helpers.toast("已保存名称/摘要/标签");
  await modal.locator("[data-close]").click();
  await modal.waitFor({ state: "detached" });

  const doc = await ctx.api.doc(kb, FIXTURES.docs.pdf.id);
  assert.equal(doc.title, nextTitle);
  assert.equal(doc.summary, "E2E 人工摘要：预览资料");
  assert.equal(doc.summarySource, "manual");
  assert.deepEqual(doc.tags, ["并网", "验收标签"]);

  const updatedRow = page.locator("tr.doc-row").filter({ hasText: nextTitle });
  await poll(async () => {
    const text = normalize(await updatedRow.innerText());
    return text.includes("并网") && text.includes("验收标签");
  }, { message: "列表行应显示新名称与新标签" });

  const select = page.locator("[data-docs-tag]");
  await select.waitFor();
  await select.selectOption("并网");
  await poll(async () => {
    const rows = page.locator("tr.doc-row");
    return (await rows.count()) === 1 && (await rows.first().innerText()).includes(nextTitle);
  }, { message: "按并网标签筛选应只剩资料一" });
  assert.equal(await page.locator(".docs-tag-active").count(), 1);

  // 搜索与标签共存：搜到不匹配的词时保留标签 chip 与清除入口。
  await page.locator("[data-docs-query]").fill("不存在的词");
  await page.locator("[data-docs-query]").press("Enter");
  await page.getByText("没有匹配的资料").waitFor();
  assert.equal(await page.locator(".docs-tag-active").count(), 1);
  await page.locator(".docs-tag-active").click();
  await page.getByText("没有匹配的资料").waitFor();
}
