/**
 * 服务端 PDF 连续滚动 viewer：逐页 PNG + 关键词高亮 + 工具栏。
 *
 * 口径（0.28）：
 *  - 页码：显式 page 优先；没有 page 时才用「命中最多的一页」；越界夹取。
 *  - 高亮：每页最多 VIEWER_MAX_MARKS_PER_PAGE 个框，触顶时如实标记 truncated。
 *  - 旋转：rotate 同时作用于页图与高亮（同一旋转矩阵），按钮重载本页。
 *  - 降级：没有文字层（扫描件）或被搜词不存在时给横幅，不静默 0 高亮。
 */
import { readFile } from "node:fs/promises";

export const VIEWER_MAX_TERMS = 8;
export const VIEWER_MAX_MARKS_PER_PAGE = 240;
export const VIEWER_ROTATIONS = Object.freeze([0, 90, 180, 270]);
const TERM_MAX_CHARS = 40;
const PAGE_PNG_DPI = 144;

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function percent(value) {
  return `${(value * 100).toFixed(3)}%`;
}

/** `"电压|电压| 谐波 "` 或数组 → 去重（大小写不敏感）、2–40 字、最多 8 个。 */
export function normalizeViewerTerms(input) {
  const list = Array.isArray(input) ? input : String(input ?? "").split("|");
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const term = String(raw ?? "").trim().slice(0, TERM_MAX_CHARS);
    if (term.length < 2) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= VIEWER_MAX_TERMS) break;
  }
  return out;
}

/** 解析 page 参数：缺省/非法/小于 1 → null（= 自动选页）。 */
export function parseViewerPage(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 1 ? rounded : null;
}

export function clampViewerPage(page, total) {
  const limit = Math.max(1, Math.round(Number(total) || 1));
  const value = Math.round(Number(page) || 1);
  return Math.min(limit, Math.max(1, value));
}

/** 0/90/180/270（含负值与字符串），其余回落 0。 */
export function normalizeRotate(value) {
  const number = Math.round(Number(value) || 0);
  const normalized = ((number % 360) + 360) % 360;
  return VIEWER_ROTATIONS.includes(normalized) ? normalized : 0;
}

/** 显式页码优先；否则命中最多的页；都没有则第 1 页。 */
export function resolveStartPage({ requested = null, total = 1, pageHits = new Map() } = {}) {
  if (Number.isInteger(requested) && requested > 0) return clampViewerPage(requested, total);
  if (pageHits instanceof Map && pageHits.size > 0) {
    return [...pageHits.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
  }
  return 1;
}

/** 与 mupdf `Matrix.rotate(deg)` 同向的顺时针旋转：90 → (x,y)=(-y,x)。 */
export function rotatePoint(x, y, rotate) {
  switch (normalizeRotate(rotate)) {
    case 90: return [-y, x];
    case 180: return [-x, -y];
    case 270: return [y, -x];
    default: return [x, y];
  }
}

/** 页面框旋转后覆盖的区域（mupdf 的 pixmap 以它为原点）。 */
export function rotatedBounds(bounds, rotate) {
  const [x0, y0, x1, y1] = bounds;
  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]
    .map(([x, y]) => rotatePoint(x, y, rotate));
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    minX,
    minY,
    width: Math.max(1e-6, Math.max(...xs) - minX),
    height: Math.max(1e-6, Math.max(...ys) - minY),
  };
}

/** PDF quad（8 个坐标）→ 旋转后页面上的百分比框。 */
export function transformQuad(quad, bounds, rotate) {
  const box = rotatedBounds(bounds, rotate);
  const points = [];
  const values = Array.isArray(quad) ? quad.flat(Infinity).map(Number) : [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    points.push(rotatePoint(values[i], values[i + 1], rotate));
  }
  if (points.length === 0) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  if (!(x1 > x0 && y1 > y0)) return null;
  return {
    left: (x0 - box.minX) / box.width,
    top: (y0 - box.minY) / box.height,
    width: (x1 - x0) / box.width,
    height: (y1 - y0) / box.height,
  };
}

function flattenQuads(input, out = []) {
  if (!Array.isArray(input)) return out;
  if (input.length > 0 && typeof input[0] === "number") {
    out.push(input);
    return out;
  }
  for (const item of input) flattenQuads(item, out);
  return out;
}

/** 一页的 quad 集合 → 高亮框 + 是否触顶（供渲染与单测复用）。 */
export function collectPageMarks({ quads = [], bounds = [0, 0, 1, 1], rotate = 0, cap = VIEWER_MAX_MARKS_PER_PAGE } = {}) {
  const limit = Math.max(1, Math.round(Number(cap) || VIEWER_MAX_MARKS_PER_PAGE));
  const marks = [];
  let truncated = false;
  for (const quad of flattenQuads(quads)) {
    const box = transformQuad(quad, bounds, rotate);
    if (!box) continue;
    if (marks.length >= limit) {
      truncated = true;
      break;
    }
    marks.push(box);
  }
  return { marks, truncated };
}

