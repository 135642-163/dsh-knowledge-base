/** 服务端 PDF 连续滚动 viewer：逐页 PNG + 关键词高亮 + 工具栏。 */
import { readFile } from "node:fs/promises";

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function renderPdfViewerHtml({ pdfPath, title, page = 1, terms = [] }) {
  const data = await readFile(pdfPath);
  const { default: mupdf } = await import("mupdf");
  const doc = mupdf.Document.openDocument(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), "application/pdf");
  const cleanTerms = [...new Set((terms ?? []).map((t) => String(t).trim().slice(0, 40)).filter((t) => t.length >= 2))].slice(0, 8);
  let total = 1;
  let hitCount = 0;
  const pages = [];
  const hitPages = new Set();
  const pageHits = new Map();
  try {
    total = Math.max(1, doc.countPages());
    for (let i = 0; i < total; i += 1) {
      const p = doc.loadPage(i);
      const bounds = p.getBounds();
      const width = Math.max(1, bounds[2] - bounds[0]);
      const height = Math.max(1, bounds[3] - bounds[1]);
      const marks = [];
      for (const term of cleanTerms) {
        let hits = [];
        try {
          hits = p.search(term) ?? [];
        } catch {
          hits = [];
        }
        for (const item of hits) {
          const quad = Array.isArray(item) && item.length === 1 && Array.isArray(item[0]) ? item[0] : item;
          if (!quad || typeof quad.length !== "number" || quad.length < 8) continue;
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          const ys = [quad[1], quad[3], quad[5], quad[7]];
          const x0 = Math.min(...xs);
          const x1 = Math.max(...xs);
          const y0 = Math.min(...ys);
          const y1 = Math.max(...ys);
          if (!(x1 > x0 && y1 > y0)) continue;
          marks.push(`<span class="hl" style="left:${((x0 - bounds[0]) / width * 100).toFixed(3)}%;top:${((y0 - bounds[1]) / height * 100).toFixed(3)}%;width:${((x1 - x0) / width * 100).toFixed(3)}%;height:${((y1 - y0) / height * 100).toFixed(3)}%"></span>`);
          hitCount += 1;
          hitPages.add(i + 1);
          pageHits.set(i + 1, (pageHits.get(i + 1) ?? 0) + 1);
          if (marks.length >= 240) break;
        }
        if (marks.length >= 240) break;
      }
      pages.push(`<figure class="page" id="p${i + 1}"><div class="canvas"><img loading="lazy" src="page.png?page=${i + 1}&amp;dpi=144" alt="${escapeHtml(title)} 第 ${i + 1} 页">${marks.join("")}</div><figcaption>第 ${i + 1} / ${total} 页</figcaption></figure>`);
    }
  } finally {
    try { doc.destroy(); } catch { /* ignore */ }
  }
  const requested = Math.min(total, Math.max(1, Math.round(Number(page) || 1)));
  // 页码不可靠时选命中数最多的页作为初始页；高亮会覆盖全部命中。
  const start = pageHits.size > 0
    ? [...pageHits.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
    : requested;
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
.pages{display:flex;flex-direction:column;align-items:center;gap:14px;padding:14px 10px 40px}
.page{width:calc(min(1100px,100%) * var(--zoom));max-width:none;margin:0;background:#fff;box-shadow:0 4px 20px #0006;scroll-margin-top:54px}
.canvas{position:relative;background:#fff;line-height:0}
.canvas img{display:block;width:100%;height:auto;aspect-ratio:.707;background:#fff}
.hl{position:absolute;z-index:2;background:rgba(255,214,0,.42);border:1px solid rgba(255,166,0,.75);border-radius:2px;pointer-events:none}
.page figcaption{position:relative;z-index:3;margin-top:-24px;margin-left:8px;padding:2px 6px;width:max-content;background:#0008;color:#fff;font-size:11px;border-radius:4px;line-height:1.4}
.rotate .canvas img{transform:rotate(90deg);transform-origin:center;width:100%}
</style><header id="toolbar"><span class="title">${escapeHtml(title)}</span><span class="tb"><button type="button" id="prev" title="上一页">‹</button><input id="pageno" value="${start}" aria-label="页码"><span>/ ${total}</span><button type="button" id="next" title="下一页">›</button></span><span class="tb"><button type="button" id="zoomout" title="缩小">−</button><span id="zoomlabel">100%</span><button type="button" id="zoomin" title="放大">+</button></span><span class="tb"><button type="button" id="rotate" title="旋转">↻</button><a href="../source" download title="下载原件">↓</a><button type="button" id="print" title="打印">⎙</button></span><span id="hits">${hitCount > 0 ? `高亮 ${hitCount} 处` : ""}</span></header><main class="pages">${pages.join("")}</main><script>
(function(){
  var start=${start},total=${total},zoom=1,current=start;
  var pages=[].slice.call(document.querySelectorAll(".page"));
  function go(n,behavior){n=Math.max(1,Math.min(total,Math.round(n)||1));current=n;var el=document.getElementById("p"+n);if(el)el.scrollIntoView({block:"start",behavior:behavior||"auto"});var inp=document.getElementById("pageno");if(inp)inp.value=n;}
  function setZoom(z){zoom=Math.max(.5,Math.min(2.5,z));document.documentElement.style.setProperty("--zoom",zoom);document.getElementById("zoomlabel").textContent=Math.round(zoom*100)+"%";}
  document.getElementById("prev").onclick=function(){go(current-1,"smooth")};
  document.getElementById("next").onclick=function(){go(current+1,"smooth")};
  document.getElementById("zoomin").onclick=function(){setZoom(zoom+.1)};
  document.getElementById("zoomout").onclick=function(){setZoom(zoom-.1)};
  document.getElementById("rotate").onclick=function(){document.body.classList.toggle("rotate")};
  document.getElementById("print").onclick=function(){window.print()};
  document.getElementById("pageno").addEventListener("change",function(e){go(Number(e.target.value))});
  var ticking=false;
  window.addEventListener("scroll",function(){if(ticking)return;ticking=true;requestAnimationFrame(function(){ticking=false;var y=54;var best=current;for(var i=0;i<pages.length;i++){var r=pages[i].getBoundingClientRect();if(r.top<=y)best=i+1;}if(best!==current){current=best;document.getElementById("pageno").value=current;}})},{passive:true});
  setTimeout(function(){go(start)},60);
})();
</script>`;
  return { html, total, hits: hitCount, start };
}
