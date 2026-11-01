/**
 * 知识库根目录的持久化设置（工作台「数据目录」用）。
 *
 * - 文件放在 DSH 家目录下的 `knowledge-wiki/settings.json`
 *   （`$DSH_HOME/knowledge-wiki/settings.json`，未设置 DSH_HOME 时是 `~/.dsh/...`），
 *   与具体知识库无关，因此换根目录不会把设置文件一起换走；
 * - 启动时优先读这里，其次才用插件配置 `kbRoot`（见 lib/index.js）；
 * - 只存路径，不创建/移动知识库内容；保存时只做「可建可写」校验。
 */
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expandRoot } from "./store.js";

/** DSH 家目录：优先 $DSH_HOME，其次 ~/.dsh（与 E2E/宿主约定一致）。 */
export function dshHome(env = process.env) {
  const configured = String(env?.DSH_HOME ?? "").trim();
  if (configured === "") return join(homedir(), ".dsh");
  const expanded = configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
  return resolve(expanded);
}

/** 设置文件路径（可注入 home / base 便于测试）。 */
export function kbSettingsPath({ home, base = "" } = {}) {
  const root = base || (home ? join(home, ".dsh") : dshHome());
  return join(root, "knowledge-wiki", "settings.json");
}

/**
 * 归一化用户输入：展开 ~ / 环境变量，转为绝对路径；相对路径视为无效
 * （避免“相对谁”在不同启动方式下不一致）。
 * 返回 "" 表示输入为空或无效。
 */
export function normalizeKbRootInput(input) {
  const raw = String(input ?? "").trim();
  if (raw === "") return "";
  const expanded = expandRoot(raw);
  if (!isAbsolute(expanded)) return "";
  return resolve(expanded);
}

/** 读取保存的根目录；不存在/损坏时返回 null（不抛错，回退配置）。 */
export async function readKbRootSetting(options = {}) {
  try {
    const parsed = JSON.parse(await readFile(kbSettingsPath(options), "utf8"));
    const value = typeof parsed?.kbRoot === "string" ? normalizeKbRootInput(parsed.kbRoot) : "";
    return value || null;
  } catch {
    return null;
  }
}

/**
 * 校验并保存根目录（会创建目录并检查可写）。
 * @returns 归一化后的绝对路径
 * @throws 路径为空/相对路径/不可建不可写时抛错
 */
export async function writeKbRootSetting(input, options = {}) {
  const target = normalizeKbRootInput(input);
  if (!target) throw new Error("请填写绝对路径（支持 ~ 开头）");
  await ensureRootUsable(target);
  const file = kbSettingsPath(options);
  await mkdir(join(file, ".."), { recursive: true });
  const payload = JSON.stringify({ kbRoot: target, updatedAt: new Date().toISOString() }, null, 2) + "\n";
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, file);
  return target;
}

/** 清除保存的根目录（回退到插件配置）；返回是否确实删除。 */
export async function clearKbRootSetting(options = {}) {
  try {
    await rm(kbSettingsPath(options), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 目录可建可写校验（文件路径、无权限时抛出可读错误）。 */
export async function ensureRootUsable(root) {
  let info = null;
  try {
    info = await stat(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`无法访问目录：${error?.message ?? error}`);
  }
  if (info && !info.isDirectory()) throw new Error("目标路径不是目录");
  try {
    await mkdir(root, { recursive: true });
    await access(root, fsConstants.W_OK);
  } catch (error) {
    throw new Error(`目录不可写：${error?.message ?? error}`);
  }
}

/**
 * 启动时解析生效根目录：保存的设置优先于插件配置。
 * env.KB_SETTINGS_DISABLED=1 时忽略设置（单元测试/E2E 用来隔离本机路径）。
 */
export async function resolveKbRoot({ configured, env = process.env, ...options } = {}) {
  const configKbRoot = resolve(expandRoot(configured ?? "~/.dsh/knowledge"));
  const disabled = String(env?.KB_SETTINGS_DISABLED ?? "") === "1";
  const savedKbRoot = disabled ? null : await readKbRootSetting(options);
  return {
    kbRoot: savedKbRoot ?? configKbRoot,
    configKbRoot,
    savedKbRoot,
    kbRootSource: savedKbRoot ? "setting" : "config",
  };
}

/** 给状态/设置 API 用的只读描述。 */
export async function describeKbRootSettings({ effectiveKbRoot, configKbRoot, source, ...options } = {}) {
  const saved = await readKbRootSetting(options);
  const effective = effectiveKbRoot ?? saved ?? configKbRoot ?? "";
  return {
    kbRoot: effective,
    kbRootSource: source ?? (saved && normalizeKbRootInput(saved) === normalizeKbRootInput(effective) ? "setting" : "config"),
    configKbRoot: configKbRoot ?? "",
    savedKbRoot: saved ?? "",
    restartRequired: Boolean(saved && normalizeKbRootInput(saved) !== normalizeKbRootInput(effective)),
  };
}
