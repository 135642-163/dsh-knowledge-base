/**
 * 各类源文件的解析器：docx / pptx / pdf（文字版与扫描版自动分流）/ md / txt。
 * 统一输出 { sections: [{heading, level, text, page?}], ... }，
 * sections 由 pipeline 组装为分块与合并版 markdown。
 *
 * 重量级依赖（mammoth、mupdf、tesseract.js、jszip 等）全部在首次使用时动态
 * import，保证插件加载轻快、单个解析器损坏不影响知识库整体可用。
 */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, extname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * 异步执行外部命令（promisified execFile + 超时），避免同步转换阻塞宿主事件循环。
 * 失败（含非零退出码 / 超时 / 无法启动）时 reject，error 上附带 stdout/stderr 文本。
 */
export async function execFileAsync(bin, args, { timeoutMs = 180000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return await new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = String(stdout ?? "");
          error.stderr = String(stderr ?? "");
          reject(error);
        } else {
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        }
      }
    );
  });
}

export const SUPPORTED_EXTS = [".docx", ".doc", ".pptx", ".ppt", ".pdf", ".md", ".markdown", ".txt", ".epub", ".mobi", ".azw", ".azw3"];

export function kindForPath(path) {
  const ext = extname(String(path)).toLowerCase();
  if (ext === ".docx" || ext === ".doc") return "docx";
  if (ext === ".pptx" || ext === ".ppt") return "pptx";
  if (ext === ".pdf") return "pdf";
  if (ext === ".epub") return "epub";
  if (ext === ".mobi" || ext === ".azw" || ext === ".azw3") return "mobi";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".txt") return "text";
  return null;
}

// ---------------------------------------------------------------------------
// 通用：markdown 文本 → 段落
// ---------------------------------------------------------------------------

export function sectionsFromMarkdown(md) {
  const lines = String(md).split(/\r?\n/);
  const sections = [];
  let cur = { heading: "", level: 0, text: [] };
  for (const line of lines) {
    const match = /^(#{1,4})[ \t]+(.+?)\s*$/.exec(line);
    if (match) {
      if (cur.text.length > 0 || cur.heading) {
        sections.push({ heading: cur.heading, level: cur.level, text: cur.text.join("\n").trim() });
      }
      cur = { heading: match[2].replace(/[#*_`]/g, " ").trim(), level: match[1].length, text: [] };
    } else {
      cur.text.push(line);
    }
  }
  if (cur.text.length > 0 || cur.heading) {
    sections.push({ heading: cur.heading, level: cur.level, text: cur.text.join("\n").trim() });
  }
  if (sections.length === 0) return [];
  const hasHeading = sections.some((s) => s.heading);
  if (!hasHeading) {
    // 无标题的纯文本：按空行分段的“软段落”
    return splitParagraphs(String(md));
  }
  return sections.filter((s) => s.heading || s.text);
}

/**
 * 无标题的纯文本：按空行分段，再把超长段落切到 ~1200 字符窗口，
 * 组装为“软段落”。线性复杂度（旧实现用 splice 把余量反复插回数组，
 * 在超大段落上平方级膨胀直至 OOM，已重写）。
 */
function splitParagraphs(md) {
  const blocks = String(md).split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const pieces = [];
  for (const block of blocks) {
    if (block.length <= 1200) {
      pieces.push(block);
      continue;
    }
    let rest = block;
    while (rest.length > 1200) {
      // 优先在行边界切分，避免拦腰截断句子
      let cut = rest.lastIndexOf("\n", 1200);
      if (cut < 400) cut = 1200;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n+/, "");
    }
    if (rest.length > 0) pieces.push(rest);
  }
  const sections = [];
  let cur = [];
  let curChars = 0;
  for (const piece of pieces) {
    if (cur.length > 0 && curChars + piece.length > 1200) {
      sections.push({ heading: "", level: 0, text: cur.join("\n\n") });
      cur = [];
      curChars = 0;
    }
    cur.push(piece);
    curChars += piece.length;
  }
  if (cur.length > 0) sections.push({ heading: "", level: 0, text: cur.join("\n\n") });
  return sections.length > 0 ? sections : [{ heading: "", level: 0, text: "" }];
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

export async function convertDocx(buffer) {
  const { default: mammoth } = await import("mammoth");
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer) },
    { includeDefaultStyleMap: true }
  );
  const { default: TurndownService } = await import("turndown");
  const { gfm } = await import("turndown-plugin-gfm");
  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    hr: "---",
  });
  turndown.use(gfm);
  const md = cleanWordFieldCodes(turndown.turndown(result.value));
  const warnings = (result.messages ?? []).map((m) => m.message);
  return { sections: sectionsFromMarkdown(md), warnings };
}

