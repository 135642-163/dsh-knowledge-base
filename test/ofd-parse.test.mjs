/**
 * OFD 版式文档解析：坐标重排、行聚类、空格规则、CTM 膨胀字号、图片页告警。
 *
 * 测试用 OFD 全部现场构造（真实公文不进仓库），只覆盖解析口径本身；
 * 真实样本（/Volumes/home/工作/OFD）由 dev/ofd-probe.mjs 人工核对。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { convertOfd, preScanOfdPages } from "../lib/parsers.js";
import { importFileInto } from "../lib/pipeline.js";
import { readManifest } from "../lib/store.js";

const OFD_NS = "http://www.ofdspec.org/2016";

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 一个 TextObject（Boundary 用页面坐标，X/Y/Size/DeltaX 用对象坐标）。 */
function textObject(spec, id) {
  const attrs = [`ID="${id}"`, `Boundary="${spec.boundary.join(" ")}"`];
  if (spec.size !== undefined) attrs.push(`Size="${spec.size}"`);
  if (spec.ctm) attrs.push(`CTM="${spec.ctm}"`);
  const code = [`X="${spec.x ?? 0}"`, `Y="${spec.y ?? 0}"`];
  if (spec.deltaX) code.push(`DeltaX="${spec.deltaX}"`);
  return `<ofd:TextObject ${attrs.join(" ")}><ofd:TextCode ${code.join(" ")}>${escapeXml(spec.text)}</ofd:TextCode></ofd:TextObject>`;
}

/** 按 { textObjects, images } 拼一页的 Content.xml。 */
function pageXml({ textObjects = [], images = [] } = {}) {
  const body = [
    ...textObjects.map((spec, index) => textObject(spec, index + 1)),
    ...images.map(
      (image, index) =>
        `<ofd:ImageObject ID="${900 + index}" ResourceID="${image.resourceId}" Boundary="${image.boundary.join(" ")}" CTM="${image.ctm ?? "1 0 0 1 0 0"}"/>`
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="${OFD_NS}"><ofd:Content><ofd:Layer ID="1">${body.join("")}</ofd:Layer></ofd:Content></ofd:Page>`;
}

/** 造一个最小可用的 OFD 文件，返回 Buffer。 */
async function makeOfd({ pages }) {
  const zip = new JSZip();
  zip.file(
    "OFD.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<ofd:OFD xmlns:ofd="${OFD_NS}" Version="1.0" DocType="OFD"><ofd:DocBody><ofd:DocInfo><ofd:DocID>test-ofd</ofd:DocID></ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`
  );
  const pageEntries = pages
    .map((_, index) => `<ofd:Page ID="${index + 1}" BaseLoc="Pages/Page_${index}/Content.xml"/>`)
    .join("");
  zip.file(
    "Doc_0/Document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="${OFD_NS}"><ofd:CommonData><ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea><ofd:PublicRes>PublicRes.xml</ofd:PublicRes></ofd:CommonData><ofd:Pages>${pageEntries}</ofd:Pages></ofd:Document>`
  );
  zip.file(
    "Doc_0/PublicRes.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Res xmlns:ofd="${OFD_NS}" BaseLoc="Res"><ofd:Fonts><ofd:Font ID="1" FontName="宋体" FamilyName="宋体"/></ofd:Fonts></ofd:Res>`
  );
  pages.forEach((page, index) => {
    zip.file(`Doc_0/Pages/Page_${index}/Content.xml`, pageXml(page));
  });
  return await zip.generateAsync({ type: "nodebuffer" });
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "kb-ofd-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("OFD：TextObject 打乱顺序写入，按坐标重排成行", async () => {
  await withTempDir(async (dir) => {
    const buffer = await makeOfd({
      pages: [
        {
          textObjects: [
            { text: "第二行正文", boundary: [27, 20, 40, 6], size: 5.6, x: 0, y: 4.5 },
            { text: "第一行正文", boundary: [27, 10, 40, 6], size: 5.6, x: 0, y: 4.5 },
          ],
        },
      ],
    });
    const file = join(dir, "顺序.ofd");
    await writeFile(file, buffer);
    const result = await convertOfd(file, { maxOcrPages: 0 });
    assert.equal(result.pages, 1);
    assert.equal(result.type, "ofd");
    assert.equal(result.sections.length, 1);
    assert.equal(result.sections[0].heading, "第 1 页");
    assert.equal(result.sections[0].page, 1);
    assert.deepEqual(result.sections[0].text.split("\n"), ["第一行正文", "第二行正文"]);
  });
});

