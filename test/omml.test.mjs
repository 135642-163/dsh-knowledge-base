/**
 * OMML → LaTeX 常用结构。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ommlToLatex } from "../lib/omml.js";

const wrap = (body) =>
  `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${body}</m:oMath>`;

test("fraction", async () => {
  const r = await ommlToLatex(
    wrap('<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>')
  );
  assert.equal(r.latex, "\\frac{1}{2}");
});

test("superscript and subscript", async () => {
  const sup = await ommlToLatex(
    wrap('<m:sSup><m:e><m:r><m:t>E</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>')
  );
  assert.equal(sup.latex, "{E}^{2}");
  const sub = await ommlToLatex(
    wrap('<m:sSub><m:e><m:r><m:t>U</m:t></m:r></m:e><m:sub><m:r><m:t>n</m:t></m:r></m:sub></m:sSub>')
  );
  assert.equal(sub.latex, "{U}_{n}");
});

test("sum with limits", async () => {
  const r = await ommlToLatex(
    wrap(
      '<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub><m:r><m:t>i=1</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup><m:e><m:r><m:t>x</m:t></m:r></m:e></m:nary>'
    )
  );
  assert.equal(r.latex, "\\sum_{i=1}^{n} x");
});

test("delimiter and escaping", async () => {
  const d = await ommlToLatex(
    wrap('<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e><m:r><m:t>a+b</m:t></m:r></m:e></m:d>')
  );
  assert.equal(d.latex, "\\left(a+b\\right)");
  const pct = await ommlToLatex(wrap('<m:r><m:t>50%</m:t></m:r>'));
  assert.equal(pct.latex, "50\\%");
  const cn = await ommlToLatex(wrap('<m:r><m:t>电压</m:t></m:r>'));
  assert.equal(cn.latex, "\\text{电压}");
});

test("matrix and accent", async () => {
  const m = await ommlToLatex(
    wrap(
      '<m:m><m:mr><m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:mr><m:mr><m:e><m:r><m:t>c</m:t></m:r></m:e><m:e><m:r><m:t>d</m:t></m:r></m:e></m:mr></m:m>'
    )
  );
  assert.match(m.latex, /\\begin\{matrix\} a & b \\\\ c & d \\end\{matrix\}/);
  const acc = await ommlToLatex(
    wrap('<m:acc><m:accPr><m:chr m:val="^"/></m:accPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:acc>')
  );
  assert.equal(acc.latex, "\\hat{x}");
});
