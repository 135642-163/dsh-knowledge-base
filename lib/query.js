/**
 * 知识库全文检索：用打包的 ripgrep 二进制在合并版 markdown 上跑正则，
 * 输出按文档归组的匹配（文档 id/标题、行号、行预览）。
 * 进程侧全部经由 ctx.subprocess（无 shell 层）。
 *
 * 高频词保护：给 ripgrep 加 --max-count（每文件上限），并把 stdout 缓冲
 * 超限（lossy）视为“已截断”而不是整体失败——在 948 个文档的库里搜
 * “电压”这类词时，返回部分结果远好于一条都拿不到。
 */
import { access, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { partFileName } from "./store.js";
import { extractStdRef } from "./standards.js";
import { buildFtsIndex, ftsIndexStatus, manifestStamp, searchFtsIndex, startBackgroundFtsBuild } from "./fts-index.js";

// ---------------------------------------------------------------------------
// 标准号检索归一化：GB/T = GBT = GB_T = GB∕T，年份分隔符 -—–~～
// ---------------------------------------------------------------------------

/** 标准号前缀 → 允许分隔符变体的正则（不含大小写处理）。 */
const STD_PREFIX_RX = {
  GB: "[Gg][Bb]",
  GBT: "[Gg][Bb][/\\s_-]?[Tt]",
  GBZ: "[Gg][Bb][/\\s_-]?[Zz]",
  DL: "[Dd][Ll]",
  DLT: "[Dd][Ll][/\\s_-]?[Tt]",
  NB: "[Nn][Bb]",
  NBT: "[Nn][Bb][/\\s_-]?[Tt]",
  JB: "[Jj][Bb]",
  JBT: "[Jj][Bb][/\\s_-]?[Tt]",
  TB: "[Tt][Bb]",
  TBT: "[Tt][Bb][/\\s_-]?[Tt]",
  QGDW: "[Qq][/\\s_-]?[Gg][Dd][Ww]",
  IEC: "[Ii][Ee][Cc]",
  IEEE: "[Ii][Ee][Ee][Ee]",
  ISO: "[Ii][Ss][Oo]",
  EN: "[Ee][Nn]",
  TCEC: "[Tt][/\\s_-]?[Cc][Ee][Cc]",
  TCES: "[Tt][/\\s_-]?[Cc][Ee][Ss]",
  TCECS: "[Tt][/\\s_-]?[Cc][Ee][Cc][Ss]",
};

/**
 * 把“标准号 + 编号（+ 年份）”的简单查询扩展成兼容多种写法的正则。
 * 只处理纯查询；含正则元字符或不是标准号形态时返回 null（调用方原样检索）。
 *
 * 例：GBT 11032 → \b[Gg][Bb][/\s_-]?[Tt]\s*11032(?![0-9.])
 *     GB/T 11032-2020 → 同上并追加 \s*[-—–~～]\s*2020
 */
export function expandStdQuery(pattern) {
  const raw = String(pattern ?? "").trim();
  if (!raw) return null;
  // 已经是正则（或含元字符）时不改写，避免破坏用户意图
  if (/[\\()[\]{}|+*?^$]/.test(raw)) return null;
  const normalized = raw
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[∕／]/g, "/")
    .replace(/[－＿]/g, "-")
    .replace(/[—–~～]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const firstDigit = normalized.search(/\d/);
  if (firstDigit <= 0) return null;
  const prefix = normalized.slice(0, firstDigit).replace(/[\s/_-]+/g, "").toUpperCase();
  const prefixRx = STD_PREFIX_RX[prefix];
  if (!prefixRx) return null;
  const rest = normalized.slice(firstDigit).trim();
  const m = /^(\d+(?:\.\d+)?)(?:-(\d{1,4}))?$/.exec(rest);
  if (!m) return null;
  const number = m[1].replace(/\./g, "\\.");
  const tail = m[2] ?? "";
  let tailRx = "";
  let year = "";
  if (tail) {
    if (tail.length === 4 && Number(tail) >= 1900 && Number(tail) <= 2099) year = tail;
    else tailRx = `[-—–~～]?\\s*${tail}`;
  }
  const yearRx = year ? `\\s*[-—–~～]\\s*${year}` : "";
  const full = `\\b${prefixRx}\\s*${number}${tailRx}${yearRx}(?:[^0-9.]|$)`;
  try {
    new RegExp(full, "i");
  } catch {
    return null;
  }
  return full;
}

let rgPathPromise;
async function resolveRgPath() {
  rgPathPromise ??= import("@vscode/ripgrep").then((module) => module.rgPath);
  return rgPathPromise;
}

/** 每个文件最多保留多少条命中（总上限 maxMatches / 8，夹在 3–20 之间）。 */
function perFileLimit(maxMatches) {
  const n = Number(maxMatches) || 40;
  return Math.max(3, Math.min(20, Math.ceil(n / 8)));
}

/**
 * 构造 ripgrep 参数（导出以便单测，不启动进程）。
 * scoped=true 表示只搜一个文档目录：总共只有一个文件，按 maxMatches 取，
 * 不能沿用多文档场景的小上限（否则文档内常见词只能看到 3–5 条）。
 */
export function buildRgArgs(rgPath, pattern, target, input = {}) {
  const maxMatches = Number(input.maxMatches) || 40;
  const perFile = input.scoped === true ? Math.max(20, maxMatches) : perFileLimit(maxMatches);
  return [
    rgPath,
    "--no-config",
    "--json",
    "--glob",
    "!**/parts/**",
    `--max-count=${perFile}`,
    `--regexp=${pattern}`,
    "--",
    target,
  ];
}

/**
 * 解析 ripgrep --json 输出。容忍不完整的最后一行（缓冲区截断）。
 * @param text ripgrep stdout
 * @param opts { manifest, kbDir, maxMatches, lineBytes }
 * @returns { matches, total, truncated }
 */
export function parseRgOutput(text, { manifest, kbDir, maxMatches = 40, lineBytes = 400 } = {}) {
  const byId = new Map();
  const byIdKind = new Map();
  const visibleIds = new Set();
  for (const d of manifest?.docs ?? []) {
    byId.set(d.id, d.title ?? d.id);
    byIdKind.set(d.id, { type: d.type ?? "", kind: d.kind ?? "", trust: d.trust ?? "unknown" });
    if (d.status !== "deleted" && typeof d.deletedAt !== "string") visibleIds.add(d.id);
  }
  const matches = [];
  let total = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (line.length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "match") continue;
    const data = record.data;
    const pathText = typeof data?.path === "object" && data.path !== null ? data.path.text : undefined;
    if (typeof pathText !== "string") continue;
    if (typeof data.line_number !== "number") continue;
    const lines = data.lines;
    const lineText =
      typeof lines?.text === "string"
        ? lines.text.replace(/\r?\n$/, "")
        : typeof lines?.bytes === "string"
          ? "(该行不是有效 UTF-8 文本)"
          : undefined;
    if (lineText === undefined) continue;
    // 分块头注释是元数据，不算正文命中
    if (lineText.startsWith("<!-- doc:")) continue;
    const docId = /markdown[\\/]([^\\/]+)[\\/]/.exec(pathText)?.[1] ?? "?";
    // 软删除文档仍在磁盘上；检索结果按 manifest 过滤，避免命中已删除内容
    if (byId.size > 0 && !visibleIds.has(docId)) continue;
    total += 1;
    // total 统计真实命中数（不因 maxMatches 截断而少报），matches 仅保留展示上限；
    // display 用 path.relative 计算，Windows 下不会暴露盘符绝对路径
    if (matches.length < maxMatches) {
      const meta = byIdKind.get(docId) ?? {};
      matches.push({
        docId,
        title: byId.get(docId) ?? docId,
        path: kbDir ? relative(kbDir, pathText) || pathText : pathText,
        lineNumber: data.line_number,
        line: lineText.length > lineBytes ? lineText.slice(0, lineBytes) + "…" : lineText,
        ...(meta.type ? { type: meta.type } : {}),
        ...(meta.kind ? { kind: meta.kind } : {}),
        trust: meta.trust ?? "unknown",
      });
    }
  }
  return { matches, total, truncated: total > matches.length };
}

