/**
 * 统一的 KB zip 导出选项。
 *
 * `zip64: true` 允许单成员/整包超过 4GB（JSZip 默认在 4GB 边界报错）；
 * 小包仍按普通 zip 结构写，读取端（JSZip / 内置 zip-reader）都支持 ZIP64。
 */
export function zipStreamOptions() {
  return { streamFiles: true, compression: "DEFLATE", zip64: true };
}
