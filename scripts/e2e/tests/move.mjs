/**
 * 跨库移动全生命周期：
 * 移动 → 源库墓碑（撤销移动）→ 撤销 → 彻底删除撤销留下的目标副本
 * → 再次移动 → 目标副本软删除 → 回收站彻底删除目标副本
 * → 源库墓碑变为「恢复」→ 恢复并清 movedTo。
 *
 * 注：第二次移动前必须先清掉撤销留下的目标墓碑；否则 skip 模式会按同 ID 冲突跳过，
 * 这是 0.24.0 的既有语义，不是 E2E 特例。
 */
import assert from "node:assert/strict";
import { poll } from "../ui.mjs";
import { FIXTURES } from "../seed.mjs";

export const name = "跨库移动：移动/撤销/彻底删除目标副本/再次移动/墓碑恢复";

function normalize(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

async function openDocs(ctx, kb) {
  const page = await ctx.goto(`/kb/#/kb/${encodeURIComponent(kb)}/docs`);
  await page.locator(".docs-table").waitFor();
  return page;
}

async function setStatusFilter(page, status) {
  await page.locator(`button[data-docs-status="${status}"]`).click();
  await poll(async () => {
    const active = await page.locator("button[data-docs-status].active").getAttribute("data-docs-status");
    return (active ?? "") === status;
  }, { message: `切换资料筛选 ${status || "全部"}` });
}

async function moveDoc(ctx, title, target) {
  const page = ctx.page;
  await page.locator("tr.doc-row").filter({ hasText: title }).locator('input[data-action="docs-select"]').check();
  await page.locator('button[data-action="docs-move"]').click();
  const modal = page.locator(".overlay .modal.move-modal");
  await modal.waitFor();
  const select = modal.locator('select[name="target"]');
  await select.selectOption({ label: target });
  await modal.locator(".move-no-conflict").waitFor({ timeout: 20_000 });
  await modal.locator('input[name="ack"]').check();
  const submit = modal.locator('button[type="submit"]');
  await poll(async () => submit.isEnabled().catch(() => false), { message: "确认移动按钮应启用" });
  await submit.click();
  await modal.getByText("移动结果").waitFor();
  await poll(async () => normalize(await modal.innerText()).includes("成功 1"), {
    message: "移动结果应显示成功 1",
  });
  await modal.getByRole("button", { name: "完成" }).click();
  await modal.waitFor({ state: "detached" });
  await ctx.helpers.toast("移动完成：成功 1");
}

async function undoMoveFromDocs(ctx) {
  const page = ctx.page;
  const row = page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.a3.title });
  await row.locator('button[data-action="docs-undo-move"]').click();
  const modal = await ctx.helpers.modal();
  await modal.locator('button[type="submit"]').click();
  await modal.waitFor({ state: "detached" });
  await ctx.helpers.toast("已撤销移动");
}

async function purgeTrashDoc(ctx, title, kb) {
  const page = ctx.page;
  // 同名文档可能同时出现在不同库的回收站：必须用库徽标锁定目标行。
  const row = page.locator(".trash-doc-row")
    .filter({ hasText: title })
    .filter({ has: page.locator(".trash-kb-badge", { hasText: kb }) });
  await row.waitFor();
  await row.locator('button[data-action="trash-doc-purge"]').click();
  const modal = await ctx.helpers.modal();
  await modal.locator('input[name="confirm"]').fill(kb);
  await modal.locator('button[type="submit"]').click();
  await modal.waitFor({ state: "detached" });
  await poll(async () => (await row.count()) === 0, {
    message: `回收站中 ${kb} 的 ${title} 应已彻底删除`,
  });
}

async function softDeleteTargetCopy(ctx) {
  const page = ctx.page;
  const row = page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.a3.title });
  await row.locator('button[data-action="docs-remove"]').click();
  const modal = await ctx.helpers.modal();
  await modal.locator('button[type="submit"]').click();
  await modal.waitFor({ state: "detached" });
  await ctx.helpers.toast("已移入回收站");
  await poll(async () => (await page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.a3.title }).count()) === 0, {
    message: "目标库副本应已软删除",
  });
}

