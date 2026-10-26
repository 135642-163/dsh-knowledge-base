import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ComponentType } from "react";
import { chipLabel, selectionPayload } from "../../lib/scope-view.js";
import { dedupeSources, sourceHref, sourceLabel } from "../../ui/sources-view.js";
import type { KbSource } from "../../ui/sources-view.js";

export const inject = ["slots"];

type KbProps = { wide?: boolean };
type Scope = { mode: "all" | "selected" | "none"; kbs: string[]; inheritedFrom?: string | null };
type KbDocs = { total?: number; deleted?: number };
type KbSummary = {
  name: string;
  dir?: string;
  description?: string;
  docs?: number | KbDocs;
  mergedInto?: string | null;
};
type ScopeSlotProps = { sessionId?: string };
type SlotDeclaration = {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  select?: (owner: any) => unknown;
};
type SlotContext = {
  slots: {
    inject(name: string, callback: () => void): void;
    register(declaration: SlotDeclaration, component: ComponentType<any>): void;
  };
};
type Phase = "loading" | "ready" | "failed" | "hidden";
type PanelPhase = "loading" | "ready";
type PanelPosition = {
  left: number | string;
  bottom?: number;
  top?: number;
  maxHeight?: number;
  transform?: string;
};
type ScopeData = { scope: Scope; kbs: KbSummary[] };
type Toast = { text: string; id: number };

