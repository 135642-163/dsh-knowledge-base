/**
 * 0.40 中英双语检索扩展：让中文提问也能命中知识库里的英文文献（反之亦然）。
 *
 * 背景：词面检索（FTS5 / ripgrep）本身不跨语言；可选的语义层默认使用
 * bge-small-zh（中文语料），对英文文献的跨语言召回也不可靠。这里用一张
 * 「电力/标准领域」的中英术语对照表做**查询侧扩展**：
 *   - 中文查询 → 识别词表中的中文术语，补一组英文检索词；
 *   - 英文查询 → 反向补中文检索词；
 *   - 影子检索只落在「标题/标准号可判定为另一语言」的文档上，避免把
 *     中文库里零星出现的英文单词当成召回依据。
 *
 * 本模块是纯函数：不读盘、不加载模型、不发请求。词表覆盖电力系统、
 * 电能质量、电磁兼容与标准文本的常用术语；没覆盖到的长尾由 agent 自行
 * 翻译后再次检索（系统提示里已写明）。
 */

const CJK_RE = /[\u3400-\u9fff]/;
const CJK_ALL_RE = /[\u3400-\u9fff]/g;
const LATIN_ALL_RE = /[A-Za-z]/g;
const REGEX_META_RE = /[\\()[\]{}|+*?^$]/;
const MAX_TERMS = 12;

