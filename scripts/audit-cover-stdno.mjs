#!/usr/bin/env node
/**
 * 用 PDF/扫描件的**封面标准号**核对元数据里的标准号。
 *
 * 分类：
 *   prefix      编号+年份一致、仅前缀不同（GB → GB/T、NB → NB/T、GB → GB/Z…）——可自动修
 *   year        编号一致、年份不同——多半是文件与标题不一致，需人工判断
 *   number      编号不同——可能是分册号、附件正文里的引用，需人工判断
 *   meta-missing 元数据没有标准号，但封面有
 *
 * 默认 dry-run；--apply --fix-prefix 只修 prefix 类：改标题里的标准号、重建标准字段、
 * 同步派生 markdown 的 H1（不动 stage/trust/正文）。写清单时带锁 + 原子写 + 刷新 index + 写 log。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readManifest, updateDocsMetaLocked, withManifestLock, expandRoot, kbDirPath } from "../lib/store.js";
import { appendLog } from "../lib/wiki.js";
import { refreshKbIndex } from "../lib/import-job.js";
import { parseDocMeta } from "../lib/doc-meta.js";

const STD = /(^|[^A-Za-z])(GB\s*\/\s*[TZ]|GB|DL\s*\/\s*T|DL|NB\s*\/\s*T|NB|JB\s*\/\s*T|JB|IEC\s*\/\s*(?:TS|TR)|IEC|IEEE|EN|T\s*\/\s*[A-Z]{2,}|Q\s*\/\s*GDW)\s*(\d+(?:\.\d+)*(?:-\d+)?)\s*-\s*((?:19|20)\d{2})/;

function parseArgs(argv) {
  const args = { root: "", kb: "", apply: false, limit: 20, report: "", json: false, fixPrefix: false, fixPart: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a === "--fix-prefix") args.fixPrefix = true;
    else if (a === "--fix-part") args.fixPart = true;
    else if (a === "--root") args.root = argv[++i] ?? "";
    else if (a === "--kb") args.kb = argv[++i] ?? "";
    else if (a === "--limit") args.limit = Math.max(1, Number(argv[++i] ?? 20) || 20);
    else if (a === "--report") args.report = argv[++i] ?? "";
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log(`用法: node scripts/audit-cover-stdno.mjs --root <kbRoot> --kb <库名> [--dry-run|--apply --fix-prefix] [--limit 20] [--report out.json]
  默认只报告；
  --apply --fix-prefix  修「仅前缀不同」的那类（编号与年份一致）
  --apply --fix-part    修「标题写了第 N 部分、封面编号也带 .N」且 N 一致的分册号缺失`);
      process.exit(0);
    } else throw new Error(`未知参数: ${a}`);
  }
  if (!args.root || !args.kb) throw new Error("需要 --root 和 --kb");
  return args;
}

const normPrefix = (p) => p.replace(/\s+/g, "").toUpperCase();

/** 取封面区文本：前 700 字，修正 OCR 在编号里插空格与全角破折号。 */
export function coverText(kbDir, docId, n = 700) {
  const f = join(kbDir, "markdown", docId, `${docId}.md`);
  if (!existsSync(f)) return "";
  return readFileSync(f, "utf8")
    .slice(0, n)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^#[^\n]*\n/, " ")
    .replace(/(\d)\s*[.．]\s*(\d)/g, "$1.$2")
    .replace(/[—–－‐]/g, "-");
}

/** 从封面文本取标准号要素；跳过「代替 …」「引用 …」这类提到别人的上下文。 */
export function coverStdNo(text) {
  const t = String(text ?? "");
  const skip = /代替|被替代|代替标准|引用|参见|参照|符合|按照|依据/;
  for (const hit of t.matchAll(new RegExp(STD.source, "g"))) {
    const before = t.slice(Math.max(0, (hit.index ?? 0) - 30), hit.index ?? 0);
    if (skip.test(before)) continue; // 封面上的「代替 GB/T 20000.2—2009」不是本文的标准号
    return { prefix: normPrefix(hit[2]), number: hit[3], year: Number(hit[4]) };
  }
  return null;
}

