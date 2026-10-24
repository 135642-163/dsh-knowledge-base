/**
 * 临时/锁文件识别（无依赖）：导入管线、上传校验与 kb_lint 共用。
 *
 * 规则（大小写不敏感，只看文件名本身，不看目录）：
 *  - `~$` 前缀：Office 所有者/锁文件（如 `~$节 试验作用.docx`）；
 *  - `.~lock.` 前缀：LibreOffice 锁文件；
 *  - `thumbs.db` / `desktop.ini` / `.ds_store`：操作系统垃圾文件；
 *  - `.tmp` 结尾**仅在同时带 `~$` 前缀时**算临时文件；普通 `.tmp` 不跳过。
 */

/** 人类可读的规则列表；README / UI 文案可引用。 */
export const TEMP_FILE_PATTERNS = Object.freeze([
  "~$*（Office 所有者/锁文件）",
  ".~lock.*（LibreOffice 锁文件）",
  "Thumbs.db / desktop.ini / .DS_Store（操作系统垃圾文件）",
  "~$*.tmp（Office 临时文件；普通 .tmp 不算）",
]);

/** 一行说明。 */
export const TEMP_FILE_DESCRIPTION =
  "Office 所有者文件（~$ 前缀）、LibreOffice 锁文件（.~lock. 前缀）与系统垃圾文件" +
  "（Thumbs.db / desktop.ini / .DS_Store），大小写不敏感，只按文件名匹配。";

/** 取路径最后一段（兼容 / 与 \），无依赖。 */
function baseName(name) {
  const value = String(name ?? "");
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1];
}

/**
 * 文件名是否为临时/锁文件。传完整路径时按 basename 判断，
 * 因此 `~$目录/正常资料.md` 不会因为上级目录名被跳过。
 * @param {string} name 文件名或路径
 * @returns {boolean}
 */
export function isTempFileName(name) {
  const base = baseName(name).toLowerCase();
  if (base === "") return false;
  // `~$` 覆盖 Word 所有者文件以及 `~$xxx.tmp`；单独的 .tmp 不在本规则内。
  if (base.startsWith("~$")) return true;
  if (base.startsWith(".~lock.")) return true;
  return base === "thumbs.db" || base === "desktop.ini" || base === ".ds_store";
}
