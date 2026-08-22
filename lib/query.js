/**
 * 知识库全文检索：用打包的 ripgrep 二进制在合并版 markdown 上跑正则，
 * 输出按文档归组的匹配（文档 id/标题、行号、行预览）。
 * 进程侧全部经由 ctx.subprocess（无 shell 层）。
 */
import { join, relative } from "node:path";

let rgPathPromise;
async function resolveRgPath() {
  rgPathPromise ??= import("@vscode/ripgrep").then((module) => module.rgPath);
  return rgPathPromise;
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
  const argv = [
    await resolveRgPath(),
    "--no-config",
    "--json",
    "--glob",
    "!**/parts/**",
    `--regexp=${pattern}`,
    "--",
    target,
  ];
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
  if (stdout.lossy) {
    throw new Error("检索结果过大，超出缓冲上限；请缩小检索范围或换更精确的关键词");
  }

  const byId = new Map();
  for (const d of manifest.docs ?? []) byId.set(d.id, d.title ?? d.id);
  const matches = [];
  let total = 0;
  for (const line of (stdout.text ?? "").split("\n")) {
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
    total += 1;
    const docId = /markdown[\\/]([^\\/]+)[\\/]/.exec(pathText)?.[1] ?? "?";
    // total 统计真实命中数（不因 maxMatches 截断而少报），matches 仅保留展示上限；
    // display 用 path.relative 计算，Windows 下不会暴露盘符绝对路径
    if (matches.length < maxMatches) {
      matches.push({
        docId,
        title: byId.get(docId) ?? docId,
        path: relative(kbDir, pathText) || pathText,
        lineNumber: data.line_number,
        line: lineText.length > lineBytes ? lineText.slice(0, lineBytes) + "…" : lineText,
      });
    }
  }
  return {
    matches,
    total,
    truncated: total > matches.length,
    pattern,
  };
}
