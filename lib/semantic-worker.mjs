/**
 * 0.31 语义索引后台构建进程：大库（>100 篇）首次语义检索时由
 * `startBackgroundVectorBuild()` 拉起，避免 11s 的首建阻塞请求。
 *
 * 只读清单与 markdown，只写 <kb>/.index/doc-vectors.*；完成后把结果写到
 * doc-vectors.build.json 供排查，并释放锁文件。
 */
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSemanticRuntime } from "./semantic-runtime.js";
import { ensureDocVectors, normalizeDocProfile } from "./semantic-index.js";

const [dir, lock, profileArg] = process.argv.slice(2);
const profile = normalizeDocProfile(profileArg);
const report = { at: new Date().toISOString(), ok: false };

try {
  const manifest = JSON.parse(await readFile(join(dir, "kb.json"), "utf8"));
  const runtime = createSemanticRuntime();
  const status = await runtime.status();
  if (!status.available) throw new Error(`runtime_unavailable: ${status.reason}`);
  const result = await ensureDocVectors({
    dir,
    manifest,
    profile,
    embedder: async (texts) => {
      const embedded = await runtime.embedDocuments(texts);
      if (!embedded.ok) throw new Error(embedded.reason);
      return embedded.vectors;
    },
  });
  Object.assign(report, result);
} catch (error) {
  report.error = String(error?.message ?? error);
}

try {
  await writeFile(join(dir, ".index", "doc-vectors.build.json"), `${JSON.stringify(report)}\n`, "utf8");
} catch {
  /* 报告文件仅用于诊断 */
}
if (lock) await unlink(lock).catch(() => {});
