/**
 * 检索路径判定：标准号查询必须留给 expandStdQuery + ripgrep，保持 GB ≠ GB/T。
 * 背景：0.26 的 plainFtsQuery 只识别 `GB 1234` 这类形态，`GB/T 1234` 会走 FTS，
 * 而 FTS 的 token OR 查询让 `gb` 命中几乎所有标准（见 0.27 spec §3.3）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldUseFts } from "../lib/query.js";

test("标准号查询不走 FTS（GB ≠ GB/T）", () => {
  const standardQueries = [
    "GB 1234",
    "GB/T 1234",
    "GBT 1234",
    "GB_T 1234",
    "GB∕T 1234", // U+2215
    "GB/T 19963.2-2024",
    "GB/Z 17625.3",
    "DL/T 587",
    "DL/Z 460",
    "NB/T 31005",
    "JB/T 7113",
    "Q/GDW 651",
    "Q/GDW 10650.1",
    "T/CEC 123",
    "IEC 61000-4-30",
    "ＧＢ／Ｔ 1234", // 全角
  ];
  for (const query of standardQueries) {
    assert.equal(shouldUseFts(query), false, `${query} 应走精确正则路径`);
  }
});

test("普通中文短语仍走 FTS", () => {
  for (const query of ["电压偏差", "谐波电流", "风电场接入", "三相电压不平衡度"]) {
    assert.equal(shouldUseFts(query), true, `${query} 应走 FTS`);
  }
});

test("显式正则与条款号不走 FTS（含元字符，交给 ripgrep）", () => {
  for (const query of ["GB/T \\d+", "电压|谐波", "5\\.2\\.2", "5.2.2", "^5\\."]) {
    assert.equal(shouldUseFts(query), false, `${query} 含正则语法，保持原样检索`);
  }
});

test("只是以标准号前缀开头、没有数字骨架的说明文字仍走 FTS", () => {
  assert.equal(shouldUseFts("GB 标准编号规则"), true);
  assert.equal(shouldUseFts("DL 电力行业标准"), true);
});

test("空查询不进 FTS（由调用方报错）", () => {
  assert.equal(shouldUseFts(""), false);
  assert.equal(shouldUseFts("   "), false);
  assert.equal(shouldUseFts(undefined), false);
});
