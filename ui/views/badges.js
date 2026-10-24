/**
 * 库状态徽标：把「导入中 / 有失败」拆成两个独立计数。
 *
 * 详情页把「有失败」渲染成按钮（点进资料 tab 并按 status=failed 过滤）；
 * 总览卡片保持纯展示的 span，避免卡片点击打开库的语义被打断。
 */

/** 导入/失败计数，非法值一律按 0 处理。 */
function count(value) {
  const number = Math.round(Number(value) || 0);
  return number > 0 ? number : 0;
}

/** 成功 X · 导入中 Y · 失败 Z：徽标 hover 就能看到完整拆分。 */
export function statusBadgeTitle(kb) {
  const docs = kb?.docs ?? {};
  return `成功 ${count(docs.ready)} · 导入中 ${count(docs.importing)} · 失败 ${count(docs.failed)}`;
}

/**
 * @param {object} kb 库摘要（含 docs.ready/importing/failed）
 * @param {{interactiveFailed?: boolean}} [options] 详情页传 true，让「有失败」成为筛选按钮
 * @returns {string} 徽标 HTML；只渲染非零项
 */
export function statusBadges(kb, { interactiveFailed = false } = {}) {
  const docs = kb?.docs ?? {};
  const importing = count(docs.importing);
  const failed = count(docs.failed);
  const title = escapeAttr(statusBadgeTitle(kb));
  const badges = [];
  if (importing > 0) {
    badges.push(`<span class="badge accent" title="${title}">导入中 ${importing}</span>`);
  }
  if (failed > 0) {
    badges.push(interactiveFailed
      ? `<button type="button" class="badge warn badge-action" data-action="docs-status" data-docs-status="failed" title="${title}">有失败 ${failed}</button>`
      : `<span class="badge warn" title="${title}">有失败 ${failed}</span>`);
  }
  return badges.join("");
}

function escapeAttr(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}
