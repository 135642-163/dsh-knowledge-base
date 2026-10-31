#!/usr/bin/env node
/**
 * 纠正被误标成「说明材料/征求意见稿」的标准正文 stage。
 *
 * 背景（2026-10-31 实测）：`parseContentStandard` 曾在正文前 3000 字里找阶段词，
 * 而 Q/GDW 标准的目次/附录清单里几乎都有「编制说明」，GB 类前言里又有
 * 「修改单（不包括勘误的内容）」的样板句，于是正文被判成 notes/comment，
 * 进而让标准更新检查把这些组当成"库内没有正文"（下载会导重复）。
 *
 * 本脚本只改 stage/stageLabel，且要求三重证据：
 *   1. 标题与来源文件名里都没有过程资料标记；
 *   2. 正文前 400 字没有过程资料特征（编制说明/征求意见/报批/送审…）；
 *   3. 正文有标准封面特征（企业标准/国家标准/前言/本标准规定了）且 ≥3000 字。
 * 默认 dry-run；--apply 才写清单（带锁 + 原子写 + 刷新 index.md + 写 log.md）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, updateDocsMetaLocked, withManifestLock, expandRoot, kbDirPath } from "../lib/store.js";
import { appendLog } from "../lib/wiki.js";
import { refreshKbIndex } from "../lib/import-job.js";

const PROC_TITLE = /征求意见|报批|送审|讨论稿|草案|大纲|预审|修订稿|编制说明|修订说明|条文说明|标准说明/;
const PROC_FILE = /征求意见|报批|送审|讨论|草案|大纲|预审|编制说明|修订说明|条文说明|修编情况/;
/** 只看正文开头 400 字：这里是封面/标题页，真编制说明一定在这里露出 */
const PROC_HEAD = /编制说明|征求意见|报批|送审|修编情况介绍|任务来源|编制原则|标准修订工作/;
const TEXT_HEAD = /前言|本标准规定了|本文件规定了|范\s*围|目\s*次/;
/** 扫描件封面 OCR 质量差时正文词可能缺字，但“企业标准/国家标准/行业标准”一般还在 */
const COVER_HEAD = /企业标[准;；]|国家标准|行业标准|地方标准|团体标准|Technical/i;
const MIN_CHARS = 3000;