/** 清除 Word 域代码文本（textutil 转换产物会把 TOC/HYPERLINK/PAGEREF 域码留在正文里；反斜杠可能被转义成 \\）。 */
function cleanWordFieldCodes(md) {
  return String(md)
    .replace(/HYPERLINK\s+\\{1,2}[A-Za-z]+\s*"[^"]*"\s*/gi, "")
    .replace(/PAGEREF\s+\S+\s+\\{1,2}[A-Za-z]+\s*/gi, "")
    .replace(/TOC\s+(?:\\{1,2}[A-Za-z]+\s*(?:"[^"]*")?\s*)+/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n");
}

// ---------------------------------------------------------------------------
// 旧版 .doc → .docx 转换（跨平台）
//   Windows: Microsoft Word COM 自动化（本机装有 Word 时首选）
//   macOS:   textutil（系统自带）
//   Linux:   LibreOffice（若可用）
// ---------------------------------------------------------------------------

const DOC_CONVERT_SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), "data", "win", "docx-convert.ps1");

let docConverter = null;
let docConverterReady = null;

/** 探测本机可用的旧格式转换工具（平台事实缓存）: { textutil, word }。 */
async function resolveDocConverter() {
  if (docConverterReady !== null) return docConverterReady;
  docConverterReady = (async () => {
    const out = { textutil: false, word: false };
    if (process.platform === "darwin") {
      try {
        await execFileAsync("textutil", ["-help"], { timeoutMs: 10000 });
        out.textutil = true;
      } catch {
        /* ignore */
      }
    } else if (process.platform === "win32") {
      // Word 未安装时 COM 调用会报 class factory 错误，run 阶段映射为友好提示
      out.word = true;
    }
    return out;
  })();
  return docConverterReady;
}

/** 探测 LibreOffice（每次现查不缓存：便携版可能在使用中途才就位）。
 *  注意：某些环境 soffice --version 会挂起（GUI 子系统 stdout 丢失/首启初始化），
 *  因此优先用文件存在性探测，仅在显式路径下才做快速版本验证。 */
async function resolveSoffice() {
  const { access } = await import("node:fs/promises");
  const local = join(homedir(), ".dsh", "tools", "libreoffice", "program", process.platform === "win32" ? "soffice.exe" : "soffice");
  for (const bin of [local, "soffice", "libreoffice"]) {
    if (bin === "soffice" || bin === "libreoffice") {
      try {
        await execFileAsync(bin, ["--version"], { timeoutMs: 8000 });
        return bin;
      } catch {
        /* try next */
      }
    } else {
      try {
        await access(bin);
        return bin;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

/** 用 LibreOffice 无头转换：源文件 → out（docx/pptx），产物名按扩展名定位后改名。 */
async function convertViaSoffice(bin, dir, sourcePath, out, toExt) {
  try {
    await execFileAsync(
      bin,
      ["--headless", "--convert-to", toExt, "--outdir", dir, sourcePath],
      { timeoutMs: 300000 }
    );
  } catch (error) {
    const errText = (error.stderr || "").trim().slice(0, 300);
    if (error.code === "ENOENT" || /spawn/i.test(String(error.message))) {
      throw new Error(`LibreOffice 转换失败（无法启动 ${bin}）: ${error.message}`);
    }
    if (error.killed) {
      throw new Error(`LibreOffice 转换超时（300 秒）: ${errText}`);
    }
    throw new Error(`LibreOffice 转换失败（退出码 ${error.code ?? "?"}）: ${errText}`);
  }
  const { rename, readdir } = await import("node:fs/promises");
  const produced = join(dir, basename(String(sourcePath)).replace(/\.(docx?|pptx?)$/i, "") + "." + toExt);
  try {
    await rename(produced, out);
  } catch {
    for (const f of await readdir(dir)) {
      if (f.toLowerCase().endsWith("." + toExt)) {
        await rename(join(dir, f), out);
        break;
      }
    }
  }
}

/**
 * 把旧版 .doc 转换为 .docx 缓冲（kb_view 提取 .doc 内嵌图片也复用此函数）。
 * 转换按调用方串行发起（各调用独立使用临时目录，无并发交错）。
 */
export async function convertLegacyDocToBuffer(sourcePath) {
  const converter = await resolveDocConverter();
  const soffice = await resolveSoffice();
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "dsh-kb-doc-"));
  try {
    const out = join(dir, "converted.docx");
    if (converter.textutil) {
      try {
        await execFileAsync("textutil", ["-convert", "docx", sourcePath, "-output", out], {
          timeoutMs: 180000,
        });
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new Error(`旧版 .doc 转换失败（textutil 调用出错）: ${error.message}`);
        }
        throw new Error(
          `旧版 .doc 转换失败 (textutil 退出码 ${error.code ?? "?"}): ${(error.stderr || "").trim().slice(0, 300)}`
        );
      }
    } else if (converter.word) {
      try {
        await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            DOC_CONVERT_SCRIPT,
            "-Source",
            sourcePath,
            "-Dest",
            out,
          ],
          { timeoutMs: 180000 }
        );
      } catch (error) {
        const errText = `${error.stderr || ""}\n${error.stdout || ""}`.trim();
        if (error.code === "ENOENT") {
          throw new Error(`旧版 .doc 转换失败（无法启动 Word 转换器）: ${error.message}`);
        }
        if (soffice) {
          // Word 转换失败（未安装/COM 异常/文件被拒）：回退 LibreOffice
          await convertViaSoffice(soffice, dir, sourcePath, out, "docx");
        } else if (/class factory|CLSID|80040154|80080005|RPC server|COM object|comobject/i.test(errText)) {
          throw new Error(
            "旧版 .doc 转换失败：本机未找到可用的 Microsoft Word（COM 自动化不可用）。请安装 Word/WPS 后重试，或手动将文件另存为 .docx 再导入。"
          );
        } else {
          throw new Error(`旧版 .doc 转换失败（Word 转换器退出码 ${error.code ?? "?"}）: ${errText.slice(0, 300)}`);
        }
      }
    } else if (soffice) {
      await convertViaSoffice(soffice, dir, sourcePath, out, "docx");
    } else {
      throw new Error(
        "旧版 .doc 转换失败：当前系统没有可用的转换工具。Windows 请安装 Microsoft Word（WPS 用户请手动另存为 .docx）；macOS 应使用自带 textutil；Linux 请安装 LibreOffice。"
      );
    }
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 旧版 .doc：先转成 .docx 再解析。 */
export async function convertLegacyDoc(sourcePath) {
  const buffer = await convertLegacyDocToBuffer(sourcePath);
  return await convertDocx(buffer);
}

// ---------------------------------------------------------------------------
// 旧版 .ppt → .pptx 转换（跨平台）
//   Windows: PowerPoint COM 自动化；其他: LibreOffice（若可用）
// ---------------------------------------------------------------------------

const PPT_CONVERT_SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), "data", "win", "pptx-convert.ps1");

