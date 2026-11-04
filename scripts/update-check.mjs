#!/usr/bin/env node
/**
 * DSH / 知识库插件升级检查（定时任务入口）。
 *
 * 检查四件事：
 *  1) 本机 DSH 版本（macOS 读 App Info.plist；其它平台回退 `dsh --version`，也可 --dsh-version 指定）；
 *  2) npm 上 @deepseek-ai/dsh 的 latest / next；
 *  3) GitHub 上本插件 main 分支 package.json 的版本与 peerDependencies 范围；
 *  4) 本机 DSH 是否仍落在插件声明的兼容范围内。
 *
 * 默认把 Markdown 报告写到 <插件>/docs/reports/update-check-YYYYMMDD.md；
 * 需要动作（DSH 可升级 / 插件可升级 / 版本越界）时退出码 10，并在 macOS 弹通知。
 * 网络失败不阻塞：对应来源标记为 unknown，退出码 0。
 *
 * 示例：
 *   node scripts/update-check.mjs
 *   node scripts/update-check.mjs --reports-dir ~/.dsh/reports --no-notify
 *   node scripts/update-check.mjs --dsh-version 0.2.2-rc.1 --json
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = dirname(here);
export const DSH_NPM_METADATA = "https://registry.npmjs.org/@deepseek-ai%2Fdsh";
export const DEFAULT_BRANCH = "main";

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function reportDate(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function reportPath(reportsDir, now = new Date()) {
  return join(String(reportsDir), `update-check-${reportDate(now).replace(/-/g, "")}.md`);
}

/** 宽松 semver：解析 major.minor.patch 与 prerelease；无法解析返回 null。 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : [],
  };
}

function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 正式版 > 预发布
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // 数字标识 < 字母标识
    } else {
      if (x === y) continue;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** compareVersions(a,b)：a<b 返回 -1，a>b 返回 1，相等 0；无法解析返回 null。 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  return comparePre(x.pre, y.pre);
}

function compareComparator(version, operator, target) {
  const diff = compareVersions(version, target);
  if (diff === null) return null;
  switch (operator) {
    case ">=": return diff >= 0;
    case ">": return diff > 0;
    case "<=": return diff <= 0;
    case "<": return diff < 0;
    case "=":
    case "": return diff === 0;
    default: return null;
  }
}

function boundFor(version, operator) {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  const floor = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  if (operator === "^") {
    if (parsed.major > 0) return { low: `>=${floor}`, high: `<${parsed.major + 1}.0.0` };
    if (parsed.minor > 0) return { low: `>=${floor}`, high: `<0.${parsed.minor + 1}.0` };
    return { low: `>=${floor}`, high: `<0.0.${parsed.patch + 1}` };
  }
  if (operator === "~") {
    return { low: `>=${floor}`, high: `<${parsed.major}.${parsed.minor + 1}.0` };
  }
  return null;
}

/**
 * 判断 version 是否满足 range（支持空格分隔的 >=/<=/>/</=、^、~ 与 || 备选）。
 * 预发布不做 semver 的“默认排除”处理：宿主 rc 版本需要能落进范围。
 * 无法解析时返回 null（表示 unknown，而不是不兼容）。
 */
