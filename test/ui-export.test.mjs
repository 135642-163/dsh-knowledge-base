/**
 * 导出弹窗选项与概览入口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { exportOptionBody } from "../ui/views/export.js";
import { renderOverview } from "../ui/views/overview.js";

const icons = { upload: "", archive: "", search: "", chevron: "", database: "", plus: "" };
const fmtNumber = (value) => String(value ?? 0);

test("导出选项映射到 format/includeSources", () => {
  assert.deepEqual(exportOptionBody("zip"), { format: "zip", includeSources: false });
  assert.deepEqual(exportOptionBody("zip-sources"), { format: "zip", includeSources: true });
  assert.deepEqual(exportOptionBody("md"), { format: "md" });
  assert.deepEqual(exportOptionBody("zip", ["d1", "d2"]), { format: "zip", includeSources: false, docIds: ["d1", "d2"] });
});

test("概览页有导入/导出知识库入口", () => {
  const state = {
    kbs: [],
    filter: "all",
    query: "",
    server: { kbRoot: "/tmp/kb" },
  };
  const html = renderOverview(state, { icons, fmtNumber });
  assert.match(html, /data-action="import-package"/);
  assert.match(html, /data-action="export-kb"/);
  assert.match(html, /导入知识库包/);
  assert.match(html, /导出知识库/);
});
