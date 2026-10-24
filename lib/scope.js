/**
 * 会话知识库范围语义：校验、懒继承快照、清理、21 工具矩阵解析。
 * 文件 I/O 在 lib/scope-store.js；这里只处理纯数据与工具调用契约。
 */
import { kbDirPath, listKbs, readManifest, sanitizeKbName } from "./store.js";
import { listTrash } from "./kbmeta.js";
import { mutateScopes, readScopes, readScopesSync } from "./scope-store.js";

export const OUT_OF_SCOPE = "KB_OUT_OF_SCOPE";
export const KB_REQUIRED = "KB_REQUIRED";
export const MAX_SCOPE_KBS = 50;
const MAX_SESSION_ID = 200;
const VIRTUAL_DOCS = new Set(["schema", "index", "log"]);
const ALL_SCOPE = Object.freeze({ mode: "all", kbs: [], inheritedFrom: null, stored: false });

export class ScopeError extends Error {
  constructor(message, code = OUT_OF_SCOPE, details) {
    super(message);
    this.name = "ScopeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_SESSION_ID) return null;
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function normalizeScope(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const mode = entry.mode === "selected" ? "selected" : "all";
  const kbs = Array.isArray(entry.kbs)
    ? [...new Set(entry.kbs.map((kb) => (typeof kb === "string" ? kb.trim() : "")).filter(Boolean))]
    : [];
  if (mode === "all" || kbs.length === 0) return { mode: "all", kbs: [], inheritedFrom: null };
  return {
    mode: "selected",
    kbs,
    inheritedFrom: typeof entry.inheritedFrom === "string" && entry.inheritedFrom !== "" ? entry.inheritedFrom : null,
  };
}

/** 从已解析的条目表里解析某个会话的生效范围（不查磁盘、不写盘）。 */
export function lookupScope(scopes, sessionId, parentSession = null) {
  if (!sessionId) return { ...ALL_SCOPE };
  const own = normalizeScope(scopes[sessionId]);
  if (own) return { ...own, stored: true };
  if (parentSession) {
    const parent = normalizeScope(scopes[parentSession]);
    if (parent) return { ...parent, inheritedFrom: parentSession, stored: false };
  }
  return { ...ALL_SCOPE };
}

export function scopeForSessionSync(root, sessionId, parentSession) {
  const data = readScopesSync(root);
  return lookupScope(data.scopes, normalizeSessionId(sessionId), normalizeSessionId(parentSession));
}

async function availableKbNames(root) {
  const entries = await listKbs(root).catch(() => []);
  return new Set(entries.filter((kb) => kb.mergedInto == null).map((kb) => kb.name));
}

function prune(data, { now, ttlMs, available }) {
  let changed = false;
  for (const [sessionId, entry] of Object.entries(data.scopes)) {
    const updatedAt = Date.parse(String(entry?.updatedAt ?? ""));
    if (ttlMs > 0 && Number.isFinite(updatedAt) && now - updatedAt > ttlMs) {
      delete data.scopes[sessionId];
      changed = true;
      continue;
    }
    if (!Array.isArray(entry?.kbs)) continue;
    const next = entry.kbs.filter((kb) => typeof kb === "string" && available.has(kb));
    if (next.length !== entry.kbs.length) {
      entry.kbs = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * 解析会话范围：清理过期/失效条目；子会话无条目时按父条目落一份快照（snapshot=true）。
 * snapshot=false 供 GET 使用：显示父范围但不写子条目。
 */
export async function resolveScope(root, { sessionId, parentSession, ttlDays = 30, snapshot = true } = {}) {
  const session = normalizeSessionId(sessionId);
  if (!session) return { ...ALL_SCOPE };
  const available = await availableKbNames(root);
  const ttlMs = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 86400000 : 0;
  const now = Date.now();
  const parent = normalizeSessionId(parentSession);
  let result = null;
  try {
    await mutateScopes(root, (data) => {
      let changed = prune(data, { now, ttlMs, available });
      const own = normalizeScope(data.scopes[session]);
      if (own) {
        result = { ...own, stored: true };
        return changed;
      }
      if (snapshot && parent) {
        const parentScope = normalizeScope(data.scopes[parent]);
        if (parentScope) {
          data.scopes[session] = {
            mode: parentScope.mode,
            kbs: [...parentScope.kbs],
            updatedAt: new Date(now).toISOString(),
            inheritedFrom: parent,
          };
          result = { ...parentScope, inheritedFrom: parent, stored: true };
          return true;
        }
      }
      if (!snapshot && parent) {
        const parentScope = normalizeScope(data.scopes[parent]);
        if (parentScope) result = { ...parentScope, inheritedFrom: parent, stored: false };
      }
      return changed;
    });
  } catch (error) {
    // 只读磁盘/权限不足：退化为只读解析，不阻塞工具调用（M1 §6.5 的降级策略）
    console.warn("[kb-scope] 范围快照写入失败，按只读解析临时生效：", String(error?.message ?? error));
    const data = await readScopes(root).catch(() => ({ scopes: {} }));
    result = lookupScope(data.scopes, session, parent);
  }
  return result ?? { ...ALL_SCOPE };
}

async function archivedKbNames(root) {
  const entries = await listTrash(root).catch(() => []);
  return new Set(entries.map((entry) => entry.name));
}

/** 写入一个会话的显式范围（胶囊 PUT）。 */
export async function setScope(root, { sessionId, mode, kbs }) {
  const session = normalizeSessionId(sessionId);
  if (!session) throw new ScopeError("会话标识无效（session 必须是 1–200 字符、无控制字符）", "SCOPE_INVALID");
  if (mode !== "all" && mode !== "selected") {
    throw new ScopeError("范围模式无效（mode 必须是 all 或 selected）", "SCOPE_INVALID");
  }
  let wanted;
  try {
    wanted = mode === "all" ? [] : [...new Set((Array.isArray(kbs) ? kbs : []).map((kb) => sanitizeKbName(kb)))];
  } catch (error) {
    throw new ScopeError(`知识库名称无效: ${String(error?.message ?? error)}`, "SCOPE_INVALID");
  }
  if (wanted.length > MAX_SCOPE_KBS) throw new ScopeError(`一次最多选择 ${MAX_SCOPE_KBS} 个知识库`, "SCOPE_INVALID");
  const live = await availableKbNames(root);
  const archived = new Set();
  for (const name of wanted) {
    if (live.has(name)) continue;
    if (archived.size === 0) {
      for (const archivedName of await archivedKbNames(root)) archived.add(archivedName);
    }
    if (archived.has(name)) throw new ScopeError(`知识库已归档: ${name}`, "KB_ARCHIVED");
    throw new ScopeError(`知识库不存在: ${name}`, "KB_NOT_FOUND");
  }
  const effective = mode === "selected" && wanted.length > 0 ? "selected" : "all";
  try {
    await mutateScopes(root, (data) => {
      data.scopes[session] = {
        mode: effective,
        kbs: effective === "selected" ? wanted : [],
        updatedAt: new Date().toISOString(),
        inheritedFrom: null,
      };
      return true;
    });
  } catch (error) {
    if (error?.code === "SCOPE_UNUSABLE") {
      throw new ScopeError(
        "范围文件 .scopes.json 已损坏或过大，无法保存；请备份后删除该文件再重试",
        "SCOPE_WRITE_FAILED",
        { cause: String(error?.message ?? error) }
      );
    }
    throw new ScopeError("范围保存失败，请重试", "SCOPE_WRITE_FAILED", { cause: String(error?.message ?? error) });
  }
  return { mode: effective, kbs: effective === "selected" ? wanted : [], inheritedFrom: null, stored: true };
}

function outOfScopeMessage(scope, requested) {
  return `本会话的知识库范围是「${scope.kbs.join("、")}」，不包含「${requested}」。\n如需使用，请在输入框旁的知识库选择器里调整范围。`;
}

export function assertInScope(scope, name) {
  if (scope.mode !== "selected") return name;
  if (scope.kbs.includes(name)) return name;
  throw new ScopeError(outOfScopeMessage(scope, name), OUT_OF_SCOPE, { scope: [...scope.kbs], requested: name });
}

export async function resolveExecScope(exec, { kbRoot, ttlDays }) {
  const session = exec?.agent?.session;
  return resolveScope(kbRoot, {
    sessionId: session?.id,
    parentSession: session?.header?.parentSession,
    ttlDays,
  });
}

/**
 * 解析出唯一目标库（doc/single/std/kbAdmin 之外的策略）。
 * policy: "single"（默认）| "std"（默认库为「标准」）
 */
export async function resolveSingleKb(exec, requestedKb, { kbRoot, defaultKb, ttlDays }, { policy = "single" } = {}) {
  const scope = await resolveExecScope(exec, { kbRoot, ttlDays });
  const hasRequest = typeof requestedKb === "string" && requestedKb.trim() !== "";
  if (hasRequest) {
    const kb = sanitizeKbName(requestedKb);
    return { scope, kb: assertInScope(scope, kb) };
  }
  const fallback = policy === "std" ? "标准" : defaultKb;
  if (scope.mode !== "selected") return { scope, kb: sanitizeKbName(fallback) };
  if (policy === "std") return { scope, kb: assertInScope(scope, "标准") };
  if (scope.kbs.length === 0) return { scope, kb: sanitizeKbName(defaultKb) };
  if (scope.kbs.length === 1) return { scope, kb: scope.kbs[0] };
  throw new ScopeError(
    `本会话范围有 ${scope.kbs.length} 个知识库，请用 kb 参数指定一个：${scope.kbs.join("、")}`,
    KB_REQUIRED,
    { scope: [...scope.kbs] }
  );
}

/** 单库内按 resolveDoc 的优先级挑候选（跨库解析复用）。 */
function rankDocMatches(manifest, ref) {
  const text = String(ref ?? "").trim();
  const docs = (manifest.docs ?? []).filter((doc) => doc.deletedAt === undefined || doc.deletedAt === null);
  const byId = docs.filter((doc) => doc.id === text);
  if (byId.length === 1) return { exact: true, matches: byId };
  const byPrefix = docs.filter((doc) => doc.id.startsWith(text));
  if (byPrefix.length > 0) return { exact: false, matches: byPrefix };
  const lower = text.toLowerCase();
  const byTitle = docs.filter((doc) => String(doc.title ?? "").toLowerCase() === lower);
  if (byTitle.length > 0) return { exact: true, matches: byTitle };
  return { exact: false, matches: docs.filter((doc) => String(doc.title ?? "").toLowerCase().includes(lower)) };
}

/**
 * doc 类工具的入口：显式 kb 必须在范围内；省略时 selected 且多库 → 跨库解析。
 * 返回 { scope, kb, doc? }。doc 只在跨库解析出唯一命中时给出，其余交给工具自己 resolveDoc。
 */
export async function resolveDocTarget(exec, requestedKb, docRef, { kbRoot, defaultKb, ttlDays }) {
  const scope = await resolveExecScope(exec, { kbRoot, ttlDays });
  const hasRequest = typeof requestedKb === "string" && requestedKb.trim() !== "";
  if (hasRequest) {
    const kb = sanitizeKbName(requestedKb);
    return { scope, kb: assertInScope(scope, kb) };
  }
  const virtual = VIRTUAL_DOCS.has(String(docRef ?? "").trim().toLowerCase());
  if (scope.mode !== "selected") return { scope, kb: sanitizeKbName(defaultKb) };
  if (virtual || scope.kbs.length <= 1) {
    if (scope.kbs.length === 1) return { scope, kb: scope.kbs[0] };
    if (scope.kbs.length === 0) return { scope, kb: sanitizeKbName(defaultKb) };
    throw new ScopeError(
      `本会话范围有 ${scope.kbs.length} 个知识库；「${docRef}」是库级维护文件（schema/index/log），请用 kb 参数指定一个：${scope.kbs.join("、")}`,
      KB_REQUIRED,
      { scope: [...scope.kbs] }
    );
  }
  const exactHits = [];
  const fuzzyHits = [];
  for (const kb of scope.kbs) {
    const manifest = await readManifest(kbDirPath(kbRoot, kb));
    const { exact, matches } = rankDocMatches(manifest, docRef);
    for (const doc of matches) (exact ? exactHits : fuzzyHits).push({ kb, doc });
  }
  const hits = exactHits.length > 0 ? exactHits : fuzzyHits;
  if (hits.length === 1) return { scope, kb: hits[0].kb, doc: hits[0].doc };
  if (hits.length === 0) {
    throw new ScopeError(
      `本会话范围（${scope.kbs.join("、")}）里没有找到「${docRef}」（用 kb_list 查看文档列表）`,
      "KB_NOT_FOUND",
      { scope: [...scope.kbs], requested: docRef }
    );
  }
  const candidates = hits.slice(0, 6).map((hit) => `${hit.kb}/${hit.doc.id}（${hit.doc.title}）`).join("，");
  throw new ScopeError(
    `「${docRef}」在本会话范围内命中多个文档，请指定 kb 或用更精确的标题/id：${candidates}${hits.length > 6 ? " …" : ""}`,
    "KB_AMBIGUOUS",
    { scope: [...scope.kbs], requested: docRef, matches: hits.slice(0, 6).map((hit) => ({ kb: hit.kb, docId: hit.doc.id, title: hit.doc.title })) }
  );
}