/** 把旧版 .ppt 转换为 .pptx 缓冲（kb_view 提取 .ppt 内嵌图片也复用此函数）。 */
export async function convertLegacyPptToBuffer(sourcePath) {
  const soffice = await resolveSoffice();
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "dsh-kb-ppt-"));
  try {
    const out = join(dir, "converted.pptx");
    if (soffice) {
      // LibreOffice 优先（无头转换稳定；PowerPoint COM 在部分环境保存被拒）
      await convertViaSoffice(soffice, dir, sourcePath, out, "pptx");
    } else if (process.platform === "win32") {
      try {
        await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            PPT_CONVERT_SCRIPT,
            "-Source",
            sourcePath,
            "-Dest",
            out,
          ],
          { timeoutMs: 300000 }
        );
      } catch (error) {
        const errText = `${error.stderr || ""}\n${error.stdout || ""}`.trim();
        if (error.code === "ENOENT") {
          throw new Error(`旧版 .ppt 转换失败（无法启动 PowerPoint 转换器）: ${error.message}`);
        }
        if (/class factory|CLSID|80040154|80080005|RPC server|COM object|comobject/i.test(errText)) {
          throw new Error(
            "旧版 .ppt 转换失败：本机未找到可用的 Microsoft PowerPoint（COM 自动化不可用）。请安装 PowerPoint/LibreOffice 后重试，或手动将文件另存为 .pptx 再导入。"
          );
        }
        throw new Error(`旧版 .ppt 转换失败（PowerPoint 转换器退出码 ${error.code ?? "?"}）: ${errText.slice(0, 300)}`);
      }
    } else {
      throw new Error(
        "旧版 .ppt 转换失败：当前系统没有可用的转换工具。Windows 请安装 Microsoft PowerPoint 或 LibreOffice；macOS/Linux 请安装 LibreOffice。"
      );
    }
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 旧版 .ppt：先转成 .pptx 再解析。 */
export async function convertLegacyPpt(sourcePath) {
  const buffer = await convertLegacyPptToBuffer(sourcePath);
  return await convertPptx(buffer);
}

// ---------------------------------------------------------------------------
// PowerPoint (.pptx)
// ---------------------------------------------------------------------------

