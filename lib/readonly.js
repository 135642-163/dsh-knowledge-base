/** 只读知识库：manifest.readOnly=true 时禁止内容写入；查询/阅读/导出仍可用。 */
export class KbReadOnlyError extends Error {
  constructor(name = "") {
    super(`知识库${name ? `「${name}」` : ""}已设为只读，不能修改内容`);
    this.name = "KbReadOnlyError";
    this.code = "KB_READONLY";
  }
}

export function isReadOnly(manifest) {
  return manifest?.readOnly === true;
}

export function assertKbWritable(manifest, name = manifest?.name ?? "") {
  if (isReadOnly(manifest)) throw new KbReadOnlyError(String(name || manifest?.name || ""));
}
