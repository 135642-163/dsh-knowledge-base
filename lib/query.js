/**
 * 知识库全文检索：用打包的 ripgrep 二进制在合并版 markdown 上跑正则，
 * 输出按文档归组的匹配（文档 id/标题、行号、行预览）。
 * 进程侧全部经由 ctx.subprocess（无 shell 层）。
 *
 * 高频词保护：给 ripgrep 加 --max-count（每文件上限），并把 stdout 缓冲
 * 超限（lossy）视为“已截断”而不是整体失败——在 948 个文档的库里搜
 * “电压”这类词时，返回部分结果远好于一条都拿不到。
 */
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

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
  for (const d of manifest?.docs ?? []) byId.set(d.id, d.title ?? d.id);
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
    total += 1;
    const docId = /markdown[\\/]([^\\/]+)[\\/]/.exec(pathText)?.[1] ?? "?";
    // total 统计真实命中数（不因 maxMatches 截断而少报），matches 仅保留展示上限；
    // display 用 path.relative 计算，Windows 下不会暴露盘符绝对路径
    if (matches.length < maxMatches) {
      matches.push({
        docId,
        title: byId.get(docId) ?? docId,
        path: kbDir ? relative(kbDir, pathText) || pathText : pathText,
        lineNumber: data.line_number,
        line: lineText.length > lineBytes ? lineText.slice(0, lineBytes) + "…" : lineText,
      });
    }
  }
  return { matches, total, truncated: total > matches.length };
}

/**
 * 给命中项补 part/page：读取 markdown/<docId>/parts/index.json，
 * 用合并版行号落到对应分块。0.4.0 之前的文档没有索引时保持原样。
 */
export async function annotateMatches(matches, kbDir) {
  const cache = new Map();
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
      match.pageStart = hit.pageStart ?? null;
      match.pageEnd = hit.pageEnd ?? null;
    }
  }
  return matches;
}

/**
 * @param ctx 插件上下文（需 ctx.subprocess）
 * @param exec 工具执行上下文（需 exec.signal）
 * @param kbDir 知识库目录
 * @param manifest 知识库清单（用于 id→标题 映射）
 * @param input { pattern, docDir?, maxMatches, lineBytes, timeoutMs }
 */
export async function searchKb(ctx, exec, kbDir, manifest, input) {
  const { pattern, docDir, maxMatches = 40, lineBytes = 400, timeoutMs = 30000 } = input ?? {};
  if (!pattern || String(pattern).length === 0) throw new Error("检索词不能为空");
  const target = docDir ? docDir : join(kbDir, "markdown");
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
  const parsed = parseRgOutput(stdout?.text ?? "", { manifest, kbDir, maxMatches, lineBytes });
  await annotateMatches(parsed.matches, kbDir);
  return {
    ...parsed,
    truncated: parsed.truncated || lossy,
    lossy,
    ...(lossy
      ? { note: "检索结果超出缓冲上限，已保留缓冲区内的匹配；请换更精确的关键词或缩小范围" }
      : {}),
    pattern,
  };
}
