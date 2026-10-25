import test from "node:test";
import assert from "node:assert/strict";
import { parseHash, hrefForKb, hrefForSearch, hrefForTrash } from "../ui/router.js";

test("empty hash is overview", () => {
  assert.deepEqual(parseHash(""), { page: "overview", query: {} });
});

test("kb detail hash carries name and tab", () => {
  assert.deepEqual(parseHash("#/kb/%E6%A0%87%E5%87%86/docs"), {
    page: "detail",
    name: "标准",
    tab: "docs",
    query: {},
  });
});

test("unknown hash falls back to overview", () => {
  assert.equal(parseHash("#/nope").page, "overview");
});

test("trash hash is its own page", () => {
  assert.deepEqual(parseHash("#/trash"), { page: "trash", query: {} });
});

test("trash hash carries the tab query", () => {
  assert.deepEqual(parseHash("#/trash?tab=docs"), { page: "trash", query: { tab: "docs" } });
});

test("hrefForTrash", () => {
  assert.equal(hrefForTrash(), "#/trash");
});

test("hrefForKb encodes name", () => {
  assert.equal(hrefForKb("标准", "docs"), "#/kb/%E6%A0%87%E5%87%86/docs");
});

test("search hash is its own page and keeps conditions", () => {
  assert.deepEqual(parseHash("#/search"), { page: "search", query: {} });
  assert.deepEqual(parseHash("#/search?q=%E7%94%B5%E5%8E%8B&trust=high"), {
    page: "search",
    query: { q: "电压", trust: "high" },
  });
});

test("hrefForSearch encodes conditions and skips empty ones", () => {
  assert.equal(hrefForSearch({}), "#/search");
  assert.equal(
    hrefForSearch({ q: "电压偏差", kb: "标准", tag: "并网", type: "pdf-text", trust: "high" }),
    `#/search?kb=${encodeURIComponent("标准")}&tag=${encodeURIComponent("并网")}&type=pdf-text&trust=high&q=${encodeURIComponent("电压偏差")}`,
  );
  assert.equal(hrefForSearch({ q: "  电压  " }), `#/search?q=${encodeURIComponent("电压")}`);
});
