/**
 * 原件预览：PDF 内嵌 iframe 与笔记 tab 的正文预览（硬断言）。
 * Office 预览是可选用例，见 preview-office.mjs。
 */
import assert from "node:assert/strict";
import { FIXTURES } from "../seed.mjs";

export const name = "原件预览：PDF iframe 与笔记正文";

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

async function openPreviewFromDocList(ctx, title) {
  const page = ctx.page;
  const row = page.locator("tr.doc-row").filter({ hasText: title });
  await row.locator('button[data-action="open-doc"]').click();
  const docModal = page.locator(".overlay .modal").last();
  await docModal.waitFor();
  await docModal.locator('button[data-preview]').click();
  const preview = page.locator(".overlay .modal.preview-modal");
  await preview.waitFor();
  return { docModal, preview };
}

async function closePreview(page, preview, docModal) {
  await preview.locator('button[data-close]').click();
  await preview.waitFor({ state: "detached" });
  if (await docModal.count()) {
    await docModal.locator('button[data-close]').click().catch(() => {});
    await docModal.waitFor({ state: "detached" }).catch(() => {});
  }
}

export async function run(ctx) {
  const page = await ctx.goto(`/kb/#/kb/${encodeURIComponent(FIXTURES.kbs.primary)}/docs`);
  await page.locator(".docs-table").waitFor();

  // 1) PDF：查看原件 → iframe 可见，src 走 inline source。
  const pdf = await openPreviewFromDocList(ctx, FIXTURES.docs.pdf.title);
  const frame = pdf.preview.locator("iframe.preview-frame");
  await frame.waitFor({ state: "visible", timeout: 20_000 });
  const src = await frame.getAttribute("src");
  assert.ok(src && src.includes(`/docs/${FIXTURES.docs.pdf.id}/source?inline=1`),
    `PDF iframe src 应为 inline source：${src}`);
  assert.equal(await pdf.preview.locator(".preview-text").count(), 0, "PDF 不应渲染成文本预览");
  await closePreview(page, pdf.preview, pdf.docModal);

  // 2) 笔记 tab：列表显示种子笔记与摘要，点开后正文 preview-text 可读。
  await ctx.goto(`/kb/#/kb/${encodeURIComponent(FIXTURES.kbs.primary)}/notes`);
  await page.locator(".notes-table").waitFor();
  const noteRow = page.locator(".notes-table tr").filter({ hasText: FIXTURES.docs.note.title });
  await noteRow.waitFor();
  const noteRowText = normalize(await noteRow.innerText());
  assert.ok(noteRowText.includes(FIXTURES.docs.note.title), `笔记列表缺少标题：${noteRowText}`);
  assert.ok(noteRowText.includes("验收笔记摘要"), `笔记列表缺少摘要：${noteRowText}`);
  await noteRow.locator('button[data-action="open-note"]').click();
  const notePreview = page.locator(".overlay .modal.preview-modal");
  await notePreview.waitFor();
  const previewText = notePreview.locator("pre.preview-text");
  await previewText.waitFor();
  const body = normalize(await previewText.innerText());
  assert.ok(body.includes(FIXTURES.noteBody), `笔记预览正文不符：${body.slice(0, 200)}`);
  await notePreview.locator('button[data-close]').click();
  await notePreview.waitFor({ state: "detached" });
}
