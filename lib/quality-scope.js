/**
 * 质量口径（0.39）：把「机械标记」收敛为「真实待办」。
 *
 * 背景：kb_lint 的判定是纯机械的，两类标记会长期挂着、但并不是资料坏了：
 *  - 文字层损坏页：插件导入时已按页 OCR；修复后的正文可读，标记却留在
 *    corruptedPages 里，导致徽标与质量队列永远是"有坏页"。
 *  - 正文不完整：规则是「正文 <1000 字或条款 <3 且总字数 <5000」。通知、纪要、
 *    编制说明、IEC 修改单天然是短文档，永远命中 partial。
 *
 * 因此：
 *  - 解析阶段把「原来坏、已 OCR 修复」的页写入 repairedPages，corruptedPages
 *    只保留确实没修好的页；
 *  - 正文完整性只在「像正式标准」的资料上计入质量问题：有标准号、非过程稿/
 *    说明材料、且至少 5 页（1–4 页的多为修改单/短文，页数本身不足以判断缺页）。
 *    cover-only（正文不足 200 字）不受此限，任何资料都算问题。
 *
 * 这里只放判定，不写文件、不读磁盘；lint 与质量徽标共用，保证口径一致。
 */
import { parseDocMeta } from "./doc-meta.js";

/** 编制说明/修编说明等过程稿：短是正常的。 */
const ADMIN_STAGES = new Set(["notes", "material"]);

/** 是否过程稿/说明材料（stage 由标题解析或标准号元数据给出）。 */
export function isAdministrativeStage(doc) {
  return ADMIN_STAGES.has(String(doc?.stage ?? ""));
}

/**
 * 是否把这篇资料计入「正文可能不完整」。
 * @param {object} doc 清单条目
 * @param {string} [standardNo] 已由调用方解析出的标准号（lint 传入），省略时回退条目字段/标题解析
 */
export function countsAsIncomplete(doc, standardNo) {
  const integrity = String(doc?.contentIntegrity ?? "");
  // 正文几乎为 0：任何资料都是真问题（空壳 PDF、只解析到封面）。
  if (integrity === "cover-only") return true;
  if (integrity !== "partial") return false;
  if (isAdministrativeStage(doc)) return false;
  const pages = Number(doc?.pages ?? 0);
  if (!Number.isFinite(pages) || pages < 5) return false;
  const resolved = String(standardNo ?? doc?.standardNo ?? "").trim();
  if (resolved) return true;
  const parsed = parseDocMeta(doc?.title ?? "", doc?.rawTitle ?? doc?.title ?? "");
  return String(parsed?.standardNo ?? "").trim() !== "";
}
