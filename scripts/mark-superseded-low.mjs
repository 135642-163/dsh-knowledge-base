#!/usr/bin/env node
/**
 * 把「站点标注废止」的标准标为 trust=low（带证据理由）。
 *
 * 数据源：<kb>/.std-check.json 里 status=superseded 的条目（kb_std_check 检查产物）。
 * 证据分层（理由文本自动生成）：
 *   A 站点写「被 X 代替」且库内已有 X 正文
 *   B 站点写「被 X 代替」但库内暂无 X 正文
 *   C 站点未给出继任编号
 * 默认 dry-run；--apply 才写清单（带锁 + 原子写 + 刷新 index.md + 写 log.md）。
 * 会覆盖 trustSource=manual 的人工标注——执行前必须已获得用户授权并留快照。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, updateDocsMetaLocked, withManifestLock, expandRoot, kbDirPath } from "../lib/store.js";
import { appendLog } from "../lib/wiki.js";
import { refreshKbIndex } from "../lib/import-job.js";

const SITE_LABEL = "标准网";
const TODAY = new Date().toISOString().slice(0, 10);

function parseArgs(argv) {
  const args = { root: "", kb: "", apply: false, limit: 20, report: "", json: false, date: TODAY };
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
      console.log("用法: node scripts/mark-superseded-low.mjs --root <kbRoot> --kb <库名> [--dry-run|--apply] [--limit 20] [--report out.json]");
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (!args.root || !args.kb) throw new Error("需要 --root 和 --kb");
  return args;
}

function readCache(kbDir) {
  try {
    return JSON.parse(readFileSync(join(kbDir, ".std-check.json"), "utf8"));
  } catch {
    return { items: {} };
  }
}

/** 从站点「代替标准」字段里拆出「被 … 代替」的继任编号。 */
export function successorsOf(field) {
  const m = String(field ?? "").match(/被([^；。]+?)代替/);
  if (!m) return [];
  return m[1].split(/[;；,，、]/).map((s) => s.trim()).filter(Boolean);
}

/** 解析标准号 → { key, year }（体系内比较用，忽略 /T、/Z 后缀差异）。 */
export function parseStd(s) {
  const m = String(s ?? "").replace(/[∕／]/g, "/").match(/^([A-Za-z/]+)\s*([\d.]+)(?:-(\d{4}))?/);
  if (!m) return null;
  return { key: `${m[1].toUpperCase().replace(/\/T$|\/Z$/, "")}${m[2]}`, year: m[3] ? Number(m[3]) : null };
}

/** 库里是否已有继任版本正文（同编号、年份不低于继任版本）。 */
export function holdsSuccessor(liveDocs, successor) {
  const want = parseStd(successor);
  if (!want) return false;
  return liveDocs.some((doc) => {
    if (!doc.standardNo) return false;
    const got = parseStd(doc.standardNo);
    if (!got || got.key !== want.key) return false;
    return want.year == null || (got.year ?? 0) >= want.year;
  });
}

/** 生成理由文本（三档证据写清来源，便于以后复核）。 */
export function reasonFor(entry, { tier = "C", successors = [], held = [] } = {}) {
  const status = String(entry?.siteStatus ?? "废止");
  const head = `站点标注${status}（${SITE_LABEL} ${TODAY}）`;
  if (tier === "A") {
    return `${head}：被 ${successors.join("、")} 代替，库内已有继任版本正文`;
  }
  if (tier === "B") {
    const missing = successors.filter((s) => !held.includes(s));
    return `${head}：被 ${(missing.length ? missing : successors).join("、")} 代替，库内暂无继任版本正文，待补`;
  }
  return `${head}，站点未给出继任标准编号`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kbDir = kbDirPath(expandRoot(args.root), args.kb);
  const cache = readCache(kbDir);
  const manifest = await readManifest(kbDir);
  const live = (manifest.docs ?? []).filter((d) => !d.deletedAt);

  const byId = new Map(live.map((d) => [d.id, d]));
  const entries = Object.values(cache.items ?? {}).filter((it) => it.status === "superseded");

  // 计算每篇待标文档的理由；同篇可能被多组命中，取第一条并合并说明
  const plan = [];
  for (const entry of entries) {
    const successors = successorsOf(entry.replaced);
    const held = successors.filter((s) => holdsSuccessor(live, s));
    // 证据分层：站点给出继任且库里已有 → A；给了但库内没有 → B；没给 → C
    const tier = successors.length === 0 ? "C" : held.length === successors.length ? "A" : "B";
    const targetIds = (entry.docs ?? [])
      .filter((d) => (entry.siteYear == null || d.year == null || Number(d.year) === Number(entry.siteYear)))
      .map((d) => d.id);
    const ids = targetIds.length > 0 ? targetIds : (entry.docs ?? []).map((d) => d.id);
    for (const id of ids) {
      const doc = byId.get(id);
      if (!doc) continue;
      plan.push({
        docId: id,
        title: doc.title,
        siteNo: entry.siteNo ?? entry.number,
        siteStatus: entry.siteStatus ?? "废止",
        tier,
        successors,
        from: { trust: doc.trust ?? "unknown", trustSource: doc.trustSource ?? "unknown", trustReason: doc.trustReason ?? "" },
        to: { trust: "low", trustSource: "manual", reason: reasonFor(entry, { tier, successors, held }) },
      });
    }
  }
  // 去重：同一篇只标一次
  const seen = new Set();
  const unique = plan.filter((p) => (seen.has(p.docId) ? false : (seen.add(p.docId), true)));
  const todo = unique.filter((p) => p.from.trust !== "low");
  const batch = todo.slice(0, args.limit);

  let applied = 0;
  if (args.apply && batch.length > 0) {
    const now = new Date().toISOString();
    await withManifestLock(kbDir, async () => {
      const fresh = await readManifest(kbDir);
      const patches = batch.map((item) => ({
        docId: item.docId,
        patch: {
          trust: "low",
          trustReason: item.to.reason,
          trustUpdatedAt: now,
          trustSource: "manual",
        },
      }));
      applied = await updateDocsMetaLocked(kbDir, fresh, patches);
    });
    await appendLog(kbDir, {
      action: "trust",
      title: `标注可信度 low：${applied} 篇（站点标注废止）`,
      detail: `A/B/C 分层见 docs/reports/2026-10-31-superseded-review.md`,
    });
    await refreshKbIndex(kbDir);
  }

  const report = {
    kb: args.kb,
    apply: args.apply,
    supersededEntries: entries.length,
    plannedDocs: unique.length,
    skippedAlreadyLow: unique.length - todo.length,
    applied,
    remaining: Math.max(0, todo.length - applied),
    batch: batch.map(({ docId, title, siteNo, tier, from, to }) => ({ docId, title, siteNo, tier, from, to })),
  };
  if (args.report) writeFileSync(args.report, JSON.stringify(report, null, 2), "utf8");
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`知识库「${args.kb}」：废止组 ${entries.length} 个，涉及文档 ${unique.length} 篇，待改 ${todo.length} 篇；本次${args.apply ? "已应用" : "预演"} ${batch.length} 篇${todo.length > batch.length ? `（余 ${todo.length - batch.length} 篇下批）` : ""}`);
  for (const item of batch) {
    console.log(`  ${item.docId} | ${item.from.trust}/${item.from.trustSource} → low | [${item.tier}] ${item.siteNo} | ${item.title.slice(0, 46)}`);
    console.log(`    理由: ${item.to.reason}`);
  }
  if (!args.apply) console.log("\n（dry-run：未写入。加 --apply 才写清单）");
}

await main();
