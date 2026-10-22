/**
 * Excel (.xlsx/.xlsm) 导入：工作表 → Markdown 表格，共享字符串/富文本/公式缓存值。
 */
import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { convertXlsx, kindForPath } from "../lib/parsers.js";

async function workbookBuffer() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="参数" sheetId="1" r:id="rId1"/><sheet name="第二表" sheetId="2" r:id="rId2"/><sheet name="隐藏" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>`
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>设备</t></si><si><t>电压</t></si><si><r><t>海</t></r><r><t>缆</t></r></si></sst>`
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>220</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>备注</t></is></c><c r="B3" t="str"><f>CONCAT(&quot;a&quot;,&quot;b&quot;)</f><v>ok</v></c></row></sheetData></worksheet>`
  );
  zip.file(
    "xl/worksheets/sheet2.xml",
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>单列</t></is></c></row><row r="2"><c r="A2"><v>1</v></c></row><row r="3"><c r="A3" t="str"><f>1+1</f><v></v></c></row></sheetData></worksheet>`
  );
  zip.file(
    "xl/worksheets/sheet3.xml",
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`
  );
  return await zip.generateAsync({ type: "nodebuffer" });
}

test("xlsx conversion builds Markdown tables per sheet", async () => {
  const r = await convertXlsx(await workbookBuffer());
  assert.equal(r.sections.length, 2);
  assert.equal(r.sections[0].heading, "工作表：参数");
  assert.match(r.sections[0].text, /\| 设备 \| 电压 \|/);
  assert.match(r.sections[0].text, /\| 海缆 \| 220 \|/);
  assert.match(r.sections[0].text, /\| 备注 \| ok \|/);
  assert.equal(r.sections[1].heading, "工作表：第二表");
  assert.match(r.sections[1].text, /\| 单列 \|/);
  assert.match(r.sections[1].text, /\| 1 \|/);
  assert.match(r.sections[1].text, /\| =1\+1 \|/);
  assert.ok(r.warnings.some((w) => w.includes("隐藏")));
});

test("xlsx extension is recognized", () => {
  assert.equal(kindForPath("参数.xlsx"), "xlsx");
  assert.equal(kindForPath("宏.xlsm"), "xlsx");
});
