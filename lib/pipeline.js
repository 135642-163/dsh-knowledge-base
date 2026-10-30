/**
 * 导入管线：源文件 → 解析为段落 → 分块写入暂存目录 → 原子提交进知识库。
 * 工具内联路径与后台 worker 共用本模块。
 */
import { randomBytes } from "node:crypto";
import { readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { hashFile } from "./hash.js";
import {
  canonicalizeTitle,
  contentIntegrityFor,
  mergeDocMeta,
  parseContentStandard,
  parseCoverTitle,
  parseDocMeta,
  textFingerprint,
  titleKey,
  trustHeuristic,
  withStandardPrefix,
} from "./doc-meta.js";
import { decideDuplicate, matchCandidate } from "./dedup-index.js";
import { isTempFileName } from "./temp-files.js";
import { PARSER_VERSION } from "./version.js";
import {
  commitDoc,
  docIdFor,
  markFailed,
  markImporting,
  markSkipped,
  readManifest,
  touchImportHeartbeat,
  writeParts,
} from "./store.js";
import { appendLog, ensureSchema, summarizeSections, summarizeStandardScope } from "./wiki.js";
import {
  convertDocx,
  convertEpub,
  convertLegacyDoc,
  convertLegacyPptToBuffer,
  convertMobi,
  convertPdf,
  convertPptx,
  convertTextFile,
  convertXlsx,
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

function sameSourcePath(a, b) {
  try {
    return resolve(String(a)) === resolve(String(b));
  } catch {
    return String(a) === String(b);
  }
}

/**
 * 导入一个源文件。
 * @param kbDir 知识库目录（已存在）
 * @param input { sourcePath, relKey, title, config, onProgress, docId?, stableKey?,
 *                sourceFile?, storedSourcePath?, forceReparse? }
 *   docId 可选：显式指定文档 id（迁移/续传/重解析场景用，跳过 relKey 哈希）
 *   stableKey 可选：relKey 是调用方定义的稳定逻辑 key（如标准下载的
 *   std-download/xxx.pdf），来源临时路径变化不代表换了文件，不做同名冲突检测。
 *   storedSourcePath 可选：写清单时保留的来源路径（重解析时保留原始外部路径）。
 *   forceReparse 可选：即使文件哈希与管线版本都没变也重新解析。
 * @returns 导入报告 { docId, title, type, pages, chars, parts, warnings, ms, collision?, skippedUnchanged? }
 */
export async function importFileInto(kbDir, input) {
  const { sourcePath, relKey, title, config, onProgress } = input;
  const started = Date.now();
  const ext = extname(String(sourcePath)).toLowerCase();
  const kind = kindForPath(sourcePath);
  const sourcePathAbs = resolve(String(sourcePath));
  const sourceFile = input.sourceFile ?? basename(String(sourcePath));
  const storedSourcePath =
    input.storedSourcePath !== undefined ? String(input.storedSourcePath) : sourcePathAbs;
  let docId = input.docId ?? docIdFor(relKey);
  const rawTitle = String(input.rawTitle ?? title ?? basename(String(sourcePath), ext)).trim();
  let docTitle = String(title ?? basename(String(sourcePath), ext)).trim().slice(0, 200) || sourceFile;
  const filenameMeta = parseDocMeta(docTitle, rawTitle);
  if (filenameMeta.standardNo) docTitle = canonicalizeTitle(docTitle);
  const dedupIndex = input.dedupIndex ?? null;
  const allowCrossKb = input.allowCrossKb === true;

  if (!kind) {
    throw new Error(
      `不支持的文件类型 "${ext}"（支持: ${SUPPORTED_EXTS.join(", ")}；.doc/.ppt 会自动经本机 Word/PowerPoint 转换）`
    );
  }

  // 建库时落一份维护规范（已存在则不覆盖）；解析失败也不影响，只做 best-effort
  await ensureSchema(kbDir, basename(kbDir)).catch(() => {});

  const sourceHash = input.sourceHash ?? (await hashFile(sourcePath));
  const forceReparse = input.forceReparse === true || config?.forceReparse === true;
  const requestedOcrModel = config?.ocrModel === "fast" ? "fast" : "best";

  // 同名不同文件保护：单文件导入的 relKey 只有 basename，两个不同目录的
  // 「通知.pdf」会得到同一个 docId，旧实现会静默覆盖第一份。
  // 旧清单没有 sourcePath 时无法追溯（只在 warnings 里提示一次）；新导入
  // 会记录 sourcePath，后续同路径=原位更新、不同路径=另建文档。
  let collision = null;
  let legacyPrev = null;
  const manifest = await readManifest(kbDir);
  let prevDoc = (manifest.docs ?? []).find((d) => d.id === docId) ?? null;

  // 内容与管线版本都没变：不重跑解析/OCR（kb_reparse 会传 forceReparse 绕过）
  if (
    !forceReparse &&
    config?.forceOcr !== true &&
    prevDoc?.status === "ready" &&
    prevDoc.sourceHash === sourceHash &&
    prevDoc.parserVersion === PARSER_VERSION &&
    prevDoc.title === docTitle &&
    (prevDoc.ocrModel ?? "best") === requestedOcrModel
  ) {
    return {
      docId,
      title: docTitle,
      type: prevDoc.type,
      pages: prevDoc.pages ?? 0,
      chars: prevDoc.chars ?? 0,
      parts: prevDoc.parts ?? 1,
      warnings: [],
      skippedUnchanged: true,
      version: prevDoc.version ?? 0,
      ms: Date.now() - started,
    };
  }

  // 非 stableKey 的调用都做同名冲突检测（单文件 basename 与目录相对路径都算）；
  // kb_std_check 使用 stableKey 的合成 key，下载临时路径变化不代表换了文件，
  // 仍应原位更新。
  if (input.docId === undefined && input.stableKey !== true) {
    legacyPrev = prevDoc;
    if (
      prevDoc &&
      typeof prevDoc.sourcePath === "string" &&
      prevDoc.sourcePath.trim() !== "" &&
      !sameSourcePath(prevDoc.sourcePath, storedSourcePath)
    ) {
      const altId = docIdFor(`${relKey}|${sourcePathAbs.replace(/\\/g, "/")}`);
      collision = { previousId: prevDoc.id, previousSourcePath: prevDoc.sourcePath, docId: altId };
      docId = altId;
      prevDoc = (manifest.docs ?? []).find((d) => d.id === docId) ?? null;
      legacyPrev = prevDoc;
    }
  }

  // 解析前只能可靠判定“同一文件/同一标题”；标准号是否与封面一致要等解析后，
  // 因此这里先拦 sourceHash/title，std 留给解析后的完整性矩阵。
  if (!forceReparse && dedupIndex) {
    const preHits = matchCandidate(dedupIndex, {
      ...filenameMeta,
      sourceHash,
      docId,
      contentIntegrity: "unknown",
    }).filter((hit) => hit.kind === "source-hash" || hit.kind === "title-exact");
    const preDecision = decideDuplicate(preHits, { ...filenameMeta, contentIntegrity: "unknown" }, { allowCrossKb });
    if (preDecision.skip) {
      return {
        docId,
        title: docTitle,
        type: "skipped",
        pages: 0,
        chars: 0,
        parts: 0,
        warnings: [],
        skipped: true,
        reason: preDecision.reason,
        duplicate: preDecision.match,
        ms: Date.now() - started,
      };
    }
  }

  const staged = join(kbDir, "import-tmp", `${docId}-${randomBytes(4).toString("hex")}`);
  let heartbeatTimer = null;
  const baseEntry = {
    id: docId,
    title: docTitle,
    rawTitle,
    canonicalTitle: filenameMeta.canonicalTitle,
    sourceFile,
    sourcePath: storedSourcePath,
    sourceHash,
    parserVersion: PARSER_VERSION,
    contentSource: "unknown",
    ocrPages: 0,
    ocrEngine: "",
    ocrDpi: 0,
    ocrLang: "",
    ocrModel: requestedOcrModel,
    ocrConfidence: null,
    lowConfidencePages: [],
    corruptedPages: [],
    edited: false,
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
    // 长 OCR 可能超过 30 分钟的活跃窗口；每 60 秒刷新一次 heartbeatAt，
    // 让并发的同一文档导入继续被判定为“导入中”，而不是重复跑一遍。
    heartbeatTimer = setInterval(() => {
      void touchImportHeartbeat(kbDir, docId);
    }, 60_000);
    heartbeatTimer.unref?.();
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
        columnReorder: config?.pdfColumnReorder !== false,
        autoDownloadModels: config?.autoDownloadModels,
        ocrNativeBin: config?.ocrNativeBin,
        ocrPythonBin: config?.ocrPythonBin,
        skipOcr: config?.skipOcr === true,
        forceOcr: config?.forceOcr === true,
        forceOcrPages: config?.forceOcrPages,
        skipOcrPages: config?.skipOcrPages,
        onProgress,
      });
      parsed = {
        sections: r.sections,
        warnings: r.warnings,
        pages: r.pages,
        type: r.type,
        outline: r.outline,
        ocrPages: r.ocrPages ?? 0,
        pageQuality: r.pageQuality ?? [],
        lowConfidencePages: r.lowConfidencePages ?? [],
        corruptedPages: r.corruptedPages ?? [],
        ocrConfidence: r.ocrConfidence ?? null,
      };
    } else if (kind === "xlsx") {
      const r = await convertXlsx(await readFile(sourcePath));
      parsed = {
        sections: r.sections,
        warnings: r.warnings,
        pages: 0,
        type: "xlsx",
        outline: outlineFromSections(r.sections),
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
    if (Array.isArray(parsed.outline)) {
      parsed.outline = parsed.outline.map((item) =>
        typeof item === "string"
          ? normalizeExtractedText(item)
          : { ...item, title: normalizeExtractedText(item?.title ?? "") }
      );
    }

    // 1.5.1) 标准/书籍：正文/封面优先；其他资料只用文件名/标题。
    const standardEligible = kind !== "xlsx"
      && (Boolean(filenameMeta.standardNo) || kind === "epub" || kind === "mobi");
    let contentMeta = null;
    if (standardEligible) {
      contentMeta = parseContentStandard(parsed.sections, { expectedStandardNo: filenameMeta.standardNo });
      if (!filenameMeta.standardNo && (kind === "epub" || kind === "mobi")) {
        const cover = parseCoverTitle(parsed.sections);
        if (cover && (docTitle.length <= 2 || /^(?:book|untitled|\d+)$/i.test(docTitle))) docTitle = cover.title;
      }
    }
    const mergedMeta = mergeDocMeta(filenameMeta, contentMeta);
    if (mergedMeta.standardSource === "content" && mergedMeta.contentTitle) {
      const onlyStandard = docTitle === filenameMeta.standardNo || titleKey(docTitle) === titleKey(filenameMeta.standardNo);
      docTitle = canonicalizeTitle(onlyStandard ? `${mergedMeta.standardNo} ${mergedMeta.contentTitle}` : docTitle);
    } else if (filenameMeta.standardNo) {
      docTitle = canonicalizeTitle(docTitle);
    }
    // 0.31.3：标准类资料统一「标准号 + 名称」，编号只来自规范标准号（不含“（发布稿）”等阶段）。
    if (mergedMeta.standardNo) docTitle = withStandardPrefix(docTitle, mergedMeta.standardNo);
    const integrity = contentIntegrityFor(parsed, { kind });
    const textHash = textFingerprint(parsed.sections);

    // 1.6) 同名冲突/旧清单提示（随文档 warnings 一起落盘）
    const warnings = [...(parsed.warnings ?? [])];
    if (collision) {
      warnings.push(
        `检测到同名不同文件：原文档 ${collision.previousId} 来自另一个目录，本次另建文档 ${docId}`
      );
    } else if (legacyPrev && !legacyPrev.sourcePath && (legacyPrev.status ?? "ready") === "ready") {
      warnings.push(
        "旧条目未记录来源路径，本次按同名原位更新；若为同名不同文件，请用 title 参数区分后重新导入"
      );
    }
    if (mergedMeta.standardSource === "content" && mergedMeta.filenameStandardNo
      && mergedMeta.filenameStandardNo !== mergedMeta.standardNo) {
      warnings.push(
        `文件名标准号「${mergedMeta.filenameStandardNo}」与封面/正文「${mergedMeta.standardNo}」不一致，已按正文处理`
      );
    }
    if (mergedMeta.standardNo && integrity.integrity !== "full") {
      warnings.push(`正文完整性判定为 ${integrity.integrity}（正文 ${integrity.bodyChars} 字，条款 ${integrity.clauseCount} 条）`);
    }
    if (!forceReparse && dedupIndex) {
      const hits = matchCandidate(dedupIndex, {
        ...mergedMeta,
        sourceHash,
        textHash,
        docId,
        contentIntegrity: integrity.integrity,
      });
      const decision = decideDuplicate(
        hits,
        { ...mergedMeta, contentIntegrity: integrity.integrity },
        { allowCrossKb }
      );
      if (decision.skip) {
        await rm(staged, { recursive: true, force: true }).catch(() => {});
        await markSkipped(kbDir, docId).catch(() => {});
        return {
          docId,
          title: docTitle,
          type: "skipped",
          pages: 0,
          chars: 0,
          parts: 0,
          warnings,
          skipped: true,
          reason: decision.reason,
          duplicate: decision.match,
          ms: Date.now() - started,
        };
      }
      if (decision.replacesIncomplete) {
        warnings.push("库内已有同标准的残缺版本；本次保留完整版，请人工清理旧文档");
      }
    }

    // 1.7) 内容来源与 OCR 元数据（用于识别旧管线产物 / 跳过未变化的导入）
    const contentSource = contentSourceFor(kind, parsed.type);
    const ocrPages = Number(parsed.ocrPages) || 0;
    const ocrEngine = ocrPages > 0 ? String(config?.ocrEngine || "auto") : "";
    const ocrDpi = ocrPages > 0 ? Number(config?.ocrDpi) || 0 : 0;
    const ocrLang = ocrPages > 0 ? String(config?.ocrLang || "") : "";
    const lowConfidencePages = Array.isArray(parsed.lowConfidencePages)
      ? parsed.lowConfidencePages.slice(0, 500)
      : [];
    const corruptedPages = Array.isArray(parsed.corruptedPages)
      ? parsed.corruptedPages.slice(0, 500)
      : [];
    const ocrConfidence = Number.isFinite(parsed.ocrConfidence) ? parsed.ocrConfidence : null;
    if (Array.isArray(parsed.pageQuality) && parsed.pageQuality.length > 0) {
      await writeFile(
        join(staged, "pages.json"),
        JSON.stringify(parsed.pageQuality, null, 2),
        "utf8"
      );
    }

    // 2) 分块 + 合并版写入暂存目录（writeParts 同时产出 parts/index.json 与结构化 outline）
    const { parts, chars, outline: partOutline } = await writeParts(staged, parsed.sections, {
      partMaxChars: config?.partMaxChars,
      docTitle,
    });
    // PDF 的页面级 heading（第 N 页）不适合当目录；保留 PDF 书签，转成结构化条目。
    const outline = kind === "pdf" ? normalizeOutlineItems(parsed.outline) : partOutline;
    // 抽取式摘要兜底：没有人工/模型编目时，index.md 与 kb_list 也有一行可读说明。
    // 标准类资料优先取第 1 章「范围」；编制说明（stage=notes）和英文标题不套用。
    const scopeSummary = mergedMeta.standardNo && mergedMeta.stage !== "notes" && /[\u4e00-\u9fa5]/.test(docTitle)
      ? summarizeStandardScope(parsed.sections.map((section) => section.text).join("\n\n"), 160, { title: docTitle })
      : "";
    const summary = scopeSummary || summarizeSections(parsed.sections, 160);
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

    const trust = trustHeuristic(mergedMeta);
    const standardFields = mergedMeta.standardNo
      ? {
          standardNo: mergedMeta.standardNo,
          standardPrefix: mergedMeta.standardPrefix,
          standardNumber: mergedMeta.standardNumber,
          standardBase: mergedMeta.standardBase,
          standardYear: mergedMeta.standardYear,
          standardPart: mergedMeta.standardPart,
          stage: mergedMeta.stage,
          stageLabel: mergedMeta.stageLabel,
        }
      : { stage: "unknown", stageLabel: "" };

    // 3) 原子提交
    await commitDoc(kbDir, {
      docId,
      sourcePath: sourcePathAbs,
      storedSourcePath,
      sourceExt: ext,
      sourceFile,
      sourceHash,
      rawTitle: rawTitle || docTitle,
      canonicalTitle: mergedMeta.canonicalTitle || docTitle,
      ...standardFields,
      standardSource: mergedMeta.standardSource ?? "none",
      filenameStandardNo: mergedMeta.filenameStandardNo ?? "",
      contentTitle: mergedMeta.contentTitle ?? "",
      contentIntegrity: integrity.integrity,
      bodyChars: integrity.bodyChars,
      clauseCount: integrity.clauseCount,
      textHash,
      textHashAlgo: "sha256-norm-v1",
      trust: trust.trust,
      trustReason: trust.reason,
      trustSource: trust.trust === "unknown" ? "unknown" : "heuristic",
      parserVersion: PARSER_VERSION,
      contentSource,
      ocrPages,
      ocrEngine,
      ocrDpi,
      ocrLang,
      ocrModel: requestedOcrModel,
      ocrConfidence,
      lowConfidencePages,
      corruptedPages,
      edited: false,
      stagedDir: staged,
      title: docTitle,
      type: parsed.type,
      pages: parsed.pages,
      chars,
      parts,
      outline,
      warnings,
      summary,
      summarySource: "auto",
      snapshotReason: forceReparse ? "reparse" : "import",
    });
    await appendLog(kbDir, {
      action: forceReparse ? "reparse" : "ingest",
      title: docTitle,
      docId,
      version: (prevDoc?.version ?? 0) + 1,
      detail: `${parts} 部分 ${chars} 字`,
    });
    return {
      docId,
      title: docTitle,
      type: parsed.type,
      pages: parsed.pages,
      chars,
      parts,
      warnings,
      summary,
      sourceHash,
      textHash,
      standardNo: mergedMeta.standardNo || "",
      standardSource: mergedMeta.standardSource ?? "none",
      contentIntegrity: integrity.integrity,
      contentSource,
      ocrConfidence,
      lowConfidencePages,
      corruptedPages,
      version: (prevDoc?.version ?? 0) + 1,
      ...(collision ? { collision } : {}),
      ms: Date.now() - started,
    };
  } catch (error) {
    await rm(staged, { recursive: true, force: true }).catch(() => {});
    await markFailed(kbDir, {
      ...baseEntry,
      error: String(error?.message ?? error),
    }).catch(() => {});
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

function contentSourceFor(kind, type) {
  if (kind === "pdf") {
    if (type === "pdf-text") return "text-layer";
    if (type === "pdf-mixed") return "mixed";
    return "ocr";
  }
  if (kind === "docx" || kind === "pptx" || kind === "xlsx" || kind === "epub" || kind === "mobi") return "converted";
  if (kind === "markdown" || kind === "text") return "text";
  return "unknown";
}

function normalizeOutlineItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) =>
      typeof item === "string"
        ? { title: item, level: 1, page: null, part: null }
        : {
            title: String(item?.title ?? ""),
            level: Number(item?.level) || 1,
            page: item?.page ?? null,
            part: item?.part ?? null,
          }
    )
    .filter((item) => item.title.length > 0)
    .slice(0, 200);
}

