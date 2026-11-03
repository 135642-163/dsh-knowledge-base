#!/usr/bin/env node
/**
 * 按人工核对表修正资料身份（标准号 / 标题 / 可信度 / 摘要）。
 *
 * 用途：文件名只有名称（如 Zotero 的「2015 - 火力发电厂…」）或文件名标准号写错的资料，
 * 在旧解析口径下拿不到标准号 → 标题没有「标准号 名称」前缀、trust 落进批量默认值、
 * 摘要只是正文首段。核对表是人工（或代理）逐篇核对封面后的结论，本脚本只负责落地：
 *
 *   - 用 parseDocMeta(newTitle) 重新计算标准要素，核对表给的 standardNo 必须与之一致；
 *   - 每篇先快照历史版本，再重建合并版 H1、版本号 +1（与 kb_retitle 同一口径）；
 *   - standardSource 记为 manual（人工核对），filenameStandardNo 清空（原文件名不可靠时）；
 *   - 摘要写 summarySource=model，可信度写 trustSource=manual；
 *   - 全部写完刷新 index.md 并写一条 log.md。
 *
 * 用法：
 *   node scripts/apply-doc-identity.mjs --data fix.json      # dry-run
 *   node scripts/apply-doc-identity.mjs --data fix.json --apply
 *
 * 核对表格式：{ "kb": "标准", "entries": [{ docId, fromTitle?, title, standardNo?,
 *   trust, trustReason, summary, warning? }] }
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  expandRoot,
  kbDirPath,
  pruneHistory,
  readManifest,
  rebuildMerged,
  snapshotDocVersion,
  touchDocLocked,
  withManifestLock,
} from "../lib/store.js";
import { refreshKbIndex } from "../lib/import-job.js";
import { appendLog } from "../lib/wiki.js";
import { parseDocMeta } from "../lib/doc-meta.js";

function parseArgs(argv) {
  const args = { root: join(process.env.HOME ?? "", ".dsh", "knowledge"), kb: "", data: "", apply: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") args.root = argv[++i] ?? "";
    else if (a === "--kb") args.kb = argv[++i] ?? "";
    else if (a === "--data") args.data = argv[++i] ?? "";
    else if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log(`用法: node scripts/apply-doc-identity.mjs --data <核对表.json> [--root <kbRoot>] [--kb 库名] [--apply]
  默认 dry-run；--apply 才写清单。核对表: { kb, entries: [{ docId, fromTitle?, title, standardNo?, trust, trustReason, summary, warning? }] }`);
      process.exit(0);
    } else throw new Error(`未知参数: ${a}`);
  }
  if (!args.data) throw new Error("需要 --data <核对表.json>");
  return args;
}

function summarize(text, limit = 60) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = JSON.parse(await readFile(args.data, "utf8"));
  const kbName = args.kb || spec.kb;
  if (!kbName) throw new Error("核对表缺少 kb，或传 --kb");
  const root = expandRoot(args.root);
  if (!existsSync(root)) throw new Error(`kbRoot 不存在: ${root}`);
  const dir = kbDirPath(root, kbName);
  const manifest = await readManifest(dir);
  const byId = new Map((manifest.docs ?? []).map((d) => [d.id, d]));

  const plan = [];
  const errors = [];
  for (const entry of spec.entries ?? []) {
    const doc = byId.get(entry.docId);
    if (!doc) {
      errors.push({ docId: entry.docId, error: "文档不存在" });
      continue;
    }
    if (doc.deletedAt || doc.status !== "ready") {
      errors.push({ docId: entry.docId, error: `状态 ${doc.status}${doc.deletedAt ? "/已删除" : ""}，跳过` });
      continue;
    }
    if (entry.fromTitle && entry.fromTitle !== doc.title) {
      errors.push({ docId: entry.docId, error: `当前标题与核对表不一致：${doc.title}` });
      continue;
    }
    const title = String(entry.title ?? doc.title).trim();
    const meta = parseDocMeta(title, doc.rawTitle || title);
    const expected = String(entry.standardNo ?? "").trim();
    if (expected && meta.standardNo !== expected) {
      errors.push({ docId: entry.docId, error: `标题解析出 ${meta.standardNo || "(空)"}，与 standardNo ${expected} 不一致` });
      continue;
    }
    if (!expected && meta.standardNo) {
      errors.push({ docId: entry.docId, error: `核对表要求无标准号，但标题解析出 ${meta.standardNo}` });
      continue;
    }
    const trust = String(entry.trust ?? "").trim();
    if (!["high", "medium", "low"].includes(trust)) {
      errors.push({ docId: entry.docId, error: `trust 非法：${trust}` });
      continue;
    }
    const summary = String(entry.summary ?? "").replace(/\s+/g, " ").trim();
    if (!summary) {
      errors.push({ docId: entry.docId, error: "缺少摘要" });
      continue;
    }
    plan.push({
      doc,
      title,
      meta,
      standardNo: meta.standardNo,
      trust,
      trustReason: String(entry.trustReason ?? "").trim(),
      summary,
      warning: String(entry.warning ?? "").trim(),
    });
  }

  const report = {
    kb: kbName,
    mode: args.apply ? "apply" : "dry-run",
    planned: plan.length,
    errors,
    changes: plan.map((item) => ({
      docId: item.doc.id,
      from: item.doc.title,
      to: item.title,
      standardNo: item.standardNo,
      titleChanged: item.doc.title !== item.title,
      trust: `${item.doc.trust ?? "?"} → ${item.trust}`,
      summary: summarize(item.summary, 70),
    })),
  };

  if (args.apply && plan.length > 0) {
    const applied = await withManifestLock(dir, async () => {
      const fresh = await readManifest(dir);
      const now = new Date().toISOString();
      let count = 0;
      for (const item of plan) {
        const doc = (fresh.docs ?? []).find((d) => d.id === item.doc.id);
        if (!doc) continue;
        let history = Array.isArray(doc.history) ? [...doc.history] : [];
        try {
          const snap = await snapshotDocVersion(dir, doc, "identity");
          if (snap) history.push(snap);
        } catch {
          /* 历史快照失败不阻塞修正 */
        }
        history = await pruneHistory(dir, doc.id, history);
        const titleChanged = doc.title !== item.title;
        if (titleChanged) {
          doc.title = item.title;
          await rebuildMerged(dir, doc);
        }
        const warnings = Array.isArray(doc.warnings) ? [...doc.warnings] : [];
        if (item.warning && !warnings.includes(item.warning)) warnings.push(item.warning);
        const meta = item.meta;
        await touchDocLocked(dir, fresh, doc.id, {
          title: item.title,
          history,
          titleSource: "manual",
          canonicalTitle: meta.canonicalTitle || item.title,
          standardNo: meta.standardNo,
          standardPrefix: meta.standardPrefix,
          standardNumber: meta.standardNumber,
          standardBase: meta.standardBase,
          standardYear: meta.standardYear,
          standardPart: meta.standardPart,
          standardSource: meta.standardNo ? "manual" : "none",
          filenameStandardNo: "",
          stage: meta.stage,
          stageLabel: meta.stageLabel,
          trust: item.trust,
          trustReason: item.trustReason,
          trustSource: "manual",
          trustUpdatedAt: now,
          summary: item.summary,
          summarySource: "model",
          warnings,
        });
        count += 1;
      }
      return count;
    });
    report.applied = applied;
    await refreshKbIndex(dir);
    await appendLog(dir, {
      action: "fix-identity",
      title: `按封面核对修正资料身份：${applied} 篇`,
      detail: "scripts/apply-doc-identity.mjs（标准号/标题/可信度/摘要）",
    });
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`[apply-doc-identity] ${report.mode} kb=${kbName} 计划 ${report.planned} 篇${report.errors.length ? ` · 错误 ${report.errors.length}` : ""}`);
  for (const change of report.changes) {
    console.log(`- ${change.docId} ${change.from}\n    → ${change.to}${change.standardNo ? `  [${change.standardNo}]` : "  [无标准号]"}  trust ${change.trust}`);
  }
  for (const error of report.errors) console.log(`  ! ${error.docId}: ${error.error}`);
  if (!args.apply) console.log("\n（dry-run：未写入。加 --apply 才改清单）");
  else console.log(`\n已应用 ${report.applied ?? 0} 篇，index.md/log.md 已刷新。`);
}

await main();
