/** 独立 FTS 构建进程：由 kb_query 在索引缺失/过期时拉起。 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readManifest } from "./store.js";
import { buildFtsIndex, manifestStamp } from "./fts-index.js";

const dir = process.argv[2];
const lock = process.argv[3] ?? join(dir, ".index", "build.lock");
try {
  const manifest = await readManifest(dir);
  const result = await buildFtsIndex(dir, manifest, { stamp: manifestStamp(manifest) });
  await mkdir(join(dir, ".index"), { recursive: true });
  await writeFile(join(dir, ".index", "build.json"), JSON.stringify({ ...result, finishedAt: new Date().toISOString() }), "utf8");
} catch (error) {
  try {
    await mkdir(join(dir, ".index"), { recursive: true });
    await writeFile(join(dir, ".index", "build.json"), JSON.stringify({ ok: false, error: String(error?.message ?? error), finishedAt: new Date().toISOString() }), "utf8");
  } catch {
    /* ignore */
  }
} finally {
  await unlink(lock).catch(() => {});
}
