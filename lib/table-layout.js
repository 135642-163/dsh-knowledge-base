/**
 * 本地 OCR 的表格重建（实验）：rapidocr 只给行文本，但带每行的四点框。
 * 用框坐标识别「连续、列对齐、短单元格」的行块，输出 HTML 表格；
 * 其余行保持纯文本，避免把条款段落误当表格。
 *
 * 只对规则表格有效；合并单元格、无线表、跨页表仍建议 kb_view 或云端 OCR。
 */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function boxBounds(box) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const point of Array.isArray(box) ? box : []) {
    const x = Number(point?.[0]);
    const y = Number(point?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  }
  if (!Number.isFinite(x1)) return null;
  return { x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, h: y2 - y1 };
}

/** 规范化并过滤空行，按阅读顺序（上→下、左→右）排序。 */
export function normalizeOcrLines(lines) {
  const out = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = String(line?.text ?? "").replace(/\s+/g, " ").trim();
    const bounds = boxBounds(line?.box);
    if (!text || !bounds || bounds.x2 < 0 || bounds.y2 < 0) continue;
    out.push({ text, ...bounds });
  }
  return out.sort((a, b) => (Math.abs(a.cy - b.cy) > 4 ? a.cy - b.cy : a.x1 - b.x1));
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 按 y 中心聚成行；同一行的多个单元格按 x 排序。 */
export function groupOcrRows(lines) {
  const normalized = normalizeOcrLines(lines);
  if (normalized.length === 0) return [];
  const tolerance = Math.max(6, median(normalized.map((line) => line.h)) * 0.6);
  const rows = [];
  for (const line of normalized) {
    const row = rows.find((item) => Math.abs(item.cy - line.cy) <= tolerance);
    if (row) {
      row.cells.push(line);
      row.cy = row.cells.reduce((sum, cell) => sum + cell.cy, 0) / row.cells.length;
    } else {
      rows.push({ cy: line.cy, cells: [line] });
    }
  }
  rows.sort((a, b) => a.cy - b.cy);
  for (const row of rows) row.cells.sort((a, b) => a.x1 - b.x1);
  return rows;
}

function looksLikeTableRow(row, maxCellChars, maxCells = 30) {
  if (row.cells.length < 2 || row.cells.length > maxCells) return false;
  return row.cells.every((cell) => cell.text.length <= maxCellChars);
}

function columnStarts(rows, tolerance) {
  const clusters = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      const hit = clusters.find((cluster) => Math.abs(cluster.x - cell.x1) <= tolerance);
      if (hit) {
        hit.x = (hit.x * hit.count + cell.x1) / (hit.count + 1);
        hit.count += 1;
      } else {
        clusters.push({ x: cell.x1, count: 1 });
      }
    }
    // 每个单元格只归入一个列：先收集再统一归并，避免同一行两个近邻格被合并
  }
  return clusters.sort((a, b) => a.x - b.x);
}

function alignmentScore(rows, tolerance) {
  const columns = columnStarts(rows, tolerance);
  if (columns.length < 2) return { score: 0, columns: [] };
  let matched = 0;
  let total = 0;
  for (const row of rows) {
    const used = new Set();
    for (const cell of row.cells) {
      total += 1;
      let best = -1;
      let bestDistance = Infinity;
      columns.forEach((column, index) => {
        if (used.has(index)) return;
        const distance = Math.abs(column.x - cell.x1);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      });
      if (best >= 0 && bestDistance <= tolerance) {
        used.add(best);
        matched += 1;
      }
    }
  }
  return { score: total === 0 ? 0 : matched / total, columns };
}

function renderTable(rows, columns) {
  const body = rows.map((row) => {
    const cells = new Array(columns.length).fill("");
    for (const cell of row.cells) {
      let best = 0;
      let bestDistance = Infinity;
      columns.forEach((column, index) => {
        const distance = Math.abs(column - cell.x1);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      });
      cells[best] = cells[best] ? `${cells[best]} ${cell.text}` : cell.text;
    }
    return `<tr>${cells.map((text) => `<td>${escapeHtml(text)}</td>`).join("")}</tr>`;
  }).join("");
  return `<table>${body}</table>`;
}

/**
 * 找连续、列对齐的表格块。
 * @returns {Array<{start:number,end:number,columns:Array}>} 行号区间（含 start，不含 end）
 */
export function findTableBlocks(rows, { maxCellChars = 60, pageWidth = 0 } = {}) {
  const blocks = [];
  // 真实标准表格常有十几列、单元格被拆/合导致每行格数不完全一致；
  // 这里允许格数浮动，只要每格都能对齐到同一组列起点。
  const tolerance = Math.max(18, pageWidth * 0.015);
  let index = 0;
  while (index < rows.length) {
    let end = index;
    while (
      end < rows.length
      && looksLikeTableRow(rows[end], maxCellChars)
    ) {
      end += 1;
    }
    const run = rows.slice(index, end);
    if (run.length >= 3) {
      const { score, columns } = alignmentScore(run, tolerance);
      const coverage = pageWidth > 0
        ? (Math.max(...run.flatMap((row) => row.cells.map((cell) => cell.x2)))
          - Math.min(...run.flatMap((row) => row.cells.map((cell) => cell.x1)))) / pageWidth
        : 1;
      if (columns.length >= 2 && columns.length <= 30 && score >= 0.7 && coverage >= 0.3) {
        blocks.push({ start: index, end, columns: columns.map((column) => column.x) });
      }
    }
    index = end > index ? end : index + 1;
  }
  return blocks;
}

/**
 * 把 OCR 行还原为「正文 + 表格 HTML」。
 * 没有识别到表格时返回 null（调用方保留原纯文本）。
 */
export function ocrTableLayout(lines, { maxCellChars = 40 } = {}) {
  const rows = groupOcrRows(lines);
  if (rows.length < 3) return null;
  const pageWidth = Math.max(0, ...rows.flatMap((row) => row.cells.map((cell) => cell.x2)));
  const blocks = findTableBlocks(rows, { maxCellChars, pageWidth });
  if (blocks.length === 0) return null;
  const parts = [];
  let cursor = 0;
  for (const block of blocks) {
    for (; cursor < block.start; cursor += 1) {
      const text = rows[cursor].cells.map((cell) => cell.text).join(" ");
      if (text) parts.push(text);
    }
    parts.push(renderTable(rows.slice(block.start, block.end), block.columns));
    cursor = block.end;
  }
  for (; cursor < rows.length; cursor += 1) {
    const text = rows[cursor].cells.map((cell) => cell.text).join(" ");
    if (text) parts.push(text);
  }
  return { text: parts.join("\n\n"), tables: blocks.length };
}
