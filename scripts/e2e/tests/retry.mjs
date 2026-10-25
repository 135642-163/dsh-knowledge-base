/**
 * 失败资料重试：行上先看到「失败/重试」，打开详情能读到错误原因；
 * 点重试后启动 kb-reparse 任务，UI 轮询直到 ready 且错误清空。
 */
import assert from "node:assert/strict";
import { poll } from "../ui.mjs";
import { FIXTURES } from "../seed.mjs";

export const name = "失败资料重试：错误可见 → 重试 → ready";

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export async function run(ctx) {
  const page = await ctx.goto(`/kb/#/kb/${encodeURIComponent(FIXTURES.kbs.primary)}/docs`);
  await page.locator(".docs-table").waitFor();
  const row = page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.failed.title });
  await row.waitFor();

  // 重试前：行上失败徽标 + 重试按钮。
  assert.equal(await row.locator(".badge.warn").count(), 1, "失败行应有「失败」徽标");
  assert.equal(normalize(await row.locator(".badge.warn").innerText()), "失败");
  assert.equal(await row.locator('button[data-action="docs-retry"]').count(), 1, "失败行应有重试按钮");

  // 打开资料详情，错误原因在重试前可见。
  await row.locator('button[data-action="open-doc"]').click();
  let modal = page.locator(".overlay .modal").last();
  await modal.waitFor();
  const errorBox = modal.locator(".doc-error-text");
  await errorBox.waitFor();
  const errorText = normalize(await errorBox.innerText());
  assert.ok(errorText.includes(FIXTURES.errorText), `详情错误文本不符：${errorText}`);
  await modal.locator('button[data-close]').click();
  await modal.waitFor({ state: "detached" });

  // 点击行内重试。
  await row.locator('button[data-action="docs-retry"]').click();
  await poll(async () => {
    const retryText = normalize(await row.locator('button[data-action="docs-retry"]').innerText().catch(() => ""));
    return retryText.includes("重试中")
      || (await row.locator(".badge.warn").count()) === 0;
  }, { timeout: 15_000, message: "点击重试后行应进入重试中/成功态" });

  // 轮询：UI 行回到 ready（无失败徽标、无重试按钮），服务端 error 清空。
  await poll(async () => {
    if ((await row.locator(".badge.warn").count()) !== 0) return false;
    if ((await row.locator('button[data-action="docs-retry"]').count()) !== 0) return false;
    const doc = await ctx.api.doc(FIXTURES.kbs.primary, FIXTURES.docs.failed.id);
    return doc.status === "ready" && doc.error === "";
  }, { timeout: 60_000, interval: 500, message: "重试后资料应变为 ready 且错误清空" });

  const doc = await ctx.api.doc(FIXTURES.kbs.primary, FIXTURES.docs.failed.id);
  assert.equal(doc.status, "ready");
  assert.equal(doc.error, "");
  assert.equal(await row.locator(".badge.warn").count(), 0, "成功后不应再有失败徽标");
  assert.equal(await row.locator('button[data-action="docs-retry"]').count(), 0, "成功后不应再有重试按钮");

  // 重试写入的正文应可读（说明确实重新解析成功，而不是只改了状态）。
  const content = await ctx.api.docContent(FIXTURES.kbs.primary, FIXTURES.docs.failed.id);
  assert.ok(String(content.markdown ?? "").includes("失败资料五的原始文本"),
    "重试后正文应包含原始 txt 内容");
}