const API = "/kb/api";
const CSS_ID = "dsh-knowledge-wiki/sidebar-entry.css";
const PANEL_MAX_HEIGHT = 420;
const FALLBACK_PANEL_POSITION: PanelPosition = { left: "50%", bottom: 24, transform: "translateX(-50%)" };
const CSS = `
.dsh-kb-entry { box-sizing: border-box; display: flex; flex: 1 1 0; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 36px; margin: 8px 2px 0; padding: 7px 8px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; text-align: left; text-decoration: none; cursor: pointer; }
.dsh-kb-entry:hover, .dsh-kb-entry-active { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-kb-entry:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe)); outline-offset: -2px; }
.dsh-kb-entry svg { flex: none; }
.dsh-kb-entry-collapsed { flex: 0 0 auto; width: 36px; height: 36px; min-height: 36px; justify-content: center; margin: 8px 0 0; padding: 0; }
.dsh-kb-entry-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-kb-modal-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 24px; background: rgba(0, 0, 0, 0.55); }
.dsh-kb-modal { display: flex; flex-direction: column; width: min(1180px, 100%); height: min(860px, 100%); overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff)); color: var(--dsw-alias-label-primary, #111); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.4); }
.dsh-kb-modal-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 44px; padding: 0 10px 0 16px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); font-size: 14px; font-weight: 600; }
.dsh-kb-modal-close { width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #666); font-size: 20px; line-height: 1; cursor: pointer; }
.dsh-kb-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary, #111); }
.dsh-kb-modal-frame { flex: 1; width: 100%; border: 0; background: #fff; }
.dsh-kb-scope-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 190px; height: 24px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #666); font: inherit; font-size: 12px; line-height: 24px; cursor: pointer; }
.dsh-kb-scope-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary, #111); }
.dsh-kb-scope-chip-active { color: var(--dsw-alias-state-business-primary, #4d6bfe); }
.dsh-kb-scope-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-kb-scope-panel { position: fixed; z-index: 1200; display: flex; flex-direction: column; width: 320px; max-height: 420px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #111); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35); }
.dsh-kb-scope-head { padding: 10px 12px 6px; font-size: 13px; font-weight: 600; }
.dsh-kb-scope-search { height: 28px; margin: 0 12px 8px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 12px; }
.dsh-kb-scope-list { flex: 1; overflow: auto; padding: 0 6px 6px; }
.dsh-kb-scope-row { display: flex; align-items: center; gap: 8px; padding: 6px; border-radius: 8px; font-size: 12px; cursor: pointer; }
.dsh-kb-scope-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-kb-scope-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-kb-scope-meta { flex: none; color: var(--dsw-alias-label-tertiary, #999); font-size: 11px; }
.dsh-kb-scope-empty { padding: 18px 12px; text-align: center; color: var(--dsw-alias-label-secondary, #666); font-size: 12px; }
.dsh-kb-scope-actions { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); font-size: 12px; }
.dsh-kb-scope-actions button { padding: 5px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, #111); font: inherit; font-size: 12px; cursor: pointer; }
.dsh-kb-scope-actions button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-kb-scope-primary { background: var(--dsw-alias-state-business-primary, #4d6bfe) !important; color: #fff !important; }
.dsh-kb-scope-primary:disabled { opacity: 0.5; cursor: default; }
.dsh-kb-scope-link { margin-left: auto; color: var(--dsw-alias-label-secondary, #666) !important; }
.dsh-kb-scope-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 1300; padding: 6px 12px; border-radius: 999px; background: rgba(0, 0, 0, 0.78); color: #fff; font-size: 12px; }
.dsh-kb-source-row { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius: 8px; margin: 4px 0; font-size: 12px; }
.dsh-kb-source-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-kb-source-title { font-weight: 600; color: var(--dsw-alias-label-primary, #111); }
.dsh-kb-source-meta { color: var(--dsw-alias-label-tertiary, #888); font-size: 11px; }
.dsh-kb-source-toggle { border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-state-business-primary, #4d6bfe); font: inherit; font-size: 12px; cursor: pointer; padding: 2px 6px; }
.dsh-kb-source-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-kb-sources-list { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.dsh-kb-source-link { display: flex; flex-direction: column; gap: 2px; padding: 5px 7px; border-radius: 7px; color: var(--dsw-alias-label-primary, #111); text-decoration: none; }
.dsh-kb-source-link:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-kb-source-snippet { color: var(--dsw-alias-label-secondary, #666); font-size: 11px; line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.dsh-kb-source-card { display: flex; flex-direction: column; gap: 3px; padding: 7px 9px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); border-radius: 8px; color: var(--dsw-alias-label-primary, #111); text-decoration: none; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.04)); }
.dsh-kb-source-card:hover { border-color: var(--dsw-alias-state-business-primary, #4d6bfe); }
.dsh-kb-source-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.dsh-kb-source-card-title { font-weight: 600; line-height: 1.4; }
.dsh-kb-source-card-page { flex: none; color: var(--dsw-alias-state-business-primary, #4d6bfe); font-size: 11px; white-space: nowrap; }
.dsh-kb-source-card-open { color: var(--dsw-alias-label-tertiary, #888); font-size: 11px; }
.dsh-kb-citation-action { border: 0; background: transparent; color: var(--dsw-alias-label-tertiary, #777); font: inherit; font-size: 12px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.dsh-kb-citation-action:hover { color: var(--dsw-alias-state-business-primary, #4d6bfe); background: var(--dsw-alias-interactive-bg-hover); }
.dsh-kb-source-flash { outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe); outline-offset: 2px; }
.dsh-kb-preview-backdrop { position: fixed; inset: 0; z-index: 1400; display: grid; place-items: center; padding: 18px; background: rgba(0,0,0,.55); }
.dsh-kb-preview { display: flex; flex-direction: column; width: min(1120px, 94vw); height: min(90vh, 900px); overflow: hidden; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #111); box-shadow: 0 24px 80px rgba(0,0,0,.4); }
.dsh-kb-preview-head { flex: none; display: flex; align-items: center; gap: 10px; min-height: 42px; padding: 0 8px 0 14px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); font-size: 13px; font-weight: 600; }
.dsh-kb-preview-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-kb-preview-page { flex: none; color: var(--dsw-alias-state-business-primary, #4d6bfe); font-size: 12px; font-weight: 400; }
.dsh-kb-preview-close { flex: none; width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #666); font-size: 20px; cursor: pointer; }
.dsh-kb-preview-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary, #111); }
.dsh-kb-preview-body { flex: 1; min-height: 0; display: grid; place-items: center; background: var(--dsw-alias-bg-layer-2, #f5f5f7); color: var(--dsw-alias-label-secondary, #666); font-size: 13px; }
.dsh-kb-preview-frame { width: 100%; height: 100%; border: 0; background: #fff; }
.dsh-kb-preview-pages { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 100%; padding: 8px; box-sizing: border-box; }
.dsh-kb-preview-image { flex: 1; min-height: 0; max-width: 100%; object-fit: contain; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.12); }
.dsh-kb-preview-nav { flex: none; display: flex; align-items: center; gap: 10px; color: var(--dsw-alias-label-secondary, #666); font-size: 12px; }
.dsh-kb-preview-nav button { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius: 6px; background: transparent; color: inherit; font: inherit; padding: 3px 9px; cursor: pointer; }
.dsh-kb-preview-nav button:disabled { opacity: .4; cursor: default; }
.dsh-kb-sources-turn { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); border-radius: 10px; padding: 8px 10px; margin: 8px 0; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #111); font-size: 12px; }
.dsh-kb-sources-turn h4 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
`;

