/**
 * 资料操作（0.23.0）：多选、回收站、失败重试、跨库移动的纯逻辑与渲染。
 * 弹窗 DOM 交互需要真实浏览器，这里只测可导出的纯函数与 SSR 字符串。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DOCS_STATUSES, docRowActions, renderDetail, renderDocsBulkBar, selectableDoc,
  selectionAllSelected, selectionHas, selectionIds, selectionToggle, selectionToggleOne,
} from "../ui/views/detail.js";
import {
  conflictGroups, deleteConfirmBody, deleteConfirmCheck, moveConfirmState,
  moveTargetChange, renderDocModalBody, renderMoveForm, renderMoveResult,
  renderMoveSummary, retryFailedDoc, waitForJob,
} from "../ui/views/modals.js";

const icons = { upload: "", archive: "", search: "", chevron: "", database: "" };
const fmtNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
const current = { page: "detail", name: "标准", tab: "docs" };

function makeDoc(id, patch = {}) {
  return {
    id,
    title: `资料 ${id}`,
    type: "pdf-text",
    pages: 3,
    trust: "high",
    status: "ready",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  };
}

function makeState(docs = {}, kbPatch = {}) {
  return {
    detailLoading: false,
    detailError: "",
    detail: {
      kb: {
        name: "标准",
        status: "ok",
        description: "现行标准",
        docs: { ready: 2, importing: 0, failed: 0, notes: 0, deleted: 0 },
        pages: 20,
        chars: 1000,
        updatedAt: "2026-10-01T00:00:00.000Z",
        ...kbPatch,
      },
      health: { failed: 0, importing: 0, lowConfidenceDocs: 0, corruptedDocs: 0, hasSchema: true },
      recentDocs: [],
      logTail: "",
    },
    docs: {
      items: [], total: 0, offset: 0, limit: 50, query: "", appliedQuery: "", status: "",
      selected: [], busy: false, retrying: [],
      ...docs,
    },
  };
}

function render(docs, kbPatch = {}) {
  return renderDetail(makeState(docs, kbPatch), current, { icons, fmtNumber });
}

// ---------------------------------------------------------------------------
// 勾选
// ---------------------------------------------------------------------------

test("只有 ready/failed 行可勾选，导入中/已删除不参与多选", () => {
  assert.equal(selectableDoc(makeDoc("a")), true);
  assert.equal(selectableDoc(makeDoc("f", { status: "failed" })), true);
  assert.equal(selectableDoc(makeDoc("i", { status: "importing" })), false);
  assert.equal(selectableDoc(makeDoc("d", { status: "deleted", deleted: true })), false);
  assert.equal(selectableDoc(null), false);
});

test("selectionToggle 选中本页可操作行，再点一次取消本页", () => {
  const rows = [
    makeDoc("a"),
    makeDoc("f", { status: "failed" }),
    makeDoc("i", { status: "importing" }),
    makeDoc("d", { status: "deleted", deleted: true }),
  ];
  const all = selectionToggle([], rows);
  assert.deepEqual(selectionIds(all), ["a", "f"]);
  assert.equal(selectionAllSelected(all, rows), true);
  assert.deepEqual(selectionIds(selectionToggle(all, rows)), []);
  assert.equal(selectionAllSelected([], rows), false);
});

test("selectionToggle 局部选中时补齐而不是清空", () => {
  const rows = [makeDoc("a"), makeDoc("b")];
  const one = selectionToggle([], rows);
  const partial = selectionToggle([one[0]], rows);
  assert.deepEqual(selectionIds(partial), ["a", "b"]);
  // 已删除的勾选不因表头点击丢失（表头只作用于本页可操作行）。
  const kept = selectionToggle([{ id: "x", title: "跨页", status: "ready" }], []);
  assert.deepEqual(selectionIds(kept), ["x"]);
});

test("selectionToggleOne 按 checked 增删；不传 checked 时取反", () => {
  const doc = makeDoc("a", { title: "电压偏差" });
  assert.deepEqual(selectionIds(selectionToggleOne([], doc, true)), ["a"]);
  assert.equal(selectionHas(selectionToggleOne([], doc, true), "a"), true);
  assert.deepEqual(selectionIds(selectionToggleOne([{ id: "a", title: "电压偏差", status: "ready" }], doc, false)), []);
  assert.deepEqual(selectionIds(selectionToggleOne([], doc)), ["a"]);
  assert.deepEqual(selectionIds(selectionToggleOne([{ id: "a" }], doc)), []);
  assert.deepEqual(selectionIds(selectionToggleOne([], { id: "" })), []);
});

test("文档表格有勾选列，已删除行没有复选框但保留行内操作", () => {
  const html = render({
    items: [
      makeDoc("a"),
      makeDoc("f", { status: "failed" }),
      makeDoc("d", { status: "deleted", deleted: true }),
    ],
    total: 3,
    selected: [{ id: "a", title: "资料 a", status: "ready" }],
  });
  assert.match(html, /<th class="col-check"><input type="checkbox" data-action="docs-select-all"/);
  assert.match(html, /data-action="docs-select" data-id="a"[^>]*checked/);
  assert.match(html, /data-action="docs-select" data-id="f"/);
  assert.doesNotMatch(html, /data-action="docs-select" data-id="d"/);
  assert.match(html, /<td class="col-check"><\/td>/);
  assert.match(html, /data-action="docs-restore" data-id="d"/);
  assert.match(html, /data-action="docs-purge" data-id="d"/);
});

test("多选工具条显示数量与导出/移动/回收站/取消操作，busy 时禁用", () => {
  const idle = renderDocsBulkBar({ selected: [{ id: "a" }, { id: "b" }] });
  assert.match(idle, /data-action="docs-export-selected"/);
  assert.match(idle, /已选 2 篇/);
  assert.match(idle, /data-action="docs-move"/);
  assert.match(idle, /data-action="docs-trash-selected"/);
  assert.match(idle, /data-action="docs-clear-selection"/);
  assert.doesNotMatch(idle, / disabled/);
  assert.equal(renderDocsBulkBar({ selected: [] }), "");

  const busy = renderDocsBulkBar({ selected: [{ id: "a" }], busy: true });
  assert.equal((busy.match(/ disabled/g) ?? []).length, 4);
});

test("docs 渲染在多选时插入工具条", () => {
  const html = render({ items: [makeDoc("a")], total: 1, selected: [{ id: "a", title: "资料 a", status: "ready" }] });
  assert.match(html, /class="docs-bulk"/);
  assert.match(html, /已选 1 篇/);
  const noSelection = render({ items: [makeDoc("a")], total: 1 });
  assert.doesNotMatch(noSelection, /class="docs-bulk"/);
});

// ---------------------------------------------------------------------------
// 已删除筛选与行内操作
// ---------------------------------------------------------------------------

test("有已删除资料时才显示「已删除」筛选，选中时高亮", () => {
  assert.equal(DOCS_STATUSES.includes("deleted"), true);
  const hidden = render({ items: [makeDoc("a")], total: 1 }, { deleted: 0 });
  assert.doesNotMatch(hidden, /data-docs-status="deleted"/);

  const shown = render({ items: [makeDoc("a")], total: 1 }, { docs: { ready: 1, importing: 0, failed: 0, notes: 0, deleted: 2 } });
  assert.match(shown, /data-action="docs-status" data-docs-status="deleted"[^>]*>已删除/);

  const active = render({ items: [makeDoc("d", { status: "deleted", deleted: true })], total: 1, status: "deleted" });
  assert.match(active, /class="seg active" data-action="docs-status" data-docs-status="deleted"[^>]*>已删除/);
});

test("已删除筛选无结果时给出专门空状态", () => {
  const html = render({ total: 0, status: "deleted" });
  assert.match(html, /没有已删除的资料/);
  assert.match(html, /data-docs-status="deleted"/);
});

test("已删除筛选且有回收站内容时显示「清空本库已删除资料」", () => {
  const deletedRow = makeDoc("d", { status: "deleted", deleted: true });
  const withDeleted = { docs: { ready: 1, importing: 0, failed: 0, notes: 0, deleted: 2 } };

  // 只有切到「已删除」筛选才出现，其它筛选即使有回收站内容也不显示。
  const all = render({ items: [makeDoc("a")], total: 1, status: "" }, withDeleted);
  assert.doesNotMatch(all, /docs-purge-all/);
  const filtered = render({ items: [makeDoc("f", { status: "failed" })], total: 1, status: "failed" }, withDeleted);
  assert.doesNotMatch(filtered, /docs-purge-all/);

  const shown = render({ items: [deletedRow], total: 1, status: "deleted" }, withDeleted);
  assert.match(shown, /class="btn danger docs-purge-all" data-action="docs-purge-all">清空本库已删除资料/);

  // 已删除筛选无结果（搜索词过滤）但库里仍有回收站内容时，工具栏仍保留入口。
  const noResult = render({ total: 0, status: "deleted", query: "找不到", appliedQuery: "找不到" }, withDeleted);
  assert.match(noResult, /没有匹配的资料/);
  assert.match(noResult, /data-action="docs-purge-all"/);

  const busy = render({ items: [deletedRow], total: 1, status: "deleted", busy: true }, withDeleted);
  assert.match(busy, /data-action="docs-purge-all" disabled/);

  // 库里没有已删除资料时不显示。
  const none = render({ items: [], total: 0, status: "deleted" }, {
    docs: { ready: 1, importing: 0, failed: 0, notes: 0, deleted: 0 },
  });
  assert.doesNotMatch(none, /docs-purge-all/);
});

test("行内操作按状态给出：失败=重试+移除，就绪=移除，已删除=恢复+彻底删除", () => {
  assert.deepEqual(docRowActions(makeDoc("f", { status: "failed" })), ["retry", "remove"]);
  assert.deepEqual(docRowActions(makeDoc("a")), ["remove"]);
  assert.deepEqual(docRowActions(makeDoc("d", { status: "deleted" })), ["restore", "purge"]);
  assert.deepEqual(docRowActions(makeDoc("i", { status: "importing" })), []);
  assert.deepEqual(docRowActions(null), []);

  const html = render({
    items: [makeDoc("f", { status: "failed" }), makeDoc("a")],
    total: 2,
  });
  assert.match(html, /data-action="docs-retry" data-id="f"[^>]*>重试/);
  assert.match(html, /data-action="docs-remove" data-id="f"[^>]*>移除/);
  assert.match(html, /data-action="docs-remove" data-id="a"[^>]*>移除/);
  assert.doesNotMatch(html, /data-action="docs-retry" data-id="a"/);
});

test("重试中的失败行按钮禁用并显示「重试中…」", () => {
  const html = render({ items: [makeDoc("f", { status: "failed" })], total: 1, retrying: ["f"] });
  assert.match(html, /data-action="docs-retry" data-id="f" disabled>重试中…/);
});

test("已跨库移动的回收站行显示「撤销移动」而不是恢复，并带目标库", () => {
  const moved = makeDoc("m1", {
    status: "deleted",
    deleted: true,
    movedTo: { kb: "目标", docId: "t1", transferId: "abc", at: "2026-10-02T00:00:00.000Z" },
  });
  assert.deepEqual(docRowActions(moved), ["undo-move", "purge"]);
  const html = render({ items: [moved], total: 1, status: "deleted" });
  assert.match(html, /data-action="docs-undo-move" data-id="m1" data-target="目标">撤销移动/);
  assert.match(html, /已移至 目标/);
  assert.doesNotMatch(html, /data-action="docs-restore" data-id="m1"/);
});

// ---------------------------------------------------------------------------
// 确认与移动纯逻辑
// ---------------------------------------------------------------------------

test("deleteConfirmCheck 去首尾空白后逐字比较，空标题不可确认", () => {
  assert.deepEqual(deleteConfirmCheck("电压偏差", " 电压偏差 "), { ok: true, expected: "电压偏差" });
  assert.equal(deleteConfirmCheck("电压偏差 ", "电压偏差").ok, true);
  assert.equal(deleteConfirmCheck("电压偏差", "电压偏差x").ok, false);
  assert.equal(deleteConfirmCheck("", "电压偏差").ok, false);
  assert.equal(deleteConfirmCheck("", "").ok, false);
});

test("deleteConfirmBody 固定说明 + 标题清单，超过 20 条折叠", () => {
  const body = deleteConfirmBody([{ title: "A" }, { title: "B" }]);
  assert.match(body, /^移入回收站，可在『已删除』中恢复；原件与解析内容保留\n\n· A\n· B$/);

  const many = Array.from({ length: 25 }, (_, index) => ({ title: `资料 ${index + 1}` }));
  const capped = deleteConfirmBody(many);
  assert.match(capped, /· 资料 20/);
  assert.doesNotMatch(capped, /· 资料 21/);
  assert.match(capped, /…等 25 篇/);
});

test("conflictGroups 按同 ID/同内容/同标题分组并保留目标标题", () => {
  const preflight = {
    totalBytes: 2048,
    docs: [
      { id: "a", title: "A", conflict: { kind: "id", withTitle: "A 旧" } },
      { id: "b", title: "B", conflict: { kind: "hash", withTitle: "B 旧" } },
      { id: "c", title: "C", conflict: { kind: "title", withTitle: "C 旧" } },
      { id: "d", title: "D", conflict: { kind: "title", withTitle: "D 旧" } },
      { id: "e", title: "E", conflict: null },
    ],
  };
  const groups = conflictGroups(preflight);
  assert.deepEqual(groups.map((group) => [group.kind, group.count]), [["id", 1], ["hash", 1], ["title", 2]]);
  assert.deepEqual(groups[0], {
    kind: "id",
    label: "同 ID",
    count: 1,
    items: [{ id: "a", title: "A", targetTitle: "A 旧" }],
  });
  assert.equal(groups[2].items[1].targetTitle, "D 旧");
  assert.deepEqual(conflictGroups({ docs: [] }), []);
  assert.deepEqual(conflictGroups([]), []);
});

test("移动表单没有冲突时不渲染冲突模式单选，提示将直接移动", () => {
  const html = renderMoveForm({
    sourceIds: ["a"],
    targets: ["目标"],
    target: "目标",
    preflight: { docs: [{ id: "a", title: "A", conflict: null }] },
  });
  assert.doesNotMatch(html, /name="on-conflict"/);
  assert.doesNotMatch(html, /遇到重复/);
  assert.doesNotMatch(html, /class="move-conflict-mode"/);
  assert.match(html, /<p class="muted move-no-conflict">没有重复冲突，将直接移动。<\/p>/);
  assert.doesNotMatch(html, /同内容重复始终跳过/);
  // 预检完成但未勾选确认时仍不可提交（ack 门禁不变）。
  assert.match(html, /请先勾选确认移动说明/);
  assert.match(html, /<button type="submit" class="btn primary" disabled>开始移动<\/button>/);
});

test("移动表单有冲突时两个单选均可用，默认选中跳过", () => {
  const preflight = {
    totalBytes: 2048,
    docs: [
      { id: "a", title: "A", conflict: { kind: "title", withTitle: "A 旧" } },
      { id: "b", title: "B", conflict: { kind: "hash", withTitle: "B 旧" } },
    ],
  };
  const html = renderMoveForm({
    sourceIds: ["a", "b"],
    targets: ["目标", "乙库"],
    target: "目标",
    preflight,
  });
  assert.match(html, /class="move-conflict-mode"/);
  assert.match(html, /目标库已有重复（2 篇）/);
  assert.doesNotMatch(html, /move-no-conflict/);
  const skip = html.match(/<input type="radio" name="on-conflict" value="skip"[^>]*>/)?.[0] ?? "";
  const rename = html.match(/<input type="radio" name="on-conflict" value="rename"[^>]*>/)?.[0] ?? "";
  assert.match(skip, / checked/);
  assert.doesNotMatch(skip, / disabled/);
  assert.doesNotMatch(rename, / checked/);
  assert.doesNotMatch(rename, / disabled/);
  // 同内容冲突的说明只在 hash 组存在时出现。
  assert.match(html, /同内容重复始终跳过/);
  assert.match(html, /请先勾选确认移动说明/);

  const ready = renderMoveForm({
    sourceIds: ["a", "b"],
    targets: ["目标"],
    target: "目标",
    ack: true,
    preflight,
  });
  assert.doesNotMatch(ready, /move-hint/);
  assert.doesNotMatch(ready, /class="btn primary" disabled/);

  const busy = renderMoveForm({
    sourceIds: ["a", "b"],
    targets: ["目标"],
    target: "目标",
    ack: true,
    busy: true,
    preflight,
  });
  for (const radio of busy.match(/<input type="radio" name="on-conflict"[^>]*>/g) ?? []) {
    assert.match(radio, / disabled/);
  }
});

test("切换移动目标重置勾选后表单重新提示确认", () => {
  const next = moveTargetChange({ target: "乙库", previousTarget: "目标", ack: true });
  assert.equal(next.ack, false);
  const html = renderMoveForm({
    sourceIds: ["a"],
    targets: ["目标", "乙库"],
    target: next.target,
    ack: next.ack,
    preflight: { docs: [{ id: "a", title: "A", conflict: null }] },
  });
  assert.match(html, /<option value="乙库" selected>乙库<\/option>/);
  assert.match(html, /请先勾选确认移动说明/);
});

test("moveConfirmState 在目标/预检/勾选/忙碌之间正确禁用", () => {
  const ready = { target: "目标", ack: true, preflight: { docs: [] }, loading: false, busy: false, error: "" };
  assert.equal(moveConfirmState(ready).disabled, false);
  assert.match(moveConfirmState({ ...ready, target: "" }).reason, /目标知识库/);
  assert.match(moveConfirmState({ ...ready, ack: false }).reason, /勾选/);
  assert.match(moveConfirmState({ ...ready, preflight: null }).reason, /预检/);
  assert.match(moveConfirmState({ ...ready, loading: true }).reason, /预检/);
  assert.match(moveConfirmState({ ...ready, busy: true }).reason, /移动/);
  assert.match(moveConfirmState({ ...ready, error: "目标库已合并" }).reason, /预检失败/);
});

test("切换移动目标会重置确认勾选", () => {
  assert.deepEqual(
    moveTargetChange({ target: "乙库", previousTarget: "甲库", ack: true }),
    { target: "乙库", ack: false }
  );
  assert.deepEqual(
    moveTargetChange({ target: "甲库", previousTarget: "甲库", ack: true }),
    { target: "甲库", ack: true },
    "目标未变时保留勾选"
  );
  assert.deepEqual(
    moveTargetChange({ target: "", previousTarget: "甲库", ack: true }),
    { target: "", ack: false }
  );
});

test("renderMoveSummary 显示篇数、大小与目标，并转义错误", () => {
  assert.match(renderMoveSummary({ target: "", ids: ["a"] }), /请选择目标知识库/);
  assert.match(renderMoveSummary({ target: "目标", ids: ["a"], loading: true }), /正在预检/);
  assert.match(
    renderMoveSummary({ target: "目标", preflight: { docs: [{ id: "a" }, { id: "b" }], totalBytes: 2048 } }),
    /将移动 2 篇（约 2\.0 KB）到「目标」/,
  );
  assert.match(renderMoveSummary({ target: "目标", ids: ["a", "b"], preflight: null }), /将移动 2 篇（约 0 B）到「目标」/);
  assert.match(
    renderMoveSummary({ target: "<目标>", error: "目标库<已合并>" }),
    /&lt;已合并&gt;/,
  );
});

test("renderMoveResult 分组列出成功/跳过/失败原因与新标题", () => {
  const html = renderMoveResult({
    target: "目标",
    result: {
      moved: 1,
      skipped: 2,
      failed: 1,
      results: [
        { id: "d1", title: "电压偏差", status: "moved", newTitle: "电压偏差（副本）" },
        { id: "d2", title: "继电保护", status: "skipped", reason: "目标库已有相同内容的文档" },
        { id: "d3", title: "<script>", status: "skipped", conflict: { kind: "title", withTitle: "旧标题" } },
        { id: "d4", title: "油务", status: "failed", error: "移动失败（TRANSFER_IO_FAILED）" },
      ],
    },
  });
  assert.match(html, /共 4 篇：成功 1 · 跳过 2 · 失败 1/);
  assert.match(html, /已移动 1 篇 → 「目标」/);
  assert.match(html, /电压偏差（副本）/);
  assert.match(html, /目标库已有相同内容的文档/);
  assert.match(html, /目标库已有相同标题的文档/);
  assert.match(html, /移动失败（TRANSFER_IO_FAILED）/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("renderMoveResult 无结果时给出占位", () => {
  assert.match(renderMoveResult({ result: null }), /尚无移动结果/);
});

// ---------------------------------------------------------------------------
// 失败文档弹窗正文
// ---------------------------------------------------------------------------

test("失败文档正文显示等宽错误块、warnings 与重试/回收站按钮", () => {
  const html = renderDocModalBody({
    name: "标准",
    id: "f1",
    doc: makeDoc("f1", {
      status: "failed",
      error: "解析失败：<文件损坏>",
      warnings: ["第 2 页低置信度", "<script>"],
      pages: 0,
      chars: 0,
      sourceFile: "坏文件.pdf",
    }),
  });
  assert.match(html, /<pre class="doc-error-text">解析失败：&lt;文件损坏&gt;<\/pre>/);
  assert.match(html, /第 2 页低置信度/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /data-retry>重新导入/);
  assert.match(html, /data-remove>移入回收站/);
  assert.match(html, /data-preview>查看原件/);
  assert.match(html, /\/kb\/api\/kbs\/%E6%A0%87%E5%87%86\/docs\/f1\/source/);
  assert.match(html, /data-retry-state hidden/);
});

test("失败但没有 error/warnings 时回落到「导入失败」，就绪文档没有重试入口", () => {
  const failed = renderDocModalBody({
    name: "标准",
    id: "f1",
    doc: makeDoc("f1", { status: "failed", error: "", warnings: [] }),
  });
  assert.match(failed, /<pre class="doc-error-text">导入失败<\/pre>/);
  assert.doesNotMatch(failed, /doc-warnings/);

  const ready = renderDocModalBody({ name: "标准", id: "a1", doc: makeDoc("a1") });
  assert.doesNotMatch(ready, /data-retry/);
  assert.doesNotMatch(ready, /移入回收站/);
  assert.match(ready, /data-preview/);
});

// ---------------------------------------------------------------------------
// 重试轮询（注入 fake sleep/getJob，不需要真实计时器）
// ---------------------------------------------------------------------------

test("waitForJob 轮询到 running 之外的结算状态", async () => {
  const statuses = ["running", "running", "succeeded"];
  let calls = 0;
  const job = await waitForJob({
    jobId: "j1",
    getJob: async () => ({ status: statuses[calls++] }),
    sleep: async () => {},
    intervalMs: 1000,
    timeoutMs: 10000,
  });
  assert.equal(calls, 3);
  assert.deepEqual(job, { status: "succeeded" });
});

test("waitForJob 任务已结算时立即返回，超时抛 REPARSE_TIMEOUT", async () => {
  let calls = 0;
  const settled = await waitForJob({
    jobId: "j2",
    getJob: async () => { calls += 1; return { status: "failed" }; },
    sleep: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(settled.status, "failed");

  await assert.rejects(
    () => waitForJob({
      jobId: "j3",
      getJob: async () => ({ status: "running" }),
      sleep: async () => {},
      intervalMs: 1000,
      timeoutMs: 2000,
    }),
    (error) => {
      assert.equal(error.code, "REPARSE_TIMEOUT");
      assert.match(error.message, /超时/);
      return true;
    },
  );

  await assert.rejects(() => waitForJob({ jobId: "", getJob: async () => ({}) }), /缺少任务 id/);
  await assert.rejects(() => waitForJob({ jobId: "j4" }), /缺少任务查询函数/);
});

test("retryFailedDoc 启动任务、轮询、通知并刷新", async () => {
  const notices = [];
  const settled = [];
  const job = await retryFailedDoc({
    name: "标准",
    id: "f1",
    notify: (message, kind) => notices.push([message, kind]),
    reparse: async () => ({ jobId: "j1" }),
    getJob: async () => ({ status: "succeeded", detail: "重试完成：失败资料" }),
    sleep: async () => {},
    onSettled: async (value) => { settled.push(value); },
  });
  assert.equal(job.status, "succeeded");
  assert.deepEqual(notices[0], ["已开始重试解析", undefined]);
  assert.deepEqual(notices.at(-1), ["重试完成：失败资料", undefined]);
  assert.equal(settled.length, 1);
});

test("retryFailedDoc 把任务失败原因提示成 error，并报告缺 jobId", async () => {
  const notices = [];
  const job = await retryFailedDoc({
    name: "标准",
    id: "f1",
    notify: (message, kind) => notices.push([message, kind]),
    reparse: async () => ({ jobId: "j1" }),
    getJob: async () => ({ status: "failed", detail: "原件读取失败" }),
    sleep: async () => {},
  });
  assert.equal(job.status, "failed");
  assert.deepEqual(notices.at(-1), ["重试失败：原件读取失败", "error"]);

  await assert.rejects(
    () => retryFailedDoc({
      name: "标准",
      id: "f1",
      reparse: async () => ({}),
      getJob: async () => ({ status: "succeeded" }),
    }),
    /没有返回 jobId/,
  );
});
