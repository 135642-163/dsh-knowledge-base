/**
 * 资料标签的确定性分类：标准层级 + 主题。
 * 只依据标题/标准号，不读正文；宁可少标，不把“会议通知/附件”误标成标准。
 */
import { parseDocMeta } from "./doc-meta.js";

const TYPE_BY_PREFIX = new Map([
  ["GB", "国家标准"],
  ["GB/T", "国家标准"],
  ["GB/Z", "国家标准"],
  ["JJF", "国家标准"],
  ["JJG", "国家标准"],
  ["DL", "行业标准"],
  ["DL/T", "行业标准"],
  ["DL/Z", "行业标准"],
  ["NB", "行业标准"],
  ["NB/T", "行业标准"],
  ["JB", "行业标准"],
  ["JB/T", "行业标准"],
  ["TB", "行业标准"],
  ["TB/T", "行业标准"],
  ["HG", "行业标准"],
  ["HG/T", "行业标准"],
  ["YD", "行业标准"],
  ["YD/T", "行业标准"],
  ["Q/GDW", "企业标准"],
  ["IEC", "国际标准"],
  ["IEC/TS", "国际标准"],
  ["IEC/TR", "国际标准"],
  ["IEEE", "国际标准"],
  ["ISO", "国际标准"],
  ["EN", "国际标准"],
]);

const TOPIC_RULES = [
  ["电能质量", /电能质量|电压暂降|电压偏差|电压波动|电压闪变|闪变|谐波|间谐波|无功补偿|电压监测|电压合格率|供电电压|公用电网|三相不平衡|电压暂降与短时中断|电能质量评估|power\s+quality/i],
  ["继电保护", /继电保护|保护装置|安全自动装置|故障录波|整定计算|重合闸|差动保护|距离保护|线路保护|母线保护|变压器保护|保护校验|保护运行/],
  ["变压器", /变压器|换流变压器/],
  ["变电试验", /变电试验|(?:变电|变电站|换流站).*(?:试验|检测|检修|交接|预防性|带电|调试|验收)|(?:试验|检测|检修|交接|预防性|带电|调试|验收).*(?:变电|变电站|换流站)/],
  ["绝缘", /绝缘|局部放电|局放|绝缘子|套管|污闪|沿面|介损|介质损耗/],
  ["新能源", /风电|风电场|光伏|分布式电源|新能源|储能|海上风电|风机/],
  ["直流输电", /直流输电|柔性直流|特高压直流|换流站/],
];

export const TYPE_TAGS = Object.freeze(["国家标准", "行业标准", "企业标准", "团体标准", "国际标准"]);
export const TOPIC_TAGS = Object.freeze(["电能质量", "继电保护", "变压器", "变电试验", "绝缘", "新能源", "直流输电"]);

/** 从已存字段或标题解析标准前缀；用于旧资料/标题带书名号的情况。 */
export function standardPrefixOf(doc) {
  const stored = String(doc?.standardPrefix ?? "").trim().toUpperCase();
  if (stored) return stored;
  const title = String(doc?.title ?? "");
  // 标题中间出现“IEC/GB”的通知/纪要不是标准；只有书名号开头或标准号开头才解析。
  if (!/^\s*(?:《|GB|DL|NB|JB|TB|HG|YD|SJ|YS|CJJ|JGJ|JJF|JJG|Q\/GDW|IEC|IEEE|ISO|EN|T\/[A-Z]{2,}|T[A-Z]{3,})/i.test(title)) {
    return "";
  }
  const meta = parseDocMeta(title, doc?.rawTitle ?? title);
  return String(meta.standardPrefix ?? "").trim().toUpperCase();
}

/** 标准层级标签；无法判断时返回空数组（不强行归为“其他”）。 */
export function standardTypeTags(doc) {
  const prefix = standardPrefixOf(doc);
  const direct = TYPE_BY_PREFIX.get(prefix);
  if (direct) return [direct];
  if (/^T\/[A-Z]{2,}$/i.test(prefix) || /^T[A-Z]{3,}$/i.test(prefix)) return ["团体标准"];
  const title = String(doc?.title ?? "");
  if (/^Q\/GDW|^国网|^国家电网/.test(title) && /规定|规范|标准|导则|规程|办法/.test(title)) return ["企业标准"];
  if (/^T\/[A-Z]{2,}/i.test(title)) return ["团体标准"];
  if (/^(?:【[^】]*】\s*)?IEC\s+(?:TR|TS|61000)/i.test(title)) return ["国际标准"];
  return [];
}

/** 主题标签；按固定顺序返回，便于稳定 diff。 */
export function topicTags(doc) {
  const text = `${doc?.title ?? ""} ${doc?.summary ?? ""}`.trim();
  if (!text) return [];
  return TOPIC_RULES.filter(([, re]) => re.test(text)).map(([tag]) => tag);
}

/** 合并已有标签；去重、去空、保留原有顺序，最多 20 个。 */
export function classifyDocTags(doc, { existing = [] } = {}) {
  const all = [];
  for (const tag of [...(Array.isArray(existing) ? existing : []), ...standardTypeTags(doc), ...topicTags(doc)]) {
    const value = String(tag ?? "").trim();
    if (value && !all.includes(value)) all.push(value);
  }
  return all.slice(0, 20);
}

/** 只返回新增标签，便于 dry-run 报告。 */
export function addedTags(doc, existing = []) {
  const next = classifyDocTags(doc, { existing });
  return next.filter((tag) => !existing.includes(tag));
}