test("OFD：同一行的多段按 x 合并（基线抖动 0.2mm 不拆行）", async () => {
  await withTempDir(async (dir) => {
    const buffer = await makeOfd({
      pages: [
        {
          textObjects: [
            { text: "世界", boundary: [40, 10.2, 11, 6], size: 5.6, x: 0, y: 4.5 },
            { text: "你好", boundary: [27, 10, 11, 6], size: 5.6, x: 0, y: 4.5 },
          ],
        },
      ],
    });
    const file = join(dir, "同一行.ofd");
    await writeFile(file, buffer);
    const result = await convertOfd(file, { maxOcrPages: 0 });
    assert.equal(result.sections[0].text, "你好世界");
  });
});

test("OFD：CTM 膨胀的 Size 不把相邻两行并成一行（政办通报回归）", async () => {
  await withTempDir(async (dir) => {
    // 真实样本特征：Size=29.26、CTM=0.3528，实测字宽只有 5.4mm；相邻行距 10.4mm。
    const deltaX = Array.from({ length: 8 }, () => "15.7197").join(" ");
    const buffer = await makeOfd({
      pages: [
        {
          textObjects: [
            {
              text: "第一行八个字",
              boundary: [27.64, 34.91, 44.3, 7.18],
              size: 29.2627,
              ctm: "0.3528 0 0 0.3528 0 0",
              x: 0,
              y: 14.6,
              deltaX,
            },
            {
              text: "第二行八个字",
              boundary: [27.64, 45.28, 44.3, 7.18],
              size: 29.2627,
              ctm: "0.3528 0 0 0.3528 0 0",
              x: 0,
              y: 14.6,
              deltaX,
            },
          ],
        },
      ],
    });
    const file = join(dir, "通报.ofd");
    await writeFile(file, buffer);
    const result = await convertOfd(file, { maxOcrPages: 0 });
    assert.deepEqual(result.sections[0].text.split("\n"), ["第一行八个字", "第二行八个字"]);
  });
});

test("OFD：汉字间的分散对齐不补空格，中文标点旁也不补", async () => {
  await withTempDir(async (dir) => {
    const buffer = await makeOfd({
      pages: [
        {
          textObjects: [
            { text: "设备变电", boundary: [27, 10, 28, 6], size: 5.6, x: 0, y: 4.5 },
            { text: "〔2022〕69号", boundary: [56.5, 10, 40, 6], size: 5.6, x: 0, y: 4.5 },
          ],
        },
      ],
    });
    const file = join(dir, "文号.ofd");
    await writeFile(file, buffer);
    const result = await convertOfd(file, { maxOcrPages: 0 });
    assert.equal(result.sections[0].text, "设备变电〔2022〕69号");
  });
});

test("OFD：DeltaX 只写部分字形时，数字/文号不被空格拆开（浙电批复回归）", async () => {
  await withTempDir(async (dir) => {
    // 真实样本特征：TextObject("21") 的 DeltaX 只写了一个 2.7092（不是两段），
    // 早前拿它当整段宽度会算出假间隙，把「214号」拆成「21 4 号」。
    const buffer = await makeOfd({
      pages: [
        {
          textObjects: [
            { text: "〔2023〕", boundary: [160, 82.78, 13.4, 6.35], size: 5.6268, x: 0.95, y: 4.97 },
            { text: "21", boundary: [173.3759, 82.78, 7.8245, 6.35], size: 5.6268, x: 0.9525, y: 4.9742, deltaX: "2.7092" },
            { text: "4", boundary: [179.6838, 82.78, 7.3025, 6.35], size: 5.6268, x: 0.9525, y: 4.9742 },
            { text: "号", boundary: [186.9, 82.78, 5.63, 6.35], size: 5.6268, x: 0.9525, y: 4.9742 },
          ],
        },
      ],
    });
    const file = join(dir, "文号拆分.ofd");
    await writeFile(file, buffer);
    const result = await convertOfd(file, { maxOcrPages: 0 });
    assert.equal(result.sections[0].text, "〔2023〕214号");
  });
});