export function satisfiesRange(version, range) {
  const raw = String(range ?? "").trim();
  if (raw === "" || raw === "*") return true;
  if (!parseVersion(version)) return null;
  const alternatives = raw.split("||").map((part) => part.trim()).filter(Boolean);
  if (alternatives.length === 0) return true;
  for (const alternative of alternatives) {
    let expression = alternative;
    const bounds = [];
    // 把 ^ / ~ 展开成两个比较符，其余原样。
    expression = expression.replace(/(^|\s)([~^])([^\s]+)/g, (_all, lead, operator, target) => {
      const bound = boundFor(target, operator);
      if (!bound) return `${lead}${operator}${target}`;
      bounds.push(bound.low, bound.high);
      return lead;
    });
    const tokens = [expression, ...bounds].join(" ").trim().split(/\s+/).filter(Boolean);
    let ok = true;
    for (const token of tokens) {
      if (token === "*") continue;
      const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token);
      if (!match) return null;
      const result = compareComparator(version, match[1] ?? "", match[2]);
      if (result === null) return null;
      if (!result) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 没有 fetch");
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "dsh-kb-update-check/1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return await response.json();
}

/** 从 package.json 的 repository 字段解析 GitHub owner/repo。 */
export function repoOf(pkg) {
  const raw = typeof pkg?.repository === "string" ? pkg.repository : pkg?.repository?.url ?? "";
  const match = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i.exec(String(raw).trim());
  return match ? `${match[1]}/${match[2]}` : "135642-163/dsh-knowledge-base";
}

/** 本机 DSH 版本：显式参数 → 环境变量 → macOS App Info.plist → `dsh --version`。 */
export async function detectDshVersion({
  explicit = "",
  env = process.env,
  platform = process.platform,
  execFileImpl = execFileAsync,
  appPath = "/Applications/DeepSeek Harness.app",
} = {}) {
  if (String(explicit).trim() !== "") return { version: String(explicit).trim(), source: "参数 --dsh-version" };
  const fromEnv = String(env.DSH_VERSION ?? env.DSH_APP_VERSION ?? "").trim();
  if (fromEnv !== "") return { version: fromEnv, source: "环境变量" };
  if (platform === "darwin") {
    try {
      const { stdout } = await execFileImpl("plutil", [
        "-extract", "CFBundleShortVersionString", "raw", "-o", "-",
        join(appPath, "Contents/Info.plist"),
      ]);
      const version = String(stdout).trim();
      if (version !== "") return { version, source: appPath };
    } catch {
      /* 没装桌面端时回退 CLI */
    }
  }
  try {
    const { stdout } = await execFileImpl("dsh", ["--version"]);
    const version = String(stdout).trim().split(/\s+/).pop() ?? "";
    if (version !== "") return { version, source: "dsh --version（CLI，可能与桌面端不同）" };
  } catch {
    /* 没有 CLI */
  }
  return { version: "", source: "unknown" };
}

/**
 * 执行检查并返回结构化结果；所有网络错误收进 errors，不抛出。
 * fetchImpl 可注入，便于单测。
 */
export async function checkUpdates({
  pluginRoot = PLUGIN_ROOT,
  fetchImpl = globalThis.fetch,
  dshVersion = "",
  repo = "",
  branch = DEFAULT_BRANCH,
  now = new Date(),
} = {}) {
  const errors = [];
  let localPackage = {};
  try {
    localPackage = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8"));
  } catch (error) {
    errors.push(`读取插件 package.json 失败：${String(error?.message ?? error)}`);
  }
  const targetRepo = String(repo).trim() || repoOf(localPackage);
  const localPluginVersion = String(localPackage.version ?? "").trim();
  const localPeerRange = String(localPackage.peerDependencies?.["@deepseek-ai/dsh-tools"] ?? "").trim();

  let npm = null;
  try {
    npm = await fetchJson(DSH_NPM_METADATA, { fetchImpl });
  } catch (error) {
    errors.push(`读取 npm @deepseek-ai/dsh 失败：${String(error?.message ?? error)}`);
  }
  const dshTags = npm && typeof npm["dist-tags"] === "object" ? npm["dist-tags"] : {};

  let remotePackage = null;
  let remoteBranch = branch;
  try {
    remotePackage = await fetchJson(
      `https://raw.githubusercontent.com/${targetRepo}/${branch}/package.json`,
      { fetchImpl }
    );
  } catch (error) {
    // main 不存在时试 master；都失败就只报告本地信息。
    if (branch === "main") {
      try {
        remotePackage = await fetchJson(
          `https://raw.githubusercontent.com/${targetRepo}/master/package.json`,
          { fetchImpl }
        );
        remoteBranch = "master";
      } catch {
        errors.push(`读取 GitHub ${targetRepo} package.json 失败：${String(error?.message ?? error)}`);
      }
    } else {
      errors.push(`读取 GitHub ${targetRepo} package.json 失败：${String(error?.message ?? error)}`);
    }
  }
  const remotePluginVersion = String(remotePackage?.version ?? "").trim();
  const remotePeerRange = String(remotePackage?.peerDependencies?.["@deepseek-ai/dsh-tools"] ?? "").trim();
  const peerRange = remotePeerRange || localPeerRange;
  const dshLatest = String(dshTags.latest ?? "").trim();
  const dshNext = String(dshTags.next ?? "").trim();

  const installedDsh = String(dshVersion ?? "").trim();
  const pluginUpdate = remotePluginVersion !== "" && compareVersions(remotePluginVersion, localPluginVersion) === 1;
  const dshUpdate = installedDsh !== "" && dshLatest !== "" && compareVersions(dshLatest, installedDsh) === 1;
  const compatibility = installedDsh !== "" && peerRange !== "" ? satisfiesRange(installedDsh, peerRange) : null;
  const nextAvailable = installedDsh !== "" && dshNext !== "" && compareVersions(dshNext, installedDsh) === 1;
  const actionNeeded = pluginUpdate || dshUpdate || compatibility === false;

  return {
    checkedAt: now.toISOString(),
    repo: targetRepo,
    branch: remoteBranch,
    local: {
      pluginVersion: localPluginVersion,
      peerRange: localPeerRange,
      dshVersion: installedDsh,
    },
    npm: {
      latest: dshLatest || null,
      next: dshNext || null,
    },
    remote: {
      pluginVersion: remotePluginVersion || null,
      peerRange: remotePeerRange || null,
    },
    compatibility,
    pluginUpdate,
    dshUpdate,
    nextAvailable,
    actionNeeded,
    errors,
  };
}

function yesNo(value) {
  return value === true ? "是" : value === false ? "否" : "未知";
}

/** 生成 Markdown 报告（落 docs/reports，便于回查）。 */
export function renderReport(result, { now = new Date() } = {}) {
  const local = result.local ?? {};
  const npm = result.npm ?? {};
  const remote = result.remote ?? {};
  const lines = [
    `# DSH / 知识库插件升级检查（${reportDate(now)}）`,
    "",
    `- 检查时间：${now.toISOString()}`,
    `- 本机 DSH：${local.dshVersion || "未知"}`,
    `- 本机插件：${local.pluginVersion || "未知"}`,
    `- 插件兼容范围（peerDependencies）：${remote.peerRange || local.peerRange || "未声明"}`,
    `- npm @deepseek-ai/dsh：latest=${npm.latest || "未知"}，next=${npm.next || "未知"}`,
    `- 插件远端 ${result.repo}@${result.branch}：${remote.pluginVersion || "未知"}`,
    "",
    "## 结论",
    "",
    `- 插件可升级：${yesNo(result.pluginUpdate)}`,
    `- DSH 可升级（latest）：${yesNo(result.dshUpdate)}`,
    `- 本机 DSH 是否在插件兼容范围内：${yesNo(result.compatibility)}`,
    `- 是否有更新的预发布（next）：${yesNo(result.nextAvailable)}`,
    `- 需要动作：${result.actionNeeded ? "是" : "否"}`,
    "",
  ];
  const actions = [];
  if (result.pluginUpdate) actions.push(`升级知识库插件到 ${remote.pluginVersion}（先看仓库 release/README，再更新 profile 依赖）`);
  if (result.dshUpdate) actions.push(`DSH 可升级到 ${npm.latest}；升级后运行插件回归（npm test / npm run test:e2e）`);
  if (result.compatibility === false) actions.push(`本机 DSH ${local.dshVersion} 不在插件兼容范围 ${remote.peerRange || local.peerRange} 内，先升级插件或回退 DSH`);
  if (result.nextAvailable) actions.push(`另有预发布 ${npm.next}；除非要跟进新特性，否则不必升级`);
  lines.push("## 建议动作", "");
  lines.push(...(actions.length > 0 ? actions.map((item) => `- ${item}`) : ["- 无需升级，保持现状。"]));
  lines.push("", "## 数据来源", "");
  lines.push(`- npm：${DSH_NPM_METADATA}`);
  lines.push(`- GitHub：https://raw.githubusercontent.com/${result.repo}/${result.branch}/package.json`);
  if (result.errors.length > 0) {
    lines.push("", "## 检查异常", "");
    lines.push(...result.errors.map((item) => `- ${item}`));
  }
  lines.push("");
  return lines.join("\n");
}

export function notificationText(result) {
  if (!result.actionNeeded) return "";
  const parts = [];
  if (result.pluginUpdate) parts.push(`插件可升级到 ${result.remote?.pluginVersion}`);
  if (result.dshUpdate) parts.push(`DSH 可升级到 ${result.npm?.latest}`);
  if (result.compatibility === false) parts.push("DSH 版本超出插件兼容范围");
  return `DSH 升级检查：${parts.join("，")}`;
}

function notifyMac(message) {
  if (process.platform !== "darwin" || message === "") return;
  execFile("osascript", ["-e", `display notification ${JSON.stringify(message)} with title "DSH 升级检查"`], () => {});
}

export function parseArgs(argv) {
  const args = {
    reportsDir: join(PLUGIN_ROOT, "docs", "reports"),
    dshVersion: "",
    repo: "",
    branch: DEFAULT_BRANCH,
    notify: true,
    json: false,
    noReport: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--reports-dir") args.reportsDir = argv[++i] ?? args.reportsDir;
    else if (arg === "--dsh-version") args.dshVersion = argv[++i] ?? "";
    else if (arg === "--repo") args.repo = argv[++i] ?? "";
    else if (arg === "--branch") args.branch = argv[++i] ?? DEFAULT_BRANCH;
    else if (arg === "--json") args.json = true;
    else if (arg === "--no-report") args.noReport = true;
    else if (arg === "--no-notify") args.notify = false;
    else if (arg === "--notify") args.notify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`用法: node scripts/update-check.mjs [选项]
  --dsh-version <版本>   本机 DSH 版本（默认自动探测）
  --repo <owner/repo>    插件仓库（默认读 package.json repository）
  --branch <分支>        远端分支（默认 main，失败回退 master）
  --reports-dir <目录>   报告目录（默认 <插件>/docs/reports）
  --json                 以 JSON 输出检查结果（报告仍会写）
  --no-report            不写 Markdown 报告
  --no-notify            有动作也不弹 macOS 通知
  --notify               强制开启通知（默认 macOS 开启）`);
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const detected = await detectDshVersion({ explicit: args.dshVersion });
  const result = await checkUpdates({
    dshVersion: detected.version,
    repo: args.repo,
    branch: args.branch,
  });
  result.dshVersionSource = detected.source;

  const text = renderReport(result);
  const outPath = reportPath(args.reportsDir);
  if (!args.noReport) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, text, "utf8");
  }
  if (args.json) {
    console.log(JSON.stringify({ ...result, reportPath: args.noReport ? null : outPath }, null, 2));
  } else {
    console.log(text);
    if (!args.noReport) console.log(`报告：${outPath}`);
  }
  if (args.notify && result.actionNeeded) notifyMac(notificationText(result));
  process.exit(result.actionNeeded ? 10 : 0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`update-check failed: ${String(error?.message ?? error)}`);
    process.exit(1);
  });
}
