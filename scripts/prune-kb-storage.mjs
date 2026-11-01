#!/usr/bin/env node
/**
 * 清理知识库 snapshots/ 与 exports/ 的旧文件（默认 dry-run）。
 *
 * 用法：
 *   node scripts/prune-kb-storage.mjs --root ~/workspace/knowledge --kb 标准
 *   node scripts/prune-kb-storage.mjs --root ~/workspace/knowledge --snapshots-keep 20 --exports-keep 20 --apply
 */
import { expandRoot, kbDirPath, listKbs } from "../lib/store.js";
import { pruneExports, pruneSnapshots } from "../lib/storage-retention.js";

function parseArgs(argv) {
  const args = { root: "~/workspace/knowledge", kb: "", snapshotsKeep: 20, exportsKeep: 20, apply: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i] ?? args.root;
    else if (arg === "--kb") args.kb = argv[++i] ?? "";
    else if (arg === "--snapshots-keep") args.snapshotsKeep = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--exports-keep") args.exportsKeep = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`用法: node scripts/prune-kb-storage.mjs [选项]
  --root <dir>              知识库根目录（默认 ~/workspace/knowledge）
  --kb <name>               只处理一个库；省略=全部
  --snapshots-keep <n>      每个库保留最近 n 份快照（默认 20；0=不限制）
  --exports-keep <n>        每个库保留最近 n 份导出（默认 20；0=不限制）
  --apply                   真正删除；默认 dry-run
  --json                    输出 JSON`);
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const root = expandRoot(args.root);
const kbs = (await listKbs(root)).filter((k) => !args.kb || (k.dir ?? k.name) === args.kb || k.name === args.kb);
if (kbs.length === 0) throw new Error(`没有匹配的知识库（${args.kb || "全部"}）`);
const rows = [];
let totalBytes = 0;
let totalDeleted = 0;
for (const k of kbs) {
  const dir = kbDirPath(root, k.dir ?? k.name);
  const snapshots = await pruneSnapshots(dir, { keep: args.snapshotsKeep, dryRun: !args.apply });
  const exports = await pruneExports(dir, { keep: args.exportsKeep, dryRun: !args.apply });
  totalBytes += snapshots.bytes + exports.bytes;
  totalDeleted += snapshots.deleted.length + exports.deleted.length;
  rows.push({ kb: k.name, snapshots, exports });
}
if (args.json) {
  console.log(JSON.stringify({ root, apply: args.apply, totalDeleted, totalBytes, rows }, null, 2));
} else {
  console.log(`${args.apply ? "已清理" : "预演（未删除）"}：${root}`);
  for (const row of rows) {
    const s = row.snapshots;
    const e = row.exports;
    console.log(`- ${row.kb}: snapshots ${s.total}→${s.kept}（删 ${s.deleted.length}，${(s.bytes / 1024 ** 2).toFixed(1)}MB）; exports ${e.total}→${e.kept}（删 ${e.deleted.length}，${(e.bytes / 1024 ** 2).toFixed(1)}MB）`);
  }
  console.log(`合计：删除 ${totalDeleted} 个文件，释放 ${(totalBytes / 1024 ** 2).toFixed(1)}MB${args.apply ? "" : "（加 --apply 才真正删除）"}`);
}