test("OFD：纯图片页在关闭 OCR 时降级为「本页无文字」并给告警", async () => {
  await withTempDir(async (dir) => {
    const buffer = await makeOfd({
      pages: [{ textObjects: [], images: [{ resourceId: "5", boundary: [0, 0, 210, 297] }] }],
    });
    const file = join(dir, "扫描页.ofd");
    await writeFile(file, buffer);
    const result = await convertOfd(file, { maxOcrPages: 0 });
    assert.equal(result.pages, 1);
    assert.equal(result.sections[0].text, "（本页无文字内容）");
    assert.ok(result.warnings.some((warning) => warning.includes("第 1 页")));
  });
});

test("OFD：多页保留页码，页数预扫描一致", async () => {
  await withTempDir(async (dir) => {
    const buffer = await makeOfd({
      pages: [
        { textObjects: [{ text: "第一页", boundary: [27, 10, 20, 6], size: 5.6, x: 0, y: 4.5 }] },
        { textObjects: [{ text: "第二页", boundary: [27, 10, 20, 6], size: 5.6, x: 0, y: 4.5 }] },
        { textObjects: [{ text: "第三页", boundary: [27, 10, 20, 6], size: 5.6, x: 0, y: 4.5 }] },
      ],
    });
    const file = join(dir, "多页.ofd");
    await writeFile(file, buffer);
    const result = await convertOfd(file, { maxOcrPages: 0 });
    assert.equal(result.pages, 3);
    assert.deepEqual(result.sections.map((section) => section.page), [1, 2, 3]);
    assert.equal(await preScanOfdPages(file), 3);
  });
});

test("OFD：不是 zip 容器时报可读错误", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "假.ofd");
    await writeFile(file, "这不是 OFD 文件", "utf8");
    await assert.rejects(() => convertOfd(file, { maxOcrPages: 0 }), /OFD 解析失败/);
  });
});

test("OFD：走完整导入管线，清单类型与页码正确", async () => {
  await withTempDir(async (dir) => {
    const kbDir = join(dir, "kb");
    const buffer = await makeOfd({
      pages: [
        { textObjects: [{ text: "国网设备部关于加强设备管理的通知", boundary: [27, 20, 90, 8], size: 8, x: 0, y: 6 }] },
        { textObjects: [{ text: "各电网单位要认真落实设备管理工作。", boundary: [27, 15, 120, 6], size: 5.6, x: 0, y: 4.5 }] },
      ],
    });
    const file = join(dir, "公文.ofd");
    await writeFile(file, buffer);
    const report = await importFileInto(kbDir, {
      sourcePath: file,
      relKey: "公文.ofd",
      title: "公文",
      config: { partMaxChars: 4000 },
    });
    assert.equal(report.type, "ofd");
    assert.equal(report.pages, 2);
    const manifest = await readManifest(kbDir);
    const doc = manifest.docs.find((item) => item.id === report.docId);
    assert.equal(doc.type, "ofd");
    assert.equal(doc.pages, 2);
    const { readFile } = await import("node:fs/promises");
    const merged = await readFile(join(kbDir, "markdown", doc.id, `${doc.id}.md`), "utf8");
    assert.match(merged, /第 1 页/);
    assert.match(merged, /国网设备部关于加强设备管理的通知/);
    assert.match(merged, /各电网单位要认真落实设备管理工作/);
  });
});
