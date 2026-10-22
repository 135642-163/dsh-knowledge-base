/**
 * 0.5.0 文字层质量与逐页 OCR 决策。
 * 目标：只对损坏/稀薄的页 OCR，不再需要整本 forceOcr。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatPageList, shouldOcrPage, textLayerQuality } from "../lib/parsers.js";

test("normal Chinese text is not corrupted", () => {
  const q = textLayerQuality("电能质量 供电电压偏差 第5.2.2条");
  assert.equal(q.bad, false);
  assert.equal(q.replacement, 0);
  assert.equal(q.latinCjk, 0);
});

test("replacement characters mark a page as corrupted", () => {
  const q = textLayerQuality(`${"\uFFFD".repeat(80)}电能质量`);
  assert.equal(q.bad, true);
  assert.ok(q.replacement >= 3);
});

test("Latin letters mapped to CJK ideographs mark a page as corrupted", () => {
  const q = textLayerQuality("犌犅／犜 12325-2008 电能质量");
  assert.equal(q.bad, true);
  assert.ok(q.latinCjk >= 2);
});

test("private-use punctuation E011/E012 is ignored, other PUA is not", () => {
  assert.equal(textLayerQuality("电能质量\uE011供电电压\uE012偏差").bad, false);
  assert.equal(textLayerQuality(`电能质量${"\uE013".repeat(5)}`).bad, true);
});

test("shouldOcrPage only OCRs empty-low or corrupted pages", () => {
  const base = { chars: 100, images: 0, quality: { bad: false } };
  assert.equal(shouldOcrPage(base, { threshold: 50 }), false);
  assert.equal(shouldOcrPage({ ...base, chars: 10 }, { threshold: 50 }), true);
  assert.equal(shouldOcrPage({ ...base, quality: { bad: true } }, { threshold: 50 }), true);
  assert.equal(shouldOcrPage({ chars: 0, images: 0, quality: { bad: false } }, { threshold: 50 }), false);
});

test("explicit page sets override the heuristic", () => {
  const page = { chars: 100, images: 0, quality: { bad: false } };
  assert.equal(
    shouldOcrPage(page, { threshold: 50, forcePages: new Set([1]), pageNo: 1 }),
    true
  );
  assert.equal(
    shouldOcrPage(
      { ...page, quality: { bad: true } },
      { threshold: 50, skipPages: new Set([2]), pageNo: 2 }
    ),
    false
  );
  assert.equal(shouldOcrPage(page, { threshold: 50, forceOcr: true, pageNo: 3 }), true);
  assert.equal(
    shouldOcrPage({ chars: 0, images: 0 }, { threshold: 50, forceOcr: true, pageNo: 3 }),
    false
  );
});


test("page list formatting does not duplicate the unit", () => {
  assert.equal(formatPageList([1, 2]), "第 1、2 页");
  assert.equal(
    formatPageList(Array.from({ length: 12 }, (_, i) => i + 1)),
    "第 1、2、3、4、5、6、7、8、9、10 等 12 页"
  );
});