function ensureCss() {
  if (typeof document === "undefined") return;
  const selector = `style[data-plugin-css="${CSS_ID}"]`;
  if (document.querySelector(selector) !== null) return;
  const style = document.createElement("style");
  style.dataset.pluginCss = CSS_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function DatabaseIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** 库身份＝目录名（范围条目用它）；清单 name 只做显示名。 */
function kbIdentity(kb: KbSummary): string {
  return kb.dir ?? kb.name;
}

/** 事件目标是否落在容器内；测试运行时没有 DOM contains，退化为同一节点。 */
function isInside(container: Element | null, target: Node): boolean {
  if (!container) return false;
  if (container === target) return true;
  return typeof container.contains === "function" && container.contains(target);
}

/** 文档数徽标：软删除的文档不算“在用”，避免只剩删除项的库显示 N 篇。 */
function docsBadge(kb: KbSummary): string {
  const docs = kb.docs;
  const total = typeof docs === "number" ? docs : docs?.total ?? 0;
  const deleted = typeof docs === "number" ? 0 : docs?.deleted ?? 0;
  const live = Math.max(0, total - deleted);
  return live === 0 ? "空库" : `${live} 篇`;
}

function WorkbenchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="dsh-kb-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dsh-kb-modal" role="dialog" aria-modal="true" aria-label="知识库工作台">
        <div className="dsh-kb-modal-head">
          <span>知识库工作台</span>
          <button type="button" className="dsh-kb-modal-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <iframe className="dsh-kb-modal-frame" src="/kb/?embed=1" title="知识库工作台" />
      </div>
    </div>,
    document.body
  );
}

