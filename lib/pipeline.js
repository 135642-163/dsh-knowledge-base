/**
 * 导入管线：源文件 → 解析为段落 → 分块写入暂存目录 → 原子提交进知识库。
 * 工具内联路径与后台 worker 共用本模块。
 */
import { randomBytes } from "node:crypto";
import { readFile, mkdir, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  commitDoc,
  docIdFor,
  markFailed,
  markImporting,
  writeParts,
} from "./store.js";
import {
  convertDocx,
  convertEpub,
  convertLegacyDoc,
  convertLegacyPptToBuffer,
  convertMobi,
  convertPdf,
  convertPptx,
  convertTextFile,
  kindForPath,
  normalizeExtractedText,
  SUPPORTED_EXTS,
} from "./parsers.js";

export { SUPPORTED_EXTS, kindForPath };

/** 预扫描 PDF 页数（用于内联/后台分流决策），失败返回 0。 */
export async function preScanPdfPages(sourcePath) {
  let doc;
  try {
    const { default: mupdf } = await import("mupdf");
    const data = await readFile(sourcePath);
    doc = mupdf.Document.openDocument(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      "application/pdf"
    );
    return doc.countPages();
  } catch {
    return 0;
  } finally {
    // WASM 对象需显式销毁，避免等待 GC 期间堆内分配累积
    try { doc?.destroy(); } catch { /* ignore */ }
  }
}

/**
 * 导入一个源文件。
 * @param kbDir 知识库目录（已存在）
 * @param input { sourcePath, relKey, title, config, onProgress, docId? }
 *   docId 可选：显式指定文档 id（迁移/续传场景用，跳过 relKey 哈希）
 * @returns 导入报告 { docId, title, type, pages, chars, parts, warnings, ms }
 */
