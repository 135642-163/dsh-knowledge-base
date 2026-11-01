/**
 * 0.36 P3 质量 tab 渲染：统计卡、快捷筛选、分组/证据/动作、勾选与预览、
 * 只读禁用、延迟加载、上次执行结果。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  QUALITY_QUICK_FILTERS,
  previewTargetText,
  qualityActionLabel,
  qualityBatchAction,
  qualityEvidence,
  qualityFilter,
  qualityFilterParams,
  qualityItemIds,
  qualitySelectionAll,
  qualitySelectionToggle,
  renderQualityLastResult,
  renderQualityPanel,
  renderQualityPreviewBody,
  severityMeta,
} from "../ui/views/quality.js";
import { renderDetail } from "../ui/views/detail.js";

const fmtNumber = (value) => new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
const icons = { upload: "", archive: "", search: "", chevron: "", database: "" };

function item(id, extra = {}) {
  return {
    docId: id,
    docIds: [id],
    title: `GB/T ${id}`,
    detail: "",
    docs: [{ id, title: `GB/T ${id}` }],
    ...extra,
  };
}

function group(code, extra = {}) {
  return {
    code,
    label: code,
    severity: "warning",
    section: "content",
    actionable: true,
    deferred: false,
    suggestedAction: null,
    allowedActions: [],
    hint: "",
    count: 1,
    matched: 1,
    offset: 0,
    limit: 50,
    returned: 1,
    truncated: false,
    items: [item("doc1")],
    ...extra,
  };
}

function makeReport(overrides = {}) {
  return {
    kb: "标准",
    readOnly: false,
    generatedAt: "2026-11-02T00:00:00.000Z",
    summary: {
      totalDocs: 10, readyDocs: 9, notes: 1, sources: 8, groups: 4,
      error: 0, warning: 2, info: 1, actionable: 2, actionableGroups: 2,
      deferred: 1, deferredItems: 4,
    },
    groups: [
      group("corrupted", {
        label: "文字层损坏 / OCR 低置信",
        suggestedAction: "reparse-pages",
        allowedActions: ["reparse-pages"],
        hint: "关键页用 kb_view 核对",
        count: 2,
        matched: 2,
        items: [
          item("c1", {
            title: "GB/T 31517.1-2022 固定式海上风力发电机组",
            detail: "损坏 3 页，低置信 0 页",
            pages: 119,
            badPages: [39, 40, 41],
            contentIntegrity: "full",
            trust: "high",
            summaryMissing: false,
            version: 2,
            updatedAt: "2026-10-01T00:00:00.000Z",
          }),
          item("c2", { title: "IEC 61000-4-30", badPages: [2], summaryMissing: true }),
        ],
      }),
      group("same-number", {
        label: "同标准号同期同阶段疑似重复",
        suggestedAction: "keep",
        allowedActions: ["keep", "remove"],
        count: 1,
        items: [
          {
            docId: "d1,d2",
            docIds: ["d1", "d2"],
            title: "GB/T 2000-2021 重复样本 / GB/T 2000-2021 重复样本（副本）",
            detail: "同号同期同阶段（2021 发布稿）",
            docs: [
              { id: "d1", title: "GB/T 2000-2021 重复样本" },
              { id: "d2", title: "GB/T 2000-2021 重复样本（副本）" },
            ],
          },
        ],
      }),
      group("unlabeled", {
        label: "未编目（没有一行摘要）",
        severity: "warning",
        suggestedAction: "describe",
        allowedActions: ["describe"],
        count: 1,
        items: [item("u1", { title: "GB/T 3000-2019 未编目", summaryMissing: true })],
      }),
      group("stale", {
        label: "旧管线产物（可选刷新）",
        severity: "info",
        actionable: false,
        deferred: true,
        count: 4,
        matched: 4,
        returned: 0,
        items: [],
      }),
    ],
    ...overrides,
  };
}

function makeState(patch = {}) {
  return {
    quality: {
      loading: false,
      error: "",
      data: makeReport(),
      filter: "",
      group: "",
      offset: 0,
      limit: 50,
      query: "",
      selected: [],
      selectionGroup: "",
      busy: false,
      lastResult: null,
      ...patch,
    },
  };
}

const detail = { kb: { name: "标准", readOnly: false, quality: {} } };

test("快捷筛选与接口参数映射", () => {
  assert.deepEqual(QUALITY_QUICK_FILTERS.map((item) => item.id), ["", "actionable", "corrupted", "unlabeled", "summary-noise"]);
  assert.equal(qualityFilter("corrupted"), "corrupted");
  assert.equal(qualityFilter("unknown"), "");
  assert.deepEqual(qualityFilterParams(""), {});
  assert.deepEqual(qualityFilterParams("actionable"), { actionable: "1" });
  assert.deepEqual(qualityFilterParams("summary-noise"), { group: "summary-noise" });
});

test("严重度与动作文案", () => {
  assert.equal(severityMeta("error").label, "错误");
  assert.equal(severityMeta("warning").className, "warn");
  assert.equal(severityMeta("info").icon, "ℹ");
  assert.equal(qualityActionLabel("reparse-pages"), "重解析坏页");
  assert.equal(qualityActionLabel("remove"), "软删除");
  assert.equal(qualityActionLabel("nope"), "nope");
});

test("明细 id 展开：单篇 / docIds / 旧逗号 docId", () => {
  assert.deepEqual(qualityItemIds({ docId: "a", docIds: ["a"] }), ["a"]);
  assert.deepEqual(qualityItemIds({ docId: "a,b", docIds: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(qualityItemIds({ docId: "a, b" }), ["a", "b"]);
  assert.deepEqual(qualityItemIds({}), []);
});

test("可批量动作：describe/不可操作/无动作都不批量", () => {
  assert.equal(qualityBatchAction({ actionable: true, suggestedAction: "reparse-pages" }), "reparse-pages");
  assert.equal(qualityBatchAction({ actionable: true, suggestedAction: "keep" }), "keep");
  assert.equal(qualityBatchAction({ actionable: true, suggestedAction: "describe" }), "", "摘要必须逐篇人工写");
  assert.equal(qualityBatchAction({ actionable: false, suggestedAction: "remove" }), "");
  assert.equal(qualityBatchAction({ actionable: true, suggestedAction: null }), "");
});

test("勾选：切换、整组选择、跨组时由调用方清空", () => {
  assert.deepEqual(qualitySelectionToggle([], ["a"], true), ["a"]);
  assert.deepEqual(qualitySelectionToggle(["a"], ["a"], false), []);
  assert.deepEqual(qualitySelectionToggle([], ["a", "b"], true), ["a", "b"]);
  assert.deepEqual(qualitySelectionToggle(["a"], ["a", "b"], undefined), ["a", "b"]);
  assert.deepEqual(qualitySelectionToggle(["a", "b"], ["a"], undefined), ["b"]);
  assert.deepEqual(qualitySelectionAll([{ docId: "a" }, { docId: "b,c" }, { docId: "a" }]), ["a", "b", "c"]);
});

test("证据文本：lint detail + 坏页 + 正文完整性 + 缺摘要", () => {
  const evidence = qualityEvidence(
    { detail: "损坏 3 页，低置信 0 页", badPages: [39, 40, 41], contentIntegrity: "full" },
    { code: "corrupted" }
  );
  assert.match(evidence, /损坏 3 页/);
  assert.match(evidence, /坏页 39,40,41/);
  assert.match(evidence, /正文 full/);
  assert.equal(qualityEvidence({ detail: "", summaryMissing: true }, { code: "summary-noise" }), "缺摘要");
  assert.equal(qualityEvidence({ detail: "" }, { code: "unlabeled" }), "—");
});

test("预览“将执行”：页码 / 整篇 OCR / 保留 / 可信度 / 软删除", () => {
  assert.equal(previewTargetText({ preview: { pages: [3, 5], forceReparse: true } }), "页码 3,5");
  assert.equal(previewTargetText({ preview: { forceOcr: true } }), "整篇 OCR");
  assert.equal(previewTargetText({ preview: { dedupKeep: true } }), "标记已核对保留");
  assert.equal(previewTargetText({ preview: { trust: "medium" } }), "可信度 medium");
  assert.equal(previewTargetText({ preview: { soft: true } }), "软删除");
  assert.equal(previewTargetText({}), "执行");
});

test("面板：统计卡、分组、证据、行内动作、延迟加载", () => {
  const html = renderQualityPanel(makeState(), detail, { fmtNumber });
  assert.match(html, /质量队列/);
  assert.match(html, /可操作/);
  assert.match(html, /警告/);
  assert.match(html, /延迟加载/);
  // 坏页组：标题、证据、查看原页（跳第 39 页）、重解析按钮
  assert.match(html, /GB\/T 31517.1-2022/);
  assert.match(html, /坏页 39,40,41/);
  assert.match(html, /data-action="quality-open"[^>]*data-page="39"/);
  assert.match(html, /data-action="quality-act"[^>]*data-act="reparse-pages"/);
  // 重复组：多篇列在一个明细里，提供 keep/remove
  assert.match(html, /GB\/T 2000-2021 重复样本（副本）/);
  assert.match(html, /data-act="keep"/);
  assert.match(html, /data-act="remove"/);
  // 未编目组：不给批量勾选，直接打开资料弹窗补摘要
  assert.doesNotMatch(html, /data-action="quality-select"[^>]*data-code="unlabeled"/);
  assert.match(html, /data-action="open-doc"[^>]*>补摘要</);
  // 旧管线组：默认不返回明细，给“加载明细”
  assert.match(html, /data-action="quality-group" data-code="stale"/);
  assert.match(html, /加载明细/);
});

test("面板：只读库禁用动作与勾选并提示", () => {
  const html = renderQualityPanel(makeState(), { kb: { name: "标准", readOnly: true } }, { fmtNumber });
  assert.match(html, /只读共享：可以查看与筛选，动作已禁用/);
  assert.doesNotMatch(html, /data-action="quality-act"/);
  assert.doesNotMatch(html, /data-action="quality-select"/);
  assert.doesNotMatch(html, /全选本组/);
});

test("面板：勾选后出现操作栏；不同动作组的按钮文案不同", () => {
  const corrupt = renderQualityPanel(
    makeState({ selected: ["c1"], selectionGroup: "corrupted" }),
    detail,
    { fmtNumber }
  );
  assert.match(corrupt, /已选 1 篇/);
  assert.match(corrupt, /预览并执行：重解析坏页/);
  assert.match(corrupt, /data-action="quality-preview"[^>]*data-act="reparse-pages"/);

  const dup = renderQualityPanel(
    makeState({ selected: ["d1", "d2"], selectionGroup: "same-number" }),
    detail,
    { fmtNumber }
  );
  assert.match(dup, /已选 2 篇/);
  assert.match(dup, /预览并执行：标记保留/);
});

test("面板：聚焦某组时显示分页与返回全部；快捷筛选高亮", () => {
  const focused = makeReport();
  focused.groups = [group("corrupted", {
    label: "文字层损坏 / OCR 低置信",
    suggestedAction: "reparse-pages",
    allowedActions: ["reparse-pages"],
    count: 120,
    matched: 120,
    returned: 50,
    limit: 50,
    items: [item("c1", { badPages: [2] })],
  })];
  const html = renderQualityPanel(
    makeState({ data: focused, group: "corrupted", filter: "corrupted" }),
    detail,
    { fmtNumber }
  );
  assert.match(html, /只看/);
  assert.match(html, /data-action="quality-page"[^>]*data-offset="50"/);
  assert.match(html, /共 120 条/);
  assert.match(html, /data-action="quality-filter" data-filter=""[^>]*>返回全部组/);
  assert.match(html, /class="seg active" data-action="quality-filter" data-filter="corrupted"/);
});

test("面板：空数据/加载/错误/搜索无结果", () => {
  const loading = renderQualityPanel({ quality: { loading: true, data: null } }, detail, { fmtNumber });
  assert.match(loading, /正在体检/);
  const error = renderQualityPanel({ quality: { error: "请求失败", data: null } }, detail, { fmtNumber });
  assert.match(error, /请求失败/);
  assert.match(error, /data-action="quality-reload"/);
  const empty = makeReport({ groups: [] });
  const html = renderQualityPanel(makeState({ data: empty, query: "无结果" }), detail, { fmtNumber });
  assert.match(html, /没有发现机械问题/);
  assert.match(html, /无结果/);
});

test("预览弹窗正文：逐篇预览、跳过原因、转义", () => {
  const html = renderQualityPreviewBody({
    action: "reparse-pages",
    valid: 1,
    invalid: 1,
    hint: "表格页不要反复 OCR",
    items: [{ id: "c1", title: "GB/T <script>", badPages: [39], preview: { pages: [39], forceReparse: true } }],
    errors: [{ id: "x1", title: "没有原件的资料", error: "sources/ 中没有原始文件" }],
  });
  assert.match(html, /将执行 <strong>重解析坏页<\/strong>/);
  assert.match(html, /GB\/T &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /页码 39/);
  assert.match(html, /sources\/ 中没有原始文件/);
  assert.match(html, /表格页不要反复 OCR/);
});

test("上次执行结果：逐项成功/失败", () => {
  const html = renderQualityLastResult({
    action: "reparse-pages",
    ok: 1,
    failed: 1,
    results: [
      { id: "c1", ok: true, title: "GB/T 31517.1-2022" },
      { id: "c2", ok: false, title: "IEC 61000-4-30", error: "OCR 失败" },
    ],
  });
  assert.match(html, /上次执行：重解析坏页/);
  assert.match(html, /成功 1 篇 · 失败 1 篇/);
  assert.match(html, /✓ GB\/T 31517.1-2022/);
  assert.match(html, /✗ IEC 61000-4-30：OCR 失败/);
  assert.equal(renderQualityLastResult(null), "");
});

test("库详情：质量 tab 存在并渲染面板", () => {
  const state = {
    detailLoading: false,
    detailError: "",
    detail: {
      kb: {
        name: "标准",
        status: "ok",
        description: "",
        tags: [],
        docs: { ready: 1, importing: 0, failed: 0, notes: 0, deleted: 0 },
        pages: 10,
        chars: 100,
        updatedAt: "2026-10-01T00:00:00.000Z",
        quality: { corruptedDocs: 2, contentIncomplete: 1, summaryNoise: 0, unlabeled: 1 },
      },
      health: { failed: 0, importing: 0, lowConfidenceDocs: 0, corruptedDocs: 2, hasSchema: true },
      recentDocs: [],
      schema: { exists: true },
      index: { exists: true },
      logTail: "",
    },
    ...makeState(),
  };
  const html = renderDetail(state, { page: "detail", name: "标准", tab: "quality" }, { icons, fmtNumber });
  assert.match(html, /href="#\/kb\/%E6%A0%87%E5%87%86\/quality">质量</);
  assert.match(html, /质量队列/);
  // 头部质量徽标（坏页 2 · 不完整 1 · 未编目 1）
  assert.match(html, /title="质量队列：坏页 2 · 不完整 1 · 未编目 1"/);
});
