/**
 * 标题清洗：把从文件名/网页抓取带进来的噪声去掉，保留可检索、可读的标准号与标题。
 *
 * 只做保守替换，宁可少清理也不误伤：
 *  - 站点水印/域名（标准网-www.biaozhun.org、_www.upbz.net 等）；
 *  - HTML/剪藏残留（span style=…、成对的残留括号）；
 *  - 下划线分隔的标准号（GB_T→GB/T、Q_GDW→Q/GDW、T_CEC→T/CEC）；
 *  - 裸写标准号（GBT 156→GB/T 156、DLT→DL/T）；
 *  - 文件序号前缀（"1. 电能质量管理办法…"），仅匹配 1–3 位 + 点/顿号；
 *  - 目录整理用的年份前缀（"2015 - 火力发电厂…"）与状态括注（"(已作废)…"）；
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
  // 冒号分隔的标准号：下载站/文件系统不接受 "/" 时常被换成 ":"（GB:T 47968-2026、
  // Q:GDW 123-2020）。不归一化的话“标题里已有编号”的判断认不出这个编号，
  // 自动命名会拼成「GB/T 47968-2026 GB:T 47968-2026 名称」。
  t = t.replace(/\b(GB|DL|NB|JB|TB|DB|CECS)\s*[:：]\s*(T|Z)\b/gi, (m, a, b) => `${a.toUpperCase()}/${b.toUpperCase()}`);
  t = t.replace(/\bQ\s*[:：]\s*GDW\b/gi, "Q/GDW");
  t = t.replace(/\bT\s*[:：]\s*(CEC|CES|CECS|SZ)\b/gi, (m, b) => `T/${b.toUpperCase()}`);
  // 裸写标准号：GBT 156 / DLT 506 / NBT 31081 / JBT 123（后面紧跟空白/数字才替换）
  t = t.replace(/\b(GB|DL|NB|JB|TB)T(?=\s|\d)/gi, (m, a) => `${a.toUpperCase()}/T`);
  t = t.replace(/\bGBZ(?=\s|\d)/gi, "GB/Z");
  t = t.replace(/\bQGDW(?=\s|\d)/gi, "Q/GDW");
  // Zotero/下载器的「GBT+40600-2021」「GBZ+17624.8-2025」写法（加号当分隔符）
  t = t.replace(/\b(GB|DL|NB|JB|TB)T\+(?=\d)/gi, (m, a) => `${a.toUpperCase()}/T `);
  t = t.replace(/\bGBZ\+(?=\d)/gi, "GB/Z ");
  // 电压单位统一小写 kV（220KV/35KV → 220kV/35kV）
  t = t.replace(/(\d+(?:\.\d+)?)\s*[Kk][Vv]\b/g, "$1kV");
  // 状态前置标记（ZX 下载站/整理时加的「(已作废)GB 10229-88 电抗器」）：状态应进 trust，
  // 不是名称的一部分；只剥离开头的括注，避免动到名称中间的解释性括号。
  t = t.replace(/^[\(（]\s*(?:已作废|作废|已废止|已失效|现行|有效)\s*[\)）]\s*/, "");
  // 整理目录用的年份前缀（Zotero「年份 - 名称」：2024 - 高压直流工程换流变压器技术规范…）。
  // 只剥「4 位年份 + 连字符 + 非数字开头」，避开「2015-2020 年规划」这类真实年份区间。
  t = t.replace(/^(?:19|20)\d{2}\s*[-—–]\s*(?!\d)/, "");
  // 序号前缀：1. / 2、 / 10．（全角点也覆盖）
  t = t.replace(/^\s*\d{1,3}\s*[.、．]\s*(?=\S)/, "");
  // 序号 + 连字符前缀（「08-电能质量技术监督工作实施细则」），不碰 110-750kV 这类数字区间
  t = t.replace(/^\s*\d{1,2}\s*[-—–]\s*(?=[\u4e00-\u9fa5])/, "");
  // 序号 + 空格 + 标准号前缀（如“51 DL/T 5136-2012 …”）
  t = t.replace(/^\s*\d{1,3}\s+(?=[A-Za-z]{2,5}[\/\s])/, "");
  // 其余下划线视作分词空白；压空白、去空括号、去首尾分隔符
  t = t.replace(/_/g, " ");
  t = t.replace(/[\(（]\s*[\)）]/g, " ");
  t = t.replace(/\s+/g, " ").replace(/^[\s\-—–_·,，、]+|[\s\-—–_·,，、]+$/g, "").trim();
  // 末尾括注的标准号（如「电磁兼容 综述 第8部分…（GB_Z 17624.8-2025）」）：
  // 编号会移到标题开头，括注整段只有编号时剥掉，避免名称里重复一个编号。
  // 书名号标题（《名称》（GB/T …））除外：那里的编号是标题唯一的标准号来源。
  if (!/^\s*《/.test(t)) {
    t = t.replace(
      /\s*[\(（]\s*(?:GB|DL|NB|JB|TB|DB|Q\/GDW|Q\/[A-Z]{2,4}|T\/[A-Z]{2,}|CECS|JGJ|CJJ|IEC|IEEE|ISO)\s*[\/A-Z]*\s*\d+(?:\.\d+)*(?:\s*[-—–~～]\s*\d{4})?\s*[\)）]\s*$/i,
      " "
    ).trim();
  }
  // 标准命名统一为「编号 名称」：把末尾的标准号移到开头（名称里已有别的编号时不动）。
  const trailing = t.match(TRAILING_STD);
  if (trailing && trailing[1] && !ANY_STD.test(trailing[1])) t = `${trailing[2]} ${trailing[1]}`;
  return (t || original).slice(0, 200);
}