export async function convertPptx(buffer) {
  const { default: JSZip } = await import("jszip");
  const { XMLParser } = await import("fast-xml-parser");
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: false,
  });
  const parseXml = (xml) => stripTagPrefixes(parser.parse(xml));

  const presFile = zip.file("ppt/presentation.xml");
  if (!presFile) throw new Error("pptx 缺少 presentation.xml");
  const pres = parseXml(await presFile.async("string"));

  // rId → 相对 target
  const relMap = new Map();
  const relsFile = zip.file("ppt/_rels/presentation.xml.rels");
  if (relsFile) {
    const rels = parseXml(await relsFile.async("string"));
    const list = rels?.Relationships?.Relationship;
    for (const r of Array.isArray(list) ? list : list ? [list] : []) {
      relMap.set(r["@_Id"], r["@_Target"]);
    }
  }

  const sldIdList = pres?.presentation?.sldIdLst?.sldId;
  const slideIds = Array.isArray(sldIdList) ? sldIdList : sldIdList ? [sldIdList] : [];
  const slidePaths = [];
  for (const sld of slideIds) {
    const rId = sld["@_r:id"] ?? sld["@_id"];
    const target = rId ? relMap.get(rId) : null;
    if (!target) continue;
    slidePaths.push(normalizePptPath("ppt", target));
  }
  if (slidePaths.length === 0) {
    throw new Error("pptx 未找到任何幻灯片");
  }

  const sections = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const file = zip.file(slidePaths[i]);
    if (!file) continue;
    const xml = parseXml(await file.async("string"));
    const lines = [];
    const tables = [];
    walkForText(xml?.sld ?? xml, lines, tables);
    const body = [];
    for (const line of lines) body.push(line.trimEnd());
    for (const table of tables) body.push(table);
    // 备注
    const noteRelFile = zip.file(slidePaths[i].replace(/^ppt\/slides\//, "ppt/slides/_rels/") + ".rels");
    if (noteRelFile) {
      const noteRels = parseXml(await noteRelFile.async("string"));
      const list = noteRels?.Relationships?.Relationship;
      for (const r of Array.isArray(list) ? list : list ? [list] : []) {
        if ((r["@_Type"] ?? "").includes("notesSlide")) {
          const notePath = normalizePptPath("ppt/slides", r["@_Target"]);
          const noteFile = zip.file(notePath);
          if (noteFile) {
            const noteXml = parseXml(await noteFile.async("string"));
            const noteLines = [];
            walkForText(noteXml?.notesSlide ?? noteXml, noteLines, []);
            const noteText = noteLines.join("\n").trim();
            if (noteText) body.push(`> 备注:\n> ${noteText.split("\n").join("\n> ")}`);
          }
        }
      }
    }
    sections.push({
      heading: `Slide ${i + 1}`,
      level: 2,
      text: body.join("\n\n").trim() || "（本页无文字内容）",
      page: i + 1,
    });
  }
  return { sections, warnings: [], pages: sections.length };
}

/** 剥掉解析结果中标签名的命名空间前缀（属性键 @_* 保持原样，r:id 不会与 id 冲突）。 */
function stripTagPrefixes(obj) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) obj[i] = stripTagPrefixes(obj[i]);
    return obj;
  }
  if (typeof obj !== "object" || obj === null) return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const newKey = key.startsWith("@_") ? key : key.includes(":") ? key.split(":").pop() : key;
    out[newKey] = stripTagPrefixes(value);
  }
  return out;
}

function normalizePptPath(base, target) {
  const t = String(target ?? "").replace(/^\/+/, "");
  const baseParts = base.split("/");
  for (const part of t.split("/")) {
    if (part === "..") baseParts.pop();
    else if (part !== "." && part !== "") baseParts.push(part);
  }
  return baseParts.join("/");
}