export function hitsLabel({ hits = 0, truncated = false } = {}) {
  const count = Math.max(0, Math.round(Number(hits) || 0));
  if (count === 0) return "";
  return truncated
    ? `高亮 ${count} 处（每页最多 ${VIEWER_MAX_MARKS_PER_PAGE} 处，已截断）`
    : `高亮 ${count} 处`;
}

/**
 * 渲染整份 viewer HTML。
 * @param {{pdfPath:string,title:string,page?:number|null,terms?:string[]|string,rotate?:number}} input
 * @returns {Promise<{html:string,total:number,hits:number,truncated:boolean,start:number,
 *                    hasTextLayer:boolean,requestedPage:number|null,rotate:number,terms:string[],firstHitPage:number|null}>}
 */
export async function renderPdfViewerHtml({ pdfPath, title, page = null, terms = [], rotate = 0 }) {
  const data = await readFile(pdfPath);
  const { default: mupdf } = await import("mupdf");
  const doc = mupdf.Document.openDocument(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), "application/pdf");
  const cleanTerms = normalizeViewerTerms(terms);
  const rotation = normalizeRotate(rotate);
  const requestedPage = parseViewerPage(page);
  let total = 1;
  let hits = 0;
  let truncated = false;
  let hasTextLayer = false;
  const pageHits = new Map();
  const pages = [];
  try {
    total = Math.max(1, doc.countPages());
    const samplePages = new Set([0, Math.min(total - 1, (requestedPage ?? 1) - 1), total - 1]);
    for (let i = 0; i < total; i += 1) {
      const pdfPage = doc.loadPage(i);
      const bounds = pdfPage.getBounds();
      if (samplePages.has(i) && !hasTextLayer) {
        try {
          hasTextLayer = String(pdfPage.toStructuredText("preserve-whitespace").asText() ?? "").trim() !== "";
        } catch {
          /* 取不到文字层就当作没有 */
        }
      }
      const quads = [];
      for (const term of cleanTerms) {
        try {
          quads.push(pdfPage.search(term) ?? []);
        } catch {
          /* 单个词检索失败不影响其它词 */
        }
      }
      const collected = collectPageMarks({ quads, bounds, rotate: rotation });
      if (collected.truncated) truncated = true;
      hits += collected.marks.length;
      if (collected.marks.length > 0) pageHits.set(i + 1, collected.marks.length);
      const marks = collected.marks
        .map((mark) => `<span class="hl" style="left:${percent(mark.left)};top:${percent(mark.top)};width:${percent(mark.width)};height:${percent(mark.height)}"></span>`)
        .join("");
      pages.push(`<figure class="page" id="p${i + 1}"><div class="canvas"><img loading="lazy" src="page.png?page=${i + 1}&amp;dpi=${PAGE_PNG_DPI}&amp;rotate=${rotation}" alt="${escapeHtml(title)} 第 ${i + 1} 页">${marks}</div><figcaption>第 ${i + 1} / ${total} 页</figcaption></figure>`);
    }
  } finally {
    try { doc.destroy(); } catch { /* ignore */ }
  }
  const start = resolveStartPage({ requested: requestedPage, total, pageHits });
  const firstHitPage = pageHits.size > 0
    ? [...pageHits.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0]
    : null;
  const showFirstHit = firstHitPage !== null && firstHitPage !== start;
  const notice = buildNotice({ terms: cleanTerms, hits, hasTextLayer });
  const nextRotate = (rotation + 90) % 360;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