function outlineFromSections(sections) {
  return sections
    .filter((s) => s.heading && (s.level ?? 1) <= 2)
    .map((s) => s.heading)
    .slice(0, 200);
}

/**
 * 目录递归扫描支持的源文件（相对 key 用于生成稳定 docId）。
 * 临时/锁文件（Office 所有者文件、LibreOffice 锁、系统垃圾）跳过并回调 onSkip，
 * 不计入 maxFiles；单文件输入本身是临时文件时直接报错。
 */
export async function collectSources(path, { maxFiles = 2000, onSkip } = {}) {
  let st;
  try {
    st = await stat(path);
  } catch {
    throw new Error(`路径不存在: ${path}`);
  }
  const files = [];
  let skippedTempFiles = 0;
  if (st.isDirectory()) {
    const walk = async (dir, base) => {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        // 先判临时/锁文件再判点文件：`.~lock.*` / `.DS_Store` 也要报告，
        // 其余点文件（如 .git）仍静默忽略。
        if (isTempFileName(e.name)) {
          skippedTempFiles += 1;
          onSkip?.(full);
          continue;
        }
        if (e.name.startsWith(".")) continue;
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
          // 只统计可导入的文件；临时文件在上面已跳过，不占额度。
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
    if (isTempFileName(basename(path))) {
      throw new Error(`临时/锁文件不支持导入：${basename(path)}`);
    }
    files.push({ path, relKey: basename(path), size: st.size });
  } else {
    throw new Error(`路径不是文件也不是目录: ${path}`);
  }
  if (files.length === 0) {
    if (skippedTempFiles > 0) {
      throw new Error(`目录中没有可导入的文件（已跳过 ${skippedTempFiles} 个临时文件）`);
    }
    throw new Error(`没有找到可导入的文件（支持: ${SUPPORTED_EXTS.join(", ")}）`);
  }
  return files;
}
