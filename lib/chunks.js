/**
 * 把文档 part 切成适合 embedding/RAG 的小块。
 *
 * 规则：
 *  - 先按空行分段；段超过 maxChars 再按中文/英文句末标点切句；
 *  - 单句仍超长时按 maxChars 硬切（保证不会产出超长块）；
 *  - 可选 overlap：把上一块末尾若干字符带到下一块，便于跨块语义衔接；
 *  - 所有块的 length 都 <= maxChars（overlap 包含在预算内）。
 */
export function splitTextChunks(text, { maxChars = 800, overlap = 0 } = {}) {
  const value = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!value) return [];
  const max = Math.max(1, Math.floor(Number(maxChars) || 800));
  const ov = Math.min(
    Math.max(0, Math.floor(Number(overlap) || 0)),
    Math.floor(max / 3)
  );
  if (value.length <= max) return [value];

  // 1) 拆成不超过 max 的语义单元（段/句/硬切片段）
  const units = [];
  for (const rawParagraph of value.split(/\n{2,}/)) {
    const paragraph = rawParagraph.trim();
    if (!paragraph) continue;
    if (paragraph.length <= max) {
      units.push(paragraph);
      continue;
    }
    const sentences = paragraph.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [paragraph];
    let buffer = "";
    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      if (!sentence) continue;
      if (sentence.length > max) {
        if (buffer) {
          units.push(buffer);
          buffer = "";
        }
        for (let i = 0; i < sentence.length; i += max) {
          units.push(sentence.slice(i, i + max));
        }
        continue;
      }
      if (!buffer) buffer = sentence;
      else if (buffer.length + sentence.length <= max) buffer += sentence;
      else {
        units.push(buffer);
        buffer = sentence;
      }
    }
    if (buffer) units.push(buffer);
  }

  // 2) 贪心装块；跨块时按 overlap 带上上一块末尾
  const chunks = [];
  let current = "";
  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }
    if (current.length + 2 + unit.length <= max) {
      current += "\n\n" + unit;
      continue;
    }
    chunks.push(current);
    const tail = ov > 0 ? current.slice(-ov).trim() : "";
    const room = max - unit.length - (tail ? 2 : 0);
    const prefix = tail && room > 0 ? tail.slice(-room) : "";
    current = prefix ? `${prefix}\n\n${unit}` : unit;
    if (current.length > max) current = unit;
  }
  if (current) chunks.push(current);
  return chunks;
}
