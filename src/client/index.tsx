import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ComponentType } from "react";
import { chipLabel, isAllSelection, selectionPayload } from "../../lib/scope-view.js";

export const inject = ["slots"];

type KbProps = { wide?: boolean };
type Scope = { mode: "all" | "selected"; kbs: string[]; inheritedFrom?: string | null };
type KbDocs = { total?: number; deleted?: number };
type KbSummary = {
  name: string;
  description?: string;
  docs?: number | KbDocs;
  mergedInto?: string | null;
};
type ScopeSlotProps = { sessionId?: string };
type SlotDeclaration = { name: string; id: string; order?: number };
type SlotContext = {
  slots: {
    inject(name: string, callback: () => void): void;
    register(declaration: SlotDeclaration, component: ComponentType<any>): void;
  };
};
type Phase = "loading" | "ready" | "failed" | "hidden";
type PanelPhase = "loading" | "ready";
type PanelPosition = { left: number | string; bottom: number; transform?: string };
type ScopeData = { scope: Scope; kbs: KbSummary[] };
type Toast = { text: string; id: number };

const API = "/kb/api";
const CSS_ID = "dsh-knowledge-wiki/sidebar-entry.css";
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
  const generationRef = useRef(0);
  const inflightRef = useRef<{ sessionId: string; promise: Promise<ScopeData> } | null>(null);
  const toastIdRef = useRef(0);

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
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast?.id]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeScopePanel(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
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
      const bottom = Math.max(8, window.innerHeight - rect.top + 8);
      setPosition({ left, bottom });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const names = kbs.map((kb) => kb.name);
  const label = chipLabel(scope, { loading: phase === "loading", failed: phase === "failed" });
  const active = phase === "ready" && scope?.mode === "selected";
  const filtered = query.trim() === ""
    ? kbs
    : kbs.filter((kb) => `${kb.name} ${kb.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));

  if (phase === "hidden") return null;

  function closeScopePanel(restoreFocus: boolean) {
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
    const gen = ++generationRef.current;
    setPanelPhase("loading");
    setQuery("");
    try {
      const data = await loadScopeData(sessionId);
      if (gen !== generationRef.current) return;
      const freshNames = data.kbs.map((kb) => kb.name);
      setScope(data.scope);
      setKbs(data.kbs);
      setDraft(
        data.scope.mode === "selected"
          ? (data.scope.kbs ?? []).filter((name) => freshNames.includes(name))
          : [...freshNames]
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
    const picked = draft.filter((name) => names.includes(name));
    const payload = picked.length === 0 || isAllSelection(picked, names)
      ? { mode: "all", kbs: [] as string[] }
      : selectionPayload("selected", picked, names);
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
      showToast(data.scope.mode === "selected" ? `已限定为 ${data.scope.kbs.length} 个知识库` : "已改为全部知识库");
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "范围保存失败，请重试";
      showToast(message);
    } finally {
      setSaving(false);
    }
  }

  const panel = open && phase === "ready" && panelPhase === "ready" ? createPortal(
    <div
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
          filtered.map((kb) => (
            <label key={kb.name} className="dsh-kb-scope-row">
              <input
                type="checkbox"
                checked={draft.includes(kb.name)}
                disabled={saving}
                onChange={() => setDraft((current) => (
                  current.includes(kb.name) ? current.filter((name) => name !== kb.name) : [...current, kb.name]
                ))}
              />
              <span className="dsh-kb-scope-name">{kb.name}</span>
              <span className="dsh-kb-scope-meta">{docsBadge(kb)}</span>
            </label>
          ))
        )}
      </div>
      <div className="dsh-kb-scope-actions">
        <button type="button" disabled={saving} onClick={() => setDraft([...names])}>全选</button>
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
        aria-expanded={open}
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

export function apply(ctx: SlotContext) {
  ensureCss();
  ctx.slots.inject("sidebar.footer.action", () => {
    ctx.slots.register({ name: "sidebar.footer.action", id: "kb-workbench", order: 10 }, KbWorkbenchAction);
  });
  ctx.slots.inject("conversation.input.left", () => {
    ctx.slots.register({ name: "conversation.input.left", id: "kb-scope", order: 20 }, KbScopeCapsule);
  });
}