function parseArgs(argv) {
  const args = { root: "", kb: "", apply: false, limit: 20, report: "", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--root") args.root = argv[++i] ?? "";
    else if (arg === "--kb") args.kb = argv[++i] ?? "";
    else if (arg === "--limit") args.limit = Math.max(1, Number(argv[++i] ?? 20) || 20);
    else if (arg === "--report") args.report = argv[++i] ?? "";
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: node scripts/fix-std-stage.mjs --root <knowledgeRoot> --kb <库名> [--dry-run|--apply] [--limit 20] [--report <out.json>]");
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (!args.root || !args.kb) throw new Error("需要 --root 和 --kb");
  return args;
}

/** 读文档开头的派生 markdown（与 kb_read 同源），用于内容证据。 */
function readDocHead(kbDir, docId, chars = 2500) {
  const md = join(kbDir, "markdown", docId, `${docId}.md`);
  const part = join(kbDir, "markdown", docId, "parts", "0001.md");
  const file = existsSync(md) ? md : existsSync(part) ? part : null;
  return file ? readFileSync(file, "utf8").slice(0, chars) : "";
}

/** 判定单篇文档是否应纠正 stage（返回 { ok, reason, head }）。 */
export function judgeStageFix(doc, kbDir) {
  if (!doc || doc.deletedAt) return { ok: false, reason: "已删除" };
  if (!(doc.stage === "notes" || doc.stage === "comment")) return { ok: false, reason: `stage=${doc.stage}` };
  if (!doc.standardNo) return { ok: false, reason: "没有标准号" };
  if (PROC_TITLE.test(doc.title ?? "")) return { ok: false, reason: "标题即过程资料" };
  if (PROC_FILE.test(doc.sourceFile ?? "")) return { ok: false, reason: "文件名即过程资料" };
  if (Number(doc.chars ?? 0) < MIN_CHARS) return { ok: false, reason: `正文仅 ${doc.chars ?? 0} 字，不像标准正文` };
  const text = readDocHead(kbDir, doc.id);
  if (!text) return { ok: false, reason: "没有派生正文" };
  const stripped = text.replace(/^#[^\n]*\n+/, "").replace(/<!--[^>]*-->/g, "").trim();
  const head400 = stripped.slice(0, 400);
  if (PROC_HEAD.test(head400)) return { ok: false, reason: "正文开头是过程资料" };
  if (!TEXT_HEAD.test(stripped) && !COVER_HEAD.test(head400)) return { ok: false, reason: "正文缺标准封面特征" };
  return { ok: true, head: head400.slice(0, 80).replace(/\s+/g, " ") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kbRoot = expandRoot(args.root);
  const kbDir = kbDirPath(kbRoot, args.kb);
  const manifest = await readManifest(kbDir);

  const plan = [];
  const skipped = [];
  for (const doc of manifest.docs ?? []) {
    if (!(doc.stage === "notes" || doc.stage === "comment")) continue;
    if (doc.deletedAt) continue;
    const verdict = judgeStageFix(doc, kbDir);
    if (verdict.ok) plan.push({ id: doc.id, title: doc.title, from: doc.stage, fromLabel: doc.stageLabel, to: "published", toLabel: "发布稿" });
    else skipped.push({ id: doc.id, title: doc.title, reason: verdict.reason });
  }

  const batch = plan.slice(0, args.limit);
  let applied = 0;
  const batches = [];
  if (args.apply && batch.length > 0) {
    await withManifestLock(kbDir, async () => {
      const fresh = await readManifest(kbDir);
      const patches = batch
        .map((item) => {
          const doc = (fresh.docs ?? []).find((d) => d.id === item.id);
          // 双检：加锁后重新读，确认这篇仍是待改状态（防止并发导入/重解析把 stage 改回去了）
          if (!doc || !(doc.stage === "notes" || doc.stage === "comment")) return null;
          return { docId: item.id, patch: { stage: item.to, stageLabel: item.toLabel } };
        })
        .filter(Boolean);
      applied = await updateDocsMetaLocked(kbDir, fresh, patches);
      batches.push({ at: new Date().toISOString(), count: applied });
    });
    await refreshKbIndex(kbDir);
    await appendLog(kbDir, {
      action: "fix-stage",
      title: `${applied} 篇文档 stage → published`,
      detail: "纠正被内容阶段词误标成说明材料的正文（scripts/fix-std-stage.mjs）",
    });
  }

  const report = {
    kb: args.kb,
    kbDir,
    apply: args.apply,
    candidate: plan.length,
    applied,
    remaining: Math.max(0, plan.length - applied),
    skipped: skipped.length,
    batch: batch.map(({ id, title, from, fromLabel }) => ({ id, title, from, fromLabel })),
    skippedSamples: skipped.slice(0, 20),
  };
  if (args.report) writeFileSync(args.report, JSON.stringify(report, null, 2), "utf8");

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`知识库「${args.kb}」：待纠正 ${plan.length} 篇，本次${args.apply ? "已应用" : "预演"} ${applyPreviewCount(args, batch.length)} 篇${plan.length > batch.length ? `（余 ${plan.length - batch.length} 篇下批）` : ""}`);
  for (const item of batch) console.log(`  ${item.id} | ${item.fromLabel ?? item.from}(${item.from}) → 发布稿(published) | ${item.title.slice(0, 56)}`);
  if (skipped.length > 0) {
    console.log(`\n保持不动 ${skipped.length} 篇（前 10）：`);
    for (const item of skipped.slice(0, 10)) console.log(`  ${item.title.slice(0, 50)}｜${item.reason}`);
  }
  if (!args.apply) console.log("\n（dry-run：未写入。加 --apply 才写清单）");
}

function applyPreviewCount(args, n) {
  return args.apply ? n : n;
}

await main();
