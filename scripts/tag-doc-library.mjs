#!/usr/bin/env node
/**
 * 给知识库资料批量补确定性标签（标准层级 + 主题）。
 * 默认 dry-run；--apply 才写 manifest。只增标签，不改摘要/正文/版本号。
 */
import { readManifest, updateDocsMetaLocked, withManifestLock } from "../lib/store.js";
import { appendLog, refreshIndexIfStale } from "../lib/wiki.js";
import { classifyDocTags, TOPIC_TAGS, TYPE_TAGS } from "../lib/tagging.js";

function parseArgs(argv) {
  const args = { root: "", kb: "", apply: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--root") args.root = argv[++i] ?? "";
    else if (arg === "--kb") args.kb = argv[++i] ?? "";
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: node scripts/tag-doc-library.mjs --root <knowledgeRoot> --kb <库名> [--apply] [--json]");
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (!args.root || !args.kb) throw new Error("需要 --root 和 --kb");
  return args;
}

function countTags(docs) {
  const counts = new Map();
  for (const doc of docs) {
    for (const tag of doc.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kbRoot = args.root.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
  const manifest = await readManifest(`${kbRoot}/${args.kb}`);
  const docs = (manifest.docs ?? []).filter(
    (doc) => doc.status === "ready" && !doc.deletedAt && doc.type !== "note"
  );
  const autoTags = new Set([...TYPE_TAGS, ...TOPIC_TAGS]);
  const changes = [];
  for (const doc of docs) {
    const existing = Array.isArray(doc.tags) ? doc.tags : [];
    // 类型/主题标签是脚本自动维护的；保留人工标签（如“标准”“OCR修复”），
    // 移除已不再匹配的旧自动标签，避免“会议通知”残留“国际标准”。
    const manual = existing.filter((tag) => !autoTags.has(tag));
    const tags = classifyDocTags(doc, { existing: manual });
    const added = tags.filter((tag) => !existing.includes(tag));
    const removed = existing.filter((tag) => !tags.includes(tag));
    if (added.length > 0 || removed.length > 0) changes.push({ docId: doc.id, title: doc.title, tags, added, removed });
  }
  const report = {
    kb: args.kb,
    scanned: docs.length,
    changed: changes.length,
    tags: countTags(docs.map((doc) => ({ tags: classifyDocTags(doc, { existing: doc.tags ?? [] }) }))),
    samples: changes.slice(0, 25).map(({ docId, title, added, removed }) => ({ docId, title, added, removed })),
    apply: args.apply,
  };
  if (args.apply && changes.length > 0) {
    await withManifestLock(`${kbRoot}/${args.kb}`, async () => {
      const fresh = await readManifest(`${kbRoot}/${args.kb}`);
      const patches = [];
      for (const change of changes) {
        const doc = (fresh.docs ?? []).find((item) => item.id === change.docId);
        if (!doc || doc.status !== "ready" || doc.deletedAt || doc.type === "note") continue;
        patches.push({ docId: doc.id, patch: { tags: change.tags } });
      }
      report.applied = await updateDocsMetaLocked(`${kbRoot}/${args.kb}`, fresh, patches);
    });
    await appendLog(`${kbRoot}/${args.kb}`, {
      action: "tag-batch",
      title: `自动补标签 ${report.applied ?? 0} 篇`,
      detail: "标准层级 + 主题标签；只增不改，未改摘要/正文/版本号",
    });
    try {
      const fresh = await readManifest(`${kbRoot}/${args.kb}`);
      await refreshIndexIfStale(`${kbRoot}/${args.kb}`, fresh);
    } catch {
      /* 索引刷新失败不阻塞 */
    }
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`[tag] ${args.apply ? "apply" : "dry-run"} ${args.kb} 扫描 ${report.scanned} 篇，待改 ${report.changed} 篇`);
  console.log(`标签分布: ${report.tags.map(([tag, count]) => `${tag} ${count}`).join(" · ")}`);
  for (const sample of report.samples) {
    console.log(`- ${sample.docId} ${sample.title}  +${sample.added.join(" +") || "-"}${sample.removed.length ? ` -${sample.removed.join(" -")}` : ""}`);
  }
  if (args.apply) console.log(`已应用 ${report.applied ?? 0} 篇（只改 tags/metaUpdatedAt）。`);
  else console.log("dry-run：未写盘；确认后加 --apply。");
}

main().catch((error) => {
  console.error(`[tag] ${error?.message ?? error}`);
  process.exit(1);
});