/**
 * 给命中项补 part/page：读取 markdown/<docId>/parts/index.json，
 * 用合并版行号落到对应分块。0.4.0 之前的文档没有索引时保持原样。
 */
function clauseFromLine(line) {
  const text = String(line ?? "");
  const heading = /^\s*#{1,6}\s*(\d+(?:\.\d+){0,5})\b/.exec(text);
  if (heading) return heading[1];
  const body = /^\s*(\d+(?:\.\d+){1,5})\s+\S/.exec(text);
  return body ? body[1] : "";
}

export async function annotateMatches(matches, kbDir) {
  const cache = new Map();
  const partCache = new Map();
  for (const match of matches) {
    let index = cache.get(match.docId);
    if (index === undefined) {
      try {
        index = JSON.parse(
          await readFile(join(kbDir, "markdown", match.docId, "parts", "index.json"), "utf8")
        );
      } catch {
        index = [];
      }
      if (!Array.isArray(index)) index = [];
      cache.set(match.docId, index);
    }
    const hit = index.find(
      (entry) => match.lineNumber >= entry.startLine && match.lineNumber <= entry.endLine
    );
    if (hit) {
      match.part = hit.part;
      // 旧 parts/index.json 可能没有 pageStart；FTS 条款已带页码时不能被 null 覆盖。
      if (hit.pageStart !== null && hit.pageStart !== undefined) {
        match.pageStart = hit.pageStart;
        match.pageEnd = hit.pageEnd ?? null;
      }
      // FTS 命中已带精确 clause，不能被「按行号向前找标题」的结果覆盖。
      if (!match.clause) match.clause = clauseFromLine(match.line);
      if (!match.clause) {
        const key = `${match.docId}\u0000${hit.part}`;
        let lines = partCache.get(key);
        if (lines === undefined) {
          try {
            const partText = await readFile(
              join(kbDir, "markdown", match.docId, "parts", partFileName(hit.part - 1)),
              "utf8"
            );
            lines = partText.split(/\r?\n/);
          } catch {
            lines = [];
          }
          partCache.set(key, lines);
        }
        const offset = Math.max(0, Math.min(lines.length - 1, match.lineNumber - hit.startLine));
        for (let i = Math.min(offset, lines.length - 1); i >= 0; i -= 1) {
          const found = clauseFromLine(lines[i]);
          if (found) {
            match.clause = found;
            break;
          }
        }
      }
    }
  }
  return matches;
}

