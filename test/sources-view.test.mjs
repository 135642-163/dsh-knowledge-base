/**
 * 来源纯函数：链接、标签、去重。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dedupeSources, sourceHref, sourceLabel } from "../ui/sources-view.js";

test("sourceHref 使用 deepLink 或按字段重建", () => {
  assert.equal(sourceHref({ deepLink: "/kb/?doc=d1", docId: "d1" }), "/kb/?doc=d1");
  const href = sourceHref({ kb: "标准", docId: "d1", page: 12, clause: "5.2.2" });
  assert.match(href, /^\/kb\/\?/);
  const url = new URL(href, "http://dsh.internal");
  assert.equal(url.searchParams.get("kb"), "标准");
  assert.equal(url.searchParams.get("doc"), "d1");
  assert.equal(url.searchParams.get("page"), "12");
  assert.equal(url.searchParams.get("clause"), "5.2.2");
  assert.equal(sourceHref({}), "");
});

test("sourceLabel 组合标题/条款/页码/库", () => {
  assert.equal(
    sourceLabel({ title: "GB/T 1-2020", clause: "5.2.2", page: 12, kb: "标准" }),
    "GB/T 1-2020 · 第 5.2.2 条 · 第 12 页 · 来自 标准"
  );
});

test("dedupeSources 按 kb/doc/page/clause 去重并截断", () => {
  const list = dedupeSources([
    { kb: "标准", docId: "d1", page: 1, clause: "1" },
    { kb: "标准", docId: "d1", page: 1, clause: "1" },
    { kb: "标准", docId: "d1", page: 2 },
    { kb: "标准", docId: "d2" },
  ], 2);
  assert.equal(list.length, 2);
  assert.equal(list[0].docId, "d1");
  assert.equal(list[1].page, 2);
});
