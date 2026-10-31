/**
 * 语义“文档画像 v2”实验：把文档切成多个窗口，而不是只取前 600 字。
 * 仅用于评估/后续索引升级，不改变当前生产 doc-vectors。
 */
export const WINDOW_DEFAULTS = Object.freeze({
  maxWindows: 8,
  windowChars: 420,
});

function cleanMarkdown(markdown) {
  return String(markdown ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^#\s+.*$/m, "")
    .replace(/\r/g, "");
}

/**
 * 从合并版 markdown 提取窗口：按「### 第 N 页」分页，再把每页切成 ≤windowChars 的块；
 * 最后在整篇范围内均匀抽样 maxWindows 块，保证覆盖开头、中段、结尾。
 * @returns Array<{text,pageStart,pageEnd,index,total}>
 */
export function splitMarkdownWindows(markdown, { maxWindows = WINDOW_DEFAULTS.maxWindows, windowChars = WINDOW_DEFAULTS.windowChars, prefix = "" } = {}) {
  const lines = cleanMarkdown(markdown).split("\n");
  const pages = [];
  let current = { page: 0, lines: [] };
  for (const line of lines) {
    const match = /^#{1,6}\s*第\s*(\d+)\s*页\s*$/.exec(line.trim());
    if (match) {
      if (current.lines.length > 0 || current.page > 0) pages.push(current);
      current = { page: Number(match[1]), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0 || current.page > 0) pages.push(current);

  const chunks = [];
  for (const page of pages) {
    let buffer = "";
    const flush = () => {
      const text = buffer.replace(/\s+/g, " ").trim();
      buffer = "";
      if (!text) return;
      // 长段再按句号切一次，避免一个超长段落占满窗口
      for (let start = 0; start < text.length; start += windowChars) {
        const piece = text.slice(start, start + windowChars).trim();
        if (piece) chunks.push({ text: piece, page: page.page });
      }
    };
    for (const raw of page.lines) {
      const line = raw.trim();
      if (!line) continue;
      if (buffer.length > 0 && buffer.length + line.length + 1 > windowChars) flush();
      buffer += (buffer ? " " : "") + line;
    }
    flush();
  }
  if (chunks.length === 0) return [];
  const total = chunks.length;
  const wanted = Math.max(1, Math.min(Number(maxWindows) || WINDOW_DEFAULTS.maxWindows, total));
  const indexes = new Set();
  if (wanted === 1) indexes.add(0);
  else for (let i = 0; i < wanted; i += 1) {
    indexes.add(Math.round((i * (total - 1)) / (wanted - 1)));
  }
  const head = String(prefix ?? "").replace(/\s+/g, " ").trim();
  return [...indexes].sort((a, b) => a - b).map((index) => {
    const chunk = chunks[index];
    const text = `${head} ${chunk.text}`.trim().slice(0, windowChars + head.length);
    return {
      text,
      pageStart: chunk.page || null,
      pageEnd: chunk.page || null,
      index,
      total,
    };
  });
}