export async function importFileInto(kbDir, input) {
  const { sourcePath, relKey, title, config, onProgress } = input;
  const started = Date.now();
  const ext = extname(String(sourcePath)).toLowerCase();
  const kind = kindForPath(sourcePath);
  const docId = input.docId ?? docIdFor(relKey);
  const docTitle = String(title ?? basename(String(sourcePath), ext)).trim().slice(0, 200) || basename(String(sourcePath));

  if (!kind) {
    throw new Error(
      `不支持的文件类型 "${ext}"（支持: ${SUPPORTED_EXTS.join(", ")}；.doc/.ppt 会自动经本机 Word/PowerPoint 转换）`
    );
  }

  const staged = join(kbDir, "import-tmp", `${docId}-${randomBytes(4).toString("hex")}`);
  const baseEntry = {
    id: docId,
    title: docTitle,
    sourceFile: basename(String(sourcePath)),
    type: kind,
    pages: 0,
    chars: 0,
    parts: 0,
    outline: [],
    warnings: [],
  };

  try {
    // 同一文档 30 分钟内有活跃导入时跳过，避免重复发起互相覆盖
    if (!(await markImporting(kbDir, baseEntry))) {
      return {
        docId,
        title: docTitle,
        type: "skipped",
        pages: 0,
        chars: 0,
        parts: 0,
        warnings: [],
        skipped: true,
        ms: Date.now() - started,
      };
    }
    await mkdir(staged, { recursive: true });

    // 1) 解析
    let parsed;
    if (kind === "docx") {
      const r = ext === ".doc" ? await convertLegacyDoc(sourcePath) : await convertDocx(await readFile(sourcePath));
      parsed = { ...r, pages: 0, type: "docx", outline: outlineFromSections(r.sections) };
    } else if (kind === "pptx") {
      const buffer = ext === ".ppt" ? await convertLegacyPptToBuffer(sourcePath) : await readFile(sourcePath);
      const r = await convertPptx(buffer);
      parsed = {
        sections: r.sections,
        warnings: r.warnings,
        pages: r.pages,
        type: "pptx",
        outline: r.sections.map((s) => s.heading).filter(Boolean).slice(0, 200),
      };
    } else if (kind === "pdf") {
      const r = await convertPdf(sourcePath, {
        ocrLang: config?.ocrLang,
        ocrWorkers: config?.ocrWorkers,
        ocrDpi: config?.ocrDpi,
        langPath: config?.langPath,
        ocrEngine: config?.ocrEngine,
        ocrNativeBin: config?.ocrNativeBin,
        ocrPythonBin: config?.ocrPythonBin,
        skipOcr: config?.skipOcr === true,
        forceOcr: config?.forceOcr === true,
        onProgress,
      });
      parsed = {
        sections: r.sections,
        warnings: r.warnings,
        pages: r.pages,
        type: r.type,
        outline: r.outline,
      };
    } else if (kind === "epub") {
      const r = await convertEpub(sourcePath);
      parsed = {
        sections: r.sections,
        warnings: r.warnings,
        pages: 0,
        type: "epub",
        outline: outlineFromSections(r.sections),
      };
    } else if (kind === "mobi") {
      const r = await convertMobi(sourcePath, { ebookBin: config?.ebookConvertBin });
      parsed = {
        sections: r.sections,
        warnings: r.warnings,
        pages: 0,
        type: "mobi",
        outline: outlineFromSections(r.sections),
      };
    } else {
      const r = await convertTextFile(sourcePath);
      parsed = {
        sections: r.sections,
        warnings: [],
        pages: 0,
        type: kind,
        outline: outlineFromSections(r.sections),
      };
    }

    // 1.5) 文本归一化：修复字体映射损坏 PDF 导出的全角数字/字母与私用区标点，
    //      使条款号（５．２．２→5.2.2）与标准号（４０６０５→40605）可被常规检索命中
    for (const section of parsed.sections ?? []) {
      if (section.heading) section.heading = normalizeExtractedText(section.heading);
      if (section.text) section.text = normalizeExtractedText(section.text);
    }
    if (Array.isArray(parsed.outline)) parsed.outline = parsed.outline.map((h) => normalizeExtractedText(h));

    // 2) 分块 + 合并版写入暂存目录
    const { parts, chars } = await writeParts(staged, parsed.sections, {
      partMaxChars: config?.partMaxChars,
      docTitle,
    });
    {
      const { readdir, writeFile } = await import("node:fs/promises");
      const partsDir = join(staged, "parts");
      const partFiles = (await readdir(partsDir)).filter((f) => /^\d{4}\.md$/.test(f)).sort();
      let merged = `# ${docTitle}\n\n`;
      for (const f of partFiles) {
        merged += (await readFile(join(partsDir, f), "utf8")).trimEnd() + "\n\n";
      }
      await writeFile(join(staged, `${docId}.md`), merged.trimEnd() + "\n", "utf8");
    }

    // 3) 原子提交
    await commitDoc(kbDir, {
      docId,
      sourcePath,
      sourceExt: ext,
      stagedDir: staged,
      title: docTitle,
      type: parsed.type,
      pages: parsed.pages,
      chars,
      parts,
      outline: parsed.outline,
      warnings: parsed.warnings,
    });
    return {
      docId,
      title: docTitle,
      type: parsed.type,
      pages: parsed.pages,
      chars,
      parts,
      warnings: parsed.warnings,
      ms: Date.now() - started,
    };
  } catch (error) {
    await rm(staged, { recursive: true, force: true }).catch(() => {});
    await markFailed(kbDir, {
      ...baseEntry,
      error: String(error?.message ?? error),
    }).catch(() => {});
    throw error;
  }
}

function outlineFromSections(sections) {
  return sections
    .filter((s) => s.heading && (s.level ?? 1) <= 2)
    .map((s) => s.heading)
    .slice(0, 200);
}

/** 目录递归扫描支持的源文件（相对 key 用于生成稳定 docId）。 */
export async function collectSources(path, { maxFiles = 2000 } = {}) {
  let st;
  try {
    st = await stat(path);
  } catch {
    throw new Error(`路径不存在: ${path}`);
  }
  const files = [];
  if (st.isDirectory()) {
    const walk = async (dir, base) => {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = join(dir, e.name);
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(full, rel);
        } else if (e.isFile() && kindForPath(e.name)) {
          let size = 0;
          try {
            size = (await stat(full)).size;
          } catch {
            size = 0;
          }
          files.push({ path: full, relKey: rel, size });
          if (files.length >= maxFiles) throw new Error(`目录中文件过多（超过 ${maxFiles} 个），请分批导入`);
        }
      }
    };
    try {
      await walk(path, "");
    } catch (error) {
      if (!String(error.message).includes("分批导入")) throw error;
    }
    files.sort((a, b) => a.size - b.size);
  } else if (st.isFile()) {
    files.push({ path, relKey: basename(path), size: st.size });
  } else {
    throw new Error(`路径不是文件也不是目录: ${path}`);
  }
  if (files.length === 0) {
    throw new Error(`没有找到可导入的文件（支持: ${SUPPORTED_EXTS.join(", ")}）`);
  }
  return files;
}
