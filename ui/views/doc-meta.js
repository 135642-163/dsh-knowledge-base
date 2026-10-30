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

export function summarySourceLabel(source) {
  return ({ manual: "人工", model: "模型", auto: "自动", "": "未编目" })[source] ?? "未编目";
}

export function docMetaPatch({ title, summary, tags, standardNo } = {}) {
  const patch = {};
  if (title !== undefined) patch.title = normalizeDocTitleInput(title);
  if (summary !== undefined) patch.summary = normalizeDocSummary(summary);
  if (tags !== undefined) patch.tags = parseDocTagsInput(tags);
  if (standardNo !== undefined) patch.standardNo = normalizeStandardNoInput(standardNo);
  return patch;
}

export function docMetaUnchanged(doc, { title, summary, tags, standardNo } = {}) {
  const currentTitle = String(doc?.title ?? "");
  const currentSummary = String(doc?.summary ?? "");
  const currentTags = Array.isArray(doc?.tags) ? doc.tags : [];
  const currentStandardNo = String(doc?.standardNo ?? "");
  const nextTitle = normalizeDocTitleInput(title ?? currentTitle);
  const nextSummary = normalizeDocSummary(summary);
  const nextTags = parseDocTagsInput(tags);
  const nextStandardNo = normalizeStandardNoInput(standardNo ?? currentStandardNo);
  return currentTitle === nextTitle
    && currentSummary === nextSummary
    && currentTags.join("\u0000") === nextTags.join("\u0000")
    && currentStandardNo === nextStandardNo;
}
