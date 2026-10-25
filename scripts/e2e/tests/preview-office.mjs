/**
 * Office 预览（可选）：docx 夹具或 LibreOfficeKit 缺失时明确 skip。
 * 引擎可用时走「查看原件」→ preview.pdf iframe，并断言没有转换错误。
 */
import assert from "node:assert/strict";
import { FIXTURES } from "../seed.mjs";

export const name = "原件预览：Office docx（可选）";

export async function run(ctx) {
  if (!ctx.office) {
    ctx.skip("docx 夹具生成失败（python-docx/JSZip 均不可用），跳过 Office 预览");
  }
  const officeStatus = await ctx.api.officeStatus();
  if (officeStatus?.available !== true) {
    ctx.skip(`Office 转换引擎不可用（available=${String(officeStatus?.available)}），跳过 Office 预览`);
  }

  // 先在 API 层确认转换真的产出 PDF（iframe 是错误页时父页面看不到）。
  const pdfResponse = await fetch(
    `${ctx.baseUrl}/kb/api/kbs/${encodeURIComponent(FIXTURES.kbs.primary)}/docs/${FIXTURES.docs.office.id}/preview.pdf`,
    { signal: AbortSignal.timeout(60_000) },
  );
  assert.equal(pdfResponse.status, 200, `preview.pdf 应返回 200，实际 ${pdfResponse.status}`);
  assert.match(String(pdfResponse.headers.get("content-type") ?? ""), /application\/pdf/);
  const head = Buffer.from(await pdfResponse.arrayBuffer()).subarray(0, 5).toString("latin1");
  assert.equal(head, "%PDF-", "preview.pdf 应以 %PDF- 开头");

  const page = await ctx.goto(`/kb/#/kb/${encodeURIComponent(FIXTURES.kbs.primary)}/docs`);
  await page.locator(".docs-table").waitFor();
  const row = page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.office.title });
  await row.locator('button[data-action="open-doc"]').click();
  const docModal = page.locator(".overlay .modal").last();
  await docModal.waitFor();
  await docModal.locator('button[data-preview]').click();
  const preview = page.locator(".overlay .modal.preview-modal");
  await preview.waitFor();
  const frame = preview.locator("iframe.preview-frame");
  await frame.waitFor({ state: "visible", timeout: 60_000 });
  const src = await frame.getAttribute("src");
  assert.ok(src && src.includes(`/docs/${FIXTURES.docs.office.id}/preview.pdf`),
    `Office iframe src 应走 preview.pdf：${src}`);
  assert.equal(await preview.locator(".form-error").count(), 0, "Office 预览不应显示转换错误");
  await preview.locator('button[data-close]').click();
  await preview.waitFor({ state: "detached" });
  await docModal.locator('button[data-close]').click();
  await docModal.waitFor({ state: "detached" });
}