/** 遍历幻灯片 XML：收集文本行（表格单独转 markdown 表格）。 */
function walkForText(node, lines, tables) {
  if (Array.isArray(node)) {
    for (const item of node) walkForText(item, lines, tables);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const keys = Object.keys(node);
  if (keys.length === 0) return;
  // 表格节点
  if (keys.includes("tbl")) {
    for (const tbl of Array.isArray(node.tbl) ? node.tbl : [node.tbl]) {
      tables.push(tableToMarkdown(tbl));
    }
  }
  // 段落节点
  if (keys.includes("p") && !keys.includes("tbl")) {
    for (const p of Array.isArray(node.p) ? node.p : [node.p]) {
      const text = paragraphText(p);
      if (text.length > 0) lines.push(text);
    }
  }
  for (const key of keys) {
    if (key === "p" || key === "tbl") continue;
    walkForText(node[key], lines, tables);
  }
}

function paragraphText(p) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    if (typeof node.t === "string" || typeof node.t === "number") {
      out.push(String(node.t));
      return;
    }
    if (node.t !== undefined) {
      const items = Array.isArray(node.t) ? node.t : [node.t];
      for (const item of items) {
        if (typeof item === "string" || typeof item === "number") out.push(String(item));
        else if (item && typeof item === "object") out.push(String(item["#text"] ?? ""));
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "t" || key === "@_x" || key === "@_y") continue;
      if (key === "br") {
        out.push("\n");
        continue;
      }
      walk(node[key]);
    }
  };
  walk(p);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function tableToMarkdown(tbl) {
  const rows = [];
  const trs = tbl?.tr ?? [];
  for (const tr of Array.isArray(trs) ? trs : [trs]) {
    const cells = [];
    for (const tc of Array.isArray(tr?.tc) ? tr.tc : tr?.tc ? [tr.tc] : []) {
      const pTexts = [];
      const collectP = (node) => {
        if (Array.isArray(node)) {
          for (const item of node) collectP(item);
          return;
        }
        if (typeof node !== "object" || node === null) return;
        if (node.p !== undefined) {
          const ps = Array.isArray(node.p) ? node.p : [node.p];
          for (const p of ps) {
            const t = paragraphText(p);
            if (t) pTexts.push(t);
          }
        }
        for (const key of Object.keys(node)) {
          if (key === "p" || key === "t") continue;
          collectP(node[key]);
        }
      };
      collectP(tc);
      cells.push(pTexts.join("<br>").replace(/\|/g, "\\|"));
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const header = `| ${rows[0].join(" | ")} |`;
  const sep = `| ${rows[0].map(() => "---").join(" | ")} |`;
  const body = rows.slice(1).map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [header, sep, body].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// PDF（mupdf）：文字层提取 + 扫描页检测 + OCR
// ---------------------------------------------------------------------------

/**
 * 转换 PDF。返回 { sections, pages, type: pdf-text|pdf-scanned|pdf-mixed,
 * outline, warnings, ocrPages }。
 */
export async function convertPdf(sourcePath, options) {
  const {
    ocrLang = "chi_sim+eng",
    ocrWorkers = 2,
    ocrDpi = 200,
    langPath,
    ocrEngine = "auto",
    ocrNativeBin,
    ocrPythonBin,
    skipOcr = false,
    onProgress,
  } = options ?? {};
  const { default: mupdf } = await import("mupdf");
  const data = await readFile(sourcePath);
  let doc = mupdf.Document.openDocument(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    "application/pdf"
  );
  const pages = doc.countPages();
  if (pages === 0) throw new Error("PDF 没有页面");

  let outline = [];
  try {
    const raw = doc.loadOutline();
    outline = (Array.isArray(raw) ? raw : [])
      .map((o) => (typeof o === "string" ? o : o?.title))
      .filter((t) => typeof t === "string" && t.trim().length > 0)
      .slice(0, 200);
  } catch {
    outline = [];
  }

  if (skipOcr) {
    // 视觉型文档（如影印古籍）：不做文字提取与 OCR，每页占位，
    // 内容经 kb_view 查看原始页面图片。
    const sections = [];
    for (let i = 0; i < pages; i++) {
      sections.push({
        heading: `第 ${i + 1} 页`,
        level: 2,
        text: "（影印古籍页面，文字无法自动识别；请用 kb_view 查看本页原始图片）",
        page: i + 1,
      });
    }
    return { sections, pages, type: "pdf-scanned", outline, warnings: [], ocrPages: 0 };
  }

  // 1) 提取每页文字层（行文本 + 字号，经 walk 遍历，含图像块计数）
  const pageText = [];
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i);
    try {
      let extracted;
      try {
        extracted = extractPageText(page);
      } catch {
        extracted = { lines: [], chars: 0, images: 0 };
      }
      pageText.push({ page: i + 1, ...extracted });
    } finally {
      // WASM 对象需显式销毁，避免等待 GC 期间堆内分配累积
      try { page.destroy(); } catch { /* ignore */ }
    }
  }

  // 2) 判定哪些页是扫描页（文字层稀薄；空白页跳过 OCR）
  const nonzero = pageText.map((p) => p.chars).filter((c) => c > 0);
  const mean =
    nonzero.length > 0 ? nonzero.reduce((a, b) => a + b, 0) / nonzero.length : 0;
  const threshold = Math.max(50, Math.round(mean * 0.15));
  const needOcr = pageText.map((p) => p.chars < threshold && !(p.chars === 0 && p.images === 0));
  const ocrCount = needOcr.filter(Boolean).length;
  const type =
    ocrCount === 0 ? "pdf-text" : ocrCount / pages > 0.5 ? "pdf-scanned" : "pdf-mixed";

  // 3) 扫描页：渲染 + OCR（分批进行：内存有界，且复用 OCR 引擎池）
  const zoom = Math.max(1, Math.round(ocrDpi) / 72);
  const sections = new Array(pages);
  const warnings = [];
  const batchSize = Math.max(8, Math.round(ocrWorkers * 4));
  let ocrDone = 0;
  let docPagesSinceReopen = 0;
  const REOPEN_EVERY = 150;
  // 超大页面（如 A2/A1 幅面的规程扫描件）在 300 DPI 下可达 1.5 亿像素，
  // 会撑爆 tesseract wasm 堆（pixCreate fail → 进程崩溃）。渲染时按像素上限
  // 自适应降档：超大页有效 DPI 降低但页面文字本身大，OCR 仍可读。
  const MAX_RENDER_PIXELS = 24_000_000;
  /** 渲染一页为 PNG，pixmap 用后即毁（WASM 堆有限，等 GC 会累积导致 malloc 失败）。 */
  const renderPagePng = (page, z, pageNo) => {
    let effZ = z;
    try {
      const b = page.getBounds();
      const w = Math.max(1, Math.abs(b[2] - b[0]));
      const h = Math.max(1, Math.abs(b[3] - b[1]));
      const px = w * z;
      const py = h * z;
      if (px * py > MAX_RENDER_PIXELS) {
        effZ = z * Math.sqrt(MAX_RENDER_PIXELS / (px * py));
        warnings.push(
          `第 ${pageNo} 页幅面过大（${Math.round((px * py) / 1e6)}MP），已降档渲染`
        );
      }
    } catch {
      /* getBounds 失败则按原分辨率 */
    }
    const matrix = mupdf.Matrix.scale(effZ, effZ);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      return pixmap.asPNG();
    } finally {
      try { pixmap.destroy(); } catch { /* ignore */ }
    }
  };
  const { ocrImageBatch } = await import("./ocr.js");
  for (let i = 0; i < pages; i++) {
    if (!needOcr[i]) {
      sections[i] = pageToSection(pageText[i], i + 1);
      continue;
    }
    // 每隔若干页销毁并重开文档，释放 WASM 侧缓存（字体/图像等）
    if (docPagesSinceReopen >= REOPEN_EVERY) {
      try { doc.destroy(); } catch { /* ignore */ }
      doc = mupdf.Document.openDocument(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        "application/pdf"
      );
      docPagesSinceReopen = 0;
    }
    const batch = [];
    let j = i;
    while (j < pages && needOcr[j] && batch.length < batchSize) {
      const page = doc.loadPage(j);
      try {
        batch.push({ png: renderPagePng(page, zoom, j + 1), page: j + 1 });
      } catch (error) {
        // 目标分辨率下 WASM 内存不足：降分辨率重试，保证页面内容不丢
        let png = null;
        for (const z of [zoom * 0.5, zoom * 0.25]) {
          try {
            png = renderPagePng(page, z, j + 1);
            if (png) {
              warnings.push(`第 ${j + 1} 页在目标分辨率下渲染内存不足，已降分辨率渲染`);
              break;
            }
          } catch {
            /* 继续降档 */
          }
        }
        if (png) {
          batch.push({ png, page: j + 1 });
        } else {
          warnings.push(`第 ${j + 1} 页渲染失败: ${error?.message ?? error}`);
          sections[j] = { heading: `第 ${j + 1} 页`, level: 2, text: "（页面渲染失败）", page: j + 1 };
        }
      } finally {
        try { page.destroy(); } catch { /* ignore */ }
      }
      j += 1;
      docPagesSinceReopen += 1;
    }
    const results =
      batch.length > 0
        ? await ocrImageBatch(batch, { lang: ocrLang, workers: ocrWorkers, langPath, engine: ocrEngine, nativeBin: ocrNativeBin, pythonBin: ocrPythonBin })
        : [];
    for (const r of results) {
      if (r?.error) {
        warnings.push(`第 ${r.page} 页 OCR 失败: ${r.error}`);
        sections[r.page - 1] = {
          heading: `第 ${r.page} 页`,
          level: 2,
          text: "（OCR 失败，无文字）",
          page: r.page,
        };
        continue;
      }
      const text = normalizeOcrText(r?.text ?? "");
      sections[r.page - 1] = {
        heading: `第 ${r.page} 页`,
        level: 2,
        text: text || "（本页无文字内容）",
        page: r.page,
      };
    }
    ocrDone += batch.length;
    if (typeof onProgress === "function") onProgress(`已 OCR ${ocrDone}/${ocrCount} 页`, ocrDone, ocrCount);
    i = j - 1;
  }
  return { sections, pages, type, outline, warnings, ocrPages: ocrCount };
}

