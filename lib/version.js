/**
 * 解析管线版本：解析器或 OCR 行为发生变化时递增。
 * 写入清单后，可据此识别“旧管线产物”，并用 kb_reparse 重跑。
 */
export const PARSER_VERSION = "2026-10-22.2";

/** 插件版本（与 package.json 保持一致；供 web 工作台 /kb/api/status 使用）。 */
export const VERSION = "0.31.7";
