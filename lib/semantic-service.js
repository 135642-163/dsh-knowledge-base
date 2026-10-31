/**
 * 0.31 语义层装配（Task 4）：把 runtime（模型）、索引（doc-vectors.*）与
 * 单文档 FTS 组合成 `searchAll` 需要的 semantic 通道。
 *
 * 通道契约（lib/search.js 只依赖这几个方法，测试可整体注入假通道）：
 *  - enabled: true
 *  - loadIndex(target) → { ok, fresh, ids, vectors, dim } | { ok:false, reason }
 *  - embedQuery(query) → { ok, vector } | { ok:false, reason }
 *  - locateInDoc(target, docId, query) → FTS 条款行数组（两阶段页码）
 *  - note: 调用方拼进响应 note 的提示（索引构建中等）
 */
import { kbDirPath, listKbs, tryReadManifest } from "./store.js";
import { searchFtsIndex, searchFtsIndexInDocs } from "./fts-index.js";
import {
  DEFAULT_DOC_PROFILE,
  DOC_PROFILE_SUMMARY,
  DOC_PROFILE_WINDOW,
  SEMANTIC_MODEL,
  docVectorsStatus,
  ensureDocVectors,
  normalizeDocProfile,
  readDocVectors,
  startBackgroundVectorBuild,
} from "./semantic-index.js";
import { SEMANTIC_DIM } from "./semantic-runtime.js";

/** 超过这个篇数改走后台进程建索引，当次请求回退 B。 */
export const SEMANTIC_BACKGROUND_DOCS = 100;
/** top-10 中保留 B 的带页码结果数量；其余槽位给语义候选，避免引用页被挤出。 */
export const SEMANTIC_PAGE_GUARD = 8;

function readyDocs(manifest) {
  return (manifest?.docs ?? []).filter((doc) => doc && doc.status === "ready" && !doc.deletedAt);
}

/**
 * 构造一次检索用的语义通道。
 * @param {object} options
 * @param {object} options.runtime createSemanticRuntime()（或测试注入的假 runtime）
 * @param {{kb:string, dir:string, docs:object[]}[]} options.targets 本次检索的库
 * @param {number} [options.backgroundThreshold] 大库阈值（默认 100）
 */
export function createSemanticChannel({
  runtime,
  targets = [],
  backgroundThreshold = SEMANTIC_BACKGROUND_DOCS,
  profile = DEFAULT_DOC_PROFILE,
  pageGuard = SEMANTIC_PAGE_GUARD,
} = {}) {
  const expectedProfile = normalizeDocProfile(profile);
  let note = "";
  return {
    enabled: true,
    profile: expectedProfile,
    pageGuard: Math.max(0, Math.round(Number(pageGuard) || 0)),
    get note() {
      return note;
    },
    async loadIndex(target) {
      const manifest = { docs: target?.docs ?? [] };
      const current = await readDocVectors({ dir: target.dir, manifest, profile: expectedProfile });
      if (current.ok && current.fresh) return current;
      const docs = readyDocs(manifest).length;
      if (docs === 0) return { ok: false, reason: "index_empty" };
      if (docs > backgroundThreshold) {
        const started = await startBackgroundVectorBuild(target.dir, { profile: expectedProfile }).catch(() => ({ started: false }));
        note = started?.started
          ? "语义索引构建中，本次已回退词面检索；稍后重试即可使用语义"
          : "语义索引不可用，已回退词面检索";
        return { ok: false, reason: started?.started ? "index_building" : "index_unavailable" };
      }
      const built = await ensureDocVectors({
        dir: target.dir,
        manifest,
        profile: expectedProfile,
        embedder: async (texts) => {
          const embedded = await runtime.embedDocuments(texts);
          if (!embedded?.ok) throw new Error(embedded?.reason ?? "embed_failed");
          return embedded.vectors;
        },
      });
      if (!built.ok) {
        note = "语义索引构建失败，已回退词面检索";
        return { ok: false, reason: built.reason };
      }
      return readDocVectors({ dir: target.dir, manifest, profile: expectedProfile });
    },
    embedQuery(query) {
      return runtime.embedQuery(query);
    },
    async locateInDoc(target, docId, query) {
      const found = await searchFtsIndex(target.dir, query, { docId, limit: 20 }).catch(() => null);
      return found?.ok ? found.matches : [];
    },
    async locateMany(target, docIds, query) {
      const found = await searchFtsIndexInDocs(target.dir, query, docIds, { limit: 20 }).catch(() => null);
      return found?.ok ? found.rowsByDoc : new Map();
    },
  };
}

/**
 * `/kb/api/status` 的 semantic 字段：只看文件与清单，不加载模型。
 * `indexReady` = 每个非合并库都有与清单一致的索引。
 * @returns {{enabled:boolean,indexReady:boolean,model:string,dim:number,docs:number,
 *   reason:string,kbs:number}}
 */
export async function semanticStatus({ enabled = false, kbRoot = "", dim = SEMANTIC_DIM, profile = DEFAULT_DOC_PROFILE } = {}) {
  const expectedProfile = normalizeDocProfile(profile);
  const base = {
    enabled: enabled === true,
    indexReady: false,
    model: enabled === true ? SEMANTIC_MODEL : "",
    dim: enabled === true ? dim : 0,
    profile: expectedProfile,
    docs: 0,
    readyKbs: 0,
    totalKbs: 0,
    reason: enabled === true ? "" : "disabled",
    kbs: 0,
  };
  if (!base.enabled || kbRoot === "") return base;
  let total = 0;
  let ready = 0;
  let docs = 0;
  let reason = "";
  try {
    for (const entry of await listKbs(kbRoot)) {
      if (entry?.mergedInto) continue;
      const dir = kbDirPath(kbRoot, entry.dir ?? entry.name);
      const manifest = await tryReadManifest(dir);
      if (!manifest) continue;
      // 空库不需要索引；否则一个从未使用的空库会让整个状态永远显示“未就绪”。
      const liveDocs = (manifest.docs ?? []).filter((doc) => doc.status === "ready" && !doc.deletedAt).length;
      if (liveDocs === 0) continue;
      total += 1;
      const status = await docVectorsStatus({
        profile: expectedProfile, dir, manifest });
      if (status.ready) {
        docs += status.docs;
        if (status.fresh) ready += 1;
        else reason ||= "index_stale";
      } else {
        reason ||= status.reason;
      }
    }
  } catch (error) {
    return { ...base, reason: `status_failed: ${String(error?.message ?? error)}` };
  }
  const indexReady = total > 0 && ready === total;
  return {
    ...base,
    indexReady,
    docs,
    readyKbs: ready,
    totalKbs: total,
    kbs: total,
    reason: indexReady ? "" : (ready > 0 ? "partial" : (reason || "index_missing")),
  };
}
