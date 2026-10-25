/**
 * E2E 固定数据：
 *  - 建库/归档走 HTTP API（和用户操作同一入口）；
 *  - 资料直接写 kb.json + sources/ + markdown/（与既有验收夹具一致，不跑 OCR/解析，
 *    保证几秒内可重复）；
 *  - 一份可重试的失败 txt、一份 PDF、一份 docx（python-docx 优先，失败时用 JSZip
 *    生成最小 OOXML），笔记用于预览正文。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { readManifest, rebuildMerged, writeManifestAtomic } from "../../lib/store.js";

export const FIXTURES = Object.freeze({
  kbs: { primary: "甲库", target: "乙库", archived: "丙库", search: "检索库" },
  docs: {
    a1: { id: "111111111111", title: "恢复资料一", kb: "甲库" },
    a2: { id: "222222222222", title: "删除资料二", kb: "甲库" },
    a3: { id: "333333333333", title: "移动资料三", kb: "甲库" },
    a4: { id: "444444444444", title: "清空资料四", kb: "甲库" },
    failed: { id: "555555555555", title: "失败资料五", kb: "甲库" },
    note: { id: "666666666666", title: "验收笔记", kb: "甲库" },
    pdf: { id: "777777777777", title: "预览资料", kb: "甲库" },
    office: { id: "888888888888", title: "Office资料", kb: "甲库" },
    b1: { id: "bbbbbbbbbbbb", title: "乙库删除资料", kb: "乙库" },
    c1: { id: "cccccccccccc", title: "归档资料一", kb: "丙库" },
    c2: { id: "dddddddddddd", title: "归档资料二", kb: "丙库" },
    searchA: { id: "eeeeeeeeeeee", title: "GB/T 1234-2020 风电场电能质量技术规定", kb: "检索库" },
    searchB: { id: "ffffffffffff", title: "GB 1234-2020 风电场并网技术规定", kb: "检索库" },
    searchC: { id: "999999999999", title: "光伏发电站无功补偿技术规范", kb: "检索库" },
  },
  errorText: "模拟解析失败：原件文字层损坏，请重试",
  noteBody: "这是验收笔记的正文，用于验证笔记预览文本。",
});

const NOTE_MARKDOWN = `这是验收笔记的正文，用于验证笔记预览文本。\n\n第二段：E2E 只验证能读到笔记内容。\n`;

function hashOf(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

function ago(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function padXref(value) {
  return String(value).padStart(10, "0");
}

/** 生成一份最小但合法的单页 PDF（Helvetica 文本，浏览器/预览器都能打开）。 */
export function makeTinyPdf(text = "E2E PDF fixture") {
  const escaped = String(text).replace(/[\\()]/g, (char) => `\\${char}`);
  const stream = `BT /F1 14 Tf 20 100 Td (${escaped}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${padXref(offset)} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "binary");
}

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOCX_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>E2E Office Fixture</w:t></w:r></w:p><w:p><w:r><w:t>Hello from the Playwright E2E suite.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

async function makeDocxWithJSZip() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", DOCX_CONTENT_TYPES);
  zip.file("_rels/.rels", DOCX_RELS);
  zip.file("word/document.xml", DOCX_DOCUMENT);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function pythonCandidates(env = process.env) {
  const candidates = [];
  const add = (value) => {
    const bin = String(value ?? "").trim();
    if (bin !== "" && !candidates.includes(bin)) candidates.push(bin);
  };
  add(env.DSH_E2E_PYTHON);
  add("python3");
  add("python");
  const dshHome = String(env.DSH_HOME ?? "").trim() || join(String(env.HOME ?? homedir()), ".dsh");
  const runtimes = join(dshHome, "dsh-runtimes");
  const suffixes = process.platform === "win32" ? ["", ".exe"] : [""];
  try {
    for (const name of existsSync(runtimes) ? readdirSync(runtimes) : []) {
      for (const suffix of suffixes) {
        add(join(runtimes, name, "dependencies", "python", "bin", `python3${suffix}`));
        add(join(runtimes, name, "dependencies", "python", "bin", `python${suffix}`));
      }
    }
  } catch {
    /* 没有 runtime 时继续用 PATH */
  }
  return candidates;
}

async function makeDocxWithPython(outPath, log) {
  const script = [
    "import sys",
    "from docx import Document",
    "doc = Document()",
    "doc.add_heading('E2E Office Fixture', level=1)",
    "doc.add_paragraph('Hello from python-docx.')",
    "doc.save(sys.argv[1])",
  ].join("\n");
  for (const bin of pythonCandidates()) {
    const probe = spawnSync(bin, ["-c", "import docx"], { encoding: "utf8", timeout: 10_000 });
    if (probe.status !== 0) continue;
    const made = spawnSync(bin, ["-c", script, outPath], { encoding: "utf8", timeout: 20_000 });
    if (made.status === 0 && existsSync(outPath)) {
      log(`docx: generated with ${bin} (python-docx)`);
      return { path: outPath, method: "python-docx" };
    }
    log(`docx: python-docx failed via ${bin}: ${String(made.stderr ?? "").trim().slice(0, 300)}`);
  }
  return null;
}

/**
 * 生成 docx：优先用本机/DSH 运行时里的 python-docx；不可用时退回 JSZip
 * 生成最小 OOXML（仍是合法 docx，OfficeKit 可转换）。两者都失败返回 null。
 */
export async function makeTinyDocx({ artifactsDir, log = () => {} } = {}) {
  const outPath = join(artifactsDir, "office-fixture.docx");
  const python = await makeDocxWithPython(outPath, log);
  if (python) return python;
  try {
    const buffer = await makeDocxWithJSZip();
    await writeFile(outPath, buffer);
    log("docx: generated with JSZip fallback (minimal OOXML)");
    return { path: outPath, method: "jszip", buffer };
  } catch (error) {
    log(`docx: generation failed: ${String(error?.message ?? error)}`);
    return null;
  }
}

function manifestDoc(spec, now) {
  const doc = {
    id: spec.id,
    title: spec.title,
    type: spec.type,
    status: spec.status,
    standardNo: spec.standardNo ?? "",
    sourceFile: spec.sourceFile ?? "",
    pages: spec.pages ?? 1,
    chars: spec.chars ?? 0,
    parts: spec.parts ?? 1,
    version: 1,
    importedAt: spec.importedAt ?? now,
    updatedAt: spec.updatedAt ?? now,
    summary: spec.summary ?? "",
    tags: spec.tags ?? [],
    trust: spec.trust ?? "unknown",
  };
  if (spec.sourceHash) doc.sourceHash = spec.sourceHash;
  if (spec.sourcePath) doc.sourcePath = spec.sourcePath;
  if (spec.status === "deleted") {
    doc.deletedAt = spec.deletedAt ?? now;
    doc.deletedFromStatus = spec.deletedFromStatus ?? "ready";
  }
  if (spec.status === "failed") {
    doc.error = spec.error ?? "";
    doc.errorAt = spec.errorAt ?? now;
  }
  if (spec.movedTo) doc.movedTo = spec.movedTo;
  return doc;
}

async function writeDoc(kbRoot, spec, log) {
  const dir = join(kbRoot, spec.kb);
  const manifest = await readManifest(dir);
  manifest.docs = (manifest.docs ?? []).filter((doc) => doc.id !== spec.id);
  const now = new Date().toISOString();
  const doc = manifestDoc({ ...spec, updatedAt: spec.updatedAt ?? now }, now);

  if (spec.source) {
    const sources = join(dir, "sources");
    await mkdir(sources, { recursive: true });
    const ext = spec.sourceExt ?? ".txt";
    const fileName = `${spec.id}${ext}`;
    await writeFile(join(sources, fileName), spec.source);
    doc.sourceFile = spec.sourceFile ?? `${spec.title}${ext}`;
    doc.sourceHash = hashOf(spec.source);
    log(`seeded ${spec.kb}/${spec.title} source ${fileName} (${Buffer.byteLength(spec.source)} bytes)`);
  }

  if (spec.markdown !== undefined) {
    const docDir = join(dir, "markdown", spec.id);
    const partsDir = join(docDir, "parts");
    await mkdir(partsDir, { recursive: true });
    await writeFile(join(partsDir, "0001.md"), `${spec.markdown.trimEnd()}\n`, "utf8");
    await rebuildMerged(dir, doc);
    doc.parts = 1;
    doc.chars = spec.markdown.length;
  }

  manifest.docs.push(doc);
  await writeManifestAtomic(dir, manifest);
  return doc;
}

function docsByKb() {
  return [
    {
      ...FIXTURES.docs.a1,
      type: "text",
      status: "deleted",
      source: "恢复资料一的原始文本。\n",
      sourceExt: ".txt",
      sourceFile: "恢复资料一.txt",
      markdown: "恢复资料一的整理正文。",
      deletedAt: ago(4),
    },
    {
      ...FIXTURES.docs.a2,
      type: "text",
      status: "deleted",
      source: "删除资料二的原始文本。\n",
      sourceExt: ".txt",
      sourceFile: "删除资料二.txt",
      markdown: "删除资料二的整理正文。",
      deletedAt: ago(3),
    },
    {
      ...FIXTURES.docs.a3,
      type: "text",
      status: "ready",
      source: "移动资料三的原始文本，用于跨库移动。\n",
      sourceExt: ".txt",
      sourceFile: "移动资料三.txt",
      markdown: "移动资料三的整理正文。",
    },
    {
      ...FIXTURES.docs.a4,
      type: "text",
      status: "deleted",
      source: "清空资料四的原始文本。\n",
      sourceExt: ".txt",
      sourceFile: "清空资料四.txt",
      markdown: "清空资料四的整理正文。",
      deletedAt: ago(2),
    },
    {
      ...FIXTURES.docs.failed,
      type: "text",
      status: "failed",
      source: "失败资料五的原始文本；重试后应解析成功。\n",
      sourceExt: ".txt",
      sourceFile: "失败资料五.txt",
      error: FIXTURES.errorText,
    },
    {
      ...FIXTURES.docs.note,
      type: "note",
      status: "ready",
      markdown: NOTE_MARKDOWN,
      summary: "验收笔记摘要",
      tags: ["验收", "e2e"],
    },
    {
      ...FIXTURES.docs.b1,
      type: "text",
      status: "deleted",
      source: "乙库删除资料的原始文本。\n",
      sourceExt: ".txt",
      sourceFile: "乙库删除资料.txt",
      markdown: "乙库删除资料的整理正文。",
      deletedAt: ago(1),
    },
    {
      ...FIXTURES.docs.c1,
      type: "text",
      status: "ready",
      source: "归档资料一的原始文本。\n",
      sourceExt: ".txt",
      sourceFile: "归档资料一.txt",
      markdown: "归档资料一的整理正文。",
    },
    {
      ...FIXTURES.docs.c2,
      type: "text",
      status: "ready",
      source: "归档资料二的原始文本。\n",
      sourceExt: ".txt",
      sourceFile: "归档资料二.txt",
      markdown: "归档资料二的整理正文。",
    },
    // 检索夹具：条款/页码/标准号/标签/可信度齐备，供 0.27 检索工作台验收。
    {
      ...FIXTURES.docs.searchA,
      type: "pdf-text",
      status: "ready",
      source: makeTinyPdf("GB/T 1234-2020 search fixture"),
      sourceExt: ".pdf",
      sourceFile: "GB_T 1234-2020 风电场电能质量技术规定.pdf",
      standardNo: "GB/T 1234-2020",
      tags: ["检索", "新能源"],
      trust: "high",
      pages: 3,
      markdown: [
        "### 第 1 页",
        "4.1 电压偏差",
        "风电场公共连接点的电压偏差应不超过标称电压的 7%，持续时间超过 1min 时按 10min 平均值考核。",
        "### 第 2 页",
        "4.2 谐波电流",
        "风电场注入公共连接点的谐波电流限值见表 2。",
        "### 第 3 页",
        "4.3 电压暂降",
        "风电场应记录 10kV 母线电压暂降事件并统计持续时间。",
      ].join("\n\n"),
    },
    {
      ...FIXTURES.docs.searchB,
      type: "pdf-text",
      status: "ready",
      source: "GB 1234-2020 风电场并网技术规定的原始文本。\n",
      sourceExt: ".txt",
      sourceFile: "GB 1234-2020 风电场并网技术规定.txt",
      standardNo: "GB 1234-2020",
      tags: ["检索"],
      trust: "medium",
      pages: 2,
      markdown: [
        "### 第 1 页",
        "5.1 电压偏差",
        "并网点的电压偏差应符合本文件的一般要求。",
        "### 第 2 页",
        "5.2 并网容量",
        "单点并网容量超过 6MW 时应单独评估。",
      ].join("\n\n"),
    },
    {
      ...FIXTURES.docs.searchC,
      type: "docx",
      status: "ready",
      source: "光伏发电站无功补偿技术规范的原始文本。\n",
      sourceExt: ".txt",
      sourceFile: "光伏发电站无功补偿技术规范.txt",
      standardNo: "GB/T 29321-2012",
      tags: ["新能源"],
      trust: "low",
      pages: 2,
      markdown: [
        "### 第 1 页",
        "6.1 无功容量",
        "光伏发电站应充分利用并网逆变器的无功容量及其调节能力。",
        "### 第 2 页",
        "6.2 功率因数",
        "并网点功率因数应在 0.95 以上。",
      ].join("\n\n"),
    },
  ];
}

/** 写入全部固定数据；返回 docx 是否可用等元信息。 */
export async function seedFixtures({ api, kbRoot, artifactsDir, log = () => {} }) {
  const names = [FIXTURES.kbs.primary, FIXTURES.kbs.target, FIXTURES.kbs.archived, FIXTURES.kbs.search];
  for (const name of names) {
    try {
      await api.createKb(name, { description: `${name}（E2E 临时库）` });
      log(`created kb ${name}`);
    } catch (error) {
      if (String(error?.code ?? "") !== "KB_EXISTS") throw error;
      log(`kb ${name} already exists`);
    }
  }

  const specs = docsByKb();
  const pdf = {
    ...FIXTURES.docs.pdf,
    type: "pdf",
    status: "ready",
    source: makeTinyPdf("E2E PDF fixture"),
    sourceExt: ".pdf",
    sourceFile: "预览资料.pdf",
    markdown: "PDF 预览夹具正文。",
  };
  specs.push(pdf);

  let office = null;
  const docx = await makeTinyDocx({ artifactsDir, log });
  if (docx) {
    const buffer = docx.buffer ?? await readFile(docx.path);
    specs.push({
      ...FIXTURES.docs.office,
      type: "docx",
      status: "ready",
      source: buffer,
      sourceExt: ".docx",
      sourceFile: "Office资料.docx",
      markdown: "Office 预览夹具正文。",
    });
    office = { id: FIXTURES.docs.office.id, method: docx.method };
  }

  for (const spec of specs) await writeDoc(kbRoot, spec, log);
  log(`seeded ${specs.length} docs`);

  await api.archiveKb(FIXTURES.kbs.archived);
  log(`archived kb ${FIXTURES.kbs.archived}`);

  const kbs = await api.kbs();
  const liveNames = kbs.kbs.map((kb) => kb.name);
  for (const name of [FIXTURES.kbs.primary, FIXTURES.kbs.target]) {
    if (!liveNames.includes(name)) throw new Error(`seed 后缺少知识库：${name}`);
  }
  if (liveNames.includes(FIXTURES.kbs.archived)) throw new Error("丙库归档后仍出现在 /kbs");

  const trash = await api.trash();
  if ((trash.items ?? []).length !== 1) {
    throw new Error(`归档库数量应为 1，实际 ${(trash.items ?? []).length}`);
  }
  const trashDocs = await api.trashDocs();
  if (Number(trashDocs.total) !== 4) {
    throw new Error(`已删除资料应为 4 篇，实际 ${trashDocs.total}`);
  }
  const primaryDocs = await api.docs(FIXTURES.kbs.primary, { limit: 200 });
  const failed = primaryDocs.docs.find((doc) => doc.id === FIXTURES.docs.failed.id);
  if (!failed || failed.status !== "failed") throw new Error("失败资料夹具未写入甲库");
  const pdfDoc = primaryDocs.docs.find((doc) => doc.id === FIXTURES.docs.pdf.id);
  if (!pdfDoc || pdfDoc.type !== "pdf") throw new Error("PDF 夹具未写入甲库");

  const searchDocs = await api.docs(FIXTURES.kbs.search, { limit: 50 });
  for (const fixture of [FIXTURES.docs.searchA, FIXTURES.docs.searchB, FIXTURES.docs.searchC]) {
    if (!searchDocs.docs.some((doc) => doc.id === fixture.id)) {
      throw new Error(`检索夹具未写入${FIXTURES.kbs.search}：${fixture.title}`);
    }
  }
  const searchApi = await api.request("GET", `/search?q=${encodeURIComponent("电压偏差")}`);
  if (!searchApi.results.some((item) => item.docId === FIXTURES.docs.searchA.id)) {
    throw new Error(`检索接口未命中检索夹具：${JSON.stringify(searchApi.results.map((item) => item.docId))}`);
  }

  return {
    office,
    pdf: true,
    deletedTotal: Number(trashDocs.total),
    archivedTotal: (trash.items ?? []).length,
  };
}