/** 用 StructuredText.walk 逐字符提取每页文字层：行文本 + 行内最大字号 + 图像块计数。 */
function extractPageText(page) {
  const lines = [];
  let chars = 0;
  let images = 0;
  let curLine = "";
  let curSize = 0;
  const stext = page.toStructuredText("preserve-images");
  stext.walk({
    beginLine() {
      curLine = "";
      curSize = 0;
    },
    onChar(rune, _origin, _font, size) {
      curLine += String.fromCodePoint(rune.codePointAt ? rune.codePointAt(0) : rune);
      curSize = Math.max(curSize, Number(size) || 0);
    },
    endLine() {
      const text = curLine.trimEnd();
      if (text.length > 0) {
        lines.push({ text, size: curSize });
        chars += text.length;
      }
    },
    onImageBlock() {
      images += 1;
    },
  });
  return { lines, chars, images };
}

/**
 * 归一化提取出的文本。
 * 某些 PDF 的内嵌字体 ToUnicode 映射损坏：数字与拉丁字母被导成全角、连字符被导成
 * 私用区码位，导致条款号（５．２．２）和标准号（４０６０５）用常规 ASCII 完全搜不到。
 * 这里只做无歧义的还原：全角数字/字母 → 半角、数字之间的全角句点 → 半角点、
 * 全角运算符 → 半角、私用区连字符 → '-'。中文标点、破折号、汉字一概不动。
 * 注意：字母被映射成汉字（犌犅／犜 ← GB/T）的情形本函数无法还原，需重新 OCR。
 */
