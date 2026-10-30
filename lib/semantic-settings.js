/**
 * 0.31.2 语义检索开关的持久化：<kbRoot>/.semantic.json。
 *
 * 配置文件里的 `semanticSearch` 是“部署默认值”，这里存的是用户在工作台里点的开关
 * （覆盖默认值）；两者任一为 on 都算开启，文件缺失时直接用配置默认值。
 * 文件 0600、原子写；坏了按未设置处理，不影响检索。
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SEMANTIC_SETTINGS_FILE = ".semantic.json";

export async function readSemanticSettings(kbRoot) {
  try {
    const data = JSON.parse(await readFile(join(kbRoot, SEMANTIC_SETTINGS_FILE), "utf8"));
    if (typeof data?.enabled === "boolean") {
      return { enabled: data.enabled, source: "settings", updatedAt: String(data.updatedAt ?? "") };
    }
  } catch {
    /* 缺失/损坏：交给调用方的默认值 */
  }
  return { enabled: null, source: "config", updatedAt: "" };
}

export async function readSemanticEnabled(kbRoot, fallback = false) {
  const settings = await readSemanticSettings(kbRoot);
  return settings.enabled === null ? fallback === true : settings.enabled;
}

export async function writeSemanticEnabled(kbRoot, enabled) {
  await mkdir(kbRoot, { recursive: true });
  const path = join(kbRoot, SEMANTIC_SETTINGS_FILE);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ enabled: enabled === true, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return readSemanticEnabled(kbRoot, false);
}
