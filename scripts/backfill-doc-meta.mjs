#!/usr/bin/env node
/**
 * 旧库资料身份回填 CLI（默认 dry-run）。
 *
 * 用法：
 *   node scripts/backfill-doc-meta.mjs --root ~/.dsh/knowledge --kb 标准 --dry-run
 *   node scripts/backfill-doc-meta.mjs --root ~/.dsh/knowledge --kb 标准 --apply --hash --std --content --text
 *   node scripts/backfill-doc-meta.mjs --root ~/.dsh/knowledge --kb 标准 --dry-run --retitle
 *
 * 不自动删除文档；retitle 只改标准号/名称规范形态，且只对正文完整（full）的资料生效。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyBackfill, planBackfill } from "../lib/backfill.js";
import { expandRoot, kbDirPath, listKbs } from "../lib/store.js";

function parseArgs(argv) {
  const options = {
    root: join(process.env.HOME ?? "", ".dsh", "knowledge"),
    kb: "",
    apply: false,
    hash: false,
    std: false,
    content: false,
    text: false,
    trust: false,
    retitle: false,
    normalizeTitles: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? "";
    if (arg === "--root") options.root = next();
    else if (arg === "--kb") options.kb = next();
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--hash") options.hash = true;
    else if (arg === "--std") options.std = true;
    else if (arg === "--content") options.content = true;
    else if (arg === "--text") options.text = true;
    else if (arg === "--trust") options.trust = true;
    else if (arg === "--retitle") options.retitle = true;
    else if (arg === "--normalize-titles") options.normalizeTitles = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function usage() {
  console.log(`用法: node scripts/backfill-doc-meta.mjs --root <kbRoot> [--kb 标准] [--dry-run|--apply] [选项]
选项: --hash 计算 sourceHash; --std 解析标准号; --content 正文/封面优先; --text 计算 textHash;
      --trust 仅 unknown 文档应用启发式; --retitle 规范标准标题（仅正文 full）;
      --normalize-titles 规范化书名号/括注标准号/裸标准号标题（更宽但只动标准/书籍格式）; --json 输出 JSON`);
}

function sample(changes, limit = 20) {
  return changes.slice(0, limit).map((change) => ({
    docId: change.docId,
    title: change.title,
    to: change.patch.title ?? "",
    standardNo: change.patch.standardNo ?? "",
    standardSource: change.patch.standardSource ?? "",
    contentIntegrity: change.patch.contentIntegrity ?? "",
    sourceHash: change.patch.sourceHash ? "yes" : "",
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.hash && !options.std && !options.content && !options.text && !options.trust && !options.retitle && !options.normalizeTitles) {
    throw new Error("至少指定一个回填项：--hash / --std / --content / --text / --trust / --retitle / --normalize-titles");
  }
  const root = expandRoot(options.root);
  if (!existsSync(root)) throw new Error(`kbRoot 不存在: ${root}`);
  const kbs = await listKbs(root);
  const targets = options.kb
    ? kbs.filter((kb) => kb.name === options.kb || kb.dir === options.kb)
    : kbs;
  if (targets.length === 0) throw new Error(`没有找到知识库: ${options.kb || "(全部)"}`);
  const result = { root, mode: options.apply ? "apply" : "dry-run", kbs: [], total: { scanned: 0, changed: 0, retitled: 0, skipped: 0, errors: 0 } };
  for (const kb of targets) {
    const dir = kbDirPath(root, kb.dir ?? kb.name);
    const plan = await planBackfill(dir, options);
    let applied = { applied: 0, retitled: 0, errors: [] };
    if (options.apply && plan.changes.length > 0) applied = await applyBackfill(dir, plan);
    result.kbs.push({
      kb: kb.name,
      dir: kb.dir ?? kb.name,
      counts: plan.counts,
      changes: sample(plan.changes),
      skipped: plan.skipped.slice(0, 20),
      errors: plan.errors.slice(0, 20),
      applied: applied.applied,
      retitled: applied.retitled,
      applyErrors: applied.errors.slice(0, 20),
    });
    result.total.scanned += plan.counts.scanned;
    result.total.changed += plan.changes.length;
    result.total.retitled += applied.retitled;
    result.total.skipped += plan.counts.skipped;
    result.total.errors += plan.counts.errors + applied.errors.length;
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[backfill] ${result.mode} root=${root}`);
    for (const kb of result.kbs) {
      console.log(`\n## ${kb.kb}（${kb.dir}）`);
      console.log(`扫描 ${kb.counts.scanned} · 变更 ${kb.changes.length} · sourceHash ${kb.counts.hash} · 标准号 ${kb.counts.std} · 正文 ${kb.counts.content} · textHash ${kb.counts.text} · trust ${kb.counts.trust} · retitle ${kb.counts.retitle} · 跳过 ${kb.counts.skipped} · 错误 ${kb.counts.errors}`);
      for (const item of kb.changes) {
        console.log(`- ${item.docId} ${item.title}${item.to ? ` → ${item.to}` : ""}${item.standardNo ? ` [${item.standardNo}]` : ""}${item.standardSource ? ` (${item.standardSource})` : ""}${item.contentIntegrity ? ` integrity=${item.contentIntegrity}` : ""}${item.sourceHash ? " hash=yes" : ""}`);
      }
      for (const item of kb.skipped) console.log(`  skip ${item.docId}: ${item.reason}`);
      for (const item of kb.errors) console.log(`  error ${item.docId}: ${item.error}`);
      if (options.apply) console.log(`  已应用 ${kb.applied} 篇，retitle ${kb.retitled} 篇。`);
    }
    console.log(`\n[backfill] total scanned=${result.total.scanned} changed=${result.total.changed} retitled=${result.total.retitled} skipped=${result.total.skipped} errors=${result.total.errors}`);
    if (!options.apply) console.log("[backfill] dry-run：未写盘；确认后加 --apply。");
  }
}

main().catch((error) => {
  console.error(`[backfill] ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});
