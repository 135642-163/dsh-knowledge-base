/**
 * docx OMML 公式：mammoth 不解析 OMML，插件用占位符原位恢复为 LaTeX。
 */
import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { convertDocx } from "../lib/parsers.js";

async function docxWithMath() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>
      <w:p><w:r><w:t>能量公式：</w:t></w:r><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p>
      <w:p><m:oMathPara><m:oMath><m:r><m:t>E=m</m:t></m:r><m:sSup><m:e><m:r><m:t>c</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></m:oMathPara></w:p>
      <w:p><w:r><w:t>结束。</w:t></w:r></w:p>
    </w:body></w:document>`
  );
  return await zip.generateAsync({ type: "nodebuffer" });
}

test("docx formulas become LaTeX at their original position", async () => {
  const r = await convertDocx(await docxWithMath());
  const text = r.sections.map((s) => s.text).join("\n");
  assert.match(text, /\\frac\{1\}\{2\}/);
  assert.match(text, /\$\\frac\{1\}\{2\}\$/);
  assert.match(text, /E=m\{c\}\^\{2\}/);
  assert.match(text, /\$\$\nE=m\{c\}\^\{2\}\n\$\$/);
  assert.doesNotMatch(text, /⟦[DI]MATH/);
  assert.ok(r.warnings.some((w) => w.includes("公式")));
});
