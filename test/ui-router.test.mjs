import test from "node:test";
import assert from "node:assert/strict";
import { parseHash, hrefForKb, hrefForTrash } from "../ui/router.js";

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

test("hrefForTrash", () => {
  assert.equal(hrefForTrash(), "#/trash");
});

test("hrefForKb encodes name", () => {
  assert.equal(hrefForKb("标准", "docs"), "#/kb/%E6%A0%87%E5%87%86/docs");
});
