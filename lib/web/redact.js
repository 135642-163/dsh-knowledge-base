/**
 * 面向客户端文本的路径净化：注册表只做 key 白名单，内容净化由调用方负责。
 */
export function redactPaths(text, prefixes = []) {
  let out = String(text ?? "");
  for (const prefix of prefixes) {
    if (!prefix) continue;
    out = out.split(String(prefix)).join("<path>");
  }
  return out;
}