/** [中文术语, [英文同义写法…]]。英文检索对大小写不敏感，复数/缩写都写成独立条目。 */
const TERMS = Object.freeze([
  // —— 电能质量 / 电磁兼容 ——
  ["电能质量", ["power quality"]],
  ["电能质量管理", ["power quality management"]],
  ["电能质量监测", ["power quality monitoring"]],
  ["电能质量测量", ["power quality measurement"]],
  ["电能质量评估", ["power quality assessment"]],
  ["电能质量分析", ["power quality analysis"]],
  ["供电电压", ["supply voltage"]],
  ["供电系统", ["power supply system"]],
  ["配电系统", ["distribution system"]],
  ["电力系统", ["power system"]],
  ["公用电网", ["public network"]],
  ["公用配电网络", ["public distribution network"]],
  ["公共连接点", ["point of common coupling", "pcc"]],
  ["低压供电系统", ["low-voltage supply system", "low voltage supply system"]],
  ["中压供电系统", ["medium-voltage supply system", "medium voltage supply system"]],
  ["高压", ["high voltage"]],
  ["低压", ["low voltage"]],
  ["中压", ["medium voltage"]],
  ["特高压", ["ultra-high voltage", "uhv"]],
  ["电压等级", ["voltage level"]],
  ["额定电压", ["rated voltage"]],
  ["标称电压", ["nominal voltage"]],
  ["系统电压", ["system voltage"]],
  ["电压偏差", ["voltage deviation"]],
  ["频率偏差", ["frequency deviation"]],
  ["电压波动", ["voltage fluctuation"]],
  ["电压变化", ["voltage change"]],
  ["电压暂降", ["voltage dip", "voltage sag"]],
  ["电压骤降", ["voltage dip", "voltage sag"]],
  ["短时中断", ["short interruption"]],
  ["电压中断", ["voltage interruption"]],
  ["三相不平衡", ["three-phase unbalance", "three phase unbalance"]],
  ["不平衡度", ["unbalance"]],
  ["谐波", ["harmonic"]],
  ["谐波电流", ["harmonic current"]],
  ["谐波电压", ["harmonic voltage"]],
  ["间谐波", ["interharmonic"]],
  ["总谐波畸变率", ["total harmonic distortion", "thd"]],
  ["谐波含有率", ["harmonic content"]],
  ["闪变", ["flicker"]],
  ["电压闪变", ["voltage flicker"]],
  ["电磁兼容", ["electromagnetic compatibility", "emc"]],
  ["电磁骚扰", ["electromagnetic disturbance"]],
  ["电磁干扰", ["electromagnetic interference", "emi"]],
  ["抗扰度", ["immunity"]],
  ["发射", ["emission"]],
  ["传导发射", ["conducted emission"]],
  ["辐射发射", ["radiated emission"]],
  ["传导骚扰", ["conducted disturbance"]],
  ["辐射骚扰", ["radiated disturbance"]],
  ["限值", ["limit", "limits"]],
  ["兼容水平", ["compatibility level"]],
  ["环境", ["environment"]],
  ["工业装置", ["industrial plant"]],
  ["公共低压供电系统", ["public low-voltage supply system"]],
  ["信号", ["signal", "signalling", "signaling"]],
  ["低频", ["low frequency", "low-frequency"]],
  ["磁场", ["magnetic field"]],
  ["过电压", ["overvoltage"]],
  ["静电放电", ["electrostatic discharge", "esd"]],
  ["浪涌", ["surge"]],
  ["快速瞬变", ["fast transient"]],
  ["电压暂降抗扰度", ["voltage dip immunity"]],
  ["试验", ["test", "tests"]],
  ["测量", ["measurement", "measurements"]],
  ["监测", ["monitoring"]],
  ["仪器", ["instrument"]],
  ["装置", ["device"]],
  ["设备", ["equipment"]],
  ["不确定度", ["uncertainty"]],
  ["校准", ["calibration"]],
  ["检定", ["verification"]],
  ["检验", ["inspection"]],
  ["功能试验", ["functional test"]],
  ["性能", ["performance"]],
  ["要求", ["requirement", "requirements"]],
  ["方法", ["method", "methods"]],
  ["通用", ["general"]],
  ["总则", ["general"]],
  ["定义", ["definition", "definitions"]],
  ["术语", ["terms", "terminology"]],
  ["符号", ["symbols"]],
  ["缩略语", ["abbreviations"]],
  ["范围", ["scope"]],
  ["规范性引用文件", ["normative references"]],
  ["规范性附录", ["normative annex"]],
  ["资料性附录", ["informative annex"]],
  ["分类", ["classification"]],
  ["标志", ["marking"]],
  ["包装", ["packaging"]],
  ["运输", ["transportation"]],
  ["贮存", ["storage"]],
  ["安装", ["installation"]],
  ["运行", ["operation"]],
  ["维护", ["maintenance"]],
  ["检修", ["overhaul"]],
  ["调试", ["commissioning"]],
  ["验收", ["acceptance"]],
  ["质量", ["quality"]],
  ["管理", ["management"]],
  ["评估", ["assessment"]],
  ["风险", ["risk"]],
  ["标准", ["standard", "standards"]],
  ["导则", ["guide"]],
  ["规范", ["specification"]],
  ["规程", ["code"]],
  ["技术条件", ["technical specification"]],
  ["技术规范", ["technical specification"]],
  ["草案", ["draft"]],
  ["征求意见稿", ["draft for comments"]],
  ["编制说明", ["preparation notes"]],
  ["国家标准", ["national standard"]],
  ["行业标准", ["industry standard"]],
  ["国际标准", ["international standard"]],
  ["企业标准", ["enterprise standard"]],
  // —— 电力系统 / 设备 ——
  ["电压", ["voltage"]],
  ["电流", ["current"]],
  ["功率", ["power"]],
  ["阻抗", ["impedance"]],
  ["电路", ["circuit"]],
  ["电源", ["power supply"]],
  ["电机", ["motor"]],
  ["电动机", ["motor"]],
  ["发电机", ["generator"]],
  ["电能", ["electric energy"]],
  ["故障", ["fault"]],
  ["网络", ["network"]],
  ["电力", ["power"]],
  ["电网", ["power grid"]],
  ["输电网", ["transmission network"]],
  ["配电网", ["distribution network"]],
  ["输电", ["transmission"]],
  ["配电", ["distribution"]],
  ["变电", ["substation"]],
  ["发电", ["generation"]],
  ["变压器", ["transformer"]],
  ["电力变压器", ["power transformer"]],
  ["互感器", ["instrument transformer"]],
  ["电流互感器", ["current transformer"]],
  ["电压互感器", ["voltage transformer"]],
  ["断路器", ["circuit breaker"]],
  ["隔离开关", ["disconnector"]],
  ["熔断器", ["fuse"]],
  ["避雷器", ["surge arrester", "arrester"]],
  ["绝缘子", ["insulator"]],
  ["开关柜", ["switchgear"]],
  ["电缆", ["cable"]],
  ["电力电缆", ["power cable"]],
  ["架空线", ["overhead line"]],
  ["母线", ["busbar"]],
  ["电容器", ["capacitor"]],
  ["电抗器", ["reactor"]],
  ["滤波器", ["filter"]],
  ["静止无功补偿器", ["static var compensator", "svc"]],
  ["无功补偿", ["reactive power compensation"]],
  ["无功功率", ["reactive power"]],
  ["有功功率", ["active power"]],
  ["功率因数", ["power factor"]],
  ["短路", ["short circuit"]],
  ["过电流", ["overcurrent"]],
  ["接地", ["earthing", "grounding"]],
  ["中性点", ["neutral point"]],
  ["绝缘", ["insulation"]],
  ["绝缘配合", ["insulation coordination"]],
  ["局部放电", ["partial discharge"]],
  ["介质损耗", ["dielectric loss"]],
  ["温升", ["temperature rise"]],
  ["继电保护", ["relay protection"]],
  ["保护", ["protection"]],
  ["自动化", ["automation"]],
  ["通信", ["communication"]],
  ["直流", ["direct current", "dc"]],
  ["交流", ["alternating current", "ac"]],
  ["新能源", ["renewable energy"]],
  ["光伏", ["photovoltaic", "pv"]],
  ["风电", ["wind power"]],
  ["储能", ["energy storage"]],
  ["电动汽车", ["electric vehicle", "ev"]],
  ["充电", ["charging"]],
  ["微电网", ["microgrid"]],
  ["并网", ["grid connection"]],
  ["孤岛", ["islanding"]],
  ["分布式", ["distributed"]],
  ["智能电网", ["smart grid"]],
  ["电力电子", ["power electronics"]],
  ["整流", ["rectifier"]],
  ["逆变", ["inverter"]],
  ["变频器", ["converter"]],
  ["换流器", ["converter"]],
  ["换流站", ["converter station"]],
  ["柔性直流", ["flexible dc"]],
  ["直流输电", ["direct current transmission", "hvdc"]],
  ["交流输电", ["alternating current transmission"]],
  ["三相", ["three-phase", "three phase"]],
  ["单相", ["single-phase", "single phase"]],
  ["中性线", ["neutral conductor"]],
  ["保护导体", ["protective conductor"]],
  ["负荷", ["load"]],
  ["用户", ["user", "customer"]],
  ["供电点", ["supply point"]],
  ["电能表", ["electricity meter"]],
  ["计量", ["metering"]],
  ["线损", ["line loss"]],
  ["负荷率", ["load factor"]],
  ["需求响应", ["demand response"]],
  ["频率", ["frequency"]],
  ["工频", ["power frequency"]],
  ["波形", ["waveform"]],
  ["畸变", ["distortion"]],
  ["暂态", ["transient"]],
  ["稳态", ["steady state"]],
  ["噪声", ["noise"]],
  ["干扰", ["interference"]],
  ["采样", ["sampling"]],
  ["精度", ["accuracy"]],
  ["分辨率", ["resolution"]],
  ["时钟", ["clock"]],
  ["同步", ["synchronization"]],
  ["时间同步", ["time synchronization"]],
  ["数据", ["data"]],
  ["模型", ["model"]],
  ["接口", ["interface"]],
  ["协议", ["protocol"]],
  ["实时", ["real-time"]],
  ["可靠性", ["reliability"]],
  ["安全", ["safety"]],
  ["效率", ["efficiency"]],
  ["节能", ["energy saving"]],
  ["环保", ["environmental protection"]],
  ["电力市场", ["electricity market"]],
  ["规划", ["planning"]],
  ["设计", ["design"]],
  ["建设", ["construction"]],
  ["改造", ["retrofit"]],
  ["经济", ["economic"]],
  ["温度", ["temperature"]],
  ["湿度", ["humidity"]],
  ["海拔", ["altitude"]],
  ["地震", ["earthquake"]],
  ["覆冰", ["icing"]],
  ["风荷载", ["wind load"]],
  ["荷载", ["load"]],
  ["结构", ["structure"]],
  ["土建", ["civil engineering"]],
  ["消防", ["fire protection"]],
  ["暖通", ["hvac"]],
  ["给排水", ["water supply and drainage"]],
  ["总图", ["general layout"]],
  ["防雷", ["lightning protection"]],
  ["过电压保护", ["overvoltage protection"]],
  ["消弧线圈", ["arc suppression coil"]],
  ["六氟化硫", ["sulfur hexafluoride", "sf6"]],
  ["真空断路器", ["vacuum circuit breaker"]],
  ["配电自动化", ["distribution automation"]],
  ["用电信息采集", ["electricity consumption information collection"]],
  ["需求侧", ["demand side"]],
  ["电压监测仪", ["voltage monitor"]],
  ["监测装置", ["monitoring device"]],
  ["测量仪器", ["measuring instrument"]],
  ["型式试验", ["type test"]],
  ["例行试验", ["routine test"]],
  ["抽样试验", ["sample test"]],
  ["交接试验", ["handover test"]],
  ["预防性试验", ["preventive test"]],
]);

