/**
 * Word OMML 公式 → LaTeX（常用结构；复杂公式降级为可读文本）。
 *
 * 思路：mammoth 不解析 OMML。先把 document.xml 里的 oMath/oMathPara
 * 换成 ⟦MATHn⟧ 占位 run，mammoth 转成 markdown 后按原位恢复为
 * $...$（行内）或 $$...$$（独立公式）。这样公式不会丢，也不会破坏正文顺序。
 */
let parserPromise;
async function getParser() {
  parserPromise ??= import("fast-xml-parser").then(({ XMLParser }) => {
    return new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      trimValues: false,
      parseTagValue: false,
      parseAttributeValue: false,
      removeNSPrefix: true,
    });
  });
  return parserPromise;
}

const SYMBOLS = {
  "×": "\\times ",
  "÷": "\\div ",
  "±": "\\pm ",
  "∓": "\\mp ",
  "≤": "\\leq ",
  "≥": "\\geq ",
  "≠": "\\neq ",
  "≈": "\\approx ",
  "≡": "\\equiv ",
  "∞": "\\infty ",
  "∑": "\\sum ",
  "∏": "\\prod ",
  "∫": "\\int ",
  "∮": "\\oint ",
  "√": "\\sqrt{}",
  "→": "\\to ",
  "←": "\\leftarrow ",
  "↔": "\\leftrightarrow ",
  "∈": "\\in ",
  "∉": "\\notin ",
  "⊂": "\\subset ",
  "⊃": "\\supset ",
  "∂": "\\partial ",
  "∇": "\\nabla ",
  "∠": "\\angle ",
  "°": "^{\\circ}",
  "α": "\\alpha ",
  "β": "\\beta ",
  "γ": "\\gamma ",
  "δ": "\\delta ",
  "ε": "\\varepsilon ",
  "θ": "\\theta ",
  "λ": "\\lambda ",
  "μ": "\\mu ",
  "π": "\\pi ",
  "ρ": "\\rho ",
  "σ": "\\sigma ",
  "τ": "\\tau ",
  "φ": "\\varphi ",
  "ω": "\\omega ",
  "Δ": "\\Delta ",
  "Ω": "\\Omega ",
};

