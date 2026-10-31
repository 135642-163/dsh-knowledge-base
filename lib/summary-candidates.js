/**
 * 摘要候选（只读）：从正文里提取“本标准规定了…”/“本部分适用于…”等范围句，
 * 用于人工复核后通过 kb_describe 重编目。绝不直接写库。
 */
const NOISE_PATTERNS = [
  /!!/, /WxT/i, /PQjk/i, /\bICS\s*\d/i, /\bCCS\b/i, /Published by/i,
  /First published/i, /French text overleaf/i, /PROJECT NUMBER/i, /Click here/i,
  /Copyright/i, /\bIEEE Std\b/i,
];

export function looksNoisySummary(summary) {
  const text = String(summary ?? "");
  return text.trim() === "" || NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 提取完整的「范围」小节：从“本标准规定了…”开始，到下一个章节（如“2 规范性引用文件”）
 * 之前为止。这样“规定了 / 适用于 / 不适用于”三段都会进入摘要，而不是只取第一句。
 * 找不到范围句时返回空串。
 */
export function extractScopeSummary(markdown, { maxChars = 500 } = {}) {
  const lines = String(markdown ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/\r/g, "")
    .split("\n");
  const startPattern = /(?:本标准|本部分|本文件)(?:规定了|适用于|给出了)/;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (startPattern.test(lines[index])) {
      start = index;
      break;
    }
  }
  if (start < 0) return "";
  const collected = [];
  let started = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    // 下一个一级章节（“2 规范性引用文件”“3 术语和定义”等）就停止。
    if (started && /^[2-9](?:[.、\s]|(?=[\u4e00-\u9fff]))/.test(line)) break;
    if (started && /^第[2-9]章/.test(line)) break;
    // 跳过页眉/页码（仅标准号页眉、纯数字行）；不要把以“GB/T … 的本部分规定了”开头的正文误删。
    if (/^GB(?:\/T)?\s*[\d.]+(?:[—\-一]\d{4})?\s*$/i.test(line) || /^\d+$/.test(line)) continue;
    collected.push(line);
    started = true;
  }
  let text = collected.join(" ").replace(/\s+/g, " ").trim();
  // OCR 常用句点代替顿号；只在两个汉字之间替换，避免动到小数点/版本号。
  text = text.replace(/(?<=[\u4e00-\u9fff])\.(?=[\u4e00-\u9fff])/g, "、");
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
}