/** 元数据标准号要素。 */
export function metaStdNo(doc) {
  const s = String(doc?.standardNo ?? "").replace(/\s+/g, "");
  if (!s) return null;
  const m = s.match(/^([A-Za-z/]+?)(\d+(?:\.\d+)*)(?:-(\d{4}))?$/);
  return m ? { prefix: normPrefix(m[1]), number: m[2], year: m[3] ? Number(m[3]) : null, raw: doc.standardNo } : null;
}

function baseOf(number) {
  return String(number).replace(/\.\d+$/, "");
}

/** 审计整个库，返回 { rows, kinds }。 */
export function auditManifest(kbDir, manifest) {
  const rows = [];
  for (const doc of (manifest.docs ?? []).filter((d) => !d.deletedAt)) {
    const cover = coverStdNo(coverText(kbDir, doc.id));
    if (!cover) continue;
    const meta = metaStdNo(doc);
    if (!meta) {
      rows.push({ docId: doc.id, title: doc.title, kind: "meta-missing", cover });
      continue;
    }
    const sameNum = meta.number === cover.number;
    const sameYear = meta.year === cover.year;
    const samePrefix = meta.prefix === cover.prefix;
    if (sameNum && sameYear && samePrefix) continue;
    rows.push({
      docId: doc.id,
      title: doc.title,
      kind: sameNum && sameYear ? "prefix" : sameNum ? "year" : "number",
      meta,
      cover,
    });
  }
  const kinds = rows.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] ?? 0) + 1), acc), {});
  return { rows, kinds };
}

/** 分册类修复：标题写了「第 N 部分」且封面编号尾缀也是 .N 时，补全/纠正分册号。 */
export function planPartFix(doc, cover) {
  const meta = metaStdNo(doc);
  if (!meta) return null;
  const coverPart = /^(\d+(?:\.\d+)*)\.(\d+)$/.exec(String(cover.number));
  if (!coverPart) return null;
  const titlePart = String(doc.title ?? "").match(/第\s*([0-9]+)\s*部分/);
  if (!titlePart || titlePart[1] !== coverPart[2]) return null;
  // 编号主干必须一致（18039 vs 18039.1、1650 vs 1650.4），避免把完全不同的标准改过来
  if (meta.number.replace(/\.\d+$/, "") !== coverPart[1]) return null;
  const coverNo = `${cover.prefix} ${cover.number}-${cover.year}`;
  const title = String(doc.title ?? "");
  const escaped = meta.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  if (!new RegExp(`^\\s*${escaped}(?=\\s|$)`).test(title)) return null;
  const parsed = parseDocMeta(title.replace(new RegExp(`^\\s*${escaped}`), coverNo));
  if (!parsed.standardNo) return null;
  return {
    docId: doc.id,
    from: { title, standardNo: doc.standardNo },
    to: {
      title: parsed.canonicalTitle || title,
      standardNo: parsed.standardNo,
      standardPrefix: parsed.standardPrefix,
      standardNumber: parsed.standardNumber,
      standardBase: baseOf(parsed.standardNumber),
      standardYear: parsed.standardYear,
      standardPart: parsed.standardPart ?? "",
      canonicalTitle: parsed.canonicalTitle || title,
      titleSource: "auto",
    },
  };
}

/** prefix 类修复：标题里的标准号换成封面版本，保名称不变。 */
export function planPrefixFix(kbDir, doc, cover) {
  const meta = metaStdNo(doc);
  if (!meta) return null;
  const coverNo = `${cover.prefix} ${cover.number}-${cover.year}`;
  const title = String(doc.title ?? "");
  const escaped = meta.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  if (!new RegExp(`^\\s*${escaped}(?=\\s|$)`).test(title)) return null; // 标题开头不是这个标准号，安全起见跳过
  const nextTitle = title.replace(new RegExp(`^\\s*${escaped}`), coverNo).replace(/\s+/g, " ").trim();
  const parsed = parseDocMeta(nextTitle);
  if (!parsed.standardNo) return null;
  return {
    docId: doc.id,
    from: { title, standardNo: doc.standardNo },
    to: {
      title: nextTitle,
      standardNo: parsed.standardNo,
      standardPrefix: parsed.standardPrefix,
      standardNumber: parsed.standardNumber,
      standardBase: baseOf(parsed.standardNumber),
      standardYear: parsed.standardYear,
      standardPart: parsed.standardPart ?? "",
      canonicalTitle: parsed.canonicalTitle || nextTitle,
      titleSource: "auto",
    },
  };
}

