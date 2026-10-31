/** 资料编目纯函数：摘要/标签归一化、来源徽标与 PATCH body 构造。 */

export function normalizeDocSummary(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

export function parseDocTagsInput(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[,，、\n]+/);
  const out = [];
  for (const raw of list) {
    const tag = String(raw ?? "").replace(/^#+/, "").trim();
    if (tag === "" || tag.length > 32 || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

export function normalizeStandardNoInput(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function normalizeDocTitleInput(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

export const DOC_TRUST_LEVELS = ["high", "medium", "low", "unknown"];

export function trustLevelLabel(level) {
  return ({ high: "高（现行/正式）", medium: "中（企业/培训/报批）", low: "低（草案/已废止）", unknown: "未标注" })[
    String(level ?? "unknown")
  ] ?? "未标注";
}

export function normalizeDocTrust(value) {
  const level = String(value ?? "").trim().toLowerCase();
  return DOC_TRUST_LEVELS.includes(level) ? level : "unknown";
}

export function summarySourceLabel(source) {
  return ({ manual: "人工", model: "模型", auto: "自动", "": "未编目" })[source] ?? "未编目";
}

export function docMetaPatch({ title, summary, tags, standardNo, trust } = {}) {
  const patch = {};
  if (title !== undefined) patch.title = normalizeDocTitleInput(title);
  if (summary !== undefined) patch.summary = normalizeDocSummary(summary);
  if (tags !== undefined) patch.tags = parseDocTagsInput(tags);
  if (standardNo !== undefined) patch.standardNo = normalizeStandardNoInput(standardNo);
  if (trust !== undefined) patch.trust = normalizeDocTrust(trust);
  return patch;
}

export function docMetaUnchanged(doc, { title, summary, tags, standardNo, trust } = {}) {
  const currentTitle = String(doc?.title ?? "");
  const currentSummary = String(doc?.summary ?? "");
  const currentTags = Array.isArray(doc?.tags) ? doc.tags : [];
  const currentStandardNo = String(doc?.standardNo ?? "");
  const nextTitle = normalizeDocTitleInput(title ?? currentTitle);
  const nextSummary = normalizeDocSummary(summary);
  const nextTags = parseDocTagsInput(tags);
  const nextStandardNo = normalizeStandardNoInput(standardNo ?? currentStandardNo);
  const currentTrust = normalizeDocTrust(doc?.trust);
  const nextTrust = normalizeDocTrust(trust ?? currentTrust);
  return currentTitle === nextTitle
    && currentSummary === nextSummary
    && currentTags.join("\u0000") === nextTags.join("\u0000")
    && currentStandardNo === nextStandardNo
    && currentTrust === nextTrust;
}
