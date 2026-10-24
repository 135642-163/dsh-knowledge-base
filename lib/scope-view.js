/**
 * 范围的展示/选择纯函数：无 node 依赖，服务端提示与客户端胶囊共用。
 */

export function chipLabel(scope, { loading = false, failed = false } = {}) {
  if (failed) return "知识库：—";
  if (loading || !scope) return "知识库：…";
  if (scope.mode === "selected" && Array.isArray(scope.kbs) && scope.kbs.length > 0) {
    return `知识库：${scope.kbs.length} 个`;
  }
  return "知识库：全部";
}

/** 提示文本里的库名净化：控制字符与 ASCII 花括号会被宿主提示渲染器当成插值引用。 */
function safeScopeName(name) {
  return String(name)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\{/g, "｛")
    .replace(/\}/g, "｝")
    .replace(/\s+/g, " ")
    .trim();
}

/** 系统提示里的一段范围说明；all 模式返回空串（不注入）。 */
export function scopePromptText(scope) {
  if (!scope || scope.mode !== "selected" || !Array.isArray(scope.kbs) || scope.kbs.length === 0) return "";
  const names = scope.kbs.slice(0, 20).map(safeScopeName).filter(Boolean).join("、");
  const suffix = scope.kbs.length > 20 ? ` 等 ${scope.kbs.length} 个` : "";
  return `[知识库范围] 本会话用户选定：${names}${suffix}。kb_* 工具只能访问这些库；范围外资料不要读取或检索。用户要求其他库时，提示其在输入框旁的知识库选择器里调整范围。`;
}

/** 胶囊“应用”提交：全选/清空都折叠成 mode=all；否则按选中顺序输出。 */
export function selectionPayload(mode, kbs, order = []) {
  const picked = Array.isArray(kbs) ? [...new Set(kbs)] : [];
  if (mode === "all" || picked.length === 0) return { mode: "all", kbs: [] };
  const rank = new Map(order.map((name, index) => [name, index]));
  picked.sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
  return { mode: "selected", kbs: picked };
}

export function isAllSelection(kbs, allNames) {
  const picked = new Set(Array.isArray(kbs) ? kbs : []);
  const names = Array.isArray(allNames) ? allNames : [];
  if (picked.size !== names.length) return false;
  return names.every((name) => picked.has(name));
}