export async function run(ctx) {
  // 1) 移动 A3 到乙库。
  await openDocs(ctx, FIXTURES.kbs.primary);
  await moveDoc(ctx, FIXTURES.docs.a3.title, FIXTURES.kbs.target);
  let source = await ctx.api.doc(FIXTURES.kbs.primary, FIXTURES.docs.a3.id);
  assert.equal(source.status, "deleted", "移动后源文档应为 deleted");
  assert.equal(source.movedTo?.kb, FIXTURES.kbs.target, "源文档应记录 movedTo 目标库");
  let targetDocs = await ctx.api.docs(FIXTURES.kbs.target, { limit: 200 });
  assert.ok(targetDocs.docs.some((doc) => doc.id === FIXTURES.docs.a3.id && doc.status === "ready"),
    "乙库应出现 ready 的 A3");

  // 甲库「已删除」筛选里应出现撤销移动。
  await setStatusFilter(ctx.page, "deleted");
  const tombstoneRow = ctx.page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.a3.title });
  await tombstoneRow.waitFor();
  assert.equal(await tombstoneRow.locator('button[data-action="docs-undo-move"]').count(), 1,
    "目标副本仍可用时，源库墓碑应提供撤销移动");
  assert.equal(await tombstoneRow.locator('button[data-action="docs-restore"]').count(), 0,
    "目标副本仍可用时不应提供普通恢复");
  const tombstoneText = normalize(await tombstoneRow.innerText());
  assert.ok(tombstoneText.includes("已删除"), `源库墓碑应显示已删除：${tombstoneText}`);
  assert.ok(tombstoneText.includes(`已移至 ${FIXTURES.kbs.target}`), `源库墓碑应显示目标库：${tombstoneText}`);

  // 2) 撤销移动：源库恢复，目标副本进回收站。
  await undoMoveFromDocs(ctx);
  source = await ctx.api.doc(FIXTURES.kbs.primary, FIXTURES.docs.a3.id);
  assert.equal(source.status, "ready", "撤销后源文档应为 ready");
  assert.equal(source.movedTo, null, "撤销后源文档 movedTo 应清空");
  targetDocs = await ctx.api.docs(FIXTURES.kbs.target, { status: "deleted", limit: 200 });
  assert.ok(targetDocs.docs.some((doc) => doc.id === FIXTURES.docs.a3.id),
    "撤销后乙库副本应进入已删除");

  // 切回全部，确认 A3 在甲库恢复为 ready 行。
  await setStatusFilter(ctx.page, "");
  const readyRow = ctx.page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.a3.title });
  await readyRow.waitFor();
  const readyText = normalize(await readyRow.innerText());
  assert.ok(!readyText.includes("已删除"), `撤销后 A3 不应仍显示已删除：${readyText}`);

  // 3) 彻底删除撤销留下的乙库墓碑，为第二次移动让路。
  await ctx.goto("/kb/#/trash?tab=docs");
  await ctx.page.locator(".trash-doc-row").first().waitFor();
  await purgeTrashDoc(ctx, FIXTURES.docs.a3.title, FIXTURES.kbs.target);
  targetDocs = await ctx.api.docs(FIXTURES.kbs.target, { status: "deleted", limit: 200 });
  assert.equal(targetDocs.total, 0, "目标库已删除资料应清空");

  // 4) 再次移动 A3。
  await openDocs(ctx, FIXTURES.kbs.primary);
  await moveDoc(ctx, FIXTURES.docs.a3.title, FIXTURES.kbs.target);
  targetDocs = await ctx.api.docs(FIXTURES.kbs.target, { limit: 200 });
  assert.ok(targetDocs.docs.some((doc) => doc.id === FIXTURES.docs.a3.id && doc.status === "ready"),
    "第二次移动后乙库副本应为 ready");

  // 5) 软删除乙库副本（进入回收站），再从回收站彻底删除目标副本。
  await openDocs(ctx, FIXTURES.kbs.target);
  await softDeleteTargetCopy(ctx);
  await ctx.goto("/kb/#/trash?tab=docs");
  await ctx.page.locator(".trash-doc-row").first().waitFor();
  await purgeTrashDoc(ctx, FIXTURES.docs.a3.title, FIXTURES.kbs.target);

  // 6) 目标副本已缺失：甲库源墓碑应改为「恢复」；恢复后 movedTo 清空。
  //    此时回收站只剩甲库源墓碑一行（乙库副本已被彻底删除）。
  const trashRows = ctx.page.locator(".trash-doc-row").filter({ hasText: FIXTURES.docs.a3.title });
  const sourceTrashRow = trashRows.filter({
    has: ctx.page.locator(".trash-kb-badge", { hasText: FIXTURES.kbs.primary }),
  });
  await sourceTrashRow.waitFor();
  assert.equal(await trashRows.count(), 1,
    "目标副本彻底删除后，回收站应只剩甲库源墓碑");
  assert.equal(await sourceTrashRow.locator('button[data-action="trash-doc-undo-move"]').count(), 0,
    "目标副本已缺失时不应再提供撤销移动");
  assert.equal(await sourceTrashRow.locator('button[data-action="trash-doc-restore"]').count(), 1,
    "目标副本已缺失时源库墓碑应提供恢复");
  await sourceTrashRow.locator('button[data-action="trash-doc-restore"]').click();
  await ctx.helpers.toast("已恢复");
  await poll(async () => (await sourceTrashRow.count()) === 0, {
    message: "恢复后源库墓碑应离开回收站",
  });

  await openDocs(ctx, FIXTURES.kbs.primary);
  const restoredRow = ctx.page.locator("tr.doc-row").filter({ hasText: FIXTURES.docs.a3.title });
  await restoredRow.waitFor();
  const restoredText = normalize(await restoredRow.innerText());
  assert.ok(!restoredText.includes("已删除"), "恢复后 A3 应回到就绪列表");
  assert.ok(!restoredText.includes(`已移至 ${FIXTURES.kbs.target}`), "恢复后不应再显示已移至乙库");
  source = await ctx.api.doc(FIXTURES.kbs.primary, FIXTURES.docs.a3.id);
  assert.equal(source.status, "ready", "恢复后 A3 服务端状态应为 ready");
  assert.equal(source.movedTo, null, "恢复后 movedTo 应被清空");

  // 目标库副本已被彻底删除：恢复源库不会在乙库留下第二份可用资料。
  const targetLive = await ctx.api.docs(FIXTURES.kbs.target, { limit: 200 });
  assert.equal(targetLive.docs.filter((doc) => doc.id === FIXTURES.docs.a3.id).length, 0,
    "乙库不应再有 A3 的可用副本");
  targetDocs = await ctx.api.docs(FIXTURES.kbs.target, { status: "deleted", limit: 200 });
  assert.equal(targetDocs.total, 0, "乙库回收站不应再有 A3 副本");
}