/** 侧栏入口 + 工作台弹窗。 */
export function KbWorkbenchAction({ wide = false }: KbProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`dsh-kb-entry${wide ? "" : " dsh-kb-entry-collapsed"}${open ? " dsh-kb-entry-active" : ""}`}
        title="知识库工作台"
        aria-label="知识库工作台"
        aria-pressed={open}
        onClick={() => setOpen(true)}
      >
        <DatabaseIcon />
        {wide ? <span className="dsh-kb-entry-label">知识库</span> : null}
      </button>
      <WorkbenchModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function KbScopeCapsule({ sessionId }: ScopeSlotProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [panelPhase, setPanelPhase] = useState<PanelPhase>("loading");
  const [scope, setScope] = useState<Scope | null>(null);
  const [kbs, setKbs] = useState<KbSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [retry, setRetry] = useState(0);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const generationRef = useRef(0);
  const inflightRef = useRef<{ sessionId: string; promise: Promise<ScopeData> } | null>(null);
  const toastIdRef = useRef(0);
  // 点击外部后的延迟还焦点：浏览器的默认聚焦动作发生在事件之后，同步 focus 会被覆盖。
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearFocusTimer() {
    if (focusTimerRef.current === null) return;
    clearTimeout(focusTimerRef.current);
    focusTimerRef.current = null;
  }

  function showToast(text: string) {
    toastIdRef.current += 1;
    setToast({ text, id: toastIdRef.current });
  }

  /** 单飞：同一会话共享同一个进行中的 scope+kbs 请求。 */
  function loadScopeData(sid: string): Promise<ScopeData> {
    if (inflightRef.current?.sessionId === sid) return inflightRef.current.promise;
    const promise = (async () => {
      const [scopeResponse, kbsResponse] = await Promise.all([
        getJson<{ scope: Scope }>(`/scope?session=${encodeURIComponent(sid)}`),
        getJson<{ kbs: KbSummary[] }>("/kbs"),
      ]);
      return {
        scope: scopeResponse.scope,
        kbs: (kbsResponse.kbs ?? []).filter((kb) => kb.mergedInto == null),
      };
    })();
    inflightRef.current = { sessionId: sid, promise };
    const clear = () => {
      if (inflightRef.current?.promise === promise) inflightRef.current = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!sessionId) {
        setPhase("hidden");
        return;
      }
      setPhase("loading");
      let status;
      try {
        status = await getJson<{ features?: { scope?: boolean } }>("/status");
      } catch {
        // 没有工作台/没有 webServer：静默不渲染
        if (!cancelled) setPhase("hidden");
        return;
      }
      if (cancelled) return;
      if (status.features?.scope !== true) {
        setPhase("hidden");
        return;
      }
      try {
        const data = await loadScopeData(sessionId);
        if (cancelled) return;
        setScope(data.scope);
        setKbs(data.kbs);
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("failed");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, retry]);

  useEffect(() => {
    // 会话切换（宿主要在原地换 sessionId）时作废旧会话在途的打开刷新结果。
    generationRef.current += 1;
  }, [sessionId]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast?.id]);

  useEffect(() => {
    // 重新打开面板时丢掉还没执行的外部点击还焦点，避免它把焦点从面板抢回胶囊。
    if (open) clearFocusTimer();
  }, [open]);

  useEffect(() => () => {
    // 卸载后不能再去 focus 已经不在文档里的胶囊。
    clearFocusTimer();
  }, []);

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeScopePanel(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event?.target as Node | null;
      if (target && isInside(panelRef.current, target)) return;
      if (target && isInside(chipRef.current, target)) return;
      // 与相邻的权限/模型选择 popover 一致：点击外部立即关闭面板并丢弃草稿，不提交。
      // 焦点不能同步还给胶囊——浏览器在处理完 pointerdown 后还会执行这次点击的默认
      // 聚焦动作（例如聚焦被点中的元素），同步 focus 会被它覆盖。等本次事件结束
      // （setTimeout 0）再聚焦，面板关闭本身仍然是即时的。
      closeScopePanel(false);
      clearFocusTimer();
      focusTimerRef.current = setTimeout(() => {
        focusTimerRef.current = null;
        chipRef.current?.focus();
      }, 0);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function place() {
      const rect = chipRef.current?.getBoundingClientRect();
      if (!rect) {
        setPosition(null);
        return;
      }
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 328));
      // 上方空间不够（胶囊贴近顶部）就向下展开，避免面板被视口顶部裁掉；
      // 两个方向都用 maxHeight 限制到实际可用空间。
      if (rect.top - 8 >= 240) {
        setPosition({
          left,
          bottom: Math.max(8, window.innerHeight - rect.top + 8),
          maxHeight: Math.min(PANEL_MAX_HEIGHT, rect.top - 16),
        });
        return;
      }
      setPosition({
        left,
        top: Math.round(rect.bottom + 8),
        maxHeight: Math.min(PANEL_MAX_HEIGHT, Math.max(160, window.innerHeight - rect.bottom - 16)),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const identities = kbs.map(kbIdentity);
  const label = chipLabel(scope, { loading: phase === "loading", failed: phase === "failed" });
  const active = phase === "ready" && scope?.mode === "selected";
  const filtered = query.trim() === ""
    ? kbs
    : kbs.filter((kb) => `${kb.name} ${kb.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  // 面板真实可见（已挂载）才对外声明 expanded，加载阶段面板并不存在。
  const panelVisible = open && phase === "ready" && panelPhase === "ready";

  if (phase === "hidden") return null;

  function closeScopePanel(restoreFocus: boolean) {
    if (restoreFocus) clearFocusTimer();
    setOpen(false);
    setPosition(null);
    if (restoreFocus) chipRef.current?.focus();
  }

  function openWorkbench() {
    closeScopePanel(false);
    setWorkbenchOpen(true);
  }

  async function openPanel() {
    if (!sessionId) return;
    clearFocusTimer();
    const gen = ++generationRef.current;
    setPanelPhase("loading");
    setQuery("");
    try {
      const data = await loadScopeData(sessionId);
      if (gen !== generationRef.current) return;
      const freshIdentities = data.kbs.map(kbIdentity);
      setScope(data.scope);
      setKbs(data.kbs);
      setDraft(
        data.scope.mode === "none"
          ? []
          : data.scope.mode === "selected"
            ? (data.scope.kbs ?? []).filter((name) => freshIdentities.includes(name))
            : [...freshIdentities]
      );
      setPanelPhase("ready");
    } catch {
      if (gen !== generationRef.current) return;
      closeScopePanel(false);
      setPhase("failed");
    }
  }

  function toggleOpen() {
    if (saving) return;
    if (open) {
      closeScopePanel(false);
      return;
    }
    if (phase === "failed") {
      setRetry((value) => value + 1);
      return;
    }
    if (phase !== "ready") return;
    setOpen(true);
    void openPanel();
  }

  async function applySelection() {
    if (!sessionId || saving) return;
    const picked = draft.filter((name) => identities.includes(name));
    // 一个都没选 = 关闭本会话知识库；全选 = 全部；其余按列表顺序提交 selected。
    const payload = selectionPayload(picked, identities);
    // 先递增代号：PUT 期间返回的旧 GET 响应不能再覆盖已应用的范围。
    generationRef.current += 1;
    setSaving(true);
    try {
      const response = await fetch(`${API}/scope`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-kb-ui": "1" },
        body: JSON.stringify({ session: sessionId, ...payload }),
      });
      const data = (await response.json().catch(() => null)) as
        | { scope?: Scope; error?: { message?: string } }
        | null;
      if (!response.ok) throw new Error(data?.error?.message || "范围保存失败，请重试");
      if (!data?.scope) throw new Error("范围保存失败，请重试");
      setScope(data.scope);
      closeScopePanel(true);
      showToast(
        data.scope.mode === "selected"
          ? `已限定为 ${data.scope.kbs.length} 个知识库`
          : data.scope.mode === "none"
            ? "已关闭本会话的知识库"
            : "已改为全部知识库"
      );
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "范围保存失败，请重试";
      showToast(message);
    } finally {
      setSaving(false);
    }
  }

  const panel = panelVisible ? createPortal(
    <div
      ref={panelRef}
      className="dsh-kb-scope-panel"
      role="dialog"
      aria-label="选择本会话知识库"
      style={position ?? FALLBACK_PANEL_POSITION}
    >
      <div className="dsh-kb-scope-head">本会话使用哪些知识库？</div>
      <input
        className="dsh-kb-scope-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索知识库"
        aria-label="搜索知识库"
        autoFocus
      />
      <div className="dsh-kb-scope-list">
        {filtered.length === 0 ? (
          <div className="dsh-kb-scope-empty">
            <div>{kbs.length === 0 ? "暂无知识库" : "没有匹配的知识库"}</div>
            {kbs.length === 0 ? (
              <button
                type="button"
                className="dsh-kb-scope-link"
                disabled={saving}
                onClick={openWorkbench}
              >
                去工作台新建
              </button>
            ) : null}
          </div>
        ) : (
          filtered.map((kb) => {
            const identity = kbIdentity(kb);
            return (
              <label key={identity} className="dsh-kb-scope-row">
                <input
                  type="checkbox"
                  checked={draft.includes(identity)}
                  disabled={saving}
                  onChange={() => setDraft((current) => (
                    current.includes(identity) ? current.filter((name) => name !== identity) : [...current, identity]
                  ))}
                />
                <span className="dsh-kb-scope-name">{kb.name}</span>
                <span className="dsh-kb-scope-meta">{docsBadge(kb)}</span>
              </label>
            );
          })
        )}
      </div>
      <div className="dsh-kb-scope-actions">
        <button type="button" disabled={saving} onClick={() => setDraft([...identities])}>全选</button>
        <button type="button" disabled={saving} onClick={() => setDraft([])}>清空</button>
        <button type="button" disabled={saving} onClick={() => closeScopePanel(true)}>取消</button>
        <button type="button" className="dsh-kb-scope-primary" disabled={saving} onClick={() => void applySelection()}>
          应用
        </button>
        <button type="button" className="dsh-kb-scope-link" disabled={saving} onClick={openWorkbench}>
          打开知识库工作台
        </button>
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`dsh-kb-scope-chip${active ? " dsh-kb-scope-chip-active" : ""}`}
        aria-expanded={panelVisible}
        aria-label={label}
        title={phase === "failed" ? "知识库：点击重试" : label}
        onClick={toggleOpen}
      >
        <DatabaseIcon size={14} />
        <span className="dsh-kb-scope-label">{label}</span>
      </button>
      {panel}
      {toast && typeof document !== "undefined"
        ? createPortal(
            <div className="dsh-kb-scope-toast" role="status" aria-live="polite">{toast.text}</div>,
            document.body
          )
        : null}
      <WorkbenchModal open={workbenchOpen} onClose={() => setWorkbenchOpen(false)} />
    </>
  );
}

type ToolSourceRowProps = {
  toolName?: string;
  phase?: "preparing" | "start" | "result";
  block?: { meta?: { sources?: unknown }; isError?: boolean } | null;
  useDisclosure?: () => { expanded: boolean; toggle: () => void };
};

type TurnTailProps = {
  turn?: unknown;
  seq?: number;
  matched?: { turn?: unknown };
  useChat?: (selector: (snapshot: any) => unknown) => unknown;
};

function sourcesOfBlock(block: ToolSourceRowProps["block"]): KbSource[] {
  const raw = block?.meta?.sources;
  if (!Array.isArray(raw)) return [];
  return dedupeSources(raw as KbSource[], 20);
}

function sourcePreviewBase(source: KbSource) {
  return `${API}/kbs/${encodeURIComponent(source.kb ?? "")}/docs/${encodeURIComponent(source.docId)}`;
}

function sourcePageLabel(source: KbSource): string {
  const page = source.page;
  return typeof page === "number" && Number.isInteger(page) && page > 0 ? `第 ${page} 页` : "";
}

async function sourcePreviewData(source: KbSource): Promise<{
  mode: "viewer" | "frame";
  url: string;
  page?: number;
  totalPages?: number;
}> {
  const base = sourcePreviewBase(source);
  let detail: any = null;
  try {
    const response = await fetch(`${base}`, { headers: { accept: "application/json" } });
    if (response.ok) detail = await response.json();
  } catch {
    detail = null;
  }
  const name = String(detail?.sourceFile ?? "").toLowerCase();
  const office = /\.(docx?|pptx?|xlsx?)$/.test(name);
  const pdf = /\.pdf$/.test(name);
  const note = detail?.type === "note";
  let page = source.page;
  // 兼容修复前产生的旧 source meta：当时没有 page；按 clause 反查一次页码。
  if (!(typeof page === "number" && page > 0) && source.clause) {
    try {
      const response = await fetch(`${base}/page?clause=${encodeURIComponent(source.clause)}`, { headers: { accept: "application/json" } });
      if (response.ok) {
        const body = await response.json();
        if (Number.isInteger(body?.page) && body.page > 0) page = body.page;
      }
    } catch {
      /* 保留无页码回退 */
    }
  }
  if (pdf || office) {
    // 原生 iframe PDF 在 WebKit 会下载/空白；用服务端全页 HTML viewer iframe，
    // 连续滚动完整文档，并在加载后滚到引用页。
    const current = typeof page === "number" && page > 0 ? page : 1;
    const total = Number(detail?.pages) > 0 ? Number(detail.pages) : undefined;
    // 只有拿到页码时才显式指定；否则让 viewer 自动落到命中最多的页。
    const params = new URLSearchParams();
    if (typeof page === "number" && page > 0) params.set("page", String(current));
    // 只高亮检索关键词；绝不要把条款号当关键词（旧 source meta 可能只有 clause）。
    const terms = Array.isArray(source.keywords) ? source.keywords.filter((word) => word && word !== source.clause) : [];
    if (terms.length > 0) params.set("q", terms.join("|"));
    return {
      mode: "viewer",
      url: `${base}/viewer.html?${params.toString()}`,
      page: current,
      ...(total ? { totalPages: total } : {}),
    };
  }
  let url = note ? `${base}/content` : `${base}/source?inline=1`;
  if (typeof page === "number" && Number.isInteger(page) && page > 0) url += `#page=${page}&zoom=page-fit`;
  return { mode: "frame", url, ...(typeof page === "number" ? { page } : {}) };
}

function SourceLinks({ sources, limit = 12 }: { sources: KbSource[]; limit?: number }) {
  const [preview, setPreview] = useState<{ source: KbSource; mode?: "viewer" | "frame"; url?: string; page?: number; totalPages?: number; error?: string } | null>(null);
  const open = async (event: any, source: KbSource) => {
    event?.preventDefault?.();
    setPreview({ source });
    try {
      const data = await sourcePreviewData(source);
      setPreview({ source, ...data });
    } catch (error) {
      setPreview({ source, error: String((error as any)?.message ?? error) });
    }
  };
  return (
    <div className="dsh-kb-sources-list">
      {sources.slice(0, limit).map((source) => {
        const page = source.page;
        const parts = [source.clause ? `第 ${source.clause} 条` : "", typeof page === "number" && Number.isInteger(page) && page > 0 ? `第 ${page} 页` : "", source.kb ? `来自 ${source.kb}` : ""].filter(Boolean);
        return (
          <a
            key={`${source.kb ?? ""}-${source.docId}-${source.page ?? ""}-${source.clause ?? ""}`}
            className="dsh-kb-source-link dsh-kb-source-card"
            href={sourceHref(source)}
            target="_blank"
            rel="noreferrer"
            title={source.snippet ?? ""}
            onClick={(event) => void open(event, source)}
          >
            <span className="dsh-kb-source-card-head">
              <span className="dsh-kb-source-card-title">{source.title ?? source.docId}</span>
              {parts.length > 0 ? <span className="dsh-kb-source-card-page">{parts.join(" · ")}</span> : null}
            </span>
            {source.snippet ? <span className="dsh-kb-source-snippet">{source.snippet}</span> : null}
            <span className="dsh-kb-source-card-open">打开原件并定位 →</span>
          </a>
        );
      })}
      {preview && typeof document !== "undefined"
        ? createPortal(
            <div
              className="dsh-kb-preview-backdrop"
              onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}
            >
              <div className="dsh-kb-preview" role="dialog" aria-modal="true" aria-label="原件预览">
                <div className="dsh-kb-preview-head">
                  <span className="dsh-kb-preview-title">{preview.source.title ?? preview.source.docId}</span>
                  {preview.mode === "viewer" ? <span className="dsh-kb-preview-page">关键词高亮</span> : null}
                  {preview.mode !== "viewer" && sourcePageLabel(preview.source) ? <span className="dsh-kb-preview-page">{sourcePageLabel(preview.source)}</span> : null}
                  <button type="button" className="dsh-kb-preview-close" aria-label="关闭预览" onClick={() => setPreview(null)}>×</button>
                </div>
                <div className="dsh-kb-preview-body">
                  {preview.error ? <div>原件预览失败：{preview.error}</div>
                    : preview.url ? <iframe className="dsh-kb-preview-frame" src={preview.url} title="原件预览" />
                    : <div>正在打开原件…</div>}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function KbCitationAction({ messageId }: { messageId?: string }) {
  const onClick = (event: any) => {
    if (typeof document === "undefined") return;
    const button = event?.currentTarget as HTMLElement | null;
    const root = button?.closest?.("[data-turn-tail]") ?? document;
    const target = root.querySelector?.(".dsh-kb-sources-turn")
      ?? root.querySelector?.(".dsh-kb-source-row")
      ?? document.querySelector?.(".dsh-kb-sources-turn")
      ?? document.querySelector?.(".dsh-kb-source-row");
    if (!target) return;
    target.scrollIntoView?.({ behavior: "smooth", block: "center" });
    target.classList?.add("dsh-kb-source-flash");
    setTimeout(() => target.classList?.remove("dsh-kb-source-flash"), 1800);
  };
  return (
    <button type="button" className="dsh-kb-citation-action" title={messageId ? "查看本条回答引用的资料" : "查看引用资料"} onClick={onClick}>
      引用
    </button>
  );
}

function KbToolSourcesRow({ toolName, phase, block, useDisclosure }: ToolSourceRowProps) {
  const title = toolName === "kb_read" ? "知识库精读" : "知识库检索";
  const sources = sourcesOfBlock(block);
  const disclosure = useDisclosure?.();
  const expanded = disclosure?.expanded ?? false;
  if (phase === "result" && block?.isError) {
    return <div className="dsh-kb-source-row"><span className="dsh-kb-source-title">{title}失败</span></div>;
  }
  if (phase !== "result") {
    return (
      <div className="dsh-kb-source-row">
        <span className="dsh-kb-source-title">{title}</span>
        <span className="dsh-kb-source-meta">正在检索…</span>
      </div>
    );
  }
  if (sources.length === 0) {
    return (
      <div className="dsh-kb-source-row">
        <span className="dsh-kb-source-title">{title}</span>
        <span className="dsh-kb-source-meta">没有可定位的来源</span>
      </div>
    );
  }
  return (
    <div className="dsh-kb-source-row">
      <div className="dsh-kb-source-head">
        <span className="dsh-kb-source-title">{title}</span>
        <span className="dsh-kb-source-meta">{sources.length} 个来源</span>
        <button
          type="button"
          className="dsh-kb-source-toggle"
          aria-expanded={expanded}
          onClick={() => disclosure?.toggle()}
        >
          {expanded ? "收起来源" : "展开来源"}
        </button>
      </div>
      {expanded ? <SourceLinks sources={sources} /> : <SourceLinks sources={sources} limit={3} />}
    </div>
  );
}

function collectNodeSources(block: any, out: KbSource[]) {
  if (!block || typeof block !== "object") return;
  if (Array.isArray(block.meta?.sources)) out.push(...block.meta.sources);
  if (Array.isArray(block.subCalls)) {
    for (const child of block.subCalls) collectNodeSources(child, out);
  }
}

function turnNumberOf(turn: unknown): number | null {
  if (typeof turn === "number" && Number.isFinite(turn)) return turn;
  if (turn && typeof turn === "object") {
    const value = (turn as any).turn ?? (turn as any).number ?? (turn as any).index;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return null;
}

function KbSourcesTurnPanel({ turn, matched, useChat }: TurnTailProps) {
  const nodes: any = useChat ? useChat((snapshot: any) => snapshot?.nodes) : null;
  const turnNo = turnNumberOf(turn ?? matched?.turn);
  const collected: KbSource[] = [];
  if (nodes && typeof nodes.values === "function") {
    for (const node of nodes.values()) {
      if (!node || node.kind !== "tool-call") continue;
      const location = node.location;
      const nodeTurn = location?.turn?.turn ?? location?.turn ?? null;
      if (turnNo !== null && nodeTurn !== null && nodeTurn !== turnNo) continue;
      collectNodeSources(node.data?.root, collected);
    }
  }
  const sources = dedupeSources(collected, 20);
  if (sources.length === 0) return null;
  return (
    <section className="dsh-kb-sources-turn" aria-label="本轮来源">
      <h4>本轮来源（{sources.length}）</h4>
      <SourceLinks sources={sources} limit={12} />
    </section>
  );
}

export function apply(ctx: SlotContext) {
  ensureCss();
  ctx.slots.inject("sidebar.footer.action", () => {
    ctx.slots.register({ name: "sidebar.footer.action", id: "kb-workbench", order: 10 }, KbWorkbenchAction);
  });
  ctx.slots.inject("conversation.input.left", () => {
    ctx.slots.register({ name: "conversation.input.left", id: "kb-scope", order: 20 }, KbScopeCapsule);
  });
  ctx.slots.inject("tool.call.toolview", () => {
    ctx.slots.register({ name: "tool.call.toolview", key: "kb_query" }, KbToolSourcesRow);
    ctx.slots.register({ name: "tool.call.toolview", key: "kb_read" }, KbToolSourcesRow);
  });
  ctx.slots.inject("conversation.chat.turnTail", () => {
    // DSH 不同版本把 turnTail 声明为 list 或 chain：chain 需要 select；
    // 先按 chain 注册，失败再按 list 注册。
    try {
      ctx.slots.register(
        { name: "conversation.chat.turnTail", id: "kb-sources", order: 30, select: (owner: any) => owner },
        KbSourcesTurnPanel
      );
    } catch {
      ctx.slots.register(
        { name: "conversation.chat.turnTail", id: "kb-sources", order: 30 },
        KbSourcesTurnPanel
      );
    }
  });
  ctx.slots.inject("conversation.chat.assistant-actions", () => {
    ctx.slots.register({ name: "conversation.chat.assistant-actions", id: "kb-citations", order: 20 }, KbCitationAction);
  });
}