export function normalizeExtractedText(text) {
  return String(text ?? "")
    .replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/(?<=\d)\uFF0E(?=\d)/g, ".")
    .replace(/\uFF0F/g, "/")
    .replace(/\uFF0B/g, "+")
    .replace(/\uFF0D/g, "-")
    .replace(/\uFF1D/g, "=")
    .replace(/[\uE011\uE012]/g, "-");
}

/** OCR 文本规范化：去掉中文汉字/标点之间的空格（tesseract chi_sim 的常见噪声）。 */
function normalizeOcrText(text) {
  const CJK = "\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef";
  return String(text)
    .replace(new RegExp(`([${CJK}]) +(?=[${CJK}])`, "g"), "$1")
    .replace(new RegExp(` +([，。、；：！？）】」』〉》])`, "g"), "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** 文字页 → 段落：字号显著大于中位数的短行视为标题。 */
function pageToSection(pageData, pageNumber) {
  const { lines, chars } = pageData;
  if (chars === 0) {
    return { heading: `第 ${pageNumber} 页`, level: 2, text: "（本页无文字内容）", page: pageNumber };
  }
  const sizes = lines.map((l) => l.size).filter((s) => s > 0);
  const median = sizes.length > 0 ? sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] : 0;
  const out = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const isHeading =
      median > 0 &&
      line.size >= median * 1.18 &&
      text.length <= 60 &&
      !/^[，。、；：！？,.!?;:)]/.test(text) &&
      !/[。！？.!?]$/.test(text);
    if (isHeading) out.push(`### ${text}`);
    else out.push(text);
  }
  return { heading: `第 ${pageNumber} 页`, level: 2, text: out.join("\n"), page: pageNumber };
}

// ---------------------------------------------------------------------------
// MOBI / AZW3 电子书 → EPUB 转换（Calibre ebook-convert）
// ---------------------------------------------------------------------------