:root{--zoom:1;--bg:#2b2b2f;--bar:#252528;--fg:#eee;--muted:#aaa}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:13px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
#toolbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;height:44px;padding:0 12px;background:var(--bar);border-bottom:1px solid #111;box-shadow:0 2px 8px #0004;white-space:nowrap;overflow:hidden}
#toolbar .title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:#fff}
.tb{display:flex;align-items:center;gap:4px;color:var(--muted)}
.tb button,.tb a{min-width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:5px;background:transparent;color:var(--fg);font:inherit;cursor:pointer;text-decoration:none;padding:0 5px}
.tb button:hover,.tb a:hover{background:#ffffff22}
#pageno{width:38px;height:24px;text-align:center;border:1px solid #ffffff44;border-radius:4px;background:#111;color:#fff;font:inherit}
#hits{color:#ffd34d;font-size:12px}
#firsthit{color:#ffd34d;border:1px solid #ffd34d66!important}
#notice{padding:8px 12px;background:#3a2f10;color:#ffd34d;font-size:12px;line-height:1.5;border-bottom:1px solid #111}
.pages{display:flex;flex-direction:column;align-items:center;gap:14px;padding:14px 10px 40px}
.page{width:calc(min(1100px,100%) * var(--zoom));max-width:none;margin:0;background:#fff;box-shadow:0 4px 20px #0006;scroll-margin-top:54px}
.canvas{position:relative;background:#fff;line-height:0}
.canvas img{display:block;width:100%;height:auto;aspect-ratio:.707;background:#fff}
.hl{position:absolute;z-index:2;background:rgba(255,214,0,.42);border:1px solid rgba(255,166,0,.75);border-radius:2px;pointer-events:none}
.page figcaption{position:relative;z-index:3;margin-top:-24px;margin-left:8px;padding:2px 6px;width:max-content;background:#0008;color:#fff;font-size:11px;border-radius:4px;line-height:1.4}
</style><header id="toolbar"><span class="title">${escapeHtml(title)}</span><span class="tb"><button type="button" id="prev" title="上一页">‹</button><input id="pageno" value="${start}" aria-label="页码"><span>/ ${total}</span><button type="button" id="next" title="下一页">›</button></span><span class="tb"><button type="button" id="zoomout" title="缩小">−</button><span id="zoomlabel">100%</span><button type="button" id="zoomin" title="放大">+</button></span><span class="tb"><button type="button" id="rotate" title="旋转 90°">↻</button>${showFirstHit ? '<button type="button" id="firsthit" title="跳到第一个命中">首个命中</button>' : ""}<a href="../source" download title="下载原件">↓</a><button type="button" id="print" title="打印">⎙</button></span><span id="hits">${escapeHtml(hitsLabel({ hits, truncated }))}</span></header>${notice ? `<div id="notice">${escapeHtml(notice)}</div>` : ""}<main class="pages">${pages.join("")}</main><script>
(function(){
  var start=${start},total=${total},zoom=1,current=start,nextRotate=${nextRotate},firstHit=${firstHitPage ?? 0};
  var pages=[].slice.call(document.querySelectorAll(".page"));
  function go(n,behavior){n=Math.max(1,Math.min(total,Math.round(n)||1));current=n;var el=document.getElementById("p"+n);if(el)el.scrollIntoView({block:"start",behavior:behavior||"auto"});var inp=document.getElementById("pageno");if(inp)inp.value=n;}
  function setZoom(z){zoom=Math.max(.5,Math.min(2.5,z));document.documentElement.style.setProperty("--zoom",zoom);document.getElementById("zoomlabel").textContent=Math.round(zoom*100)+"%";}
  document.getElementById("prev").onclick=function(){go(current-1,"smooth")};
  document.getElementById("next").onclick=function(){go(current+1,"smooth")};
  document.getElementById("zoomin").onclick=function(){setZoom(zoom+.1)};
  document.getElementById("zoomout").onclick=function(){setZoom(zoom-.1)};
  document.getElementById("rotate").onclick=function(){var q=new URLSearchParams(location.search);q.set("page",String(current));q.set("rotate",String(nextRotate));location.search=q.toString();};
  document.getElementById("print").onclick=function(){window.print()};
  var firstHitBtn=document.getElementById("firsthit");if(firstHitBtn&&firstHit){firstHitBtn.onclick=function(){go(firstHit,"smooth")};}
  document.getElementById("pageno").addEventListener("change",function(e){go(Number(e.target.value))});
  var ticking=false;
  window.addEventListener("scroll",function(){if(ticking)return;ticking=true;requestAnimationFrame(function(){ticking=false;var y=54;var best=current;for(var i=0;i<pages.length;i++){var r=pages[i].getBoundingClientRect();if(r.top<=y)best=i+1;}if(best!==current){current=best;document.getElementById("pageno").value=current;}})},{passive:true});
  setTimeout(function(){go(start)},60);
})();
</script>`;
  return {
    html,
    total,
    hits,
    truncated,
    start,
    hasTextLayer,
    requestedPage,
    rotate: rotation,
    terms: cleanTerms,
    firstHitPage,
  };
}

function buildNotice({ terms, hits, hasTextLayer }) {
  const hasTerms = Array.isArray(terms) && terms.length > 0;
  if (!hasTerms) {
    // 没有检索词时也提示扫描件：否则用户会以为「检索能命中、原件却什么也没有」是 bug。
    return hasTextLayer
      ? ""
      : "该资料是扫描件（原件没有文字层），页面上不会显示关键词高亮；检索到的文字来自 OCR/解析文本，可按页码定位。";
  }
  if (hits > 0) return "";
  if (!hasTextLayer) {
    return "该原件没有文字层（扫描件），无法在页面上高亮；检索到的文字来自 OCR/解析文本，可按页码定位。";
  }
  return "未在原件中找到这些关键词（可能在其它页，或原件用词与检索词不同）。";
}
