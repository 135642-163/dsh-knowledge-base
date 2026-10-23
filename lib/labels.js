/**
 * 文档类型的中文标签（列表、索引、导出共用）。
 * 单独成模块是为了让 store.js / wiki.js / index.js 都能引用而不产生循环依赖。
 */
export const TYPE_LABELS = {
  docx: "Word",
  pptx: "PPT",
  xlsx: "Excel",
  "pdf-text": "PDF(文字版)",
  "pdf-scanned": "PDF(扫描版)",
  "pdf-mixed": "PDF(混合)",
  markdown: "Markdown",
  text: "文本",
  epub: "EPUB",
  mobi: "电子书(MOBI)",
  note: "笔记",
  skipped: "已跳过",
};

export function typeLabel(type) {
  return TYPE_LABELS[type] ?? String(type ?? "");
}

/** 笔记 kind 的中文标签。 */
export const NOTE_KIND_LABELS = {
  note: "笔记",
  summary: "摘要页",
  entity: "实体页",
  concept: "概念页",
  topic: "专题页",
};

export function noteKindLabel(kind) {
  return NOTE_KIND_LABELS[kind] ?? "笔记";
}

/** 可信度标签。 */
export const TRUST_LABELS = {
  high: "高",
  medium: "中",
  low: "低",
  unknown: "未标注",
};

export const TRUST_LEVELS = ["high", "medium", "low", "unknown"];

export function trustLabel(trust) {
  return TRUST_LABELS[trust] ?? "未标注";
}
