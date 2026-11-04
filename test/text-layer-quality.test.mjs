/**
 * 0.5.0 文字层质量与逐页 OCR 决策。
 * 目标：只对损坏/稀薄的页 OCR，不再需要整本 forceOcr。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  INK_RATIO_THRESHOLD,
  formatPageList,
  looksLikeBlankOcrText,
  shouldOcrPage,
  templateTextPages,
  textLayerQuality,
} from "../lib/parsers.js";

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
    true
  );
});


test("page list formatting does not duplicate the unit", () => {
  assert.equal(formatPageList([1, 2]), "第 1、2 页");
  assert.equal(
    formatPageList(Array.from({ length: 12 }, (_, i) => i + 1)),
    "第 1、2、3、4、5、6、7、8、9、10 等 12 页"
  );
});

test("forceOcr 对 chars/images 都为 0 的矢量页也强制 OCR", () => {
  assert.equal(
    shouldOcrPage({ chars: 0, images: 0 }, { forceOcr: true, pageNo: 2 }),
    true
  );
  assert.equal(
    shouldOcrPage({ chars: 0, images: 0 }, { threshold: 50, pageNo: 2 }),
    false
  );
});

test("templateTextPages 识别「每页只剩同一段水印」的页", () => {
  const watermark = "免费标准网(www.freebz.net)标准最全面免费标准网(www.freebz.net)无需注册即可下载";
  const pages = Array.from({ length: 8 }, () => ({
    lines: [{ text: watermark }],
    chars: watermark.length,
  }));
  const hit = templateTextPages(pages);
  assert.equal(hit.size, 8);
  assert.ok(hit.has(1) && hit.has(8));
});

test("templateTextPages 不误伤：正文不同、或模板串太长", () => {
  const normal = [
    { lines: [{ text: "第1章 总则 本标准规定了标准电压的值" }] },
    { lines: [{ text: "第2章 术语和定义 本标准采用下列术语" }] },
    { lines: [{ text: "第3章 标准电压 供电系统标称电压" }] },
  ];
  assert.equal(templateTextPages(normal).size, 0);

  const longRepeat = "甲".repeat(260);
  const longPages = Array.from({ length: 6 }, () => ({ lines: [{ text: longRepeat }] }));
  assert.equal(templateTextPages(longPages).size, 0);

  assert.equal(templateTextPages([{ lines: [{ text: "只有一页" }] }]).size, 0);
});

test("墨迹复核过的页（inkedPages）即使文字层够长也要 OCR", () => {
  const watermark = { chars: 55, images: 0, quality: { bad: false } };
  assert.equal(shouldOcrPage(watermark, { threshold: 50, pageNo: 1 }), false);
  assert.equal(
    shouldOcrPage(watermark, { threshold: 50, pageNo: 1, inkedPages: new Set([1]) }),
    true
  );
  // 显式跳过仍然优先
  assert.equal(
    shouldOcrPage(watermark, { threshold: 50, pageNo: 1, inkedPages: new Set([1]), skipPages: new Set([1]) }),
    false
  );
  assert.ok(INK_RATIO_THRESHOLD > 0 && INK_RATIO_THRESHOLD < 0.05);
});

test("looksLikeBlankOcrText: 空白页只剩水印/页码时不报低置信", () => {
  assert.equal(looksLikeBlankOcrText(""), true);
  assert.equal(looksLikeBlankOcrText("SIC"), true);
  assert.equal(looksLikeBlankOcrText("  5 \n"), true);
  assert.equal(looksLikeBlankOcrText("第 3 页"), true);
  assert.equal(looksLikeBlankOcrText("www.get17.cn"), true);
  assert.equal(looksLikeBlankOcrText("扫描件"), true);
  // 真正的短页/正文不能被当成空白
  assert.equal(looksLikeBlankOcrText("3.1 总则"), false);
  assert.equal(looksLikeBlankOcrText("本标准适用于 10kV 配电系统。"), false);
  assert.equal(looksLikeBlankOcrText("© 2020 中国电力出版社"), false);
});

test("textLayerQuality: 拉丁-1 乱码页（Ð ª Ë ² ÷）判为损坏，法语/中文正常页不误判", () => {
  const mojibake = "Ð ª Ë ñ ² Í À Ð µ ê ¼ ç ø ¯ ú À ³ ¨ ç ¹ û ä Ê Æ ã õ þ Í ½ ¨ ¾ ê ¼ æ ¨ Ë ç ø ¯ ú À ë ç ¦ µ ³ « ² ¬ Ó ã ç ¹ û ä Ê Ä Æ ã õ þ Í ½ ¨ ¾ ê ¼ ç ø ¯ ú À ë ç ¦ µ ³ « ² ¬ Ó ã ç ¹ û ä Ê Ä Æ ã õ þ Í ½ ¨ ¾ ê ¼".repeat(2);
  const q = textLayerQuality(mojibake);
  assert.equal(q.latin1Mojibake, true);
  assert.equal(q.bad, true);

  const french = "Aucune partie de cette publication ne peut être reproduite ni utilisée sous quelque forme que ce soit et par aucun procédé, électronique ou mécanique, y compris la photocopie et les microfilms, sans l'accord écrit de l'éditeur.";
  assert.equal(textLayerQuality(french).latin1Mojibake, false);
  assert.equal(textLayerQuality(french).bad, false);

  const chinese = "本标准适用于 10kV 配电系统，电压偏差 ±7%，频率偏差 ±0.2Hz。".repeat(4);
  assert.equal(textLayerQuality(chinese).bad, false);
});

test("looksLikeBlankOcrText: 全大写水印/机构缩写（SAIC/SZIG/IEEE）也算空白页", () => {
  assert.equal(looksLikeBlankOcrText("SAIC"), true);
  assert.equal(looksLikeBlankOcrText("SZIG"), true);
  assert.equal(looksLikeBlankOcrText("IEEE"), true);
  assert.equal(looksLikeBlankOcrText("IEEE Std"), false);
});
