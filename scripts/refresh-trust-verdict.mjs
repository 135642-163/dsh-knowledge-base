#!/usr/bin/env node
/**
 * 用标准网检查结果刷新「已发布标准（需按现行/废止再核对）」这类占位理由。
 *
 * 只处理 trustReason 仍是占位文案的文档：
 *   - 检查结果为 current（站点现行）→ 理由改为「站点核对现行（标准网 YYYY-MM-DD）」
 * 不改变 trust 级别与 trustSource（保留人工 high）；--apply 才写。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, updateDocsMetaLocked, withManifestLock, expandRoot, kbDirPath } from "../lib/store.js";
import { appendLog } from "../lib/wiki.js";
import { refreshKbIndex } from "../lib/import-job.js";

const STALE = /需按现行\/废止再核对|尚未核实现行\/废止/;
const norm = (s) => String(s ?? "").replace(/[∕／]/g, "/").replace(/\s+/g, "").toUpperCase();

function parseArgs(argv) {
  const args = { root: "", kb: "", apply: false, limit: 20, report: "", json: false, date: new Date().toISOString().slice(0, 10) };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a === "--root") args.root = argv[++i] ?? "";
    else if (a === "--kb") args.kb = argv[++i] ?? "";
    else if (a === "--limit") args.limit = Math.max(1, Number(argv[++i] ?? 20) || 20);
    else if (a === "--report") args.report = argv[++i] ?? "";
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log("用法: node scripts/refresh-trust-verdict.mjs --root <kbRoot> --kb <库名> [--dry-run|--apply] [--limit 20] [--report out.json]");
      process.exit(0);
    } else throw new Error(`未知参数: ${a}`);
  }
  if (!args.root || !args.kb) throw new Error("需要 --root 和 --kb");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kbDir = kbDirPath(expandRoot(args.root), args.kb);
  const manifest = await readManifest(kbDir);
  let cache = { items: {} };
  try {
    cache = JSON.parse(readFileSync(join(kbDir, ".std-check.json"), "utf8"));
  } catch {
    /* 没有检查缓存就什么也做不了 */
  }
  // 站点核对为现行的标准号（按 current 条目）
  const current = new Set();
  for (const item of Object.values(cache.items ?? {})) {
    if (item.status !== "current") continue;
    const no = norm(item.siteNo ?? "");
    if (no) current.add(no);
  }
  const reason = `站点核对现行（标准网 ${args.date}）`;
  const live = (manifest.docs ?? []).filter((d) => !d.deletedAt);
  const todo = [];
  for (const doc of live) {
    if (!STALE.test(doc.trustReason ?? "")) continue;
    if (!current.has(norm(doc.standardNo))) continue;
    if (doc.trustReason === reason) continue;
    todo.push({ docId: doc.id, title: doc.title, standardNo: doc.standardNo, from: doc.trustReason, trust: doc.trust, trustSource: doc.trustSource });
  }
  const batch = todo.slice(0, args.limit);
  let applied = 0;
  if (args.apply && batch.length > 0) {
    const now = new Date().toISOString();
    await withManifestLock(kbDir, async () => {
      const fresh = await readManifest(kbDir);
      const patches = batch.map((item) => ({ docId: item.docId, patch: { trustReason: reason, trustUpdatedAt: now } }));
      applied = await updateDocsMetaLocked(kbDir, fresh, patches);
    });
    await refreshKbIndex(kbDir);
    await appendLog(kbDir, { action: "trust", title: `刷新核对结论：${applied} 篇`, detail: reason });
  }
  const report = { kb: args.kb, apply: args.apply, candidates: todo.length, applied, remaining: Math.max(0, todo.length - applied), batch: batch.map(({ docId, title, standardNo, from, trust }) => ({ docId, title, standardNo, from, trust })) };
  if (args.report) writeFileSync(args.report, JSON.stringify(report, null, 2), "utf8");
  if (args.json) return console.log(JSON.stringify({ ...report, batch: undefined }, null, 2));
  console.log(`知识库「${args.kb}」：占位理由待刷新 ${todo.length} 篇；本次${args.apply ? "已应用" : "预演"} ${batch.length} 篇${todo.length > batch.length ? `（余 ${todo.length - batch.length} 篇下批）` : ""}`);
  for (const item of batch.slice(0, 5)) console.log(`  ${item.docId} | ${item.standardNo} | ${item.trust}/${item.trustSource ?? "-"} | ${item.title.slice(0, 40)}`);
  if (!args.apply) console.log("\n（dry-run：未写入。加 --apply 才写清单）");
}

await main();
