/**
 * 上传弹窗：上传≠解析；逐文件状态与重复跳过文案。
 */
import assert from "node:assert/strict";
import { poll } from "../ui.mjs";
import { FIXTURES } from "../seed.mjs";

export const name = "上传：解析进度/完成/重复跳过不误报";

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

async function startUpload(ctx, page, { name, body }) {
  await page.locator("[data-action='upload']").click();
  const modal = await ctx.helpers.modal();
  const chooserPromise = page.waitForEvent("filechooser");
  await modal.locator('[data-pick="files"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(body) });
  const start = modal.locator("[data-start]");
  await poll(async () => !(await start.isDisabled()), { message: "选择文件后开始上传应启用" });
  await start.click();
  return modal;
}

export async function run(ctx) {
  const kb = FIXTURES.kbs.primary;
  const page = await ctx.goto(`/kb/#/kb/${encodeURIComponent(kb)}/docs`);
  await page.locator(".docs-table").waitFor();

  const body = "上传验收资料的正文，用于验证解析状态。\n";
  let modal = await startUpload(ctx, page, { name: "上传验收资料.md", body });
  await poll(async () => /解析完成|上传失败|没有新资料/.test(normalize(await modal.innerText())), {
    timeout: 30_000,
    message: "等待上传/解析结算",
  });
  const finalText = normalize(await modal.innerText());
  assert.match(finalText, /解析完成/, `应显示解析完成：${finalText}`);
  assert.doesNotMatch(finalText, /已上传，待解析/, "完成页不应停在待解析");
  assert.doesNotMatch(finalText, /上传中（文件尚未解析）/, "完成页不应停在未解析");
  await modal.locator("[data-close]").click();
  await poll(async () => (await page.locator("tr.doc-row").filter({ hasText: "上传验收资料" }).count()) === 1, {
    timeout: 15_000,
    message: "上传完成后资料列表应出现新文档",
  });

  // 再传一次同标题/同内容：应明确显示“没有新资料”，而不是“解析完成”。
  modal = await startUpload(ctx, page, { name: "上传验收资料副本.md", body });
  await poll(async () => /没有新资料|解析完成|上传失败/.test(normalize(await modal.innerText())), {
    timeout: 30_000,
    message: "等待重复上传结算",
  });
  const dupText = normalize(await modal.innerText());
  assert.match(dupText, /没有新资料|重复/, `重复上传应显示重复跳过：${dupText}`);
  assert.doesNotMatch(dupText, /解析完成/, "全部重复不应显示解析完成");
  await modal.locator("[data-close]").click();

  const docs = await ctx.api.docs(kb, { query: "上传验收资料", limit: 10 });
  assert.ok(docs.docs.length >= 1);
}
