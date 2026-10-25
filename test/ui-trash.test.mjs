/**
 * 回收站（0.24.0 数据治理任务 2）：归档库 / 已删除资料双分区、勾选、批量恢复与按库彻底删除。
 * 只测可导出的纯渲染与选择/确认文案；弹窗输入与按钮点击绑定属于 DOM 行为。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PURGE_DOCS_WARNING, TRASH_DOCS_COPY, TRASH_DOC_SORTS, TRASH_PURGE_WARNING,
  TRASH_QUERY_PLACEHOLDER, purgeDocsConfirmBody, renderTrash, renderTrashBulk,
  renderTrashDocsToolbar, renderTrashPurgeBody, renderTrashTabs, sameTrashKb,
  trashPurgePhrase, trashPurgeTarget, trashRestoreTargets, trashSelectionAllSelected,
  trashSelectionHas, trashSelectionKb, trashSelectionToggleAll, trashSelectionToggleOne, trashTab,
} from "../ui/views/trash.js";

const icons = { trash: '<svg data-icon="trash"></svg>' };
const fmtNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value) || 0);

function archivedKb(patch = {}) {
  return {
    dir: ".trash/旧库",
    name: "旧库",
    docs: 12,
    notes: 3,
    archivedAt: "2026-10-01T08:30:00.000Z",
    restorable: true,
    ...patch,
  };
}

function deletedDoc(kb, id, patch = {}) {
  return {
    kb,
    id,
    title: `资料 ${id}`,
    type: "pdf-text",
    deletedAt: "2026-10-02T08:30:00.000Z",
    deleted: true,
    deletedFromStatus: "ready",
    ...patch,
  };
}

function makeState({
  archived = [],
  docs = [],
  total = docs.length,
  truncated = false,
  selectedDocs = [],
  loading = false,
  error = "",
  docsError = "",
  busy = false,
  query = "",
  sort = "deleted_desc",
} = {}) {
  return {
    trash: {
      items: archived,
      docs: { items: docs, total, truncated, error: docsError },
      selectedDocs,
      query,
      sort,
      loading,
      error,
      busy,
    },
  };
}

function render(state, tab = "archived") {
  return renderTrash(
    state,
    { page: "trash", query: tab === "docs" ? { tab: "docs" } : {} },
    { icons, fmtNumber },
  );
}

// ---------------------------------------------------------------------------
// 分区页签
// ---------------------------------------------------------------------------

test("默认归档库；只有 ?tab=docs 进入已删除资料", () => {
  assert.equal(trashTab({ page: "trash", query: {} }), "archived");
  assert.equal(trashTab({ page: "trash" }), "archived");
  assert.equal(trashTab({ page: "trash", query: { tab: "docs" } }), "docs");
  assert.equal(trashTab({ page: "trash", query: { tab: "unknown" } }), "archived");
  assert.equal(trashTab(undefined), "archived");
});

test("两个分区页签带数量与可直接刷新/后退的 hash 链接", () => {
  const tabs = renderTrashTabs({ tab: "archived", archivedCount: 2, docsCount: 7, fmtNumber });
  assert.match(tabs, /class="segmented trash-tabs"/);
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /class="seg active" role="tab" aria-selected="true" href="#\/trash">归档库 <span class="seg-count">2<\/span>/);
  assert.match(tabs, /class="seg" role="tab" aria-selected="false" href="#\/trash\?tab=docs">已删除资料 <span class="seg-count">7<\/span>/);

  const docs = renderTrashTabs({ tab: "docs", archivedCount: 0, docsCount: 0, fmtNumber });
  assert.match(docs, /class="seg" role="tab" aria-selected="false" href="#\/trash">归档库 <span class="seg-count">0<\/span>/);
  assert.match(docs, /class="seg active" role="tab" aria-selected="true" href="#\/trash\?tab=docs">已删除资料 <span class="seg-count">0<\/span>/);
});

test("已删除资料页签数量取服务端 total，而不是被 500 条上限截断的条数", () => {
  const html = render(makeState({
    docs: Array.from({ length: 3 }, (_, index) => deletedDoc("标准", `d${index}`)),
    total: 501,
    truncated: true,
  }), "docs");
  assert.match(html, /已删除资料 <span class="seg-count">501<\/span>/);
});

// ---------------------------------------------------------------------------
// 归档库分区
// ---------------------------------------------------------------------------

test("归档库分区保留原列表：恢复/彻底删除操作与计数", () => {
  const html = render(makeState({ archived: [archivedKb()] }));
  assert.match(html, /归档的库不在总览和检索里；恢复后回到正常使用。1 个归档库。/);
  assert.match(html, /彻底删除不可撤销；仅对回收站中的库生效。/);
  assert.match(html, /<strong>旧库<\/strong>/);
  assert.match(html, /data-action="restore-kb" data-dir=".trash\/旧库" data-name="旧库">恢复/);
  assert.match(html, /data-action="purge-kb" data-dir=".trash\/旧库" data-name="旧库">彻底删除/);
  assert.doesNotMatch(html, /trash-docs-table/);
});

test("归档库为空时保留原空状态", () => {
  const html = render(makeState());
  assert.match(html, /回收站是空的/);
  assert.match(html, /在库设置里归档的库会出现在这里。/);
  assert.match(html, /data-icon="trash"/);
  assert.doesNotMatch(html, /trash-docs-table/);
});

test("归档库分区保留加载与错误状态", () => {
  const loading = render(makeState({ loading: true }));
  assert.match(loading, /回收站加载中…/);

  const error = render(makeState({ error: "读取 <失败>" }));
  assert.match(error, /class="state error"/);
  assert.match(error, /读取 &lt;失败&gt;/);
  assert.match(error, /data-action="reload-trash">重试/);
});

// ---------------------------------------------------------------------------
// 已删除资料分区
// ---------------------------------------------------------------------------

test("已删除资料分区有说明、总数、库徽标与行内恢复/彻底删除", () => {
  const html = render(makeState({
    archived: [archivedKb()],
    docs: [
      deletedDoc("标准", "d1", { title: "电压偏差", type: "pdf-text", deletedAt: "2026-10-03T06:07:00.000Z" }),
      deletedDoc("标准", "d2", { title: "继电保护", type: "docx" }),
    ],
  }), "docs");

  assert.match(html, new RegExp(TRASH_DOCS_COPY));
  assert.match(html, /共 2 篇/);
  assert.match(html, /<th>库<\/th><th>标题<\/th><th>类型<\/th><th>删除时间<\/th><th class="col-actions">操作<\/th>/);
  assert.match(html, /<span class="badge trash-kb-badge">标准<\/span>/);
  assert.match(html, /<td>电压偏差<\/td>/);
  assert.match(html, /<td class="muted">docx<\/td>/);
  assert.match(html, /2026-10-03 \d{2}:\d{2}/);
  assert.match(html, /data-action="trash-doc-restore" data-kb="标准" data-id="d1">恢复/);
  assert.match(html, /data-action="trash-doc-purge" data-kb="标准" data-id="d1">彻底删除/);
  assert.match(html, /data-action="trash-doc-select-all"/);
  assert.match(html, /data-action="trash-doc-select" data-kb="标准" data-id="d2"/);
  // 已删除资料分区不渲染归档库操作。
  assert.doesNotMatch(html, /data-action="restore-kb"/);
  assert.doesNotMatch(html, /data-action="purge-kb"/);
});

test("已删除资料工具条：搜索框、六种排序、过滤后的篇数与截断提示", () => {
  const html = render(makeState({
    docs: [deletedDoc("标准", "d1", { title: "电压偏差" })],
    total: 501,
    truncated: true,
    query: "电压",
    sort: "title_desc",
  }), "docs");

  assert.match(html, /class="table-tools trash-docs-tools"/);
  assert.match(html, /data-trash-query value="电压" placeholder="搜索库名、标题或类型…" aria-label="搜索已删除资料"/);
  assert.match(html, new RegExp(`placeholder="${TRASH_QUERY_PLACEHOLDER}"`));
  assert.match(html, /<select data-trash-sort aria-label="已删除资料排序">/);
  for (const [value, label] of TRASH_DOC_SORTS) {
    assert.match(html, new RegExp(`<option value="${value}"${value === "title_desc" ? " selected" : ""}>${label}</option>`));
  }
  assert.match(html, /共 501 篇/);
  assert.match(html, /仅显示前 500 篇/);
  assert.match(html, /<td>电压偏差<\/td>/);

  const escaped = renderTrashDocsToolbar({ query: '<电压&"', sort: "unknown", total: 0 });
  assert.match(escaped, /value="&lt;电压&amp;&quot;"/);
  // 未知排序值回落到默认项，避免下拉框没有选中项。
  assert.match(escaped, /<option value="deleted_desc" selected>删除时间（新→旧）<\/option>/);
});

test("搜索命中 0 篇与回收站本来就空是两种空状态", () => {
  const filtered = render(makeState({ total: 0, query: "不存在" }), "docs");
  assert.match(filtered, /没有匹配的已删除资料/);
  assert.match(filtered, /data-action="trash-docs-clear-query">清除搜索/);
  assert.match(filtered, /data-trash-query value="不存在"/);
  assert.match(filtered, /共 0 篇/);
  assert.doesNotMatch(filtered, /没有已删除的资料/);

  const empty = render(makeState({ total: 0, query: "" }), "docs");
  assert.match(empty, /没有已删除的资料/);
  assert.doesNotMatch(empty, /没有匹配的已删除资料/);
  assert.doesNotMatch(empty, /trash-docs-clear-query/);

  // 只有空白搜索词也按“未搜索”处理。
  const blank = render(makeState({ total: 0, query: "   " }), "docs");
  assert.match(blank, /没有已删除的资料/);
});

test("移动来源的行渲染撤销移动而不是恢复，勾选与彻底删除仍保留", () => {
  const moved = deletedDoc("标准", "m1", {
    title: "已移走",
    movedTo: { kb: "目标库", docId: "t1", transferId: "abc123", at: "2026-10-02T00:00:00.000Z" },
  });
  const normal = deletedDoc("标准", "d1", { title: "普通删除" });
  const html = render(makeState({ docs: [moved, normal] }), "docs");

  assert.match(html, /data-action="trash-doc-undo-move" data-kb="标准" data-id="m1" data-target="目标库">撤销移动/);
  assert.doesNotMatch(html, /data-action="trash-doc-restore" data-kb="标准" data-id="m1"/);
  assert.match(html, /data-action="trash-doc-restore" data-kb="标准" data-id="d1">恢复/);
  // 已移动行仍可勾选（供批量彻底删除）与彻底删除。
  assert.match(html, /data-action="trash-doc-select" data-kb="标准" data-id="m1"/);
  assert.match(html, /data-action="trash-doc-purge" data-kb="标准" data-id="m1">彻底删除/);
});

test("目标副本已删除/缺失的移动行渲染恢复，批量只排除目标仍可用者", () => {
  const movedTo = { kb: "目标库", docId: "t1", transferId: "abc123", at: "2026-10-02T00:00:00.000Z" };
  const live = deletedDoc("标准", "m1", { title: "目标仍可用", movedTo, movedToState: "live" });
  const deleted = deletedDoc("标准", "m2", { title: "目标已删除", movedTo, movedToState: "deleted" });
  const missing = deletedDoc("标准", "m3", { title: "目标已缺失", movedTo, movedToState: "missing" });
  // 旧服务端没有 movedToState：安全默认仍是撤销移动。
  const legacy = deletedDoc("标准", "m4", { title: "旧服务端", movedTo });
  const normal = deletedDoc("标准", "d1", { title: "普通删除" });

  const html = render(makeState({ docs: [live, deleted, missing, legacy, normal] }), "docs");
  assert.match(html, /data-action="trash-doc-undo-move" data-kb="标准" data-id="m1" data-target="目标库">撤销移动/);
  assert.match(html, /data-action="trash-doc-undo-move" data-kb="标准" data-id="m4" data-target="目标库">撤销移动/);
  assert.match(html, /data-action="trash-doc-restore" data-kb="标准" data-id="m2">恢复/);
  assert.match(html, /data-action="trash-doc-restore" data-kb="标准" data-id="m3">恢复/);
  assert.doesNotMatch(html, /data-action="trash-doc-restore" data-kb="标准" data-id="m1"/);
  assert.match(html, /data-action="trash-doc-purge" data-kb="标准" data-id="m2">彻底删除/);

  // 旧选择项没带状态时以当前列表为准：live/legacy 排除，deleted/missing 与普通删除纳入恢复。
  const selected = [live, deleted, missing, legacy, normal].map((doc) => ({
    kb: doc.kb,
    id: doc.id,
    title: doc.title,
    ...(doc.movedTo ? { movedTo: { kb: doc.movedTo.kb } } : {}),
  }));
  const targets = trashRestoreTargets(selected, [live, deleted, missing, legacy, normal]);
  assert.deepEqual(targets.entries.map((entry) => entry.id), ["m2", "m3", "d1"]);
  assert.equal(targets.excluded, 2);

  const bar = renderTrashBulk({ selected, docs: [live, deleted, missing, legacy, normal], fmtNumber });
  assert.match(bar, /已选 5 篇/);
  assert.match(bar, /已排除 2 篇已移动资料，请在对应库中撤销移动/);
  assert.match(bar, /data-action="trash-docs-restore-selected">恢复所选/);
});

test("批量恢复排除已移动资料并提示，彻底删除仍可处理它们", () => {
  const moved = deletedDoc("标准", "m1", {
    title: "资料 m1",
    movedTo: { kb: "目标库", docId: "t1", transferId: "abc123" },
  });
  const normal = deletedDoc("标准", "d1", { title: "资料 d1" });
  const selected = [
    { kb: "标准", id: "m1", title: "资料 m1", movedTo: { kb: "目标库" } },
    { kb: "标准", id: "d1", title: "资料 d1" },
  ];

  const targets = trashRestoreTargets(selected, [moved, normal]);
  assert.deepEqual(targets.entries.map((entry) => entry.id), ["d1"]);
  assert.equal(targets.excluded, 1);
  // 旧选择项没带移动标记时，以当前列表为准。
  const stale = trashRestoreTargets([{ kb: "标准", id: "m1", title: "资料 m1" }], [moved]);
  assert.deepEqual(stale.entries, []);
  assert.equal(stale.excluded, 1);

  const bar = renderTrashBulk({ selected, docs: [moved, normal], fmtNumber });
  assert.match(bar, /已选 2 篇/);
  assert.match(bar, /已排除 1 篇已移动资料，请在对应库中撤销移动/);
  assert.match(bar, /data-action="trash-docs-restore-selected">恢复所选/);
  assert.match(bar, /data-action="trash-docs-purge-selected">彻底删除所选/);

  // 完整渲染同样把当前列表传给工具条（选择项本身可以没有 movedTo）。
  const page = render(makeState({
    docs: [moved, normal],
    selectedDocs: [{ kb: "标准", id: "m1", title: "资料 m1" }, { kb: "标准", id: "d1", title: "资料 d1" }],
  }), "docs");
  assert.match(page, /已选 2 篇/);
  assert.match(page, /已排除 1 篇已移动资料，请在对应库中撤销移动/);

  // 全选中的都是已移动资料：恢复禁用，但彻底删除仍可用。
  const onlyMoved = renderTrashBulk({
    selected: [{ kb: "标准", id: "m1", title: "资料 m1", movedTo: { kb: "目标库" } }],
    docs: [moved],
    fmtNumber,
  });
  assert.match(onlyMoved, /data-action="trash-docs-restore-selected" disabled>恢复所选/);
  assert.doesNotMatch(onlyMoved, /data-action="trash-docs-purge-selected" disabled/);
  assert.equal(trashPurgeTarget([selected[0]]).ok, true);
});

test("已删除资料为空时给出专门空状态", () => {
  const html = render(makeState({ total: 0 }), "docs");
  assert.match(html, /没有已删除的资料/);
  assert.match(html, /已删除的资料会先进入这里，可恢复或彻底删除。/);
  assert.match(html, /共 0 篇/);
  assert.doesNotMatch(html, /trash-docs-table/);
  assert.doesNotMatch(html, /trash-doc-select-all/);
});

test("超过 500 条时提示仅显示前 500 篇，未截断时不提示", () => {
  const truncated = render(makeState({
    docs: [deletedDoc("标准", "d1")],
    total: 501,
    truncated: true,
  }), "docs");
  assert.match(truncated, /仅显示前 500 篇/);
  assert.match(truncated, /class="badge warn"/);

  const exact = render(makeState({
    docs: [deletedDoc("标准", "d1")],
    total: 500,
    truncated: false,
  }), "docs");
  assert.doesNotMatch(exact, /仅显示前/);
});

test("已删除资料分区有独立的加载与错误态", () => {
  const loading = render(makeState({ loading: true, docs: [], total: 0 }), "docs");
  assert.match(loading, /已删除资料加载中…/);
  assert.doesNotMatch(loading, /没有已删除的资料/);

  const error = render(makeState({ docsError: "读取已删除资料 <失败>" }), "docs");
  assert.match(error, /class="state error"/);
  assert.match(error, /读取已删除资料 &lt;失败&gt;/);
  assert.match(error, /data-action="reload-trash">重试/);
  assert.doesNotMatch(error, /没有已删除的资料/);
});

test("勾选状态渲染为复选框 checked，不再把在用资料画进来", () => {
  const docs = [deletedDoc("标准", "d1"), deletedDoc("标准", "d2")];
  const html = render(makeState({
    docs,
    selectedDocs: [{ kb: "标准", id: "d1", title: "资料 d1" }],
  }), "docs");
  assert.match(html, /data-action="trash-doc-select" data-kb="标准" data-id="d1"[^>]* checked/);
  assert.match(html, /data-action="trash-doc-select" data-kb="标准" data-id="d2"(?![^>]*checked)/);
  assert.doesNotMatch(html, /data-action="trash-doc-select" data-kb="标准" data-id="d3"/);
  assert.doesNotMatch(html, /已选 2 篇/);
});

// ---------------------------------------------------------------------------
// 选择与批量操作
// ---------------------------------------------------------------------------

test("接口混入明确在用的资料时不渲染（防御性过滤）", () => {
  const html = render(makeState({
    docs: [
      deletedDoc("标准", "d1", { title: "已删除资料" }),
      deletedDoc("标准", "live", { title: "在用资料", deleted: false }),
    ],
    total: 1,
  }), "docs");
  assert.match(html, /<td>已删除资料<\/td>/);
  assert.doesNotMatch(html, /在用资料/);
  assert.doesNotMatch(html, /data-id="live"/);
});

test("sameTrashKb / trashSelectionKb 识别跨库选择", () => {
  assert.equal(sameTrashKb([]), true);
  assert.equal(trashSelectionKb([]), "");
  assert.equal(sameTrashKb([{ kb: "标准", id: "1" }]), true);
  assert.equal(trashSelectionKb([{ kb: "标准", id: "1" }, { kb: "标准", id: "2" }]), "标准");
  assert.equal(sameTrashKb([{ kb: "标准", id: "1" }, { kb: "乙库", id: "2" }]), false);
  assert.equal(trashSelectionKb([{ kb: "标准", id: "1" }, { kb: "乙库", id: "2" }]), "");
  // 缺库或缺 id 的脏数据不参与选择。
  assert.equal(sameTrashKb([{ kb: "", id: "1" }, { id: "2" }]), true);
});

test("trashSelectionToggleOne 按库+id 增删，不会把两个库的同 id 混为一篇", () => {
  const one = deletedDoc("标准", "d1", { title: "标准资料" });
  const other = deletedDoc("乙库", "d1", { title: "乙库资料" });

  const first = trashSelectionToggleOne([], one, true);
  assert.deepEqual(first, [{ kb: "标准", id: "d1", title: "标准资料" }]);
  assert.equal(trashSelectionHas(first, "标准", "d1"), true);
  assert.equal(trashSelectionHas(first, "乙库", "d1"), false);

  const second = trashSelectionToggleOne(first, other, true);
  assert.equal(second.length, 2);
  assert.equal(sameTrashKb(second), false);

  assert.deepEqual(trashSelectionToggleOne(second, one, false), [{ kb: "乙库", id: "d1", title: "乙库资料" }]);
  assert.deepEqual(trashSelectionToggleOne([], one), [{ kb: "标准", id: "d1", title: "标准资料" }]);
  assert.deepEqual(trashSelectionToggleOne(first, one), []);
  assert.deepEqual(trashSelectionToggleOne([], { kb: "", id: "x" }), []);
});

test("trashSelectionToggleAll 补齐当前列表，再点取消本列表并保留跨页选择", () => {
  const rows = [deletedDoc("标准", "d1"), deletedDoc("标准", "d2")];
  const all = trashSelectionToggleAll([], rows);
  assert.deepEqual(all.map((entry) => entry.id), ["d1", "d2"]);
  assert.equal(trashSelectionAllSelected(all, rows), true);

  assert.deepEqual(trashSelectionToggleAll(all, rows), []);

  const kept = trashSelectionToggleAll([{ kb: "标准", id: "d9", title: "跨页" }], rows);
  assert.deepEqual(kept.map((entry) => entry.id), ["d9", "d1", "d2"]);
  assert.equal(trashSelectionAllSelected(kept, rows), true);
  assert.equal(trashSelectionAllSelected([{ kb: "标准", id: "d9" }], rows), false);
  assert.equal(trashSelectionAllSelected([], []), false);
});

test("批量工具条：跨库选择同样可彻底删除，不再展示同库限制提示", () => {
  const same = renderTrashBulk({
    selected: [{ kb: "标准", id: "d1" }, { kb: "标准", id: "d2" }],
    fmtNumber,
  });
  assert.match(same, /已选 2 篇/);
  assert.match(same, /data-action="trash-docs-restore-selected">恢复所选/);
  assert.match(same, /data-action="trash-docs-purge-selected">彻底删除所选/);
  assert.match(same, /data-action="trash-doc-clear">取消选择/);

  const mixed = renderTrashBulk({
    selected: [{ kb: "标准", id: "d1" }, { kb: "乙库", id: "d2" }],
    fmtNumber,
  });
  assert.match(mixed, /data-action="trash-docs-purge-selected">彻底删除所选/);
  assert.doesNotMatch(mixed, /彻底删除一次只能处理同一个库的资料/);
  assert.equal((mixed.match(/disabled/g) ?? []).length, 0);

  // 完整页面同样把跨库选择交给批量工具条，按钮不禁用。
  const page = render(makeState({
    docs: [deletedDoc("标准", "d1"), deletedDoc("乙库", "d2")],
    selectedDocs: [
      { kb: "标准", id: "d1", title: "资料 d1" },
      { kb: "乙库", id: "d2", title: "资料 d2" },
    ],
  }), "docs");
  assert.match(page, /data-action="trash-docs-purge-selected">彻底删除所选/);
  assert.match(page, /已选 2 篇/);

  assert.equal(renderTrashBulk({ selected: [], fmtNumber }), "");
});

test("busy 时批量按钮与行内操作禁用，选择仍保留", () => {
  const state = makeState({
    docs: [deletedDoc("标准", "d1")],
    selectedDocs: [{ kb: "标准", id: "d1", title: "资料 d1" }],
    busy: true,
  });
  const html = render(state, "docs");
  assert.match(html, /data-action="trash-docs-restore-selected" disabled>恢复所选/);
  assert.match(html, /data-action="trash-docs-purge-selected" disabled>彻底删除所选/);
  assert.match(html, /data-action="trash-doc-clear" disabled>取消选择/);
  assert.match(html, /data-action="trash-doc-select-all"[^>]* disabled/);
  assert.match(html, /data-action="trash-doc-restore" data-kb="标准" data-id="d1" disabled>恢复/);
  assert.match(html, /data-action="trash-doc-purge" data-kb="标准" data-id="d1" disabled>彻底删除/);
});

// ---------------------------------------------------------------------------
// 彻底删除确认
// ---------------------------------------------------------------------------

test("purgeDocsConfirmBody 列出最多 10 个标题、总篇数与不可恢复警告", () => {
  const body = purgeDocsConfirmBody({
    docs: Array.from({ length: 25 }, (_, index) => ({ title: `资料 ${index + 1}` })),
  });
  assert.match(body, /^· 资料 1\n/);
  assert.match(body, /· 资料 10/);
  assert.doesNotMatch(body, /· 资料 11/);
  assert.match(body, /…等 25 篇/);
  assert.match(body, /共 25 篇/);
  assert.match(body, new RegExp(PURGE_DOCS_WARNING));
  // 警告与标题清单之间留空行。
  assert.match(body, /共 25 篇\n\n彻底删除会移除原件/);
});

test("purgeDocsConfirmBody 支持清空本库（只有 total）与零篇", () => {
  const all = purgeDocsConfirmBody({ total: 12 });
  assert.match(all, /^共 12 篇/);
  assert.doesNotMatch(all, /· /);
  assert.match(all, new RegExp(PURGE_DOCS_WARNING));

  const zero = purgeDocsConfirmBody({ total: 0 });
  assert.match(zero, /共 0 篇/);
  assert.match(zero, new RegExp(PURGE_DOCS_WARNING));

  const single = purgeDocsConfirmBody({ docs: [{ title: "唯一一篇" }], total: 1 });
  assert.match(single, /· 唯一一篇\n共 1 篇/);
});

test("trashPurgeTarget 只拒绝空选择；跨库选择允许并返回全部条目", () => {
  assert.deepEqual(trashPurgeTarget([]), {
    ok: false,
    kb: "",
    entries: [],
    reason: "请先选择要彻底删除的资料",
  });

  const mixed = trashPurgeTarget([
    { kb: "标准", id: "d1", title: "A" },
    { kb: "乙库", id: "d2", title: "B" },
  ]);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.kb, "");
  assert.deepEqual(mixed.entries.map((entry) => `${entry.kb}/${entry.id}`), ["标准/d1", "乙库/d2"]);
  assert.equal(mixed.reason, "");

  const same = trashPurgeTarget([
    { kb: "标准", id: "d1", title: "A" },
    { kb: "标准", id: "d2", title: "B" },
  ]);
  assert.equal(same.ok, true);
  assert.equal(same.kb, "标准");
  assert.deepEqual(same.entries.map((entry) => entry.id), ["d1", "d2"]);
  assert.equal(same.reason, "");
});

test("trashPurgePhrase 与跨库确认正文：库名:标题、最多 10 条、篇数/库数与警告", () => {
  assert.equal(trashPurgePhrase(3), "彻底删除 3 篇");
  assert.equal(trashPurgePhrase("2"), "彻底删除 2 篇");
  assert.equal(trashPurgePhrase(-1), "彻底删除 0 篇");
  assert.equal(trashPurgePhrase("bad"), "彻底删除 0 篇");

  const items = Array.from({ length: 12 }, (_, index) => ({
    kb: index % 2 === 0 ? "标准" : "乙库",
    id: `d${index + 1}`,
    title: `资料 ${index + 1}`,
  }));
  const body = renderTrashPurgeBody(items);
  assert.match(body, /^标准：资料 1\n乙库：资料 2\n/);
  assert.match(body, /标准：资料 9/);
  assert.match(body, /…等 12 篇/);
  assert.doesNotMatch(body, /资料 11/);
  assert.match(body, /共 12 篇，来自 2 个库/);
  assert.match(body, new RegExp(TRASH_PURGE_WARNING));
  assert.match(body, /共 12 篇，来自 2 个库\n\n彻底删除会移除原件/);

  const single = renderTrashPurgeBody([{ kb: "标准", id: "d1", title: "" }]);
  assert.match(single, /^标准：d1\n共 1 篇，来自 1 个库/);
  assert.match(single, new RegExp(TRASH_PURGE_WARNING));
});

// ---------------------------------------------------------------------------
// 转义
// ---------------------------------------------------------------------------

test("库名与标题在文本、属性和 aria-label 中都转义", () => {
  const html = render(makeState({
    docs: [deletedDoc('<标准&"库">', 'd&1', {
      title: '<script>alert("x")</script>',
      type: 'pdf<&>"',
    })],
  }), "docs");

  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /data-kb="&lt;标准&amp;&quot;库&quot;&gt;"/);
  assert.match(html, /data-id="d&amp;1"/);
  assert.match(html, /aria-label="选择 &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;"/);
  assert.match(html, /<span class="badge trash-kb-badge">&lt;标准&amp;&quot;库&quot;&gt;<\/span>/);
  assert.match(html, /pdf&lt;&amp;&gt;&quot;/);
});

test("归档库名称与不可恢复原因同样转义", () => {
  const html = render(makeState({
    archived: [archivedKb({
      name: '<旧库&"名">',
      restorable: false,
      reason: '<已合并>',
    })],
  }));
  assert.doesNotMatch(html, /<旧库&"名">/);
  assert.match(html, /&lt;旧库&amp;&quot;名&quot;&gt;/);
  assert.match(html, /不可恢复：&lt;已合并&gt;/);
});