/** 同步派生 markdown 的 H1（不重建正文，只换首行标题）。 */
async function rewriteHeadline(kbDir, docId, fromTitle, toTitle) {
  const files = [
    join(kbDir, "markdown", docId, `${docId}.md`),
    join(kbDir, "markdown", docId, "parts", "0001.md"),
  ];
  const { writeFile } = await import("node:fs/promises");
  for (const f of files) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    if (!text.startsWith("# ")) continue;
    const firstLineEnd = text.indexOf("\n");
    const first = text.slice(2, firstLineEnd < 0 ? text.length : firstLineEnd).trim();
    if (first !== fromTitle) continue;
    await writeFile(f, `# ${toTitle}${firstLineEnd < 0 ? "\n" : text.slice(firstLineEnd)}`, "utf8");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kbDir = kbDirPath(expandRoot(args.root), args.kb);
  const manifest = await readManifest(kbDir);
  const { rows, kinds } = auditManifest(kbDir, manifest);
  const docById = new Map((manifest.docs ?? []).map((d) => [d.id, d]));

  const fixes = [];
  if (args.fixPrefix) {
    for (const row of rows.filter((r) => r.kind === "prefix")) {
      const plan = planPrefixFix(kbDir, docById.get(row.docId), row.cover);
      if (plan) fixes.push(plan);
    }
  }
  if (args.fixPart) {
    for (const row of rows.filter((r) => r.kind === "number")) {
      const plan = planPartFix(docById.get(row.docId), row.cover);
      if (plan) fixes.push(plan);
    }
  }
  const batch = fixes.slice(0, args.limit);

  let applied = 0;
  if (args.apply && batch.length > 0) {
    await withManifestLock(kbDir, async () => {
      const fresh = await readManifest(kbDir);
      const patches = batch.map((item) => ({ docId: item.docId, patch: item.to }));
      applied = await updateDocsMetaLocked(kbDir, fresh, patches);
    });
    for (const item of batch) await rewriteHeadline(kbDir, item.docId, item.from.title, item.to.title);
    await refreshKbIndex(kbDir);
    await appendLog(kbDir, {
      action: "fix-stdno",
      title: `标准号前缀按封面纠正：${applied} 篇`,
      detail: "scripts/audit-cover-stdno.mjs（封面标准号 vs 元数据）",
    });
  }

  const report = {
    kb: args.kb,
    apply: args.apply,
    audit: { total: rows.length, kinds },
    prefixFixable: fixes.length,
    applied,
    remaining: Math.max(0, fixes.length - applied),
    batch: batch.map((b) => ({ docId: b.docId, from: b.from.standardNo, to: b.to.standardNo, title: b.to.title })),
    rows: args.report ? rows : undefined,
  };
  if (args.report) writeFileSync(args.report, JSON.stringify({ kb: args.kb, kinds, rows }, null, 2), "utf8");
  if (args.json) {
    console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
    return;
  }
  console.log(`知识库「${args.kb}」封面核对：不一致 ${rows.length} 篇 ${JSON.stringify(kinds)}`);
  if (args.fixPrefix || args.fixPart) {
    console.log(`可自动修：${fixes.length} 篇；本次${args.apply ? "已应用" : "预演"} ${batch.length} 篇${fixes.length > batch.length ? `（余 ${fixes.length - batch.length} 篇下批）` : ""}`);
    for (const item of batch) console.log(`  ${item.docId} | ${item.from.standardNo} → ${item.to.standardNo} | ${item.to.title.slice(0, 60)}`);
  }
  if (!args.apply) console.log("\n（dry-run：未写入。加 --apply --fix-prefix 才写清单）");
}

await main();
