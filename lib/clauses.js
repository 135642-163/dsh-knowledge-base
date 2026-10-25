/**
 * 条款级分块（FTS5 索引的输入层；不改变 markdown/parts）。
 * 输入合并版 markdown，输出可索引的 {clause,heading,text,pageStart,pageEnd,lineStart,lineEnd}。
 */
const PAGE_RE = /^#{1,6}\s*第\s*(\d+)\s*页\s*$/;
const CLAUSE_RE = /^#{0,6}\s*(\d+(?:\.\d+){1,5})\s+(\S.*)$/;
const SECTION_RE = /^#{0,6}\s*(第\s*[一二三四五六七八九十百0-9]+\s*[章节篇])\s*(.*)$/;
const APPENDIX_RE = /^#{0,6}\s*([A-Z](?:\.\d+)*)\s+(\S.+)$/;

function splitLongText(text, maxChars) {
  const value = String(text ?? "").trim();
  if (value.length <= maxChars) return [value];
  const pieces = [];
  let rest = value;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cut = Math.max(window.lastIndexOf("。"), window.lastIndexOf("；"), window.lastIndexOf("\n"));
    const end = cut >= maxChars * 0.5 ? cut + 1 : maxChars;
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * @param {string} markdown 合并版正文
 * @param {{docId?:string,maxChars?:number}} options
 * @returns {Array<{docId:string,clause:string,heading:string,text:string,pageStart:number|null,pageEnd:number|null,lineStart:number,lineEnd:number}>}
 */
export function splitClauses(markdown, { docId = "", maxChars = 800 } = {}) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const clauses = [];
  let page = null;
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.text.join("\n").trim();
    if (text || current.heading) {
      for (const piece of splitLongText(text || current.heading, maxChars)) {
        clauses.push({
          docId,
          clause: current.clause,
          heading: current.heading,
          text: piece,
          pageStart: current.pageStart,
          pageEnd: current.pageEnd ?? current.pageStart,
          lineStart: current.lineStart,
          lineEnd: current.lineEnd,
        });
      }
    }
    current = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const pageMatch = PAGE_RE.exec(line.trim());
    if (pageMatch) {
      page = Number(pageMatch[1]);
      continue;
    }
    const clauseMatch = CLAUSE_RE.exec(line) ?? SECTION_RE.exec(line) ?? APPENDIX_RE.exec(line);
    if (clauseMatch) {
      flush();
      current = {
        clause: String(clauseMatch[1] ?? "").trim(),
        heading: String(clauseMatch[2] ?? "").trim(),
        text: [],
        pageStart: page,
        pageEnd: page,
        lineStart: i + 1,
        lineEnd: i + 1,
      };
      continue;
    }
    if (!current) continue;
    if (line.trim()) current.text.push(line.trim());
    current.pageEnd = page ?? current.pageEnd;
    current.lineEnd = i + 1;
  }
  flush();
  return clauses;
}
