/**
 * 本地 OCR 表格重建：规则表格 → HTML；条款列表不误判。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ocrTableLayout, groupOcrRows } from "../lib/table-layout.js";

function line(text, x1, y1, x2, y2) {
  return { text, box: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]] };
}

test("规则表格重建为 HTML，并保留表格前后的正文", () => {
  const lines = [
    line("标题", 110, 100, 800, 130),
    line("项目", 108, 503, 159, 534),
    line("技术要求", 559, 504, 658, 532),
    line("备注", 896, 501, 953, 534),
    line("有功功率变化率", 108, 546, 280, 578),
    line("≤10%额定功率/min", 562, 546, 776, 576),
    line("1 min平均值", 897, 545, 1043, 579),
    line("电压偏差", 108, 592, 208, 620),
    line("0.97～1.07 p.u.", 559, 590, 728, 623),
    line("并网点", 897, 591, 975, 623),
    line("频率范围", 109, 637, 207, 665),
    line("48.5～50.5 Hz", 561, 637, 710, 664),
    line("连续运行", 898, 636, 999, 667),
    line("注：表格结束。", 109, 700, 500, 730),
  ];
  const laid = ocrTableLayout(lines);
  assert.ok(laid);
  assert.equal(laid.tables, 1);
  assert.match(laid.text, /^标题/);
  assert.match(laid.text, /<table><tr><td>项目<\/td><td>技术要求<\/td><td>备注<\/td><\/tr>/);
  assert.match(laid.text, /<td>有功功率变化率<\/td>/);
  assert.match(laid.text, /注：表格结束/);
});

test("两列但列不对齐的长文本不判为表格", () => {
  const lines = [
    line("1 范围", 100, 100, 600, 130),
    line("本文件规定了海上风电场的接入要求。", 120, 140, 900, 170),
    line("2 规范性引用文件", 100, 180, 700, 210),
    line("下列文件中的内容通过文中的规范性引用而构成本文件必不可少的条款。", 120, 220, 1100, 250),
    line("3 术语和定义", 100, 260, 600, 290),
  ];
  assert.equal(ocrTableLayout(lines), null);
});

test("行聚类的容差按中位行高计算", () => {
  const rows = groupOcrRows([
    line("A", 100, 100, 120, 120),
    line("B", 300, 104, 320, 124),
    line("C", 100, 200, 120, 220),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cells.length, 2);
  assert.equal(rows[1].cells.length, 1);
});