/** 英文短语（规范化后）→ 中文术语；同义写法合并。 */
const EN_TO_ZH = new Map();
for (const [zh, list] of TERMS) {
  for (const raw of list) {
    const key = normalizeEnglish(raw);
    if (key === "") continue;
    const bucket = EN_TO_ZH.get(key) ?? [];
    if (!bucket.includes(zh)) bucket.push(zh);
    EN_TO_ZH.set(key, bucket);
  }
}

let maxEnglishWords = 1;
for (const key of EN_TO_ZH.keys()) maxEnglishWords = Math.max(maxEnglishWords, key.split(" ").length);

/** 长词优先，保证「电压暂降」先于「电压」覆盖字符区间。 */
const ZH_TERMS = [...TERMS].sort((left, right) => right[0].length - left[0].length);

function normalizeEnglish(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasCjk(value) {
  return CJK_RE.test(String(value ?? ""));
}

/** 中文查询 → 英文检索词（按最长匹配覆盖，避免“电压”重复命中“电压暂降”）。 */
export function englishTermsForChinese(query) {
  const text = String(query ?? "").normalize("NFKC");
  if (!CJK_RE.test(text)) return [];
  const covered = new Uint8Array(text.length);
  const out = [];
  const seen = new Set();
  for (const [zh, list] of ZH_TERMS) {
    if (!text.includes(zh)) continue;
    let start = text.indexOf(zh);
    let matched = false;
    while (start !== -1) {
      const end = start + zh.length;
      let overlap = false;
      for (let index = start; index < end; index += 1) {
        if (covered[index] === 1) {
          overlap = true;
          break;
        }
      }
      if (!overlap) {
        for (let index = start; index < end; index += 1) covered[index] = 1;
        matched = true;
      }
      start = text.indexOf(zh, start + 1);
    }
    if (!matched) continue;
    for (const raw of list) {
      const term = normalizeEnglish(raw);
      if (term !== "" && !seen.has(term)) {
        seen.add(term);
        out.push(term);
      }
    }
    if (out.length >= MAX_TERMS) break;
  }
  return out.slice(0, MAX_TERMS);
}

/** 英文查询 → 中文检索词（按最长英文短语匹配）。 */
export function chineseTermsForEnglish(query) {
  const text = normalizeEnglish(query);
  if (text === "") return [];
  const words = text.split(" ");
  const used = new Uint8Array(words.length);
  const out = [];
  const seen = new Set();
  for (let size = Math.min(maxEnglishWords, words.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      let skip = false;
      for (let index = start; index < start + size; index += 1) {
        if (used[index] === 1) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      const phrase = words.slice(start, start + size).join(" ");
      const list = EN_TO_ZH.get(phrase);
      if (!list) continue;
      for (let index = start; index < start + size; index += 1) used[index] = 1;
      for (const zh of list) {
        if (!seen.has(zh)) {
          seen.add(zh);
          out.push(zh);
        }
      }
      if (out.length >= MAX_TERMS) return out.slice(0, MAX_TERMS);
    }
  }
  return out.slice(0, MAX_TERMS);
}

/**
 * 生成影子检索计划。返回 null 表示不需要/无法安全扩展
 * （纯数字、标准号、含正则元字符或词表未命中）。
 * @returns {{direction:"zh-en"|"en-zh", terms:string[], query:string,
 *   regex:string, note:string}|null}
 */
export function expandBilingualQuery(query) {
  const value = String(query ?? "").trim();
  if (value === "" || REGEX_META_RE.test(value)) return null;
  if (CJK_RE.test(value)) {
    const terms = englishTermsForChinese(value);
    if (terms.length === 0) return null;
    return {
      direction: "zh-en",
      terms,
      query: terms.join(" "),
      regex: terms.map(escapeRegex).join("|"),
      note: `已按中英术语对照补充检索：${terms.slice(0, 4).join("、")}${terms.length > 4 ? "…" : ""}`,
    };
  }
  if (!LATIN_ALL_RE.test(value)) return null;
  const terms = chineseTermsForEnglish(value);
  if (terms.length === 0) return null;
  return {
    direction: "en-zh",
    terms,
    query: terms.join(" "),
    regex: terms.map(escapeRegex).join("|"),
    note: `已按中英术语对照补充检索：${terms.slice(0, 4).join("、")}${terms.length > 4 ? "…" : ""}`,
  };
}

export function isEnglishDoc(doc) {
  const title = String(doc?.title ?? "");
  const cjk = (title.match(CJK_ALL_RE) ?? []).length;
  const latin = (title.match(LATIN_ALL_RE) ?? []).length;
  // 只按标题判定：标题是英文、且不含中文。中文标题的英文原版（人工译名）不在这里
  // 强行归类——它可能只是中文译本，补英文词反而制造噪声。
  if (cjk === 0 && latin >= 4) return true;
  // 只有标准号的标题（如 "IEC 61000-4-30"）：国际标准前缀 + 无中文也算英文来源。
  return cjk === 0 && /^(?:IEC|IEEE|ISO|EN|BS|ANSI|UL|JIS|DIN|CSA)\b/i.test(title);
}

export function isChineseDoc(doc) {
  const title = String(doc?.title ?? "");
  return (title.match(CJK_ALL_RE) ?? []).length >= 2;
}

/**
 * 影子检索的文档集合：只落在另一语言的文档上，避免中文库里零星英文单词
 * 造成大量噪声命中。返回 docId 数组（最多 500 个，FTS IN 查询用）。
 */
export function docIdsForDirection(manifest, direction) {
  const docs = (manifest?.docs ?? []).filter((doc) => doc && doc.status === "ready" && !doc.deletedAt);
  const pick = direction === "en-zh" ? isChineseDoc : isEnglishDoc;
  return docs.filter(pick).map((doc) => doc.id).filter((id) => typeof id === "string" && id !== "").slice(0, 500);
}
