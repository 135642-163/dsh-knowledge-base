/**
 * 知识库列表的可见性规则（工作台与会话范围选择器共用）。
 *
 * 空 `default` 库是插件的默认落库目标：工具仍可使用它，但用户没有建库意图时
 * 不应该出现在列表里制造噪声。只要其中已有资料/笔记/回收站内容，就照常显示。
 */

/** 在用文档数：ready + importing + failed + deleted + notes；兼容数字与对象两种清单形态。 */
export function kbLiveDocs(kb) {
  const docs = kb?.docs;
  if (typeof docs === "number") return Number.isFinite(docs) ? docs : 0;
  if (!docs || typeof docs !== "object") return 0;
  return ["ready", "importing", "failed", "deleted", "notes"]
    .reduce((sum, key) => sum + (Number(docs[key]) || 0), 0);
}

/** 是否进入列表：空 default 隐藏；其余（包括其它空库）保留，供用户主动管理。 */
export function isListedKb(kb) {
  if (!kb) return false;
  if (String(kb.name ?? "") !== "default") return true;
  return kbLiveDocs(kb) > 0;
}

export function visibleKbs(list) {
  return (Array.isArray(list) ? list : []).filter(isListedKb);
}

/**
 * 把服务端 scope 收敛到当前可见库：范围里只剩被隐藏的空 default 时，
 * 胶囊显示「未启用」而不是「1 个」；其余隐藏库同理剔除。
 */
export function normalizeScope(scope, list) {
  if (!scope || scope.mode !== "selected") return scope;
  const names = new Set((Array.isArray(list) ? list : []).map((kb) => kb?.dir ?? kb?.name));
  const kept = (Array.isArray(scope.kbs) ? scope.kbs : []).filter((name) => names.has(name));
  return kept.length === 0 ? { ...scope, mode: "none", kbs: [] } : { ...scope, kbs: kept };
}
