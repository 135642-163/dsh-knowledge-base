import test from "node:test";
import assert from "node:assert/strict";
import { zipStreamOptions } from "../lib/zip-options.js";

test("KB zip 导出启用 ZIP64，避免 >4GB 时 JSZip 报错", () => {
  const opts = zipStreamOptions();
  assert.equal(opts.zip64, true);
  assert.equal(opts.streamFiles, true);
  assert.equal(opts.compression, "DEFLATE");
});
