/**
 * 回填旧文档 parts/index.json 的 pageStart/pageEnd：
 * 页面标题优先，其次用分块头注释 <!-- doc: ... | 第 X–Y 页 -->。
 * 只改页面元数据，不改正文/版本号。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readManifest } from "../lib/store.js";
import { appendLog } from "../lib/wiki.js";

export async function backfillPartPages(dir) {
  const manifest = await readManifest(dir);
  let changed = 0;
  for (const doc of manifest.docs ?? []) {
    if (doc.status !== "ready" || doc.type === "note") continue;
    const partDir = join(dir, "markdown", doc.id, "parts");
    let index;
    try {
      index = JSON.parse(await readFile(join(partDir, "index.json"), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(index)) continue;
    let touched = false;
    for (const entry of index) {
      const name = String(entry.part).padStart(4, "0");
      let text = "";
      try {
        text = await readFile(join(partDir, `${name}.md`), "utf8");
      } catch {
        continue;
      }
      const pages = [...text.matchAll(/^#{1,6}\s*第\s*(\d+)\s*页\s*$/gm)].map((m) => Number(m[1]));
      if (pages.length === 0) {
        const header = /第\s*(\d+)\s*[–—~-]\s*(\d+)\s*页/.exec(text);
        if (header) pages.push(Number(header[1]), Number(header[2]));
      }
      if (pages.length === 0) continue;
      const start = Math.min(...pages);
      const end = Math.max(...pages);
      if (entry.pageStart !== start || entry.pageEnd !== end) {
        entry.pageStart = start;
        entry.pageEnd = end;
        touched = true;
      }
    }
    if (touched) {
      await writeFile(join(partDir, "index.json"), JSON.stringify(index, null, 2), "utf8");
      changed += 1;
    }
  }
  if (changed > 0) {
    await appendLog(dir, { action: "backfill", title: `回填分块页码 ${changed} 篇`, detail: "parts/index.json pageStart/pageEnd" });
  }
  return { changed };
}

if (process.argv[1] && process.argv[1].endsWith("backfill-part-pages.mjs")) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: node scripts/backfill-part-pages.mjs <kbDir>");
  console.log(await backfillPartPages(dir));
}
