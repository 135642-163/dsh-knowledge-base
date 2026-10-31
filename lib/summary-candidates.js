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
 * 在合并版 markdown 中找第一个“范围”句；找不到返回空串。
 * 只在正文段落中找，避免把封面/前言做摘要。
 */
export function extractScopeSummary(markdown, { maxChars = 180 } = {}) {
  const text = cleanText(markdown);
  const patterns = [
    /(本标准规定了[^。；]{8,}?。)/,
    /(本部分规定了[^。；]{8,}?。)/,
    /(本文件规定了[^。；]{8,}?。)/,
    /(本标准适用于[^。；]{8,}?。)/,
    /(本部分适用于[^。；]{8,}?。)/,
    /(本文件适用于[^。；]{8,}?。)/,
    /(本标准给出了[^。；]{8,}?。)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const sentence = match[1].replace(/\s+/g, " ").trim();
      return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1)}…` : sentence;
    }
  }
  return "";
}