/**
 * 对候选命中排序并分组：
 *  - 标题命中 > 标题行（#/##）命中 > 同文档命中数 > 更新时间；
 *  - 同一文档默认只保留 perDocMax 条，避免一个文档刷屏；
 *  - 跨库时按 (kb, docId) 分组，相同 docId 不合并。
 * @returns 排序后的命中数组（最多 maxMatches 条）
 */
export function rankMatches(matches, { pattern = "", maxMatches = 40, perDocMax = 5 } = {}) {
  if (!Array.isArray(matches) || matches.length === 0) return [];
  let titleTest;
  try {
    const re = new RegExp(String(pattern), "i");
    titleTest = (text) => re.test(text);
  } catch {
    const p = String(pattern).toLowerCase();
    titleTest = (text) => String(text).toLowerCase().includes(p);
  }
  const groups = new Map();
  for (const match of matches) {
    const key = match.kb ? `${match.kb}\u0000${match.docId}` : match.docId;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        title: String(match.title ?? match.docId ?? ""),
        updatedAt: match.updatedAt ?? "",
        trust: match.trust ?? "unknown",
        hits: [],
        kb: match.kb,
      };
      groups.set(key, group);
    }
    group.hits.push(match);
    if (match.updatedAt && String(match.updatedAt) > String(group.updatedAt)) {
      group.updatedAt = match.updatedAt;
    }
  }
  const scored = [];
  for (const group of groups.values()) {
    const titleHit = titleTest(group.title);
    const headingHit = group.hits.some((m) => /^\s*#{1,6}\s/.test(String(m.line ?? "")));
    const timestamp = Date.parse(group.updatedAt);
    const ageDays = Number.isFinite(timestamp) ? (Date.now() - timestamp) / 86_400_000 : 365;
    const recency = Math.max(0, 1 - Math.min(Math.max(ageDays, 0), 365) / 365);
    const trustBonus = { high: 30, medium: 10, unknown: 0, low: -10 }[group.trust] ?? 0;
    const score =
      (titleHit ? 1000 : 0) + (headingHit ? 100 : 0) + Math.min(group.hits.length, 20) * 2 + recency + trustBonus;
    group.hits.sort((a, b) => a.lineNumber - b.lineNumber);
    scored.push({
      score,
      title: group.title,
      kept: group.hits.slice(0, Math.max(1, perDocMax)),
    });
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-Hans-CN"));
  const out = [];
  const cap = Math.max(1, maxMatches);
  for (const group of scored) {
    for (const match of group.kept) {
      if (out.length >= cap) return out;
      out.push(match);
    }
  }
  return out;
}


/**
 * 判定一个查询是否交给 FTS（否则走 ripgrep 精确正则）。
 *
 * 标准号形态一律不交给 FTS：`tokenizeForFts()` 会把 `GB/T 1234` 拆成
 * `gb`、`1234`、`gb/t`、`gbt` 并以 OR 连接，`gb` 会命中几乎所有标准，
 * `GB` 与 `GB/T` 的区分随之丢失（0.26 回归，0.27 修复）。
 * 用户在查询里显式写正则（含元字符）时同样不进 FTS：`ftsQuery` 只会把
 * 字面量包成引号，正则语义会静默失效。空查询由调用方报错。
 */
export function shouldUseFts(pattern) {
  const value = String(pattern ?? "");
  if (value.trim() === "") return false;
  if (looksLikeStandardNumber(value)) return false;
  return !/[\\^$.*+?()[\]{}|]/.test(value);
}

/** 标准号判定复用既有两套口径（写法归一 + 长前缀表），不另立前缀列表。 */
function looksLikeStandardNumber(value) {
  if (!/\d/.test(value)) return false;
  return expandStdQuery(value) !== null || extractStdRef(value) !== null;
}

async function tryFtsSearch(kbDir, manifest, { pattern, docId, maxMatches, backgroundIndex = false }) {
  if (!shouldUseFts(pattern)) return null;
  let status;
  try {
    status = await ftsIndexStatus(kbDir, manifest);
  } catch {
    return null;
  }
  if (!status?.fresh) {
    // 小库/测试库直接同步建，避免短命查询留下后台进程与临时目录竞态；
    // 只有真实大库才走后台，当前查询安全回退 ripgrep。
    if (backgroundIndex && (manifest?.docs?.length ?? 0) >= 100) {
      await startBackgroundFtsBuild(kbDir).catch(() => {});
      return { building: true };
    }
    let built;
    try {
      built = await buildFtsIndex(kbDir, manifest, { stamp: manifestStamp(manifest) });
    } catch {
      return null;
    }
    if (!built?.ok) return null;
  }
  let result;
  try {
    result = await searchFtsIndex(kbDir, pattern, { limit: Math.max(50, maxMatches * 5), docId });
  } catch {
    return null;
  }
  if (!result?.ok) return null;
  if (result.matches.length === 0) return null;
  const byId = new Map((manifest.docs ?? []).map((doc) => [doc.id, doc]));
  const out = [];
  const perDoc = new Map();
  for (const row of result.matches) {
    const count = perDoc.get(row.docId) ?? 0;
    if (count >= 3) continue;
    perDoc.set(row.docId, count + 1);
    const doc = byId.get(row.docId);
    const line = `${row.clause ? `[${row.clause}] ` : ""}${row.heading ? `${row.heading} — ` : ""}${String(row.text ?? "").replace(/\s+/g, " ").slice(0, 240)}`;
    out.push({
      docId: row.docId,
      title: row.title || doc?.title || row.docId,
      path: `markdown/${row.docId}/${row.docId}.md`,
      kb: undefined,
      lineNumber: row.lineStart || 1,
      updatedAt: doc?.updatedAt ?? "",
      part: row.part ?? 1,
      pageStart: row.pageStart ?? undefined,
      pageEnd: row.pageEnd ?? undefined,
      // 条款来自 FTS 行本身；annotateMatches 只在缺失时兜底，避免被分块行号猜错。
      clause: row.clause || undefined,
      type: doc?.type,
      kind: doc?.kind,
      trust: row.trust || doc?.trust,
      line,
    });
    if (out.length >= maxMatches) break;
  }
  await annotateMatches(out, kbDir);
  return {
    matches: out,
    total: result.matches.length,
    truncated: result.matches.length > out.length,
    lossy: false,
    engine: "fts",
    pattern,
  };
}

/**
 * @param ctx 插件上下文（需 ctx.subprocess）
 * @param exec 工具执行上下文（需 exec.signal）
 * @param kbDir 知识库目录
 * @param manifest 知识库清单（用于 id→标题 映射）
 * @param input { pattern, docDir?, maxMatches, lineBytes, timeoutMs }
 */
export async function searchKb(ctx, exec, kbDir, manifest, input) {
  const { pattern, docDir, maxMatches = 40, lineBytes = 400, timeoutMs = 30000, backgroundIndex = false } = input ?? {};
  if (!pattern || String(pattern).length === 0) throw new Error("检索词不能为空");
  const target = docDir ? docDir : join(kbDir, "markdown");
  try {
    await access(target);
  } catch {
    // 空知识库没有 markdown 目录；跨库检索应跳过它而不是让 rg 以退出码 2 失败
    return { matches: [], total: 0, truncated: false, lossy: false, engine: "none", pattern };
  }
  const fts = await tryFtsSearch(kbDir, manifest, {
    pattern: input?.ftsPattern ?? pattern,
    docId: docDir ? docDir.split(/[\\/]/).filter(Boolean).pop() : "",
    maxMatches,
    backgroundIndex,
  });
  const building = fts?.building === true;
  if (fts && !building) return fts;
  const argv = buildRgArgs(await resolveRgPath(), pattern, target, {
    maxMatches,
    lineBytes,
    scoped: Boolean(docDir),
  });
  const stdoutBytes = 16 * 1024 * 1024;
  const handle = ctx.subprocess.spawn({
    argv,
    cwd: kbDir,
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: stdoutBytes },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 3000,
    signal: exec.signal,
  });
  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    throw new Error(`检索进程启动失败: ${error?.message ?? error}`);
  }
  const stdout = handle.collected.stdout?.readFrom(0);
  const stderr = handle.collected.stderr?.readFrom(0);
  if (exec.signal.aborted) throw new Error("检索被取消");
  if (outcome.signal !== null || outcome.exitCode === null) {
    throw new Error(`检索进程被信号终止: ${outcome.signal ?? "(unknown)"}`);
  }
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
    const errText = (stderr?.text ?? "").trim();
    if (/regex parse error|error parsing glob/i.test(errText)) {
      throw new Error(`正则表达式被 ripgrep 拒绝: ${errText.slice(0, 300)}`);
    }
    throw new Error(`检索失败 (退出码 ${outcome.exitCode}): ${errText.slice(0, 300)}`);
  }

  const lossy = stdout?.lossy === true;
  // 排序需要看到比展示上限更多的候选；单文档搜索只有一个文件，放宽到 maxMatches 即可。
  const candidateLimit = docDir
    ? Math.max(maxMatches, 50)
    : Math.min(2000, Math.max(200, maxMatches * 10));
  const parsed = parseRgOutput(stdout?.text ?? "", {
    manifest,
    kbDir,
    maxMatches: candidateLimit,
    lineBytes,
  });
  await annotateMatches(parsed.matches, kbDir);
  const updatedAtById = new Map(
    (manifest.docs ?? []).map((doc) => [doc.id, doc.updatedAt ?? ""])
  );
  for (const match of parsed.matches) {
    match.updatedAt = updatedAtById.get(match.docId) ?? "";
  }
  const ranked = rankMatches(parsed.matches, {
    pattern: String(pattern),
    maxMatches,
    perDocMax: docDir ? candidateLimit : 5,
  });
  return {
    ...parsed,
    matches: ranked,
    truncated: parsed.total > ranked.length || lossy,
    lossy,
    engine: "rg",
    ...(building ? { indexBuilding: true } : {}),
    ...(lossy || building
      ? { note: [
          lossy ? "检索结果超出缓冲上限，已保留缓冲区内的匹配；请换更精确的关键词或缩小范围" : "",
          building ? "FTS 索引构建中，本次已回退全文检索；稍后重试即可使用条款索引" : "",
        ].filter(Boolean).join("；") }
      : {}),
    pattern,
  };
}
