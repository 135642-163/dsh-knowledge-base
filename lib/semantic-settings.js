/**
 * 0.31.2 语义检索设置的持久化：<kbRoot>/.semantic.json。
 *
 * 配置文件里的 `semanticSearch` / `semanticProfile` 是“部署默认值”，这里存的是
 * 用户在工作台里选的开关与画像（覆盖默认值）；文件缺失时直接用配置默认值。
 * 文件 0600、原子写；坏了按未设置处理，不影响检索。
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SEMANTIC_SETTINGS_FILE = ".semantic.json";
export const SEMANTIC_PROFILES = ["summary", "window"];

export function normalizeSemanticProfile(value) {
  return String(value ?? "").trim().toLowerCase() === "window" ? "window" : "summary";
}

function readProfile(value) {
  const profile = String(value ?? "").trim().toLowerCase();
  return SEMANTIC_PROFILES.includes(profile) ? profile : null;
}

export async function readSemanticSettings(kbRoot) {
  try {
    const data = JSON.parse(await readFile(join(kbRoot, SEMANTIC_SETTINGS_FILE), "utf8"));
    const enabled = typeof data?.enabled === "boolean" ? data.enabled : null;
    const profile = readProfile(data?.profile);
    if (enabled !== null || profile !== null) {
      return {
        enabled,
        profile,
        source: "settings",
        updatedAt: String(data.updatedAt ?? ""),
      };
    }
  } catch {
    /* 缺失/损坏：交给调用方的默认值 */
  }
  return { enabled: null, profile: null, source: "config", updatedAt: "" };
}

export async function readSemanticEnabled(kbRoot, fallback = false) {
  const settings = await readSemanticSettings(kbRoot);
  return settings.enabled === null ? fallback === true : settings.enabled;
}

export async function readSemanticProfile(kbRoot, fallback = "summary") {
  const settings = await readSemanticSettings(kbRoot);
  return settings.profile ?? normalizeSemanticProfile(fallback);
}

async function writeSemanticSettings(kbRoot, patch) {
  await mkdir(kbRoot, { recursive: true });
  const current = await readSemanticSettings(kbRoot);
  const enabled = typeof patch?.enabled === "boolean" ? patch.enabled : (current.enabled ?? false);
  const profile = readProfile(patch?.profile) ?? current.profile ?? "summary";
  const path = join(kbRoot, SEMANTIC_SETTINGS_FILE);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({
      enabled: enabled === true,
      profile,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return { enabled, profile };
}

export async function writeSemanticEnabled(kbRoot, enabled) {
  const settings = await writeSemanticSettings(kbRoot, { enabled });
  return settings.enabled;
}

export async function writeSemanticProfile(kbRoot, profile) {
  const settings = await writeSemanticSettings(kbRoot, { profile });
  return settings.profile;
}