/** 探测 Calibre 的 ebook-convert：显式配置 > 用户环境 > 平台默认位置 > PATH。 */
async function resolveEbookConverter(explicitBin) {
  const { access } = await import("node:fs/promises");
  const candidates = [];
  if (explicitBin) candidates.push({ bin: explicitBin, probe: "run" });
  candidates.push({
    bin: join(homedir(), ".dsh", "tools", "calibre", process.platform === "win32" ? "ebook-convert.exe" : "ebook-convert"),
    probe: "access",
  });
  if (process.platform === "darwin") {
    candidates.push({ bin: "/Applications/calibre.app/Contents/MacOS/ebook-convert", probe: "access" });
  }
  candidates.push({ bin: process.platform === "win32" ? "ebook-convert.exe" : "ebook-convert", probe: "run" });
  for (const { bin, probe } of candidates) {
    try {
      if (probe === "access") {
        await access(bin);
        return bin;
      }
      await execFileAsync(bin, ["--version"], { timeoutMs: 15000 });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 把 mobi/azw/azw3 转换为 epub 缓冲（kb_view 提取内嵌图片与导入解析共用）。 */
export async function convertMobiToEpub(sourcePath, { ebookBin } = {}) {
  const bin = await resolveEbookConverter(ebookBin);
  if (bin === null) {
    throw new Error(
      "MOBI/AZW3 转换失败：本机未找到 Calibre 的 ebook-convert。请安装 Calibre 后重试，或用 Calibre 手动将文件转换为 epub 再导入。"
    );
  }
  const { mkdtemp, rm, readFile: readFileLocal } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "dsh-kb-mobi-"));
  try {
    const out = join(dir, "converted.epub");
    try {
      await execFileAsync(bin, [sourcePath, out], { timeoutMs: 600000 });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`MOBI/AZW3 转换失败（无法启动 ${bin}）: ${error.message}`);
      }
      if (error.killed) {
        throw new Error("MOBI/AZW3 转换超时（600 秒）");
      }
      throw new Error(
        `MOBI/AZW3 转换失败（ebook-convert 退出码 ${error.code ?? "?"}）: ${(error.stderr || "").trim().slice(0, 300)}`
      );
    }
    return await readFileLocal(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 旧版 mobi/azw/azw3：先经 Calibre 转成 epub 再解析。 */
export async function convertMobi(sourcePath, options) {
  const buffer = await convertMobiToEpub(sourcePath, options);
  return await convertEpub(buffer);
}

// ---------------------------------------------------------------------------
// EPUB 电子书（zip + OPF spine + XHTML → Markdown）
// ---------------------------------------------------------------------------

export async function convertEpub(source) {
  const { default: JSZip } = await import("jszip");
  const { XMLParser } = await import("fast-xml-parser");
  // 接受文件路径或 epub 缓冲（mobi 经 Calibre 转换后直接传入缓冲，少一次落盘）
  const buffer = Buffer.isBuffer(source) ? source : await readFile(source);
  const zip = await JSZip.loadAsync(buffer);
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error("EPUB 缺少 META-INF/container.xml");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const container = parser.parse(await containerFile.async("string"));
  const rootfilePath = container?.container?.rootfiles?.rootfile?.["@_full-path"];
  if (!rootfilePath) throw new Error("EPUB 无法定位 OPF 文件");
  const opfDir = dirname(rootfilePath) === "." ? "" : dirname(rootfilePath) + "/";
  const opfFile = zip.file(rootfilePath);
  if (!opfFile) throw new Error(`EPUB 缺少 OPF: ${rootfilePath}`);
  const opf = parser.parse(await opfFile.async("string"));
  const manifest = opf?.package?.manifest?.item;
  const spine = opf?.package?.spine?.itemref;
  const idToHref = new Map();
  for (const item of Array.isArray(manifest) ? manifest : manifest ? [manifest] : []) {
    if (item["@_id"] && item["@_href"]) idToHref.set(item["@_id"], item["@_href"]);
  }
  const refs = Array.isArray(spine) ? spine : spine ? [spine] : [];
  const parts = [];
  for (const ref of refs) {
    const href = idToHref.get(ref["@_idref"]);
    if (!href) continue;
    const file = zip.file(opfDir + href);
    if (!file) continue;
    const html = await file.async("string");
    const md = xhtmlToMarkdown(html);
    if (md.trim().length > 0) parts.push(md);
  }
  if (parts.length === 0) throw new Error("EPUB 没有可解析的正文");
  const md = parts.join("\n\n");
  return { sections: sectionsFromMarkdown(md), warnings: [] };
}

/** XHTML 正文 → Markdown（保留 h1-h6 标题层级，其余标签按段落/换行展开）。 */
function xhtmlToMarkdown(html) {
  return String(html)
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(h[1-6])[^>]*>/gi, (_m, t) => "\n\n" + "#".repeat(Number(t[1])) + " ")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<(p|div|li|tr|blockquote|section|article)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// 纯文本 / Markdown（自动识别 UTF-8 / GBK）
// ---------------------------------------------------------------------------

export async function convertTextFile(sourcePath) {
  const buf = await readFile(sourcePath);
  let text;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.subarray(3).toString("utf8");
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    // UTF-16LE（Windows 记事本「Unicode」格式），剥离 BOM 后解码
    text = buf.subarray(2).toString("utf16le");
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE：逐字节交换为 LE 再解码
    const body = buf.subarray(2);
    const swapped = Buffer.alloc(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    text = swapped.toString("utf16le");
  } else if (isUtf8(buf)) {
    text = buf.toString("utf8");
  } else {
    const { default: iconv } = await import("iconv-lite");
    text = iconv.decode(buf, "gbk");
  }
  const ext = extname(String(sourcePath)).toLowerCase();
  const sections =
    ext === ".md" || ext === ".markdown" ? sectionsFromMarkdown(text) : splitParagraphs(text);
  return { sections, warnings: [] };
}

function isUtf8(buf) {
  let i = 0;
  const len = buf.length;
  while (i < len) {
    const b = buf[i];
    if (b < 0x80) {
      i += 1;
    } else if (b >= 0xc2 && b <= 0xdf) {
      if (i + 1 >= len || (buf[i + 1] & 0xc0) !== 0x80) return false;
      i += 2;
    } else if (b >= 0xe0 && b <= 0xef) {
      if (i + 2 >= len || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80) return false;
      i += 3;
    } else if (b >= 0xf0 && b <= 0xf4) {
      if (i + 3 >= len || (buf[i + 1] & 0xc0) !== 0x80 || (buf[i + 2] & 0xc0) !== 0x80 || (buf[i + 3] & 0xc0) !== 0x80) return false;
      i += 4;
    } else {
      return false;
    }
  }
  return true;
}