function escapeMathText(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\backslash ")
    .replace(/([{}_^%&#$])/g, "\\$1");
}

function textToLatex(text) {
  const value = String(text ?? "");
  if (value.length === 0) return "";
  if (/[\u4e00-\u9fff]/.test(value)) {
    return `\\text{${value.replace(/[{}]/g, "\\$&")}}`;
  }
  let out = "";
  for (const ch of value) {
    out += SYMBOLS[ch] ?? escapeMathText(ch);
  }
  return out;
}

function list(node) {
  return Array.isArray(node) ? node : node === undefined ? [] : [node];
}

function attr(node, name) {
  return node?.[`@_${name}`];
}

function renderChild(key, value) {
  if (key === "f") {
    const f = value ?? {};
    return `\\frac{${renderNode(f.num)}}{${renderNode(f.den)}}`;
  }
  if (key === "sSup") {
    const x = value ?? {};
    return `{${renderNode(x.e)}}^{${renderNode(x.sup)}}`;
  }
  if (key === "sSub") {
    const x = value ?? {};
    return `{${renderNode(x.e)}}_{${renderNode(x.sub)}}`;
  }
  if (key === "sSubSup") {
    const x = value ?? {};
    return `{${renderNode(x.e)}}_{${renderNode(x.sub)}}^{${renderNode(x.sup)}}`;
  }
  if (key === "rad") {
    const r = value ?? {};
    const deg = renderNode(r.deg).trim();
    return deg ? `\\sqrt[${deg}]{${renderNode(r.e)}}` : `\\sqrt{${renderNode(r.e)}}`;
  }
  if (key === "d") {
    const d = value ?? {};
    const beg = attr(d.dPr?.begChr, "val") ?? "(";
    const end = attr(d.dPr?.endChr, "val") ?? ")";
    const wrap = (ch) =>
      ch === "{" ? "\\{" : ch === "}" ? "\\}" : ch === "⟨" ? "\\langle" : ch === "⟩" ? "\\rangle" : ch;
    return `\\left${wrap(beg)}${renderNode(d.e)}\\right${wrap(end)}`;
  }
  if (key === "nary") {
    const n = value ?? {};
    const chr = attr(n.naryPr?.chr, "val") ?? "∑";
    const op =
      { "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∮": "\\oint", "⋃": "\\bigcup", "⋂": "\\bigcap" }[chr] ??
      "\\sum";
    const sub = n.sub ? `_{${renderNode(n.sub)}}` : "";
    const sup = n.sup ? `^{${renderNode(n.sup)}}` : "";
    return `${op}${sub}${sup} ${renderNode(n.e)}`;
  }
  if (key === "func") {
    const f = value ?? {};
    const name = renderNode(f.fName).trim();
    const commands = {
      sin: "\\sin",
      cos: "\\cos",
      tan: "\\tan",
      cot: "\\cot",
      log: "\\log",
      ln: "\\ln",
      exp: "\\exp",
      lim: "\\lim",
      max: "\\max",
      min: "\\min",
      sup: "\\sup",
      inf: "\\inf",
    };
    const cmd = commands[name] ?? (name ? `\\operatorname{${name}}` : "");
    return `${cmd}\\left(${renderNode(f.e)}\\right)`;
  }
  if (key === "limLow") {
    const l = value ?? {};
    const base = renderNode(l.e);
    return base.includes("lim") ? `\\lim_{${renderNode(l.lim)}}` : `\\underset{${renderNode(l.lim)}}{${base}}`;
  }
  if (key === "limUpp") {
    const l = value ?? {};
    return `\\overset{${renderNode(l.lim)}}{${renderNode(l.e)}}`;
  }
  if (key === "m") {
    const rows = list(value?.mr).map((mr) => list(mr.e).map(renderNode).join(" & "));
    return `\\begin{matrix} ${rows.join(" \\\\ ")} \\end{matrix}`;
  }
  if (key === "eqArr") {
    const rows = list(value?.e).map(renderNode);
    return `\\begin{aligned} ${rows.join(" \\\\ ")} \\end{aligned}`;
  }
  if (key === "acc") {
    const a = value ?? {};
    const chr = attr(a.accPr?.chr, "val") ?? "^";
    const cmd = { "^": "\\hat", "¯": "\\bar", "→": "\\vec", "~": "\\tilde", "˙": "\\dot", "¨": "\\ddot" }[chr] ?? "\\hat";
    return `${cmd}{${renderNode(a.e)}}`;
  }
  if (key === "bar") return `\\overline{${renderNode(value?.e)}}`;
  if (key === "groupChr") {
    const g = value ?? {};
    const chr = attr(g.groupChrPr?.chr, "val") ?? "";
    const inner = renderNode(g.e);
    return attr(g.groupChrPr, "pos") === "top"
      ? `\\overbrace{${inner}}^{${escapeMathText(chr)}}`
      : `\\underbrace{${inner}}_{${escapeMathText(chr)}}`;
  }
  if (key === "box") return renderNode(value?.e);
  if (key === "borderBox") return renderNode(value?.e);
  if (key === "phant") return renderNode(value?.e);
  return renderNode(value);
}

function renderNode(node) {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return textToLatex(node);
  }
  if (Array.isArray(node)) return node.map(renderNode).join("");
  if (typeof node !== "object") return "";

  const contentKeys = Object.keys(node).filter(
    (key) => !key.startsWith("@_") && key !== "#text" && !key.endsWith("Pr")
  );
  // 纯文本节点（m:t）
  if (contentKeys.length === 0 && node["#text"] !== undefined) {
    return textToLatex(node["#text"]);
  }

  let out = "";
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_") || key === "#text" || key.endsWith("Pr")) continue;
    out += renderChild(key, value);
  }
  return out;
}

/** 把单个 OMML 片段（<m:oMath> 或 <m:oMathPara>）转为 LaTeX。 */
export async function ommlToLatex(fragment) {
  const parser = await getParser();
  const doc = parser.parse(`<root>${fragment}</root>`);
  const root = doc?.root ?? {};
  const latex = renderNode(root.oMathPara ?? root.oMath ?? root).trim();
  return { latex, ok: latex.length > 0 };
}

function findElementRanges(xml, localName) {
  const openRe = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}(?=[\\s/>])`, "g");
  const closeRe = new RegExp(`</(?:[A-Za-z0-9_.-]+:)?${localName}\\s*>`, "g");
  const ranges = [];
  let last = 0;
  for (;;) {
    openRe.lastIndex = last;
    const open = openRe.exec(xml);
    if (!open) break;
    const start = open.index;
    const openEnd = xml.indexOf(">", start);
    if (openEnd < 0) break;
    if (xml.slice(start, openEnd + 1).endsWith("/>")) {
      ranges.push({ start, end: openEnd + 1 });
      last = openEnd + 1;
      continue;
    }
    closeRe.lastIndex = openEnd + 1;
    const close = closeRe.exec(xml);
    if (!close) break;
    ranges.push({ start, end: close.index + close[0].length });
    last = close.index + close[0].length;
  }
  return ranges;
}

async function replaceElements(xml, localName, replacer) {
  const ranges = findElementRanges(xml, localName);
  if (ranges.length === 0) return { xml, count: 0 };
  let out = "";
  let last = 0;
  for (const range of ranges) {
    out += xml.slice(last, range.start);
    out += await replacer(xml.slice(range.start, range.end));
    last = range.end;
  }
  out += xml.slice(last);
  return { xml: out, count: ranges.length };
}

function formulaPlainText(fragment) {
  return String(fragment)
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-zA-Z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 预处理 docx：把 OMML 换成占位 run，返回新 buffer 与公式表。
 * 无 OMML 时原样返回（避免无谓重打包）。
 */
export async function preprocessDocxMath(buffer) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) return { buffer, formulas: [], warnings: [] };
  const original = await docFile.async("string");
  if (!/<(?:[A-Za-z0-9_.-]+:)?oMath(?=[\s/>])/.test(original)) {
    return { buffer, formulas: [], warnings: [] };
  }

  const formulas = [];
  const addFormula = async (fragment, display) => {
    const id = formulas.length;
    let latex = "";
    let ok = false;
    try {
      const r = await ommlToLatex(fragment);
      latex = r.latex;
      ok = r.ok;
    } catch {
      /* fall through */
    }
    if (!latex) {
      latex = formulaPlainText(fragment) || "[公式]";
      ok = false;
    }
    formulas.push({ id, display, latex, ok });
    return `⟦${display ? "D" : "I"}MATH${id}⟧`;
  };

  let xml = original;
  const para = await replaceElements(xml, "oMathPara", async (fragment) => {
    const marker = await addFormula(fragment, true);
    return `<w:r><w:t xml:space="preserve">${marker}</w:t></w:r>`;
  });
  xml = para.xml;
  const inline = await replaceElements(xml, "oMath", async (fragment) => {
    const marker = await addFormula(fragment, false);
    return `<w:r><w:t xml:space="preserve">${marker}</w:t></w:r>`;
  });
  xml = inline.xml;

  if (formulas.length === 0) {
    return { buffer, formulas: [], warnings: [] };
  }
  zip.file("word/document.xml", xml);
  const out = await zip.generateAsync({ type: "nodebuffer" });
  const failed = formulas.filter((f) => !f.ok).length;
  const warnings = [
    `docx 含 ${formulas.length} 个公式，已转换为 LaTeX；复杂公式可能不完整，建议对照原 Word 文件核对`,
  ];
  if (failed > 0) warnings.push(`其中 ${failed} 个公式转换不完整，已保留可读文本/占位`);
  return { buffer: out, formulas, warnings };
}

/** 把 mammoth markdown 里的占位符恢复为 LaTeX。 */
export function restoreMathMarkers(markdown, formulas) {
  let out = String(markdown ?? "");
  for (const f of formulas ?? []) {
    const token = `⟦${f.display ? "D" : "I"}MATH${f.id}⟧`;
    const latex = f.latex || "[公式]";
    if (f.display) {
      const lineRe = new RegExp(`^[ \\t]*${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "gm");
      if (lineRe.test(out)) {
        // 用函数替换，避免 String.replace 把 $$ 当成转义（会退化成单 $）
        out = out.replace(lineRe, () => `\n\n$$\n${latex}\n$$\n\n`);
        continue;
      }
      out = out.split(token).join(`$$${latex}$$`);
    } else {
      out = out.split(token).join(`$${latex}$`);
    }
  }
  return out;
}
