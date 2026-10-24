/**
 * 标题清洗：把从文件名/网页抓取带进来的噪声去掉，保留可检索、可读的标准号与标题。
 *
 * 只做保守替换，宁可少清理也不误伤：
 *  - 站点水印/域名（标准网-www.biaozhun.org、_www.upbz.net 等）；
 *  - HTML/剪藏残留（span style=…、成对的残留括号）；
 *  - 下划线分隔的标准号（GB_T→GB/T、Q_GDW→Q/GDW、T_CEC→T/CEC）；
 *  - 裸写标准号（GBT 156→GB/T 156、DLT→DL/T）；
 *  - 文件序号前缀（"1. 电能质量管理办法…"），仅匹配 1–3 位 + 点/顿号；
 *  - 剩余下划线转空格、压缩空白、去掉空括号与首尾分隔符。
 */
const SITE_PATTERNS = [
  // （标准网-www.biaozhun.org）、[免费标准网_www.upbz.net]
  /[\(（\[【]\s*(?:免费)?标准网[^\)）\]】]{0,80}[\)）\]】]/gi,
  /[\(（\[【]?\s*(?:www\.)?(?:biaozhun\.org|upbz\.net|fx678\.com|doc88\.com)[^\s\)）\]】]{0,40}[\)）\]】]?/gi,
  /[_\-\s]*(?:免费)?标准网[_\-\s：:]*/gi,
];

/** 标准号（含 GB/DL/NB/IEEE 等前缀）的通用片段，用于把末尾编号移到开头。 */
const STD_NUMBER = String.raw`(?:GB|DL|NB|JB|TB|DB|Q\/GDW|T\/CEC|CECS|JGJ|CJJ|IEC|IEEE(?:\s+Std)?|WD)\s*[\/A-Z]*\s*\d+(?:\.\d+)*(?:\s*[-—–~]\s*\d{4})?`;
const TRAILING_STD = new RegExp(`^(.*?[^\\s])\\s+(${STD_NUMBER})\\s*$`, "i");
const ANY_STD = new RegExp(STD_NUMBER, "i");

export function cleanTitle(input) {
  const original = String(input ?? "").normalize("NFC").trim();
  if (!original) return "";
  let t = original;
  for (const re of SITE_PATTERNS) t = t.replace(re, " ");
  // 剪藏/转换残留：整段含 span 的方括号（只保留括号里的中文，去掉样式碎片）
  t = t.replace(/\[[^\]]*span[^\]]*\]/gi, (m) => {
    const inner = m
      .slice(1, -1)
      .replace(/\b(?:span|style|class|color|red|blue|green|black)\b/gi, " ")
      .replace(/[_=;:{}]+/g, " ");
    const cjk = inner.match(/[\u4e00-\u9fa5]+/g) ?? [];
    return cjk.length > 0 ? ` ${cjk.join("")} ` : " ";
  });
  t = t.replace(/\b_?span\s+(?:style|class)=[^\]\)\s]*/gi, " ");
  t = t.replace(/_{2,}/g, " ");
  // 下划线标准号 → 规范写法（先于“下划线转空格”）
  t = t.replace(/\b(GB|DL|NB|JB|TB)_(T|Z)\b/gi, (m, a, b) => `${a.toUpperCase()}/${b.toUpperCase()}`);
  // 全角/除号分隔的标准号（GB∕T、DL／T）统一成半角斜杠
  t = t.replace(/\b(GB|DL|NB|JB|TB|DB|CECS|T)\s*[∕／]\s*(T|Z)\b/gi, (m, a, b) => `${a.toUpperCase()}/${b.toUpperCase()}`);
  t = t.replace(/\bT_(CEC|CES|CECS|SZ)\b/gi, (m, b) => `T/${b.toUpperCase()}`);
  t = t.replace(/\bQ_GDW\b/gi, "Q/GDW");
  // 裸写标准号：GBT 156 / DLT 506 / NBT 31081 / JBT 123（后面紧跟空白/数字才替换）
  t = t.replace(/\b(GB|DL|NB|JB|TB)T(?=\s|\d)/gi, (m, a) => `${a.toUpperCase()}/T`);
  t = t.replace(/\bGBZ(?=\s|\d)/gi, "GB/Z");
  t = t.replace(/\bQGDW(?=\s|\d)/gi, "Q/GDW");
  // 电压单位统一小写 kV（220KV/35KV → 220kV/35kV）
  t = t.replace(/(\d+(?:\.\d+)?)\s*[Kk][Vv]\b/g, "$1kV");
  // 序号前缀：1. / 2、 / 10．（全角点也覆盖）
  t = t.replace(/^\s*\d{1,3}\s*[.、．]\s*(?=\S)/, "");
  // 序号 + 空格 + 标准号前缀（如“51 DL/T 5136-2012 …”）
  t = t.replace(/^\s*\d{1,3}\s+(?=[A-Za-z]{2,5}[\/\s])/, "");
  // 其余下划线视作分词空白；压空白、去空括号、去首尾分隔符
  t = t.replace(/_/g, " ");
  t = t.replace(/[\(（]\s*[\)）]/g, " ");
  t = t.replace(/\s+/g, " ").replace(/^[\s\-—–_·,，、]+|[\s\-—–_·,，、]+$/g, "").trim();
  // 标准命名统一为「编号 名称」：把末尾的标准号移到开头（名称里已有别的编号时不动）。
  const trailing = t.match(TRAILING_STD);
  if (trailing && trailing[1] && !ANY_STD.test(trailing[1])) t = `${trailing[2]} ${trailing[1]}`;
  return (t || original).slice(0, 200);
}
